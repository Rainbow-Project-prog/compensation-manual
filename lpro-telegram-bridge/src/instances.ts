/**
 * 複数案件（instances/<案件名>/.env ＋ 既定のルート .env）の一覧と、案件間の設定競合の検出。
 *
 * 競合＝2つの案件プロセスが同じ資源を掴む状態。いずれも「無音で壊れる」か「誤配信」に直結する:
 *   - 同じ TELEGRAM_BOT_TOKEN: 2プロセスが getUpdates を取り合い 409 Conflict → 片方が落ちて
 *     PM2 再起動 → もう片方が落ちる…の永久ループ（どちらも安定して動かない）
 *   - 同じ Telegram グループID: 両案件の Bot が同じトピックの返信を拾い、それぞれの Lpro へ送る
 *     （＝別案件の顧客へ誤送信 / 二重送信）。配信も同じグループへ混ざる
 *   - 同じブラウザプロファイル: chromium のプロファイルロック競合で起動失敗ループ、または
 *     同じ Lpro セッションを2プロセスが奪い合う
 *   - 同じ DB: 会員IDが両案件で偶然一致すると台帳・トピック紐付けが混ざる
 * doctor（起動前チェック）と index.ts の起動ガードが、この案件と他案件の間で競合が無いことを確認する。
 */
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync, utimesSync, unlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parse } from 'dotenv';
import { pkgRoot, resolveDataPaths, INSTANCE_ID_RE } from './paths.js';

export type InstanceInfo = {
  id: string;            // '' = 既定（ルート配置）
  dir: string;           // データディレクトリ
  envPath: string;
  token: string;         // TELEGRAM_BOT_TOKEN（未設定は ''）
  groups: number[];      // 有効な受信箱グループID（0/NaN は除外）
  userDataDir: string;
  dbPath: string;
  loginUrl: string;      // LPRO_LOGIN_URL（未設定は ''）
};

function groupIds(env: Record<string, string | undefined>): number[] {
  const out: number[] = [];
  for (const k of ['CHAT_GROUP_CHAT_ID', 'TALK_GROUP_CHAT_ID']) {
    const n = Number((env[k] ?? '').trim());
    if (Number.isFinite(n) && n !== 0) out.push(n);
  }
  return out;
}

/** 環境変数の集合（process.env またはパース済み .env）から案件情報を組み立てる */
export function describeInstance(
  id: string,
  dir: string,
  envPath: string,
  env: Record<string, string | undefined>
): InstanceInfo {
  const paths = resolveDataPaths(dir, env);
  return {
    id,
    dir,
    envPath,
    token: (env.TELEGRAM_BOT_TOKEN ?? '').trim(),
    groups: groupIds(env),
    userDataDir: paths.userDataDir,
    dbPath: paths.dbPath,
    loginUrl: (env.LPRO_LOGIN_URL ?? '').trim(),
  };
}

/** 設定ファイルが存在する案件を列挙する（既定のルート .env → instances/<名前>/.env の順）。
 * 各 .env は読み取るだけ（process.env には流し込まない）。壊れた .env は空設定として扱う */
export function listInstances(root: string = pkgRoot): InstanceInfo[] {
  const out: InstanceInfo[] = [];
  const read = (p: string): Record<string, string> => {
    try { return parse(readFileSync(p, 'utf8')); } catch { return {}; }
  };
  const rootEnv = join(root, '.env');
  if (existsSync(rootEnv)) out.push(describeInstance('', root, rootEnv, read(rootEnv)));
  const instDir = join(root, 'instances');
  if (existsSync(instDir)) {
    for (const d of readdirSync(instDir, { withFileTypes: true })) {
      if (!d.isDirectory() || !INSTANCE_ID_RE.test(d.name)) continue;
      const dir = join(instDir, d.name);
      const envPath = join(dir, '.env');
      if (!existsSync(envPath)) continue;
      out.push(describeInstance(d.name, dir, envPath, read(envPath)));
    }
  }
  return out;
}

const label = (i: InstanceInfo): string => (i.id === '' ? '既定（ルート .env）' : `案件 "${i.id}"`);
// パスの同一性: 正規化（末尾区切り・. / .. の解決）＋ Windows のドライブ/フォルダ名の大文字小文字を無視
export const samePath = (a: string, b: string): boolean => resolve(a).toLowerCase() === resolve(b).toLowerCase();
// URL の同一性（比較用の正規化。パース不能ならそのまま小文字比較）
function normUrl(u: string): string {
  try { const x = new URL(u); return (x.host + x.pathname).replace(/\/+$/, '').toLowerCase(); } catch { return u.trim().toLowerCase(); }
}

/**
 * 自案件 me と他案件 others の間の資源競合を人が読める文で返す（空配列＝競合なし）。
 * 純関数（ファイルを読まない）なので単体テストで規則をロックする。
 */
export function findInstanceConflicts(me: InstanceInfo, others: InstanceInfo[]): string[] {
  const problems: string[] = [];
  for (const o of others) {
    if (o.id === me.id) continue;
    if (me.token && o.token && me.token === o.token) {
      problems.push(
        `${label(o)} と同じ TELEGRAM_BOT_TOKEN です（同じ Bot を2プロセスで動かすと 409 Conflict で交互に落ち続けます。案件ごとに BotFather で別の Bot を作ってください）`
      );
    }
    const dup = me.groups.filter((g) => o.groups.includes(g));
    if (dup.length > 0) {
      problems.push(
        `${label(o)} と同じ Telegram グループID（${dup.join(', ')}）です（両案件の返信が互いの Lpro へ送られる＝別案件の顧客への誤送信になります。案件ごとに別グループを作ってください）`
      );
    }
    if (samePath(me.userDataDir, o.userDataDir)) {
      problems.push(`${label(o)} と同じブラウザプロファイル（${me.userDataDir}）です（USER_DATA_DIR を分けてください）`);
    }
    if (samePath(me.dbPath, o.dbPath)) {
      problems.push(`${label(o)} と同じ DB（${me.dbPath}）です（DB_PATH を分けてください）`);
    }
  }
  return problems;
}

// ── 生存マーカー ──
// 稼働中の案件プロセスは <データディレクトリ>/bridge.lock を 30 秒ごとに touch し、終了時に消す。
// preflight は「mtime が新しい＝いま動いている案件」との競合だけを既定案件でも起動拒否にする
// （止まっている/作りかけの案件との競合は警告止まり＝本番を無音で殺さない）。pid は書くが生存判定には使わない
// （再起動後の pid 再利用で誤って「生きている」と判定し、本番を止めてしまう事故を避けるため、時刻だけで判定する）。
export const LIVE_LOCK_MAX_AGE_MS = 2 * 60_000;
export function lockPath(dir: string): string {
  return join(dir, 'bridge.lock');
}
export function isInstanceLive(i: InstanceInfo, now: number = Date.now(), maxAgeMs: number = LIVE_LOCK_MAX_AGE_MS): boolean {
  try { return now - statSync(lockPath(i.dir)).mtimeMs < maxAgeMs; } catch { return false; }
}
export function writeLock(dir: string): void {
  try { writeFileSync(lockPath(dir), `${process.pid} ${new Date().toISOString()}\n`); } catch { /* ディスク障害時も稼働は続ける */ }
}
export function touchLock(dir: string): void {
  try { const t = new Date(); utimesSync(lockPath(dir), t, t); } catch { writeLock(dir); }
}
export function removeLock(dir: string): void {
  try { unlinkSync(lockPath(dir)); } catch { /* 無ければよい */ }
}

/**
 * 起動は止めないが知らせるべき案件間の重なり（警告）。
 *  - 同じ Lpro ログインURL: 同じ Lpro サーバー（同一アカウントの可能性）。同一アカウントを2案件で使う構成は
 *    Lpro が同時セッションを許すか未検証（片方のログインが他方を失効させる恐れ）。別アカウントなら問題ない
 *    （LPRO_SITE_ID の照合で別アカウントへの誤ログインは防ぐ）。
 */
export function findInstanceWarnings(me: InstanceInfo, others: InstanceInfo[]): string[] {
  const warnings: string[] = [];
  for (const o of others) {
    if (o.id === me.id) continue;
    if (me.loginUrl && o.loginUrl && normUrl(me.loginUrl) === normUrl(o.loginUrl)) {
      warnings.push(
        `${label(o)} と同じ Lpro ログインURL（${me.loginUrl}）です。同じ Lpro アカウントを2案件で使う構成は未検証です（別アカウントなら問題ありません。LPRO_SITE_ID を両案件に設定して取り違えを防いでください）`
      );
    }
  }
  return warnings;
}
