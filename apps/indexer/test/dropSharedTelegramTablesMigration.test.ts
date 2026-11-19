/**
 * Migration 0112 (#3572): the shared Telegram tables #1722 emptied are
 * dropped, with `user_thresholds.tg_chat_id`, and nothing else.
 *
 * The contract step of a two-step retirement: 0091 emptied the shared copies
 * while the keeper then serving still read them; this drops them once nothing
 * does. These cases pin that the migration applies on a database built from
 * every earlier migration, removes exactly what it names, and keeps the
 * thresholds rows and their other columns.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { createSqliteD1 } from './helpers/sqliteD1';

const MIGRATIONS_DIR = new URL('../migrations/', import.meta.url);
const read = (f: string) => readFileSync(new URL(f, MIGRATIONS_DIR), 'utf8');
const files = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort();
const THIS = '0112_drop_shared_telegram_tables.sql';
const BEFORE = files.filter((f) => f < THIS).map(read);
const DROPPED = ['telegram_links', 'alert_channel_changes', 'protected_lock_requests', 'protected_lock_readiness'];

type Db = ReturnType<typeof createSqliteD1>['db'];
const tableExists = (db: Db, name: string) =>
  db.prepare(`SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = ?`).get(name) !== undefined;
const columns = (db: Db, table: string) =>
  (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((c) => c.name);

describe('migration 0112 — drop the shared Telegram tables (#3572)', () => {
  it('drops the four tables and the chat column, and keeps the thresholds rows', () => {
    const { db } = createSqliteD1(BEFORE);
    for (const t of DROPPED) expect(tableExists(db, t)).toBe(true);
    expect(columns(db, 'user_thresholds')).toContain('tg_chat_id');
    db.prepare(
      `INSERT INTO user_thresholds (wallet, chain_id, warn_hf, alert_hf, critical_hf, push_channel, created_at, updated_at)
       VALUES ('0xa', 84532, 1.5, 1.2, 1.05, 'push', 1, 1)`,
    ).run();

    db.exec(read(THIS));

    for (const t of DROPPED) expect(tableExists(db, t)).toBe(false);
    const cols = columns(db, 'user_thresholds');
    expect(cols).not.toContain('tg_chat_id');
    expect(cols).toEqual(expect.arrayContaining(['wallet', 'chain_id', 'push_channel', 'locale']));
    const row = db.prepare(`SELECT wallet, push_channel FROM user_thresholds`).get() as {
      wallet: string;
      push_channel: string;
    };
    expect(row).toEqual({ wallet: '0xa', push_channel: 'push' });
  });

  it('carries no statement other than the five drops', () => {
    const statements = read(THIS)
      .split('\n')
      .filter((l) => !l.trim().startsWith('--') && l.trim() !== '')
      .join('\n');
    expect(statements.trim()).toBe(
      [
        'DROP TABLE IF EXISTS telegram_links;',
        'DROP TABLE IF EXISTS alert_channel_changes;',
        'DROP TABLE IF EXISTS protected_lock_requests;',
        'DROP TABLE IF EXISTS protected_lock_readiness;',
        'ALTER TABLE user_thresholds DROP COLUMN tg_chat_id;',
      ].join('\n'),
    );
  });
});
