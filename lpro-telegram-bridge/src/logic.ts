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
