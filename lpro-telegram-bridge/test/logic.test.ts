import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  decideDeliveryBySeen, packDeliveryChunks, toConvMessages, type FpMsg, type ScanMsg,
} from '../src/logic.js';

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

// --- packDeliveryChunks（大量配信の429対策: 連結チャンク化） ---

const fmt = (m: FpMsg) => m.text; // msg('a') → text='本文a'（3字）

test('minBatch 未満は連結しない（通常の新着は従来どおり1件1通）', () => {
  const out = packDeliveryChunks(msgs('a', 'b'), fmt, { minBatch: 6 });
  assert.deepEqual(out, [
    { text: '本文a', hashes: ['a'] },
    { text: '本文b', hashes: ['b'] },
  ]);
});

test('minBatch 以上は連結され、text とハッシュがチャンクに対応する', () => {
  const out = packDeliveryChunks(msgs('a', 'b', 'c'), fmt, { minBatch: 3, maxChars: 1000, sep: '|' });
  assert.deepEqual(out, [{ text: '本文a|本文b|本文c', hashes: ['a', 'b', 'c'] }]);
});

test('maxChars 超過で分割される（順序維持・ハッシュの取り落としなし）', () => {
  // 本文x=3字, sep=1字 → 「本文a|本文b」=7字 は maxChars=8 に収まり、c を足すと11字で溢れる
  const out = packDeliveryChunks(msgs('a', 'b', 'c', 'd'), fmt, { minBatch: 2, maxChars: 8, sep: '|' });
  assert.deepEqual(out.map((c) => c.hashes), [['a', 'b'], ['c', 'd']]);
  assert.deepEqual(out.map((c) => c.text), ['本文a|本文b', '本文c|本文d']);
});

test('1件で maxChars を超えるメッセージは単独チャンク（4096字分割は送信側の責務）', () => {
  const big = { text: 'x'.repeat(50), hash: 'big' };
  const out = packDeliveryChunks([big, ...msgs('a')], (m) => m.text, { minBatch: 2, maxChars: 10, sep: '|' });
  assert.deepEqual(out.map((c) => c.hashes), [['big'], ['a']]);
});

test('ラベル付け（format）はチャンク連結前に1件ずつ適用される', () => {
  const items = [
    { text: 'a', hash: 'a', self: false },
    { text: 'b', hash: 'b', self: true },
  ];
  const out = packDeliveryChunks(items, (m) => (m.self ? '🔷 ' + m.text : m.text), { minBatch: 2, sep: '|' });
  assert.deepEqual(out, [{ text: 'a|🔷 b', hashes: ['a', 'b'] }]);
});

test('空入力は空配列', () => {
  assert.deepEqual(packDeliveryChunks([], fmt), []);
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

// --- 対応状況マーカーの遷移判定（L-Pro henshin → トピック名 🔴/✅）---

import { decideMarkerTransitions } from '../src/logic.js';

const cand = (key: string, marker: string | null) => ({ key, marker });
const noTrunc = { truncated: false, max: 10 };
const streak = () => new Map<string, number>();

test('未返信一覧に居る顧客は pending(🔴) へ即遷移', () => {
  const t = decideMarkerTransitions(
    [cand('talk:1', 'done'), cand('talk:2', null)], new Set(['talk:1', 'talk:2']), noTrunc, streak());
  assert.deepEqual(t, [
    { key: 'talk:1', desired: 'pending' },
    { key: 'talk:2', desired: 'pending' },
  ]);
});

test('不在→done(✅) は doneAfterMisses サイクル連続不在で初めて遷移（1回目は保留）', () => {
  const s = streak();
  const c = [cand('talk:1', 'pending')];
  assert.deepEqual(decideMarkerTransitions(c, new Set(), noTrunc, s), []); // 1回目: 保留
  assert.deepEqual(decideMarkerTransitions(c, new Set(), noTrunc, s), [{ key: 'talk:1', desired: 'done' }]); // 2回目
});

test('不在ストリークは present で即リセット（一過性の一覧欠けで✅にしない）', () => {
  const s = streak();
  const c = [cand('talk:1', 'pending')];
  decideMarkerTransitions(c, new Set(), noTrunc, s); // 不在1回
  decideMarkerTransitions(c, new Set(['talk:1']), noTrunc, s); // 再出現 → リセット
  assert.deepEqual(decideMarkerTransitions(c, new Set(), noTrunc, s), []); // 不在1回目からやり直し
});

test('doneAfterMisses=1 なら不在1回で✅', () => {
  const t = decideMarkerTransitions(
    [cand('talk:1', 'pending'), cand('talk:2', null)], new Set(),
    { truncated: false, max: 10, doneAfterMisses: 1 }, streak());
  assert.deepEqual(t, [
    { key: 'talk:1', desired: 'done' },
    { key: 'talk:2', desired: 'done' },
  ]);
});

test('既に望む状態なら遷移なし（editForumTopic を呼ばせない）', () => {
  const s = streak();
  const c = [cand('talk:1', 'pending'), cand('talk:2', 'done')];
  const t1 = decideMarkerTransitions(c, new Set(['talk:1']), { truncated: false, max: 10, doneAfterMisses: 1 }, s);
  assert.deepEqual(t1, []);
});

test('表示上限打ち切り中は「不在=✅」を保留し、不在ストリークにも数えない', () => {
  const s = streak();
  const c = [cand('talk:1', 'pending'), cand('talk:2', 'done')];
  const t1 = decideMarkerTransitions(c, new Set(['talk:2']), { truncated: true, max: 10, doneAfterMisses: 1 }, s);
  assert.deepEqual(t1, [{ key: 'talk:2', desired: 'pending' }]); // 🔴側は即応
  assert.equal(s.get('talk:1') ?? 0, 0); // 打ち切りサイクルは不在にカウントしない
});

test('max 件で打ち止め（残りは次サイクルへ持ち越し）だが、ストリーク更新は全候補分続く', () => {
  const s = streak();
  const c = [cand('talk:1', null), cand('talk:2', null), cand('talk:3', null)];
  const t = decideMarkerTransitions(c, new Set(), { truncated: false, max: 2, doneAfterMisses: 1 }, s);
  assert.deepEqual(t.map((x) => x.key), ['talk:1', 'talk:2']);
  assert.equal(s.get('talk:3'), 1); // 持ち越し分も不在カウントは進んでいる
});

test('max は「実際の遷移数」で数える（無遷移の候補はカウントしない）', () => {
  const t = decideMarkerTransitions(
    [cand('talk:1', 'done'), cand('talk:2', 'done'), cand('talk:3', null)],
    new Set(),
    { truncated: false, max: 1, doneAfterMisses: 1 }, streak());
  assert.deepEqual(t, [{ key: 'talk:3', desired: 'done' }]);
});
