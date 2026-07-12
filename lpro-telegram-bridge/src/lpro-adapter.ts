import { chromium, type BrowserContext, type Page, type Frame, type Locator } from 'playwright';
import { createHash } from 'node:crypto';
import { cfg, SELECTORS, httpCredentials } from './config.js';

export type Conversation = { customerKey: string; name: string; unread: boolean };
/** hash はフィンガープリント（会員ID+日時+本文+同文連番）。重複配信・取りこぼし防止の要 */
export type InboundMsg = { text: string; hash: string };

let ctx: BrowserContext | null = null;
let page: Page | null = null;

const warned = new Set<string>();
function warnOnce(key: string, msg: string): void {
  if (warned.has(key)) return;
  warned.add(key);
  console.warn(msg);
}

function clean(s: string | null | undefined): string {
  return (s ?? '').trim().replace(/\s+/g, ' ');
}

export async function initBrowser(): Promise<void> {
  // 再初期化（クラッシュ復旧）に備えて既存コンテキストは先に閉じる
  if (ctx) await closeBrowser();
  ctx = await chromium.launchPersistentContext(cfg.userDataDir, {
    headless: cfg.headless,
    viewport: { width: 1400, height: 950 },
    // /manage の HTTP ベーシック認証（realm "InfoSys Manager"）に自動応答する。
    // 未設定なら undefined（従来どおり）で、その場合はページ側の認証ダイアログに手動対応が必要
    httpCredentials: httpCredentials(),
    // Ctrl+C / kill の終了処理は index.ts の shutdown() が担う。Playwright 既定のシグナルハンドラは
    // ブラウザを閉じた直後に process.exit してしまい、返信の排水・bot停止・DBクローズを先取りで打ち切る
    // （プロセス終了時の chromium の後始末は Playwright の exit ハンドラが引き続き行う）
    handleSIGINT: false,
    handleSIGTERM: false,
    handleSIGHUP: false,
  });
  page = ctx.pages()[0] ?? (await ctx.newPage());
  await ensureLoggedIn();
}

/** 終了時に呼ぶ。ブラウザ（永続コンテキスト）を閉じる */
export async function closeBrowser(): Promise<void> {
  try { await ctx?.close(); } catch { /* already closed */ }
  ctx = null;
  page = null;
}

/** ブラウザ/ページが閉じられた・クラッシュした系のエラーか（復旧判定用） */
export function isBrowserGoneError(e: unknown): boolean {
  const m = String(e);
  return /Target (page|context|browser).*closed|browser has been closed|context.*closed|Target closed|Page crashed|Target crashed|browser.*disconnected/i.test(m);
}

/** ページが使えない状態か（initBrowser 失敗後の null 固定・タブ閉鎖の検知用） */
export function pageGone(): boolean {
  return !page || page.isClosed();
}

/**
 * 顧客行テーブルの iframe（chatframe）を探す。
 * talkUrl を直接開いた場合（chat_message?method=frame）は1段、
 * /manage/ シェル経由なら main → chatframe の2段になるが、
 * Playwright の frames() はフラットに列挙するので name で拾えばどちらでも動く。
 */
function findChatFrame(): Frame | null {
  const p = page;
  if (!p || p.isClosed()) return null;
  for (const f of p.frames()) {
    if (f.name() === 'chatframe' || /\/chat_message(?:\?(?!.*method=frame)|$)/.test(f.url())) return f;
  }
  return null;
}

async function waitForChatFrame(timeoutMs: number): Promise<Frame | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const f = findChatFrame();
    if (f) {
      // フレームは在っても中身が空のことがあるので、行テーブルの出現まで確認する
      const ok = await f
        .waitForSelector(SELECTORS.conversationItem, { timeout: Math.max(1000, deadline - Date.now()), state: 'attached' })
        .then(() => true)
        .catch(() => false);
      if (ok) return f;
      return findChatFrame(); // 行ゼロでもフレームがあれば返す（空一覧は呼び出し側で扱う）
    }
    await page!.waitForTimeout(500);
  }
  return null;
}

/** chatframe を必須で取得。無ければセッション切れ/未ログインとして throw（復旧経路へ） */
function requireChatFrame(): Frame {
  const f = findChatFrame();
  if (!f) throw new Error('トーク画面（chatframe）が見つかりません（セッション切れ/画面遷移の疑い）');
  return f;
}

export async function ensureLoggedIn(): Promise<void> {
  const p = page!;
  await p.goto(cfg.talkUrl, { waitUntil: 'domcontentloaded' });
  // トーク画面が出ればログイン済み。未ログインならログインページへリダイレクトされ chatframe は現れない
  let f = await waitForChatFrame(15_000);
  if (!f) {
    if (cfg.headless) {
      throw new Error(
        '未ログインですが HEADLESS=true のため手動ログインできません。' +
        '.env で HEADLESS=false にして `npm run login` を実行してください'
      );
    }
    console.log('未ログインの可能性。表示中のブラウザでログイン（2FA含む）してください。最大5分待機…');
    await p.goto(cfg.loginUrl, { waitUntil: 'domcontentloaded' }).catch(() => {});
    // ログイン完了はシェルのログアウトメニュー（loggedInMarker）またはトーク画面の出現で判定
    const deadline = Date.now() + 300_000;
    let ok = false;
    while (Date.now() < deadline && !ok) {
      ok =
        (await p.locator(SELECTORS.loggedInMarker).first().isVisible().catch(() => false)) ||
        findChatFrame() !== null;
      if (!ok) await p.waitForTimeout(2000);
    }
    if (!ok) throw new Error('5分以内にログインを確認できませんでした');
    await p.goto(cfg.talkUrl, { waitUntil: 'domcontentloaded' });
    f = await waitForChatFrame(30_000);
    if (!f) throw new Error('ログイン後もトーク画面（chatframe）を表示できませんでした');
  }
  console.log('Lpro ログイン確認OK（トーク画面表示）');
}

/** 行スキャン結果（frame.evaluate で一括抽出する軽量DTO） */
type RowScan = { key: string; name: string; status: string };

let lastLoggedCounts = '';

/**
 * 会話（顧客行）一覧を取得。毎回 talkUrl を開き直して最新の描画を読む。
 * 一括返信行（会員ID無し）はここで除外される。
 */
export async function pollConversations(): Promise<Conversation[]> {
  const p = page!;
  await p.goto(cfg.talkUrl, { waitUntil: 'domcontentloaded' });
  const f = await waitForChatFrame(20_000);
  if (!f) {
    throw new Error('トーク画面（chatframe）が表示されません（セッション切れの疑い）');
  }
  const rows: RowScan[] = await f.evaluate(
    (S) => {
      const out: Array<{ key: string; name: string; status: string }> = [];
      for (const row of document.querySelectorAll(S.conversationItem)) {
        const idEl = row.querySelector(S.memberIdText);
        const key = (idEl?.textContent ?? '').trim();
        if (!key) continue; // 一括返信行・会員ID欠落行はスキップ（誤爆防止）
        const name = (row.querySelector(S.customerName)?.textContent ?? '').trim().replace(/\s+/g, ' ').slice(0, 60);
        const status = (row.querySelector(S.statusCell)?.textContent ?? '').trim();
        out.push({ key, name, status });
      }
      return out;
    },
    {
      conversationItem: SELECTORS.conversationItem,
      memberIdText: SELECTORS.memberIdText,
      customerName: SELECTORS.customerName,
      statusCell: SELECTORS.statusCell,
    }
  );
  if (rows.length === 0) {
    warnOnce('empty-list', '顧客行が0件です。conversationItem セレクタと表示フィルタを確認してください。');
  }
  const out = rows.map((r) => {
    // 未読判定は安全側に倒す: 「未返信」を含む、または「返信済」を含まない未知の状態は未読扱い
    // （dump 時点では全行「返信済み」で未返信の実表記が未検証のため。誤判定しても
    //   フィンガープリント台帳があるので重複配信にはならず、読み込みが増えるだけ）
    const unread =
      r.status === ''
        ? true
        : r.status.includes(SELECTORS.unreadText) || !r.status.includes('返信済');
    if (r.status === '') {
      warnOnce('empty-status', '返信状態セル（statusCell）が空の行があります。安全のため未読扱いにします。');
    }
    return { customerKey: r.key, name: r.name || `ID:${r.key}`, unread };
  });
  // 未読0件が続く無音障害を観測できるよう、件数が変わった時だけログに出す
  const counts = `${out.length}行/未読${out.filter((o) => o.unread).length}件`;
  if (counts !== lastLoggedCounts) {
    lastLoggedCounts = counts;
    console.log(`巡回: ${counts}`);
  }
  return out;
}

/** トーク画面を開き直して最新の描画にする（返信後の即時取り込み等、goto を伴わない読み取りの前に呼ぶ） */
export async function refreshTalkView(): Promise<void> {
  const p = page!;
  await p.goto(cfg.talkUrl, { waitUntil: 'domcontentloaded' });
  const f = await waitForChatFrame(20_000);
  if (!f) throw new Error('トーク画面（chatframe）が表示されません（セッション切れの疑い）');
}

/**
 * 会員IDで顧客行を特定する（★誤配信防止の要★）。
 * 行スコープの Locator を返す前に、行内の会員ID表示が要求キーと完全一致することを検証する。
 * 見つからない場合は throw（現在の表示（最新100件）に含まれない顧客には送れない）。
 */
async function findRow(f: Frame, customerKey: string): Promise<Locator> {
  const row = f
    .locator(SELECTORS.conversationItem)
    .filter({ has: f.locator(SELECTORS.memberIdText).getByText(customerKey, { exact: true }) });
  const n = await row.count();
  if (n === 0) {
    throw new Error(
      `顧客行が見つかりません（会員ID=${customerKey}）。表示中の一覧（最新100件）に含まれていない可能性があります。` +
      'Lpro の画面から直接返信してください。'
    );
  }
  if (n > 1) {
    // 会員IDは一意のはず。万一複数一致したら誤配信リスクなので送らない
    throw new Error(`会員ID=${customerKey} に一致する行が複数（${n}件）あります。安全のため操作を中止しました`);
  }
  const shown = clean(await row.locator(SELECTORS.memberIdText).first().textContent());
  if (shown !== customerKey) {
    throw new Error(`行の同一性検証に失敗（要求=${customerKey} 表示=${shown}）。安全のため操作を中止しました`);
  }
  return row;
}

/** メッセージ抽出DTO */
type MsgScan = { inbound: boolean; text: string; dt: string; hasImage: boolean };

/**
 * 顧客行の会話履歴から「顧客の発言」をフィンガープリント付きで取得。
 * 表示されるのは直近数件のみ（履歴の窓）だが、新着は必ず窓の末尾に現れるため
 * ハッシュの未見分だけを配信すれば取りこぼし・重複配信は起きない。
 */
export async function readInbound(conv: Conversation): Promise<InboundMsg[]> {
  const f = requireChatFrame();
  const row = await findRow(f, conv.customerKey);
  const scans: MsgScan[] = await row.evaluate(
    (rowEl, S) => {
      const out: Array<{ inbound: boolean; text: string; dt: string; hasImage: boolean }> = [];
      for (const g of rowEl.querySelectorAll(S.messageGroup)) {
        const inbound = g.classList.contains(S.inboundGroupClass);
        const bubble = g.querySelector(S.bubble);
        if (!bubble) continue;
        const text = (bubble.textContent ?? '').trim().replace(/\s+/g, ' ');
        const dt = Array.from(g.querySelectorAll(S.msgDatetime))
          .map((d) => (d.textContent ?? '').trim().replace(/\s+/g, ' '))
          .join(' ')
          .trim();
        const hasImage = bubble.querySelector('img') !== null;
        out.push({ inbound, text, dt, hasImage });
      }
      return out;
    },
    {
      messageGroup: SELECTORS.messageGroup,
      inboundGroupClass: SELECTORS.inboundGroupClass,
      bubble: SELECTORS.bubble,
      msgDatetime: SELECTORS.msgDatetime,
    }
  );

  const res: InboundMsg[] = [];
  const dupCount = new Map<string, number>();
  // ★実DOMは新→旧（最新が先頭）で並ぶ（dump全100行で確認）。時系列昇順（古→新）に
  // 直してから処理する。logic.ts の「新着は末尾」前提・Telegram への配信順・
  // 同文連番の付与順は、すべてこの向きに依存する
  for (const m of [...scans].reverse()) {
    if (!m.inbound) continue;
    // スタンプ・画像のみのメッセージも「来たこと」は伝える（無音で消すと顧客の連絡自体に気付けない）
    const text = m.text || (m.hasImage ? '[画像/スタンプ]（本文なし。Lproで確認してください）' : '');
    if (!text) continue;
    const base = createHash('sha1')
      .update(`${conv.customerKey}|${m.dt}|${text}`)
      .digest('hex');
    // 同一日時・同一本文の連投を別メッセージとして扱うための連番（時系列昇順で付与）。
    // 既知の限界: 同分・同文の連投が表示窓のズレで分断されると連番が繰り上がって
    // 既知ハッシュと衝突し、後発分が届かないことがある（稀な連投に限る抑止方向の誤り）
    const n = dupCount.get(base) ?? 0;
    dupCount.set(base, n + 1);
    res.push({ text, hash: n === 0 ? base : `${base}:${n}` });
  }
  return res;
}

/**
 * 返信を送信し、成功を検証する。
 * - 行は会員IDで特定し（findRow が同一性検証済み）、入力・クリックはその行スコープのみ。
 *   ページ先頭の「一括返信」フォームには構造上届かない。
 * - 送信成功の検証: クリック後に「入力欄が空になる」か「自分側の吹き出しが1つ増える」の
 *   いずれかを最大10秒待つ。確認できなければ throw（呼び出し側が⚠️通知を出す）。
 */
export async function sendReply(customerKey: string, _name: string, text: string): Promise<void> {
  const p = page!;
  const f = requireChatFrame();
  const row = await findRow(f, customerKey);
  const input = row.locator(SELECTORS.replyInput).first();
  await input.fill(text);

  const outboundGroups = row.locator(`${SELECTORS.messageGroup}:not(.${SELECTORS.inboundGroupClass})`);
  const rightBefore = await outboundGroups.count();
  // 第3の成功シグナル用: 「送った本文を含む自分側吹き出し」の出現数を送信前後で比較する
  const probe = clean(text).slice(0, 30);
  const probeBefore = probe ? await outboundGroups.filter({ hasText: probe }).count().catch(() => 0) : 0;

  // 送信ボタンが confirm ダイアログを出す実装だった場合に備える（出なければ何もしない）
  const onDialog = (d: import('playwright').Dialog) => { void d.accept().catch(() => {}); };
  p.once('dialog', onDialog);
  try {
    await row.locator(SELECTORS.sendButton).first().click();

    // 成功シグナル3種のいずれかを最大10秒待つ:
    // (1) 入力欄が空になった (2) 自分側吹き出しの数が増えた (3) 送った本文を含む自分側吹き出しが増えた
    // ※ 送信ハンドラ（js/mailbox.js）の実挙動は静的DOMから確定できないため、
    //   初回の実機送信テストで「どのシグナルで成功判定されたか」をログで確認すること
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      const cleared = (await input.inputValue().catch(() => text)) === '';
      const rightNow = await outboundGroups.count().catch(() => rightBefore);
      const probeNow = probe ? await outboundGroups.filter({ hasText: probe }).count().catch(() => probeBefore) : probeBefore;
      if (cleared || rightNow > rightBefore || probeNow > probeBefore) {
        console.log(
          `送信確認OK（シグナル: ${cleared ? '入力欄クリア' : rightNow > rightBefore ? '吹き出し増加' : '本文一致'}）`
        );
        return;
      }
      await p.waitForTimeout(500);
    }
    throw new Error(
      '送信を確認できませんでした（入力欄が残ったまま/送信済み吹き出しが増えない）。' +
      '⚠️ 実際には送信されている可能性もあります。再送する前に必ず Lpro の画面で確認してください'
    );
  } finally {
    p.off('dialog', onDialog);
  }
}
