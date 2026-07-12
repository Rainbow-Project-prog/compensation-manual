import { cfg, inboxes, inboxById, type Inbox } from './config.js';
import { dbApi, closeDb } from './db.js';
import { runExclusive, drainQueue } from './queue.js';
import { decideDeliveryBySeen } from './logic.js';
import { runDoctor, printResult } from './preflight.js';
import {
  initBrowser, closeBrowser, isBrowserGoneError, pageGone, ensureLoggedIn,
  pollConversations, readInbound, sendReply, pollHitLimit, listAllMemberIds, type Conversation,
} from './lpro-adapter.js';
import {
  startBot, stopBot, setReplyHandler, ensureTopic, pushInbound, reopenTopic, notifyOps,
  isThreadNotFoundError, isTopicClosedError, isTelegramError,
} from './telegram.js';

let shuttingDown = false;

// DBキーは「受信箱ID:会員ID」。同じ会員IDがチャットとトークの両方に居ても取り違えない
function keyOf(inbox: Inbox, memberId: string): string {
  return `${inbox.id}:${memberId}`;
}

// 起動時ブートストラップで観測したDBキーの集合。稼働中に初遭遇した顧客が
// 「起動時から居た（未読で委譲された）」のか「真の新規登録」なのかの区別に使う
const startupKeys = new Set<string>();

/**
 * 起動時の一括ブートストラップ。各受信箱の全会話の現在件数を既読として記録し、
 * 過去ログを配らずに基準点を作る。トピックはここでは作らない（配信が必要になった時に作る）。
 */
async function bootstrapAll(): Promise<void> {
  for (const inbox of inboxes) {
    if (shuttingDown) return;
    console.log(`起動時ブートストラップ [${inbox.name}]: 既読基準を記録します…`);
    // 一覧の描画失敗を「顧客ゼロ」と確定させると、次の巡回で全顧客が初遭遇扱いになり
    // 旧履歴が BOOTSTRAP_TAIL 件ずつ一斉配信される。0件・一時エラーは一度だけ再試行して確認する
    let convs: Conversation[] = [];
    for (let attempt = 1; ; attempt++) {
      try {
        convs = await runExclusive(() => pollConversations(inbox));
        if (convs.length > 0 || attempt >= 2) break;
        console.warn(`[${inbox.name}] 会話一覧が0件でした。描画失敗の可能性があるため再試行します…`);
      } catch (e) {
        if (attempt >= 2) throw e;
        console.warn(`[${inbox.name}] 一覧取得に失敗。再試行します…:`, String(e).slice(0, 150));
      }
      await new Promise((r) => setTimeout(r, 5000));
    }
    if (convs.length === 0) {
      await notifyOps(`⚠️ 起動時ブートストラップ [${inbox.name}]: 会話一覧が0件です（顧客ゼロなら正常。セレクタ切れの可能性もあります）`);
    }
    // 返信済みも含む全会員IDを startupKeys に登録する（未返信だけ見ると、返信済み既存顧客が
    // 起動後に初送信したとき「真の新規」と誤認され履歴窓全件配信になるため）。
    // ここは会員IDの把握が目的なのでメッセージ本文は読まない（すべて検索で軽く一覧取得）。
    try {
      const all = await runExclusive(() => listAllMemberIds(inbox));
      for (const c of all) startupKeys.add(keyOf(inbox, c.memberId));
    } catch (e) {
      console.warn(`[${inbox.name}] 全会員IDの把握に失敗（続行）:`, String(e).slice(0, 150));
    }
    let done = 0;
    let skippedUnread = 0;
    for (const conv of convs) {
      if (shuttingDown) return;
      const key = keyOf(inbox, conv.memberId);
      startupKeys.add(key);
      // 未読の未登録会話はここで既読化せず巡回の初遭遇経路（末尾 bootstrapTail 件配信）に委ねる。
      if (conv.unread && !dbApi.get(key)?.bootstrapped) {
        skippedUnread++;
        continue;
      }
      if (dbApi.get(key)?.bootstrapped) continue;
      try {
        dbApi.upsert(key, conv.name);
        const inbound = conv.inbound ?? [];
        for (const m of inbound) dbApi.addSeen(key, m.hash);
        dbApi.setSeen(key, inbound.length, 1);
        done++;
      } catch (e) {
        console.warn(`[${inbox.name}] ブートストラップ失敗（続行）: ${conv.name}:`, String(e).slice(0, 200));
      }
    }
    console.log(
      `起動時ブートストラップ完了 [${inbox.name}]: 新規 ${done} 件 / 未読のため巡回へ委譲 ${skippedUnread} 件 / 一覧 ${convs.length} 件`
    );
  }
}

/**
 * 1会話分の取り込み。★必ず runExclusive(() => processConversation(...)) で呼ぶこと★
 * 既読の読取→配信→setSeen を1単位で直列化しないと、巡回と返信後取り込みが同一顧客で
 * 並走したとき両者が同じ差分を読んで二重配信する。
 * 戻り値: 窓から抽出できた顧客メッセージ数（セレクタ切れの無音停止を検知する監視材料）
 */
async function processConversation(inbox: Inbox, conv: Conversation): Promise<number> {
  const key = keyOf(inbox, conv.memberId);
  dbApi.upsert(key, conv.name);
  // 巡回経路は pollConversations が1パスで抽出済み（conv.inbound）。返信後の単発再取り込み等で
  // inbound 未添付なら会員ID検索で読む
  const inbound = conv.inbound ?? await readInbound(inbox, conv);
  const cust = dbApi.get(key)!;

  // フィンガープリント方式: 台帳に無いハッシュのメッセージだけ配信する。
  // 起動時に存在しなかった「真の新規顧客」は履歴全体が新規なので窓の全件を配る
  const tail = startupKeys.has(key) ? cfg.bootstrapTail : Number.MAX_SAFE_INTEGER;
  const { deliver, bootstrap } = decideDeliveryBySeen(
    !!cust.bootstrapped,
    inbound,
    (h) => dbApi.hasSeen(key, h),
    { bootstrapTail: tail }
  );

  if (bootstrap) {
    // 初遭遇: 「配信しない過去ログ」だけを先に既知化する（deliver は配信成功ごとに既知化）
    const deliverSet = new Set(deliver.map((m) => m.hash));
    for (const m of inbound) {
      if (!deliverSet.has(m.hash)) dbApi.addSeen(key, m.hash);
    }
    dbApi.setSeen(key, inbound.length, 1);
  }
  if (deliver.length > 0) {
    // トピック名に会員IDを含めて同名顧客の取り違えを防ぐ。トピックは受信箱のグループへ作る
    const threadId = await ensureTopic(key, `${conv.name}（${conv.memberId}）`, inbox.groupChatId);
    for (const m of deliver) {
      try {
        await pushInbound(inbox.groupChatId, threadId, m.text);
      } catch (e) {
        if (isTopicClosedError(e)) {
          console.warn(`[${inbox.name}] トピックが閉じられています。開き直します: ${conv.name}`);
          await reopenTopic(inbox.groupChatId, threadId);
          await pushInbound(inbox.groupChatId, threadId, m.text);
        } else if (isThreadNotFoundError(e)) {
          console.warn(`[${inbox.name}] トピックが削除されています。次回作り直します: ${conv.name}`);
          dbApi.clearTopic(key);
          throw e;
        } else {
          throw e;
        }
      }
      // 1件成功ごとに既知化: 途中で失敗しても、送信済み分を次回に再配信しない
      dbApi.addSeen(key, m.hash);
    }
  }
  if (!bootstrap) {
    for (const m of inbound) dbApi.addSeen(key, m.hash);
    dbApi.setSeen(key, inbound.length, 1);
  }
  dbApi.pruneSeen(key);
  return inbound.length;
}

// 無音障害の自己申告用カウンタ
let convFailureStreak = 0;
const zeroExtractStreak = new Map<string, number>();
let lastTopicFailNotifyAt = 0;

async function pollOnce(): Promise<void> {
  let playwrightSuspect = false;
  let cycleConvFailures = 0;

  for (const inbox of inboxes) {
    if (shuttingDown) return;
    let convs: Conversation[];
    try {
      convs = await runExclusive(() => pollConversations(inbox));
    } catch (e) {
      console.error(`一覧取得失敗 [${inbox.name}]:`, String(e).slice(0, 200));
      cycleConvFailures++;
      if (!isTelegramError(e)) playwrightSuspect = true;
      continue; // この受信箱は今サイクル諦め、他の受信箱は続行する
    }
    const targets = cfg.onlyUnread ? convs.filter((c) => c.unread) : convs;

    let extracted = 0;
    let convFailures = 0;
    for (const conv of targets) {
      if (shuttingDown) return;
      try {
        extracted += await runExclusive(() => processConversation(inbox, conv));
      } catch (e) {
        console.error(`会話処理失敗 [${inbox.name}][${conv.name}]:`, String(e).slice(0, 300));
        convFailures++;
        // トピック作成の 400 はセットアップ不備の可能性が高く放置すると全顧客が無音未配信 → 即時自己申告
        if (String(e).includes('トピック作成に失敗') && Date.now() - lastTopicFailNotifyAt > 3_600_000) {
          lastTopicFailNotifyAt = Date.now();
          await notifyOps(`⚠️ [${inbox.name}] トピック作成に失敗しています。グループの Topics 設定・botの「トピックの管理」権限・GROUP_CHAT_ID を確認してください`);
        }
        if (!isTelegramError(e)) playwrightSuspect = true;
      }
    }
    cycleConvFailures += convFailures;
    // 未読顧客がいるのにメッセージを1件も抽出できない状態が続く = メッセージ系セレクタ切れの疑い（受信箱ごと）
    if (targets.length > 0 && extracted === 0 && convFailures === 0) {
      const n = (zeroExtractStreak.get(inbox.id) ?? 0) + 1;
      zeroExtractStreak.set(inbox.id, n);
      if (n === 10) {
        await notifyOps(`⚠️ [${inbox.name}] 未読顧客がいるのにメッセージを1件も抽出できません（メッセージ系セレクタ切れの疑い）`);
      }
    } else {
      zeroExtractStreak.set(inbox.id, 0);
    }
  }

  // 会話単位の失敗が続く場合も自己申告
  if (cycleConvFailures > 0) {
    convFailureStreak++;
    if (convFailureStreak === 5) {
      await notifyOps(`⚠️ 会話の配信失敗が5巡回連続で発生しています（直近の巡回で ${cycleConvFailures} 件）。ログを確認してください`);
    }
  } else {
    convFailureStreak = 0;
  }
  // 表示上限に達した（未返信が多すぎて古い顧客を取りこぼす可能性）を1回だけ自己申告
  if (pollHitLimit() && !overLimitNotified) {
    overLimitNotified = true;
    await notifyOps('⚠️ 未返信の一覧が表示上限に達しました。古い未返信顧客を取りこぼす可能性があります。Lpro で未返信を処理してください');
  }
  if (playwrightSuspect) {
    await runExclusive(() => ensureLoggedIn(inboxes[0]));
  }
}
let overLimitNotified = false;

async function main(): Promise<void> {
  // PM2 経由は npm の prestart(doctor) を通らないため、ここでも必ずチェックする
  const pre = runDoctor();
  if (pre.problems.length > 0) {
    printResult(pre);
    process.exit(1);
  }
  console.log('監視対象の受信箱: ' + inboxes.map((i) => `${i.name}(group ${i.groupChatId})`).join(' / '));

  // 各受信箱の GROUP_CHAT_ID 変更検知。旧グループ由来のスレッドIDは新グループの別トピックと
  // 番号衝突し「別顧客への誤配信」の温床になるため、旧グループの紐付けを外して作り直す
  for (const inbox of inboxes) {
    const metaKey = `group_chat_id:${inbox.id}`;
    const prev = dbApi.getMeta(metaKey);
    if (prev !== undefined && prev !== String(inbox.groupChatId)) {
      console.warn(`[${inbox.name}] GROUP_CHAT_ID が変更されました（${prev} → ${inbox.groupChatId}）。旧グループのトピック紐付けをリセットします`);
      dbApi.clearTopicsByGroup(Number(prev));
    }
    dbApi.setMeta(metaKey, String(inbox.groupChatId));
  }

  // 旧形式DB（件数ベース版が作った bridge.db）の移行ガード
  if (dbApi.getMeta('fp_seeded') === undefined) {
    if (dbApi.countBootstrapped() > 0 && dbApi.countSeenAll() === 0) {
      console.warn('旧形式の bridge.db を検出。全顧客を再ブートストラップして台帳を再構築します（未読顧客は末尾数件のみ配信・一部重複の可能性あり）');
      dbApi.resetAllBootstrapped();
    }
    dbApi.setMeta('fp_seeded', '1');
  }

  await initBrowser();
  await bootstrapAll();

  // Telegram → Lpro（返信）
  setReplyHandler((inboxId, memberId, name, text) => {
    const inbox = inboxById(inboxId);
    if (!inbox) {
      console.error(`返信の受信箱が不明です（inboxId=${inboxId}）。無視します`);
      return;
    }
    const key = keyOf(inbox, memberId);
    // 送信前にDBへ控えを残す（クラッシュ/電源断で送信途中に死んでも再起動時に「未送信の可能性」を通知できる）
    const pendingId = dbApi.addPending(key, name, text);
    void runExclusive(() => sendReply(inbox, memberId, text))
      .then(() => {
        dbApi.deletePending(pendingId);
        // 会話本文はログに残さない（PM2 のログは平文でディスクに蓄積されるため）
        console.log(`→ Lpro送信 [${inbox.name}][${name}] (${text.length}字)`);
        if (shuttingDown) return;
        // 返信で相手が返信済みになり未返信一覧から外れても、inbound 未添付で渡すと
        // processConversation が会員ID検索で読み直すため、直前の新着を取りこぼさない
        return runExclusive(() => processConversation(inbox, { memberId, name, unread: true }))
          .catch((e) => console.error(`返信後の取り込み失敗 [${inbox.name}][${name}]:`, String(e).slice(0, 200)));
      })
      .catch(async (e) => {
        console.error('送信失敗:', e);
        try {
          const c = dbApi.get(key);
          if (c?.topic_thread_id && c.group_chat_id) {
            await pushInbound(c.group_chat_id, c.topic_thread_id, `⚠️ 送信失敗: ${String(e).slice(0, 120)}`);
          }
          dbApi.deletePending(pendingId);
        } catch (e2) {
          console.error('失敗通知も送れませんでした:', e2);
        }
      });
  });
  // ポーリング停止（401/409等）は半死に状態にせず、明示的に落として PM2 に再起動させる
  await startBot((e) => { void shutdown(`TELEGRAM_FATAL: ${String(e).slice(0, 80)}`, 1); });

  // 前回の停止時に送信を完了できなかった可能性のある返信を通知する（自動再送はしない）
  for (const pr of dbApi.listPending()) {
    const c = dbApi.get(pr.customer_key);
    const note =
      `⚠️ 前回の停止時に、この返信の送信が完了していない可能性があります。` +
      `Lpro で送信済みか確認し、未送信なら送り直してください:\n${pr.text}`;
    try {
      if (c?.topic_thread_id && c.group_chat_id) {
        await pushInbound(c.group_chat_id, c.topic_thread_id, note);
      } else {
        await notifyOps(`⚠️ 前回の停止時に未送信の可能性がある返信が1件あります（宛先: ${pr.name ?? pr.customer_key}）。Lpro を確認してください`);
      }
      dbApi.deletePending(pr.id);
    } catch (e) {
      console.error('未送信返信の通知に失敗（次回起動時に再通知）:', String(e).slice(0, 150));
    }
  }

  // Lpro → Telegram（巡回）
  console.log('巡回開始');
  let consecutiveFailures = 0;
  while (!shuttingDown) {
    try {
      await pollOnce();
      consecutiveFailures = 0;
    } catch (e) {
      console.error('poll error:', e);
      consecutiveFailures++;
      if (consecutiveFailures === 10) {
        await notifyOps('⚠️ 巡回が10回連続で失敗しています。ブリッジのログを確認してください');
      }
      if (!shuttingDown) {
        try {
          if (isBrowserGoneError(e) || pageGone()) {
            console.log('ブラウザを再起動します…');
            await runExclusive(() => initBrowser());
          } else if (!isTelegramError(e)) {
            await runExclusive(() => ensureLoggedIn(inboxes[0]));
          }
        } catch (e2) {
          console.error('復旧失敗（次の巡回で再試行）:', e2);
        }
      }
    }
    if (shuttingDown) break;
    await new Promise((r) => setTimeout(r, cfg.pollIntervalMs));
  }
}

/** Ctrl+C / kill / PM2 停止時に資源を片付ける（chromium残骸・WAL破損・返信の取り逃しを防ぐ） */
async function shutdown(reason: string, code = 0): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`\n${reason} 受信。終了処理中…`);
  // 実行中の返信送信・取り込みを先に終わらせる（bot を先に止めると grammY が処理前 update の
  // オフセットを確定し、打ち切られた返信が無音で失われる）。PM2 の kill_timeout 40秒に収める
  await Promise.race([drainQueue(), new Promise((r) => setTimeout(r, 20_000))]);
  try { await stopBot(); } catch (e) { console.error('bot停止エラー:', e); }
  await Promise.race([drainQueue(), new Promise((r) => setTimeout(r, 5000))]);
  try { await closeBrowser(); } catch (e) { console.error('ブラウザ終了エラー:', e); }
  try { closeDb(); } catch (e) { console.error('DB終了エラー:', e); }
  console.log('終了しました。');
  process.exit(code);
}
// Playwright の SIGINT ハンドラは無効化してある（handleSIGINT:false）ため、2回目の Ctrl+C は強制終了
let sigintCount = 0;
process.on('SIGINT', () => {
  sigintCount++;
  if (sigintCount >= 2) {
    console.error('2回目の SIGINT。強制終了します');
    process.exit(130);
  }
  void shutdown('SIGINT');
});
process.on('SIGTERM', () => void shutdown('SIGTERM'));
// Windows の PM2 はシグナルが届かないため 'shutdown' メッセージで通知される
process.on('message', (m) => { if (m === 'shutdown') void shutdown('PM2 shutdown'); });

// 取りこぼした Promise 拒否でプロセスごと落ちるのを防ぐ最終防壁（Node 20 の既定は即終了）
process.on('unhandledRejection', (r) => { console.error('unhandledRejection:', r); });
// uncaughtException でも即死せず、実行中の返信送信を排水してから落ちる（上限8秒）
let crashing = false;
process.on('uncaughtException', (e) => {
  console.error('uncaughtException:', e);
  if (crashing) return;
  crashing = true;
  shuttingDown = true;
  void Promise.race([drainQueue(), new Promise((r) => setTimeout(r, 8000))])
    .finally(() => process.exit(1));
});

main().catch((e) => { console.error(e); process.exit(1); });
