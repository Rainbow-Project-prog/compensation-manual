import { cfg } from './config.js';
import { initBrowser } from './lpro-adapter.js';

console.log(`案件: ${cfg.instanceLabel || '既定'} / プロファイル: ${cfg.userDataDir}`);
await initBrowser();
console.log(
  cfg.instanceId
    ? `ログイン状態を保存しました。Ctrl+Cで終了 → \`pm2 start ecosystem.config.cjs --only lpro-bridge-${cfg.instanceId}\` で常駐開始してください（追加案件は npm start では起動しない）。`
    : 'ログイン状態を保存しました。Ctrl+Cで終了 → `npm start`（または pm2 start ecosystem.config.cjs --only lpro-bridge）で本起動してください。'
);
