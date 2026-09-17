import { chromium, type BrowserContext, type Page, type Frame, type Locator } from 'playwright';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { toConvMessages, type ScanMsg, type ConvMsg } from './logic.js';
import { attemptAutoLogin, loginFormVisible, pageHasVisibleInputs, type AutoLoginCreds, type AutoLoginResult } from './autologin.js';
import { cfg, SELECTORS, SEND_ACCEPT_RE, DISPLAY_LIMIT, DISPLAY_LIMIT_FALLBACK, httpCredentials, inboxes, type Inbox } from './config.js';
import {
  cookiesToRestore, describeCookies, cookieSignature, saveSessionFile, loadSessionFile, sessionFileSupported,
  type CookieRec,
} from './session.js';

/** conv.memberId は Lpro の会員ID（受信箱に依らず顧客不変）。DBキーは inbox 込みで index.ts が合成。
 * inbound は巡回時に一括抽出済みの顧客発言（共有画面の割り込み競合を避けるため poll 内で確定させる）。
 * 返信後の再取り込み経路など inbound 未添付で来た場合は readInbound で読む。 */
// 会話メッセージ（顧客側＋自分側の両方）。フィンガープリント生成は logic.ts の純関数に集約した。
export type InboundMsg = ConvMsg;
// 生スキャン型（DOM 抽出用）。フィンガープリント式は logic.toConvMessages が持つ
type MsgScan = ScanMsg;
export type Conversation = { memberId: string; name: string; unread: boolean; inbound?: InboundMsg[] };

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
export type LoginEvent = 'waiting' | 'wrong-site' | 'recovered' | 'auto-login' | 'auto-login-failed' | 'auto-login-blocked';
let loginNotifier: ((e: LoginEvent, detail?: string) => void) | null = null;
export function setLoginNotifier(fn: ((e: LoginEvent, detail?: string) => void) | null): void {
  loginNotifier = fn;
}
// 手動ログイン待ち（or 別アカウントからのログインし直し待ち）の最中か。日次のブラウザ再起動はこの間スキップする
let loginWaiting = false;
export function isLoginWaiting(): boolean {
  return loginWaiting;
}
// ブラウザ世代。initBrowser が成功するたびに増える。巡回ループの復旧経路が「エラー観測後に別経路（日次再起動）で
// 既に開き直された」ことを検知して二重再起動しないために使う
let generation = 0;
export function browserGeneration(): number {
  return generation;
}
const loggedOnce = new Set<string>();
function logOnce(key: string, msg: string): void {
  if (loggedOnce.has(key)) return;
  loggedOnce.add(key);
  console.log(msg);
}

// ── ログイン Cookie の引き継ぎ（背景と方式は src/session.ts の冒頭）──
// 開き直し（recycleBrowser）／再初期化で閉じる直前に退避した Lpro の Cookie。直後の initBrowser が1回だけ消費する
let carriedCookies: CookieRec[] | null = null;
// いまのブラウザ（ctx）が「ログイン確認OK」を通ったか。通っていない間の Cookie（ログイン画面が発行した未認証の
// JSESSIONID、別アカウントのもの）を退避すると、直前まで有効だった退避分を上書きしてしまうので、退避の条件にする
let sessionVerified = false;
// 直近に .lpro-session へ書いた内容のシグネチャ（同じ内容の書き直し＝PowerShell 起動を省く）
let lastSavedSig: string | null = null;
// 退避の書き込みは直列化する（ログイン確認OK の非同期保存と終了時の保存が重ならないように）
let saveChain: Promise<void> = Promise.resolve();

const sessionOwner = (): { instanceId: string; host: string } => ({ instanceId: cfg.instanceId, host: new URL(cfg.loginUrl).host });

/** Lpro（loginUrl のオリジン）へ送られる Cookie。値はログに出さないこと */
async function lproCookies(c: BrowserContext): Promise<CookieRec[]> {
  return (await c.cookies([cfg.loginUrl])) as CookieRec[];
}

/** 閉じる前に Lpro の Cookie をプロセス内に退避する（上限時間付き。取れなければ null＝.lpro-session 頼み） */
async function carryCookies(c: BrowserContext): Promise<void> {
  const cs = await Promise.race([
    lproCookies(c).catch(() => null),
    new Promise<null>((r) => setTimeout(() => r(null), 10_000)),
  ]);
  carriedCookies = cs && cs.length > 0 ? cs : null;
}

/** 起動直後（ナビゲーション前）: プロファイルに無い Lpro の Cookie を、開き直し前の退避分 → .lpro-session の順で戻す */
async function restoreSessionCookies(c: BrowserContext): Promise<void> {
  const present = await lproCookies(c);
  let snapshot: CookieRec[] = [];
  let source = '';
  if (carriedCookies) {
    snapshot = carriedCookies;
    source = '開き直し前の退避分';
  } else if (sessionFileSupported()) {
    // 起動直後は PowerShell のコールドスタートで時間がかかることがあるので 1 回だけ再試行する
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        const loaded = await loadSessionFile(cfg.sessionFile, sessionOwner());
        if (loaded) {
          snapshot = loaded.cookies;
          source = `.lpro-session（${loaded.savedAt} 保存）`;
        }
        break;
      } catch (e) {
        const msg = String(e).slice(0, 220);
        if (attempt === 1 && !/別の案件|形式が不明|内容が不正/.test(msg)) {
          await new Promise((r) => setTimeout(r, 1500));
          continue;
        }
        console.warn(`.lpro-session を読めませんでした（無視して通常のログイン確認に進みます）: ${msg}`);
        break;
      }
    }
  }
  carriedCookies = null;
  const toAdd = cookiesToRestore(snapshot, present, Math.floor(Date.now() / 1000));
  if (toAdd.length > 0) {
    try {
      await c.addCookies(toAdd);
      console.log(`Lpro Cookie を復元: ${describeCookies(toAdd)}（${source}）`);
    } catch (e) {
      console.warn(`Lpro Cookie の復元に失敗（通常のログイン確認に進みます）: ${String(e).slice(0, 160)}`);
    }
  } else if (present.length > 0) {
    console.log(`Lpro Cookie: プロファイルに残存（${describeCookies(present)}）`);
  } else {
    console.log('Lpro Cookie: プロファイルにも退避分にも無し（初回、または退避前に失効）。ログインが必要な見込み');
  }
}

/**
 * Lpro の Cookie を .lpro-session に退避する。「ログイン確認OK」を通ったブラウザの Cookie だけを対象にし、
 * 内容が前回と同じでファイルも残っていれば何もしない。失敗しても本体の動作は止めない
 */
function persistSessionCookies(c: BrowserContext, when: string): Promise<void> {
  if (!sessionFileSupported()) return Promise.resolve();
  // ログイン待ち中／未確認のブラウザの Cookie（未認証の JSESSIONID・別アカウント）で有効な退避分を上書きしない
  if (!sessionVerified || loginWaiting) return Promise.resolve();
  const run = async (): Promise<void> => {
    let cs: CookieRec[];
    try {
      cs = await Promise.race([
        lproCookies(c),
        new Promise<CookieRec[]>((_, rej) => setTimeout(() => rej(new Error('cookies() timeout')), 5_000)),
      ]);
    } catch {
      return; // ブラウザが既に死んでいる等。退避済みの前回分がそのまま残る
    }
    if (cs.length === 0) return; // Cookie ゼロ（起動直後など）で前回のログイン済み分を消さない
    const sig = cookieSignature(cs);
    // 同じ内容でも、ファイルが消されていれば書き直す（RUNBOOK「消しても次のログイン確認OKで作り直される」を守る）
    if (sig === lastSavedSig && existsSync(cfg.sessionFile)) return;
    try {
      await saveSessionFile(cfg.sessionFile, cs, sessionOwner());
      lastSavedSig = sig;
      console.log(`Lpro Cookie を退避しました（${when}: ${describeCookies(cs)}）`);
    } catch (e) {
      console.warn(`Lpro Cookie の退避に失敗（${when}）: ${String(e).slice(0, 160)}`);
    }
  };
  saveChain = saveChain.then(run, run);
  return saveChain;
}

/** 進行中の退避書き込みが終わるまで待つ（login.ts が「保存しました」と言う前に呼ぶ） */
export function flushSessionSave(): Promise<void> {
  return saveChain;
}

function clean(s: string | null | undefined): string {
  return (s ?? '').trim().replace(/\s+/g, ' ');
}

/**
 * クラッシュ（graceful shutdown を経ない強制終了）で残った Playwright の chromium は、この
 * プロファイル（userDataDir）のロックを掴んだままになり、次回 launchPersistentContext を失敗させる。
 * 待つだけでは解放されないので、userDataDir を --user-data-dir に持つ chrome.exe だけを狙って終了する。
 * ユーザーの通常 Chrome は別プロファイルなのでコマンドライン一致せず対象外。Windows 専用（対象外OSは何もしない）。
 */
async function killStaleProfileChromium(): Promise<void> {
  if (process.platform !== 'win32') return;
  const dir = resolve(cfg.userDataDir);
  // --user-data-dir=<dir> の完全一致だけを狙う。前方一致（*<dir>*）だと instances/a と instances/ab の
  // ように別案件のプロファイルまで巻き添えで殺す。引用符の有無・末尾の区切り（空白/行末）両対応。
  // .NET 正規表現のメタ文字と PowerShell 単一引用符をエスケープする
  const escaped = dir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/'/g, "''");
  const re = `--user-data-dir="?${escaped}"?(\\s|$)`;
  const psCmd =
    `Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" | ` +
    `Where-Object { $_.CommandLine -match '${re}' } | ` +
    `ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`;
  await new Promise<void>((res) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', psCmd],
      { timeout: 15_000, windowsHide: true },
      () => res() // 失敗しても launch リトライに委ねる（例外にしない）
    );
  });
}

export async function initBrowser(): Promise<void> {
  if (inboxes.length === 0) {
    throw new Error(
      '有効な受信箱がありません（.env の CHAT_TALK_URL+CHAT_GROUP_CHAT_ID か ' +
      'TALK_TALK_URL+TALK_GROUP_CHAT_ID を設定してください）。`npm run doctor` で確認できます'
    );
  }
  // 再初期化（クラッシュ復旧）に備えて既存コンテキストは先に閉じる。ブラウザ自体が生きていれば
  // （Page crashed 等）正常 close でセッションCookieが捨てられるので、開き直しと同じく先に退避する
  if (ctx) {
    if (sessionVerified && !carriedCookies) await carryCookies(ctx);
    await closeBrowser();
  }
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
      console.warn(`ブラウザ起動に失敗（プロファイルのロック競合の可能性）。残存chromiumを掃除して ${attempt}/5、3秒後に再試行します: ${String(e).slice(0, 120)}`);
      // 強制終了（クラッシュ）で残った chromium はロックを掴んだまま解放しないので、掃除してから待つ
      await killStaleProfileChromium();
      await new Promise((r) => setTimeout(r, 3000));
    }
  }
  page = ctx!.pages()[0] ?? (await ctx!.newPage());
  currentInboxId = null;
  generation++;
  sessionVerified = false; // 新しいブラウザ。ensureLoggedIn が通るまで退避しない
  resetAutoLoginForNewBrowser(); // 前のブラウザの画面に紐づく再試行待ちは持ち越さない（バックオフは維持）
  // 正常終了→再起動で Chromium が捨てるセッションCookie（JSESSIONID）を、最初のナビゲーションの前に戻す
  await restoreSessionCookies(ctx!);
  // 最初の受信箱でログイン確認（複数受信箱でもログインは共通のセッション）
  await ensureLoggedIn(inboxes[0]);
}

/** 終了時に呼ぶ。ブラウザ（永続コンテキスト）を閉じる */
export async function closeBrowser(): Promise<void> {
  // 閉じる前に Lpro の Cookie を退避しておく（正常終了で Chromium がセッションCookieを捨てるため）。
  // 内容が前回退避分と同じなら何もしない。終了処理の猶予（PM2 kill_timeout）を食い潰さないよう上限付き
  if (ctx) {
    await Promise.race([
      persistSessionCookies(ctx, '終了前'),
      new Promise<void>((r) => setTimeout(r, 6_000)),
    ]);
  }
  try { await ctx?.close(); } catch { /* already closed */ }
  ctx = null;
  page = null;
  currentInboxId = null;
  sessionVerified = false;
}

/**
 * ブラウザ（chromium）を閉じて開き直す（日次の定期再起動）。長時間稼働で一覧の空振り・検索フォーム待ちの
 * タイムアウトが日を追って増える傾向（2026-08-16〜20、08-30〜09-07 の2期間で観測。9日目で約7倍）を
 * リセットする。★必ず runExclusive 内で呼ぶこと★（巡回・返信と直列化し、送信途中のブラウザを閉じない）。
 * ★ログインセッション（JSESSIONID）は有効期限なしのセッションCookieで、Chromium は正常終了→再起動で捨てる
 *   （2026-09-11 09:00 の定期再起動でログアウト→ログイン待ちになった。実験でも再現）。プロファイル任せにせず、
 *   閉じる前に cookies() で退避し、initBrowser が addCookies() で戻す（src/session.ts）。
 * Lpro 側で失効していれば initBrowser 内の ensureLoggedIn が通常どおりログイン待ち＋アラートに入る。
 * close が固まっても待ちは有限にし、残存 chromium は強制終了してから開き直す
 * （ctx を先に手放すので、initBrowser が固まった close を再び待つことはない）。
 */
export async function recycleBrowser(shouldAbort: () => boolean = () => false): Promise<void> {
  const old = ctx;
  ctx = null;
  page = null;
  currentInboxId = null;
  if (old) {
    // 閉じる前にログイン Cookie を退避（直後の initBrowser が1回だけ消費する）。取れなければ .lpro-session 頼み
    await carryCookies(old);
    sessionVerified = false;
    console.log(`開き直し前に Lpro Cookie を退避: ${carriedCookies ? describeCookies(carriedCookies) : '取得できず'}`);
    const closed = await Promise.race([
      old.close().then(() => true, () => true),
      new Promise<boolean>((r) => setTimeout(() => r(false), 30_000)),
    ]);
    if (!closed) {
      console.warn('ブラウザの終了が30秒で完了しません。残存 chromium を強制終了してから開き直します');
      await killStaleProfileChromium();
    }
  }
  // 閉じている間に終了処理（PM2 stop）が始まっていたら開き直さない（chromium 残骸・不要なログイン待ちを作らない）
  if (shouldAbort()) {
    carriedCookies = null;
    return;
  }
  await initBrowser();
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

/** ログイン中の Lpro サイト（＝アカウント）の識別子: 検索フォーム iframe の URL に載る site_id。
 * 読めなければ空＝照合しない（誤ロックアウトより見逃しを選ぶ）。
 * （/manage シェルの .sitename 表示名は、ブリッジが開く画面（chat_message?method=frame 等）には無いので読まない） */
async function readSiteId(inbox: Inbox): Promise<string> {
  const p = page!;
  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline) {
    const m = findMenuFrame(inbox);
    let id: string | null = null;
    try { id = m ? new URL(m.url()).searchParams.get('site_id') : null; } catch { id = null; }
    if (id) return id.trim();
    await p.waitForTimeout(300);
  }
  return '';
}

// site_id の比較は先頭ゼロを無視する（"016" と "16" を別物にすると永久ログイン待ちになる）
const normSiteId = (s: string): string => s.trim().replace(/^0+(?=\d)/, '');

/** 期待するサイトID（LPRO_SITE_ID）と違うアカウントでログインしていれば、その説明文を返す（照合不能/一致なら null） */
async function siteMismatch(inbox: Inbox): Promise<string | null> {
  const siteId = await readSiteId(inbox);
  logOnce(
    `site:${siteId}`,
    `Lpro サイト確認: site_id=${siteId || '?'}` +
      (cfg.lproSiteId
        ? ` / 期待 site_id=${cfg.lproSiteId}`
        : '（LPRO_SITE_ID 未設定＝照合なし。.env に設定すると別アカウントでのログインを自動で弾けます）')
  );
  if (cfg.lproSiteId && siteId && normSiteId(siteId) !== normSiteId(cfg.lproSiteId)) {
    return `期待 site_id=${cfg.lproSiteId} に対して site_id=${siteId} でログインされています`;
  }
  return null;
}

/**
 * Lpro からログアウトする（別アカウントでログインされていたとき用）。
 * /manage シェルを開いてログアウトリンクの href を辿る（無ければ <LPRO_LOGIN_URL>/logout。末尾スラッシュの有無に依らず
 * /manage/logout に解決する）。実際にログアウトできたか（ログイン済みマーカーが消えたか）を返す。
 * ログアウトが効かない環境で「ログアウトしました」と言い続ける高速ループにしないための検証
 */
async function logoutLpro(p: Page): Promise<boolean> {
  await p.goto(cfg.loginUrl, { waitUntil: 'domcontentloaded' }).catch(() => {});
  let target: string | null = null;
  try {
    const href = await p.locator(SELECTORS.loggedInMarker).first().getAttribute('href', { timeout: 2_000 });
    if (href) target = new URL(href, p.url()).toString();
  } catch { /* シェル以外の画面ならフォールバック */ }
  if (!target) {
    const base = cfg.loginUrl.endsWith('/') ? cfg.loginUrl : cfg.loginUrl + '/';
    target = new URL('logout', base).toString();
  }
  await p.goto(target, { waitUntil: 'domcontentloaded' }).catch(() => {});
  await p.goto(cfg.loginUrl, { waitUntil: 'domcontentloaded' }).catch(() => {});
  const stillIn = await p.locator(SELECTORS.loggedInMarker).first()
    .waitFor({ state: 'visible', timeout: 3_000 }).then(() => true, () => false);
  return !stillIn;
}

// ── 自動ログイン（src/autologin.ts）の再試行制御。プロセス内で持つ ──
// 失敗のたびに間隔を延ばす（同じ資格情報を連打してアカウントロックを招かない）。ログイン確認OK でリセット。
// 「送信したがログインフォーム以外の対話ページになった」（追加認証など）は失敗に数えず、画面を触らずに人を待つ
const AUTO_LOGIN_BACKOFF_MS = [30_000, 2 * 60_000, 10 * 60_000, 30 * 60_000, 60 * 60_000];
const AUTO_LOGIN_RESULT_WAIT_MS = 30_000;       // 送信後にログイン済みマーカーを待つ上限（同じ document のままなら同じ長さだけ延長＝遅い応答）
const AUTO_LOGIN_LATE_SUCCESS_MS = 3 * 60_000;  // 送信からこの時間内にマーカーが出たら「自動ログインで入った」とみなす（失敗確定後は除く）
const AUTO_LOGIN_FORM_WAIT_MS = 8_000;          // ログインページを開いた後、フォーム（or マーカー）の描画を待つ上限
const AUTO_LOGIN_OTHER_PAGE_WAIT_MS = 15 * 60_000;
const AUTO_LOGIN_HUMAN_PAGE_EXTEND_MS = 60_000; // 人が操作中かもしれないページを見つけたとき、再試行を延ばす単位
const AUTO_LOGIN_HUMAN_PAGE_MAX_EXTENDS = 15;   // その延長の上限（≒15分）。超えたら開き直して再試行する（無限に待たない）
const AUTO_LOGIN_NO_FORM_RETRY_MS = 60_000;
const AUTO_LOGIN_NEED_INPUT_RETRY_MS = 15 * 60_000;
const AUTO_LOGIN_PROBE_EVERY_MS = 60_000;       // 待機中、別タブでログイン状態を確かめる間隔（nav の無い着地ページ対策）
const AUTO_LOGIN_LOG_EVERY_MS = 15 * 60_000;
let autoLoginFailures = 0;    // 資格情報が拒否された（送信後もログインフォームのまま／応答不明）連続回数
let autoLoginOtherPages = 0;  // 送信後に入力欄のある別ページ（追加認証？）へ着地した連続回数（通知の間引き用）
let autoLoginNextAt = 0;
let autoLoginLastResult = ''; // describeAutoLogin（バナー・⚠️通知）用の直近結果
let autoLoginLastFilledFrom: 'env' | 'prefilled' | null = null;
// 直近の送信時刻と、その送信を「失敗」と確定したか。失敗確定していない送信の直後にマーカーが出たら自動ログイン成功とみなす
let autoLoginSubmittedAt = 0;
let autoLoginSubmitFailed = false;
// 資格情報（.env またはブラウザの自動入力）が「この案件と別のアカウント」だった等、人が直すまで自動ログインを止める理由
let autoLoginBlocked: string | null = null;
let autoLoginBlockedSource: 'env' | 'prefilled' | null = null;
const lastLoggedAt = new Map<string, number>();
/** 同じ趣旨のログを ms に1回に間引く（logOnce だと「続いているか」が分からず、毎回だと洪水になるもの向け） */
function logEvery(key: string, ms: number, msg: string): void {
  const now = Date.now();
  if (now - (lastLoggedAt.get(key) ?? 0) < ms) return;
  lastLoggedAt.set(key, now);
  console.log(msg);
}
/** ブラウザを開き直したとき（クラッシュ復旧・日次再起動）に呼ぶ: 画面に紐づく待ち時間は捨て、ロック防止のバックオフだけ残す */
function resetAutoLoginForNewBrowser(): void {
  autoLoginOtherPages = 0;
  autoLoginSubmittedAt = 0;
  autoLoginSubmitFailed = false;
  if (autoLoginFailures === 0) autoLoginNextAt = 0;
}

function autoLoginCreds(): AutoLoginCreds | null {
  return cfg.loginPasskey ? { id: cfg.loginId, pass: cfg.loginPasskey } : null;
}
function autoLoginEnabled(): boolean {
  return cfg.autoLogin !== 'off' && !autoLoginBlocked;
}
/** バナー・ログ・通知用の自動ログイン状態の説明（資格情報の値は含めない） */
export function describeAutoLogin(): string {
  if (cfg.autoLogin === 'off') return '無効（AUTO_LOGIN=off）';
  if (autoLoginBlocked) return `停止中（${autoLoginBlocked}）`;
  const src = autoLoginCreds() ? '.env の ID/パスキーを入力して送信' : '入力済みのフォームを送信（LPRO_LOGIN_ID/PASSKEY 未設定）';
  const last = autoLoginLastResult ? `。直近: ${autoLoginLastResult}` : '';
  if (autoLoginNextAt > Date.now()) {
    return `有効: ${src}${last}。次の自動再試行 ${new Date(autoLoginNextAt).toLocaleTimeString('ja-JP')}`;
  }
  return `有効: ${src}${last}`;
}
function notifyLogin(e: LoginEvent, detail?: string): void {
  try { loginNotifier?.(e, detail); } catch { /* 通知失敗で待機を止めない */ }
}
function fmtWait(ms: number): string {
  return ms < 60_000 ? `${Math.round(ms / 1000)}秒後` : `約${Math.round(ms / 60_000)}分後`;
}
const loginSelectors = () => ({ loginPassInput: SELECTORS.loginPassInput, loginIdInput: SELECTORS.loginIdInput, loginSubmit: SELECTORS.loginSubmit });

/** ログインページを開いた直後、ログイン済みマーカーかログインフォームのどちらかが描画されるまで待つ（JS 描画・遅い応答・iframe 対策） */
async function waitForLoginPage(p: Page, timeoutMs: number): Promise<'marker' | 'form' | 'none'> {
  const deadline = Date.now() + timeoutMs;
  const marker = p.locator(SELECTORS.loggedInMarker).first();
  for (;;) {
    if (await marker.isVisible().catch(() => false)) return 'marker';
    if (await loginFormVisible(p, SELECTORS.loginPassInput)) return 'form';
    if (Date.now() >= deadline) return 'none';
    await p.waitForTimeout(300);
  }
}
async function waitForMarker(p: Page, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  const marker = p.locator(SELECTORS.loggedInMarker).first();
  while (Date.now() < deadline) {
    if (await marker.isVisible().catch(() => false)) return true;
    await p.waitForTimeout(500);
  }
  return false;
}
/** いま表示中の画面を壊さずにログイン状態を確かめる: 同じコンテキスト（＝同じ Cookie）で別タブに /manage/ を開き、
 * ログイン済みマーカーが出るかを見て閉じる。送信後の着地ページに nav が無い場合や、人が追加認証を操作中の場合に使う */
async function probeLoggedIn(p: Page, timeoutMs = 10_000): Promise<boolean> {
  let tab: Page | null = null;
  try {
    tab = await p.context().newPage();
    await tab.goto(cfg.loginUrl, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
    return await tab.locator(SELECTORS.loggedInMarker).first()
      .waitFor({ state: 'visible', timeout: timeoutMs }).then(() => true, () => false);
  } catch (e) {
    if (isBrowserGoneError(e)) throw e;
    return false;
  } finally {
    await tab?.close().catch(() => {});
  }
}
// 送信前に main frame の document に印を付ける。送信後も印が残っていれば「まだ同じ document」＝ナビゲーション待ち
// （遅いログイン応答）か JS だけの拒否表示。印が消えていればサーバー応答で描画し直された
const STAMP_KEY = '__lproBridgeLoginStamp';
async function stampDocument(p: Page): Promise<void> {
  await p.evaluate((k) => { (window as unknown as Record<string, unknown>)[k] = 1; }, STAMP_KEY).catch(() => {});
}
async function stampPresent(p: Page): Promise<boolean> {
  return p.evaluate((k) => (window as unknown as Record<string, unknown>)[k] === 1, STAMP_KEY).catch(() => false);
}

type AutoLoginAttempt = { loggedIn: boolean; submitted: boolean; notified: boolean };

/** ログインページで自動ログインを1回試み、結果を分類する。送信は最大1回。
 * 結果に応じて次回の試行時刻（autoLoginNextAt）・失敗回数・直近結果を更新する。
 * notified=true は ⚠️ を出した（呼び出し側が「未ログイン」アラート済みとして扱い、復旧時に ✅ を出す） */
async function tryAutoLoginOnce(p: Page, retry: boolean): Promise<AutoLoginAttempt> {
  const none: AutoLoginAttempt = { loggedIn: false, submitted: false, notified: false };
  const creds = autoLoginCreds();
  // フォーム（or マーカー）の描画待ち。domcontentloaded 直後は JS 描画・iframe が間に合わないことがある
  const state = await waitForLoginPage(p, AUTO_LOGIN_FORM_WAIT_MS);
  if (state === 'marker') {
    autoLoginLastResult = 'ログイン済みを検出';
    return { loggedIn: true, submitted: false, notified: false };
  }
  let r: AutoLoginResult = { kind: 'no-form', detail: `パスキー欄 ${SELECTORS.loginPassInput} もログイン済みマーカーも ${AUTO_LOGIN_FORM_WAIT_MS / 1000} 秒以内に表示されず` };
  if (state === 'form') {
    await stampDocument(p);
    try {
      r = await attemptAutoLogin(p, { creds, selectors: loginSelectors(), log: (m) => console.log(m), skipIfTyped: retry });
    } catch (e) {
      // attemptAutoLogin が throw したときは送信していない（autologin.ts の契約）。エラー文は資格情報をスクラブ済み
      if (isBrowserGoneError(e)) throw e;
      console.warn(`${String(e).split('\n')[0]?.slice(0, 220)}（${AUTO_LOGIN_NO_FORM_RETRY_MS / 1000}秒後に再試行）`);
      autoLoginLastResult = '入力/送信の操作に失敗';
      autoLoginNextAt = Date.now() + AUTO_LOGIN_NO_FORM_RETRY_MS;
      return none;
    }
  }
  if (r.kind === 'no-form') {
    autoLoginLastResult = 'ログインフォーム未検出';
    logEvery('autologin:no-form', AUTO_LOGIN_LOG_EVERY_MS,
      `自動ログイン: ログインフォームが見つかりません（${r.detail}）。Lpro 停止中・追加認証・画面変更の可能性。` +
      `${AUTO_LOGIN_NO_FORM_RETRY_MS / 1000}秒ごとに再確認します（このログは${AUTO_LOGIN_LOG_EVERY_MS / 60_000}分に1回）`);
    autoLoginNextAt = Date.now() + AUTO_LOGIN_NO_FORM_RETRY_MS;
    return none;
  }
  if (r.kind === 'need-input') {
    autoLoginLastResult = '入力待ち（資格情報なし）';
    logEvery('autologin:need-input', AUTO_LOGIN_LOG_EVERY_MS,
      `自動ログイン: ${r.detail}。.env に LPRO_LOGIN_ID / LPRO_LOGIN_PASSKEY を設定すると無人で復旧できます（RUNBOOK C）`);
    autoLoginNextAt = Date.now() + AUTO_LOGIN_NEED_INPUT_RETRY_MS;
    return none;
  }
  if (r.kind === 'busy') {
    autoLoginLastResult = '人が入力中のため見送り';
    logEvery('autologin:busy', AUTO_LOGIN_LOG_EVERY_MS, `自動ログイン: ${r.detail}。${AUTO_LOGIN_NO_FORM_RETRY_MS / 1000}秒後に見直します`);
    autoLoginNextAt = Date.now() + AUTO_LOGIN_NO_FORM_RETRY_MS;
    return none;
  }
  autoLoginLastFilledFrom = r.filledFrom;
  autoLoginSubmittedAt = Date.now();
  autoLoginSubmitFailed = false;
  console.log(`自動ログイン: 送信しました（${r.filledFrom === 'env' ? '.env の資格情報' : '入力済みのフォーム'} / ${r.detail}）。結果を待ちます…`);
  const succeed = (when: string): AutoLoginAttempt => {
    autoLoginFailures = 0;
    autoLoginOtherPages = 0;
    autoLoginNextAt = 0;
    autoLoginLastResult = `成功（${when}）`;
    console.log(`自動ログイン: ログイン済みを確認しました（${when}）`);
    return { loggedIn: true, submitted: true, notified: false };
  };
  const fail = (reason: string): AutoLoginAttempt => {
    autoLoginFailures++;
    autoLoginOtherPages = 0;
    autoLoginSubmitFailed = true;
    const wait = AUTO_LOGIN_BACKOFF_MS[Math.min(autoLoginFailures - 1, AUTO_LOGIN_BACKOFF_MS.length - 1)];
    autoLoginNextAt = Date.now() + wait;
    autoLoginLastResult = `失敗 ${autoLoginFailures} 回（${reason}）`;
    const msg = `自動ログインに失敗しました（${autoLoginFailures}回目: ${reason}）。次の自動再試行は${fmtWait(wait)}`;
    console.warn(`自動ログイン: ${msg}`);
    // 通知は 1回目・3回目、以後は毎回（5回目以降は再試行が1時間間隔なので連発しない）
    const notify = autoLoginFailures === 1 || autoLoginFailures === 3 || autoLoginFailures >= 5;
    if (notify) notifyLogin('auto-login-failed', msg);
    return { loggedIn: false, submitted: true, notified: notify };
  };
  if (await waitForMarker(p, AUTO_LOGIN_RESULT_WAIT_MS)) return succeed('送信直後');
  // 同じ document のままフォームが見えている＝サーバー応答待ち（遅いログイン）か JS だけの拒否表示。同じ長さだけ1回延長する
  if ((await loginFormVisible(p, SELECTORS.loginPassInput)) && (await stampPresent(p))) {
    console.log(`自動ログイン: ${AUTO_LOGIN_RESULT_WAIT_MS / 1000}秒たっても応答がありません（Lpro が遅い可能性）。もう${AUTO_LOGIN_RESULT_WAIT_MS / 1000}秒待ちます`);
    if (await waitForMarker(p, AUTO_LOGIN_RESULT_WAIT_MS)) return succeed('遅い応答');
  }
  // マーカーが出ない。いまの画面で分類する（画面は壊さない: ログイン状態の確認は別タブで行う）:
  //  (a) ログインフォームが出ている          → 資格情報が拒否された（or 送信が効かなかった）: 失敗として数え、バックオフ
  //  (b) 入力欄のある別ページ                → 別タブで確認してログイン済みならそれで成功（nav の無い着地ページ）。
  //                                            未ログインなら追加認証・確認画面の可能性: 触らず長めに待つ
  //  (c) 入力欄の無いページ（空・エラー）    → 別タブで確認して成功/未ログインを判定。未ログインならログインURLを開き直し、
  //                                            フォームが出ても出なくても失敗として数える（応答不明でもバックオフに乗せる）
  if (!(await loginFormVisible(p, SELECTORS.loginPassInput))) {
    if (await probeLoggedIn(p)) {
      // 着地ページに nav が無いだけ。本体側の画面もログインURLへ寄せる
      await p.goto(cfg.loginUrl, { waitUntil: 'domcontentloaded' }).catch(() => {});
      return succeed('別タブで確認');
    }
    if (await pageHasVisibleInputs(p)) {
      autoLoginOtherPages++;
      autoLoginLastResult = '送信後に別の入力ページ（追加認証？）';
      const msg =
        `送信後にログインフォーム以外の入力ページ（追加認証や確認画面の可能性）が表示されています（${autoLoginOtherPages}回目）。` +
        `${AUTO_LOGIN_OTHER_PAGE_WAIT_MS / 60_000}分間は画面を触らず人の操作を待ちます`;
      console.warn(`自動ログイン: ${msg}`);
      autoLoginNextAt = Date.now() + AUTO_LOGIN_OTHER_PAGE_WAIT_MS;
      const notify = autoLoginOtherPages === 1 || autoLoginOtherPages === 3 || autoLoginOtherPages >= 5;
      if (notify) notifyLogin('auto-login-failed', msg);
      return { loggedIn: false, submitted: true, notified: notify };
    }
    console.log('自動ログイン: 送信後の画面にマーカーもフォームも入力欄もなく、別タブでも未ログインです。ログインページを開き直します');
    await p.goto(cfg.loginUrl, { waitUntil: 'domcontentloaded' }).catch(() => {});
    const st = await waitForLoginPage(p, 10_000);
    if (st === 'marker') return succeed('開き直し後');
    return fail(st === 'form' ? '送信後にエラーページ→ログイン画面。ID/パスキー拒否の疑い' : '送信後の応答が不明（Lpro 側の一過性エラー？）');
  }
  return fail('ID/パスキー拒否の疑い');
}

export async function ensureLoggedIn(inbox: Inbox = inboxes[0]): Promise<void> {
  const p = page!;
  await p.goto(inbox.talkUrl, { waitUntil: 'domcontentloaded' });
  currentInboxId = inbox.id;
  // トーク画面が出ればログイン済み。未ログインならログインページへリダイレクトされ chatframe は現れない
  let ok = await findChatFrame(inbox)
    ? true
    : await gotoInbox(inbox, 15_000).then(() => true).catch(() => false);
  // ログイン済みでも「この案件とは別のアカウント」なら受信・返信に進んではいけない（別案件の顧客への誤送信）。
  // ログアウトして、正しいアカウントでのログイン待ちに入る
  let wrongSite: string | null = ok ? await siteMismatch(inbox) : null;
  let initialLogoutFailed = false;
  if (wrongSite) {
    ok = false;
    initialLogoutFailed = !(await logoutLpro(p));
  }
  // 直近のログインが自動ログインによるものか（別アカウント判定時に「資格情報の誤り」として自動ログインを止める／
  // 復旧通知の文面を変えるため）。alerted = 運用へ ⚠️/🚫 を出したか（出したときだけ復旧の ✅ を出す）
  let viaAuto = false;
  let alerted = false;
  const headlessError = (prefix: string): Error => new Error(
    prefix +
    (autoLoginBlocked ? `自動ログインは停止中（${autoLoginBlocked}）で、` : '') +
    'HEADLESS=true のため手動ログインできません。.env で HEADLESS=false にして `npm run login` を実行するか、' +
    'LPRO_LOGIN_ID / LPRO_LOGIN_PASSKEY（と LPRO_SITE_ID）を設定して自動ログインを有効にしてください'
  );
  if (!ok) {
    // 無人で成立する自動ログインは「.env の資格情報あり」のときだけ（ブラウザの自動入力は headless では効かず、人もいない）
    if (cfg.headless && !(autoLoginEnabled() && autoLoginCreds())) {
      throw headlessError(wrongSite ? `別のアカウントでログインされています（${wrongSite}）が、` : '未ログインですが ');
    }
    // ★以前は5分デッドラインで throw していたが、それだと PM2 が即再起動し、開いていた
    //   ログイン用ウィンドウごと消えて 2FA を中断してしまう（＝誰にも通知されない無音クラッシュループ）。
    //   ヘッドフルなので手動ログインが済むまで待ち続け、運用グループにアラートする
    //   （通常の未ログインは 20 秒続いてから初回、以後 15 分ごと。別アカウント検出は即時。
    //   20 秒以内に自己回復した一過性の空振りでは ⚠️ も ✅ も飛ばさない）。
    // ★2026-09-17〜 自動ログイン: ログインフォームが出ていれば .env の資格情報（or 自動入力済みの内容）で送信し、
    //   人を待たずに復旧する。失敗時はバックオフして再試行し、その間も人の手動ログインを受け付ける（下の待機ループ）。
    //   再試行でページを開き直すのは「ログインフォームが見えている」か「入力欄の無いページ」のときだけ
    //   （人が操作中かもしれない追加認証ページ等を壊さない。ただし上限あり＝無限には待たない）
    loginWaiting = true;
    sessionVerified = false; // ここから先のブラウザの Cookie は未認証（or 別アカウント）なので退避しない
    // アラートの間隔: 通常は15分ごと。別アカウント検出時は（前回から1分以上空いていれば）即時に知らせる。
    // ループの外で持つ＝「別アカウント→ログアウト」を繰り返しても通知が連発しない。
    // 自動ログインが出す ⚠️ も「アラート済み」として同じ間隔に乗せる（1件の失効で ⚠️ が2通続かない）
    const REALERT_MS = 15 * 60_000;
    const MIN_GAP_MS = 60_000;
    // 1回目のアラートは少しだけ待つ: 開き直し直後や Lpro の毎時処理中はトーク画面が遅れて出ることがあり、
    // /manage/ を開き直せば数秒でログイン済みと分かる。その場合は「未ログイン」を運用に飛ばさない
    // （別アカウント検出は下で即時に倒す）
    const FIRST_ALERT_GRACE_MS = 20_000;
    let lastAlertAt = 0;
    // 別アカウント検出は自動ログアウトの成否に依らず即時（誤送信の芽なので猶予を置かない）
    let nextAlertAt = wrongSite ? 0 : Date.now() + FIRST_ALERT_GRACE_MS;
    let logoutFailed = initialLogoutFailed;
    let attempts = 0; // この待機中に自動ログインを試みた回数（2回目以降は人の入力中フォームに触らない）
    const markAlerted = (): void => {
      lastAlertAt = Date.now();
      nextAlertAt = lastAlertAt + REALERT_MS;
      alerted = true;
    };
    const maybeAlert = (): void => {
      if (Date.now() < nextAlertAt) return;
      notifyLogin(
        wrongSite ? 'wrong-site' : 'waiting',
        wrongSite
          ? (logoutFailed ? `${wrongSite}。自動ログアウトに失敗したため手動ログアウトが必要です` : wrongSite)
          : `自動ログイン: ${describeAutoLogin()}`
      );
      markAlerted();
    };
    // 複数案件を同じPCで動かすとログイン待ちウィンドウが複数並ぶため、どの案件のウィンドウかを
    // ページ上のバナーとタイトル（タスクバー表示）で示す。ログイン画面の DOM に載せるだけで、
    // フォームには触れない（pointer-events:none＝入力欄を覆っても操作を邪魔しない）。失敗しても待機動作には影響しない。
    // 送信でページが変わると消えるので、何度呼んでも1枚だけになるよう id で更新する
    const showBanner = (): Promise<void> => p.evaluate((a) => {
      if (!document.title.startsWith('【')) document.title = `【${a.label}】ログインしてください - ${document.title}`;
      const text = (a.wrong
        ? (a.logoutFailed
          ? `【${a.label}】Lproブリッジ: 別のアカウント（${a.wrong}）でログインされています。自動ログアウトできなかったので、手動でログアウトしてこの案件のアカウントでログインし直してください`
          : `【${a.label}】Lproブリッジ: 別のアカウント（${a.wrong}）でログインされていたためログアウトしました。この案件のアカウントでログインし直してください`)
        : `【${a.label}】Lproブリッジ: このウィンドウで Lpro にログインしてください（ログイン後は自動で監視を再開します）`) +
        `｜自動ログイン: ${a.auto}`;
      let d = document.getElementById('lpro-bridge-login-banner');
      if (!d) {
        d = document.createElement('div');
        d.id = 'lpro-bridge-login-banner';
        d.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:2147483647;background:#c43c3c;color:#fff;font:bold 15px sans-serif;padding:10px 16px;text-align:center;pointer-events:none;';
        document.body?.prepend(d);
      }
      d.textContent = text;
    }, { label: cfg.instanceLabel || 'Lproブリッジ', wrong: wrongSite, logoutFailed, auto: describeAutoLogin() }).catch(() => {});
    try {
      for (;;) {
        viaAuto = false;
        let humanPageExtends = 0;
        let lastProbeAt = Date.now();
        if (wrongSite) {
          console.log(
            logoutFailed
              ? `別のアカウントでログインされています（${wrongSite}）が自動ログアウトできませんでした。ブラウザで手動ログアウトし、この案件のアカウントでログインしてください…`
              : `別のアカウントでログインされていました（${wrongSite}）。ログアウトしました。この案件のアカウントでログインしてください…`
          );
          // 自動ログアウトが効いた場合は人が再ログインするたびに（1分以上空けて）即知らせる。
          // 効かずに自走している間は15分間隔のまま（通知の連発防止）
          if (!logoutFailed) nextAlertAt = Math.min(nextAlertAt, lastAlertAt + MIN_GAP_MS);
          // 別アカウントの通知は、自動ログインで入り直す前に出す（「ログアウトした」事実は伝える。復旧は続報で知らせる）
          maybeAlert();
        } else {
          logEvery('login-wait', 60_000, `未ログインの可能性。自動ログイン: ${describeAutoLogin()}。表示中のブラウザで手動ログイン（2FA含む）もできます。ログインを確認するまで待機します…`);
        }
        // ログインフォームが既に見えているならそのまま使う（開き直すと人が入力中の内容が消える）。見えていなければ開く
        if (!logoutFailed && !(await loginFormVisible(p, SELECTORS.loginPassInput))) {
          await p.goto(cfg.loginUrl, { waitUntil: 'domcontentloaded' }).catch(() => {});
        }
        await showBanner();
        let seen = false;
        // ── 自動ログイン（ログインフォームが出ていれば、資格情報 or 自動入力済みの内容で1回送信）──
        if (autoLoginEnabled() && !logoutFailed && Date.now() >= autoLoginNextAt) {
          const r = await tryAutoLoginOnce(p, attempts > 0);
          attempts++;
          if (r.notified) markAlerted();
          if (r.loggedIn) {
            seen = true;
            viaAuto = r.submitted; // 送信せずにマーカーが見えた＝人が入れた or 一過性の空振り
          } else {
            await showBanner(); // 送信でページが変わりバナーが消えているので出し直す
          }
        }
        while (!seen) {
          maybeAlert();
          seen = await p.locator(SELECTORS.loggedInMarker).first().isVisible().catch(() => false);
          // 表示中の画面に nav が無くても（人が nav の無いページで作業中・着地ページ）、別タブなら分かる。1分に1回
          if (!seen && Date.now() - lastProbeAt >= AUTO_LOGIN_PROBE_EVERY_MS) {
            lastProbeAt = Date.now();
            if (await probeLoggedIn(p)) {
              seen = true;
              await p.goto(cfg.loginUrl, { waitUntil: 'domcontentloaded' }).catch(() => {});
            }
          }
          if (seen) {
            // 自分の送信（失敗と確定していないもの）から間もなくマーカーが出た＝遅れて成立した自動ログイン
            if (autoLoginSubmittedAt && !autoLoginSubmitFailed && Date.now() - autoLoginSubmittedAt < AUTO_LOGIN_LATE_SUCCESS_MS) {
              viaAuto = true;
              console.log('自動ログイン: 遅れてログイン済みを確認しました');
            }
            break;
          }
          if (autoLoginEnabled() && !logoutFailed && Date.now() >= autoLoginNextAt) {
            // 再試行（外側ループで開き直し）は、ログインフォームが見えているか、誰も操作しようのないページ（入力欄なし）のときだけ。
            // 人が操作中かもしれない対話ページ（追加認証など）は壊さず少し待って見直す。ただし上限を超えたら開き直す（無限に待たない）
            if ((await loginFormVisible(p, SELECTORS.loginPassInput)) || !(await pageHasVisibleInputs(p)) ||
                humanPageExtends >= AUTO_LOGIN_HUMAN_PAGE_MAX_EXTENDS) break;
            humanPageExtends++;
            autoLoginNextAt = Date.now() + AUTO_LOGIN_HUMAN_PAGE_EXTEND_MS;
          }
          await p.waitForTimeout(2000);
        }
        if (!seen) {
          // 自動ログインの再試行へ。別アカウントの件は通知済みなので、以後は通常の未ログインとして扱う（🚫 を繰り返さない）
          wrongSite = null;
          continue;
        }
        // 実際に受信箱へ到達できてから「復旧・監視再開」を通知する（gotoInbox が失敗したら
        // 誤って再開を告げず、throw は呼び出し側（main().catch / 巡回の復旧経路）に委ねる）
        await gotoInbox(inbox, 30_000);
        wrongSite = await siteMismatch(inbox);
        if (!wrongSite) {
          // 人が正しいアカウントで入り直した → ブラウザの自動入力由来の停止は解除する（保存済みパスワードが直った可能性）
          if (!viaAuto && autoLoginBlocked && autoLoginBlockedSource === 'prefilled') {
            console.log('自動ログイン: 正しいアカウントでの手動ログインを確認したため、停止を解除します');
            autoLoginBlocked = null;
            autoLoginBlockedSource = null;
          }
          break;
        }
        if (viaAuto && !autoLoginBlocked) {
          // 自動ログインで入ったアカウントが別サイト＝資格情報がこの案件のものではない。
          // 「ログアウト→自動ログイン→別アカウント→ログアウト…」の無限ループを断ち、人が直すまで自動ログインを止める
          const src = autoLoginLastFilledFrom === 'prefilled' ? 'ブラウザの自動入力' : '.env の資格情報';
          autoLoginBlocked = `自動ログイン（${src}）で入ったアカウントがこの案件と一致しません（${wrongSite}）`;
          autoLoginBlockedSource = autoLoginLastFilledFrom ?? 'env';
          console.error(`自動ログインを停止します: ${autoLoginBlocked}`);
          notifyLogin('auto-login-blocked', autoLoginBlocked);
          markAlerted();
          await logoutLpro(p);
          // headless では人が入り直せないので、起動時と同じ明確なエラーで止める（PM2 ログに理由が残る）
          if (cfg.headless) throw headlessError('');
          // 🚫 で伝えたので、以後は通常の未ログイン（自動ログイン停止中）として待つ（別アカウントの通知を繰り返さない）
          wrongSite = null;
          logoutFailed = false;
          continue;
        }
        // また別アカウント → ログアウトしてやり直し。ログアウトが効かなければ人の手動ログアウトを待つ
        // （画面を奪い続けないよう 30 秒あけてから再確認）
        logoutFailed = !(await logoutLpro(p));
        if (logoutFailed) await p.waitForTimeout(30_000);
      }
    } finally {
      loginWaiting = false;
    }
    // 「未ログイン」を知らせた場合だけ「復旧」を知らせる（猶予内に自己回復した一過性の空振りでは何も飛ばさない）。
    // 自動ログインで復旧したときは、⚠️ を出していなくても 🔑 で1通だけ知らせる（セッション失効があった事実を残す）
    if (alerted) notifyLogin('recovered', viaAuto ? '自動ログインで復旧しました' : undefined);
    else if (viaAuto) notifyLogin('auto-login', autoLoginLastFilledFrom === 'prefilled' ? '入力済みのフォームを送信' : '.env の ID/パスキーで送信');
  }
  console.log(`Lpro ログイン確認OK（${inbox.name}）`);
  // ログイン確認が取れた＝資格情報は有効（or 人が入った）。自動ログインの失敗カウントとバックオフを戻す
  autoLoginFailures = 0;
  autoLoginOtherPages = 0;
  autoLoginNextAt = 0;
  autoLoginLastResult = '';
  autoLoginSubmittedAt = 0;
  autoLoginSubmitFailed = false;
  // ログイン済みの Cookie を退避（プロセス再起動をまたいでログインを引き継ぐ）。内容が同じなら書かない
  sessionVerified = true;
  void persistSessionCookies(p.context(), 'ログイン確認OK');
}

/** 行スキャン結果（frame.evaluate で一括抽出）。各顧客の会話履歴（scans）も同時に取る */
type RowScan = { key: string; name: string; status: string; scans: MsgScan[] };

const lastLoggedCounts = new Map<string, string>();
// 受信箱ごとの「現在サイクルで表示上限に達しているか」。解消すれば false に戻る
const overLimitByInbox = new Map<string, boolean>();
// 受信箱ごとの「直近の applySearch で表示数500件の指定が効いたか」。効いていなければ
// サーバー既定の100件が実効上限なので、打ち切り判定をそちらに合わせる（無音の見落とし防止）
const limitOkByInbox = new Map<string, boolean>();

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
    // 表示数を広げる（未返信100超の取りこぼし防止）。失敗は無視するが「500件が効いたか」は記録する:
    // セレクタ切れで既定100件に落ちると rows.length が500に届かず打ち切り検知（overLimit）が
    // 無音で無効化されるため、失敗時は実効上限=100件として判定する（マーカー同期の誤✅防止の生命線）
    const limitOk = await menu.locator(SELECTORS.limitLarge).first().check({ timeout: 4_000 })
      .then(() => true)
      .catch(() => false);
    limitOkByInbox.set(inbox.id, limitOk);
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
    // 応答到達（=新文書コミット）まで待つ。★応答を確認できないまま進むと旧文書（例: 直前の返信で
    // 会員ID 1件に絞られた一覧）を「正常な検索結果」として読んでしまい、巡回の見落としや
    // マーカー同期の誤✅（一覧に不在=対応済みの誤判定）につながるため、確認できなければ中断する
    // （attempt は呼び出し側で再ナビゲート付きの再試行が1回かかる）
    if ((await respP) === null) {
      throw new Error(`${inbox.name}: 検索POSTの応答を確認できません（旧い一覧を読む恐れがあるため中断）`);
    }

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
 * chatframe の全顧客行の会話履歴を描画させてから読むための前処理（2026-08-06 実機で判明した罠）。
 * Lpro の一覧は「画面に入った行／直近に動きのあった行」しか会話履歴を描画せず、画面外の行は
 * メッセージ要素が空のまま＝そのまま抽出すると「メッセージ0件」に見える。8/6 の8日ぶり再起動では
 * 未読22件中、一覧上位の2行しか読めなかった（残りは新着や返信で行が浮上した瞬間に初めて読めた）。
 * 未描画の行だけを scrollIntoView で順に画面へ入れ、未描画数が減らなくなるまで（時間上限つき）待つ。
 * 全行描画済みなら即 return＝定常時の追加コストはゼロ。
 */
async function renderAllRows(inbox: Inbox, f: Frame): Promise<void> {
  const S = {
    conversationItem: SELECTORS.conversationItem,
    memberIdText: SELECTORS.memberIdText,
    messageGroup: SELECTORS.messageGroup,
  };
  // 会員IDを持つのに会話履歴が1件も無い行のインデックス一覧（一括返信行は対象外）
  const listEmpty = (): Promise<number[]> =>
    f.evaluate((S) => {
      const idx: number[] = [];
      Array.from(document.querySelectorAll(S.conversationItem)).forEach((row, i) => {
        if (!(row.querySelector(S.memberIdText)?.textContent ?? '').trim()) return;
        if (row.querySelectorAll(S.messageGroup).length === 0) idx.push(i);
      });
      return idx;
    }, S);

  let empty = await listEmpty();
  if (empty.length === 0) return;
  const deadline = Date.now() + 20_000;
  let prev = Infinity;
  while (empty.length > 0 && empty.length < prev && Date.now() < deadline) {
    prev = empty.length;
    for (const i of empty) {
      if (Date.now() > deadline) break;
      await f.evaluate(
        (a) => { Array.from(document.querySelectorAll(a.sel))[a.i]?.scrollIntoView({ block: 'center' }); },
        { sel: S.conversationItem, i }
      );
      await f.waitForTimeout(300); // 1行ずつ viewport を通し、遅延ロードの発火を待つ
    }
    await f.waitForTimeout(700); // 発火済みのロードが着弾するのを待ってから数え直す
    empty = await listEmpty();
  }
  if (empty.length > 0) {
    warnOnce(
      `unrendered-${inbox.id}`,
      `${inbox.name}: スクロールしても会話履歴が描画されない行が ${empty.length} 件あります（該当行は取り込みを見送り、描画され次第取り込みます）`
    );
  }
  // 先頭へ戻す（以降の行スコープ操作を実機確認しやすくする。失敗しても実害なし）
  await f.evaluate(() => { (document.scrollingElement ?? document.documentElement).scrollTop = 0; }).catch(() => {});
}

/**
 * 指定受信箱の顧客行一覧を、各顧客の会話履歴（inbound）まで含めて1回の evaluate で取得する。
 * ★1パス抽出★ 顧客ごとに画面を開き直さないので、返信(openMember)が割り込んで表示が
 * 対象1名に絞られても、この巡回で取った各顧客のデータは揺らがない（共有画面の競合を根絶）。
 * 毎回「未返信のみ（会員ID絞り込み無し）」を明示送信して読む。一括返信行（会員ID無し）は除外。
 */
export async function pollConversations(inbox: Inbox): Promise<Conversation[]> {
  const f = await applySearch(inbox, { memberId: '', unreadOnly: cfg.onlyUnread });
  // 画面外の行の会話履歴を描画させてから抽出する（未描画行を「0件」と誤認しないため）
  await renderAllRows(inbox, f);
  const scan: { total: number; rows: RowScan[] } = await f.evaluate(
    (S) => {
      const all = document.querySelectorAll(S.conversationItem);
      const out: Array<{ key: string; name: string; status: string;
        scans: Array<{ inbound: boolean; text: string; dt: string; hasImage: boolean }> }> = [];
      for (const row of all) {
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
      return { total: all.length, rows: out };
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
  const rows = scan.rows;
  // ★偽の「未返信ゼロ」を配信・マーカー同期に流さないためのガード（2026-08-15 レビュー反映）:
  //  - 行が1つも無い: chatframe には一括返信行(rowid=0)が常在するので、total=0 は「未返信ゼロ」では
  //    なく文書が描画されていない（またはセレクタ切れ）。正常リターンすると全トピックが誤✅化する
  //  - 行はあるのに会員IDが1件も読めない: memberIdText セレクタ切れの疑い（一括返信行しか無い
  //    total=1 は正当な空一覧なので除外）
  if (scan.total === 0) {
    throw new Error(`${inbox.name}: 一覧に行が1件もありません（一括返信行も無い＝文書未描画/セレクタ切れの疑い）`);
  }
  if (scan.total > 1 && rows.length === 0) {
    throw new Error(`${inbox.name}: 顧客行が ${scan.total - 1} 行あるのに会員IDを1件も読めません（member_id セレクタ切れの疑い）`);
  }
  // 表示上限に達したか（現在サイクルの状態）。解消したら false に戻し、再超過で再警告できるようにする。
  // 500件指定が効かなかったサイクルはサーバー既定の100件を実効上限として判定する
  const effLimit = limitOkByInbox.get(inbox.id) === false ? DISPLAY_LIMIT_FALLBACK : DISPLAY_LIMIT;
  overLimitByInbox.set(inbox.id, rows.length >= effLimit);
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
      inbound: toConvMessages(inbox.id, r.key, r.scans),
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

/** 指定受信箱が現在サイクルで表示上限に達しているか。打ち切り中は「一覧に不在＝返信済み」の
 * 推定が信用できない（表示圏外の未返信があり得る）ため、ステータスマーカー同期が✅側を保留する判定に使う */
export function pollHitLimitFor(inboxId: string): boolean {
  return overLimitByInbox.get(inboxId) ?? false;
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
  // 検索POSTの応答が返っても行の描画は一拍遅れる。即時 count() は描画レースで
  // 実在する会員でも恒常的に空振りする（12日間で181件の誤失敗）ため、出現を待って判定する
  try {
    await row.first().waitFor({ state: 'attached', timeout: 5000 });
    return f;
  } catch {
    throw new Error(
      `${inbox.name}: 会員ID=${memberId} を検索しても行が出ません（この受信箱に居ない/存在しない会員IDの可能性）`
    );
  }
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
  return toConvMessages(inbox.id, conv.memberId, scans);
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
    // 送信中に飛んだ POST を控える（送信確認NG時のデバッグに残す。会話本文は URL に載らない）
    const sentPosts: string[] = [];
    const onResp = (r: import('playwright').Response) => {
      if (r.request().method() === 'POST') sentPosts.push(`${r.status()} ${r.url()}`);
    };
    p.on('response', onResp);
    // ★主シグナル: 送信ボタンは（chatframe への form POST ではなく）AJAX で /manage/json/<名前>_send へ
    // POST する。この応答が 200 で返れば Lpro が返信を受理した＝送信成功。吹き出しの表示タイミングに
    // 依存せず確実（吹き出しでの確認は表示が遅れると偽陰性→二重送信を招くため主シグナルにしない）。
    const respP = p
      .waitForResponse(
        (r) => SEND_ACCEPT_RE.test(r.url()) && r.request().method() === 'POST',
        { timeout: 15_000 }
      )
      .catch(() => null);
    await row.locator(SELECTORS.sendButton).first().click();
    const resp = await respP;
    p.off('response', onResp);

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
    // 受理エンドポイントが変わった等の切り分けのため、送信中に飛んだ POST を残す（会話本文は含まない）
    console.warn(`[${inbox.name}] 送信確認NG（${lastReason}）。捕捉したPOST: ${sentPosts.join(' , ') || '(none)'}`);
    throw new Error(
      `${inbox.name}: 送信を確認できませんでした（${lastReason}）。` +
      '⚠️ 実際には送信されている可能性もあります。再送する前に必ず Lpro の画面で確認してください'
    );
  } finally {
    p.off('dialog', onDialog);
  }
}
