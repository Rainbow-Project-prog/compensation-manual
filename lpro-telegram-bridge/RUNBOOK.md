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
   - 「トーク画面（chatframe）が見つかりません」が出続ける → `mainFrame` / `chatFrame`（iframe構造の変化）
     または該当受信箱の talk URL（`CHAT_TALK_URL` = chat_message?method=frame /
     `TALK_TALK_URL` = linechat_message_frame）の変更。どの受信箱で出ているかはログの受信箱名で分かる
   - 顧客行が0件 → `conversationItem`（tr.rowitem）
   - **一覧は取れるのに新着が全く配信されない** → `statusCell` / `unreadText`（未知の状態表記は安全側で未読扱いになる。
     ただし `statusCell` が「返信済」を含む場合のみ未読なし扱いなので、「返信済」の表記が変わった場合は全行が
     未読扱いになり巡回が重くなる。ログの「巡回[チャット応対]: N行/未読M件」/「巡回[ダイレクトトーク応対]: …」で
     気付ける。ログには受信箱名が付くのでどちらの受信箱の話か見分けられる）
   - 顧客が「スキップ」され続ける → `memberIdText`（会員ID要素）
   - 名前が変 → `customerName`
   - メッセージが拾えない → `messageGroup` / `inboundGroupClass` / `bubble` / `msgDatetime`
   - 返信が入らない・「送信を確認できません」→ `replyInput` / `sendButton`
   - そもそもログイン判定で止まる → `loggedInMarker`

2. **新しいセレクタを調べる**
   トーク応対画面で F12 → 該当要素を右クリック → Copy → **Copy selector**（または outerHTML を見てクラス/属性を確認）。

3. **`src/config.ts` の SELECTORS を差し替える**（基本ここだけ）。

4. **行の特定方法が変わった場合**は `src/lpro-adapter.ts` の `findRow()`（会員IDの完全一致で行を特定）を調整。

5. **顧客キー（会員ID）の表示要素が変わった場合**は `src/config.ts` の `SELECTORS.memberIdText` を差し替え。

6. `npm run doctor` で TODO 残りが無いか確認 → `npm start` で再開。

> ヒント: 顧客キーは会員ID（アカバンでも不変）。表示名をキーにしてはならない（同名衝突で取り違える）。

---

## B. Telegram にトピックが作られない / 送れない

`createForumTopic` が 400 で失敗する場合、コードが下記を促すエラーを出す:

1. グループの **Topics が ON** か
2. bot が**管理者**で「**トピックの管理 (Manage Topics)**」権限を持つか（bot は両グループそれぞれに追加する）
3. 該当受信箱のグループID（`CHAT_GROUP_CHAT_ID` / `TALK_GROUP_CHAT_ID`）が正しいか（`npm run chatid` で取り直す。`-100...` の数値。エラーには受信箱名が付くのでどちらのグループか分かる）

429（レート制限）や 5xx・ネットワーク断は自動でリトライ（指数バックオフ）するので、基本は放置で回復する。
ただし**トピック作成（createForumTopic）だけはネットワーク断・5xx では意図的に再試行しない**
（非冪等のため、応答が届かなかっただけの再試行が重複トピックを生む。429 レート制限のみ
retry_after を待って再試行する）。作成失敗は次の配信サイクルで自然に再試行される。

---

## C. ログインが切れる / 毎回ログインを求められる

- セッションは `USER_DATA_DIR`（既定はプロジェクト直下の `.lpro-profile`）に保存される。**このフォルダを消さない**こと。
- 巡回中に切れた場合は poll エラー時に自動で再ログイン待ち（`ensureLoggedIn`）に入る。
  ログイン画面へリダイレクトされるとトーク画面（`chatframe`）が表示されなくなるため、
  エラー化して同じ復旧経路に入る。画面が見える状態（`HEADLESS=false`）なら手動で通せば復帰する。
- 2FA は初回だけ手動。確立後に `HEADLESS=true` で弾かれるなら headed のまま運用する。

---

## D. 新着がダブる / 過去ログが大量に流れる / 新着が来ない

- 本実装は **フィンガープリント方式**(2026-07-11 実DOM確定時に件数ベースから移行):
  メッセージごとに「会員ID+日時+本文」のハッシュを `seen_messages` テーブル(bridge.db)に記録し、
  **台帳に無いハッシュのメッセージだけ**配信する。Lpro の履歴窓(行内に直近数件のみ表示)が
  どうずれても、同数入れ替わりでも、取りこぼし・再配信は起きない設計。
- 送信は1件成功ごとに既知化するので途中失敗でも重複しない
  (例外: 4000字超の長文は分割送信されるため、分割の途中で失敗した場合のみ先頭部分が重複し得る)。
- それでもダブる場合: 同一顧客で **日時表示や本文の描画が変わる**とハッシュが変わる。
  `.mmsgdt` の中身が変化していないか(A-1 の `msgDatetime`)を確認。
- 新着が来ない場合: `statusCell`/`unreadText`(未返信判定)を確認。`ONLY_UNREAD=false` にすると
  全行を毎回読むので、未返信判定が壊れていても届くようになる(重い・既読台帳があるので安全)。
  なお受信箱は2つ(チャット応対/ダイレクトトーク応対)あり、どちらの巡回の話かはログの
  「巡回[受信箱名]: N行/未読M件」で見分けられる。片方だけ来ない場合は、その受信箱の
  `*_TALK_URL`/`*_GROUP_CHAT_ID` が両方設定されて有効になっているか(`npm run doctor`)も確認する。
- 顧客1人に**トピックが複数できる**ことは起きない設計(キー=会員ID固定)。起きたら `memberIdText` を確認。
- 配信判定そのものは `src/logic.ts`(`decideDeliveryBySeen`)に分離済み。挙動を変えるときは
  まず `test/logic.test.ts` にケースを足してから直すと安全。
- 既定の `ONLY_UNREAD=true` は「未返信」状態の顧客だけを読む。顧客の新着に Lpro の画面から
  直接返信すると状態が「返信済み」に変わり、そのメッセージは Telegram のトピックに現れないことがある
  （業務上は返信済みなので実害は小さい）。Telegram 側にも完全なミラーが必要な運用では
  `ONLY_UNREAD=false`（全行を毎巡回チェック。台帳があるので重複はしない）を使う。

---

## E. プロセスが落ちる / 常時起動

- PM2: `pm2 start ecosystem.config.cjs` → `pm2 logs lpro-bridge` でログ確認。
  クラッシュ時は5秒後に自動再起動（30秒以内に連続クラッシュが続くと停止）。
  node + tsx で直接起動する構成のため Windows でも動く（`pm2 start npm -- start` は不可）。
- **終了処理の実際**: Ctrl+C（コンソール実行時）では実行中の返信送信を待ってから（最大20+5秒）
  bot・ブラウザ・DB を正しく閉じる。2回目の Ctrl+C は強制終了。
  PM2 経由の停止は `shutdown_with_message: true` により（OS を問わず）シグナルの代わりに
  'shutdown' IPC メッセージが送られ、index.ts の `process.on('message')` が終了処理を起動する
  （`kill_timeout` 40秒を超えると強制kill）。強制killでも SQLite は WAL のおかげで
  通常は壊れない。chromium のプロファイルロック問題が出た場合、Windows ではロックは
  プロセス生存に紐づくミューテックスなので、タスクマネージャで残った chromium を終了すれば
  解消する（Linux/macOS のような `Singleton*` ファイル削除は Windows では不要・存在しない）。
- **OS起動時の自動立ち上げ（Windows）**: `pm2 startup` は Windows 非対応。
  `npm i -g pm2-windows-startup && pm2-startup install`、またはタスクスケジューラで
  「ログオン時に `pm2 resurrect`」を登録する。headed ブラウザを使う場合は
  ログオン済みデスクトップセッションが必要（自動ログオン設定を検討）。
- Telegram のポーリングが 401（トークン失効）/ 409（多重起動）で止まった場合は
  半死にで放置せず、プロセスを終了コード1で落として PM2 に再起動させる設計。
  409 が続くなら `npm run chatid` や別の `npm start` が同時に動いていないか確認。
- **PM2 で起動直後にクラッシュを繰り返す**とき: `pm2 logs lpro-bridge` で
  「環境変数 ○○ が未設定です」が出ていないか確認（.env の記入漏れ。`npm run doctor` で全項目確認できる）。
- **ログの取り扱い**: PM2 のログは `~/.pm2/logs/` に**平文で無期限に蓄積**される（リポジトリ外・
  .gitignore の保護対象外）。ブリッジは会話本文をログに出さない方針だが、顧客表示名は
  運用ログに含まれる。`pm2 install pm2-logrotate` でサイズ上限・保持世代を設定しておくこと。
- 強制終了して `bridge.db-wal` / `.lpro-profile` が壊れた疑いがあるとき:
  - `.lpro-profile` を消すと**再ログインが必要**（消すのは最終手段）。
  - `bridge.db` を消すと**全顧客が初回ブートストラップ扱い**になり、既存トピックとの紐付けが切れる。原則消さない。
  - `CHAT_GROUP_CHAT_ID` / `TALK_GROUP_CHAT_ID` を変更すると、起動時に**受信箱ごとに変更を検知**し、
    その受信箱の旧グループに紐付いたトピックだけを自動リセット（`clearTopicsByGroup`）して、
    次回配信時に新グループへ作り直す（旧グループのトピックはそのまま残る。もう一方の受信箱のトピックは影響を受けない）。

---

## F. 開発時のチェック

```bash
npm run doctor      # 設定の抜け（.env / SELECTORS の TODO）を検出
npm run typecheck   # 型エラー
npm test            # 配信判定ロジックの単体テスト
```
push すると GitHub Actions（`.github/workflows/bridge-ci.yml`）で typecheck + test が自動実行される。
