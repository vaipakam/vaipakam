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

  it('reads a schema-qualified table name before the action (#2988 r1)', () => {
    for (const name of ['"main"."loans"', 'main.loans', 'main."loans"', '[main].[loans]', 'main . loans']) {
      expect(reasons(`ALTER TABLE ${name} DROP COLUMN "status";`), name).toEqual([
        'ALTER TABLE … DROP COLUMN',
      ]);
      expect(reasons(`ALTER TABLE ${name} RENAME TO old_loans;`), name).toEqual([
        'ALTER TABLE … RENAME',
      ]);
      expect(reasons(`ALTER TABLE ${name} ADD COLUMN c TEXT NOT NULL;`), name).toEqual([
        'ADD COLUMN … NOT NULL without a DEFAULT',
      ]);
      expect(reasons(`ALTER TABLE ${name} ADD COLUMN c TEXT NOT NULL DEFAULT '';`), name).toEqual([]);
    }
  });

  it('treats DEFAULT NULL as no default for a NOT NULL column (#2988 r1)', () => {
    // SQLite applies these on an EMPTY table, and an INSERT from the code
    // already serving, which omits the column, then fails the constraint.
    for (const def of ['DEFAULT NULL', 'DEFAULT (NULL)', 'DEFAULT ((null))']) {
      expect(reasons(`ALTER TABLE t ADD COLUMN c INTEGER NOT NULL ${def};`), def).toEqual([
        'ADD COLUMN … NOT NULL without a DEFAULT',
      ]);
    }
    // A nullable column may default to NULL; a real default satisfies NOT NULL.
    expect(reasons('ALTER TABLE t ADD COLUMN c INTEGER DEFAULT NULL;')).toEqual([]);
    for (const def of ['DEFAULT 0', 'DEFAULT -1', "DEFAULT 'x'", 'DEFAULT (0)', 'DEFAULT CURRENT_TIMESTAMP']) {
      expect(reasons(`ALTER TABLE t ADD COLUMN c INTEGER NOT NULL ${def};`), def).toEqual([]);
    }
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
