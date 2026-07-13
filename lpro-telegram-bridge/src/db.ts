import Database from 'better-sqlite3';
import { fileURLToPath } from 'node:url';

// CWD 依存にすると別ディレクトリから起動したとき .gitignore の保護外に顧客DBが生成されるため、
// パッケージルート基準の固定パスにする
const dbPath = fileURLToPath(new URL('../bridge.db', import.meta.url));
const db = new Database(dbPath);
db.pragma('journal_mode = WAL');

db.exec(`
CREATE TABLE IF NOT EXISTS customers (
  customer_key    TEXT PRIMARY KEY,
  name            TEXT,
  topic_thread_id INTEGER,
  group_chat_id   INTEGER,
  bootstrapped    INTEGER NOT NULL DEFAULT 0,
  seen_count      INTEGER NOT NULL DEFAULT 0,
  -- 自分側発言のフィンガープリント基準を確立済みか（双方向同期の移行ガード）。
  -- 従来 seen 台帳は顧客側しか持たないため、既存顧客は初回接触で自分側を一括既知化してから配信する
  self_seeded     INTEGER NOT NULL DEFAULT 0,
  created_at      INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
-- 配信済み/既知メッセージのフィンガープリント（会員ID+日時+本文のハッシュ）。
-- Lpro の履歴窓がずれても再配信・取りこぼしをしないための台帳
CREATE TABLE IF NOT EXISTS seen_messages (
  customer_key TEXT NOT NULL,
  hash         TEXT NOT NULL,
  created_at   INTEGER NOT NULL,
  PRIMARY KEY (customer_key, hash)
);
-- 送信待ちのオペレータ返信。送信完了前にプロセスが死んでも（クラッシュ/電源断）
-- 無音で消さず、再起動時に該当トピックへ「未送信の可能性」を通知するための控え
CREATE TABLE IF NOT EXISTS pending_replies (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  customer_key TEXT NOT NULL,
  name         TEXT,
  text         TEXT NOT NULL,
  created_at   INTEGER NOT NULL
);
-- Telegram経由で送った返信の控え（正規化本文）。次の読取で自分側吹き出しとして逆流するのを
-- 配信抑止するため。再起動をまたいでも二重配信しないよう永続化する（TTL で自動失効）
CREATE TABLE IF NOT EXISTS sent_echoes (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  customer_key TEXT NOT NULL,
  norm_text    TEXT NOT NULL,
  created_at   INTEGER NOT NULL
);
`);

// 旧スキーマからの列追加移行。列が既にあれば無視される
try { db.exec('ALTER TABLE customers ADD COLUMN group_chat_id INTEGER'); } catch { /* already exists */ }
try { db.exec('ALTER TABLE customers ADD COLUMN self_seeded INTEGER NOT NULL DEFAULT 0'); } catch { /* already exists */ }
// 最後に「実活動」があった時刻（顧客の新着 or オペレーター返信）。双方向再同期の対象を
// 直近活動のあるトピックだけに絞り、休眠会話を延々クロールしない/レイテンシを一定に保つため
try { db.exec('ALTER TABLE customers ADD COLUMN last_activity INTEGER'); } catch { /* already exists */ }

export type Customer = {
  customer_key: string;
  name: string | null;
  topic_thread_id: number | null;
  group_chat_id: number | null;
  bootstrapped: number;
  seen_count: number;
  self_seeded: number;
  last_activity: number | null;
};

export const dbApi = {
  get: (key: string) =>
    db.prepare('SELECT * FROM customers WHERE customer_key=?').get(key) as Customer | undefined,
  upsert: (key: string, name: string) =>
    db.prepare(
      `INSERT INTO customers (customer_key,name,created_at) VALUES (?,?,?)
       ON CONFLICT(customer_key) DO UPDATE SET name=excluded.name`
    ).run(key, name, Date.now()),
  // upsert形: 行が無い状態で呼ばれても紐付けを失わない（クラッシュ時の重複トピック防止）。
  // group_chat_id も保存する（スレッドIDはグループ内でのみ一意なので、返信の宛先解決に必須）
  setTopic: (key: string, threadId: number, groupChatId: number) =>
    db.prepare(
      `INSERT INTO customers (customer_key, topic_thread_id, group_chat_id, created_at) VALUES (?,?,?,?)
       ON CONFLICT(customer_key) DO UPDATE SET topic_thread_id=excluded.topic_thread_id,
         group_chat_id=excluded.group_chat_id`
    ).run(key, threadId, groupChatId, Date.now()),
  // トピックが削除されていた場合に紐付けを外す（次回配信時に作り直す）
  clearTopic: (key: string) =>
    db.prepare('UPDATE customers SET topic_thread_id=NULL WHERE customer_key=?').run(key),
  setSeen: (key: string, count: number, bootstrapped = 1) =>
    db.prepare('UPDATE customers SET seen_count=?, bootstrapped=? WHERE customer_key=?')
      .run(count, bootstrapped, key),
  // 自分側発言のベースライン確立フラグ（双方向同期の移行ガード。既存顧客の過去自分側発言の一斉配信を防ぐ）
  setSelfSeeded: (key: string) =>
    db.prepare('UPDATE customers SET self_seeded=1 WHERE customer_key=?').run(key),
  // 「実活動」時刻を更新（顧客の新着＝未読巡回で処理 / オペレーター返信の送信時）。再同期の対象選定に使う
  touchActivity: (key: string) =>
    db.prepare('UPDATE customers SET last_activity=? WHERE customer_key=?').run(Date.now(), key),
  // 双方向再同期の対象: グループに紐付く「トピックを開いている」かつ直近 sinceMs 以降に実活動のある顧客。
  // 休眠会話を延々再読しないよう活動でバウンドし、直近活動順に返す（PC返信のレイテンシを一定に保つ）
  listOpenTopics: (groupChatId: number, sinceMs: number) =>
    db.prepare(
      `SELECT customer_key, name FROM customers
       WHERE group_chat_id=? AND topic_thread_id IS NOT NULL
         AND last_activity IS NOT NULL AND last_activity >= ?
       ORDER BY last_activity DESC`
    ).all(groupChatId, sinceMs) as Array<{ customer_key: string; name: string | null }>,
  // 返信の宛先解決: スレッドIDはグループ内でのみ一意なので、必ずグループでも絞る
  // （2グループ運用で thread_id が偶然一致しても別顧客に誤配信しないため）
  byThread: (groupChatId: number, threadId: number) =>
    db.prepare('SELECT * FROM customers WHERE group_chat_id=? AND topic_thread_id=?')
      .get(groupChatId, threadId) as Customer | undefined,
  // GROUP_CHAT_ID 変更検知用（旧グループのスレッドIDは新グループの別トピックと衝突し誤配信の温床になる）
  getMeta: (key: string) =>
    (db.prepare('SELECT value FROM meta WHERE key=?').get(key) as { value: string } | undefined)?.value,
  setMeta: (key: string, value: string) =>
    db.prepare(
      `INSERT INTO meta (key,value) VALUES (?,?)
       ON CONFLICT(key) DO UPDATE SET value=excluded.value`
    ).run(key, value),
  // 指定グループに紐付いたトピックだけリセット（そのグループの GROUP_CHAT_ID 変更時）
  clearTopicsByGroup: (groupChatId: number) =>
    db.prepare('UPDATE customers SET topic_thread_id=NULL WHERE group_chat_id=?').run(groupChatId),
  // ── フィンガープリント台帳 ──
  hasSeen: (key: string, hash: string) =>
    db.prepare('SELECT 1 FROM seen_messages WHERE customer_key=? AND hash=?').get(key, hash) !== undefined,
  addSeen: (key: string, hash: string) =>
    db.prepare(
      'INSERT OR IGNORE INTO seen_messages (customer_key, hash, created_at) VALUES (?,?,?)'
    ).run(key, hash, Date.now()),
  // 顧客ごとに直近 keep 件だけ残す（履歴窓は十数件なので300あれば十分。肥大防止）。
  // 併せて200日より古い記録も落とす: フィンガープリントの日時は年を含まないため、
  // 丸1年後に同一日時・同一本文が来ると衝突して届かなくなる問題の予防（古い方を先に消す）
  pruneSeen: (key: string, keep = 300) => {
    db.prepare(
      `DELETE FROM seen_messages WHERE customer_key=? AND hash NOT IN (
         SELECT hash FROM seen_messages WHERE customer_key=? ORDER BY created_at DESC, rowid DESC LIMIT ?)`
    ).run(key, key, keep);
    db.prepare('DELETE FROM seen_messages WHERE customer_key=? AND created_at < ?')
      .run(key, Date.now() - 200 * 24 * 60 * 60 * 1000);
  },
  countSeenAll: () =>
    (db.prepare('SELECT COUNT(*) AS n FROM seen_messages').get() as { n: number }).n,
  countBootstrapped: () =>
    (db.prepare('SELECT COUNT(*) AS n FROM customers WHERE bootstrapped=1').get() as { n: number }).n,
  resetAllBootstrapped: () => db.prepare('UPDATE customers SET bootstrapped=0').run(),
  // ── 送信待ち返信の控え ──
  addPending: (key: string, name: string, text: string) =>
    Number(
      db.prepare(
        'INSERT INTO pending_replies (customer_key, name, text, created_at) VALUES (?,?,?,?)'
      ).run(key, name, text, Date.now()).lastInsertRowid
    ),
  deletePending: (id: number) => db.prepare('DELETE FROM pending_replies WHERE id=?').run(id),
  listPending: () =>
    db.prepare('SELECT * FROM pending_replies ORDER BY id').all() as Array<{
      id: number; customer_key: string; name: string | null; text: string; created_at: number;
    }>,
  // ── 送信エコーの控え（自送信の逆流を配信抑止。再起動をまたいで有効）──
  addSentEcho: (key: string, normText: string) =>
    db.prepare('INSERT INTO sent_echoes (customer_key, norm_text, created_at) VALUES (?,?,?)')
      .run(key, normText, Date.now()),
  // 一致する最古の控えを1件だけ消費して true。TTL より古い控えは無視する（無ければ false=PC直返信）
  consumeSentEcho: (key: string, normText: string, ttlMs: number): boolean => {
    const row = db.prepare(
      'SELECT id FROM sent_echoes WHERE customer_key=? AND norm_text=? AND created_at>=? ORDER BY id LIMIT 1'
    ).get(key, normText, Date.now() - ttlMs) as { id: number } | undefined;
    if (!row) return false;
    db.prepare('DELETE FROM sent_echoes WHERE id=?').run(row.id);
    return true;
  },
  pruneSentEchoes: (ttlMs: number) =>
    db.prepare('DELETE FROM sent_echoes WHERE created_at < ?').run(Date.now() - ttlMs),
};

/** 終了時に呼ぶ。WAL を確定してファイルを閉じる */
export function closeDb(): void {
  try { db.close(); } catch { /* already closed */ }
}
