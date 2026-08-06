/**
 * 新着配信の判定ロジック（Lpro/Telegram に依存しない純関数）。
 *
 * 2026-07-11 実機DOM確定に伴い、件数ベース（seen_count 比較）から
 * ★フィンガープリント方式★（メッセージごとのハッシュ既知判定）へ移行した。
 * - Lpro の会話履歴は行内に「直近数件」しか表示されない（窓）ため、件数比較は
 *   「同数入れ替わり」で新着を取りこぼす原理的欠陥があった（事前レビュー [1][22]）。
 * - ハッシュ（会員ID+日時+本文+同文連番。lpro-adapter が生成）の未知分だけを配信する
 *   方式なら、窓がどれだけずれても「新着は必ず窓の末尾に現れる」性質だけで正しく動く。
 *
 * - bootstrapped=false（初遭遇）: 窓内の全メッセージを既知化する前提で、
 *   末尾 bootstrapTail 件だけ配信対象にする（0なら配らない。起動時一括ブートストラップ用）。
 * - bootstrapped=true: 未知ハッシュのメッセージだけを表示順のまま配信対象にする。
 *
 * 既知化（addSeen）のタイミングは呼び出し側（index.ts）の責務:
 * 配信1件成功ごとに既知化することで、途中失敗しても再配信・取りこぼしが起きない。
 */
export type FpMsg = { text: string; hash: string };

// 配信判定はハッシュだけで行うので、self ラベル等の追加フィールドを持つメッセージでも
// そのまま（型を保ったまま）通せるようジェネリックにする。
export function decideDeliveryBySeen<T extends { hash: string }>(
  bootstrapped: boolean,
  inbound: T[],
  hasSeen: (hash: string) => boolean,
  opts: { bootstrapTail?: number } = {}
): { deliver: T[]; bootstrap: boolean } {
  if (!bootstrapped) {
    const tail = Math.max(0, Math.floor(opts.bootstrapTail ?? 0));
    return { deliver: tail > 0 ? inbound.slice(-tail) : [], bootstrap: true };
  }
  return { deliver: inbound.filter((m) => !hasSeen(m.hash)), bootstrap: false };
}

/**
 * 配信メッセージ列を「1通の Telegram メッセージに連結するチャンク」に詰める（429対策）。
 * 新規顧客の履歴一括配信（実測中央値41通）を1件1通で送ると Telegram のレート制限(429)を
 * 連発する（2026-07-26 解析: 429 の85%がこの経路）ため、minBatch 件以上まとまっている場合
 * だけ連結して通数を減らす。通常の新着（数件）は従来どおり1件1通＝見た目を変えない。
 *
 * 各チャンクの text は format 済み本文を sep で連結したもの。hashes はそのチャンクに
 * 入ったメッセージのハッシュ列で、チャンク送信成功ごとにまとめて既知化するのは
 * 呼び出し側（index.ts）の責務（途中失敗しても送信済みチャンク分は再配信されない）。
 * 1件で maxChars を超えるメッセージは単独チャンクにする（送信時の4096字分割は pushInbound が行う）。
 */
export function packDeliveryChunks<T extends { hash: string }>(
  messages: T[],
  format: (m: T) => string,
  opts: { minBatch?: number; maxChars?: number; sep?: string } = {}
): Array<{ text: string; hashes: string[] }> {
  const minBatch = opts.minBatch ?? 6;
  const maxChars = opts.maxChars ?? 3500;
  const sep = opts.sep ?? '\n\n';
  if (messages.length < minBatch) {
    return messages.map((m) => ({ text: format(m), hashes: [m.hash] }));
  }
  const chunks: Array<{ text: string; hashes: string[] }> = [];
  let curText = '';
  let curHashes: string[] = [];
  for (const m of messages) {
    const t = format(m);
    if (curHashes.length > 0 && curText.length + sep.length + t.length > maxChars) {
      chunks.push({ text: curText, hashes: curHashes });
      curText = '';
      curHashes = [];
    }
    curText = curHashes.length === 0 ? t : curText + sep + t;
    curHashes.push(m.hash);
  }
  if (curHashes.length > 0) chunks.push({ text: curText, hashes: curHashes });
  return chunks;
}

// ── フィンガープリント生成（純関数。Lpro/Telegram 非依存なのでここで単体テストする）──
import { createHash } from 'node:crypto';

/** 生スキャン1件（lpro-adapter が行の DOM から抽出）。inbound=true は顧客側（.mb_M.left）。 */
export type ScanMsg = { inbound: boolean; text: string; dt: string; hasImage: boolean };
/** フィンガープリント付き会話メッセージ。self=true は自分側（オペレーター/自動応答）の発言。 */
export type ConvMsg = { text: string; hash: string; self: boolean };

/**
 * 生スキャン（実DOMは新→旧順）→ フィンガープリント付き会話メッセージ（時系列昇順）。
 * ★顧客側(inbound)のハッシュ式は従来と完全に同一に保つ：既存の seen 台帳と一致させ、
 *   本機能アップグレードで顧客メッセージが一斉再配信されるのを防ぐため（誤配信/スパム防止の要）。
 *   自分側(self)は "out" を挟んだ別式にし、顧客と同一日時・同一本文でも衝突させない。
 * 同一式のメッセージが複数（同文連投）なら :連番 を付けて別メッセージ扱いにする。
 */
export function toConvMessages(inboxId: string, memberId: string, scans: ScanMsg[]): ConvMsg[] {
  const res: ConvMsg[] = [];
  const dup = new Map<string, number>();
  for (const m of [...scans].reverse()) {
    const self = !m.inbound;
    const text = m.text || (m.hasImage ? '[画像/スタンプ]（本文なし。Lproで確認してください）' : '');
    if (!text) continue;
    const material = self
      ? `${inboxId}|${memberId}|out|${m.dt}|${text}`
      : `${inboxId}|${memberId}|${m.dt}|${text}`;
    const base = createHash('sha1').update(material).digest('hex');
    const n = dup.get(base) ?? 0;
    dup.set(base, n + 1);
    res.push({ text, hash: n === 0 ? base : `${base}:${n}`, self });
  }
  return res;
}
