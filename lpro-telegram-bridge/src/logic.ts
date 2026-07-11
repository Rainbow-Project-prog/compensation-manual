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

export type FpDecision = {
  /** Telegram へ配信するメッセージ（表示順） */
  deliver: FpMsg[];
  /** 初回ブートストラップとして処理したか */
  bootstrap: boolean;
};

export function decideDeliveryBySeen(
  bootstrapped: boolean,
  inbound: FpMsg[],
  hasSeen: (hash: string) => boolean,
  opts: { bootstrapTail?: number } = {}
): FpDecision {
  if (!bootstrapped) {
    const tail = Math.max(0, Math.floor(opts.bootstrapTail ?? 0));
    return { deliver: tail > 0 ? inbound.slice(-tail) : [], bootstrap: true };
  }
  return { deliver: inbound.filter((m) => !hasSeen(m.hash)), bootstrap: false };
}
