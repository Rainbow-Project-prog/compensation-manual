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
 *     呼び出し側＝lpro-adapter が管理する）。送信操作は noWaitAfter＝ナビゲーション完了を待たずに返す。
 *     待つと遅いログイン応答で click がタイムアウトし「送信済みなのに失敗扱い→再送信」になるため
 *   - この関数が throw したときは「送信していない」（入力段階か、送信操作が実行前に弾かれた）。呼び出し側はそう扱ってよい
 *   - パスワード欄が見つからないページ（追加認証・エラー画面・Lpro 停止中）には一切触らない
 *   - 「ログインできない方はこちら」のようなリンクをボタンと誤認して押さない（リンクは文言の完全一致だけ）。
 *     submit 型のボタンが複数あるときは文言で選び、選べなければ form 送信（requestSubmit）に倒す
 *   - 資格情報の値はログにもエラー文にも出さない（Playwright のエラーは Call log に fill("値") を含むので、
 *     1行目だけに切り詰めて値をスクラブしてから投げ直す）
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
  /** ID 欄に資格情報と違う値が入っている＝人が入力中の可能性。何も触っていない（再試行時のみ判定） */
  | { kind: 'busy'; detail: string }
  /** 送信した（1回だけ）。ログインできたかどうかは呼び出し側が判定する */
  | { kind: 'submitted'; filledFrom: 'env' | 'prefilled'; how: 'click' | 'requestSubmit' | 'enter'; detail: string };

// 自動判定した要素に付ける目印属性（frame.evaluate の結果を Locator として受け取るため）
const MARK_ID = 'data-lpro-bridge-login-id';
const MARK_SUBMIT = 'data-lpro-bridge-login-submit';
// ボタンの文言（value / テキスト / alt / title）。「忘れた」「登録」「再発行」系は除外する
const BUTTON_TEXT_RE = /ログイン|log\s*in|sign\s*in|認証|送信/i;
const BUTTON_EXCLUDE_RE = /忘れ|forgot|reset|リセット|登録|register|sign\s*up|新規|できない|お困り|help|ヘルプ|再発行|再設定|変更|問い合わせ|検索|言語|キャンセル|cancel|戻る|back|ログアウト|logout/i;
// リンク（a / role=button）は文言の完全一致だけ（「ログインできない方はこちら」を押さない）
const LINK_TEXT_RE = /^\s*(ログイン|log\s*in|sign\s*in)\s*$/i;
// 入力・クリックの待ち上限。fill/click は要素が編集可能・有効になるまで待つので、readonly/disabled だとここまで待って throw する
const ACTION_TIMEOUT_MS = 8_000;

type FoundForm = { frame: Frame; pass: Locator; id: Locator | null; idReadonly: boolean; hasForm: boolean };

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

/** 人が操作しうる入力欄（テキスト系・パスワード・textarea）が表示されているか。
 * 送信後に着地したページが「追加認証などの対話ページ」か「空・エラー・遷移中」かの見分けに使う */
export async function pageHasVisibleInputs(page: Page): Promise<boolean> {
  const sel = 'input:not([type]), input[type="text"], input[type="tel"], input[type="number"], input[type="email"], input[type="password"], ' +
    'input[type="radio"], input[type="checkbox"], textarea, select';
  for (const f of page.frames()) {
    if (await firstVisible(f.locator(sel))) return true;
  }
  return false;
}

/** Playwright のエラーから資格情報を除いた1行にする（Call log に fill("値") が載るため）。
 * 1行目に「Target page, context or browser has been closed」等が残るので、呼び出し側のブラウザ喪失判定はそのまま効く */
export function sanitizeActionError(e: unknown, creds: AutoLoginCreds | null, stage: string): Error {
  let line = String(e instanceof Error ? e.message : e).split('\n')[0] ?? '';
  for (const v of [creds?.pass, creds?.id]) {
    if (v && v.length > 0) line = line.split(v).join('***');
  }
  const err = new Error(`自動ログイン: ${stage}に失敗: ${line.slice(0, 200)}`);
  return err;
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
        (pw: Element, a: { markId: string; markSubmit: string; idSel: string }) => {
          const input = pw as HTMLInputElement;
          const form = input.form;
          const scope: ParentNode = form ?? input.ownerDocument;
          // 前回の目印は document 全体から消す（form スコープ外に残った目印を拾わないため）
          for (const el of input.ownerDocument.querySelectorAll(`[${a.markId}],[${a.markSubmit}]`)) {
            el.removeAttribute(a.markId);
            el.removeAttribute(a.markSubmit);
          }
          // 表示中の候補要素（幅・高さがあり display:none / visibility:hidden でない）
          const cands: Array<{ el: Element; input: boolean }> = [];
          const q = a.idSel ? `input, ${a.idSel}` : 'input';
          for (const el of scope.querySelectorAll(q)) {
            const r = el.getBoundingClientRect();
            const cs = getComputedStyle(el);
            if (!(r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none')) continue;
            cands.push({ el, input: el instanceof HTMLInputElement });
          }
          // ── ID 欄 ──
          let idEl: Element | null = null;
          if (a.idSel) {
            idEl = cands.find((c) => c.el.matches(a.idSel))?.el ?? null;
          } else {
            // パスワード欄と同じスコープで、その直前（DOM 順で前）にある最後のテキスト系入力。
            // readonly（ID を覚えている画面の表示用欄）は fill できないので候補から外す（値はそのまま使う）
            const textTypes = ['', 'text', 'email', 'tel', 'number'];
            for (const c of cands) {
              if (!c.input || c.el === input) continue;
              const ie = c.el as HTMLInputElement;
              if (ie.disabled || ie.readOnly) continue;
              if (!textTypes.includes((ie.getAttribute('type') ?? '').toLowerCase())) continue;
              if ((ie.compareDocumentPosition(input) & Node.DOCUMENT_POSITION_FOLLOWING) === 0) continue;
              idEl = ie;
            }
          }
          if (idEl) idEl.setAttribute(a.markId, '1');
          const idReadonly = !!idEl && idEl instanceof HTMLInputElement && (idEl.readOnly || idEl.disabled);
          return { hasForm: !!form, hasId: !!idEl, idReadonly };
        },
        { markId: MARK_ID, markSubmit: MARK_SUBMIT, idSel: sel.loginIdInput }
      )
      .catch((e: unknown) => { log(`自動ログイン: フォームの判定に失敗（${String(e).split('\n')[0]?.slice(0, 200)}）`); return null; });
    if (!marks) continue;
    return {
      frame,
      pass,
      id: marks.hasId ? frame.locator(`[${MARK_ID}="1"]`).first() : null,
      idReadonly: marks.idReadonly,
      hasForm: marks.hasForm,
    };
  }
  return null;
}

/** 送信ボタンを選ぶ（入力後に呼ぶ: 入力で有効化されるボタンは入力前だと disabled で候補から外れるため）。
 * 判定ロジックは findLoginForm の evaluate と同じ（同じ関数を2回走らせて目印を付け直す） */
async function pickSubmit(found: FoundForm, sel: LoginSelectors, log: (msg: string) => void): Promise<Locator | null> {
  const marks = await found.pass
    .evaluate(
      (pw: Element, a: { markSubmit: string; submitSel: string; textRe: string; excludeRe: string; linkRe: string }) => {
        const input = pw as HTMLInputElement;
        const form = input.form;
        const scope: ParentNode = form ?? input.ownerDocument;
        for (const el of input.ownerDocument.querySelectorAll(`[${a.markSubmit}]`)) el.removeAttribute(a.markSubmit);
        const cands: Array<{ el: Element; text: string }> = [];
        const q = a.submitSel ? `button, input, a, [role="button"], ${a.submitSel}` : 'button, input, a, [role="button"]';
        for (const el of scope.querySelectorAll(q)) {
          const r = el.getBoundingClientRect();
          const cs = getComputedStyle(el);
          if (!(r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none')) continue;
          cands.push({ el, text: [(el as HTMLInputElement).value, el.textContent, el.getAttribute('alt'), el.getAttribute('title')].join(' ') });
        }
        let btn: Element | null = null;
        if (a.submitSel) {
          btn = cands.find((c) => c.el.matches(a.submitSel))?.el ?? null;
        } else {
          const textRe = new RegExp(a.textRe, 'i');
          const excludeRe = new RegExp(a.excludeRe, 'i');
          const linkRe = new RegExp(a.linkRe, 'i');
          const submitTypes = 'button[type="submit"], input[type="submit"], input[type="image"]';
          // disabled のボタンは押せない（click が待ち続けて throw する）ので候補から外す＝form 送信へ倒れる
          const buttons = cands.filter((c) =>
            c.el.matches('button, input[type="submit"], input[type="button"], input[type="image"]') &&
            !(c.el as HTMLButtonElement).disabled && !excludeRe.test(c.text));
          const links = cands.filter((c) => c.el.matches('a, [role="button"]') && linkRe.test(c.text));
          const submitOnes = buttons.filter((c) => c.el.matches(submitTypes));
          btn =
            submitOnes.find((c) => textRe.test(c.text))?.el ??
            // 文言で選べない submit 型は「それ1つしか無い」ときだけ（複数あると再発行ボタン等を押しかねない）
            (submitOnes.length === 1 ? submitOnes[0].el : undefined) ??
            buttons.find((c) => textRe.test(c.text))?.el ??
            links[0]?.el ??
            // form 内の type 無し <button> は submit 扱い（1つだけのとき）
            (form && buttons.filter((c) => c.el.matches('button:not([type]), button[type=""]')).length === 1
              ? buttons.find((c) => c.el.matches('button:not([type]), button[type=""]'))?.el
              : undefined) ??
            null;
        }
        if (btn) btn.setAttribute(a.markSubmit, '1');
        return !!btn;
      },
      { markSubmit: MARK_SUBMIT, submitSel: sel.loginSubmit, textRe: BUTTON_TEXT_RE.source, excludeRe: BUTTON_EXCLUDE_RE.source, linkRe: LINK_TEXT_RE.source }
    )
    .catch((e: unknown) => { log(`自動ログイン: 送信ボタンの判定に失敗（${String(e).split('\n')[0]?.slice(0, 200)}）`); return false; });
  return marks ? found.frame.locator(`[${MARK_SUBMIT}="1"]`).first() : null;
}

/**
 * ログインフォームを1回だけ送信する。ログインできたか（ログイン済みマーカーが出たか）の判定は呼び出し側。
 * 何も触らなかった場合は no-form / need-input を返す（どちらも再試行して害は無い）。
 * throw したときは送信していない（入力段階の失敗、または送信操作が実行前に弾かれた）。
 */
export async function attemptAutoLogin(
  page: Page,
  opts: {
    creds: AutoLoginCreds | null;
    selectors: LoginSelectors;
    log?: (msg: string) => void;
    /** 再試行時: ID 欄に資格情報と違う値が入っていれば人が入力中とみなして触らない（busy） */
    skipIfTyped?: boolean;
  }
): Promise<AutoLoginResult> {
  const log = opts.log ?? (() => {});
  const creds = opts.creds;
  const found = await findLoginForm(page, opts.selectors, log);
  if (!found) return { kind: 'no-form', detail: `パスキー欄（${opts.selectors.loginPassInput}）が表示されていません` };
  const { frame, pass, id, idReadonly, hasForm } = found;
  const idVal = id ? (await id.inputValue().catch(() => '')).trim() : '';
  const passVal = await pass.inputValue().catch(() => '');
  if (opts.skipIfTyped && creds?.id && idVal && idVal !== creds.id) {
    return { kind: 'busy', detail: 'ID 欄に設定と違う値が入っています（人が入力中の可能性）。このフォームには触りません' };
  }

  let filledFrom: 'env' | 'prefilled';
  try {
    if (creds && creds.pass) {
      if (id && !idReadonly) {
        if (creds.id) await id.fill(creds.id, { timeout: ACTION_TIMEOUT_MS });
        else if (!idVal) return { kind: 'need-input', detail: 'ID 欄が空で LPRO_LOGIN_ID も未設定です' };
      } else if (id && idReadonly) {
        if (!idVal) return { kind: 'need-input', detail: 'ID 欄が読み取り専用で空です（画面側で ID を選ぶ必要があります）' };
        log('自動ログイン: ID 欄が読み取り専用のため、表示されている ID のままパスキーだけ入力します');
      } else if (creds.id) {
        log('自動ログイン: ID 欄が見つからないため LPRO_LOGIN_ID は入力せず、パスキーだけ入力します');
      }
      await pass.fill(creds.pass, { timeout: ACTION_TIMEOUT_MS });
      filledFrom = 'env';
    } else {
      if (!passVal) return { kind: 'need-input', detail: 'パスキー欄が空です（LPRO_LOGIN_ID / LPRO_LOGIN_PASSKEY 未設定・自動入力もなし）' };
      if (id && !idVal) return { kind: 'need-input', detail: 'ID 欄が空です（パスキーだけ自動入力されています）' };
      filledFrom = 'prefilled';
    }
  } catch (e) {
    throw sanitizeActionError(e, creds, '入力');
  }

  // 送信は1回だけ。ボタン → form.requestSubmit()（submit イベントも発火＝JS 送信にも効く）→ Enter の順。
  // noWaitAfter: ナビゲーション完了を待たない（遅いログイン応答で click がタイムアウトすると「送信済みなのに失敗」になる）。
  // click が throw するのは要素の操作可能性チェック（表示・有効）で弾かれたとき＝まだ送信していないので、次の手段に倒せる
  const where = frame === page.mainFrame() ? 'メインフレーム' : `iframe(${frame.name() || frame.url().slice(0, 60)})`;
  const submit = await pickSubmit(found, opts.selectors, log);
  if (submit) {
    try {
      await submit.click({ timeout: ACTION_TIMEOUT_MS, noWaitAfter: true });
      return { kind: 'submitted', filledFrom, how: 'click', detail: `${where} / ボタンをクリック` };
    } catch (e) {
      log(`自動ログイン: 送信ボタンを押せませんでした（${String(e).split('\n')[0]?.slice(0, 120)}）。form の送信に切り替えます`);
    }
  }
  try {
    if (hasForm) {
      await pass.evaluate((el: Element) => (el as HTMLInputElement).form?.requestSubmit());
      return { kind: 'submitted', filledFrom, how: 'requestSubmit', detail: `${where} / 送信ボタンが使えないため form を送信` };
    }
    await pass.press('Enter', { timeout: ACTION_TIMEOUT_MS, noWaitAfter: true });
    return { kind: 'submitted', filledFrom, how: 'enter', detail: `${where} / form も送信ボタンも無いため Enter` };
  } catch (e) {
    throw sanitizeActionError(e, creds, '送信');
  }
}
