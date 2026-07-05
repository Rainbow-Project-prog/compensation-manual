import { Bot, GrammyError, HttpError } from 'grammy';
import { cfg } from './config.js';
import { dbApi } from './db.js';

export const bot = new Bot(cfg.telegramToken);

// ハンドラ内の例外でポーリングが止まらないようにする（既定は停止＋rethrow）
bot.catch((err) => {
  console.error('Telegram ハンドラでエラー（処理は継続します）:', err.error ?? err);
});

type ReplyHandler = (customerKey: string, name: string, text: string) => void;
let onReply: ReplyHandler = () => {};
export function setReplyHandler(h: ReplyHandler) { onReply = h; }

const MAX_WAIT_MS = 60_000;

/**
 * 一時的なエラー（429/5xx/ネットワーク）だけ指数バックオフで再試行。
 * createForumTopic のような「成功したのに応答が届かなかった」可能性のある非冪等APIは
 * retryOnHttpError=false でネットワーク断の再試行を止める（重複作成防止）。
 */
async function withRetry<T>(
  label: string,
  fn: () => Promise<T>,
  opts: { tries?: number; retryOnHttpError?: boolean } = {}
): Promise<T> {
  const tries = opts.tries ?? 3;
  const retryOnHttpError = opts.retryOnHttpError ?? true;
  let lastErr: unknown;
  for (let i = 0; i < tries; i++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      const transient =
        (e instanceof HttpError && retryOnHttpError) ||
        (e instanceof GrammyError && (e.error_code === 429 || e.error_code >= 500));
      if (!transient || i === tries - 1) throw e;
      const retryAfter = e instanceof GrammyError ? e.parameters?.retry_after : undefined;
      const waitMs = Math.min(retryAfter ? retryAfter * 1000 : 1000 * 2 ** i, MAX_WAIT_MS);
      console.warn(`Telegram ${label} 一時エラー、${waitMs}ms後に再試行 (${i + 1}/${tries}): ${String(e).slice(0, 120)}`);
      await new Promise((r) => setTimeout(r, waitMs));
    }
  }
  throw lastErr;
}

/** 顧客ごとのトピックを確保（無ければ作成）。配信直前にだけ呼ぶ（空トピックの量産防止） */
export async function ensureTopic(customerKey: string, name: string): Promise<number> {
  const existing = dbApi.get(customerKey);
  if (existing?.topic_thread_id) return existing.topic_thread_id;
  let topic;
  try {
    topic = await withRetry(
      'createForumTopic',
      () => bot.api.createForumTopic(cfg.groupChatId, name || customerKey),
      { retryOnHttpError: false } // 非冪等: ネットワーク断での再試行は重複トピックを生む
    );
  } catch (e) {
    if (e instanceof GrammyError && e.error_code === 400) {
      throw new Error(
        'トピック作成に失敗。次を確認してください: ' +
        '(1) グループの Topics が ON か (2) bot が管理者で「トピックの管理(Manage Topics)」権限を持つか ' +
        `(3) GROUP_CHAT_ID が正しいか。詳細: ${e.description}`
      );
    }
    throw e;
  }
  dbApi.setTopic(customerKey, topic.message_thread_id);
  return topic.message_thread_id;
}

/** 顧客の発言を該当トピックへ（4096字制限があるため分割送信） */
export async function pushInbound(threadId: number, text: string): Promise<void> {
  const CHUNK = 4000;
  for (let i = 0; i < Math.max(text.length, 1); i += CHUNK) {
    const part = text.slice(i, i + CHUNK);
    await withRetry('sendMessage', () =>
      bot.api.sendMessage(cfg.groupChatId, part, { message_thread_id: threadId }));
  }
}

/** 閉じられたトピックを開き直す（顧客の新着は流し続ける必要があるため） */
export async function reopenTopic(threadId: number): Promise<void> {
  await withRetry('reopenForumTopic', () =>
    bot.api.reopenForumTopic(cfg.groupChatId, threadId));
}

/** このエラーは「トピックが削除済み」か（紐付けを外して作り直すべきか） */
export function isThreadNotFoundError(e: unknown): boolean {
  return e instanceof GrammyError && e.error_code === 400 && /thread not found/i.test(e.description);
}

/** このエラーは「トピックが閉じられている」か（reopen すべきか） */
export function isTopicClosedError(e: unknown): boolean {
  return e instanceof GrammyError && e.error_code === 400 && /TOPIC_CLOSED/i.test(e.description);
}

/** Telegram 起因のエラーか（Playwright 側の再ログイン処理を誤発動させない判定用） */
export function isTelegramError(e: unknown): boolean {
  return e instanceof GrammyError || e instanceof HttpError;
}

/** 人が打った返信を拾う（トピック内のテキストのみ） */
bot.on('message:text', async (ctx) => {
  const msg = ctx.message;
  if (ctx.chat.id !== cfg.groupChatId) return;
  const threadId = msg.message_thread_id;
  if (!threadId || !msg.is_topic_message) return; // General等は無視
  const cust = dbApi.byThread(threadId);
  if (!cust) {
    // 黙って捨てると「送ったつもり」事故になるため必ずフィードバックする
    await ctx.reply(
      '⚠️ このトピックはどの顧客にも紐付いていないため、Lpro へは送信されません。' +
      '（ブリッジが作成したトピックでのみ返信できます）',
      { message_thread_id: threadId }
    ).catch(() => {});
    return;
  }
  onReply(cust.customer_key, cust.name ?? cust.customer_key, msg.text);
});

/** テキスト以外（写真・スタンプ等）は Lpro へ送れないことを知らせる */
bot.on(
  ['message:photo', 'message:sticker', 'message:document', 'message:voice',
   'message:audio', 'message:video', 'message:video_note'],
  async (ctx) => {
    const msg = ctx.message;
    if (ctx.chat.id !== cfg.groupChatId) return;
    const threadId = msg.message_thread_id;
    if (!threadId || !msg.is_topic_message) return;
    if (!dbApi.byThread(threadId)) return;
    await ctx.reply(
      '⚠️ 画像・スタンプ等は Lpro へ送信できません（テキストのみ対応）。',
      { message_thread_id: threadId }
    ).catch(() => {});
  }
);

/**
 * long polling を開始。ポーリングが致命的エラーで停止した場合（401 トークン失効、
 * 409 別プロセスと競合 等）は onFatal に通知する（黙って半死に状態になるのを防ぐ）。
 */
export async function startBot(onFatal?: (e: unknown) => void): Promise<void> {
  await bot.api.deleteWebhook().catch(() => {});
  bot.start({ onStart: () => console.log('Telegram bot started (long polling)') })
    .catch((e) => {
      console.error('Telegram long polling が停止しました:', e);
      console.error('よくある原因: (1) npm run chatid や別の npm start が同時起動して 409 Conflict (2) トークン失効で 401');
      onFatal?.(e);
    });
}

/** 終了時に呼ぶ。long polling を停止する */
export async function stopBot(): Promise<void> {
  await bot.stop();
}
