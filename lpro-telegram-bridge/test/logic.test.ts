import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decideDelivery } from '../src/logic.js';

const msgs = (n: number) => Array.from({ length: n }, (_, i) => ({ text: `m${i}` }));

// --- 初回ブートストラップ ---

test('初回(tail=0/未指定)は配信ゼロ・既読を現在件数に設定', () => {
  const d = decideDelivery({ bootstrapped: 0, seen_count: 0 }, msgs(5));
  assert.equal(d.bootstrap, true);
  assert.deepEqual(d.deliver, []);
  assert.equal(d.newSeen, 5);
});

test('初回で履歴ゼロでも既読0として確定する', () => {
  const d = decideDelivery({ bootstrapped: 0, seen_count: 0 }, msgs(0));
  assert.equal(d.bootstrap, true);
  assert.deepEqual(d.deliver, []);
  assert.equal(d.newSeen, 0);
});

test('初回 tail=5: 末尾5件だけ配って既読は全件に', () => {
  const d = decideDelivery({ bootstrapped: 0, seen_count: 0 }, msgs(12), { bootstrapTail: 5 });
  assert.equal(d.bootstrap, true);
  assert.deepEqual(d.deliver.map((m) => m.text), ['m7', 'm8', 'm9', 'm10', 'm11']);
  assert.equal(d.newSeen, 12);
});

test('初回 tail=5 で履歴3件なら全件配る', () => {
  const d = decideDelivery({ bootstrapped: 0, seen_count: 0 }, msgs(3), { bootstrapTail: 5 });
  assert.deepEqual(d.deliver.map((m) => m.text), ['m0', 'm1', 'm2']);
  assert.equal(d.newSeen, 3);
});

test('初回 tail が負数でも安全（配信ゼロ扱い）', () => {
  const d = decideDelivery({ bootstrapped: 0, seen_count: 0 }, msgs(4), { bootstrapTail: -1 });
  assert.deepEqual(d.deliver, []);
  assert.equal(d.newSeen, 4);
});

// --- 2回目以降 ---

test('既読を超えた分だけ配信し、既読を更新', () => {
  const d = decideDelivery({ bootstrapped: 1, seen_count: 3 }, msgs(5));
  assert.equal(d.bootstrap, false);
  assert.deepEqual(d.deliver.map((m) => m.text), ['m3', 'm4']);
  assert.equal(d.newSeen, 5);
});

test('新着なし(件数同じ)なら配信も既読更新もしない', () => {
  const d = decideDelivery({ bootstrapped: 1, seen_count: 4 }, msgs(4));
  assert.deepEqual(d.deliver, []);
  assert.equal(d.newSeen, null);
});

test('1件だけ新着が来たケース', () => {
  const d = decideDelivery({ bootstrapped: 1, seen_count: 10 }, msgs(11));
  assert.deepEqual(d.deliver.map((m) => m.text), ['m10']);
  assert.equal(d.newSeen, 11);
});

// --- 部分レンダリング防御（既読の下方修正はしない） ---

test('件数が減ったサイクルは部分レンダリング扱い: 配信も既読補正もしない', () => {
  const d = decideDelivery({ bootstrapped: 1, seen_count: 50 }, msgs(20));
  assert.deepEqual(d.deliver, []);
  assert.equal(d.newSeen, null);
});

test('縮小→同数まで復帰しても旧メッセージを再配信しない', () => {
  // 50件既読 → 部分レンダリングで20件（スキップ）→ 復帰して50件
  const dip = decideDelivery({ bootstrapped: 1, seen_count: 50 }, msgs(20));
  assert.equal(dip.newSeen, null); // 既読は50のまま
  const recovered = decideDelivery({ bootstrapped: 1, seen_count: 50 }, msgs(50));
  assert.deepEqual(recovered.deliver, []); // 再配信ゼロ
  assert.equal(recovered.newSeen, null);
});

test('縮小→復帰して新着があれば新着分だけ配信', () => {
  const dip = decideDelivery({ bootstrapped: 1, seen_count: 50 }, msgs(20));
  assert.equal(dip.newSeen, null);
  const recovered = decideDelivery({ bootstrapped: 1, seen_count: 50 }, msgs(52));
  assert.deepEqual(recovered.deliver.map((m) => m.text), ['m50', 'm51']);
  assert.equal(recovered.newSeen, 52);
});
