# Lpro ⇄ Telegram ブリッジ

Lpro のトーク応対画面を Playwright で自動操作し、新着を Telegram に流し、Telegram で打った返信を Lpro に書き戻すブリッジ。顧客1人 = 1トピックで取り違えを防ぐ。

- **次のセッション（家PCの Claude Code / Fable 5）はまず → [FABLE5_HANDOFF.md](./FABLE5_HANDOFF.md)**
- 詳細な背景・設計・リスク → [HANDOFF.md](./HANDOFF.md)（仕様書）
- 壊れたとき・困ったときの復旧手順 → [RUNBOOK.md](./RUNBOOK.md)（運用ランブック）

## 構成

```
lpro-telegram-bridge/
├─ README.md / HANDOFF.md / RUNBOOK.md / FABLE5_HANDOFF.md
├─ package.json / tsconfig.json
├─ .env.example          ← .env にコピーして記入
├─ ecosystem.config.cjs  ← PM2 常時起動設定（Windows対応）
├─ src/
│  ├─ config.ts          ← ★Lpro依存の SELECTORS はここだけ★
│  ├─ lpro-adapter.ts    ← ★Lpro自動操作（依存はここに隔離）★
│  ├─ telegram.ts        ← トピック管理・送受信（grammY）
│  ├─ db.ts              ← SQLite（顧客↔トピック↔既読）
│  ├─ queue.ts           ← Playwright操作の直列化
│  ├─ logic.ts           ← 配信判定の純関数（テスト対象）
│  ├─ preflight.ts       ← 起動前チェック本体
│  ├─ doctor.ts          ← 起動前チェック CLI
│  ├─ index.ts           ← 巡回ループ＋配線
│  ├─ login.ts           ← 初回ログイン（headedブラウザ）
│  └─ chatid.ts          ← グループの chat_id 取得
└─ test/
   └─ logic.test.ts      ← 配信判定の単体テスト
```

## セットアップ（家の常時起動PCで実行）

> ⚠️ 本番稼働は家のPCで行うこと。初回ログインは2FAを手動で通すため headed ブラウザが必要、
> ログインセッション（`.lpro-profile`）とDB（`bridge.db`）は常時起動マシンに永続させる。
> Node.js は **20.6 以上**（Node 24 も可。better-sqlite3 は v12 系で Node 24 プリビルド対応済み）。

```bash
# 1) 依存インストール
npm i
npx playwright install chromium

# 2) .env を用意
cp .env.example .env
#    TELEGRAM_BOT_TOKEN / LPRO_LOGIN_URL / LPRO_TALK_URL を記入

# 3) DOMセレクタを埋める（★ログインより先★）
#    src/config.ts の SELECTORS（少なくとも loggedInMarker）を埋めないと
#    npm run login が「SELECTORS.loggedInMarker が未設定です」と即エラーで止まる。
#    → HANDOFF.md「6. DOM収集」を参照

# 4) Lpro 初回ログイン（ブラウザが開く。2FAも手動で通す）
npm run login

# 5) Telegram グループの chat_id を取得（※ブリッジ本体と同時実行しない）
npm run chatid
#    表示された -100... を .env の GROUP_CHAT_ID に記入

# 6) 事前チェック → 本起動
npm run doctor
npm start
```

> `npm start` 実行時は自動で `npm run doctor`（事前チェック）が走り、`.env` 未記入や
> SELECTORS の `'TODO'` 残りがあると起動前に止まる。PM2 起動時も index.ts が同じチェックを行う。

常時起動（任意）:

```bash
npm i -g pm2
pm2 start ecosystem.config.cjs   # 自動再起動つき（restart_delay 5s / max_restarts 10）
pm2 save
# OS起動時の自動立ち上げ（Windows は `pm2 startup` 非対応。RUNBOOK 参照）:
#   npm i -g pm2-windows-startup && pm2-startup install
```

## npm スクリプト

| コマンド | 説明 |
|---------|------|
| `npm run doctor` | 起動前チェック。`.env` の必須項目・SELECTORS の `'TODO'` 残り・Node バージョンを検出（`npm start` 時に自動実行） |
| `npm start` | 本起動（巡回ループ）。ブラウザクラッシュ時は自動再起動、セッション切れ疑い時は再ログイン待ち |
| `npm run login` | Lpro 初回ログイン（headedブラウザ。SELECTORS を埋めてから実行） |
| `npm run chatid` | Telegram グループの chat_id 取得（本体停止中に実行） |
| `npm test` | 配信判定ロジック（`src/logic.ts`）の単体テスト |
| `npm run typecheck` | `tsc --noEmit` で型チェック（src + test） |

## 動作の要点

- **起動時ブートストラップ**: 全会話の既読基準を最初に記録（過去ログは配らない）。
  ただし**未読の未登録会話**は既読化せず巡回に委ねる（停止中に届いた初回接触メッセージを消さないため）。
- **稼働中・停止中の新規顧客**: 末尾 `BOOTSTRAP_TAIL` 件（既定5）だけ配信して初回メッセージの取りこぼしを防ぐ。
- **返信後の即時取り込み**: 返信で会話を開くと Lpro の未読が消えるため、返信直後にその会話だけ再読して新着を拾う。
- **トピックは配信時に作成**（空トピックを量産しない）。閉じられていたら自動で開き直し、
  削除されていたら次回配信時に作り直す。
- **1会話の失敗は他の会話に波及しない**。送信は1件ごとに既読を進め、途中失敗でも重複配信しない。
