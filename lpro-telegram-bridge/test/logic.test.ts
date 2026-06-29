import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decideDelivery } from '../src/logic.js';

const msgs = (n: number) => Array.from({ length: n }, (_, i) => ({ text: `m${i}` }));

test('初回(bootstrap)は配信ゼロ・既読を現在件数に設定', () => {
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

test('2回目以降: 既読を超えた分だけ配信し、既読を更新', () => {
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

test('件数が減った場合(再読み込み等)は配信ゼロだが既読は補正する', () => {
  const d = decideDelivery({ bootstrapped: 1, seen_count: 5 }, msgs(2));
  assert.deepEqual(d.deliver, []);
  assert.equal(d.newSeen, 2);
});

test('1件だけ新着が来たケース', () => {
  const d = decideDelivery({ bootstrapped: 1, seen_count: 10 }, msgs(11));
  assert.deepEqual(d.deliver.map((m) => m.text), ['m10']);
  assert.equal(d.newSeen, 11);
});
