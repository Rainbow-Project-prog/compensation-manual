import { Bot, GrammyError, HttpError } from 'grammy';
import { cfg, inboxes, inboxByGroup } from './config.js';
import { dbApi } from './db.js';

export const bot = new Bot(cfg.telegramToken);

// ハンドラ内の例外でポーリングが止まらないようにする（既定は停止＋rethrow）
bot.catch((err) => {
  console.error('Telegram ハンドラでエラー（処理は継続します）:', err.error ?? err);
});

// 有効な受信箱グループの集合（このグループ以外からのメッセージは無視）
const KNOWN_GROUPS = new Set(inboxes.map((i) => i.groupChatId));

type ReplyHandler = (inboxId: string, memberId: string, name: string, text: string) => void;
let onReply: ReplyHandler = () => {};
export function setReplyHandler(h: ReplyHandler) { onReply = h; }

type DigHandler = (inboxId: string, memberId: string) => Promise<{ ok: boolean; name?: string; error?: string }>;
let onDig: DigHandler = async () => ({ ok: false, error: 'ブリッジ準備中です' });
export function setDigHandler(h: DigHandler) { onDig = h; }

const MAX_WAIT_MS = 60_000;

/**
 * 一時的なエラー（429/5xx/ネットワーク）だけ指数バックオフで再試行。
 * createForumTopic のような「成功したのに応答が届かなかった」可能性のある非冪等APIは
 * retryOnHttpError=false でネットワーク断の再試行を止める（重複作成防止）。
 */
async function withRetry<T>(
  label: string,
  fn: () => Promise<T>,
  opts: { tries?: number; retryOnHttpError?: boolean; retryOn5xx?: boolean } = {}
): Promise<T> {
  const tries = opts.tries ?? 3;
  const retryOnHttpError = opts.retryOnHttpError ?? true;
  const retryOn5xx = opts.retryOn5xx ?? true;
  let lastErr: unknown;
  for (let i = 0; i < tries; i++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      const transient =
        (e instanceof HttpError && retryOnHttpError) ||
        (e instanceof GrammyError && (e.error_code === 429 || (e.error_code >= 500 && retryOn5xx)));
      if (!transient || i === tries - 1) throw e;
      const retryAfter = e instanceof GrammyError ? e.parameters?.retry_after : undefined;
      const waitMs = Math.min(retryAfter ? retryAfter * 1000 : 1000 * 2 ** i, MAX_WAIT_MS);
      console.warn(`Telegram ${label} 一時エラー、${waitMs}ms後に再試行 (${i + 1}/${tries}): ${String(e).slice(0, 120)}`);
      await new Promise((r) => setTimeout(r, waitMs));
    }
  }
  throw lastErr;
}

/** 顧客ごとのトピックを確保（無ければ作成）。配信直前にだけ呼ぶ（空トピックの量産防止）。
 * トピックは受信箱ごとのグループ（groupChatId）に作る。 */
export async function ensureTopic(customerKey: string, name: string, groupChatId: number): Promise<number> {
  const existing = dbApi.get(customerKey);
  if (existing?.topic_thread_id) return existing.topic_thread_id;
  let topic;
  try {
    topic = await withRetry(
      'createForumTopic',
      () => bot.api.createForumTopic(groupChatId, name || customerKey),
      // 非冪等: ネットワーク断（HttpError）もコミット後 5xx 応答も再試行すると重複トピックを生む
      { retryOnHttpError: false, retryOn5xx: false }
    );
  } catch (e) {
    if (e instanceof GrammyError && e.error_code === 400) {
      throw new Error(
        'トピック作成に失敗。次を確認してください: ' +
        '(1) グループの Topics が ON か (2) bot が管理者で「トピックの管理(Manage Topics)」権限を持つか ' +
        `(3) GROUP_CHAT_ID が正しいか。詳細: ${e.description}`,
        { cause: e } // isTelegramError が cause を見て Playwright 再ログインの誤発動を防ぐ
      );
    }
    throw e;
  }
  // 作成→DB永続化の間のクラッシュで生まれる孤児トピックを診断できるよう、必ずログに残す
  console.log(`トピック作成: group=${groupChatId} thread=${topic.message_thread_id} key=${customerKey}`);
  dbApi.setTopic(customerKey, topic.message_thread_id, groupChatId);
  return topic.message_thread_id;
}

/** 顧客の発言を該当トピックへ（4096字制限があるため分割送信）。
 * 意図的な非対称: sendMessage はネットワーク断/5xx でも再試行する（応答喪失時は同一メッセージが
 * トピックに二重表示され得るが、表示重複は消失より害が小さい）。createForumTopic は逆に
 * 再試行しない（重複トピック＝返信喪失の温床になるため）。 */
export async function pushInbound(groupChatId: number, threadId: number, text: string): Promise<void> {
  if (!text) return; // 空文字は Telegram が 400 で拒否する
  const CHUNK = 4000;
  let i = 0;
  while (i < text.length) {
    let end = Math.min(i + CHUNK, text.length);
    // サロゲートペア（絵文字等）を境界で割ると文字化け・最悪 400 になるため1つ手前で切る
    const c = text.charCodeAt(end - 1);
    if (end < text.length && c >= 0xd800 && c <= 0xdbff) end--;
    const part = text.slice(i, end);
    await withRetry('sendMessage', () =>
      bot.api.sendMessage(groupChatId, part, { message_thread_id: threadId }));
    i = end;
  }
}

/** 運用通知。会話本文・顧客名は載せないこと。全受信箱グループへ送る（どこを見ていても気付ける） */
export async function notifyOps(text: string): Promise<void> {
  for (const inbox of inboxes) {
    await bot.api.sendMessage(inbox.groupChatId, text)
      .catch((e) => console.error('運用通知の送信失敗:', String(e).slice(0, 120)));
  }
}

/** 閉じられたトピックを開き直す（顧客の新着は流し続ける必要があるため） */
export async function reopenTopic(groupChatId: number, threadId: number): Promise<void> {
  await withRetry('reopenForumTopic', () =>
    bot.api.reopenForumTopic(groupChatId, threadId));
}

/** このエラーは「トピックが削除済み」か（紐付けを外して作り直すべきか） */
export function isThreadNotFoundError(e: unknown): boolean {
  return e instanceof GrammyError && e.error_code === 400 && /thread not found/i.test(e.description);
}

/** このエラーは「トピックが閉じられている」か（reopen すべきか） */
export function isTopicClosedError(e: unknown): boolean {
  return e instanceof GrammyError && e.error_code === 400 && /TOPIC_CLOSED/i.test(e.description);
}

/** Telegram 起因のエラーか（Playwright 側の再ログイン処理を誤発動させない判定用）。
 * ensureTopic のように分かりやすいメッセージへ包み直したエラーは cause で判定する */
export function isTelegramError(e: unknown): boolean {
  if (e instanceof GrammyError || e instanceof HttpError) return true;
  const cause = (e as { cause?: unknown } | null | undefined)?.cause;
  return cause instanceof GrammyError || cause instanceof HttpError;
}

/** customer_key = "inbox:memberId" を分解する */
function splitKey(key: string): { inboxId: string; memberId: string } {
  const idx = key.indexOf(':');
  return idx < 0
    ? { inboxId: '', memberId: key }
    : { inboxId: key.slice(0, idx), memberId: key.slice(idx + 1) };
}

/**
 * 掘り起こし: /dig <会員ID> を対象グループで送ると、その受信箱で会員を開いてトピックを用意する。
 * ★ message:text ハンドラより前に登録すること（コマンドをここで消費し、返信として Lpro へ送らせない）。
 * 受信箱はコマンドを送ったグループから自動判別する。時間のかかる会員ID検索でポーリングを塞がない
 * よう、受付だけ即返しして本処理はバックグラウンドで走らせ、完了時に結果を返信する。
 */
bot.command('dig', async (ctx) => {
  if (!KNOWN_GROUPS.has(ctx.chat.id)) return; // 監視対象グループ以外は無視（＝コマンドも消費して黙る）
  const threadId = ctx.message?.message_thread_id;
  const replyOpts = threadId ? { message_thread_id: threadId } : {};
  const say = (t: string) => ctx.reply(t, replyOpts).catch(() => {});
  const inbox = inboxByGroup(ctx.chat.id);
  if (!inbox) { await say('⚠️ このグループは監視対象の受信箱に紐付いていません。'); return; }
  const memberId = (ctx.match ?? '').trim();
  if (!/^\d+$/.test(memberId)) {
    await say('使い方: /dig <会員ID>（数字）。例: /dig 510654');
    return;
  }
  await say(`🔎 会員ID ${memberId} を「${inbox.name}」で開いています…`);
  void onDig(inbox.id, memberId)
    .then((res) => res.ok
      ? say(`✅ ${res.name ?? memberId} のトピックを用意しました。トピック一覧から開いて返信すると掘り起こしメッセージが送れます。`)
      : say(`⚠️ 開けませんでした: ${res.error ?? '不明なエラー'}`))
    .catch((e) => say(`⚠️ 掘り起こしでエラー: ${String(e).slice(0, 150)}`));
});

/** 人が打った返信を拾う（トピック内のテキストのみ） */
bot.on('message:text', async (ctx) => {
  const msg = ctx.message;
  if (!KNOWN_GROUPS.has(ctx.chat.id)) return; // 監視対象グループ以外は無視
  const threadId = msg.message_thread_id;
  if (!threadId || !msg.is_topic_message) return; // General等は無視
  const cust = dbApi.byThread(ctx.chat.id, threadId);
  if (!cust) {
    // 黙って捨てると「送ったつもり」事故になるため必ずフィードバックする
    await ctx.reply(
      '⚠️ このトピックはどの顧客にも紐付いていないため、Lpro へは送信されません。' +
      '（ブリッジが作成したトピックでのみ返信できます）',
      { message_thread_id: threadId }
    ).catch(() => {});
    return;
  }
  const { inboxId, memberId } = splitKey(cust.customer_key);
  onReply(inboxId, memberId, cust.name ?? memberId, msg.text);
});

/** 返信の「編集」は Lpro に反映されない（気付かず顧客に届いたと誤認する事故を防ぐ） */
bot.on('edited_message', async (ctx) => {
  const msg = ctx.editedMessage;
  if (!KNOWN_GROUPS.has(ctx.chat.id)) return;
  const threadId = msg.message_thread_id;
  if (!threadId || !msg.is_topic_message) return;
  if (!dbApi.byThread(ctx.chat.id, threadId)) return;
  await ctx.reply(
    '⚠️ メッセージの編集は Lpro へ反映されません。修正内容を新しいメッセージとして送ってください。',
    { message_thread_id: threadId }
  ).catch(() => {});
});

/**
 * オペレータが「送ったつもり」になり得る非テキストコンテンツの種別。
 * サービスメッセージ（ピン留め・トピック開閉・メンバー変動等）を除外するため、
 * 拒否リストではなくコンテンツの許可リストで判定する（新種の未知コンテンツは
 * 警告されず黙殺されるが、サービス操作への誤警告よりは安全側）。
 */
const NON_TEXT_CONTENT_KEYS = [
  'photo', 'sticker', 'document', 'voice', 'audio', 'video', 'video_note',
  'animation', 'location', 'contact', 'venue', 'poll', 'dice', 'story', 'game',
  'invoice', 'paid_media',
] as const;

/**
 * テキスト以外（写真・スタンプ・位置情報など）は Lpro へ送れないことを知らせる。
 * 型ごとのハンドラ列挙では取り残しが黙殺されるため catch-all で拾う
 * （テキストは先に登録済みの message:text ハンドラが消費するのでここへ来ない）。
 */
bot.on('message', async (ctx) => {
  const msg = ctx.message;
  if (!KNOWN_GROUPS.has(ctx.chat.id)) return;
  const threadId = msg.message_thread_id;
  if (!threadId || !msg.is_topic_message) return;
  const rec = msg as unknown as Record<string, unknown>;
  if (!NON_TEXT_CONTENT_KEYS.some((k) => rec[k] !== undefined)) return;
  const note = dbApi.byThread(ctx.chat.id, threadId)
    ? (msg.caption
        ? '⚠️ 画像・ファイル等は Lpro へ送信できません（キャプションも送られません）。テキストとして送り直してください。'
        : '⚠️ 画像・スタンプ等は Lpro へ送信できません（テキストのみ対応）。')
    : '⚠️ このトピックはどの顧客にも紐付いていないため、Lpro へは送信されません。';
  await ctx.reply(note, { message_thread_id: threadId }).catch(() => {});
});

/**
 * long polling を開始。ポーリングが致命的エラーで停止した場合（401 トークン失効、
 * 409 別プロセスと競合 等）は onFatal に通知する（黙って半死に状態になるのを防ぐ）。
 */
export async function startBot(onFatal?: (e: unknown) => void): Promise<void> {
  await bot.api.deleteWebhook().catch(() => {});
  bot.start({ onStart: () => console.log('Telegram bot started (long polling)') })
    .catch((e) => {
      console.error('Telegram long polling が停止しました:', e);
      console.error('よくある原因: (1) npm run chatid や別の npm start が同時起動して 409 Conflict (2) トークン失効で 401');
      onFatal?.(e);
    });
}

/** 終了時に呼ぶ。long polling を停止する */
export async function stopBot(): Promise<void> {
  await bot.stop();
}
