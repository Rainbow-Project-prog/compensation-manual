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
  bootstrapped    INTEGER NOT NULL DEFAULT 0,
  seen_count      INTEGER NOT NULL DEFAULT 0,
  created_at      INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`);

export type Customer = {
  customer_key: string;
  name: string | null;
  topic_thread_id: number | null;
  bootstrapped: number;
  seen_count: number;
};

export const dbApi = {
  get: (key: string) =>
    db.prepare('SELECT * FROM customers WHERE customer_key=?').get(key) as Customer | undefined,
  upsert: (key: string, name: string) =>
    db.prepare(
      `INSERT INTO customers (customer_key,name,created_at) VALUES (?,?,?)
       ON CONFLICT(customer_key) DO UPDATE SET name=excluded.name`
    ).run(key, name, Date.now()),
  // upsert形: 行が無い状態で呼ばれても紐付けを失わない（クラッシュ時の重複トピック防止）
  setTopic: (key: string, threadId: number) =>
    db.prepare(
      `INSERT INTO customers (customer_key, topic_thread_id, created_at) VALUES (?,?,?)
       ON CONFLICT(customer_key) DO UPDATE SET topic_thread_id=excluded.topic_thread_id`
    ).run(key, threadId, Date.now()),
  // トピックが削除されていた場合に紐付けを外す（次回配信時に作り直す）
  clearTopic: (key: string) =>
    db.prepare('UPDATE customers SET topic_thread_id=NULL WHERE customer_key=?').run(key),
  setSeen: (key: string, count: number, bootstrapped = 1) =>
    db.prepare('UPDATE customers SET seen_count=?, bootstrapped=? WHERE customer_key=?')
      .run(count, bootstrapped, key),
  byThread: (threadId: number) =>
    db.prepare('SELECT * FROM customers WHERE topic_thread_id=?').get(threadId) as Customer | undefined,
  // GROUP_CHAT_ID 変更検知用（旧グループのスレッドIDは新グループの別トピックと衝突し誤配信の温床になる）
  getMeta: (key: string) =>
    (db.prepare('SELECT value FROM meta WHERE key=?').get(key) as { value: string } | undefined)?.value,
  setMeta: (key: string, value: string) =>
    db.prepare(
      `INSERT INTO meta (key,value) VALUES (?,?)
       ON CONFLICT(key) DO UPDATE SET value=excluded.value`
    ).run(key, value),
  clearAllTopics: () => db.prepare('UPDATE customers SET topic_thread_id=NULL').run(),
};

/** 終了時に呼ぶ。WAL を確定してファイルを閉じる */
export function closeDb(): void {
  try { db.close(); } catch { /* already closed */ }
}
