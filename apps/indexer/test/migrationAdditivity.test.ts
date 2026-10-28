/**
 * #2412 — the additive-migration rule the CI check enforces.
 */
import { describe, expect, it } from 'vitest';
import {
  destructiveStatements,
  statements,
  stripSql,
} from '../scripts/lib/migration-additivity.mjs';

const reasons = (sql: string) => destructiveStatements(sql).map((d) => d.reason);

describe('migration additivity (#2412)', () => {
  it('allows the additive forms', () => {
    expect(
      reasons(`
        CREATE TABLE IF NOT EXISTS t (id INTEGER PRIMARY KEY, v TEXT NOT NULL);
        ALTER TABLE t ADD COLUMN a INTEGER;
        ALTER TABLE t ADD COLUMN b INTEGER NOT NULL DEFAULT 0;
        CREATE INDEX IF NOT EXISTS t_v ON t (v);
        DROP INDEX IF EXISTS t_old;
        INSERT INTO t (id, v) VALUES (1, 'x');
      `),
    ).toEqual([]);
  });

  it('refuses each destructive form', () => {
    expect(reasons('DROP TABLE t;')).toEqual(['DROP TABLE']);
    expect(reasons('drop   table if exists t')).toEqual(['DROP TABLE']);
    expect(reasons('ALTER TABLE t DROP COLUMN v;')).toEqual(['ALTER TABLE … DROP COLUMN']);
    expect(reasons('ALTER TABLE t RENAME TO u;')).toEqual(['ALTER TABLE … RENAME']);
    expect(reasons('ALTER TABLE t RENAME COLUMN v TO w;')).toEqual(['ALTER TABLE … RENAME']);
    expect(reasons('ALTER TABLE t ADD COLUMN c TEXT NOT NULL;')).toEqual([
      'ADD COLUMN … NOT NULL without a DEFAULT',
    ]);
    expect(reasons('ALTER TABLE "t" DROP COLUMN "v";')).toEqual(['ALTER TABLE … DROP COLUMN']);
  });

  it('does not read comments or string literals as statements', () => {
    expect(
      reasons(`
        -- DROP TABLE t; this migration does not drop anything
        /* ALTER TABLE t DROP COLUMN v; */
        INSERT INTO notes (body) VALUES ('DROP TABLE t; ALTER TABLE t RENAME TO u');
      `),
    ).toEqual([]);
    expect(stripSql("SELECT 'it''s; fine'")).toBe("SELECT ''");
  });

  it('does not split a trigger body into top-level statements', () => {
    const sql = `
      CREATE TRIGGER IF NOT EXISTS trg AFTER INSERT ON t BEGIN
        DELETE FROM u WHERE id = NEW.id;
        UPDATE u SET v = 1;
      END;
      ALTER TABLE t ADD COLUMN a INTEGER;
    `;
    expect(statements(sql)).toHaveLength(2);
    expect(reasons(sql)).toEqual([]);
  });

  it('fails closed on SQL it cannot read', () => {
    expect(() => destructiveStatements("INSERT INTO t VALUES ('unterminated);")).toThrow();
    expect(() => destructiveStatements('/* never closed')).toThrow();
  });
});
