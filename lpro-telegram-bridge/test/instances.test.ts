import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join, resolve, sep } from 'node:path';
import { describeInstance, findInstanceConflicts, findInstanceWarnings, samePath, type InstanceInfo } from '../src/instances.js';
import { resolveDataPaths, dataDirOf, pm2AppName, INSTANCE_ID_RE } from '../src/paths.js';

// ── 案件間の競合検出（純関数）──
// 競合はどれも「409 で交互に落ちる」「別案件の顧客へ誤送信」に直結するため、規則をテストでロックする

const ROOT = resolve('/bridge');
// 案件IDごとに必ず異なるグループIDを作る（同じ長さのIDで衝突させない）
const hashOf = (s: string): number => [...s].reduce((a, c, i) => a + c.charCodeAt(0) * (i + 1), 0);
const inst = (id: string, over: Partial<InstanceInfo> = {}): InstanceInfo => {
  const dir = id ? join(ROOT, 'instances', id) : ROOT;
  const h = hashOf(id || 'root');
  return {
    id,
    dir,
    envPath: join(dir, '.env'),
    token: `token-${id || 'root'}`,
    groups: [-100000 - h, -200000 - h],
    userDataDir: join(dir, '.lpro-profile'),
    dbPath: join(dir, 'bridge.db'),
    loginUrl: `https://lpro-pm${h}.com/manage/`,
    ...over,
  };
};

test('資源が全て別なら競合なし', () => {
  assert.deepEqual(findInstanceConflicts(inst(''), [inst('foo'), inst('bar')]), []);
});

test('同じ Bot トークンは競合（409 Conflict ループ）', () => {
  const me = inst('foo', { token: 'same' });
  const other = inst('bar', { token: 'same' });
  const out = findInstanceConflicts(me, [other]);
  assert.equal(out.length, 1);
  assert.match(out[0], /TELEGRAM_BOT_TOKEN/);
  assert.match(out[0], /案件 "bar"/);
});

test('トークン未設定同士（空）は競合と見なさない', () => {
  assert.deepEqual(findInstanceConflicts(inst('foo', { token: '' }), [inst('bar', { token: '' })]), []);
});

test('同じ Telegram グループIDは競合（別案件の顧客への誤送信）', () => {
  const me = inst('foo', { groups: [-100111, -100222] });
  const other = inst('', { groups: [-100999, -100222] });
  const out = findInstanceConflicts(me, [other]);
  assert.equal(out.length, 1);
  assert.match(out[0], /-100222/);
  assert.match(out[0], /既定/);
});

test('同じブラウザプロファイル（大文字小文字・末尾区切りの違いを無視）は競合', () => {
  const me = inst('foo', { userDataDir: join(ROOT, 'Shared-Profile') + sep });
  const other = inst('bar', { userDataDir: join(ROOT, 'shared-profile') });
  const out = findInstanceConflicts(me, [other]);
  assert.equal(out.length, 1);
  assert.match(out[0], /プロファイル/);
});

test('同じ DB は競合', () => {
  const me = inst('foo', { dbPath: join(ROOT, 'one.db') });
  const other = inst('bar', { dbPath: join(ROOT, 'one.db') });
  const out = findInstanceConflicts(me, [other]);
  assert.equal(out.length, 1);
  assert.match(out[0], /DB/);
});

test('複数の競合は全て列挙される（トークン＋グループ）', () => {
  const me = inst('foo', { token: 'same', groups: [-1] });
  const other = inst('bar', { token: 'same', groups: [-1] });
  assert.equal(findInstanceConflicts(me, [other]).length, 2);
});

test('自分自身（同じID）は比較対象から除外される', () => {
  const me = inst('foo');
  assert.deepEqual(findInstanceConflicts(me, [inst('foo')]), []);
});

// ── 警告（起動は止めない）──

test('同じ Lpro ログインURL（表記ゆれ込み）は警告（同一アカウント運用は未検証）', () => {
  const me = inst('foo', { loginUrl: 'https://LPRO-PM4.com/manage/' });
  const other = inst('bar', { loginUrl: 'https://lpro-pm4.com/manage' });
  const out = findInstanceWarnings(me, [other]);
  assert.equal(out.length, 1);
  assert.match(out[0], /同じ Lpro ログインURL/);
  assert.match(out[0], /案件 "bar"/);
});

test('別の Lpro サーバーなら警告なし・URL未設定同士も警告なし', () => {
  assert.deepEqual(findInstanceWarnings(inst('foo'), [inst('bar')]), []);
  assert.deepEqual(findInstanceWarnings(inst('foo', { loginUrl: '' }), [inst('bar', { loginUrl: '' })]), []);
});

test('samePath: 末尾区切り・大文字小文字・. の違いを無視して同一判定', () => {
  assert.ok(samePath(join(ROOT, 'A', 'b') + sep, join(ROOT, 'a', 'B')));
  assert.ok(samePath(join(ROOT, 'x', '.', 'y'), join(ROOT, 'x', 'y')));
  assert.ok(!samePath(join(ROOT, 'x'), join(ROOT, 'x2')));
});

test('pm2AppName: 既定は lpro-bridge、案件名ありは lpro-bridge-<名前>（ecosystem と同じ規則）', () => {
  assert.equal(pm2AppName(''), 'lpro-bridge');
  assert.equal(pm2AppName('foo'), 'lpro-bridge-foo');
});

// ── データ配置の規則 ──

test('dataDirOf: 既定はルート、案件名ありは instances/<名前>', () => {
  assert.equal(dataDirOf('', ROOT), ROOT);
  assert.equal(dataDirOf('foo', ROOT), join(ROOT, 'instances', 'foo'));
});

test('resolveDataPaths: 未指定なら案件フォルダ直下の .lpro-profile / bridge.db / backups', () => {
  const dir = join(ROOT, 'instances', 'foo');
  const p = resolveDataPaths(dir, {});
  assert.equal(p.userDataDir, join(dir, '.lpro-profile'));
  assert.equal(p.dbPath, join(dir, 'bridge.db'));
  assert.equal(p.backupDir, join(dir, 'backups'));
});

test('resolveDataPaths: 相対パスは案件フォルダ基準（既定案件の ./.lpro-profile は従来と同じ場所）', () => {
  const p = resolveDataPaths(ROOT, { USER_DATA_DIR: './.lpro-profile', DB_PATH: 'data/x.db' });
  assert.equal(p.userDataDir, join(ROOT, '.lpro-profile'));
  assert.equal(p.dbPath, join(ROOT, 'data', 'x.db'));
});

test('resolveDataPaths: 絶対パスはそのまま', () => {
  const abs = resolve('/elsewhere/profile');
  const p = resolveDataPaths(ROOT, { USER_DATA_DIR: abs });
  assert.equal(p.userDataDir, abs);
});

test('INSTANCE_ID_RE: 英数字・-・_ のみ、先頭は英数字、32文字以内', () => {
  for (const ok of ['hikari', 'foo-1', 'A_b', 'x'.repeat(32)]) assert.ok(INSTANCE_ID_RE.test(ok), ok);
  for (const ng of ['', 'ひかり', '-a', '_a', 'a/b', 'a b', 'a.b', 'x'.repeat(33)]) assert.ok(!INSTANCE_ID_RE.test(ng), ng);
});

test('describeInstance: グループIDは数値のものだけ（空/0/NaN は除外）・トークンは trim', () => {
  const info = describeInstance('foo', join(ROOT, 'instances', 'foo'), 'p', {
    TELEGRAM_BOT_TOKEN: '  tok  ',
    CHAT_GROUP_CHAT_ID: '-1001',
    TALK_GROUP_CHAT_ID: '',
  });
  assert.equal(info.token, 'tok');
  assert.deepEqual(info.groups, [-1001]);
  const info2 = describeInstance('bar', ROOT, 'p', { CHAT_GROUP_CHAT_ID: '0', TALK_GROUP_CHAT_ID: 'abc' });
  assert.deepEqual(info2.groups, []);
});
