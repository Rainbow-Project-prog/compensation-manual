import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  cookiesToRestore, describeCookies, cookieSignature, sessionEntropy, saveSessionFile, loadSessionFile, sessionFileSupported,
  type CookieRec,
} from '../src/session.js';

const c = (name: string, value: string, expires = -1, domain = 'lpro-pm4.com', path = '/'): CookieRec =>
  ({ name, value, domain, path, expires, httpOnly: true, secure: true, sameSite: 'Lax' });

const OWNER = { instanceId: '', host: 'lpro-pm4.com' };

// --- cookiesToRestore（純関数）---

test('プロファイルに無いセッションCookieだけ戻す（あるものは触らない）', () => {
  const snap = [c('JSESSIONID', 'old'), c('other', 'x')];
  const present = [c('other', 'y')];
  const r = cookiesToRestore(snap, present, 1_000);
  assert.deepEqual(r.map((x) => x.name), ['JSESSIONID']);
});

test('同名でも domain/path が違えば別物として戻す', () => {
  const snap = [c('JSESSIONID', 'a', -1, 'lpro-pm4.com', '/'), c('JSESSIONID', 'b', -1, 'lpro-pm4.com', '/manage')];
  const present = [c('JSESSIONID', 'z', -1, 'lpro-pm4.com', '/')];
  const r = cookiesToRestore(snap, present, 1_000);
  assert.deepEqual(r.map((x) => x.path), ['/manage']);
});

test('期限切れの Cookie は戻さない（セッションCookie=-1 は常に戻す）', () => {
  const snap = [c('JSESSIONID', 'a', -1), c('expired', 'b', 900), c('alive', 'c', 1_100)];
  const r = cookiesToRestore(snap, [], 1_000);
  assert.deepEqual(r.map((x) => x.name), ['JSESSIONID', 'alive']);
});

test('空の退避分なら何も戻さない', () => {
  assert.deepEqual(cookiesToRestore([], [c('JSESSIONID', 'a')], 1_000), []);
});

// --- ログ要約・シグネチャ・エントロピー ---

test('describeCookies は値を出さない', () => {
  const s = describeCookies([c('JSESSIONID', 'SECRETVALUE'), c('p', 'v', 999)]);
  assert.equal(s, 'JSESSIONID(セッション),p');
  assert.ok(!s.includes('SECRETVALUE'));
  assert.equal(describeCookies([]), 'なし');
});

test('cookieSignature は順序に依らず、値が変われば変わる', () => {
  const a = [c('A', '1'), c('B', '2')];
  const b = [c('B', '2'), c('A', '1')];
  assert.equal(cookieSignature(a), cookieSignature(b));
  assert.notEqual(cookieSignature(a), cookieSignature([c('A', '1'), c('B', '3')]));
});

test('sessionEntropy は案件ID・ホストごとに異なり、空にならない', () => {
  const e0 = sessionEntropy({ instanceId: '', host: 'lpro-pm4.com' });
  assert.ok(e0.length > 0);
  assert.notEqual(e0.toString('hex'), sessionEntropy({ instanceId: 'foo', host: 'lpro-pm4.com' }).toString('hex'));
  assert.notEqual(e0.toString('hex'), sessionEntropy({ instanceId: '', host: 'lpro-chat.com' }).toString('hex'));
});

// --- .lpro-session（DPAPI。Windows のみ）---

test('DPAPI 退避→復元の往復（非ASCII含む・平文は残らない）', { skip: !sessionFileSupported() }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'lpro-session-'));
  const file = join(dir, '.lpro-session');
  try {
    const value = 'ABC日本語123';
    const cookies = [c('JSESSIONID', value), c('p', 'v', 4_000_000_000)];
    await saveSessionFile(file, cookies, OWNER);
    const raw = readFileSync(file, 'utf8');
    const meta = JSON.parse(raw);
    assert.equal(meta.v, 2);
    assert.equal(meta.count, 2);
    assert.equal(meta.host, OWNER.host);
    assert.equal(meta.instanceId, OWNER.instanceId);
    // 平文が無いことの検査は Base64 の偶然の部分一致で誤検知しないマーカーで行う
    // （'ABC' のような短い英字は暗号文の Base64 に約1〜2% の確率で現れる）
    const outer = JSON.stringify({ ...meta, dpapi: '' });
    assert.ok(!outer.includes('JSESSIONID') && !outer.includes(value), '外側 JSON に Cookie 名/値が出ている');
    assert.ok(!raw.includes('日本語'), '平文の値がファイルに出ている');
    const blob = Buffer.from(meta.dpapi, 'base64');
    assert.ok(!blob.includes(Buffer.from(JSON.stringify(cookies), 'utf8')), '暗号化前の JSON がブロブに含まれる');
    assert.ok(!blob.includes(Buffer.from(value, 'utf16le')), '値(UTF-16)がブロブに含まれる');
    const loaded = await loadSessionFile(file, OWNER);
    assert.ok(loaded);
    assert.deepEqual(loaded.cookies, cookies);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('別の案件/ホストの .lpro-session は照合で弾かれ、復号もできない', { skip: !sessionFileSupported() }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'lpro-session-'));
  const file = join(dir, '.lpro-session');
  try {
    await saveSessionFile(file, [c('JSESSIONID', 'A-SESSION')], { instanceId: 'a', host: 'lpro-pm4.com' });
    // 案件が違う → メタ照合で throw（復元しない）
    await assert.rejects(loadSessionFile(file, { instanceId: 'b', host: 'lpro-pm4.com' }), /別の案件/);
    // メタを書き換えて通しても、エントロピーが違うので DPAPI が復号を拒む
    const meta = JSON.parse(readFileSync(file, 'utf8'));
    meta.instanceId = 'b';
    const { writeFileSync } = await import('node:fs');
    writeFileSync(file, JSON.stringify(meta), 'utf8');
    await assert.rejects(loadSessionFile(file, { instanceId: 'b', host: 'lpro-pm4.com' }), /powershell 失敗/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('ファイルが無ければ null', { skip: !sessionFileSupported() }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'lpro-session-'));
  try {
    assert.equal(await loadSessionFile(join(dir, 'missing'), OWNER), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
