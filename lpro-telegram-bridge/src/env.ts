/**
 * 案件（インスタンス）の解決と .env の読み込み。
 * ★他のどのモジュールよりも先に import されること★（config.ts / preflight.ts の先頭で import する）。
 *
 * 1つのコードベースで複数の案件（Lpro アカウント × Telegram Bot）を動かすため、案件ごとに
 * 「設定(.env)・ブラウザプロファイル・DB・バックアップ」を丸ごと分離したデータディレクトリを持つ:
 *   - 既定（案件名なし）: パッケージルート直下（.env / .lpro-profile / bridge.db / backups）
 *     ＝2026-07 から稼働している最初の案件。既存配置を一切動かさないための互換モード
 *   - 案件名あり:        instances/<案件名>/ 配下（.env / .lpro-profile / bridge.db / backups）
 *
 * 案件名は BRIDGE_INSTANCE 環境変数（PM2 の ecosystem.config.cjs が設定する）か、
 * CLI 引数 --instance=<案件名>（例: npm run login -- --instance=foo）で指定する。
 *
 * 案件ごとにプロセス（PM2 アプリ）を分ける理由: Telegram の long polling は Bot トークン1つに
 * つき1プロセスしか許されない（409 Conflict）ため、案件ごとに Bot を分けるのが最も単純で、
 * ブラウザ・ログインセッション・障害（ログイン待ち等）・DB も案件間で完全に隔離される
 * （ある案件のログイン待ちや Lpro 障害が他の案件の配信を止めない）。
 */
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import dotenv from 'dotenv';
import { INSTANCE_ID_RE, dataDirOf } from './paths.js';

function instanceFromArgv(): string | undefined {
  for (const a of process.argv.slice(2)) {
    const m = /^--instance=(.*)$/.exec(a);
    if (m) return m[1];
  }
  return undefined;
}

const rawId = (instanceFromArgv() ?? process.env.BRIDGE_INSTANCE ?? '').trim();
if (rawId !== '' && !INSTANCE_ID_RE.test(rawId)) {
  throw new Error(
    `案件名（BRIDGE_INSTANCE / --instance）が不正です: "${rawId}"（英数字で始まり、英数字・-・_ のみ、32文字以内）`
  );
}

/** 案件ID（'' = 既定＝パッケージルート配置） */
export const instanceId: string = rawId;
/** この案件のデータディレクトリ（.env / プロファイル / DB / バックアップの置き場） */
export const dataDir: string = dataDirOf(instanceId);
/** 読み込む .env の実パス（DOTENV_CONFIG_PATH で明示上書き可） */
export const envPath: string = process.env.DOTENV_CONFIG_PATH
  ? resolve(process.env.DOTENV_CONFIG_PATH)
  : join(dataDir, '.env');

if (!existsSync(envPath)) {
  // ここで止めないと config.ts の required() が「環境変数 ○○ が未設定」と出て、案件の取り違え
  // （名前のタイプミス・ディレクトリ未作成）に気付きにくい
  throw new Error(
    (instanceId ? `案件 "${instanceId}" の設定ファイルが見つかりません: ${envPath}` : `.env が見つかりません: ${envPath}`) +
    '（.env.example をコピーして作成してください）'
  );
}
// 既に設定済みの環境変数（PM2 の env 等）は上書きしない（dotenv の既定どおり）
dotenv.config({ path: envPath, quiet: true });
