/**
 * 新着配信の判定ロジック（Lpro/Telegram に依存しない純関数）。
 * index.ts のループから切り出してテスト可能にしている。
 *
 * - bootstrapped=0（初回）:
 *     opts.bootstrapTail = 0 … 何も配らず現在件数を既読として記録（起動時の一括ブートストラップ用。
 *                              過去ログのスパム防止）
 *     opts.bootstrapTail = K … 末尾K件だけ配って既読を確定（稼働中に初めて現れた=いま送ってきた
 *                              顧客の初回メッセージを取りこぼさないため）
 * - bootstrapped=1（2回目以降）: seen_count を超えた分だけ配信。
 * - inbound.length < seen_count のとき: 部分レンダリング（仮想化・読み込み失敗）とみなし、
 *   このサイクルは配信も既読補正もしない。既読を下方修正すると、次の正常サイクルで
 *   旧メッセージを大量再配信してしまうため（事前レビュー確定指摘）。
 *
 * 既知の限界: 件数ベースのため「同じ間隔で1件消えて1件増えた」等の同数入れ替わりは検知できない。
 * Lpro のメッセージ要素に一意IDがあればフィンガープリント方式に移行する（FABLE5_HANDOFF.md 参照）。
 */
export type SeenState = { bootstrapped: number; seen_count: number };

export type DeliveryDecision<T> = {
  /** Telegram へ配信するメッセージ */
  deliver: T[];
  /** seen_count を更新する場合の新しい値。更新不要なら null */
  newSeen: number | null;
  /** 初回ブートストラップとして処理したか */
  bootstrap: boolean;
};

export function decideDelivery<T>(
  state: SeenState,
  inbound: T[],
  opts: { bootstrapTail?: number } = {}
): DeliveryDecision<T> {
  if (!state.bootstrapped) {
    const tail = Math.max(0, Math.floor(opts.bootstrapTail ?? 0));
    const deliver = tail > 0 ? inbound.slice(-tail) : [];
    return { deliver, newSeen: inbound.length, bootstrap: true };
  }
  if (inbound.length < state.seen_count) {
    return { deliver: [], newSeen: null, bootstrap: false };
  }
  const fresh = inbound.slice(state.seen_count);
  const newSeen = inbound.length !== state.seen_count ? inbound.length : null;
  return { deliver: fresh, newSeen, bootstrap: false };
}
