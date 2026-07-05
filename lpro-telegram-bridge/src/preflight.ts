/**
 * 起動前チェックの本体。doctor.ts（CLI）と index.ts（起動時ガード。PM2 は npm を
 * 経由しないため prestart が走らず、ここで再チェックする）から使う。
 */
import 'dotenv/config';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

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

  // 3) SELECTORS の 'TODO' 残り
  const configPath = fileURLToPath(new URL('./config.ts', import.meta.url));
  const configSrc = readFileSync(configPath, 'utf8');
  const todoSelectors = [...configSrc.matchAll(/(\w+):\s*'TODO'/g)].map((m) => m[1]);
  if (todoSelectors.length > 0) {
    problems.push(`SELECTORS が未確定です（'TODO' のまま）: ${todoSelectors.join(', ')}`);
  }

  // 4) lpro-adapter の TODO（参考警告のみ）
  const adapterPath = fileURLToPath(new URL('./lpro-adapter.ts', import.meta.url));
  const adapterSrc = readFileSync(adapterPath, 'utf8');
  const todoCount = (adapterSrc.match(/TODO(?!\()/g) ?? []).length;
  if (todoCount > 0) {
    warnings.push(`lpro-adapter.ts に TODO が ${todoCount} 件あります（会話の開き方・送信検証を確認）`);
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
