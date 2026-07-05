import { chromium, type BrowserContext, type Page } from 'playwright';
import { cfg, SELECTORS } from './config.js';

export type Conversation = { customerKey: string; name: string; unread: boolean };
export type InboundMsg = { text: string };

let ctx: BrowserContext | null = null;
let page: Page | null = null;

const warned = new Set<string>();
function warnOnce(key: string, msg: string): void {
  if (warned.has(key)) return;
  warned.add(key);
  console.warn(msg);
}

function clean(s: string | null | undefined): string {
  return (s ?? '').trim().replace(/\s+/g, ' ');
}

export async function initBrowser(): Promise<void> {
  // 再初期化（クラッシュ復旧）に備えて既存コンテキストは先に閉じる
  if (ctx) await closeBrowser();
  ctx = await chromium.launchPersistentContext(cfg.userDataDir, {
    headless: cfg.headless,
    viewport: { width: 1280, height: 900 },
  });
  page = ctx.pages()[0] ?? (await ctx.newPage());
  await ensureLoggedIn();
}

/** 終了時に呼ぶ。ブラウザ（永続コンテキスト）を閉じる */
export async function closeBrowser(): Promise<void> {
  try { await ctx?.close(); } catch { /* already closed */ }
  ctx = null;
  page = null;
}

/** ブラウザ/ページが閉じられた系のエラーか（復旧判定用） */
export function isBrowserGoneError(e: unknown): boolean {
  const m = String(e);
  return /Target (page|context|browser).*closed|browser has been closed|context.*closed|Target closed/i.test(m);
}

export async function ensureLoggedIn(): Promise<void> {
  if (SELECTORS.loggedInMarker === 'TODO') {
    throw new Error(
      'SELECTORS.loggedInMarker が未設定です。先に Lpro のトーク応対画面を F12 で調べて ' +
      'src/config.ts の SELECTORS を埋めてください（npm run doctor で確認できます）'
    );
  }
  const p = page!;
  await p.goto(cfg.talkUrl, { waitUntil: 'domcontentloaded' });
  const marker = p.locator(SELECTORS.loggedInMarker).first();
  const ok = (await marker.count()) > 0 && (await marker.isVisible().catch(() => false));
  if (!ok) {
    if (cfg.headless) {
      throw new Error(
        '未ログインですが HEADLESS=true のため手動ログインできません。' +
        '.env で HEADLESS=false にして `npm run login` を実行してください'
      );
    }
    console.log('未ログインの可能性。表示中のブラウザでログイン（2FA含む）してください。最大5分待機…');
    await p.goto(cfg.loginUrl, { waitUntil: 'domcontentloaded' }).catch(() => {});
    await p.waitForSelector(SELECTORS.loggedInMarker, { timeout: 300_000 });
  }
  console.log('Lpro ログイン確認OK');
}

/** 会話行から顧客キーと表示名を取り出す（キーの安定性が命） */
async function extractIdentity(
  item: ReturnType<Page['locator']>,
  index: number
): Promise<{ customerKey: string; name: string } | null> {
  let customerKey = '';
  if (SELECTORS.customerKeyAttr !== 'TODO') {
    customerKey = clean(await item.getAttribute(SELECTORS.customerKeyAttr));
  }
  let name = '';
  if (SELECTORS.customerName !== 'TODO') {
    name = clean(await item.locator(SELECTORS.customerName).first().textContent().catch(() => ''));
  }
  if (!name) {
    // フォールバック: 行全文。プレビューや未読数を含むため名前としては不安定
    name = clean(await item.textContent()).slice(0, 60);
    warnOnce(
      'name-fallback',
      '⚠️ customerName セレクタ未設定のため行全文から名前を代用中。プレビュー変化で名前が揺れ、' +
      '返信先の特定に失敗する危険があります。config.ts の SELECTORS.customerName を設定してください。'
    );
  }
  if (!customerKey) {
    customerKey = name;
    warnOnce(
      'key-fallback',
      '⚠️ customerKeyAttr 未設定のため表示名を顧客キーに使用中。同名衝突・キー揺れで' +
      '顧客1人に複数トピックができる危険があります。一意属性があれば必ず設定してください。'
    );
  }
  if (!customerKey) {
    console.warn(`会話行 ${index}: 顧客キーを特定できないためスキップします`);
    return null;
  }
  return { customerKey, name };
}

/** 会話一覧を取得 */
export async function pollConversations(): Promise<Conversation[]> {
  const p = page!;
  await p.goto(cfg.talkUrl, { waitUntil: 'domcontentloaded' });
  await p.waitForSelector(SELECTORS.conversationItem, { timeout: 15_000 }).catch(() => {});
  const items = p.locator(SELECTORS.conversationItem);
  const n = await items.count();
  if (n === 0) {
    warnOnce('empty-list', '会話一覧が0件です。conversationItem セレクタが正しいか確認してください。');
  }
  const out: Conversation[] = [];
  for (let i = 0; i < n; i++) {
    const item = items.nth(i);
    const id = await extractIdentity(item, i);
    if (!id) continue;
    const unread = (await item.locator(SELECTORS.unreadBadge).count()) > 0;
    out.push({ customerKey: id.customerKey, name: id.name, unread });
  }
  return out;
}

/** 会話を開いて相手(顧客)の発言だけを順番に取得。開けない/読めない場合は throw する */
export async function readInbound(conv: Conversation): Promise<InboundMsg[]> {
  const p = page!;
  await openConversation(conv);
  const bubbles = p.locator(SELECTORS.messageBubble);
  const n = await bubbles.count();
  const res: InboundMsg[] = [];
  for (let i = 0; i < n; i++) {
    const b = bubbles.nth(i);
    // 目印がバブル内部（子孫）にあるか、バブル自身のクラス等かの両対応
    let isInbound = (await b.locator(SELECTORS.inboundBubbleMarker).count()) > 0;
    if (!isInbound) {
      const self = await b
        .evaluate((el, sel) => {
          try { return (el as Element).matches(sel); } catch { return null; }
        }, SELECTORS.inboundBubbleMarker)
        .catch(() => null);
      if (self === null) {
        warnOnce(
          'marker-not-css',
          '⚠️ inboundBubbleMarker がバブル自身の判定（Element.matches）に使えないセレクタです。' +
          '純粋なCSS（クラス等）を推奨します。現在は子孫マッチのみで判定しています。'
        );
      }
      isInbound = self === true;
    }
    if (!isInbound) continue;
    const text = clean(await b.locator(SELECTORS.bubbleText).first().textContent().catch(() => ''));
    if (text) res.push({ text });
  }
  return res;
}

/** 返信を送信 */
export async function sendReply(customerKey: string, name: string, text: string): Promise<void> {
  const p = page!;
  await openConversation({ customerKey, name, unread: false });
  await p.locator(SELECTORS.replyInput).first().fill(text);
  await p.locator(SELECTORS.sendButton).first().click();
  // TODO(DOM確定後): 送信成功の検証を入れる（入力欄が空になった／自分の吹き出しが増えた等）。
  // 現状は固定待ちのみで、送信失敗を検知できない。
  await p.waitForTimeout(800);
}

/**
 * 会話を開く。キー属性 > 名前要素の完全一致 > 行全文の部分一致 の順で照合し、
 * 見つからなければ throw（握りつぶすと「空の履歴」扱いになり誤動作するため）。
 * ※ 直接URLで開ける場合（例: `${cfg.talkUrl}?user=...`）はそちらが確実。DOM確定時に差し替える。
 */
async function openConversation(conv: Conversation): Promise<void> {
  const p = page!;
  await p.waitForSelector(SELECTORS.conversationItem, { timeout: 15_000 });
  const items = p.locator(SELECTORS.conversationItem);
  const n = await items.count();
  let clicked = false;

  if (SELECTORS.customerKeyAttr !== 'TODO') {
    for (let i = 0; i < n && !clicked; i++) {
      const item = items.nth(i);
      if (clean(await item.getAttribute(SELECTORS.customerKeyAttr)) === conv.customerKey) {
        await item.click();
        clicked = true;
      }
    }
  } else if (SELECTORS.customerName !== 'TODO') {
    for (let i = 0; i < n && !clicked; i++) {
      const item = items.nth(i);
      const nm = clean(await item.locator(SELECTORS.customerName).first().textContent().catch(() => ''));
      if (nm === conv.name) {
        await item.click();
        clicked = true;
      }
    }
  } else {
    // 最終フォールバック: 部分一致（プレビュー変化で外れたり別行に当たる危険あり）
    warnOnce(
      'open-fallback',
      '⚠️ 会話の特定を行全文の部分一致で行っています。取り違えの危険があるため ' +
      'customerKeyAttr か customerName を設定してください。'
    );
    const hit = items.filter({ hasText: conv.name }).first();
    if ((await hit.count()) > 0) {
      await hit.click();
      clicked = true;
    }
  }

  if (!clicked) {
    throw new Error(`会話が見つかりません: ${conv.name}（key=${conv.customerKey}）`);
  }
  // ここで失敗したら throw させる（黙って空配列を返すと既読管理が壊れる）
  await p.waitForSelector(SELECTORS.messageBubble, { timeout: 10_000 });
}
