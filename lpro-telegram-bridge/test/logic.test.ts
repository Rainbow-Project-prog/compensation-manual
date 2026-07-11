import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decideDeliveryBySeen, type FpMsg } from '../src/logic.js';

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
