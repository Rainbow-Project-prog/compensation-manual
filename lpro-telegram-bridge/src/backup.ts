import { mkdirSync, existsSync, readdirSync, unlinkSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { backupTo } from './db.js';

// バックアップ先はパッケージルート直下 backups/（.gitignore 済み・顧客データを含むため）
const backupDir = fileURLToPath(new URL('../backups', import.meta.url));

const NAME_RE = /^bridge-\d{4}-\d{2}-\d{2}\.db$/;

/** ローカル日付の YYYY-MM-DD（バックアップは「1日1世代」の単位で管理する） */
function today(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/**
 * bridge.db の日次ホットバックアップ。2026-07-26 解析まで顧客・トピック紐付け・
 * フィンガープリント台帳のバックアップが皆無だった（DB破損＝全顧客のトピック紐付け喪失）。
 * - VACUUM INTO を一時名に書いてから rename する: 途中失敗の残骸を当日分と誤認しない
 * - 同日分が既にあればスキップ（戻り値 null）＝起動のたびに書き直さない
 * - retain 世代を超えた古い世代は削除（ファイル名の日付順＝辞書順）
 */
export function runBackup(retain = 14): string | null {
  mkdirSync(backupDir, { recursive: true });
  const dest = join(backupDir, `bridge-${today()}.db`);
  let created: string | null = null;
  if (!existsSync(dest)) {
    const tmp = `${dest}.tmp`;
    if (existsSync(tmp)) unlinkSync(tmp); // 前回途中失敗の残骸（VACUUM INTO は宛先が在ると失敗する）
    backupTo(tmp);
    renameSync(tmp, dest);
    created = dest;
  }
  const files = readdirSync(backupDir).filter((f) => NAME_RE.test(f)).sort();
  for (const f of files.slice(0, Math.max(0, files.length - retain))) {
    try { unlinkSync(join(backupDir, f)); } catch { /* 次回の実行で再試行される */ }
  }
  return created;
}
