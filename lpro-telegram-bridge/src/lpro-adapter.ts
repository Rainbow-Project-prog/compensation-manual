import { chromium, type BrowserContext, type Page, type Frame, type Locator } from 'playwright';
import { createHash } from 'node:crypto';
import { cfg, SELECTORS, httpCredentials, inboxes, type Inbox } from './config.js';

/** conv.memberId は Lpro の会員ID（受信箱に依らず顧客不変）。DBキーは inbox 込みで index.ts が合成 */
export type Conversation = { memberId: string; name: string; unread: boolean };
/** hash はフィンガープリント（会員ID+日時+本文+同文連番）。重複配信・取りこぼし防止の要 */
export type InboundMsg = { text: string; hash: string };

let ctx: BrowserContext | null = null;
let page: Page | null = null;
// いま main iframe に読み込んでいる受信箱（不要な再ナビゲーションを避ける）
let currentInboxId: string | null = null;

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
  if (inboxes.length === 0) {
    throw new Error(
      '有効な受信箱がありません（.env の CHAT_TALK_URL+CHAT_GROUP_CHAT_ID か ' +
      'TALK_TALK_URL+TALK_GROUP_CHAT_ID を設定してください）。`npm run doctor` で確認できます'
    );
  }
  // 再初期化（クラッシュ復旧）に備えて既存コンテキストは先に閉じる
  if (ctx) await closeBrowser();
  ctx = await chromium.launchPersistentContext(cfg.userDataDir, {
    headless: cfg.headless,
    viewport: { width: 1400, height: 950 },
    // /manage の HTTP ベーシック認証（realm "InfoSys Manager"）に自動応答する。
    httpCredentials: httpCredentials(),
    // Ctrl+C / kill の終了処理は index.ts の shutdown() が担う。Playwright 既定のシグナルハンドラは
    // ブラウザを閉じた直後に process.exit してしまい、返信の排水・bot停止・DBクローズを先取りで打ち切る
    handleSIGINT: false,
    handleSIGTERM: false,
    handleSIGHUP: false,
  });
  page = ctx.pages()[0] ?? (await ctx.newPage());
  currentInboxId = null;
  // 最初の受信箱でログイン確認（複数受信箱でもログインは共通のセッション）
  await ensureLoggedIn(inboxes[0]);
}

/** 終了時に呼ぶ。ブラウザ（永続コンテキスト）を閉じる */
export async function closeBrowser(): Promise<void> {
  try { await ctx?.close(); } catch { /* already closed */ }
  ctx = null;
  page = null;
  currentInboxId = null;
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

/** 指定受信箱の顧客行 iframe（name=chatframe かつ URL がその受信箱のもの）を探す */
function findChatFrame(inbox: Inbox): Frame | null {
  const p = page;
  if (!p || p.isClosed()) return null;
  for (const f of p.frames()) {
    if (f.name() === 'chatframe' && inbox.chatframeRe.test(f.url())) return f;
    // フォールバック: name が付く前でも URL で判別（chat と linechat を取り違えない正規表現）
    if (inbox.chatframeRe.test(f.url()) && f.url() !== inbox.talkUrl) return f;
  }
  return null;
}

/**
 * 指定受信箱の画面を（必要なら）開き、顧客行 iframe が現れるまで待つ。
 * 別の受信箱を表示中、または未表示なら talkUrl へナビゲートする。
 */
async function gotoInbox(inbox: Inbox, timeoutMs = 20_000): Promise<Frame> {
  const p = page!;
  if (currentInboxId !== inbox.id || !findChatFrame(inbox)) {
    await p.goto(inbox.talkUrl, { waitUntil: 'domcontentloaded' });
    currentInboxId = inbox.id;
  }
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const f = findChatFrame(inbox);
    if (f) {
      const ok = await f
        .waitForSelector(SELECTORS.conversationItem, { timeout: Math.max(1000, deadline - Date.now()), state: 'attached' })
        .then(() => true)
        .catch(() => false);
      if (ok) return f;
      return f; // 行ゼロでもフレームがあれば返す（空一覧は呼び出し側で扱う）
    }
    await p.waitForTimeout(500);
  }
  throw new Error(`${inbox.name}: トーク画面（chatframe）が表示されません（セッション切れの疑い）`);
}

export async function ensureLoggedIn(inbox: Inbox = inboxes[0]): Promise<void> {
  const p = page!;
  await p.goto(inbox.talkUrl, { waitUntil: 'domcontentloaded' });
  currentInboxId = inbox.id;
  // トーク画面が出ればログイン済み。未ログインならログインページへリダイレクトされ chatframe は現れない
  let ok = await findChatFrame(inbox)
    ? true
    : await gotoInbox(inbox, 15_000).then(() => true).catch(() => false);
  if (!ok) {
    if (cfg.headless) {
      throw new Error(
        '未ログインですが HEADLESS=true のため手動ログインできません。' +
        '.env で HEADLESS=false にして `npm run login` を実行してください'
      );
    }
    console.log('未ログインの可能性。表示中のブラウザでログイン（2FA含む）してください。最大5分待機…');
    await p.goto(cfg.loginUrl, { waitUntil: 'domcontentloaded' }).catch(() => {});
    const deadline = Date.now() + 300_000;
    while (Date.now() < deadline && !ok) {
      ok = await p.locator(SELECTORS.loggedInMarker).first().isVisible().catch(() => false);
      if (!ok) await p.waitForTimeout(2000);
    }
    if (!ok) throw new Error('5分以内にログインを確認できませんでした');
    await gotoInbox(inbox, 30_000);
  }
  console.log(`Lpro ログイン確認OK（${inbox.name}）`);
}

/** 行スキャン結果（frame.evaluate で一括抽出する軽量DTO） */
type RowScan = { key: string; name: string; status: string };

const lastLoggedCounts = new Map<string, string>();

/**
 * 指定受信箱の顧客行一覧を取得。毎回開き直して最新の描画を読む。
 * 一括返信行（会員ID無し）はここで除外される。
 */
export async function pollConversations(inbox: Inbox): Promise<Conversation[]> {
  const f = await gotoInbox(inbox, 20_000);
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
    warnOnce(`empty-list-${inbox.id}`, `${inbox.name}: 顧客行が0件です。conversationItem セレクタと表示フィルタを確認してください。`);
  }
  const out = rows.map((r) => {
    // 未読判定は安全側: 「未返信」を含む、または「返信済」を含まない未知の状態は未読扱い
    const unread =
      r.status === ''
        ? true
        : r.status.includes(SELECTORS.unreadText) || !r.status.includes('返信済');
    if (r.status === '') {
      warnOnce(`empty-status-${inbox.id}`, `${inbox.name}: 返信状態セルが空の行があります。安全のため未読扱いにします。`);
    }
    return { memberId: r.key, name: r.name || `ID:${r.key}`, unread };
  });
  const counts = `${out.length}行/未読${out.filter((o) => o.unread).length}件`;
  if (lastLoggedCounts.get(inbox.id) !== counts) {
    lastLoggedCounts.set(inbox.id, counts);
    console.log(`巡回[${inbox.name}]: ${counts}`);
  }
  return out;
}

/** トーク画面を開き直して最新の描画にする（返信後の即時取り込み等の前に呼ぶ） */
export async function refreshTalkView(inbox: Inbox): Promise<void> {
  currentInboxId = null; // 強制的に再ナビゲートさせる
  await gotoInbox(inbox, 20_000);
}

/** 受信箱の検索フォーム iframe（*_message_menu）を探す */
function findMenuFrame(inbox: Inbox): Frame | null {
  const p = page;
  if (!p || p.isClosed()) return null;
  for (const f of p.frames()) {
    if (inbox.menuRe.test(f.url())) return f;
  }
  return null;
}

/**
 * 会員IDで検索して、その1件だけを chatframe に表示させる（「すべて」=返信済みも含む）。
 * 返信済みの相手・掘り起こし対象（未返信一覧に居ない相手）も確実に開けるようにするための要。
 * 表示された chatframe を返す。会員IDが存在しない/検索が効かない場合は throw。
 */
async function openMember(inbox: Inbox, memberId: string): Promise<Frame> {
  const p = page!;
  await gotoInbox(inbox, 20_000);
  const menu = findMenuFrame(inbox);
  if (!menu) throw new Error(`${inbox.name}: 検索フォーム(menu iframe)が見つかりません`);
  await menu.locator(SELECTORS.memberIdFilter).first().fill(memberId);
  await menu.locator(SELECTORS.searchAllButton).first().click();

  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    await p.waitForTimeout(500);
    const f = findChatFrame(inbox);
    if (!f) continue; // 検索結果で chatframe 再読込中
    const row = f
      .locator(SELECTORS.conversationItem)
      .filter({ has: f.locator(SELECTORS.memberIdText).getByText(memberId, { exact: true }) });
    if (await row.count().catch(() => 0) >= 1) return f;
  }
  throw new Error(
    `${inbox.name}: 会員ID=${memberId} を検索しても行が出ません（この受信箱に居ない/存在しない会員IDの可能性）`
  );
}

/**
 * 会員IDで顧客行を特定する（★誤配信防止の要★）。
 * 行スコープの Locator を返す前に、行内の会員ID表示が要求キーと完全一致することを検証する。
 */
async function findRow(f: Frame, memberId: string, inbox: Inbox): Promise<Locator> {
  const row = f
    .locator(SELECTORS.conversationItem)
    .filter({ has: f.locator(SELECTORS.memberIdText).getByText(memberId, { exact: true }) });
  const n = await row.count();
  if (n === 0) {
    throw new Error(
      `${inbox.name}: 顧客行が見つかりません（会員ID=${memberId}）。表示中の一覧（最新100件）に含まれていない可能性があります。` +
      'Lpro の画面から直接返信してください。'
    );
  }
  if (n > 1) {
    throw new Error(`${inbox.name}: 会員ID=${memberId} に一致する行が複数（${n}件）あります。安全のため操作を中止しました`);
  }
  const shown = clean(await row.locator(SELECTORS.memberIdText).first().textContent());
  if (shown !== memberId) {
    throw new Error(`${inbox.name}: 行の同一性検証に失敗（要求=${memberId} 表示=${shown}）。安全のため操作を中止しました`);
  }
  return row;
}

/** メッセージ抽出DTO */
type MsgScan = { inbound: boolean; text: string; dt: string; hasImage: boolean };

/**
 * 顧客行の会話履歴から「顧客の発言」をフィンガープリント付きで取得。
 * ハッシュには受信箱IDも混ぜる（同じ会員IDが両受信箱に居ても取り違えない）。
 */
export async function readInbound(
  inbox: Inbox,
  conv: Conversation,
  opts: { search?: boolean } = {}
): Promise<InboundMsg[]> {
  // search=true は会員IDで検索して開く（返信済みで未返信一覧から外れた相手も読める）。
  // 通常の巡回は default（未返信一覧）を使う（毎回検索するのは重いため）。
  const f = opts.search ? await openMember(inbox, conv.memberId) : await gotoInbox(inbox, 20_000);
  const row = await findRow(f, conv.memberId, inbox);
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
  // ★実DOMは新→旧（最新が先頭）で並ぶ。時系列昇順（古→新）に直してから処理する
  for (const m of [...scans].reverse()) {
    if (!m.inbound) continue;
    const text = m.text || (m.hasImage ? '[画像/スタンプ]（本文なし。Lproで確認してください）' : '');
    if (!text) continue;
    const base = createHash('sha1')
      .update(`${inbox.id}|${conv.memberId}|${m.dt}|${text}`)
      .digest('hex');
    const n = dupCount.get(base) ?? 0;
    dupCount.set(base, n + 1);
    res.push({ text, hash: n === 0 ? base : `${base}:${n}` });
  }
  return res;
}

/**
 * 返信を送信し、成功を検証する。行は会員IDで特定し（findRow が同一性検証済み）、
 * 入力・クリックはその行スコープのみ。ページ先頭の「一括返信」フォームには構造上届かない。
 */
export async function sendReply(inbox: Inbox, memberId: string, text: string): Promise<void> {
  const p = page!;
  // ★会員IDで検索して対象だけを表示する（未返信一覧に居ない＝返信済みの相手や掘り起こしでも開ける）。
  // findRow で会員IDの完全一致を再検証してから、その行スコープ内でのみ入力・送信する。
  const f = await openMember(inbox, memberId);
  const row = await findRow(f, memberId, inbox);

  const outbound = `${SELECTORS.messageGroup}:not(.${SELECTORS.inboundGroupClass})`;
  const probe = clean(text).slice(0, 30);
  // 送信前の「自分側吹き出しに送信本文を含む数」。送信成功で必ず1つ増える
  const probeBefore = probe
    ? await row.locator(outbound).filter({ hasText: probe }).count().catch(() => 0)
    : 0;

  await row.locator(SELECTORS.replyInput).first().fill(text);

  const onDialog = (d: import('playwright').Dialog) => { void d.accept().catch(() => {}); };
  p.once('dialog', onDialog);
  try {
    await row.locator(SELECTORS.sendButton).first().click();

    // 送信ボタンは per-row フォームを submit し chatframe を再読込する（参照が切れる）。
    // 会員IDで検索し直して「自分側吹き出しに送信本文が増えたか」を確認する（返信済みでも
    // 「すべて」検索なので相手は表示に残る）。偽陰性→二重送信を避けるため入力欄クリアも成功扱い。
    const deadline = Date.now() + 20_000;
    let lastReason = '再読込待ち';
    while (Date.now() < deadline) {
      await p.waitForTimeout(1200);
      let fc: Frame;
      try { fc = await openMember(inbox, memberId); } catch { lastReason = '再検索待ち'; continue; }
      const row2 = fc
        .locator(SELECTORS.conversationItem)
        .filter({ has: fc.locator(SELECTORS.memberIdText).getByText(memberId, { exact: true }) });
      if (await row2.count().catch(() => 0) !== 1) { lastReason = '行の再取得待ち'; continue; }
      const probeNow = probe
        ? await row2.locator(outbound).filter({ hasText: probe }).count().catch(() => probeBefore)
        : probeBefore;
      const cleared = (await row2.locator(SELECTORS.replyInput).first().inputValue().catch(() => text)) === '';
      if (probeNow > probeBefore || cleared) {
        console.log(`送信確認OK[${inbox.name}]（シグナル: ${probeNow > probeBefore ? '送信本文が反映' : '入力欄クリア'}）`);
        return;
      }
      lastReason = '送信本文が反映されず・入力欄に残存';
    }
    throw new Error(
      `${inbox.name}: 送信を確認できませんでした（${lastReason}）。` +
      '⚠️ 実際には送信されている可能性もあります。再送する前に必ず Lpro の画面で確認してください'
    );
  } finally {
    p.off('dialog', onDialog);
  }
}
