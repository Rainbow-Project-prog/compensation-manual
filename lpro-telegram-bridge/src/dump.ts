/**
 * 実DOM収集ツール（SELECTORS 確定用の1回きり診断。`npm run dump`）。
 * ブラウザが開くので Lpro にログインし、トーク応対（ダイレクトトーク）画面を表示するだけでよい。
 * トーク画面の要素（.btn_send 等）をどこかのフレームで検知したら、全フレームの HTML を
 * dump/ に保存して終了する。
 * ※ dump/ は顧客情報を含むため .gitignore 済み。リポジトリに入れない・外部に送らないこと。
 */
import { chromium, type Frame } from 'playwright';
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { cfg } from './config.js';

const OUT = fileURLToPath(new URL('../dump', import.meta.url));
// 事前に判明している「トーク画面にしか無い」目印（担当者提供の断片より）
const MARKER = '.btn_send, form[action*="linechat_message"], .mmsg_member, .mmsg_char';

const ctx = await chromium.launchPersistentContext(cfg.userDataDir, {
  headless: false,
  viewport: { width: 1400, height: 950 },
});
const page = ctx.pages()[0] ?? (await ctx.newPage());
await page.goto(cfg.loginUrl, { waitUntil: 'domcontentloaded' }).catch(() => {});
console.log('ブラウザで Lpro にログインし、トーク応対（ダイレクトトーク）画面を開いてください。');
console.log('トーク画面を検知すると自動で画面構造を dump/ に保存して終了します（最大20分待機）…');

const deadline = Date.now() + 20 * 60_000;
let found = false;
while (Date.now() < deadline && !found) {
  for (const f of page.frames()) {
    const n = await f.locator(MARKER).count().catch(() => 0);
    if (n > 0) {
      found = true;
      break;
    }
  }
  if (!found) await page.waitForTimeout(4000);
}
if (!found) {
  console.error('20分以内にトーク画面を検知できませんでした。もう一度 npm run dump を実行してください。');
  await ctx.close();
  process.exit(1);
}

console.log('トーク画面を検知しました。レンダリング完了を待っています…');
await page.waitForTimeout(5000);
mkdirSync(OUT, { recursive: true });
const frames = page.frames();
const meta: Array<{ index: number; name: string; url: string; parent: number }> = [];
for (let i = 0; i < frames.length; i++) {
  const f: Frame = frames[i];
  const p = f.parentFrame();
  meta.push({ index: i, name: f.name(), url: f.url(), parent: p ? frames.indexOf(p) : -1 });
  const html = await f.content().catch((e) => `<!-- content() 失敗: ${String(e).slice(0, 200)} -->`);
  writeFileSync(join(OUT, `frame-${i}.html`), html);
}
writeFileSync(join(OUT, 'frames.json'), JSON.stringify(meta, null, 2));
console.log(`保存完了: dump/frame-0〜${frames.length - 1}.html（構成は dump/frames.json）`);
console.log('※ 顧客情報を含むため dump/ の中身は外部に送らないでください。ブラウザを閉じます。');
await ctx.close();
