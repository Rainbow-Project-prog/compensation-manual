// PM2 常時起動設定。
//   全案件を登録:        pm2 start ecosystem.config.cjs
//   特定の案件だけ追加:  pm2 start ecosystem.config.cjs --only lpro-bridge-<案件名>
//   ログ / 再起動 / 停止: pm2 logs <アプリ名> / pm2 restart <アプリ名> / pm2 stop <アプリ名>
//   ※ 稼働中の案件があるときに引数なしの `pm2 start ecosystem.config.cjs` を打つと、その案件も
//     再起動される（RUNBOOK の安全な再起動手順を踏まない再起動になる）。追加は必ず --only で行うこと。
//
// 複数案件（インスタンス）:
//   - 既定案件（ルートの .env / .lpro-profile / bridge.db。最初の案件）は従来どおりアプリ名「lpro-bridge」
//     （dump.pm2・ログオン時の自動復帰との互換のため名前を変えない）
//   - instances/<案件名>/.env があるディレクトリごとに、アプリ名「lpro-bridge-<案件名>」を自動で並べる。
//     BRIDGE_INSTANCE=<案件名> を渡すと src/env.ts がそのディレクトリの .env / プロファイル / DB を使う。
//   - 案件ごとに Telegram Bot（トークン）を分けること（同じトークンの2プロセスは 409 Conflict で交互に落ちる。
//     doctor が起動前に検出して止める）。
//
// Windows での注意:
// - `script: 'npm'` は Windows の PM2 で動かないため、node + tsx で直接起動する。
//   npm を経由しないので prestart(doctor) は走らないが、index.ts が起動時に同じチェックを行う。
// - Windows では SIGINT/SIGTERM が届かないため shutdown_with_message で 'shutdown'
//   メッセージを送らせ、index.ts 側の process.on('message') で終了処理する。
// - OS 起動時の自動立ち上げ: `pm2 startup` は Windows 非対応。
//   `pm2 save` した一覧をログオン時に `pm2 resurrect` で復元する（~/.pm2/pm2_resurrect.cmd。RUNBOOK E章）。
//   案件を追加したら必ず `pm2 save` すること（しないと次回ログオン時に復元されない）。
// - headed ブラウザ（HEADLESS=false）はログオン中のデスクトップセッションが必要。
const fs = require('node:fs');
const path = require('node:path');

const base = {
  script: 'src/index.ts',
  interpreter: 'node',
  interpreter_args: '--import tsx', // Node 20.6+ 必須
  cwd: __dirname,
  autorestart: true,
  // クラッシュ時は5秒待って再起動。短時間に連続クラッシュしたら止める
  restart_delay: 5000,
  max_restarts: 10,
  min_uptime: '30s',
  // 終了処理（実行中の返信の排水 最大20+5秒 → bot/ブラウザ/DBクローズ）の猶予。これを超えると強制kill
  kill_timeout: 40000,
  shutdown_with_message: true,
  time: true, // ログにタイムスタンプを付与
};

const apps = [];

// 既定案件（ルート配置）。ルートに .env が無ければ登録しない（全案件を instances/ に置く構成も許す）。
// BRIDGE_INSTANCE は明示的に空にする: PM2 は起動時にシェルの環境変数を丸ごと取り込むため、シェルに
// BRIDGE_INSTANCE が残っていると既定案件が別案件として立ち上がってしまう（ecosystem の env が優先される）
if (fs.existsSync(path.join(__dirname, '.env'))) {
  apps.push({ ...base, name: 'lpro-bridge', env: { NODE_ENV: 'production', BRIDGE_INSTANCE: '' } });
}

// 追加案件: instances/<案件名>/.env（案件名の規則は src/paths.ts の INSTANCE_ID_RE と同じ）
const instDir = path.join(__dirname, 'instances');
if (fs.existsSync(instDir)) {
  for (const d of fs.readdirSync(instDir, { withFileTypes: true })) {
    if (!d.isDirectory() || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/.test(d.name)) continue;
    if (!fs.existsSync(path.join(instDir, d.name, '.env'))) continue;
    apps.push({
      ...base,
      name: `lpro-bridge-${d.name}`,
      env: { NODE_ENV: 'production', BRIDGE_INSTANCE: d.name },
    });
  }
}

module.exports = { apps };
