import { Bot } from 'grammy';
import { cfg } from './config.js';

// 注意: ブリッジ本体（npm start / PM2）と同時に実行しないこと。
// 同じトークンで getUpdates を取り合い、本体側が 409 Conflict で停止する。
console.log('※ ブリッジ本体が起動中なら先に停止してください（409 Conflict になります）');

const bot = new Bot(cfg.telegramToken);
bot.on('message', (ctx) =>
  console.log('chat.id =', ctx.chat.id, '| type =', ctx.chat.type, '| thread =', ctx.message.message_thread_id)
);
bot.start({ onStart: () => console.log('対象グループでメッセージを送ると chat.id を表示します。Ctrl+Cで終了。') })
  .catch((e) => {
    console.error('起動失敗:', String(e).slice(0, 300));
    console.error('よくある原因: TELEGRAM_BOT_TOKEN が不正/失効、またはブリッジ本体が起動中（409）');
    process.exit(1);
  });
