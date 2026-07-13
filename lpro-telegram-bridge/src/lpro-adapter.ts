import { chromium, type BrowserContext, type Page, type Frame, type Locator } from 'playwright';
import { createHash } from 'node:crypto';
import { cfg, SELECTORS, DISPLAY_LIMIT, httpCredentials, inboxes, type Inbox } from './config.js';

/** conv.memberId は Lpro の会員ID（受信箱に依らず顧客不変）。DBキーは inbox 込みで index.ts が合成。
 * inbound は巡回時に一括抽出済みの顧客発言（共有画面の割り込み競合を避けるため poll 内で確定させる）。
 * 返信後の再取り込み経路など inbound 未添付で来た場合は readInbound で読む。 */
export type Conversation = { memberId: string; name: string; unread: boolean; inbound?: InboundMsg[] };
/** hash はフィンガープリント（会員ID+日時+本文+同文連番）。重複配信・取りこぼし防止の要 */
export type InboundMsg = { text: string; hash: string };

/** 生スキャン（新→旧順）→ フィンガープリント付き顧客発言（時系列昇順）。poll/readInbound で共用 */
type MsgScan = { inbound: boolean; text: string; dt: string; hasImage: boolean };
function toInbound(inboxId: string, memberId: string, scans: MsgScan[]): InboundMsg[] {
  const res: InboundMsg[] = [];
  const dup = new Map<string, number>();
  // ★実DOMは新→旧（最新が先頭）で並ぶ。時系列昇順（古→新）に直してから処理する
  for (const m of [...scans].reverse()) {
    if (!m.inbound) continue;
    const text = m.text || (m.hasImage ? '[画像/スタンプ]（本文なし。Lproで確認してください）' : '');
    if (!text) continue;
    const base = createHash('sha1').update(`${inboxId}|${memberId}|${m.dt}|${text}`).digest('hex');
    const n = dup.get(base) ?? 0;
    dup.set(base, n + 1);
    res.push({ text, hash: n === 0 ? base : `${base}:${n}` });
  }
  return res;
}

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

/** ログイン失効（手動ログイン待ち）／復旧を運用へ通知するフック。index.ts が notifyOps を接続する。
 * ensureLoggedIn は startBot より前（initBrowser 内）でも走るが、notifyOps は bot.api 経由なので
 * bot の長ポーリング未起動でも送れる。未設定でも待機動作は変わらない（テストや login.ts では無音）。 */
export type LoginEvent = 'waiting' | 'recovered';
let loginNotifier: ((e: LoginEvent) => void) | null = null;
export function setLoginNotifier(fn: ((e: LoginEvent) => void) | null): void {
  loginNotifier = fn;
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
  // PM2 restart 直後は、直前まで動いていた chromium がプロファイルのロック（Windows の
  // ProcessSingleton）を解放しきる前に launchPersistentContext が走り、「既存のブラウザ
  // セッションで開いています」で失敗することがある。これを放置すると起動失敗→即再起動→また
  // ロック衝突…の無音クラッシュループになる（実機で確認）。数秒あけて数回リトライし解放を待つ。
  ctx = null;
  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
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
      break;
    } catch (e) {
      if (attempt === 5) throw e;
      console.warn(`ブラウザ起動に失敗（プロファイルのロック解放待ちの可能性）。${attempt}/5、3秒後に再試行します: ${String(e).slice(0, 120)}`);
      await new Promise((r) => setTimeout(r, 3000));
    }
  }
  page = ctx!.pages()[0] ?? (await ctx!.newPage());
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
    // ★以前は5分デッドラインで throw していたが、それだと PM2 が即再起動し、開いていた
    //   ログイン用ウィンドウごと消えて 2FA を中断してしまう（＝誰にも通知されない無音クラッシュループ）。
    //   ヘッドフルなので手動ログインが済むまで待ち続け、運用グループには即時＋定期的にアラートする。
    console.log('未ログインの可能性。表示中のブラウザでログイン（2FA含む）してください。ログインを確認するまで待機します…');
    await p.goto(cfg.loginUrl, { waitUntil: 'domcontentloaded' }).catch(() => {});
    let nextAlertAt = 0; // 0 = まず1回目のアラートを即送る
    const REALERT_MS = 15 * 60_000; // 待機が続く間は15分ごとに再通知（気付けるように・ただしスパムは避ける）
    while (!ok) {
      if (Date.now() >= nextAlertAt) {
        try { loginNotifier?.('waiting'); } catch { /* 通知失敗で待機を止めない */ }
        nextAlertAt = Date.now() + REALERT_MS;
      }
      ok = await p.locator(SELECTORS.loggedInMarker).first().isVisible().catch(() => false);
      if (!ok) await p.waitForTimeout(2000);
    }
    // 実際に受信箱へ到達できてから「復旧・監視再開」を通知する（gotoInbox が失敗したら
    // 誤って再開を告げず、throw は main().catch のアラートに委ねる）
    await gotoInbox(inbox, 30_000);
    try { loginNotifier?.('recovered'); } catch { /* noop */ }
  }
  console.log(`Lpro ログイン確認OK（${inbox.name}）`);
}

/** 行スキャン結果（frame.evaluate で一括抽出）。各顧客の会話履歴（scans）も同時に取る */
type RowScan = { key: string; name: string; status: string; scans: MsgScan[] };

const lastLoggedCounts = new Map<string, string>();
// 受信箱ごとの「現在サイクルで表示上限に達しているか」。解消すれば false に戻る
const overLimitByInbox = new Map<string, boolean>();

/**
 * 検索フォームを明示的に送信して chatframe を目的の状態にする。
 * ★これが重要★ Lpro はサーバー側セッションに直前の検索条件（会員ID絞り込み等）を保持するため、
 * 単に画面を開き直すだけだと「送信時に会員ID検索した状態」が巡回に残り、他の未返信顧客を
 * 見落とす。巡回・返信のたびに必要な条件を明示送信することで、検索状態に依存しない動作にする。
 *   - 巡回:   memberId='' + 未返信のみ(or すべて)  → 全未返信を確定的に取得
 *   - 返信/掘り起こし: memberId=対象 + すべて         → その相手だけを確実に開く
 */
async function applySearch(
  inbox: Inbox,
  opts: { memberId: string; unreadOnly: boolean }
): Promise<Frame> {
  const p = page!;

  // menu iframe の検索欄を埋めて submit し、再読込後の chatframe を返す。
  // 二段iframe（main→menu）の描画は goto 完了後も遅れることがあるため、既定30sを待たず
  // 検索欄の出現を短く待つ。掴めなければ呼び出し側で1回だけ再ナビゲートして再試行する。
  const attempt = async (): Promise<Frame> => {
    // menu sub-iframe は chatframe より遅れて読み込まれる/差し替わることがあるため、
    // 検索欄が実際に出現するまで待つ（毎ループでフレームを取り直す）。
    const menu = await waitMenuReady(inbox, 12_000);
    await menu.locator(SELECTORS.memberIdFilter).first().fill(opts.memberId, { timeout: 8_000 });
    // 表示数を広げる（未返信100超の取りこぼし防止）。無ければ無視
    await menu.locator(SELECTORS.limitLarge).first().check({ timeout: 4_000 }).catch(() => {});
    const btn = opts.unreadOnly ? SELECTORS.searchUnreadButton : SELECTORS.searchAllButton;

    // ★検索フォーム submit は chatframe を再読込する（POST, target=chatframe）。
    // 一括返信行(rowid=0)は再読込前の旧文書にも常在するため「行が出た」では再読込完了を判定できない。
    // フォーム action への POST 応答を待って「再読込が確定した」ことを掴んでから読む。
    const respP = p
      .waitForResponse(
        (r) => inbox.chatframeRe.test(r.url()) && r.request().method() === 'POST',
        { timeout: 15_000 }
      )
      .catch(() => null);
    await menu.locator(btn).first().click({ timeout: 8_000 });
    await respP; // 応答到達（=新文書コミット）まで待つ

    // 応答後に chatframe を取り直し、描画の落ち着きを短く待つ
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      const f = findChatFrame(inbox);
      if (f) {
        await f.waitForSelector(SELECTORS.conversationItem, { timeout: 3_000, state: 'attached' }).catch(() => {});
        return f;
      }
      await p.waitForTimeout(300);
    }
    throw new Error(`${inbox.name}: 検索後に chatframe が表示されません（セッション切れの疑い）`);
  };

  await gotoInbox(inbox, 20_000);
  try {
    return await attempt();
  } catch (e) {
    if (isBrowserGoneError(e)) throw e; // ブラウザ喪失は上位の復旧に委ねる
    // 二段iframeの描画遅延・フレーム取り違えの一過性対策: 明示再ナビゲートして1回だけ再試行
    console.log(`${inbox.name}: 検索フォーム取得を再試行します（${String(e).slice(0, 80)}）`);
    currentInboxId = null; // gotoInbox に強制再ナビゲートさせる
    await gotoInbox(inbox, 20_000);
    return await attempt();
  }
}

/**
 * 指定受信箱の顧客行一覧を、各顧客の会話履歴（inbound）まで含めて1回の evaluate で取得する。
 * ★1パス抽出★ 顧客ごとに画面を開き直さないので、返信(openMember)が割り込んで表示が
 * 対象1名に絞られても、この巡回で取った各顧客のデータは揺らがない（共有画面の競合を根絶）。
 * 毎回「未返信のみ（会員ID絞り込み無し）」を明示送信して読む。一括返信行（会員ID無し）は除外。
 */
export async function pollConversations(inbox: Inbox): Promise<Conversation[]> {
  const f = await applySearch(inbox, { memberId: '', unreadOnly: cfg.onlyUnread });
  const rows: RowScan[] = await f.evaluate(
    (S) => {
      const out: Array<{ key: string; name: string; status: string;
        scans: Array<{ inbound: boolean; text: string; dt: string; hasImage: boolean }> }> = [];
      for (const row of document.querySelectorAll(S.conversationItem)) {
        const idEl = row.querySelector(S.memberIdText);
        const key = (idEl?.textContent ?? '').trim();
        if (!key) continue; // 一括返信行・会員ID欠落行はスキップ（誤爆防止）
        const name = (row.querySelector(S.customerName)?.textContent ?? '').trim().replace(/\s+/g, ' ').slice(0, 60);
        const status = (row.querySelector(S.statusCell)?.textContent ?? '').trim();
        const scans: Array<{ inbound: boolean; text: string; dt: string; hasImage: boolean }> = [];
        for (const g of row.querySelectorAll(S.messageGroup)) {
          const bubble = g.querySelector(S.bubble);
          if (!bubble) continue;
          const dt = Array.from(g.querySelectorAll(S.msgDatetime))
            .map((d) => (d.textContent ?? '').trim().replace(/\s+/g, ' ')).join(' ').trim();
          scans.push({
            inbound: g.classList.contains(S.inboundGroupClass),
            text: (bubble.textContent ?? '').trim().replace(/\s+/g, ' '),
            dt,
            hasImage: bubble.querySelector('img') !== null,
          });
        }
        out.push({ key, name, status, scans });
      }
      return out;
    },
    {
      conversationItem: SELECTORS.conversationItem,
      memberIdText: SELECTORS.memberIdText,
      customerName: SELECTORS.customerName,
      statusCell: SELECTORS.statusCell,
      messageGroup: SELECTORS.messageGroup,
      inboundGroupClass: SELECTORS.inboundGroupClass,
      bubble: SELECTORS.bubble,
      msgDatetime: SELECTORS.msgDatetime,
    }
  );
  if (rows.length === 0) {
    warnOnce(`empty-list-${inbox.id}`, `${inbox.name}: 顧客行が0件です。conversationItem セレクタと表示フィルタを確認してください。`);
  }
  // 表示上限に達したか（現在サイクルの状態）。解消したら false に戻し、再超過で再警告できるようにする
  overLimitByInbox.set(inbox.id, rows.length >= DISPLAY_LIMIT);
  const out = rows.map((r) => {
    // 未読判定は安全側: 「未返信」を含む、または「返信済」を含まない未知の状態は未読扱い
    const unread =
      r.status === ''
        ? true
        : r.status.includes(SELECTORS.unreadText) || !r.status.includes('返信済');
    if (r.status === '') {
      warnOnce(`empty-status-${inbox.id}`, `${inbox.name}: 返信状態セルが空の行があります。安全のため未読扱いにします。`);
    }
    return {
      memberId: r.key,
      name: r.name || `ID:${r.key}`,
      unread,
      inbound: toInbound(inbox.id, r.key, r.scans),
    };
  });
  const counts = `${out.length}行/未読${out.filter((o) => o.unread).length}件`;
  if (lastLoggedCounts.get(inbox.id) !== counts) {
    lastLoggedCounts.set(inbox.id, counts);
    console.log(`巡回[${inbox.name}]: ${counts}`);
  }
  return out;
}

/** いずれかの受信箱が現在サイクルで表示上限に達しているか（index.ts が rising-edge 通知に使う） */
export function pollHitLimit(): boolean {
  for (const v of overLimitByInbox.values()) if (v) return true;
  return false;
}

/**
 * 「すべて」検索で全会員IDだけを軽量取得する（メッセージ本文は読まない）。
 * ブートストラップで返信済み既存顧客も startupKeys に登録するために使う。
 * 表示上限で打ち切られた場合は truncated=true（startupKeys が不完全になる＝呼び出し側で保守運用）。
 */
export async function listAllMemberIds(inbox: Inbox): Promise<{ ids: string[]; truncated: boolean }> {
  const f = await applySearch(inbox, { memberId: '', unreadOnly: false });
  const ids: string[] = await f.evaluate(
    (S) => {
      const out: string[] = [];
      for (const row of document.querySelectorAll(S.conversationItem)) {
        const key = (row.querySelector(S.memberIdText)?.textContent ?? '').trim();
        if (key) out.push(key);
      }
      return out;
    },
    { conversationItem: SELECTORS.conversationItem, memberIdText: SELECTORS.memberIdText }
  );
  return { ids, truncated: ids.length >= DISPLAY_LIMIT };
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
 * menu iframe（検索フォーム）の member_id 欄が実際に出現するまで短くポーリングして待つ。
 * gotoInbox は chatframe しか待たないため、menu sub-iframe が少し遅れて読み込まれる/差し替わる
 * ケース（特に空の受信箱）で findMenuFrame が一瞬 null / 空文書を掴む問題を吸収する。
 * 毎ループでフレームを取り直すので、フレーム参照の差し替えにも強い。
 */
async function waitMenuReady(inbox: Inbox, timeoutMs: number): Promise<Frame> {
  const p = page!;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const menu = findMenuFrame(inbox);
    if (menu) {
      const ok = await menu
        .locator(SELECTORS.memberIdFilter)
        .first()
        .waitFor({ state: 'visible', timeout: Math.min(2_000, Math.max(500, deadline - Date.now())) })
        .then(() => true)
        .catch(() => false);
      if (ok) return menu;
    }
    await p.waitForTimeout(300);
  }
  throw new Error(`${inbox.name}: 検索フォーム(menu iframe)が現れません`);
}

/**
 * 会員IDで検索して、その1件だけを chatframe に表示させる（「すべて」=返信済みも含む）。
 * 返信済みの相手・掘り起こし対象（未返信一覧に居ない相手）も確実に開けるようにするための要。
 * 表示された chatframe を返す。会員IDが存在しない/検索が効かない場合は throw。
 */
async function openMember(inbox: Inbox, memberId: string): Promise<Frame> {
  // 「すべて」＝返信済みも含めて、その会員IDだけを表示する
  const f = await applySearch(inbox, { memberId, unreadOnly: false });
  const row = f
    .locator(SELECTORS.conversationItem)
    .filter({ has: f.locator(SELECTORS.memberIdText).getByText(memberId, { exact: true }) });
  if (await row.count().catch(() => 0) >= 1) return f;
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

/**
 * 特定顧客の会話履歴を会員ID検索で開いて読む（返信済みで未返信一覧から外れた相手も読める）。
 * 巡回は pollConversations が1パスで抽出するので、これは返信後の再取り込み等の単発読みに使う。
 */
export async function readInbound(inbox: Inbox, conv: Conversation): Promise<InboundMsg[]> {
  const f = await openMember(inbox, conv.memberId);
  const row = await findRow(f, conv.memberId, inbox);
  const scans: MsgScan[] = await row.evaluate(
    (rowEl, S) => {
      const out: Array<{ inbound: boolean; text: string; dt: string; hasImage: boolean }> = [];
      for (const g of rowEl.querySelectorAll(S.messageGroup)) {
        const bubble = g.querySelector(S.bubble);
        if (!bubble) continue;
        const dt = Array.from(g.querySelectorAll(S.msgDatetime))
          .map((d) => (d.textContent ?? '').trim().replace(/\s+/g, ' ')).join(' ').trim();
        out.push({
          inbound: g.classList.contains(S.inboundGroupClass),
          text: (bubble.textContent ?? '').trim().replace(/\s+/g, ' '),
          dt,
          hasImage: bubble.querySelector('img') !== null,
        });
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
  return toInbound(inbox.id, conv.memberId, scans);
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
  // 送信本文（先頭30字）。空白のみの返信はそもそも送らない（呼び出し側で弾く）。
  const probe = clean(text).slice(0, 30);
  if (!probe) {
    throw new Error(`${inbox.name}: 空のメッセージは送信できません`);
  }
  // 送信前の「送信本文を含む自分側吹き出しの数」（補助確認用）
  const countMatch = async (rowLoc: Locator): Promise<number> =>
    rowLoc.locator(outbound).filter({ hasText: probe }).count().catch(() => -1);
  const before = await countMatch(row);

  await row.locator(SELECTORS.replyInput).first().fill(text);

  const onDialog = (d: import('playwright').Dialog) => { void d.accept().catch(() => {}); };
  p.once('dialog', onDialog);
  try {
    // ★主シグナル: 送信ボタンは per-row フォームを POST(target=chatframe) する。この POST 応答が
    // 200 で返れば Lpro が返信を受理した＝送信成功。吹き出しの表示タイミングに依存せず確実。
    // （吹き出しでの確認は表示が遅れると偽陰性→二重送信を招くため主シグナルにしない）
    const respP = p
      .waitForResponse(
        (r) => inbox.chatframeRe.test(r.url()) && r.request().method() === 'POST',
        { timeout: 15_000 }
      )
      .catch(() => null);
    await row.locator(SELECTORS.sendButton).first().click();
    const resp = await respP;

    if (resp && resp.status() < 400) {
      console.log(`送信確認OK[${inbox.name}]（Lproが返信を受理: HTTP ${resp.status()}）`);
      return;
    }

    // 応答を捉えられなかった場合の補助確認: 会員IDで検索し直して送信本文の吹き出しが増えたか（長めに待つ）
    let lastReason = resp ? `POST応答 ${resp.status()}` : 'POST応答を捉えられず';
    for (let i = 0; i < 8; i++) {
      await p.waitForTimeout(1500);
      let fc: Frame;
      try { fc = await openMember(inbox, memberId); } catch { lastReason = '再検索待ち'; continue; }
      const row2 = fc
        .locator(SELECTORS.conversationItem)
        .filter({ has: fc.locator(SELECTORS.memberIdText).getByText(memberId, { exact: true }) });
      if (await row2.count().catch(() => 0) !== 1) { lastReason = '行の再取得待ち'; continue; }
      const now = await countMatch(row2);
      if (before >= 0 && now > before) {
        console.log(`送信確認OK[${inbox.name}]（自分側吹き出しに反映）`);
        return;
      }
    }
    throw new Error(
      `${inbox.name}: 送信を確認できませんでした（${lastReason}）。` +
      '⚠️ 実際には送信されている可能性もあります。再送する前に必ず Lpro の画面で確認してください'
    );
  } finally {
    p.off('dialog', onDialog);
  }
}
