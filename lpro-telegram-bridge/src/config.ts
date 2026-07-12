import 'dotenv/config';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

// DB・プロファイルの既定パスは CWD ではなくパッケージルート基準にする
// （別ディレクトリから起動すると .gitignore の保護外に顧客データが生成されるため）
const pkgRoot = fileURLToPath(new URL('..', import.meta.url));

export const cfg = {
  telegramToken: required('TELEGRAM_BOT_TOKEN'),
  loginUrl: required('LPRO_LOGIN_URL'),
  pollIntervalMs: Math.max(1000, num('POLL_INTERVAL_MS', 8000)),
  onlyUnread: (process.env.ONLY_UNREAD ?? 'true') === 'true',
  headless: (process.env.HEADLESS ?? 'false') === 'true',
  userDataDir: process.env.USER_DATA_DIR ?? join(pkgRoot, '.lpro-profile'),
  // Lpro の /manage は HTTP ベーシック認証（realm "InfoSys Manager"）で保護されている。
  // これは Cookie と違いプロファイルに永続しないため、環境変数から毎回渡す必要がある
  // （設定すると Playwright が認証チャレンジに自動応答する）。Lpro アプリのログインとは別物。
  basicUser: process.env.LPRO_BASIC_USER ?? '',
  basicPass: process.env.LPRO_BASIC_PASS ?? '',
  // 停止中・稼働中に初めて現れた顧客（=いま送ってきた新規顧客）の初回配信件数。
  // 0にすると初回は何も配らない＝初回メッセージを取りこぼすので注意。
  bootstrapTail: num('BOOTSTRAP_TAIL', 5),
};

/**
 * Lpro には独立した2つの受信箱がある（2026-07-12 動画で判明）:
 *   - チャット応対（chat_message）: 自動応答が効かず全部手動対応 → 必ず監視
 *   - ダイレクトトーク応対（linechat_message）: 基本は自動応答だが、キーワードに
 *     変な絵文字が付くと不発 → 取りこぼし防止のため監視
 * それぞれ別の Telegram グループへ配信する（受信箱の取り違え＝誤配信を構造的に防ぐ）。
 * 構造（iframe経路・行・吹き出し・返信）は両者ほぼ同一なので SELECTORS は共用。
 * chatframe の URL だけが違うため chatframeRe で受信箱を判別する。
 */
export type Inbox = {
  id: 'chat' | 'talk';
  name: string;
  talkUrl: string;      // シェルの main iframe に読み込む URL
  groupChatId: number;  // この受信箱を流す Telegram グループ
  chatframeRe: RegExp;  // 顧客行 iframe（name=chatframe）を受信箱ごとに判別する
  menuRe: RegExp;       // 検索フォーム iframe（*_message_menu）を受信箱ごとに判別する
};

// 各受信箱は「URL と グループID の両方が設定されている」ときだけ有効
const ALL_INBOXES: Inbox[] = [
  {
    id: 'chat',
    name: 'チャット応対',
    talkUrl: process.env.CHAT_TALK_URL ?? '',
    groupChatId: num('CHAT_GROUP_CHAT_ID', 0),
    // 顧客行 iframe の判別。実DOM(dump)では chat の chatframe URL はクエリが剥がれて
    // `.../chat_message`（?無し）に落ち着くため ?有無どちらも許容する。ただし main ラッパー
    // `chat_message?method=frame` と menu `chat_message_menu?` は除外する（前が "/" なので
    // linechat_message にも一致しない）。
    chatframeRe: /\/chat_message(?:\?(?!.*method=frame)|$)/,
    menuRe: /\/chat_message_menu\b/,
  },
  {
    id: 'talk',
    name: 'ダイレクトトーク応対',
    talkUrl: process.env.TALK_TALK_URL ?? '',
    groupChatId: num('TALK_GROUP_CHAT_ID', 0),
    // talk は chatframe が `linechat_message?site_id...`（?有り）、main ラッパーは
    // `linechat_message_frame`（?無し・後ろが _frame）なので method=frame 除外と併せて衝突しない。
    chatframeRe: /\/linechat_message(?:\?(?!.*method=frame)|$)/,
    menuRe: /\/linechat_message_menu\b/,
  },
];

export const inboxes: Inbox[] = ALL_INBOXES.filter((i) => i.talkUrl && i.groupChatId);

export function inboxById(id: string): Inbox | undefined {
  return inboxes.find((i) => i.id === id);
}
export function inboxByGroup(groupChatId: number): Inbox | undefined {
  return inboxes.find((i) => i.groupChatId === groupChatId);
}

/** launchPersistentContext に渡す httpCredentials（ベーシック認証が未設定なら undefined） */
export function httpCredentials(): { username: string; password: string } | undefined {
  return cfg.basicUser ? { username: cfg.basicUser, password: cfg.basicPass } : undefined;
}

function required(k: string): string {
  const v = process.env[k];
  if (!v) throw new Error(`環境変数 ${k} が未設定です（.env を確認）`);
  return v;
}

// タイプミス（NaN）を黙って通すと「初回メッセージの無音喪失」や「ウェイトなし巡回」になるため既定値へ倒す
// （doctor/preflight でも同じ値を問題として検出する）
function num(k: string, def: number): number {
  const raw = process.env[k];
  if (raw === undefined || raw.trim() === '') return def;
  const v = Number(raw);
  if (!Number.isFinite(v)) {
    console.warn(`環境変数 ${k} が数値ではありません: "${raw}" → 既定値 ${def} を使用します`);
    return def;
  }
  return v;
}

/**
 * ★★★ Lpro 依存はこの SELECTORS だけ ★★★
 * 2026-07-11 実機 DOM（npm run dump → dump/frame-*.html）で確定。
 * Lpro の UI が変わったら基本ここを直すだけで復旧できる（RUNBOOK A 参照）。
 *
 * 画面構造（重要）:
 *   トーク応対は「一覧クリックで開く」型ではなく、1ページに顧客ブロック（行）が
 *   縦に並ぶインライン型。行 = プロフィール + 会話履歴（直近数件のみ表示）+ 返信欄。
 *   実体は iframe の入れ子: /manage/（シェル）→ iframe[name="main"]（chat_message?method=frame）
 *   → iframe[name="chatframe"]（chat_message = 顧客行のテーブル）。
 *
 * ⚠️ chatframe の先頭には「一括返信」フォーム（#form0 / #message0 / input#btn_send、
 *    tr.rowitem[data-rowid="0"]）がある。誤って触ると全顧客一斉送信になるため、
 *    すべての操作は「会員IDで特定した行」のスコープ内でのみ行うこと（lpro-adapter が保証）。
 *
 * ※ すべて純CSS（frame.evaluate 内の querySelectorAll / matches で使うため、
 *    Playwright 拡張構文 :has-text() 等は使用不可）。
 */
export const SELECTORS = {
  // ── フレーム経路 ──
  // 右コンテンツの iframe（/manage/ シェル配下）。talkUrl を直接開いた場合は不要になる
  mainFrame: 'iframe[name="main"]',
  // 顧客行テーブルの iframe（chat_message）
  chatFrame: 'iframe[name="chatframe"]',
  // /manage/ シェルでのログイン済み判定（ログアウトメニューはログイン後にだけ出る）
  loggedInMarker: 'nav.opemenu a[href="logout"]',

  // ── 顧客行（chatframe 内）──
  // 顧客1件分の行。一括返信行（data-rowid="0"）も同じ class を持つため、
  // 会員ID要素（memberIdText）を持つ行だけを顧客として扱う
  conversationItem: 'tr.rowitem[data-rowid]',
  // 行内: 会員ID（顧客キー。アカバンでも不変とヒアリング済み）
  memberIdText: 'span[id^="member_id"]',
  // 行内: LINE ユーザー名（表示用。キーには使わない）
  customerName: 'mark.lineusername',
  // 行内: 返信状態セル（縦書きで「未返信」/「返信済み」）
  statusCell: 'td.henshin',
  // statusCell がこの文字列を含めば未読（未返信）扱い
  unreadText: '未返信',

  // ── メッセージ（行内の会話履歴。直近数件のみ表示される点に注意）──
  // 1メッセージ分のグループ。左=顧客(inbound) / 右=自分(outbound)
  messageGroup: '.chat_inner > .mb_M',
  // グループがこの class を持てば顧客の発言
  inboundGroupClass: 'left',
  // グループ内: 吹き出し本体（mmsg_member / mmsg_char / mmsg_char2 の総称）
  bubble: '[class*="mmsg_"]',
  // グループ内: 日時表示（例: 07/04<br>22:04。フィンガープリントの材料）
  msgDatetime: '.mmsgdt',

  // ── 返信（必ず行スコープで使う）──
  replyInput: 'textarea[name="message"]',
  sendButton: 'input.btn_send',

  // ── 検索フォーム（menu iframe 内。任意の会員を返信済み含めて開くため）──
  // 会員ID絞り込み（カンマ区切り可）。1件だけ入れればその会員だけ表示される
  memberIdFilter: 'textarea[name="member_id"]',
  // 「すべて」＝ jokyo=0（未返信/返信済みを問わず表示）。返信済みの相手や掘り起こしでも開ける
  searchAllButton: 'button.find.jokyo0',
  // 「未返信のみ」＝ jokyo=1。巡回で毎回これを送信し、直前の検索状態に依存しない確定的な一覧にする
  searchUnreadButton: 'button.find.jokyo1',
  // 表示数=500件（value=4）。既定100件だと未返信が100超のとき古い顧客を静かに取りこぼすため広げる
  limitLarge: 'input[name="limit"][value="4"]',
};

// 表示上限（limitLarge=500件）。巡回でこの件数に達したら「打ち切りの可能性」を警告する
export const DISPLAY_LIMIT = 500;
