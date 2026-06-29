import { cfg } from './config.js';
import { dbApi, closeDb } from './db.js';
import { runExclusive } from './queue.js';
import { decideDelivery } from './logic.js';
import { initBrowser, closeBrowser, ensureLoggedIn, pollConversations, readInbound, sendReply } from './lpro-adapter.js';
import { startBot, stopBot, setReplyHandler, ensureTopic, pushInbound } from './telegram.js';

let shuttingDown = false;

async function pollOnce(): Promise<void> {
  const convs = await runExclusive(() => pollConversations());
  const targets = cfg.onlyUnread ? convs.filter((c) => c.unread) : convs;

  for (const conv of targets) {
    dbApi.upsert(conv.customerKey, conv.name);
    const threadId = await ensureTopic(conv.customerKey, conv.name);
    const inbound = await runExclusive(() => readInbound(conv));
    const cust = dbApi.get(conv.customerKey)!;

    const { deliver, newSeen } = decideDelivery(cust, inbound);
    for (const m of deliver) await pushInbound(threadId, m.text);
    if (newSeen !== null) dbApi.setSeen(conv.customerKey, newSeen, 1);
  }
}

async function main(): Promise<void> {
  if (!cfg.groupChatId) {
    console.error('GROUP_CHAT_ID 未設定。先に `npm run chatid` で取得して .env に記入してください。');
    process.exit(1);
  }
  await initBrowser();

  // Telegram → Lpro（返信）
  setReplyHandler((key, name, text) => {
    runExclusive(() => sendReply(key, name, text))
      .then(() => console.log(`→ Lpro送信 [${name}] ${text}`))
      .catch(async (e) => {
        console.error('送信失敗:', e);
        const c = dbApi.get(key);
        if (c?.topic_thread_id) {
          await pushInbound(c.topic_thread_id, `⚠️ 送信失敗: ${String(e).slice(0, 120)}`);
        }
      });
  });
  await startBot();

  // Lpro → Telegram（巡回）
  console.log('巡回開始');
  while (!shuttingDown) {
    try {
      await pollOnce();
    } catch (e) {
      console.error('poll error:', e);
      // セッション切れの可能性 → 再ログイン待ちを挟んで復旧を試みる（8章の改善）
      try {
        await runExclusive(() => ensureLoggedIn());
      } catch (e2) {
        console.error('再ログイン失敗（次の巡回で再試行）:', e2);
      }
    }
    if (shuttingDown) break;
    await new Promise((r) => setTimeout(r, cfg.pollIntervalMs));
  }
}

/** Ctrl+C / kill 時に資源を片付ける（chromium残骸・WAL破損を防ぐ） */
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`\n${signal} 受信。終了処理中…`);
  try { await stopBot(); } catch (e) { console.error('bot停止エラー:', e); }
  try { await closeBrowser(); } catch (e) { console.error('ブラウザ終了エラー:', e); }
  try { closeDb(); } catch (e) { console.error('DB終了エラー:', e); }
  console.log('終了しました。');
  process.exit(0);
}
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));

main().catch((e) => { console.error(e); process.exit(1); });
