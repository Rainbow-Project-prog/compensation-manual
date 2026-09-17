/**
 * Lpro ログインフォームの自動送信（自動ログイン）。
 *
 * 背景: Lpro のログインセッション（JSESSIONID）はサーバー側で失効することがあり（PC の長時間停止・スリープ後など。
 * RUNBOOK C）、失効すると ensureLoggedIn が「手動ログイン待ち」に入って巡回が止まっていた（人が headed ブラウザで
 * 入り直すまで新着が届かない）。ログイン画面は ID とパスキーを入れて送信するだけなので、ここを自動化して無人で復旧させる。
 *
 * 方式（優先順）:
 *   1. .env の LPRO_LOGIN_ID / LPRO_LOGIN_PASSKEY があればフォームに入力して送信する
 *   2. 無ければ、フォームが既に埋まっている（ブラウザのパスワード自動入力）ときだけ送信ボタンを押す
 *   3. どちらもできなければ何もしない（従来どおり人のログインを待つ）
 *
 * このモジュールは Lpro 依存を「セレクタ（config.ts の SELECTORS.login*）」に閉じ、Page を受け取る操作関数として書く
 * （test/autologin.test.ts が模擬ログインページで検証する。config.ts は import しない）。
 * ログイン画面の実DOMは 2026-09-17 時点で未収集のため、セレクタ未指定（''）の項目は一般的なログインフォームの構造から
 * 自動判定する: パスワード欄 → 同じ form 内でその直前にあるテキスト入力を ID 欄、同じ form 内の submit ボタン
 * （無ければ「ログイン」等の文言のボタン）を送信ボタンとみなす。
 *
 * 安全側の原則:
 *   - 1回の呼び出しで送信は最大1回（同じ資格情報を連打してアカウントロックを招かない。再試行の間隔・回数は
 *     呼び出し側＝lpro-adapter が管理する）
 *   - パスワード欄が見つからないページ（追加認証・エラー画面・Lpro 停止中）には一切触らない
 *   - 「ログインできない方はこちら」のようなリンクをボタンと誤認して押さない（リンクは文言の完全一致だけ）
 *   - 資格情報の値はログに出さない
 */
import type { Page, Frame, Locator } from 'playwright';

export type LoginSelectors = {
  /** パスキー（パスワード）入力欄。これが表示されているフレームを「ログインフォームのあるフレーム」とみなす */
  loginPassInput: string;
  /** ID 入力欄。'' なら自動判定（パスワード欄と同じ form 内でその直前にあるテキスト入力） */
  loginIdInput: string;
  /** 送信ボタン。'' なら自動判定（同じ form の submit ボタン → 「ログイン」等の文言のボタン → form.requestSubmit()） */
  loginSubmit: string;
};

export type AutoLoginCreds = { id: string; pass: string };

export type AutoLoginResult =
  /** ログインフォーム（パスワード欄）が見つからない。追加認証ページ・エラーページ・Lpro 停止中など。何も触っていない */
  | { kind: 'no-form'; detail: string }
  /** フォームはあるが埋められない（資格情報なし、かつ自動入力もされていない）。何も触っていない＝人の入力待ち */
  | { kind: 'need-input'; detail: string }
  /** 送信した（1回だけ）。ログインできたかどうかは呼び出し側が判定する */
  | { kind: 'submitted'; filledFrom: 'env' | 'prefilled'; how: 'click' | 'requestSubmit' | 'enter'; detail: string };

// 自動判定した要素に付ける目印属性（frame.evaluate の結果を Locator として受け取るため）
const MARK_ID = 'data-lpro-bridge-login-id';
const MARK_SUBMIT = 'data-lpro-bridge-login-submit';
// ボタンの文言（value / テキスト / alt / title）。「忘れた」「登録」系は除外する
const BUTTON_TEXT_RE = /ログイン|log\s*in|sign\s*in|認証|送信/i;
const BUTTON_EXCLUDE_RE = /忘れ|forgot|reset|リセット|登録|register|sign\s*up|新規|できない|お困り|help|ヘルプ/i;
// リンク（a / role=button）は文言の完全一致だけ（「ログインできない方はこちら」を押さない）
const LINK_TEXT_RE = /^\s*(ログイン|log\s*in|sign\s*in)\s*$/i;

type FoundForm = { frame: Frame; pass: Locator; id: Locator | null; submit: Locator | null; hasForm: boolean };

async function firstVisible(loc: Locator): Promise<Locator | null> {
  const n = await loc.count().catch(() => 0);
  for (let i = 0; i < n; i++) {
    const l = loc.nth(i);
    if (await l.isVisible().catch(() => false)) return l;
  }
  return null;
}

/** 表示中のパスワード欄がどこかのフレームにあるか（送信後の「まだログイン画面か」判定にも使う） */
export async function loginFormVisible(page: Page, passSelector: string): Promise<boolean> {
  for (const f of page.frames()) {
    if (await firstVisible(f.locator(passSelector))) return true;
  }
  return false;
}

/** 全フレームからログインフォームを探す（表示中のパスワード欄が最初に見つかったフレーム）。
 * ID 欄・送信ボタンは、パスワード欄が属する form（無ければ document）の中で判定し、目印属性を付けて Locator にする。
 * ※ evaluate 内に名前付き関数・変数代入した関数を書かない（tsx/esbuild が付ける __name ヘルパーがページ側に無く
 *    ReferenceError になる。lpro-adapter.ts の evaluate と同じ流儀＝ループとインラインのコールバックだけ） */
async function findLoginForm(page: Page, sel: LoginSelectors, log: (msg: string) => void): Promise<FoundForm | null> {
  for (const frame of page.frames()) {
    const pass = await firstVisible(frame.locator(sel.loginPassInput));
    if (!pass) continue;
    const marks = await pass
      .evaluate(
        (pw: Element, a: { markId: string; markSubmit: string; idSel: string; submitSel: string; textRe: string; excludeRe: string; linkRe: string }) => {
          const input = pw as HTMLInputElement;
          const form = input.form;
          const scope: ParentNode = form ?? input.ownerDocument;
          // 前回の目印は document 全体から消す（form スコープ外に残った目印を拾わないため）
          for (const el of input.ownerDocument.querySelectorAll(`[${a.markId}],[${a.markSubmit}]`)) {
            el.removeAttribute(a.markId);
            el.removeAttribute(a.markSubmit);
          }
          // 表示中の候補要素（幅・高さがあり display:none / visibility:hidden でない）と、その文言
          const cands: Array<{ el: Element; text: string; input: boolean }> = [];
          const q = a.idSel || a.submitSel
            ? `input, button, a, [role="button"], ${[a.idSel, a.submitSel].filter((x) => x).join(', ')}`
            : 'input, button, a, [role="button"]';
          for (const el of scope.querySelectorAll(q)) {
            const r = el.getBoundingClientRect();
            const cs = getComputedStyle(el);
            if (!(r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none')) continue;
            const text = [(el as HTMLInputElement).value, el.textContent, el.getAttribute('alt'), el.getAttribute('title')].join(' ');
            cands.push({ el, text, input: el instanceof HTMLInputElement });
          }
          // ── ID 欄 ──
          let idEl: Element | null = null;
          if (a.idSel) {
            idEl = cands.find((c) => c.el.matches(a.idSel))?.el ?? null;
          } else {
            // パスワード欄と同じスコープで、その直前（DOM 順で前）にある最後のテキスト系入力
            const textTypes = ['', 'text', 'email', 'tel', 'number'];
            for (const c of cands) {
              if (!c.input || c.el === input || (c.el as HTMLInputElement).disabled) continue;
              if (!textTypes.includes((c.el.getAttribute('type') ?? '').toLowerCase())) continue;
              if ((c.el.compareDocumentPosition(input) & Node.DOCUMENT_POSITION_FOLLOWING) === 0) continue;
              idEl = c.el;
            }
          }
          if (idEl) idEl.setAttribute(a.markId, '1');
          // ── 送信ボタン ──
          let btn: Element | null = null;
          if (a.submitSel) {
            btn = cands.find((c) => c.el.matches(a.submitSel))?.el ?? null;
          } else {
            const textRe = new RegExp(a.textRe, 'i');
            const excludeRe = new RegExp(a.excludeRe, 'i');
            const linkRe = new RegExp(a.linkRe, 'i');
            const submitTypes = 'button[type="submit"], input[type="submit"], input[type="image"]';
            const buttons = cands.filter((c) => c.el.matches('button, input[type="submit"], input[type="button"], input[type="image"]') && !excludeRe.test(c.text));
            const links = cands.filter((c) => c.el.matches('a, [role="button"]') && linkRe.test(c.text));
            btn =
              buttons.find((c) => c.el.matches(submitTypes) && textRe.test(c.text))?.el ??
              buttons.find((c) => c.el.matches(submitTypes))?.el ??
              buttons.find((c) => textRe.test(c.text))?.el ??
              links[0]?.el ??
              // form 内の type 無し <button> は submit 扱い
              (form ? buttons.find((c) => c.el.matches('button:not([type]), button[type=""]'))?.el : undefined) ??
              null;
          }
          if (btn) btn.setAttribute(a.markSubmit, '1');
          return { hasForm: !!form, hasId: !!idEl, hasSubmit: !!btn };
        },
        {
          markId: MARK_ID, markSubmit: MARK_SUBMIT, idSel: sel.loginIdInput, submitSel: sel.loginSubmit,
          textRe: BUTTON_TEXT_RE.source, excludeRe: BUTTON_EXCLUDE_RE.source, linkRe: LINK_TEXT_RE.source,
        }
      )
      .catch((e: unknown) => { log(`自動ログイン: フォームの判定に失敗（${String(e).slice(0, 200)}）`); return null; });
    if (!marks) continue;
    return {
      frame,
      pass,
      id: marks.hasId ? frame.locator(`[${MARK_ID}="1"]`).first() : null,
      submit: marks.hasSubmit ? frame.locator(`[${MARK_SUBMIT}="1"]`).first() : null,
      hasForm: marks.hasForm,
    };
  }
  return null;
}

/**
 * ログインフォームを1回だけ送信する。ログインできたか（ログイン済みマーカーが出たか）の判定は呼び出し側。
 * 何も触らなかった場合は no-form / need-input を返す（どちらも再試行して害は無い）。
 */
export async function attemptAutoLogin(
  page: Page,
  opts: { creds: AutoLoginCreds | null; selectors: LoginSelectors; log?: (msg: string) => void }
): Promise<AutoLoginResult> {
  const log = opts.log ?? (() => {});
  const found = await findLoginForm(page, opts.selectors, log);
  if (!found) return { kind: 'no-form', detail: `パスキー欄（${opts.selectors.loginPassInput}）が表示されていません` };
  const { frame, pass, id, submit, hasForm } = found;
  const idVal = id ? (await id.inputValue().catch(() => '')).trim() : '';
  const passVal = await pass.inputValue().catch(() => '');

  let filledFrom: 'env' | 'prefilled';
  const creds = opts.creds;
  if (creds && creds.pass) {
    if (id) {
      if (creds.id) await id.fill(creds.id);
      else if (!idVal) return { kind: 'need-input', detail: 'ID 欄が空で LPRO_LOGIN_ID も未設定です' };
    } else if (creds.id) {
      log('自動ログイン: ID 欄が見つからないため LPRO_LOGIN_ID は入力せず、パスキーだけ入力します');
    }
    await pass.fill(creds.pass);
    filledFrom = 'env';
  } else {
    if (!passVal) return { kind: 'need-input', detail: 'パスキー欄が空です（LPRO_LOGIN_ID / LPRO_LOGIN_PASSKEY 未設定・自動入力もなし）' };
    if (id && !idVal) return { kind: 'need-input', detail: 'ID 欄が空です（パスキーだけ自動入力されています）' };
    filledFrom = 'prefilled';
  }

  // 送信は1回だけ。ボタン → form.requestSubmit()（submit イベントも発火＝JS 送信にも効く）→ Enter の順
  const where = frame === page.mainFrame() ? 'メインフレーム' : `iframe(${frame.name() || frame.url().slice(0, 60)})`;
  if (submit) {
    await submit.click({ timeout: 5_000 });
    return { kind: 'submitted', filledFrom, how: 'click', detail: `${where} / ボタンをクリック` };
  }
  if (hasForm) {
    await pass.evaluate((el: Element) => (el as HTMLInputElement).form?.requestSubmit());
    return { kind: 'submitted', filledFrom, how: 'requestSubmit', detail: `${where} / 送信ボタンが見つからないため form を送信` };
  }
  await pass.press('Enter');
  return { kind: 'submitted', filledFrom, how: 'enter', detail: `${where} / form も送信ボタンも無いため Enter` };
}
