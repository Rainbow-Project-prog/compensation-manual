/**
 * 起動前チェックの本体。doctor.ts（CLI）と index.ts（起動時ガード。PM2 は npm を
 * 経由しないため prestart が走らず、ここで再チェックする）から使う。
 */
import 'dotenv/config';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const REQUIRED_ENV = [
  'TELEGRAM_BOT_TOKEN',
  'GROUP_CHAT_ID',
  'LPRO_LOGIN_URL',
  'LPRO_TALK_URL',
] as const;

export type PreflightResult = { problems: string[]; warnings: string[] };

export function runDoctor(): PreflightResult {
  const problems: string[] = [];
  const warnings: string[] = [];

  // 0) Node バージョン（PM2 の `node --import tsx` 起動には 20.6+ が必要）
  const [maj = 0, min = 0] = process.versions.node.split('.').map(Number);
  if (maj < 20 || (maj === 20 && min < 6)) {
    problems.push(`Node ${process.versions.node} は古すぎます（20.6 以上が必要）`);
  }

  // 1) .env の存在
  const envPath = fileURLToPath(new URL('../.env', import.meta.url));
  if (!existsSync(envPath)) {
    problems.push('.env が見つかりません（.env.example をコピーして作成してください）');
  }

  // 2) 必須環境変数
  for (const k of REQUIRED_ENV) {
    const v = process.env[k];
    if (!v || v.trim() === '' || v.includes('（')) {
      problems.push(`環境変数 ${k} が未設定/プレースホルダのままです`);
    }
  }
  // GROUP_CHAT_ID は数値（-100...）であること
  const gid = process.env.GROUP_CHAT_ID;
  if (gid && gid.trim() !== '' && Number.isNaN(Number(gid))) {
    problems.push(`GROUP_CHAT_ID が数値ではありません（npm run chatid で取得した -100... を入れる）: ${gid}`);
  }
  // 数値系はタイプミス（NaN）が「初回メッセージの無音喪失」「ウェイトなし巡回」に直結するため事前に弾く
  for (const k of ['POLL_INTERVAL_MS', 'BOOTSTRAP_TAIL'] as const) {
    const raw = process.env[k];
    if (raw !== undefined && raw.trim() !== '' && !Number.isFinite(Number(raw))) {
      problems.push(`環境変数 ${k} が数値ではありません: ${raw}`);
    }
  }

  // better-sqlite3 のネイティブバイナリが現在の Node で動くこと
  // （Node のメジャー更新や npm ci の失敗で ABI 不一致になると起動時に落ちる）
  try {
    const require_ = createRequire(import.meta.url);
    const Database = require_('better-sqlite3');
    new Database(':memory:').close();
  } catch (e) {
    problems.push(
      `better-sqlite3 が現在の Node (${process.versions.node}) で動きません` +
      `（npm ci のやり直しが必要）: ${String(e).slice(0, 120)}`
    );
  }

  // 3) SELECTORS の 'TODO' 残り
  const configPath = fileURLToPath(new URL('./config.ts', import.meta.url));
  const configSrc = readFileSync(configPath, 'utf8');
  const todoSelectors = [...configSrc.matchAll(/(\w+):\s*'TODO'/g)].map((m) => m[1]);
  if (todoSelectors.length > 0) {
    problems.push(`SELECTORS が未確定です（'TODO' のまま）: ${todoSelectors.join(', ')}`);
  }

  // 4) lpro-adapter の未実装 TODO コメント（参考警告のみ）
  // ※ SELECTORS 確定後も残る `=== 'TODO'` センチネル比較を数えないよう、コメントの TODO だけ数える
  const adapterPath = fileURLToPath(new URL('./lpro-adapter.ts', import.meta.url));
  const adapterSrc = readFileSync(adapterPath, 'utf8');
  const todoCount = (adapterSrc.match(/\/\/\s*TODO|\/\*\s*TODO/g) ?? []).length;
  if (todoCount > 0) {
    warnings.push(`lpro-adapter.ts に未実装の TODO コメントが ${todoCount} 件あります（送信検証・会話の開き方を確認）`);
  }

  return { problems, warnings };
}

export function printResult(r: PreflightResult): void {
  console.log('=== Lpro ⇄ Telegram bridge doctor ===');
  if (r.warnings.length) {
    console.log('\n[warn]');
    for (const w of r.warnings) console.log('  - ' + w);
  }
  if (r.problems.length) {
    console.log('\n[NG] 起動前に解決が必要:');
    for (const p of r.problems) console.log('  ✗ ' + p);
    console.log('\n→ 解決後にもう一度 `npm run doctor` を実行してください。');
    return;
  }
  console.log('\n[OK] 必須項目はすべて揃っています。`npm start` で起動できます。');
}
