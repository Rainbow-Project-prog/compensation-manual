import { cfg } from './config.js';
import { dbApi, closeDb } from './db.js';
import { runExclusive } from './queue.js';
import { decideDelivery } from './logic.js';
import { runDoctor, printResult } from './preflight.js';
import {
  initBrowser, closeBrowser, isBrowserGoneError, ensureLoggedIn,
  pollConversations, readInbound, sendReply, type Conversation,
} from './lpro-adapter.js';
import {
  startBot, stopBot, setReplyHandler, ensureTopic, pushInbound, reopenTopic,
  isThreadNotFoundError, isTopicClosedError, isTelegramError,
} from './telegram.js';

let shuttingDown = false;

/**
 * 起動時の一括ブートストラップ。全会話（未読に限らない）の現在件数を既読として記録し、
 * 過去ログを配らずに基準点を作る。これをやらないと「起動時に未読が無かった既存顧客」が
 * 稼働中に初送信したとき、初回扱いでメッセージを取りこぼす（事前レビュー確定指摘）。
 * トピックはここでは作らない（空トピックの量産防止。配信が必要になった時に作る）。
 */
async function bootstrapAll(): Promise<void> {
  console.log('起動時ブートストラップ: 全会話の既読基準を記録します…');
  const convs = await runExclusive(() => pollConversations());
  let done = 0;
  for (const conv of convs) {
    if (shuttingDown) return;
    if (dbApi.get(conv.customerKey)?.bootstrapped) continue;
    try {
      dbApi.upsert(conv.customerKey, conv.name);
      const inbound = await runExclusive(() => readInbound(conv));
      dbApi.setSeen(conv.customerKey, inbound.length, 1);
      done++;
    } catch (e) {
      // ここで失敗した会話は稼働中の初回遭遇時に bootstrapTail 付きで処理される
      console.warn(`ブートストラップ失敗（続行）: ${conv.name}:`, String(e).slice(0, 200));
    }
  }
  console.log(`起動時ブートストラップ完了: 新規 ${done} 件 / 一覧 ${convs.length} 件`);
}

/** 1会話分の取り込み。失敗しても他の会話に影響させない（呼び出し側で分類処理） */
async function processConversation(conv: Conversation): Promise<void> {
  dbApi.upsert(conv.customerKey, conv.name);
  const inbound = await runExclusive(() => readInbound(conv));
  const cust = dbApi.get(conv.customerKey)!;

  // 稼働中に初めて現れた会話（=いま未読で送ってきた新規顧客）は末尾 bootstrapTail 件だけ配る。
  // 0件配信で既読化すると初回メッセージが永久に失われるため（事前レビュー確定指摘）。
  const { deliver, newSeen } = decideDelivery(cust, inbound, { bootstrapTail: cfg.bootstrapTail });

  if (deliver.length > 0) {
    const threadId = await ensureTopic(conv.customerKey, conv.name);
    // 1件送るごとに既読を進める: 途中で失敗しても、送信済み分を次回に再配信しない
    let sent = inbound.length - deliver.length;
    for (const m of deliver) {
      try {
        await pushInbound(threadId, m.text);
      } catch (e) {
        if (isTopicClosedError(e)) {
          // 顧客対応中のトピックが閉じられていても新着は流し続ける必要がある
          console.warn(`トピックが閉じられています。開き直します: ${conv.name}`);
          await reopenTopic(threadId);
          await pushInbound(threadId, m.text);
        } else if (isThreadNotFoundError(e)) {
          // トピックが削除済み → 紐付けを外して次回作り直す
          console.warn(`トピックが削除されています。次回配信時に作り直します: ${conv.name}`);
          dbApi.clearTopic(conv.customerKey);
          throw e;
        } else {
          throw e;
        }
      }
      sent++;
      dbApi.setSeen(conv.customerKey, sent, 1);
    }
  }
  if (newSeen !== null) dbApi.setSeen(conv.customerKey, newSeen, 1);
}

async function pollOnce(): Promise<void> {
  const convs = await runExclusive(() => pollConversations());
  const targets = cfg.onlyUnread ? convs.filter((c) => c.unread) : convs;

  let playwrightSuspect = false;
  for (const conv of targets) {
    if (shuttingDown) return;
    try {
      await processConversation(conv);
    } catch (e) {
      // 1会話の失敗で残りの会話を巻き込まない（事前レビュー確定指摘）
      console.error(`会話処理失敗 [${conv.name}]:`, String(e).slice(0, 300));
      if (!isTelegramError(e)) playwrightSuspect = true;
    }
  }
  if (playwrightSuspect) {
    // Playwright 由来の失敗があった時だけログイン状態を確認（Telegramエラーで再ログインしない）
    await runExclusive(() => ensureLoggedIn());
  }
}

async function main(): Promise<void> {
  // PM2 経由は npm の prestart(doctor) を通らないため、ここでも必ずチェックする
  const pre = runDoctor();
  if (pre.problems.length > 0) {
    printResult(pre);
    process.exit(1);
  }

  await initBrowser();
  await bootstrapAll();

  // Telegram → Lpro（返信）
  setReplyHandler((key, name, text) => {
    void runExclusive(() => sendReply(key, name, text))
      .then(() => console.log(`→ Lpro送信 [${name}] ${text}`))
      .catch(async (e) => {
        console.error('送信失敗:', e);
        try {
          const c = dbApi.get(key);
          if (c?.topic_thread_id) {
            await pushInbound(c.topic_thread_id, `⚠️ 送信失敗: ${String(e).slice(0, 120)}`);
          }
        } catch (e2) {
          // 通知自体の失敗でプロセスを落とさない（事前レビュー確定指摘）
          console.error('失敗通知も送れませんでした:', e2);
        }
      });
  });
  // ポーリング停止（401/409等）は半死に状態にせず、明示的に落として PM2 に再起動させる
  await startBot((e) => { void shutdown(`TELEGRAM_FATAL: ${String(e).slice(0, 80)}`, 1); });

  // Lpro → Telegram（巡回）
  console.log('巡回開始');
  while (!shuttingDown) {
    try {
      await pollOnce();
    } catch (e) {
      console.error('poll error:', e);
      try {
        if (isBrowserGoneError(e)) {
          // ブラウザが閉じられた/クラッシュ → 再起動して復旧（要ログインなら待つ）
          console.log('ブラウザを再起動します…');
          await runExclusive(() => initBrowser());
        } else if (!isTelegramError(e)) {
          // セッション切れの可能性 → 再ログイン待ちを挟んで復旧を試みる
          await runExclusive(() => ensureLoggedIn());
        }
      } catch (e2) {
        console.error('復旧失敗（次の巡回で再試行）:', e2);
      }
    }
    if (shuttingDown) break;
    await new Promise((r) => setTimeout(r, cfg.pollIntervalMs));
  }
}

/** Ctrl+C / kill / PM2 停止時に資源を片付ける（chromium残骸・WAL破損を防ぐ） */
async function shutdown(reason: string, code = 0): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`\n${reason} 受信。終了処理中…`);
  try { await stopBot(); } catch (e) { console.error('bot停止エラー:', e); }
  try { await closeBrowser(); } catch (e) { console.error('ブラウザ終了エラー:', e); }
  try { closeDb(); } catch (e) { console.error('DB終了エラー:', e); }
  console.log('終了しました。');
  process.exit(code);
}
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
// Windows の PM2 はシグナルが届かないため 'shutdown' メッセージで通知される
// （ecosystem.config.cjs の shutdown_with_message: true とセット）
process.on('message', (m) => { if (m === 'shutdown') void shutdown('PM2 shutdown'); });

// 取りこぼした Promise 拒否でプロセスごと落ちるのを防ぐ最終防壁（Node 20 の既定は即終了）
process.on('unhandledRejection', (r) => { console.error('unhandledRejection:', r); });
process.on('uncaughtException', (e) => { console.error('uncaughtException:', e); process.exit(1); });

main().catch((e) => { console.error(e); process.exit(1); });
