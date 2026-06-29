import Database from 'better-sqlite3';

const db = new Database('bridge.db');
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
  setTopic: (key: string, threadId: number) =>
    db.prepare('UPDATE customers SET topic_thread_id=? WHERE customer_key=?').run(threadId, key),
  setSeen: (key: string, count: number, bootstrapped = 1) =>
    db.prepare('UPDATE customers SET seen_count=?, bootstrapped=? WHERE customer_key=?')
      .run(count, bootstrapped, key),
  byThread: (threadId: number) =>
    db.prepare('SELECT * FROM customers WHERE topic_thread_id=?').get(threadId) as Customer | undefined,
};

/** 終了時に呼ぶ。WAL を確定してファイルを閉じる */
export function closeDb(): void {
  try { db.close(); } catch { /* already closed */ }
}
