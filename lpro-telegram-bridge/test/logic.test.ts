import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decideDeliveryBySeen, toConvMessages, type FpMsg, type ScanMsg } from '../src/logic.js';

const msg = (h: string): FpMsg => ({ text: `本文${h}`, hash: h });
const msgs = (...hs: string[]) => hs.map(msg);
const seenSet = (...hs: string[]) => {
  const s = new Set(hs);
  return (h: string) => s.has(h);
};

// --- 初回ブートストラップ ---

test('初回(tail=0/未指定)は配信ゼロ', () => {
  const d = decideDeliveryBySeen(false, msgs('a', 'b', 'c'), seenSet());
  assert.equal(d.bootstrap, true);
  assert.deepEqual(d.deliver, []);
});

test('初回 tail=5: 末尾5件だけ配る', () => {
  const d = decideDeliveryBySeen(false, msgs('a', 'b', 'c', 'd', 'e', 'f', 'g'), seenSet(), { bootstrapTail: 5 });
  assert.equal(d.bootstrap, true);
  assert.deepEqual(d.deliver.map((m) => m.hash), ['c', 'd', 'e', 'f', 'g']);
});

test('初回 tail=5 で履歴3件なら全件配る', () => {
  const d = decideDeliveryBySeen(false, msgs('a', 'b', 'c'), seenSet(), { bootstrapTail: 5 });
  assert.deepEqual(d.deliver.map((m) => m.hash), ['a', 'b', 'c']);
});

test('初回 tail が負数でも安全（配信ゼロ扱い）', () => {
  const d = decideDeliveryBySeen(false, msgs('a', 'b'), seenSet(), { bootstrapTail: -1 });
  assert.deepEqual(d.deliver, []);
});

test('初回で履歴ゼロでも壊れない', () => {
  const d = decideDeliveryBySeen(false, [], seenSet(), { bootstrapTail: 5 });
  assert.equal(d.bootstrap, true);
  assert.deepEqual(d.deliver, []);
});

// --- 2回目以降（フィンガープリント差分） ---

test('全て既知なら配信しない', () => {
  const d = decideDeliveryBySeen(true, msgs('a', 'b', 'c'), seenSet('a', 'b', 'c'));
  assert.equal(d.bootstrap, false);
  assert.deepEqual(d.deliver, []);
});

test('末尾の未知分だけを表示順のまま配信', () => {
  const d = decideDeliveryBySeen(true, msgs('a', 'b', 'c', 'd'), seenSet('a', 'b'));
  assert.deepEqual(d.deliver.map((m) => m.hash), ['c', 'd']);
});

test('★同数入れ替わり（旧1件が窓から消え新1件が入る）でも新着を検知する', () => {
  // 件数ベース方式の原理的欠陥 [22] の回帰テスト:
  // 窓 [a,b,c] (3件・既知) → 窓 [b,c,d] (3件・同数) — d を取りこぼしてはならない
  const d = decideDeliveryBySeen(true, msgs('b', 'c', 'd'), seenSet('a', 'b', 'c'));
  assert.deepEqual(d.deliver.map((m) => m.hash), ['d']);
});

test('窓が縮んでも（部分描画）既知分の再配信をしない', () => {
  // 窓 [a,b,c,d,e] 既知 → 部分描画で [c,d] しか見えないサイクル → 配信ゼロ
  const d = decideDeliveryBySeen(true, msgs('c', 'd'), seenSet('a', 'b', 'c', 'd', 'e'));
  assert.deepEqual(d.deliver, []);
});

test('縮小→復帰しても再配信ゼロ・新着だけ配信', () => {
  const seen = seenSet('a', 'b', 'c', 'd', 'e');
  const dip = decideDeliveryBySeen(true, msgs('c', 'd'), seen);
  assert.deepEqual(dip.deliver, []);
  const recovered = decideDeliveryBySeen(true, msgs('b', 'c', 'd', 'e', 'f'), seen);
  assert.deepEqual(recovered.deliver.map((m) => m.hash), ['f']);
});

test('同一本文・同一日時の連投はハッシュ連番で別メッセージとして届く', () => {
  // adapter は同一(日時,本文)の2件目に ":1" を付ける → 未知として配信される
  const d = decideDeliveryBySeen(true, msgs('x', 'x:1'), seenSet('x'));
  assert.deepEqual(d.deliver.map((m) => m.hash), ['x:1']);
});

test('順序は入力の表示順を維持する', () => {
  const d = decideDeliveryBySeen(true, msgs('n1', 'k', 'n2'), seenSet('k'));
  assert.deepEqual(d.deliver.map((m) => m.hash), ['n1', 'n2']);
});

test('deliver は self などの追加フィールドを保ったまま返す（ジェネリック）', () => {
  const items = [
    { text: 'a', hash: 'a', self: false },
    { text: 'b', hash: 'b', self: true },
  ];
  const d = decideDeliveryBySeen(true, items, seenSet('a'));
  assert.deepEqual(d.deliver, [{ text: 'b', hash: 'b', self: true }]);
});

// --- toConvMessages（双方向フィンガープリント） ---

const scan = (inbound: boolean, text: string, dt: string, hasImage = false): ScanMsg => ({ inbound, text, dt, hasImage });

test('★顧客側(inbound)のハッシュ式は不変（既存台帳と一致・回帰防止）', () => {
  // この値が変わると、アップグレード時に全顧客の窓内メッセージが一斉再配信される（誤配信）
  const [m] = toConvMessages('chat', '123', [scan(true, 'こんにちは', '07/04 22:04')]);
  assert.equal(m.hash, '0a5c4c157663f366985953c1debb7aaee4a726b3');
  assert.equal(m.self, false);
});

test('自分側(self)は方向入りの別ハッシュ・self=true', () => {
  const [m] = toConvMessages('chat', '123', [scan(false, 'こんにちは', '07/04 22:04')]);
  assert.equal(m.hash, '40da39411a761ba52baedb3d3f9dd89df7d6e0f8');
  assert.equal(m.self, true);
});

test('顧客と自分が同一日時・同一本文でも別メッセージ（方向で衝突しない）', () => {
  // 実DOMは新→旧。時系列昇順に直り、両方が別ハッシュで残る
  const out = toConvMessages('chat', '123', [scan(false, '了解です', '07/04 22:04'), scan(true, '了解です', '07/04 22:04')]);
  assert.equal(out.length, 2);
  assert.notEqual(out[0].hash, out[1].hash);
  assert.deepEqual(out.map((m) => m.self), [false, true]); // 昇順: 顧客(先)→自分(後)
});

test('自分側の同文連投も :連番 で別メッセージ', () => {
  const out = toConvMessages('chat', '123', [scan(false, 'はい', '07/04 22:04'), scan(false, 'はい', '07/04 22:04')]);
  assert.equal(out.length, 2);
  assert.notEqual(out[0].hash, out[1].hash);
  assert.ok(out[1].hash.endsWith(':1'));
});

test('本文なし画像/スタンプは自分側でもプレースホルダで残る', () => {
  const [m] = toConvMessages('chat', '123', [scan(false, '', '07/04 22:04', true)]);
  assert.ok(m.text.includes('画像/スタンプ'));
  assert.equal(m.self, true);
});

test('本文も画像も無い空吹き出しは捨てる', () => {
  const out = toConvMessages('chat', '123', [scan(true, '', '07/04 22:04', false)]);
  assert.deepEqual(out, []);
});
