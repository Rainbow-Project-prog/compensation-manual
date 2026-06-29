# Lpro ⇄ Telegram ブリッジ 構築ドキュメント（Claude Code 引き継ぎ用）

> このファイルはそのまま Claude Code（デスクトップ／ターミナル）に渡して着手できる引き継ぎ＝仕様書です。
> claude.ai の会話履歴は引き継がれないため、必要な文脈はすべてこのファイルに入っています。

---

## 0. Claude Code への最初の指示（このままコピペでOK）

```
このリポジトリは「Lpro ⇄ Telegram ブリッジ」を作るプロジェクトです。
まず本ドキュメント全体を読んでください。その上で:
1. 「3. セットアップ」のファイル一式を作成（コードはこのドキュメントのものをそのまま使用）
2. `npm i` と `npx playwright install chromium` を実行
3. 私（ユーザー）が後で Lpro の DOM 断片を貼るので、src/config.ts の SELECTORS と
   src/lpro-adapter.ts の TODO（顧客キー取り出し・会話の開き方）を一緒に埋める
4. `npm run login` → `npm run chatid` → `npm start` の順で動作確認を手伝う
私の環境は Windows + VS Code + Node.js です。
```

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
   ├─ db.ts        : SQLite（顧客↔トピック↔既読件数のマッピング）
   ├─ queue.ts     : Playwright操作を直列化（巡回と送信の衝突防止）
   └─ index.ts     : 巡回ループ＋配線
   ⇅  ログイン状態を永続化して自動操作
Lpro（トーク応対画面・ブラウザ管理画面）
```

- **新着検知**：トーク応対を巡回 → 未読の会話を開く → 相手発言を読む → 既読件数を超えた分だけ Telegram へ。
- **返信反映**：Telegram のトピックで打つ → スレッドIDから顧客特定 → Lpro の該当会話に自動入力＆送信。
- **取り違え防止**：顧客ごとに専用トピック。初回はその顧客の既存履歴を配らず既読扱い（過去ログのスパムを防ぐ）。

---

## 3. セットアップ

### 3.1 前提
- Node.js 20+ 推奨
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
├─ package.json
├─ tsconfig.json
├─ .env                  ← .env.example をコピーして記入
└─ src/
   ├─ config.ts
   ├─ db.ts
   ├─ queue.ts
   ├─ telegram.ts
   ├─ lpro-adapter.ts
   ├─ chatid.ts
   ├─ login.ts
   └─ index.ts
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

> 補足：`readInbound` は「既読件数を超えた分だけ配る」前提の **件数ベース**で実装している。
> もし Lpro のメッセージ要素に**一意ID やタイムスタンプ属性**があるなら、それをキーにした重複排除に差し替える方が堅牢（リスト仮想化対策）。`db.ts` に `seen_messages(hash)` テーブルを足す方式に変更する。

---

## 5. 起動手順

```bash
# 1) 依存インストール
npm i
npx playwright install chromium

# 2) Lpro に初回ログイン（ブラウザが開く。2FAも手動で通す）
npm run login

# 3) Telegram グループの chat_id を取得（対象グループでメッセージを送る）
npm run chatid
#    表示された -100... を .env の GROUP_CHAT_ID に記入

# 4) DOM セレクタを埋める（src/config.ts の SELECTORS と adapter の TODO）
#    → 「6. DOM収集」を参照

# 5) 本起動
npm start
```

常時起動（任意）：
```bash
npm i -g pm2
pm2 start npm --name lpro-bridge -- start
pm2 save
```
※ headed ブラウザはデスクトップセッションが必要。ログイン確立後に `HEADLESS=true` でも動くことが多いが、もし弾かれるなら headed のまま運用する。

---

## 6. DOM 収集（ユーザー作業・2分）

Lpro のトーク応対画面で F12 を開き、以下を右クリック → Copy → **Copy outerHTML** して Claude Code に貼る：

1. 会話一覧（左の顧客リスト）の **1件分の行**
2. メッセージ **吹き出し1つ分**（できれば「顧客の発言」と「自分の発言」を1つずつ）
3. **返信の入力欄**＋**送信ボタン**

加えて口頭で：
- 未読会話の見分け方（バッジ／太字／色 など）
- 会話を開く操作（行クリックで開く？ URL で直接開ける？）
- メッセージ要素に一意IDや時刻属性があるか（あれば重複排除を堅牢化）

これらを貼れば、Claude Code が SELECTORS と TODO を確定できる。

---

## 7. 動作確認チェックリスト

- [ ] `npm run login` でトーク応対画面まで到達、`loggedInMarker` を検出
- [ ] `pollConversations()` が会話一覧と未読フラグを正しく返す（単体で console.log してテスト）
- [ ] `readInbound()` が顧客発言だけを抽出できる（自分の発言を拾わない）
- [ ] 新着が該当トピックに届く／初回は過去ログを配らない
- [ ] トピックで打った返信が Lpro の正しい会話に送信される
- [ ] 別顧客のトピックで打って取り違えが起きない

---

## 8. 既知の注意点・将来改善

- **件数ベースの新着検知**は append-only 前提。リスト仮想化や履歴の遅延読み込みがある場合は、メッセージの一意ID／時刻での重複排除（`seen_messages` テーブル）に切り替える。
- 顧客名のみをキーにすると **同名衝突**で取り違える。一意属性があれば必ずそちらを `customerKey` に使う。
- ポーリングは「未読のみ巡回」（`ONLY_UNREAD=true`）が軽い。全件巡回は会話数が多いと遅くなる。
- 画像・スタンプ等の非テキストは本実装では未対応（テキスト返信が主目的）。必要なら吹き出し種別を判定して Telegram 側にも添付する拡張を追加。
- セッション切れ時の自動再ログイン待ち（`ensureLoggedIn` の再呼び出し）を poll エラー時に挟むと安定する。
