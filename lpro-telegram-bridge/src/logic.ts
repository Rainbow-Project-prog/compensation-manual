/**
 * 新着配信の判定ロジック（Lpro/Telegram に依存しない純関数）。
 * index.ts のループから切り出してテスト可能にしている。
 *
 * - bootstrapped=0（初回）: 既存履歴は配らず、現在件数を既読として記録するだけ。
 * - bootstrapped=1（2回目以降）: seen_count を超えた分だけ配信。
 *   件数が増減していれば seen を更新（同数なら更新不要）。
 */
export type SeenState = { bootstrapped: number; seen_count: number };

export type DeliveryDecision<T> = {
  /** Telegram へ配信するメッセージ（初回は常に空） */
  deliver: T[];
  /** seen_count を更新する場合の新しい値。更新不要なら null */
  newSeen: number | null;
  /** 初回ブートストラップとして処理したか */
  bootstrap: boolean;
};

export function decideDelivery<T>(state: SeenState, inbound: T[]): DeliveryDecision<T> {
  if (!state.bootstrapped) {
    // 既存履歴は配らずに既読扱い（過去ログのスパム防止）
    return { deliver: [], newSeen: inbound.length, bootstrap: true };
  }
  const fresh = inbound.slice(state.seen_count);
  const newSeen = inbound.length !== state.seen_count ? inbound.length : null;
  return { deliver: fresh, newSeen, bootstrap: false };
}
