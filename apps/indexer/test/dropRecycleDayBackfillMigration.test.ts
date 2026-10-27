/**
 * Migration 0079 (#2937): the retired pre-cutover recycle-day backfill table
 * is dropped, and nothing else.
 *
 * The contract step of a two-step retirement: step 1 removed every reader
 * while the table still existed. These cases pin that the migration removes
 * the table, is safe to re-run, and leaves the live column 0047 added beside
 * it (`recycle_chain_reported.attributed_cumulative`) in place.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { createSqliteD1 } from './helpers/sqliteD1';

const MIGRATIONS_DIR = new URL('../migrations/', import.meta.url);
const read = (f: string) => readFileSync(new URL(f, MIGRATIONS_DIR), 'utf8');
const files = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort();
const THIS = '0079_drop_recycle_day_backfill.sql';
const BEFORE = files.filter((f) => f < THIS).map(read);

type Db = ReturnType<typeof createSqliteD1>['db'];
const tableExists = (db: Db, name: string) =>
  db.prepare(`SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = ?`).get(name) !== undefined;

describe('migration 0079 — drop recycle_day_backfill (#2937)', () => {
  it('drops the table and keeps the attribution column 0047 added beside it', () => {
    const { db } = createSqliteD1(BEFORE);
    expect(tableExists(db, 'recycle_day_backfill')).toBe(true);
    db.exec(read(THIS));
    expect(tableExists(db, 'recycle_day_backfill')).toBe(false);
    const cols = (db.prepare(`PRAGMA table_info(recycle_chain_reported)`).all() as Array<{ name: string }>)
      .map((c) => c.name);
    expect(cols).toContain('attributed_cumulative');
  });

  it('runs twice without error', () => {
    const { db } = createSqliteD1(BEFORE);
    db.exec(read(THIS));
    db.exec(read(THIS));
    expect(tableExists(db, 'recycle_day_backfill')).toBe(false);
  });

  it('carries no statement other than the drop', () => {
    const statements = read(THIS)
      .split('\n')
      .filter((l) => !l.trim().startsWith('--') && l.trim() !== '')
      .join('\n');
    expect(statements.trim()).toBe('DROP TABLE IF EXISTS recycle_day_backfill;');
  });
});
