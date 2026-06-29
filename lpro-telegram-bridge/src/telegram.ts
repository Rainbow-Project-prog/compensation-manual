import { Bot, GrammyError, HttpError } from 'grammy';
import { cfg } from './config.js';
import { dbApi } from './db.js';

export const bot = new Bot(cfg.telegramToken);

type ReplyHandler = (customerKey: string, name: string, text: string) => void;
let onReply: ReplyHandler = () => {};
export function setReplyHandler(h: ReplyHandler) { onReply = h; }

/** 一時的なエラー（429/5xx/ネットワーク）だけ指数バックオフで再試行 */
async function withRetry<T>(label: string, fn: () => Promise<T>, tries = 3): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < tries; i++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      const transient =
        e instanceof HttpError ||
        (e instanceof GrammyError && (e.error_code === 429 || e.error_code >= 500));
      if (!transient) throw e;
      const retryAfter = e instanceof GrammyError ? e.parameters?.retry_after : undefined;
      const waitMs = retryAfter ? retryAfter * 1000 : 1000 * 2 ** i;
      console.warn(`Telegram ${label} 一時エラー、${waitMs}ms後に再試行 (${i + 1}/${tries}): ${String(e).slice(0, 120)}`);
      await new Promise((r) => setTimeout(r, waitMs));
    }
  }
  throw lastErr;
}

/** 顧客ごとのトピックを確保（無ければ作成） */
export async function ensureTopic(customerKey: string, name: string): Promise<number> {
  const existing = dbApi.get(customerKey);
  if (existing?.topic_thread_id) return existing.topic_thread_id;
  let topic;
  try {
    topic = await withRetry('createForumTopic', () =>
      bot.api.createForumTopic(cfg.groupChatId, name || customerKey));
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

/** 顧客の発言を該当トピックへ */
export async function pushInbound(threadId: number, text: string): Promise<void> {
  await withRetry('sendMessage', () =>
    bot.api.sendMessage(cfg.groupChatId, text, { message_thread_id: threadId }));
}

/** 人が打った返信を拾う（トピック内のテキストのみ） */
bot.on('message:text', (ctx) => {
  const msg = ctx.message;
  if (ctx.chat.id !== cfg.groupChatId) return;
  const threadId = msg.message_thread_id;
  if (!threadId || !msg.is_topic_message) return; // General等は無視
  const cust = dbApi.byThread(threadId);
  if (!cust) return;
  onReply(cust.customer_key, cust.name ?? cust.customer_key, msg.text);
});

export async function startBot(): Promise<void> {
  await bot.api.deleteWebhook().catch(() => {});
  void bot.start({ onStart: () => console.log('Telegram bot started (long polling)') });
}

/** 終了時に呼ぶ。long polling を停止する */
export async function stopBot(): Promise<void> {
  await bot.stop();
}
