import { Bot } from 'grammy';
import { cfg } from './config.js';
import { dbApi } from './db.js';

export const bot = new Bot(cfg.telegramToken);

type ReplyHandler = (customerKey: string, name: string, text: string) => void;
let onReply: ReplyHandler = () => {};
export function setReplyHandler(h: ReplyHandler) { onReply = h; }

/** 顧客ごとのトピックを確保（無ければ作成） */
export async function ensureTopic(customerKey: string, name: string): Promise<number> {
  const existing = dbApi.get(customerKey);
  if (existing?.topic_thread_id) return existing.topic_thread_id;
  const topic = await bot.api.createForumTopic(cfg.groupChatId, name || customerKey);
  dbApi.setTopic(customerKey, topic.message_thread_id);
  return topic.message_thread_id;
}

/** 顧客の発言を該当トピックへ */
export async function pushInbound(threadId: number, text: string): Promise<void> {
  await bot.api.sendMessage(cfg.groupChatId, text, { message_thread_id: threadId });
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
