import 'dotenv/config';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

// DB・プロファイルの既定パスは CWD ではなくパッケージルート基準にする
// （別ディレクトリから起動すると .gitignore の保護外に顧客データが生成されるため）
const pkgRoot = fileURLToPath(new URL('..', import.meta.url));

export const cfg = {
  telegramToken: required('TELEGRAM_BOT_TOKEN'),
  groupChatId: process.env.GROUP_CHAT_ID ? Number(process.env.GROUP_CHAT_ID) : 0,
  loginUrl: required('LPRO_LOGIN_URL'),
  talkUrl: required('LPRO_TALK_URL'),
  pollIntervalMs: Math.max(1000, num('POLL_INTERVAL_MS', 8000)),
  onlyUnread: (process.env.ONLY_UNREAD ?? 'true') === 'true',
  headless: (process.env.HEADLESS ?? 'false') === 'true',
  userDataDir: process.env.USER_DATA_DIR ?? join(pkgRoot, '.lpro-profile'),
  // 稼働中に初めて現れた顧客（=いま送ってきた新規顧客）の初回配信件数。
  // 0にすると初回は何も配らない＝初回メッセージを取りこぼすので注意。
  bootstrapTail: num('BOOTSTRAP_TAIL', 5),
};

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
 * トーク応対画面で F12 → 要素を調べて各セレクタを埋める。
 * UIが変わったら基本ここを直すだけで復旧できる。
 */
export const SELECTORS = {
  // ログイン済み判定：トーク応対画面にだけ存在する要素
  loggedInMarker: 'TODO',       // 例: '[data-testid="talk-room-list"]'
  // 会話一覧：顧客1件分の行（複数マッチ想定）
  conversationItem: 'TODO',     // 例: '.talk-list .talk-list-item'
  // 会話行内：顧客名だけを含む要素（★重要★ 行全文はプレビューや未読数を含み
  // キーが揺れて顧客1人に複数トピックができるため、名前要素を必ず特定する）
  customerName: 'TODO',         // 例: '.talk-list-item__name'
  // 会話行の一意ID「属性名」（セレクタではなく属性名）。あれば最優先でキーに使う
  customerKeyAttr: 'TODO',      // 例: 'data-user-id'
  // 会話行内：未読バッジ（存在すれば未読）
  unreadBadge: 'TODO',          // 例: '.unread-badge'
  // メッセージ吹き出し（会話を開いた後／複数マッチ）
  messageBubble: 'TODO',        // 例: '.message-item'
  // 相手(顧客)発言の吹き出しを示す目印（クラス等）
  inboundBubbleMarker: 'TODO',  // 例: '.message-item--inbound'
  // 吹き出し内の本文
  bubbleText: 'TODO',           // 例: '.message-body'
  // 返信入力欄
  replyInput: 'TODO',           // 例: 'textarea.reply-input'
  // 送信ボタン
  sendButton: 'TODO',           // 例: 'button.reply-send'
};
