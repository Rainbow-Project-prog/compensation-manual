# Lpro ⇄ Telegram ブリッジ 構築ドキュメント（Claude Code 引き継ぎ用）

> このファイルはそのまま Claude Code（デスクトップ／ターミナル）に渡して着手できる引き継ぎ＝仕様書です。
> claude.ai の会話履歴は引き継がれないため、必要な文脈はすべてこのファイルに入っています。

---

## 0. Claude Code への最初の指示

> **【更新】ファイル一式は既に実装済み**（クラウドセッションで作成・レビュー・修正済み）。
> このセクションの旧指示（ファイル作成から始める）は完了しているため使わないこと。
> **次のセッションはまず [FABLE5_HANDOFF.md](./FABLE5_HANDOFF.md) を読んで着手する。**
> そちらに「事前レビューで確定した指摘と対応状況」「残タスク」「レビュー観点」がまとまっている。

---

## 1. 背景（これが何で、なぜこの作り方か）

- 運用中の「Lpro」は LINE 公式アカウントの拡張ツールだが、内部構造が特殊：
  **同名の無料公式LINEアカウントを1000個以上複製し、垢BAN対策で1アカウント3人ずつ自動振り分け**している（無料枠の月200通制限を3人でシェア）。
- そのため顧客ごとに裏側のアカウントがバラバラで、LINE純正の公式アカウントアプリでの一元的な1対1チャットは不可能。個別対応は **Lpro 内の「トーク応対／ダイレクトトーク」画面に集約**されている。
- Lpro は **PC（ブラウザ）専用・公開APIなし**。
- 目的：**スマホから顧客対応をガンガンやりたい**。
- 方針：APIが無いので Lpro のトーク応対画面を **Playwright で自動操作**し、新着を **Telegram** に流し、Telegram で打った返信を Lpro に書き戻す。Telegram のフォーラム「トピック」で **顧客1人 = 1スレッド**にして取り違えを防ぐ。

### 設計原則
- **壊れやすい半分（Lpro 依存）を1ファイルに隔離**（`src/lpro-adapter.ts` と `src/config.ts` の SELECTORS）。Lpro の UI が変わってもここだけ直せば復旧できる。
- 残り（Telegram・DB・巡回ループ）は Lpro に依存しないので安定。

### リスク（承知の上で進める前提・記録として）
- Lpro の大量アカウント複製運用は LINE 利用規約に反し、一括凍結リスクが常にある。
- この自動操作も Lpro の利用規約に抵触する恐れがある。UI 変更で壊れる前提で、保守はセレクタ修正のみで済む構成にしてある。
- 顧客の会話データを外部（Telegram）へ流すため、取り扱い・管理責任が生じる。グループは非公開・最小メンバーで運用すること。

---

## 2. アーキテクチャ

```
スマホ（Telegramアプリ）
   ⇅  顧客1人=1トピックで送受信
ブリッジ常駐（Node + TypeScript）  ← あなたのPCで常時起動
   ├─ telegram.ts  : トピック管理・送受信（grammY / long polling、公開URL不要）
   ├─ lpro-adapter.ts : Playwright で Lpro を自動操作（★Lpro依存はここだけ★）
   ├─ db.ts        : SQLite（顧客↔トピック↔既読ハッシュ台帳）
   ├─ queue.ts     : Playwright操作を直列化（巡回と送信の衝突防止）
   └─ index.ts     : 巡回ループ＋配線
   ⇅  ログイン状態を永続化して自動操作
Lpro（トーク応対画面・ブラウザ管理画面）
```

- **新着検知**：顧客行（`tr.rowitem`）を巡回 → 行内の会話履歴を読み → 会員ID+日時+本文のハッシュを台帳（`seen_messages`）と照合し、未知分だけ Telegram へ。
- **返信反映**：Telegram のトピックで打つ → スレッドIDから顧客特定 → Lpro の該当会話に自動入力＆送信。
- **取り違え防止**：顧客ごとに専用トピック。
- **過去ログのスパム防止**：起動時に全会話の既読基準を記録し、過去ログは配らない。停止中・稼働中に初めて現れた（＝いま送ってきた）会話だけは末尾 `BOOTSTRAP_TAIL` 件（既定5）を配信して初回メッセージの取りこぼしを防ぐ（§8参照）。

---

## 3. セットアップ

### 3.1 前提
- Node.js **20.6 以上**（PM2 が `node --import tsx` で起動するため。doctor がチェックする。
  Node 24 でも可 — better-sqlite3 は v12 系にしてあり Node 24 のプリビルドがある）
- Windows（VS Code）。常時起動は PM2 もしくはタスクスケジューラ。
- 初回ログインは画面表示（headed）で行う。2FA があっても初回だけ手動で通せばよい（以降はセッション永続）。

### 3.2 Telegram 側の準備（手作業）
1. Telegram で **@BotFather** → `/newbot` → トークン取得（`TELEGRAM_BOT_TOKEN`）。
2. 新規 **スーパーグループ**を作成し、グループ設定で **「トピック（Topics）」を ON**。
3. 作成した bot をそのグループに**管理者**として追加し、**「トピックの管理（Manage Topics）」権限を付与**。
4. グループの `chat_id` を後述の `npm run chatid` で取得（`-100...` の数値）。

### 3.3 ファイル構成
```
lpro-telegram-bridge/
├─ README.md / RUNBOOK.md / FABLE5_HANDOFF.md ← 各ドキュメント（本書 = HANDOFF.md）
├─ review/               ← レビュー記録（PRE_REVIEW_FINDINGS.md / RE_REVIEW_2026-07-10.md）
├─ package.json
├─ tsconfig.json
├─ .env                  ← .env.example をコピーして記入
├─ ecosystem.config.cjs  ← PM2 常時起動設定
├─ src/
│  ├─ config.ts          ← SELECTORS（Lpro依存の集約点）
│  ├─ db.ts
│  ├─ queue.ts
│  ├─ logic.ts           ← 配信判定の純関数
│  ├─ preflight.ts       ← 起動前チェック本体
│  ├─ doctor.ts          ← 起動前チェック CLI
│  ├─ telegram.ts
│  ├─ lpro-adapter.ts
│  ├─ chatid.ts
│  ├─ login.ts
│  └─ index.ts
└─ test/
   └─ logic.test.ts
```

### 3.4 インストール
```bash
npm i
npx playwright install chromium
```

---

## 4. コード

実際のコードは本ディレクトリの `package.json` / `tsconfig.json` / `.env.example` / `src/` 配下に
そのまま実装済み。仕様の詳細は各ファイルのコメントを参照。

> 補足：`readInbound` は各メッセージの日時（`.mmsgdt`）を用いた **フィンガープリント方式**で実装済み
> （`logic.ts` `decideDeliveryBySeen` / `db.ts` `seen_messages`）。リスト仮想化・同数入れ替わりに耐える。

---

## 5. 起動手順

```bash
# 1) 依存インストール
npm i
npx playwright install chromium

# 2) .env を用意
cp .env.example .env
#    TELEGRAM_BOT_TOKEN / LPRO_LOGIN_URL / LPRO_TALK_URL を記入

#    （DOM セレクタは完了済み。UI変更時のみ RUNBOOK A）

# 3) 事前チェック（.env / SELECTORS / Node バージョン）
npm run doctor

# 4) Lpro に初回ログイン（ブラウザが開く。2FAも手動で通す）
npm run login

# 5) Telegram グループの chat_id を取得（※ブリッジ本体と同時実行しない）
npm run chatid
#    表示された -100... を .env の GROUP_CHAT_ID に記入

# 6) 本起動
npm start
```

常時起動（任意）：
```bash
npm i -g pm2
pm2 start ecosystem.config.cjs   # ※ `pm2 start npm -- start` は Windows で動かない
pm2 save
```
※ headed ブラウザはデスクトップセッションが必要。ログイン確立後に `HEADLESS=true` でも動くことが多いが、もし弾かれるなら headed のまま運用する。
※ Windows の自動起動・停止シグナルの注意は RUNBOOK.md「E. プロセスが落ちる / 常時起動」を参照。

---

## 6. DOM 収集（ユーザー作業・2分）

> **【完了済み】** この収集は 2026-07-11 に `npm run dump`（全フレームのHTMLを `dump/` に自動保存する診断ツール）で実施済み。
> 再収集が必要になるのは Lpro の UI 変更時のみで、その場合も `npm run dump` を使うのが確実。
> 以下のリストは参考として残す。

Lpro のトーク応対画面で F12 を開き、以下を右クリック → Copy → **Copy outerHTML** して Claude Code に貼る：

1. 会話一覧（左の顧客リスト）の **1件分の行**
2. メッセージ **吹き出し1つ分**（できれば「顧客の発言」と「自分の発言」を1つずつ）
3. **返信の入力欄**＋**送信ボタン**
4. **トーク応対画面にだけ存在する要素**（画面タイトル・一覧のコンテナ等。ログイン判定
   `loggedInMarker` に使う。1の行の親コンテナでも可）

加えて口頭で：
- 未読会話の見分け方（バッジ／太字／色 など）
- 会話を開く操作（行クリックで開く？ URL で直接開ける？）
- メッセージ要素に一意IDや時刻属性があるか（あれば重複排除を堅牢化）
- **会話一覧は全件が一度に描画されるか**、スクロールで遅延読み込み／ページ分割されるか
  （遅延読み込みだと画面外の未読を取りこぼすため対策が必要）
- **会話を開くと顧客側の LINE に「既読」が付くか**（付くなら、人が読んでいないのに
  既読になる＝接客上の副作用。運用判断が必要）
- 会話行の一意ID属性は**顧客に紐づくか、裏側の振り分けアカウントに紐づくか**
  （Lpro のアカウントローテーションでキーが変わると顧客1人に複数トピックができる）

これらを貼れば、Claude Code が SELECTORS と TODO を確定できる。

---

## 7. 動作確認チェックリスト

- [ ] `npm run login` でトーク応対画面まで到達、`loggedInMarker` を検出
- [ ] `pollConversations()` が会話一覧と未読フラグを正しく返す（単体で console.log してテスト）
- [ ] `readInbound()` が顧客発言だけを抽出できる（自分の発言を拾わない）
- [ ] 新着が該当トピックに届く／既存顧客の過去ログが流れない（初回接触の会話だけ末尾 `BOOTSTRAP_TAIL` 件届く）
- [ ] トピックで打った返信が Lpro の正しい会話に送信される
- [ ] 別顧客のトピックで打って取り違えが起きない

---

## 8. 既知の注意点・将来改善

- **新着検知はフィンガープリント方式**（`seen_messages` 台帳）で実装済み。同数入れ替わり
  （1件消えて1件増える）・履歴窓のズレでも取りこぼし／再配信は起きない
  （`test/logic.test.ts` に回帰テスト有）。
- 顧客キーは **会員ID**（`SELECTORS.memberIdText` の完全一致、アカバンでも不変）を使う。
  顧客名や行全文をキーにしてはならない（同名衝突・プレビュー変化でキーが揺れ、
  顧客1人に複数トピックができる）。
- ポーリングは「未読のみ巡回」（`ONLY_UNREAD=true`）が軽い。全件巡回は会話数が多いと遅くなる。
- 画像・スタンプ等の非テキストは本実装では未対応（テキスト返信が主目的）。Telegram 側で打った
  非テキストには「送信できない」旨を自動返信する。転送対応は将来拡張。
- ~~セッション切れ時の自動再ログイン待ちを poll エラー時に挟むと安定する~~ → **実装済み**
  （poll エラー時の `ensureLoggedIn`、ブラウザクラッシュ時の自動再起動を含む）。
- 初回メッセージの取りこぼし防止のため、起動時に全会話をブートストラップし、稼働中に初めて
  現れた会話は末尾 `BOOTSTRAP_TAIL` 件だけ配信する（「初回は一切配らない」から仕様変更。
  過去ログ全量スパムは引き続き防止される）。
