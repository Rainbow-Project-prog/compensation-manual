/**
 * 案件（インスタンス）のデータ配置規則（純関数・副作用なし）。
 * env.ts（稼働中の自案件の解決＋.env 読み込み）と instances.ts（他案件の .env を読んで競合チェック）が
 * 同じ規則を共有し、「doctor は通ったのに実際は別の場所を見ていた」を防ぐ。テストからも import できる。
 */
import { fileURLToPath } from 'node:url';
import { join, resolve } from 'node:path';

export const pkgRoot = fileURLToPath(new URL('..', import.meta.url));

// 案件名はディレクトリ名・PM2 アプリ名に使うため ASCII の英数字と - _ に限る（表示名は INSTANCE_LABEL）
export const INSTANCE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/;

/** 案件IDに対応する PM2 アプリ名（ecosystem.config.cjs と同じ規則。起動時に照合して BRIDGE_INSTANCE の混入を検出する） */
export function pm2AppName(instanceId: string): string {
  return instanceId ? `lpro-bridge-${instanceId}` : 'lpro-bridge';
}

/** 案件IDからデータディレクトリを決める（'' = 既定＝パッケージルート配置） */
export function dataDirOf(instanceId: string, root: string = pkgRoot): string {
  return instanceId ? join(root, 'instances', instanceId) : root;
}

/**
 * 案件のデータ配置を環境変数（process.env または .env をパースしたもの）から解決する。
 *   - USER_DATA_DIR / DB_PATH は指定があればデータディレクトリ基準で解決（絶対パスならそのまま）。
 *     既定案件の "./.lpro-profile" は従来（CWD=パッケージルート）と同じ場所に解決される。
 *   - 未指定なら <データディレクトリ>/.lpro-profile と <データディレクトリ>/bridge.db
 *   - バックアップは常に <データディレクトリ>/backups
 */
export function resolveDataPaths(
  dir: string,
  env: Record<string, string | undefined>
): { userDataDir: string; dbPath: string; backupDir: string } {
  const udd = (env.USER_DATA_DIR ?? '').trim();
  const dbp = (env.DB_PATH ?? '').trim();
  return {
    userDataDir: udd ? resolve(dir, udd) : join(dir, '.lpro-profile'),
    dbPath: dbp ? resolve(dir, dbp) : join(dir, 'bridge.db'),
    backupDir: join(dir, 'backups'),
  };
}
