import { chromium, type BrowserContext, type Page } from 'playwright';
import { cfg, SELECTORS } from './config.js';

export type Conversation = { customerKey: string; name: string; unread: boolean };
export type InboundMsg = { text: string };

let ctx: BrowserContext | null = null;
let page: Page | null = null;

export async function initBrowser(): Promise<void> {
  ctx = await chromium.launchPersistentContext(cfg.userDataDir, {
    headless: cfg.headless,
    viewport: { width: 1280, height: 900 },
  });
  page = ctx.pages()[0] ?? (await ctx.newPage());
  await ensureLoggedIn();
}

async function ensureLoggedIn(): Promise<void> {
  const p = page!;
  await p.goto(cfg.talkUrl, { waitUntil: 'domcontentloaded' });
  const marker = p.locator(SELECTORS.loggedInMarker).first();
  const ok = (await marker.count()) > 0 && (await marker.isVisible().catch(() => false));
  if (!ok) {
    console.log('未ログインの可能性。表示中のブラウザでログイン（2FA含む）してください。最大5分待機…');
    await p.goto(cfg.loginUrl, { waitUntil: 'domcontentloaded' }).catch(() => {});
    await p.waitForSelector(SELECTORS.loggedInMarker, { timeout: 300_000 });
  }
  console.log('Lpro ログイン確認OK');
}

/** 会話一覧を取得 */
export async function pollConversations(): Promise<Conversation[]> {
  const p = page!;
  await p.goto(cfg.talkUrl, { waitUntil: 'domcontentloaded' }).catch(() => {});
  await p.waitForSelector(SELECTORS.conversationItem, { timeout: 15_000 }).catch(() => {});
  const items = p.locator(SELECTORS.conversationItem);
  const n = await items.count();
  const out: Conversation[] = [];
  for (let i = 0; i < n; i++) {
    const item = items.nth(i);

    // --- TODO: 顧客キーの取り出し方を Lpro の DOM に合わせる ---
    // 一意な属性があれば最優先（例: data-user-id / data-ucode）。
    // 無ければ表示名で代用（※同名衝突に注意）。
    const idAttr = await item.getAttribute('data-user-id'); // ← TODO: 実際の属性名へ
    const nameText = ((await item.textContent()) ?? '').trim().replace(/\s+/g, ' ');
    const customerKey = idAttr ?? nameText ?? `idx-${i}`;
    const name = nameText.slice(0, 60);

    const unread = (await item.locator(SELECTORS.unreadBadge).count()) > 0;
    out.push({ customerKey, name, unread });
  }
  return out;
}

/** 会話を開いて相手(顧客)の発言だけを順番に取得 */
export async function readInbound(conv: Conversation): Promise<InboundMsg[]> {
  const p = page!;
  await openConversation(conv);
  const bubbles = p.locator(SELECTORS.messageBubble);
  const n = await bubbles.count();
  const res: InboundMsg[] = [];
  for (let i = 0; i < n; i++) {
    const b = bubbles.nth(i);
    const isInbound =
      (await b.locator(SELECTORS.inboundBubbleMarker).count()) > 0 ||
      (await b.evaluate((el, sel) => (el as Element).matches(sel), SELECTORS.inboundBubbleMarker).catch(() => false));
    if (!isInbound) continue;
    const text = ((await b.locator(SELECTORS.bubbleText).first().textContent().catch(() => '')) ?? '').trim();
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
  await p.waitForTimeout(800);
}

/** 会話を開く（TODO: Lpro の開き方に合わせる） */
async function openConversation(conv: Conversation): Promise<void> {
  const p = page!;
  // --- TODO: 会話の開き方を実装（どちらか） ---
  // A) 一覧から名前で該当行をクリック:
  await p.locator(SELECTORS.conversationItem).filter({ hasText: conv.name }).first().click();
  // B) 直接URLで開ける場合（推奨・確実なら差し替え）:
  //   await p.goto(`${cfg.talkUrl}?user=${encodeURIComponent(conv.customerKey)}`);
  await p.waitForSelector(SELECTORS.messageBubble, { timeout: 10_000 }).catch(() => {});
}
