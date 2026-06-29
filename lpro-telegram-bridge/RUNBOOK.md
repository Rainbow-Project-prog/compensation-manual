# 運用ランブック（壊れたとき・困ったとき）

この設計の前提は「**Lpro の UI が変わると壊れる。そのとき直すのは `src/config.ts` の SELECTORS と
`src/lpro-adapter.ts` だけ**」。慌てず以下の手順で復旧する。

---

## A. Lpro の画面変更で動かなくなった（最頻ケース）

症状の例:
- ログには出るが Telegram に新着が来ない
- `poll error` が出続ける / `waitForSelector ... Timeout` が出る
- 返信が Lpro に入らない

### 手順

1. **どのセレクタが死んだか切り分ける**
   `HEADLESS=false` で `npm start` し、ブラウザで実際の画面を見る。
   - 会話一覧が取れない → `conversationItem` / `unreadBadge`
   - 会話は開くがメッセージが拾えない → `messageBubble` / `inboundBubbleMarker` / `bubbleText`
   - 返信が入らない → `replyInput` / `sendButton`
   - そもそもログイン判定で止まる → `loggedInMarker`

2. **新しいセレクタを調べる**
   トーク応対画面で F12 → 該当要素を右クリック → Copy → **Copy selector**（または outerHTML を見てクラス/属性を確認）。

3. **`src/config.ts` の SELECTORS を差し替える**（基本ここだけ）。

4. **会話の開き方が変わった場合**は `src/lpro-adapter.ts` の `openConversation()` を調整
   （行クリック方式 A / URL直開き方式 B のどちらか）。

5. **顧客キーの属性が変わった場合**は `pollConversations()` の `getAttribute('data-user-id')` を実際の属性名へ。

6. `npm run doctor` で TODO 残りが無いか確認 → `npm start` で再開。

> ヒント: 一意な属性（`data-user-id` 等）があれば必ず `customerKey` に使う。表示名キーは同名衝突で取り違える。

---

## B. Telegram にトピックが作られない / 送れない

`createForumTopic` が 400 で失敗する場合、コードが下記を促すエラーを出す:

1. グループの **Topics が ON** か
2. bot が**管理者**で「**トピックの管理 (Manage Topics)**」権限を持つか
3. `GROUP_CHAT_ID` が正しいか（`npm run chatid` で取り直す。`-100...` の数値）

429（レート制限）や 5xx・ネットワーク断は自動でリトライ（指数バックオフ）するので、基本は放置で回復する。

---

## C. ログインが切れる / 毎回ログインを求められる

- セッションは `USER_DATA_DIR`（既定 `./.lpro-profile`）に保存される。**このフォルダを消さない**こと。
- 巡回中に切れた場合は poll エラー時に自動で再ログイン待ち（`ensureLoggedIn`）に入る。
  画面が見える状態（`HEADLESS=false`）なら手動で通せば復帰する。
- 2FA は初回だけ手動。確立後に `HEADLESS=true` で弾かれるなら headed のまま運用する。

---

## D. 新着がダブる / 過去ログが大量に流れる

- 本実装は **件数ベース**（`seen_count` を超えた分だけ配信）。append-only 前提。
- Lpro 側にリスト仮想化や履歴の遅延読み込みがあると件数がずれて誤配信し得る。
  その場合はメッセージの**一意ID／時刻**での重複排除に切り替える:
  `db.ts` に `seen_messages(hash)` テーブルを足し、`readInbound` で各吹き出しのIDを拾って既配信を除外する。
- 配信判定そのものは `src/logic.ts`（`decideDelivery`）に分離済み。挙動を変えるときは
  まず `test/logic.test.ts` にケースを足してから直すと安全。

---

## E. プロセスが落ちる / 常時起動

- PM2: `pm2 start ecosystem.config.cjs` → `pm2 logs lpro-bridge` でログ確認。
  クラッシュ時は5秒後に自動再起動（30秒以内に連続クラッシュが続くと停止）。
- Ctrl+C / `pm2 stop` 時はブラウザと DB を正しく閉じる（chromium 残骸・WAL 破損を防止）。
- 強制終了して `bridge.db-wal` / `.lpro-profile` が壊れた疑いがあるとき:
  - `.lpro-profile` を消すと**再ログインが必要**（消すのは最終手段）。
  - `bridge.db` を消すと**全顧客が初回ブートストラップ扱い**になり、既存トピックとの紐付けが切れる。原則消さない。

---

## F. 開発時のチェック

```bash
npm run doctor      # 設定の抜け（.env / SELECTORS の TODO）を検出
npm run typecheck   # 型エラー
npm test            # 配信判定ロジックの単体テスト
```
push すると GitHub Actions（`.github/workflows/bridge-ci.yml`）で typecheck + test が自動実行される。
