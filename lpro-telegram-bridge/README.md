# Lpro ⇄ Telegram ブリッジ

Lpro のトーク応対画面を Playwright で自動操作し、新着を Telegram に流し、Telegram で打った返信を Lpro に書き戻すブリッジ。顧客1人 = 1トピックで取り違えを防ぐ。

- 詳細な背景・設計・リスク → [HANDOFF.md](./HANDOFF.md)（仕様書）
- 壊れたとき・困ったときの復旧手順 → [RUNBOOK.md](./RUNBOOK.md)（運用ランブック）

## 構成

```
lpro-telegram-bridge/
├─ package.json
├─ tsconfig.json
├─ .env.example          ← .env にコピーして記入
└─ src/
   ├─ config.ts          ← ★Lpro依存の SELECTORS はここだけ★
   ├─ db.ts              ← SQLite（顧客↔トピック↔既読）
   ├─ queue.ts           ← Playwright操作の直列化
   ├─ telegram.ts        ← トピック管理・送受信（grammY）
   ├─ lpro-adapter.ts    ← ★Lpro自動操作（依存はここに隔離）★
   ├─ chatid.ts          ← グループの chat_id 取得
   ├─ login.ts           ← 初回ログイン（headedブラウザ）
   └─ index.ts           ← 巡回ループ＋配線
```

## セットアップ（家の常時起動PCで実行）

> ⚠️ 本番稼働は家のPCで行うこと。初回ログインは2FAを手動で通すため headed ブラウザが必要、
> ログインセッション（`.lpro-profile`）とDB（`bridge.db`）は常時起動マシンに永続させる。

```bash
# 1) 依存インストール
npm i
npx playwright install chromium

# 2) .env を用意
cp .env.example .env
#    TELEGRAM_BOT_TOKEN / LPRO_LOGIN_URL / LPRO_TALK_URL を記入

# 3) Lpro 初回ログイン（ブラウザが開く。2FAも手動で通す）
npm run login

# 4) Telegram グループの chat_id を取得（対象グループでメッセージを送る）
npm run chatid
#    表示された -100... を .env の GROUP_CHAT_ID に記入

# 5) DOMセレクタを埋める（src/config.ts の SELECTORS と adapter の TODO）
#    → HANDOFF.md「6. DOM収集」を参照

# 6) 本起動
npm start
```

> `npm start` 実行時は自動で `npm run doctor`（事前チェック）が走り、`.env` 未記入や
> SELECTORS の `'TODO'` 残りがあると起動前に止まる。

常時起動（任意）:

```bash
npm i -g pm2
pm2 start ecosystem.config.cjs   # 自動再起動つき（restart_delay 5s / max_restarts 10）
pm2 save
pm2 startup                       # OS起動時の自動立ち上げ（任意）
```

## npm スクリプト

| コマンド | 説明 |
|---------|------|
| `npm run doctor` | 起動前チェック。`.env` の必須項目と SELECTORS の `'TODO'` 残りを検出（`npm start` 時に自動実行） |
| `npm start` | 本起動（巡回ループ）。poll エラー時はセッション切れを疑い自動で再ログインを試みる |
| `npm run login` | Lpro 初回ログイン（headedブラウザ） |
| `npm run chatid` | Telegram グループの chat_id 取得 |
| `npm test` | 配信判定ロジック（`src/logic.ts`）の単体テスト |
| `npm run typecheck` | `tsc --noEmit` で型チェック |

## やること（DOMセレクタ確定）

`src/config.ts` の `SELECTORS` が全部 `'TODO'` の状態。Lpro のトーク応対画面で
F12 → 要素を調べて埋める。あわせて `src/lpro-adapter.ts` の以下の TODO を確定:

- 顧客キーの取り出し（一意属性 or 表示名）
- 会話の開き方（行クリック or URL直開き）

詳しくは HANDOFF.md「6. DOM収集」「7. 動作確認チェックリスト」。
