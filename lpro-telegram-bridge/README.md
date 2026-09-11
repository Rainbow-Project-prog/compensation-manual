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
│  ├─ env.ts             ← 案件（インスタンス）の解決と .env 読み込み（最初に import される）
│  ├─ paths.ts           ← 案件のデータ配置規則（純関数）
│  ├─ instances.ts       ← 複数案件の列挙・案件間の設定競合の検出
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
   ├─ logic.test.ts      ← 配信判定の単体テスト
   └─ instances.test.ts  ← 案件間の競合ルール・データ配置規則の単体テスト
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
#    TELEGRAM_BOT_TOKEN / LPRO_LOGIN_URL / LPRO_BASIC_USER / LPRO_BASIC_PASS と、
#    受信箱ごとの CHAT_TALK_URL・CHAT_GROUP_CHAT_ID（＋使うなら TALK_TALK_URL・TALK_GROUP_CHAT_ID）を記入
#    （各受信箱は URL とグループID の両方が揃うと有効。少なくとも1つ必要）

#    （完了済み）SELECTORS は 2026-07-11 の実機DOM（npm run dump）で確定済み。
#    通常は編集不要（Lpro の UI 変更時のみ RUNBOOK A 参照）。

# 3) Lpro 初回ログイン（ブラウザが開く。2FAも手動で通す）
npm run login

# 4) Telegram グループの chat_id を取得（※ブリッジ本体と同時実行しない）
#    受信箱ごとにグループを作り、同じ bot を両方に管理者（トピック管理権限）で追加しておく
npm run chatid
#    各グループの chat_id を取得し、チャット応対グループのIDを CHAT_GROUP_CHAT_ID、
#    ダイレクトトーク応対グループのIDを TALK_GROUP_CHAT_ID に記入

# 5) 事前チェック → 本起動
npm run doctor
npm start
```

> 起動時は index.ts が `npm run doctor` と同じ事前チェックを行い、`.env` 未記入や
> SELECTORS の `'TODO'` 残り、他案件との設定競合があると起動前に止まる（PM2 起動時も同じ）。

常時起動（任意）:

```bash
npm i -g pm2
pm2 start ecosystem.config.cjs --only lpro-bridge   # 既定案件だけ起動（引数なしは全案件を再起動するので使わない）
pm2 save
# OS起動時の自動立ち上げ（Windows は `pm2 startup` 非対応。RUNBOOK 参照）:
#   npm i -g pm2-windows-startup && pm2-startup install
```

## npm スクリプト

| コマンド | 説明 |
|---------|------|
| `npm run doctor` | 起動前チェック。`.env` の必須項目・SELECTORS の `'TODO'` 残り・Node バージョン・他案件との設定競合を検出（index.ts 起動時にも同じチェックが走る） |
| `npm start` | 本起動（巡回ループ）。ブラウザクラッシュ時は自動再起動、セッション切れ疑い時は再ログイン待ち |
| `npm run login` | Lpro 初回ログイン（headedブラウザ） |
| `npm run chatid` | Telegram グループの chat_id 取得（本体停止中に実行） |
| `npm run dump` | トーク画面の実DOMを `dump/` に保存する診断ツール（UI変更時のセレクタ復旧用） |
| `npm test` | 配信判定ロジック（`src/logic.ts`）と案件間の競合ルール（`src/instances.ts`）の単体テスト |
| `npm run typecheck` | `tsc --noEmit` で型チェック（src + test） |

## 複数案件の運用（2026-09-07〜）

1つのコードベースで複数の案件（Lpro アカウント × Telegram Bot）を同時に動かせる。案件ごとに
「設定 / ブラウザプロファイル / DB / バックアップ」を丸ごと分離し、プロセス（PM2 アプリ）も分ける。

```
lpro-telegram-bridge/
├─ .env / .lpro-profile/ / bridge.db / backups/ / .lpro-session  ← 既定案件（最初の案件）。従来どおり・PM2 名 lpro-bridge
└─ instances/
   └─ <案件名>/                                    ← 追加案件（案件名は英数字・-・_ のみ）。PM2 名 lpro-bridge-<案件名>
      ├─ .env                                      ← .env.example をコピーして記入（INSTANCE_LABEL に表示名）
      └─ .lpro-profile/ bridge.db backups/ dump/ .lpro-session  ← 自動生成（.lpro-session はログイン Cookie の退避。DPAPI 暗号化）
```

- 案件の選択: PM2 は `BRIDGE_INSTANCE=<案件名>`（`ecosystem.config.cjs` が instances/ を見て自動付与。**シェルで手動設定しない**）、
  CLI は `npm run <script> -- --instance=<案件名>`（doctor / chatid / login / dump。`npm start` は既定案件専用）
- 案件ごとに **別の Telegram Bot**（BotFather）と **別のグループ2つ**を用意する。同じトークン・グループ・
  プロファイル・DB を2案件で使う設定は `npm run doctor` と起動時ガードが検出して止める（409 ループ／別案件への誤送信の防止）
- 運用通知（💓・⚠️）には `[表示名]` が付く。ログイン待ちのブラウザには赤いバナー「【表示名】このウィンドウで…」が出る
- 追加手順の詳細は RUNBOOK G章。

## 動作の要点

- **2受信箱＝2グループ**: Lpro には独立した2つの受信箱がある。①チャット応対（自動応答なし・全部手動）
  ②ダイレクトトーク応対（基本は自動応答だが取りこぼしを拾う）。それぞれ **別の Telegram グループ**へ配信し、
  返信は必ず元の受信箱・元のグループへ戻る（顧客キーは内部で `受信箱ID:会員ID`）。使う受信箱だけ
  `CHAT_*` / `TALK_*` を設定すればよい（両方でも片方でも可、最低1つ）。
- **起動時ブートストラップ**: 全会話の既読基準を最初に記録（過去ログは配らない）。
  ただし**未読の未登録会話**は既読化せず巡回に委ねる（停止中に届いた初回接触メッセージを消さないため）。
- **稼働中・停止中の新規顧客**: 末尾 `BOOTSTRAP_TAIL` 件（既定5）だけ配信して初回メッセージの取りこぼしを防ぐ。
- **返信後の即時取り込み**: 返信で会話を開くと Lpro の未読が消えるため、返信直後にその会話だけ再読して新着を拾う。
- **トピックは配信時に作成**（空トピックを量産しない）。閉じられていたら自動で開き直し、
  削除されていたら次回配信時に作り直す。
- **1会話の失敗は他の会話に波及しない**。送信は1件ごとに既読を進め、途中失敗でも重複配信しない。
