import { cfg } from './config.js';
import { dbApi } from './db.js';
import { runExclusive } from './queue.js';
import { decideDelivery } from './logic.js';
import { initBrowser, ensureLoggedIn, pollConversations, readInbound, sendReply } from './lpro-adapter.js';
import { startBot, setReplyHandler, ensureTopic, pushInbound } from './telegram.js';

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
  for (;;) {
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
    await new Promise((r) => setTimeout(r, cfg.pollIntervalMs));
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
