import 'dotenv/config';

export const cfg = {
  telegramToken: required('TELEGRAM_BOT_TOKEN'),
  groupChatId: process.env.GROUP_CHAT_ID ? Number(process.env.GROUP_CHAT_ID) : 0,
  loginUrl: required('LPRO_LOGIN_URL'),
  talkUrl: required('LPRO_TALK_URL'),
  pollIntervalMs: Number(process.env.POLL_INTERVAL_MS ?? 8000),
  onlyUnread: (process.env.ONLY_UNREAD ?? 'true') === 'true',
  headless: (process.env.HEADLESS ?? 'false') === 'true',
  userDataDir: process.env.USER_DATA_DIR ?? './.lpro-profile',
};

function required(k: string): string {
  const v = process.env[k];
  if (!v) throw new Error(`環境変数 ${k} が未設定です（.env を確認）`);
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
