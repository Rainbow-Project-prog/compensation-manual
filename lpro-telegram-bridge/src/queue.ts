// Playwright は単一ブラウザを共有するので、全操作を直列化して衝突を防ぐ
let chain: Promise<unknown> = Promise.resolve();

export function runExclusive<T>(fn: () => Promise<T>): Promise<T> {
  const next = chain.then(fn, fn);
  chain = next.catch(() => {}); // チェーンには失敗を伝播させない
  return next;
}

/**
 * 終了処理用: 呼び出し時点で実行中・待機中の操作が終わるまで待つ（結果・失敗は無視）。
 * これを待たずに閉じると、実行中の返信送信が途中で打ち切られて無音で失われる。
 */
export function drainQueue(): Promise<void> {
  return chain.then(() => undefined, () => undefined);
}
