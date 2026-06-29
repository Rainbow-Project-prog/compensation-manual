import { Bot } from 'grammy';
import { cfg } from './config.js';

const bot = new Bot(cfg.telegramToken);
bot.on('message', (ctx) =>
  console.log('chat.id =', ctx.chat.id, '| type =', ctx.chat.type, '| thread =', ctx.message.message_thread_id)
);
bot.start({ onStart: () => console.log('対象グループでメッセージを送ると chat.id を表示します。Ctrl+Cで終了。') });
