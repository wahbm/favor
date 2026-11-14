import mysql, { type PoolConnection, type RowDataPacket } from 'mysql2/promise';
export const pool = mysql.createPool({
  uri: process.env.DATABASE_URL || 'mysql://favor:CHANGE_ME@127.0.0.1:3306/favor',
  connectionLimit: 8,
  charset: 'utf8mb4',
  dateStrings: true,
  timezone: 'Z',
  supportBigNumbers: true,
  bigNumberStrings: false,
});
export type DB = PoolConnection;
export type SQLValue = string | number | boolean | null;
export async function q<T = RowDataPacket>(
  db: DB,
  sql: string,
  values: SQLValue[] = [],
): Promise<T[]> {
  const [rows] = await db.execute(sql, values);
  return rows as T[];
}
export async function transaction<T>(fn: (db: DB) => Promise<T>): Promise<T> {
  const db = await pool.getConnection();
  try {
    await db.query("SET time_zone = '+00:00'");
    await db.beginTransaction();
    const value = await fn(db);
    await db.commit();
    return value;
  } catch (e) {
    await db.rollback();
    throw e;
  } finally {
    db.release();
  }
}
export const schema = [
  `CREATE TABLE IF NOT EXISTS users (id CHAR(36) PRIMARY KEY, username VARCHAR(32) NOT NULL UNIQUE, password_hash VARCHAR(255) NOT NULL, created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP)`,
  `CREATE TABLE IF NOT EXISTS ledgers (id CHAR(36) PRIMARY KEY, name VARCHAR(80) NOT NULL, kind ENUM('personal','family') NOT NULL, owner_id CHAR(36) NOT NULL, personal_owner CHAR(36) UNIQUE, FOREIGN KEY(owner_id) REFERENCES users(id), CHECK ((kind='personal' AND personal_owner IS NOT NULL AND personal_owner=owner_id) OR (kind='family' AND personal_owner IS NULL)))`,
  `CREATE TABLE IF NOT EXISTS members (ledger_id CHAR(36) NOT NULL, user_id CHAR(36) NOT NULL, active BOOLEAN NOT NULL DEFAULT TRUE, PRIMARY KEY(ledger_id,user_id), FOREIGN KEY(ledger_id) REFERENCES ledgers(id), FOREIGN KEY(user_id) REFERENCES users(id))`,
  `CREATE TABLE IF NOT EXISTS sessions (token_hash CHAR(64) PRIMARY KEY, user_id CHAR(36) NOT NULL, csrf CHAR(64) NOT NULL, expires_at DATETIME NOT NULL, INDEX(expires_at), FOREIGN KEY(user_id) REFERENCES users(id))`,
  `CREATE TABLE IF NOT EXISTS invites (id CHAR(36) PRIMARY KEY, ledger_id CHAR(36) NOT NULL, token_hash CHAR(64) NOT NULL UNIQUE, expires_at DATETIME NOT NULL, revoked BOOLEAN NOT NULL DEFAULT FALSE, created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, FOREIGN KEY(ledger_id) REFERENCES ledgers(id))`,
  `CREATE TABLE IF NOT EXISTS people (id CHAR(36) PRIMARY KEY, source_id CHAR(36) NOT NULL, ledger_id CHAR(36) NOT NULL, name VARCHAR(80) NOT NULL, relationship VARCHAR(80) NOT NULL DEFAULT '', note VARCHAR(300) NOT NULL DEFAULT '', UNIQUE(ledger_id,source_id), UNIQUE(ledger_id,id), FOREIGN KEY(ledger_id) REFERENCES ledgers(id))`,
  `CREATE TABLE IF NOT EXISTS occasions (id CHAR(36) PRIMARY KEY, ledger_id CHAR(36) NOT NULL, name VARCHAR(80) NOT NULL, UNIQUE(ledger_id,name), UNIQUE(ledger_id,id), FOREIGN KEY(ledger_id) REFERENCES ledgers(id))`,
  `CREATE TABLE IF NOT EXISTS events (id CHAR(36) PRIMARY KEY, ledger_id CHAR(36) NOT NULL, name VARCHAR(80) NOT NULL, UNIQUE(ledger_id,name), UNIQUE(ledger_id,id), FOREIGN KEY(ledger_id) REFERENCES ledgers(id))`,
  `CREATE TABLE IF NOT EXISTS records (id CHAR(36) PRIMARY KEY, source_id CHAR(36) NOT NULL, ledger_id CHAR(36) NOT NULL, person_id CHAR(36) NOT NULL, occasion_id CHAR(36) NOT NULL, event_id CHAR(36), direction ENUM('income','expense') NOT NULL, date DATE NOT NULL, amount_cents BIGINT NOT NULL CHECK(amount_cents > 0), scope ENUM('family','personal') NOT NULL, owner_id CHAR(36), handler_id CHAR(36), note TEXT NOT NULL, creator_id CHAR(36) NOT NULL, updater_id CHAR(36) NOT NULL, version INT NOT NULL DEFAULT 1, created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, UNIQUE(ledger_id,source_id), INDEX(ledger_id,date), FOREIGN KEY(ledger_id) REFERENCES ledgers(id), FOREIGN KEY(ledger_id,person_id) REFERENCES people(ledger_id,id), FOREIGN KEY(ledger_id,occasion_id) REFERENCES occasions(ledger_id,id), FOREIGN KEY(ledger_id,event_id) REFERENCES events(ledger_id,id), FOREIGN KEY(owner_id) REFERENCES users(id), FOREIGN KEY(handler_id) REFERENCES users(id), FOREIGN KEY(creator_id) REFERENCES users(id), FOREIGN KEY(updater_id) REFERENCES users(id), CHECK ((scope='family' AND owner_id IS NULL) OR (scope='personal' AND owner_id IS NOT NULL)))`,
  `CREATE TABLE IF NOT EXISTS imported_records (ledger_id CHAR(36) NOT NULL, source_id CHAR(36) NOT NULL, imported_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, PRIMARY KEY(ledger_id,source_id), FOREIGN KEY(ledger_id) REFERENCES ledgers(id))`,
];
export async function migrate() {
  const db = await pool.getConnection();
  try {
    await q(db, "SET time_zone = '+00:00'");
    const [lock] = await q(db, "SELECT GET_LOCK('favor_schema_v1', 30) AS acquired");
    if (lock.acquired !== 1) throw new Error('无法获得数据库迁移锁');
    try {
      for (const sql of schema) await q(db, sql);
    } finally {
      await q(db, "SELECT RELEASE_LOCK('favor_schema_v1')");
    }
  } finally {
    db.release();
  }
}
