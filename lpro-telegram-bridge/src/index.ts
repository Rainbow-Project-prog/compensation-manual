import { cfg, inboxes, inboxById, type Inbox } from './config.js';
import { dbApi, closeDb } from './db.js';
import { runExclusive, drainQueue } from './queue.js';
import { decideDeliveryBySeen, packDeliveryChunks, decideMarkerTransitions, type MarkerState } from './logic.js';
import { runBackup } from './backup.js';
import { runDoctor, printResult } from './preflight.js';
import {
  initBrowser, closeBrowser, isBrowserGoneError, pageGone, ensureLoggedIn, setLoginNotifier,
  pollConversations, readInbound, sendReply, pollHitLimit, pollHitLimitFor, listAllMemberIds, type Conversation,
} from './lpro-adapter.js';
import {
  startBot, stopBot, setReplyHandler, ensureTopic, pushInbound, reopenTopic, renameTopic, retryAfterMs,
  notifyOps, isThreadNotFoundError, isTopicClosedError, isTelegramError,
} from './telegram.js';

let shuttingDown = false;

// DBキーは「受信箱ID:会員ID」。同じ会員IDがチャットとトークの両方に居ても取り違えない
function keyOf(inbox: Inbox, memberId: string): string {
  return `${inbox.id}:${memberId}`;
}

// 起動時ブートストラップで観測したDBキーの集合。稼働中に初遭遇した顧客が
// 「起動時から居た（未読で委譲された）」のか「真の新規登録」なのかの区別に使う
const startupKeys = new Set<string>();
// 起動時に全会員IDを取り切れたか（取り切れないと「真の新規」判定が信用できないので保守運用にする）
let startupComplete = true;

// 自分側（L-Pro/オペレーター）発言を Telegram に流すときのラベル。顧客の発言と一目で区別する
const SELF_PREFIX = '🔷 自分(L-Pro): ';

// ── L-Pro対応状況のトピック名マーカー（🔴未対応/✅対応済み。L-Pro の henshin が正）──
// Telegram の未読バッジは各メンバーのクライアント状態で bot からは消せないため、
// 「トピック一覧で対応状況が一目で分かる」表現としてトピック名の先頭マーカーを同期する。
function markerName(marker: MarkerState, name: string | null, memberId: string): string {
  const base = name && name.trim() !== '' ? name : `ID:${memberId}`;
  return `${marker === 'done' ? '✅' : '🔴'} ${base}（${memberId}）`;
}

// Telegram 経由で送った返信は、次の読取で自分側吹き出しとして「逆流」してくる。そのまま配信すると
// 二重表示になるため、送信本文（正規化）を控え、一致する自分側発言は配信を抑止する（既知化はする）。
// 控えは DB に永続化する: 送信直後は吹き出しがまだ描画されず控えを既知化できないうちに再起動（や
// ログイン待ち）が挟まると、メモリ控えだと失われて逆流を1回配信してしまうため。TTL で自動失効。
const SENT_ECHO_TTL_MS = 60 * 60_000;
const normText = (s: string): string => s.trim().replace(/\s+/g, ' ');
function recordSentEcho(key: string, text: string): void {
  dbApi.addSentEcho(key, normText(text));
  dbApi.pruneSentEchoes(SENT_ECHO_TTL_MS);
}
/** 自分側発言 text がブリッジ自身の送信（逆流）なら true（控えを1件消費）。PC直返信は false でそのまま配信。 */
function consumeSentEcho(key: string, text: string): boolean {
  return dbApi.consumeSentEcho(key, normText(text), SENT_ECHO_TTL_MS);
}

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
    // メッセージ本文は読まない（すべて検索で会員IDのみ軽く取得）。失敗/打ち切り時は
    // startupComplete=false にして「真の新規」判定を保守側（bootstrapTail 相当）へ倒す。
    let got = false;
    for (let attempt = 1; attempt <= 2 && !got; attempt++) {
      try {
        const { ids, truncated } = await runExclusive(() => listAllMemberIds(inbox));
        for (const id of ids) startupKeys.add(keyOf(inbox, id));
        got = true;
        if (truncated) {
          startupComplete = false;
          console.warn(`[${inbox.name}] 会員IDが表示上限(${ids.length}件)で打ち切られました。真の新規判定を保守側に倒します`);
        }
      } catch (e) {
        console.warn(`[${inbox.name}] 全会員IDの把握に失敗（${attempt}/2）:`, String(e).slice(0, 150));
        if (attempt < 2) await new Promise((r) => setTimeout(r, 3000));
      }
    }
    if (!got) startupComplete = false;
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
        // inbound は顧客側＋自分側の両方を含む。全件を既知化して基準化する（自分側もこれで baseline 済み）
        for (const m of inbound) dbApi.addSeen(key, m.hash);
        dbApi.setSeen(key, inbound.length, 1);
        dbApi.setSelfSeeded(key);
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

// 日次ハートビートで報告する稼働カウンタ（前回ハートビート以降の累計）
const stats = { polls: 0, delivered: 0, sent: 0 };

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
  // 未読なのに1件も抽出できない行は、履歴の遅延描画がまだ（画面外・ロード中）の可能性が高い。
  // このまま進めると「空のベースライン」で bootstrapped 化され、実在する未読メッセージが
  // 配信されないまま既読相当になる（2026-08-06 の実機事故）。何もせず後続サイクルに委ねる
  if (conv.unread && inbound.length === 0) return 0;
  const cust = dbApi.get(key)!;

  // 移行ガード（双方向同期）: 自分側発言は従来フィンガープリント化されていなかったため、既存(bootstrap済)
  // 顧客の台帳には自分側ハッシュが無い。初回接触で現在の自分側発言を一括既知化し、過去分の一斉配信を防ぐ。
  if (cust.bootstrapped && !cust.self_seeded) {
    for (const m of inbound) if (m.self) dbApi.addSeen(key, m.hash);
    dbApi.setSelfSeeded(key);
  }

  // フィンガープリント方式: 台帳に無いハッシュのメッセージだけ配信する。
  // 起動時に存在しなかった「真の新規顧客」は履歴全体が新規なので窓の全件を配る。
  // ただし起動時の全会員ID把握に失敗/打ち切りがあると「真の新規」判定が信用できないので、
  // その場合は保守側（bootstrapTail 件）に倒して既存顧客の過剰配信を防ぐ
  const trulyNew = startupComplete && !startupKeys.has(key);
  const tail = trulyNew ? Number.MAX_SAFE_INTEGER : cfg.bootstrapTail;
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
    dbApi.setSelfSeeded(key);
  }
  // 自送信の逆流（Telegram経由で送った返信が自分側吹き出しとして再出現）は配信しない（既知化のみ）。
  // PC で直接 L-Pro に打った返信は控えに無いのでそのまま配信される＝双方向にリンクする。
  const toDeliver: typeof deliver = [];
  for (const m of deliver) {
    if (m.self && consumeSentEcho(key, m.text)) { dbApi.addSeen(key, m.hash); continue; }
    toDeliver.push(m);
  }
  if (toDeliver.length > 0) {
    // トピック名に会員IDを含めて同名顧客の取り違えを防ぐ。トピックは受信箱のグループへ作る。
    // 新規作成時は現在の対応状況マーカー込みの名前にする（未読巡回経路=🔴 / 再同期経路=✅）
    const initialMarker: MarkerState = conv.unread ? 'pending' : 'done';
    const threadId = await ensureTopic(
      key, markerName(initialMarker, conv.name, conv.memberId), inbox.groupChatId, initialMarker
    );
    // 大量配信（新規顧客の履歴一括など）を1件1通で送ると Telegram のレート制限(429)を連発する
    // ため、まとまっている場合だけ複数件を1通に連結して通数を減らす。通常の新着は従来どおり1件1通。
    // 自分側発言はラベルを付けて顧客の発言と区別する
    const chunks = packDeliveryChunks(
      toDeliver,
      (m) => (m.self ? SELF_PREFIX + m.text : m.text),
      { sep: '\n──────\n' }
    );
    for (const chunk of chunks) {
      try {
        await pushInbound(inbox.groupChatId, threadId, chunk.text);
      } catch (e) {
        if (isTopicClosedError(e)) {
          console.warn(`[${inbox.name}] トピックが閉じられています。開き直します: ${conv.name}`);
          await reopenTopic(inbox.groupChatId, threadId);
          await pushInbound(inbox.groupChatId, threadId, chunk.text);
        } else if (isThreadNotFoundError(e)) {
          console.warn(`[${inbox.name}] トピックが削除されています。次回作り直します: ${conv.name}`);
          dbApi.clearTopic(key);
          throw e;
        } else {
          throw e;
        }
      }
      stats.delivered++;
      // チャンク成功ごとに既知化: 途中で失敗しても、送信済みチャンク分を次回に再配信しない
      for (const h of chunk.hashes) dbApi.addSeen(key, h);
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

// 双方向再同期: トピックを開いている顧客を（返信済みで未読巡回から外れていても）定期的に再読し、
// PC直返信・遅延新着を Telegram へ反映する。会員ID検索が要るので batch 件/interval に絞り負荷を抑える。
let lastResyncAt = 0;
const resyncCursor = new Map<string, number>(); // inbox.id -> ラウンドロビン位置

// 再同期の連続失敗バックオフ: L-Pro 側から消えた会員（退会・アカウント削除）はトピックが開いて
// いる限り検索し続けても行が出ず、1回の失敗ごとに会員ID検索＋出現待ち5秒を浪費して resyncMaxMs の
// 壁時計上限を食い潰す（他の顧客の再同期まで遅らせる）うえ、活動ウィンドウを抜けるまで数十分おきに
// エラーログが出続ける（2026-08-12 会員500372で実測6連発）。連続失敗キーは指数的に間隔を空けて
// 再試行し、成功または実活動（未読で再出現・オペレーター返信）で即解除する。メモリ保持で十分
// （再起動時はやり直しになるだけで、失敗がまだ続くなら数回で再びバックオフに入る）。
// 注意2点（アドバーサリアルレビュー反映）:
//  - Telegram 側・ブラウザ喪失のエラーは「会員が消えた」証拠にならないのでストリークに数えない
//    （数えると障害復旧後も配信待ちキーだけが残存バックオフで数十分〜黙って遅れる退行になる）。
//  - 基底はラウンドロビンの実再訪周期（開トピック数百件で実測約80分）より長くないと一度も
//    スキップされず無効。2時間開始なら、バックオフ入り自体に失敗が約80分持続する必要があり、
//    一時的な描画遅延で実在会員が誤って長期休止に入ることも構造的に防げる。
const resyncFailStreak = new Map<string, number>();
const resyncSkipUntil = new Map<string, number>();
const RESYNC_BACKOFF_BASE_MS = 2 * 3_600_000;
const RESYNC_BACKOFF_CAP_MS = 24 * 3_600_000;
function clearResyncBackoff(key: string): void {
  resyncFailStreak.delete(key);
  resyncSkipUntil.delete(key);
}
async function resyncOpenTopics(processedThisCycle: Set<string>): Promise<void> {
  if (cfg.resyncBatch <= 0) return;
  if (Date.now() - lastResyncAt < cfg.resyncIntervalMs) return;
  lastResyncAt = Date.now();
  // 1 tick 全体の壁時計上限。超えたら打ち切って未読巡回の再開を遅らせない（遅れた分は次 tick で継続）
  const deadline = Date.now() + cfg.resyncMaxMs;
  const since = Date.now() - cfg.resyncActiveWindowMs;
  for (const inbox of inboxes) {
    if (shuttingDown || Date.now() > deadline) return;
    // 直近活動のあるトピックだけを直近順に。休眠会話を延々再読しない（負荷とレイテンシを一定に保つ）
    const open = dbApi.listOpenTopics(inbox.groupChatId, since);
    if (open.length === 0) continue;
    const prefix = `${inbox.id}:`;
    let pos = (resyncCursor.get(inbox.id) ?? 0) % open.length;
    let scanned = 0;
    let synced = 0;
    while (scanned < open.length && synced < cfg.resyncBatch) {
      if (shuttingDown || Date.now() > deadline) { resyncCursor.set(inbox.id, pos); return; }
      const key = open[pos].customer_key;
      const name = open[pos].name;
      pos = (pos + 1) % open.length;
      scanned++;
      // 今サイクルの未読巡回で処理済みの顧客は二度読みしない（コスト節約）
      if (processedThisCycle.has(key)) continue;
      // 連続失敗中のキーはバックオフが明けるまで飛ばす（スキップは無コストなので synced に数えない）
      if ((resyncSkipUntil.get(key) ?? 0) > Date.now()) continue;
      const memberId = key.startsWith(prefix) ? key.slice(prefix.length) : key;
      try {
        await runExclusive(() =>
          processConversation(inbox, { memberId, name: name ?? `ID:${memberId}`, unread: false })
        );
        clearResyncBackoff(key);
        synced++; // batch は「実際に再読した件数」で数える（スキップは無コストなので数えない）
      } catch (e) {
        // Telegram 障害・ブラウザ喪失は「会員が消えた」証拠にならない（上位の復旧処理に委ね、
        // ストリークに数えない）。数えると配信待ちを抱えたキーだけが障害復旧後も休止で遅れる
        if (isTelegramError(e) || isBrowserGoneError(e)) {
          console.error(`再同期失敗 [${inbox.name}][${memberId}]:`, String(e).slice(0, 200));
        } else {
          const n = (resyncFailStreak.get(key) ?? 0) + 1;
          resyncFailStreak.set(key, n);
          if (n >= 2) {
            const waitMs = Math.min(RESYNC_BACKOFF_BASE_MS * 2 ** (n - 2), RESYNC_BACKOFF_CAP_MS);
            resyncSkipUntil.set(key, Date.now() + waitMs);
            const dur = waitMs >= 3_600_000 ? `${Math.round(waitMs / 3_600_000)}時間` : `${Math.round(waitMs / 60_000)}分`;
            console.error(
              `再同期失敗 [${inbox.name}][${memberId}] (${n}回連続・以後約${dur}は再同期を休止。退会・削除済み会員の可能性):`,
              String(e).slice(0, 200)
            );
          } else {
            console.error(`再同期失敗 [${inbox.name}][${memberId}]:`, String(e).slice(0, 200));
          }
        }
        synced++; // 失敗も検索コストは発生しているので1件として数える（暴走防止）
      }
    }
    resyncCursor.set(inbox.id, pos);
  }
}

// ── L-Pro対応状況 → トピック名マーカーの同期 ──
// 巡回（未返信のみ検索）の結果から「一覧に居る=🔴未対応 / 不在=✅対応済み」を推定し、
// 変化したトピックだけ名前を書き替える（editForumTopic はグループ管理APIなので、1サイクルの
// 呼び出し数を絞りレート制限を守る。残りは次サイクルに持ち越し=数十秒遅れで追い付く）。
// 対象は db.listMarkerCandidates が絞る（🔴表示中 or 直近活動あり。休眠トピックを掘り返さない）
const MARKER_MAX_PER_CYCLE = 3;
// ✅は連続不在サイクル数がこの値に達してから（一過性の一覧欠けで誤✅にしない。logic.ts 参照）
const MARKER_DONE_AFTER_MISSES = 2;
const markerAbsentStreak = new Map<string, number>();
// 429 を受けたら retry_after の間マーカー同期ごと休む（巡回=配信は止めない）
let markerPauseUntil = 0;
// Telegram経由の返信が成功した時刻。巡回スナップショット（返信前に取得）より新しい返信があるキーは
// 🔴への遷移を捨てる（返信直後の即✅を古いスナップショットが🔴へ戻すフラップの防止）
const lastRepliedAt = new Map<string, number>();
async function syncTopicMarkers(inbox: Inbox, unreadKeys: ReadonlySet<string>, snapshotAt: number): Promise<void> {
  if (Date.now() < markerPauseUntil) return;
  const since = Date.now() - cfg.resyncActiveWindowMs;
  const prefix = `${inbox.id}:`;
  // prefix でも絞る: 2受信箱に同一グループを誤設定しても、他受信箱の顧客を「不在=✅」と
  // 誤判定しない（group_chat_id の絞りだけだと構造的に危険側へ壊れる）
  const candidates = dbApi.listMarkerCandidates(inbox.groupChatId, since)
    .filter((c) => c.key.startsWith(prefix));
  const transitions = decideMarkerTransitions(candidates, unreadKeys, {
    truncated: pollHitLimitFor(inbox.id),
    max: MARKER_MAX_PER_CYCLE,
    doneAfterMisses: MARKER_DONE_AFTER_MISSES,
  }, markerAbsentStreak);
  for (const t of transitions) {
    if (shuttingDown) return;
    // スナップショット取得後に返信済みのキーは、古い「未読」観測による🔴戻しをしない
    if (t.desired === 'pending' && (lastRepliedAt.get(t.key) ?? 0) >= snapshotAt) continue;
    const cust = dbApi.get(t.key);
    if (!cust?.topic_thread_id || !cust.group_chat_id) continue;
    const memberId = t.key.slice(prefix.length);
    try {
      await renameTopic(cust.group_chat_id, cust.topic_thread_id, markerName(t.desired, cust.name, memberId));
      dbApi.setMarker(t.key, t.desired);
      console.log(`対応状況マーカー ${t.desired === 'done' ? '✅' : '🔴'} [${inbox.name}][${memberId}]`);
    } catch (e) {
      if (isThreadNotFoundError(e)) { dbApi.clearTopic(t.key); continue; }
      const pause = retryAfterMs(e);
      if (pause !== null) {
        // レート制限: retry_after の間はマーカー同期だけ休止（巡回と配信は続行）。差分は残るので後で追い付く
        markerPauseUntil = Date.now() + pause;
        console.warn(`マーカー同期を一時停止 [${inbox.name}] (${Math.round(pause / 1000)}秒・レート制限)`);
        return;
      }
      // 恒久エラー1件で後続を飢餓させない（この件は次サイクル以降も候補に残り再試行される）
      console.warn(`マーカー更新失敗 [${inbox.name}][${memberId}]:`, String(e).slice(0, 150));
      continue;
    }
  }
}

async function pollOnce(): Promise<void> {
  let playwrightSuspect = false;
  let cycleConvFailures = 0;
  const processedThisCycle = new Set<string>();

  for (const inbox of inboxes) {
    if (shuttingDown) return;
    let convs: Conversation[];
    let fetchedAt = 0;
    try {
      convs = await runExclusive(() => pollConversations(inbox));
      fetchedAt = Date.now();
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
      const ck = keyOf(inbox, conv.memberId);
      processedThisCycle.add(ck);
      // 未読＝顧客に新着がある＝「実活動」あり。再同期の対象選定（直近活動のあるトピックだけ）に使う
      dbApi.touchActivity(ck);
      // 実活動が確認できた＝消えた会員ではない。再同期バックオフを解除して即時同期に戻す
      clearResyncBackoff(ck);
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
    // L-Pro の対応状況をトピック名の🔴/✅へ同期（一覧取得に成功したサイクルだけ推定が有効）
    if (!shuttingDown) {
      await syncTopicMarkers(
        inbox,
        new Set(convs.filter((c) => c.unread).map((c) => keyOf(inbox, c.memberId))),
        fetchedAt
      );
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
  // 表示上限に達した（未返信が多すぎて古い顧客を取りこぼす可能性）を「未超過→超過」の遷移時だけ通知。
  // 解消後に再超過したらまた通知する（持続超過中のスパムは抑える）
  const nowOverLimit = pollHitLimit();
  if (nowOverLimit && !prevOverLimit) {
    await notifyOps('⚠️ 未返信の一覧が表示上限に達しました。古い未返信顧客を取りこぼす可能性があります。Lpro で未返信を処理してください');
  }
  prevOverLimit = nowOverLimit;
  if (playwrightSuspect) {
    await runExclusive(() => ensureLoggedIn(inboxes[0]));
  }
  // 未読巡回のあとに、開いているトピックの双方向再同期（PC直返信・遅延新着の反映）を回す。内部で
  // interval ゲートされるので毎巡回呼んでも実際に走るのは resyncIntervalMs ごと。
  if (!shuttingDown) await resyncOpenTopics(processedThisCycle);
}
let prevOverLimit = false;

// ── 日次ティック: 定時ハートビート＋DBバックアップ ──
// ブリッジの停止は死んだプロセス自身には通知できない（2026-07-29 のPC再起動でPM2ごと消えた
// 8日間、誰も気付けなかった）。生存側からの定時通知の"欠落"だけが無音死のシグナルになるので、
// 「毎日 DAILY_TICK_HOUR 時に💓が届く」を運用契約にする。
function msUntilNextTick(hour: number): number {
  const now = new Date();
  const next = new Date(now.getFullYear(), now.getMonth(), now.getDate(), hour, 0, 0, 0);
  if (next.getTime() <= now.getTime()) next.setDate(next.getDate() + 1);
  return next.getTime() - now.getTime();
}

async function dailyTick(): Promise<void> {
  let backupNote: string;
  try {
    backupNote = runBackup(cfg.backupRetain)
      ? 'DBバックアップOK'
      : 'DBバックアップOK（本日分は作成済み）';
  } catch (e) {
    console.error('DBバックアップ失敗:', e);
    backupNote = '⚠️ DBバックアップ失敗（ログを確認してください）';
  }
  await notifyOps(
    `💓 定時ハートビート: ブリッジ稼働中（前回から: 巡回 ${stats.polls} 回 / Telegram配信 ${stats.delivered} 通 / ` +
    `Lpro送信 ${stats.sent} 件 / ${backupNote}）。` +
    'この通知が毎日この時刻に届かなくなったら、ブリッジが止まっています。PC と PM2 を確認してください。'
  );
  stats.polls = 0;
  stats.delivered = 0;
  stats.sent = 0;
}

function scheduleDailyTick(): void {
  if (cfg.dailyTickHour < 0 || shuttingDown) return;
  // 毎回「次の該当時刻」を取り直す1発タイマーの連鎖にする（setInterval だと時刻合わせできず、
  // スリープ復帰などで発火時刻がずれても自己補正されない）
  setTimeout(() => {
    void dailyTick()
      .catch((e) => console.error('日次ティック失敗:', e))
      .finally(scheduleDailyTick);
  }, msUntilNextTick(cfg.dailyTickHour));
}

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

  // ログイン失効／復旧を運用グループへ通知する。initBrowser のログイン確認は startBot より前に
  // 走るが、notifyOps は bot.api 経由なので bot 長ポーリング未起動でも送れる（無音クラッシュループの穴を塞ぐ）。
  // 会話本文・顧客名は載せない（notifyOps の規約どおり）。
  setLoginNotifier((e) => {
    if (e === 'waiting') {
      void notifyOps('⚠️ Lpro に未ログインです。ブリッジは受信・返信を止めて手動ログイン待機中です。表示中のブラウザでログイン（2FA含む）してください。');
    } else {
      void notifyOps('✅ Lpro へのログインを確認しました。監視を再開します。');
    }
  });

  await initBrowser();
  await bootstrapAll();

  // Telegram → Lpro（返信）
  setReplyHandler((inboxId, memberId, name, text) => {
    const inbox = inboxById(inboxId);
    if (!inbox) {
      console.error(`返信の受信箱が不明です（inboxId=${inboxId}）。無視します`);
      return;
    }
    // 空白のみの返信は Lpro に送らない（送信検証もできず、誤って成功扱いする穴を塞ぐ）
    if (text.trim() === '') {
      const c0 = dbApi.get(keyOf(inbox, memberId));
      if (c0?.topic_thread_id && c0.group_chat_id) {
        void pushInbound(c0.group_chat_id, c0.topic_thread_id, '⚠️ 空のメッセージは Lpro へ送信できません。').catch(() => {});
      }
      return;
    }
    const key = keyOf(inbox, memberId);
    // 送信前にDBへ控えを残す（クラッシュ/電源断で送信途中に死んでも再起動時に「未送信の可能性」を通知できる）
    const pendingId = dbApi.addPending(key, name, text);
    void runExclusive(() => sendReply(inbox, memberId, text))
      .then(() => {
        dbApi.deletePending(pendingId);
        // この返信は次の読取で自分側吹き出しとして逆流する。二重表示を避けるため控えておく
        recordSentEcho(key, text);
        // オペレーターの返信＝実活動。再同期の対象に含める（PC直返信の反映にも効く）
        dbApi.touchActivity(key);
        clearResyncBackoff(key);
        // 返信送信成功＝L-Pro は返信済みへ遷移した。次の巡回を待たずトピック名を✅にする
        // （失敗しても巡回のマーカー同期が数十秒後に追い付くのでベストエフォート）。
        // 時刻を控え、返信前に取得された巡回スナップショットによる🔴戻しを防ぐ
        lastRepliedAt.set(key, Date.now());
        const c2 = dbApi.get(key);
        if (c2?.topic_thread_id && c2.group_chat_id && c2.tg_marker !== 'done') {
          void renameTopic(c2.group_chat_id, c2.topic_thread_id, markerName('done', c2.name ?? name, memberId))
            .then(() => dbApi.setMarker(key, 'done'))
            .catch((e) => console.warn('返信後のマーカー更新失敗（巡回で再同期されます）:', String(e).slice(0, 120)));
        }
        // 会話本文はログに残さない（PM2 のログは平文でディスクに蓄積されるため）
        console.log(`→ Lpro送信 [${inbox.name}][${name}] (${text.length}字)`);
        stats.sent++;
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

  // 起動直後に当日分のバックアップを確保する（「バックアップ皆無」の期間を作らない）。以後は日次ティック
  try { runBackup(cfg.backupRetain); } catch (e) { console.error('起動時DBバックアップ失敗:', e); }
  scheduleDailyTick();

  // Lpro → Telegram（巡回）
  console.log('巡回開始');
  let consecutiveFailures = 0;
  while (!shuttingDown) {
    try {
      await pollOnce();
      stats.polls++;
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
  // 返信を排水し、ブラウザも閉じてから落ちる。閉じないと chromium が残って永続プロファイルの
  // SingletonLock が残り、次回 launchPersistentContext が失敗して無音の起動失敗ループに陥る
  void Promise.race([
    (async () => { await drainQueue(); try { await closeBrowser(); } catch { /* already gone */ } })(),
    new Promise((r) => setTimeout(r, 8000)),
  ]).finally(() => process.exit(1));
});

// 起動・初期化での致命エラーも無音にしない（ログイン失効は ensureLoggedIn が通知するが、
// ブラウザ起動失敗・ブートストラップ失敗などは startBot より前に main を抜けるためここが最後の砦）。
// これらは <30秒で死ぬと min_uptime を割り、PM2 が max_restarts 到達で永久停止＝完全無音死しうる。
main().catch(async (e) => {
  console.error(e);
  await Promise.race([
    notifyOps('⚠️ ブリッジが起動・初期化に失敗しました（再起動を繰り返している可能性があります）。表示中のブラウザとログを確認してください。'),
    new Promise((r) => setTimeout(r, 8000)),
  ]).catch(() => {});
  process.exit(1);
});
