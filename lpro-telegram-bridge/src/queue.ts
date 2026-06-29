// Playwright は単一ブラウザを共有するので、全操作を直列化して衝突を防ぐ
let chain: Promise<unknown> = Promise.resolve();

export function runExclusive<T>(fn: () => Promise<T>): Promise<T> {
  const next = chain.then(fn, fn);
  chain = next.catch(() => {}); // チェーンには失敗を伝播させない
  return next;
}
