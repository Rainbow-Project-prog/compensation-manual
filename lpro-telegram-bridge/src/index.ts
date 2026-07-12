import { cfg } from './config.js';
import { dbApi, closeDb } from './db.js';
import { runExclusive, drainQueue } from './queue.js';
import { decideDeliveryBySeen } from './logic.js';
import { runDoctor, printResult } from './preflight.js';
import {
  initBrowser, closeBrowser, isBrowserGoneError, pageGone, ensureLoggedIn,
  pollConversations, readInbound, sendReply, refreshTalkView, type Conversation,
} from './lpro-adapter.js';
import {
  startBot, stopBot, setReplyHandler, ensureTopic, pushInbound, reopenTopic, notifyOps,
  isThreadNotFoundError, isTopicClosedError, isTelegramError,
} from './telegram.js';

let shuttingDown = false;

// 起動時ブートストラップで観測した会員IDの集合。稼働中に初遭遇した顧客が
// 「起動時から居た（未読で委譲された）」のか「真の新規登録」なのかの区別に使う
const startupKeys = new Set<string>();

/**
 * 起動時の一括ブートストラップ。全会話（未読に限らない）の現在件数を既読として記録し、
 * 過去ログを配らずに基準点を作る。これをやらないと「起動時に未読が無かった既存顧客」が
 * 稼働中に初送信したとき、初回扱いでメッセージを取りこぼす（事前レビュー確定指摘）。
 * トピックはここでは作らない（空トピックの量産防止。配信が必要になった時に作る）。
 */
async function bootstrapAll(): Promise<void> {
  console.log('起動時ブートストラップ: 全会話の既読基準を記録します…');
  // 一覧の描画失敗を「顧客ゼロ」と確定させると、次の巡回で全顧客が初遭遇扱いになり
  // 旧履歴が BOOTSTRAP_TAIL 件ずつ一斉配信される。0件・一時エラー（セッション判定の
  // 揺れ等で pollConversations が throw するケースを含む）は一度だけ再試行して確認する
  let convs: Conversation[] = [];
  for (let attempt = 1; ; attempt++) {
    try {
      convs = await runExclusive(() => pollConversations());
      if (convs.length > 0 || attempt >= 2) break;
      console.warn('会話一覧が0件でした。描画失敗の可能性があるため再試行します…');
    } catch (e) {
      if (attempt >= 2) throw e;
      console.warn('一覧取得に失敗。再試行します…:', String(e).slice(0, 150));
    }
    await new Promise((r) => setTimeout(r, 5000));
  }
  if (convs.length === 0) {
    await notifyOps('⚠️ 起動時ブートストラップ: 会話一覧が0件です（顧客ゼロなら正常。セレクタ切れの可能性もあります）');
  }
  let done = 0;
  let skippedUnread = 0;
  for (const conv of convs) {
    if (shuttingDown) return;
    startupKeys.add(conv.customerKey);
    // 未読の未登録会話はここで既読化せず巡回の初遭遇経路（末尾 bootstrapTail 件配信）に委ねる。
    // ここで setSeen すると「ブリッジ停止中に初回接触した顧客のメッセージ」が無音で消える
    if (conv.unread && !dbApi.get(conv.customerKey)?.bootstrapped) {
      skippedUnread++;
      continue;
    }
    if (dbApi.get(conv.customerKey)?.bootstrapped) continue;
    try {
      dbApi.upsert(conv.customerKey, conv.name);
      const inbound = await runExclusive(() => readInbound(conv));
      // 表示中の全メッセージを「既知」として台帳に記録（配信はしない）
      for (const m of inbound) dbApi.addSeen(conv.customerKey, m.hash);
      dbApi.setSeen(conv.customerKey, inbound.length, 1);
      done++;
    } catch (e) {
      // ここで失敗した会話は稼働中の初回遭遇時に bootstrapTail 付きで処理される
      console.warn(`ブートストラップ失敗（続行）: ${conv.name}:`, String(e).slice(0, 200));
    }
  }
  console.log(
    `起動時ブートストラップ完了: 新規 ${done} 件 / 未読のため巡回へ委譲 ${skippedUnread} 件 / 一覧 ${convs.length} 件`
  );
}

/**
 * 1会話分の取り込み。失敗しても他の会話に影響させない（呼び出し側で分類処理）。
 * ★必ず runExclusive(() => processConversation(...)) で呼ぶこと★
 * 既読の読取→配信→setSeen を1単位で直列化しないと、巡回と返信後取り込みが同一顧客で
 * 並走したとき両者が同じ seen_count を読んで同じ新着を二重配信する。
 * （排他チェーンに入れることで shutdown の drainQueue が配信・既読更新まで待てる効果もある）
 * 戻り値: 窓から抽出できた顧客メッセージ数（セレクタ切れの無音停止を検知する監視材料）
 */
async function processConversation(conv: Conversation): Promise<number> {
  dbApi.upsert(conv.customerKey, conv.name);
  const inbound = await readInbound(conv);
  const cust = dbApi.get(conv.customerKey)!;

  // フィンガープリント方式: 台帳（seen_messages）に無いハッシュのメッセージだけ配信する。
  // 稼働中・停止中に初めて現れた会話（=いま未読で送ってきた新規顧客）は末尾 bootstrapTail 件だけ配る。
  // 0件配信で既知化すると初回メッセージが永久に失われるため（事前レビュー確定指摘 [0]）。
  // ただし起動時に存在しなかった「真の新規顧客」は履歴全体が新規なので窓の全件を配る
  // （バースト連投が bootstrapTail で切り捨てられて初回メッセージが欠ける問題の対策）
  const tail = startupKeys.has(conv.customerKey) ? cfg.bootstrapTail : Number.MAX_SAFE_INTEGER;
  const { deliver, bootstrap } = decideDeliveryBySeen(
    !!cust.bootstrapped,
    inbound,
    (h) => dbApi.hasSeen(conv.customerKey, h),
    { bootstrapTail: tail }
  );

  if (bootstrap) {
    // 初遭遇: 「配信しない過去ログ」だけを先に既知化する。配信対象（deliver）を先に既知化すると、
    // 配信途中の一時エラーで新規顧客の初回メッセージが恒久的に消える（改修検証の確定指摘）。
    // deliver 分は下の配信ループが1件成功ごとに既知化し、途中失敗しても bootstrapped=1 済みなので
    // 次巡回の未知差分（decideDeliveryBySeen）が残りを再配信する
    const deliverSet = new Set(deliver.map((m) => m.hash));
    for (const m of inbound) {
      if (!deliverSet.has(m.hash)) dbApi.addSeen(conv.customerKey, m.hash);
    }
    dbApi.setSeen(conv.customerKey, inbound.length, 1);
  }
  if (deliver.length > 0) {
    // トピック名に会員IDを含めて同名顧客の取り違えを防ぐ
    const threadId = await ensureTopic(conv.customerKey, `${conv.name}（${conv.customerKey}）`);
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
      // 1件成功ごとに既知化: 途中で失敗しても、送信済み分を次回に再配信しない
      dbApi.addSeen(conv.customerKey, m.hash);
    }
  }
  if (!bootstrap) {
    // 配信対象でなかった分も含め窓内の全ハッシュを既知に保つ
    // （プルーニング済みの古いメッセージが窓に残っていても再配信しない）
    for (const m of inbound) dbApi.addSeen(conv.customerKey, m.hash);
    dbApi.setSeen(conv.customerKey, inbound.length, 1);
  }
  dbApi.pruneSeen(conv.customerKey);
  return inbound.length;
}

// 無音障害の自己申告用カウンタ（この構成の故障はほぼ「Telegramが静かになる」形で現れるため）
let convFailureStreak = 0;
let zeroExtractStreak = 0;
let lastTopicFailNotifyAt = 0;

async function pollOnce(): Promise<void> {
  const convs = await runExclusive(() => pollConversations());
  const targets = cfg.onlyUnread ? convs.filter((c) => c.unread) : convs;

  let playwrightSuspect = false;
  let convFailures = 0;
  let extracted = 0;
  for (const conv of targets) {
    if (shuttingDown) return;
    try {
      extracted += await runExclusive(() => processConversation(conv));
    } catch (e) {
      // 1会話の失敗で残りの会話を巻き込まない（事前レビュー確定指摘）
      console.error(`会話処理失敗 [${conv.name}]:`, String(e).slice(0, 300));
      convFailures++;
      // トピック作成の 400 はセットアップ不備（Topics OFF/権限剥奪/GROUP_CHAT_ID誤り）の
      // 可能性が高く、放置すると全顧客が無音で未配信になる → 1時間に1回まで即時自己申告
      if (String(e).includes('トピック作成に失敗') && Date.now() - lastTopicFailNotifyAt > 3_600_000) {
        lastTopicFailNotifyAt = Date.now();
        await notifyOps('⚠️ トピック作成に失敗しています。グループの Topics 設定・botの「トピックの管理」権限・GROUP_CHAT_ID を確認してください');
      }
      if (!isTelegramError(e)) playwrightSuspect = true;
    }
  }
  // 会話単位の失敗が続く場合も自己申告（consecutiveFailures は巡回全体の失敗しか数えないため）
  if (convFailures > 0) {
    convFailureStreak++;
    if (convFailureStreak === 5) {
      await notifyOps(`⚠️ 会話の配信失敗が5巡回連続で発生しています（直近の巡回で ${convFailures} 件）。ログを確認してください`);
    }
  } else {
    convFailureStreak = 0;
  }
  // 未読顧客がいるのにメッセージを1件も抽出できない状態が続く = メッセージ系セレクタ切れの疑い
  if (targets.length > 0 && extracted === 0 && convFailures === 0) {
    zeroExtractStreak++;
    if (zeroExtractStreak === 10) {
      await notifyOps('⚠️ 未読顧客がいるのにメッセージを1件も抽出できない状態が続いています（メッセージ系セレクタ切れの疑い）');
    }
  } else {
    zeroExtractStreak = 0;
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

  // GROUP_CHAT_ID が変わった場合、旧グループ由来のスレッドIDは新グループの別トピックと
  // 番号衝突し「別顧客への誤配信」の温床になるため、紐付けを全て外して作り直す
  const prevGid = dbApi.getMeta('group_chat_id');
  if (prevGid !== undefined && prevGid !== String(cfg.groupChatId)) {
    console.warn(`GROUP_CHAT_ID が変更されました（${prevGid} → ${cfg.groupChatId}）。全トピック紐付けをリセットします`);
    dbApi.clearAllTopics();
  }
  dbApi.setMeta('group_chat_id', String(cfg.groupChatId));

  // 旧形式DB（件数ベース版が作った bridge.db）の移行ガード:
  // bootstrapped=1 なのにフィンガープリント台帳が空のまま巡回に入ると、
  // 窓内の過去ログ全件が「未知」となり全顧客へ一斉再配信されてしまう
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
  setReplyHandler((key, name, text) => {
    // 送信前にDBへ控えを残す: grammY はハンドラ復帰時点でオフセットを確定するため、
    // 送信完了前にプロセスが死ぬ（クラッシュ/電源断/SIGKILL）と返信は Telegram から
    // 再取得できない。控えがあれば再起動時に「未送信の可能性」を該当トピックへ通知できる
    const pendingId = dbApi.addPending(key, name, text);
    void runExclusive(() => sendReply(key, name, text))
      .then(() => {
        dbApi.deletePending(pendingId);
        // 会話本文はログに残さない（PM2 のログは平文でディスクに蓄積されるため）
        console.log(`→ Lpro送信 [${name}] (${text.length}字)`);
        // 返信で未返信状態が変わり、直前ポーリング以降の新着が ONLY_UNREAD フィルタから
        // 漏れ得るため、この会話だけ即座に取り込み直す
        // （runExclusive 1単位で呼ぶ: 巡回側と並走しても既読の読取〜更新が交錯しない。
        //   送信操作でフレームが再読込されるとは限らないため、必ず開き直してから読む）
        if (shuttingDown) return;
        return runExclusive(async () => {
          await refreshTalkView();
          await processConversation({ customerKey: key, name, unread: true });
        }).catch((e) => console.error(`返信後の取り込み失敗 [${name}]:`, String(e).slice(0, 200)));
      })
      .catch(async (e) => {
        console.error('送信失敗:', e);
        try {
          const c = dbApi.get(key);
          if (c?.topic_thread_id) {
            await pushInbound(c.topic_thread_id, `⚠️ 送信失敗: ${String(e).slice(0, 120)}`);
          }
          // オペレータへ失敗を通知できたので控えは不要（通知に失敗したら残し、再起動時に知らせる）
          dbApi.deletePending(pendingId);
        } catch (e2) {
          // 通知自体の失敗でプロセスを落とさない（事前レビュー確定指摘）
          console.error('失敗通知も送れませんでした:', e2);
        }
      });
  });
  // ポーリング停止（401/409等）は半死に状態にせず、明示的に落として PM2 に再起動させる
  await startBot((e) => { void shutdown(`TELEGRAM_FATAL: ${String(e).slice(0, 80)}`, 1); });

  // 前回の停止時に送信を完了できなかった可能性のある返信を該当トピックへ通知する
  // （自動再送はしない: 実際は送信済みだった場合に顧客へ二重送信してしまうため）
  for (const pr of dbApi.listPending()) {
    const c = dbApi.get(pr.customer_key);
    const note =
      `⚠️ 前回の停止時に、この返信の送信が完了していない可能性があります。` +
      `Lpro で送信済みか確認し、未送信なら送り直してください:\n${pr.text}`;
    try {
      if (c?.topic_thread_id) {
        await pushInbound(c.topic_thread_id, note);
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
        // この構成の故障はほぼ「Telegram が静かになる」形で現れるため、沈黙させずに自己申告する
        await notifyOps('⚠️ 巡回が10回連続で失敗しています。ブリッジのログを確認してください');
      }
      // shutdown 中の closeBrowser が出す TargetClosed を拾ってブラウザを再起動しない
      if (!shuttingDown) {
        try {
          if (isBrowserGoneError(e) || pageGone()) {
            // ブラウザが閉じられた/クラッシュ/前回の再起動失敗で page が無い → 再起動して復旧
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
  // オフセットを確定し、打ち切られた返信が無音で失われる）。遅い返信は openConversation の
  // 待機だけで最大25秒かかり得るため上限20秒とし、PM2 の kill_timeout 40秒に収める
  await Promise.race([drainQueue(), new Promise((r) => setTimeout(r, 20_000))]);
  try { await stopBot(); } catch (e) { console.error('bot停止エラー:', e); }
  await Promise.race([drainQueue(), new Promise((r) => setTimeout(r, 5000))]);
  try { await closeBrowser(); } catch (e) { console.error('ブラウザ終了エラー:', e); }
  try { closeDb(); } catch (e) { console.error('DB終了エラー:', e); }
  console.log('終了しました。');
  process.exit(code);
}
// Playwright の SIGINT ハンドラは無効化してある（handleSIGINT:false）ため、2回目の Ctrl+C は
// こちらで強制終了させる（chromium は playwright の process exit ハンドラが後始末する）
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
// （ecosystem.config.cjs の shutdown_with_message: true とセット）
process.on('message', (m) => { if (m === 'shutdown') void shutdown('PM2 shutdown'); });

// 取りこぼした Promise 拒否でプロセスごと落ちるのを防ぐ最終防壁（Node 20 の既定は即終了）
process.on('unhandledRejection', (r) => { console.error('unhandledRejection:', r); });
// uncaughtException でも即死せず、実行中の返信送信を排水してから落ちる
// （即 exit するとキュー滞留中のオペレータ返信が無音で消える。上限8秒で必ず終了）
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
