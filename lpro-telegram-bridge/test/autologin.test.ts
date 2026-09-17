/**
 * 自動ログイン（src/autologin.ts）のブラウザテスト。
 * Playwright の Chromium で模擬 Lpro（page.route で応答を差し替え）のログイン画面を開き、
 * 「入力して1回だけ送信する」「触ってはいけないページには触らない」「囮リンクを押さない」を実際の DOM 操作で検証する。
 * Chromium が起動できない環境では skip（理由付き）。CI では `npx playwright install chromium` 後に実行される。
 */
import { test, before, after, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { chromium, type Browser, type Page } from 'playwright';
import { attemptAutoLogin, loginFormVisible, type LoginSelectors, type AutoLoginCreds } from '../src/autologin.js';

const SEL: LoginSelectors = { loginPassInput: 'input[type="password"]', loginIdInput: '', loginSubmit: '' };
const CREDS: AutoLoginCreds = { id: 'user1', pass: 'secret-pk' };
const ORIGIN = 'https://lpro.test';
const MARKER = 'nav.opemenu a[href="logout"]';

let browser: Browser | null = null;
let skipReason = '';

before(async () => {
  try {
    browser = await chromium.launch({ headless: true });
  } catch (e1) {
    // ローカル（Claude Code の実行環境など）: バージョン不一致の Chromium でも executablePath 指定なら動く
    const alt = process.env.LPRO_TEST_CHROMIUM || '/opt/pw-browsers/chromium';
    if (existsSync(alt)) {
      try { browser = await chromium.launch({ headless: true, executablePath: alt }); } catch (e2) { skipReason = String(e2).slice(0, 200); }
    } else {
      skipReason = String(e1).slice(0, 200);
    }
  }
});
after(async () => { await browser?.close(); });

// ── 模擬 Lpro ──
const SHELL = '<html><body><nav class="opemenu"><a href="logout">ログアウト</a></nav><p>manage</p></body></html>';
const ERR = '<p class="err">IDまたはパスキーが違います</p>';

type Site = { html: string; frameHtml?: string; loggedIn: boolean; posts: URLSearchParams[]; requests: string[] };
function site(html: string, frameHtml?: string): Site {
  return { html, frameHtml, loggedIn: false, posts: [], requests: [] };
}
async function mount(page: Page, s: Site): Promise<void> {
  await page.route(`${ORIGIN}/**`, async (route) => {
    const req = route.request();
    const path = new URL(req.url()).pathname;
    s.requests.push(`${req.method()} ${path}`);
    const html = (body: string) => route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body });
    if (req.method() === 'POST' && path === '/manage/login') {
      const body = new URLSearchParams(req.postData() ?? '');
      s.posts.push(body);
      if (body.get('id') === CREDS.id && body.get('passkey') === CREDS.pass) {
        s.loggedIn = true;
        return html(SHELL);
      }
      return html(s.html.replace('<!--ERR-->', ERR));
    }
    if (path === '/manage/' || path === '/manage') return html(s.loggedIn ? SHELL : s.html);
    if (path === '/manage/loginframe') return html(s.frameHtml ?? '');
    return html(`<html><body>other ${path}</body></html>`);
  });
}

const FORM_STD = `<html><body><h1>Lpro</h1><!--ERR-->
<form method="post" action="/manage/login">
  <label>ID <input type="text" name="id"></label>
  <label>パスキー <input type="password" name="passkey"></label>
  <input type="submit" value="ログイン">
</form>
<a href="/manage/help">ログインできない方はこちら</a>
</body></html>`;

// テスト本体: ブラウザが無ければ skip。各テストは独立したコンテキストで実行
function browserTest(name: string, fn: (page: Page, t: TestContext) => Promise<void>): void {
  test(name, async (t) => {
    if (!browser) { t.skip(`Chromium を起動できません: ${skipReason}`); return; }
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    try { await fn(page, t); } finally { await ctx.close(); }
  });
}
const posted = (s: Site) => s.posts.map((p) => `${p.get('id')}/${p.get('passkey')}`);

browserTest('資格情報あり: ID/パスキーを入力して送信ボタンを1回押し、ログイン済みになる', async (page) => {
  const s = site(FORM_STD);
  await mount(page, s);
  await page.goto(`${ORIGIN}/manage/`);
  const r = await attemptAutoLogin(page, { creds: CREDS, selectors: SEL });
  assert.equal(r.kind, 'submitted');
  assert.equal(r.kind === 'submitted' && r.filledFrom, 'env');
  assert.equal(r.kind === 'submitted' && r.how, 'click');
  await page.locator(MARKER).first().waitFor({ state: 'visible', timeout: 5_000 });
  assert.deepEqual(posted(s), ['user1/secret-pk']);
  assert.equal(await loginFormVisible(page, SEL.loginPassInput), false);
  // 囮リンク「ログインできない方はこちら」には触っていない
  assert.ok(!s.requests.some((x) => x.includes('/manage/help')), s.requests.join(','));
});

browserTest('資格情報が拒否された: 送信は1回だけ、ログイン画面のまま（失敗を検出できる）', async (page) => {
  const s = site(FORM_STD);
  await mount(page, s);
  await page.goto(`${ORIGIN}/manage/`);
  const r = await attemptAutoLogin(page, { creds: { id: 'user1', pass: 'WRONG' }, selectors: SEL });
  assert.equal(r.kind, 'submitted');
  await page.locator('p.err').waitFor({ state: 'visible', timeout: 5_000 });
  assert.equal(await page.locator(MARKER).count(), 0);
  assert.equal(await loginFormVisible(page, SEL.loginPassInput), true);
  assert.equal(s.posts.length, 1);
});

browserTest('資格情報なし: ブラウザが自動入力済みのフォームは送信ボタンだけ押す（値は書き換えない）', async (page) => {
  const s = site(FORM_STD.replace('name="id"', 'name="id" value="user1"').replace('name="passkey"', 'name="passkey" value="secret-pk"'));
  await mount(page, s);
  await page.goto(`${ORIGIN}/manage/`);
  const r = await attemptAutoLogin(page, { creds: null, selectors: SEL });
  assert.equal(r.kind, 'submitted');
  assert.equal(r.kind === 'submitted' && r.filledFrom, 'prefilled');
  await page.locator(MARKER).first().waitFor({ state: 'visible', timeout: 5_000 });
  assert.deepEqual(posted(s), ['user1/secret-pk']);
});

browserTest('資格情報なし・未入力: 何も触らない（need-input、送信 0 回）', async (page) => {
  const s = site(FORM_STD);
  await mount(page, s);
  await page.goto(`${ORIGIN}/manage/`);
  const r = await attemptAutoLogin(page, { creds: null, selectors: SEL });
  assert.equal(r.kind, 'need-input');
  assert.equal(s.posts.length, 0);
  assert.equal(await page.locator('input[name="id"]').inputValue(), '');
});

browserTest('資格情報なし・パスキーだけ自動入力（ID 空）: 送信しない', async (page) => {
  const s = site(FORM_STD.replace('name="passkey"', 'name="passkey" value="secret-pk"'));
  await mount(page, s);
  await page.goto(`${ORIGIN}/manage/`);
  const r = await attemptAutoLogin(page, { creds: null, selectors: SEL });
  assert.equal(r.kind, 'need-input');
  assert.equal(s.posts.length, 0);
});

browserTest('パスキー欄の無いページ（追加認証など）: no-form で一切触らない', async (page) => {
  const s = site(`<html><body><form method="post" action="/manage/verify"><label>認証コード <input type="text" name="code"></label><button type="submit">認証</button></form></body></html>`);
  await mount(page, s);
  await page.goto(`${ORIGIN}/manage/`);
  const r = await attemptAutoLogin(page, { creds: CREDS, selectors: SEL });
  assert.equal(r.kind, 'no-form');
  assert.equal(await page.locator('input[name="code"]').inputValue(), '');
  assert.deepEqual(s.requests, ['GET /manage/']);
});

browserTest('ログイン済みの画面（パスキー欄なし）: no-form', async (page) => {
  const s = site(FORM_STD);
  s.loggedIn = true;
  await mount(page, s);
  await page.goto(`${ORIGIN}/manage/`);
  const r = await attemptAutoLogin(page, { creds: CREDS, selectors: SEL });
  assert.equal(r.kind, 'no-form');
  assert.equal(await loginFormVisible(page, SEL.loginPassInput), false);
});

browserTest('iframe の中のログインフォームも見つけて送信する', async (page) => {
  const s = site(`<html><body><h1>shell</h1><iframe name="login" src="/manage/loginframe" width="600" height="400"></iframe></body></html>`, FORM_STD);
  await mount(page, s);
  await page.goto(`${ORIGIN}/manage/`);
  await page.frameLocator('iframe[name="login"]').locator('input[type="password"]').waitFor({ state: 'visible', timeout: 5_000 });
  const r = await attemptAutoLogin(page, { creds: CREDS, selectors: SEL });
  assert.equal(r.kind, 'submitted');
  assert.ok(r.kind === 'submitted' && r.detail.includes('iframe'), r.kind === 'submitted' ? r.detail : '');
  await page.waitForFunction(() => true); // 送信の到達を待つ
  await new Promise((res) => setTimeout(res, 300));
  assert.deepEqual(posted(s), ['user1/secret-pk']);
});

browserTest('送信ボタンが無い form: form.requestSubmit() で送信（Enter が効かない2欄フォームでも送れる）', async (page) => {
  const s = site(`<html><body><!--ERR--><form method="post" action="/manage/login"><input type="text" name="id"><input type="password" name="passkey"></form></body></html>`);
  await mount(page, s);
  await page.goto(`${ORIGIN}/manage/`);
  const r = await attemptAutoLogin(page, { creds: CREDS, selectors: SEL });
  assert.equal(r.kind, 'submitted');
  assert.equal(r.kind === 'submitted' && r.how, 'requestSubmit');
  await page.locator(MARKER).first().waitFor({ state: 'visible', timeout: 5_000 });
  assert.deepEqual(posted(s), ['user1/secret-pk']);
});

browserTest('JS 送信のボタン（type=button）を文言で見つけ、囮リンク（忘れた／できない方）は押さない', async (page) => {
  const s = site(`<html><body><!--ERR-->
<form id="f" method="post" action="/manage/login">
  <input type="text" name="id"><input type="password" name="passkey">
  <a href="/manage/forgot">パスキーを忘れた方</a>
  <button type="button" onclick="document.getElementById('f').submit()">ログイン</button>
  <button type="button" onclick="location.href='/manage/register'">新規登録</button>
</form>
<a href="/manage/help">ログインできない方はこちら</a>
</body></html>`);
  await mount(page, s);
  await page.goto(`${ORIGIN}/manage/`);
  const r = await attemptAutoLogin(page, { creds: CREDS, selectors: SEL });
  assert.equal(r.kind, 'submitted');
  assert.equal(r.kind === 'submitted' && r.how, 'click');
  await page.locator(MARKER).first().waitFor({ state: 'visible', timeout: 5_000 });
  assert.deepEqual(posted(s), ['user1/secret-pk']);
  assert.ok(!s.requests.some((x) => /forgot|help|register/.test(x)), s.requests.join(','));
});

browserTest('form の無いページ: 文言が「ログイン」だけのリンクをボタンとして押す（「ログインできない方はこちら」は押さない）', async (page) => {
  const s = site(`<html><body>
<input type="text" id="i"><input type="password" id="p">
<a href="/manage/help">ログインできない方はこちら</a>
<a href="#" id="go" onclick="fetch('/manage/login',{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({id:document.getElementById('i').value,passkey:document.getElementById('p').value})});return false;">ログイン</a>
</body></html>`);
  await mount(page, s);
  await page.goto(`${ORIGIN}/manage/`);
  const r = await attemptAutoLogin(page, { creds: CREDS, selectors: SEL });
  assert.equal(r.kind, 'submitted');
  assert.equal(r.kind === 'submitted' && r.how, 'click');
  await page.waitForResponse((res) => res.url().endsWith('/manage/login'), { timeout: 5_000 });
  assert.deepEqual(posted(s), ['user1/secret-pk']);
  assert.ok(!s.requests.some((x) => x.includes('/manage/help')), s.requests.join(','));
});

browserTest('form もボタンも無いページ: パスキー欄で Enter を押す', async (page) => {
  const s = site(`<html><body>
<input type="text" id="i"><input type="password" id="p"
 onkeydown="if(event.key==='Enter'){fetch('/manage/login',{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({id:document.getElementById('i').value,passkey:this.value})})}">
</body></html>`);
  await mount(page, s);
  await page.goto(`${ORIGIN}/manage/`);
  const r = await attemptAutoLogin(page, { creds: CREDS, selectors: SEL });
  assert.equal(r.kind, 'submitted');
  assert.equal(r.kind === 'submitted' && r.how, 'enter');
  await page.waitForResponse((res) => res.url().endsWith('/manage/login'), { timeout: 5_000 });
  assert.deepEqual(posted(s), ['user1/secret-pk']);
});

browserTest('ID 欄の自動判定: パスキー欄の直前のテキスト入力を選ぶ（hidden・後ろの検索欄・別 form は無視）', async (page) => {
  const s = site(`<html><body><!--ERR-->
<form method="get" action="/manage/search"><input type="text" name="q" placeholder="検索"></form>
<form method="post" action="/manage/login">
  <input type="hidden" name="csrf" value="tok">
  <input type="text" name="site" placeholder="サイト名">
  <input type="text" name="id">
  <input type="password" name="passkey">
  <input type="text" name="memo" placeholder="後ろの欄">
  <input type="submit" value="ログイン">
</form></body></html>`);
  await mount(page, s);
  await page.goto(`${ORIGIN}/manage/`);
  const r = await attemptAutoLogin(page, { creds: CREDS, selectors: SEL });
  assert.equal(r.kind, 'submitted');
  await page.locator(MARKER).first().waitFor({ state: 'visible', timeout: 5_000 });
  const body = s.posts[0]!;
  assert.equal(body.get('id'), 'user1');
  assert.equal(body.get('site'), '');
  assert.equal(body.get('memo'), '');
  assert.equal(body.get('csrf'), 'tok');
});

browserTest('明示セレクタ（loginIdInput / loginSubmit）が自動判定より優先される', async (page) => {
  const s = site(`<html><body><!--ERR-->
<form id="f" method="post" action="/manage/login">
  <input type="text" name="decoy">
  <input type="text" name="id" id="uid">
  <input type="password" name="passkey">
  <button type="button" id="cancel" onclick="location.href='/manage/cancel'">キャンセル</button>
  <button type="button" id="go" onclick="document.getElementById('f').submit()">OK</button>
</form></body></html>`);
  await mount(page, s);
  await page.goto(`${ORIGIN}/manage/`);
  // 自動判定だと decoy ではなく id（直前のテキスト欄）だが、ボタンは文言に合致するものが無い → 明示指定で確定させる
  const r = await attemptAutoLogin(page, { creds: CREDS, selectors: { ...SEL, loginIdInput: '#uid', loginSubmit: '#go' } });
  assert.equal(r.kind, 'submitted');
  await page.locator(MARKER).first().waitFor({ state: 'visible', timeout: 5_000 });
  assert.deepEqual(posted(s), ['user1/secret-pk']);
  assert.equal(s.posts[0]!.get('decoy'), '');
  assert.ok(!s.requests.some((x) => x.includes('/manage/cancel')));
});

browserTest('ID 欄が無いフォーム（ID を覚えている画面）: パスキーだけ入力して送信する', async (page) => {
  const s = site(`<html><body><!--ERR--><form method="post" action="/manage/login"><input type="hidden" name="id" value="user1"><input type="password" name="passkey"><button>ログイン</button></form></body></html>`);
  await mount(page, s);
  await page.goto(`${ORIGIN}/manage/`);
  const logs: string[] = [];
  const r = await attemptAutoLogin(page, { creds: CREDS, selectors: SEL, log: (m) => logs.push(m) });
  assert.equal(r.kind, 'submitted');
  await page.locator(MARKER).first().waitFor({ state: 'visible', timeout: 5_000 });
  assert.deepEqual(posted(s), ['user1/secret-pk']);
  assert.ok(logs.some((m) => m.includes('ID 欄が見つからない')), logs.join('|'));
});

browserTest('複数回呼んでも目印属性が前回の要素に残らない（同じ結果を再現できる）', async (page) => {
  const s = site(FORM_STD);
  await mount(page, s);
  await page.goto(`${ORIGIN}/manage/`);
  // 1回目は need-input（触らない）、2回目は資格情報あり → 同じ要素を正しく選び直す
  const r1 = await attemptAutoLogin(page, { creds: null, selectors: SEL });
  assert.equal(r1.kind, 'need-input');
  const r2 = await attemptAutoLogin(page, { creds: CREDS, selectors: SEL });
  assert.equal(r2.kind, 'submitted');
  await page.locator(MARKER).first().waitFor({ state: 'visible', timeout: 5_000 });
  assert.deepEqual(posted(s), ['user1/secret-pk']);
});
