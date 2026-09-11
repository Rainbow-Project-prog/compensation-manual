/**
 * Lpro ログインセッション（Cookie）の引き継ぎ。
 *
 * 背景（2026-09-11 に実機ログと実験で確定）:
 *   - Lpro のログインは有効期限なしの Cookie（JSESSIONID＝セッションCookie）だけで保持される
 *     （ログイン画面の Set-Cookie に Expires/Max-Age が無く、「ログイン状態を保持」の類も無い）。
 *   - Playwright の Chromium（永続プロファイル）は、正常終了→次回起動でセッションCookieを破棄する
 *     （有効期限付き Cookie は残る。Preferences の restore_on_startup=1 でも回避できない。実験で確認）。
 *   - そのため「ブラウザを閉じて開き直す」操作（日次の定期再起動・PM2 stop/start・PC 再起動）は、
 *     Lpro 側のセッションが生きていてもログアウト扱いになり、手動ログイン（2FA）待ちに入っていた
 *     （2026-09-11 09:00 の定期再起動で発生し、ログイン待ちで巡回が止まった）。
 *
 * 対策:
 *   1. プロセス内の開き直し（recycleBrowser）は、閉じる前に context.cookies() で退避し、開いた後に
 *      context.addCookies() で戻す（Playwright の公開 API のみ。ディスクには出さない）。
 *   2. プロセス再起動に備え、Lpro の Cookie をデータディレクトリの .lpro-session に退避する。
 *      平文では置かない: Windows の DPAPI（ログオンユーザー鍵・CurrentUser スコープ）で暗号化する。
 *      Chromium 自身のプロファイル（Cookies DB）と同じ保護方式で、別ユーザー・別PCでは復号できない。
 *      さらに「案件ID＋Lpro ホスト」を DPAPI の追加エントロピーにする＝別案件のディレクトリへ
 *      ファイルごとコピーされても復号できない（別案件のアカウントに無言でログインする経路を塞ぐ）。
 *      Windows 以外では退避しない（このブリッジは Windows 常駐が前提）。
 *   3. 起動時、プロファイルに Lpro の Cookie が無ければ退避分を戻してからログイン確認に進む。
 *      Lpro 側で失効していれば普通に未ログイン扱い＝従来どおりの手動ログイン待ちになるだけで、悪化はしない。
 *
 * Cookie の値はログに出さない（セッション＝ログイン済みアカウントそのもの）。
 */
import { execFile } from 'node:child_process';
import { readFile, writeFile, rename, unlink } from 'node:fs/promises';

export type CookieRec = {
  name: string;
  value: string;
  domain: string;
  path: string;
  /** UNIX 秒。-1 はセッションCookie（有効期限なし） */
  expires: number;
  httpOnly: boolean;
  secure: boolean;
  sameSite: 'Strict' | 'Lax' | 'None';
};

/** 退避ファイルの持ち主（案件ID と Lpro ホスト）。保存時に記録し、読み込み時に照合＋復号鍵の一部にする */
export type SessionOwner = { instanceId: string; host: string };

/** 退避分のうち、いま無い（name+domain+path が一致しない）かつ期限切れでないものだけ返す（純関数） */
export function cookiesToRestore(snapshot: CookieRec[], present: CookieRec[], nowSec: number): CookieRec[] {
  const key = (c: CookieRec): string => `${c.name} ${c.domain} ${c.path}`;
  const have = new Set(present.map(key));
  return snapshot.filter((c) => !have.has(key(c)) && (c.expires === -1 || c.expires > nowSec));
}

/** ログ用の要約（値は出さない）。例: "JSESSIONID(セッション),foo" */
export function describeCookies(cs: CookieRec[]): string {
  if (cs.length === 0) return 'なし';
  return cs.map((c) => `${c.name}${c.expires === -1 ? '(セッション)' : ''}`).join(',');
}

/** 「同じ内容か」の判定用シグネチャ（値を含むがログには出さない。書き込みの重複を避けるため） */
export function cookieSignature(cs: CookieRec[]): string {
  return cs
    .map((c) => `${c.name} ${c.domain} ${c.path} ${c.value}`)
    .sort()
    .join('\n');
}

/** DPAPI の追加エントロピー（案件ID＋ホストから決定的に作る。空にはならない） */
export function sessionEntropy(owner: SessionOwner): Buffer {
  return Buffer.from(`lpro-bridge|${owner.instanceId}|${owner.host}`, 'utf8');
}

// ── DPAPI（Windows）──
// PowerShell の標準入出力は既定でコンソールのコードページ（cp932）になり非ASCIIが化けるため、
// 入出力とも Base64（ASCII）だけをやり取りする。値をコマンドラインに載せない（プロセス一覧に出る）。
// stdin は 1 行目=エントロピー(Base64)、2 行目=データ(Base64)。
const PS_COMMON =
  'Add-Type -AssemblyName System.Security; ' +
  '$p=[Console]::In.ReadToEnd().Trim().Split([char]10); ' +
  '$e=[Convert]::FromBase64String($p[0].Trim()); ' +
  '$b=[Convert]::FromBase64String($p[1].Trim()); ';
const PS_PROTECT = PS_COMMON +
  "[Convert]::ToBase64String([System.Security.Cryptography.ProtectedData]::Protect($b,$e,'CurrentUser'))";
const PS_UNPROTECT = PS_COMMON +
  "[Convert]::ToBase64String([System.Security.Cryptography.ProtectedData]::Unprotect($b,$e,'CurrentUser'))";

function runPowerShell(script: string, stdinText: string, timeoutMs: number): Promise<string> {
  return new Promise((res, rej) => {
    const child = execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', script],
      { timeout: timeoutMs, windowsHide: true, maxBuffer: 4 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) return rej(new Error(`powershell 失敗: ${String(stderr || err.message).slice(0, 200)}`));
        // 念のため空白・改行を全部落とす（Base64 に空白は含まれない）
        res(String(stdout).replace(/\s+/g, ''));
      }
    );
    child.stdin?.end(stdinText, 'utf8');
  });
}

export async function dpapiProtect(plain: Buffer, entropy: Buffer, timeoutMs = 20_000): Promise<string> {
  return runPowerShell(PS_PROTECT, `${entropy.toString('base64')}\n${plain.toString('base64')}\n`, timeoutMs);
}

export async function dpapiUnprotect(b64: string, entropy: Buffer, timeoutMs = 20_000): Promise<Buffer> {
  return Buffer.from(await runPowerShell(PS_UNPROTECT, `${entropy.toString('base64')}\n${b64}\n`, timeoutMs), 'base64');
}

/** .lpro-session の外側（平文）は形式とメタ情報だけ。Cookie 本体は dpapi（Base64）に暗号化して入れる */
type SessionFile = { v: 2; savedAt: string; host: string; instanceId: string; count: number; dpapi: string };

export const sessionFileSupported = (): boolean => process.platform === 'win32';

/** Lpro の Cookie を DPAPI で暗号化して file に退避する（一時名に書いてから rename＝途中失敗の残骸を読まない） */
export async function saveSessionFile(file: string, cookies: CookieRec[], owner: SessionOwner): Promise<void> {
  if (!sessionFileSupported()) return;
  const dpapi = await dpapiProtect(Buffer.from(JSON.stringify(cookies), 'utf8'), sessionEntropy(owner));
  const body: SessionFile = {
    v: 2, savedAt: new Date().toISOString(), host: owner.host, instanceId: owner.instanceId, count: cookies.length, dpapi,
  };
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    await writeFile(tmp, JSON.stringify(body), { encoding: 'utf8', mode: 0o600 });
    await rename(tmp, file);
  } catch (e) {
    await unlink(tmp).catch(() => {});
    throw e;
  }
}

/**
 * 退避した Cookie を読む。ファイルが無ければ null。
 * 別の案件／別の Lpro ホストのファイル（フォルダごとコピーされた等）は照合で弾き throw する
 * （呼び出し側で警告して無視）。メタが書き換えられていてもエントロピーが違えば復号できない。
 */
export async function loadSessionFile(
  file: string,
  owner: SessionOwner
): Promise<{ cookies: CookieRec[]; savedAt: string } | null> {
  if (!sessionFileSupported()) return null;
  let raw: string;
  try {
    raw = await readFile(file, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw e;
  }
  const meta = JSON.parse(raw) as Partial<SessionFile>;
  if (meta.v !== 2 || typeof meta.dpapi !== 'string') throw new Error('.lpro-session の形式が不明です（古い形式なら削除してください）');
  if (String(meta.host ?? '') !== owner.host || String(meta.instanceId ?? '') !== owner.instanceId) {
    throw new Error(
      `.lpro-session は別の案件/サーバーのものです（保存: instance="${meta.instanceId ?? ''}" host=${meta.host ?? '?'} / ` +
      `期待: instance="${owner.instanceId}" host=${owner.host}）。復元しません。フォルダをコピーした場合はこのファイルと .lpro-profile を削除してください`
    );
  }
  const cookies = JSON.parse((await dpapiUnprotect(meta.dpapi, sessionEntropy(owner))).toString('utf8')) as unknown;
  if (!Array.isArray(cookies)) throw new Error('.lpro-session の内容が不正です');
  return { cookies: cookies as CookieRec[], savedAt: String(meta.savedAt ?? '') };
}
