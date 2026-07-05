// PM2 常時起動設定: `pm2 start ecosystem.config.cjs`
// ログ: pm2 logs lpro-bridge / 再起動: pm2 restart lpro-bridge / 停止: pm2 stop lpro-bridge
//
// Windows での注意:
// - `script: 'npm'` は Windows の PM2 で動かないため、node + tsx で直接起動する。
//   npm を経由しないので prestart(doctor) は走らないが、index.ts が起動時に同じチェックを行う。
// - Windows では SIGINT/SIGTERM が届かないため shutdown_with_message で 'shutdown'
//   メッセージを送らせ、index.ts 側の process.on('message') で終了処理する。
// - OS 起動時の自動立ち上げ: `pm2 startup` は Windows 非対応。
//   `npm i -g pm2-windows-startup && pm2-startup install` またはタスクスケジューラを使う（RUNBOOK 参照）。
// - headed ブラウザ（HEADLESS=false）はログオン中のデスクトップセッションが必要。
module.exports = {
  apps: [
    {
      name: 'lpro-bridge',
      script: 'src/index.ts',
      interpreter: 'node',
      interpreter_args: '--import tsx', // Node 20.6+ 必須
      cwd: __dirname,
      autorestart: true,
      // クラッシュ時は5秒待って再起動。短時間に連続クラッシュしたら止める
      restart_delay: 5000,
      max_restarts: 10,
      min_uptime: '30s',
      // 終了処理（ブラウザ/DBクローズ）の猶予。これを超えると強制kill
      kill_timeout: 15000,
      shutdown_with_message: true,
      env: {
        NODE_ENV: 'production',
      },
      time: true, // ログにタイムスタンプを付与
    },
  ],
};
