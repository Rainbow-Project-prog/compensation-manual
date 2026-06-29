// PM2 常時起動設定: `pm2 start ecosystem.config.cjs`
// 起動: pm2 start ecosystem.config.cjs / 保存: pm2 save / 自動起動: pm2 startup
// ログ: pm2 logs lpro-bridge / 再起動: pm2 restart lpro-bridge
module.exports = {
  apps: [
    {
      name: 'lpro-bridge',
      script: 'npm',
      args: 'start',
      cwd: __dirname,
      autorestart: true,
      // クラッシュ時は5秒待って再起動。短時間に連続クラッシュしたら止める
      restart_delay: 5000,
      max_restarts: 10,
      min_uptime: '30s',
      // headed ブラウザを使う場合はデスクトップセッションが必要
      // （Windowsならログオン状態のユーザーで起動すること）
      env: {
        NODE_ENV: 'production',
      },
      time: true, // ログにタイムスタンプを付与
    },
  ],
};
