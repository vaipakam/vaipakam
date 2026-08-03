/**
 * Minimal D1-shaped adapter over Node's built-in `node:sqlite`
 * (DatabaseSync) — a straight port of the indexer's test shim
 * (apps/indexer/test/helpers/sqliteD1.ts) for keeper tests whose
 * behaviour IS the SQL: the HF-band pass (#1213 PR 2b) reads/writes
 * the SAME shared `vaipakam-archive` tables the indexer migrations
 * define, so an in-memory SQLite running the real migration DDL is a
 * faithful query engine. Only the tiny prepare/bind/first/all/run
 * surface the keeper uses is adapted.
 *
 * Kept deliberately narrow: no exec-through-D1, no named params.
 * `batch()` mirrors D1's all-or-nothing semantics with
 * BEGIN/COMMIT/ROLLBACK; note it surfaces no `meta.changes` counts —
 * tests assert on table rows, never on returned counts.
 */
import { DatabaseSync } from 'node:sqlite';

type SqlValue = number | string | bigint | null;

export interface SqliteD1 {
  /** Raw handle for DDL + row seeding in tests. */
  db: DatabaseSync;
  /** Cast this to `D1Database` when calling the code under test. */
  d1: unknown;
}

export function createSqliteD1(ddl: string[]): SqliteD1 {
  const db = new DatabaseSync(':memory:');
  for (const sql of ddl) db.exec(sql);
  const makeStatement = (sql: string, args: SqlValue[]) => ({
    first: async () => db.prepare(sql).get(...args) ?? null,
    all: async () => ({ results: db.prepare(sql).all(...args) }),
    run: async () => {
      const info = db.prepare(sql).run(...args);
      return { meta: { changes: Number(info.changes) } };
    },
    /** Consumed by the adapter's batch() below. */
    __exec: () => db.prepare(sql).run(...args),
  });
  const d1 = {
    prepare(sql: string) {
      return {
        bind: (...args: SqlValue[]) => makeStatement(sql, args),
        ...makeStatement(sql, []),
      };
    },
    async batch(statements: Array<{ __exec: () => unknown }>) {
      db.exec('BEGIN');
      try {
        const results = statements.map((s) => s.__exec());
        db.exec('COMMIT');
        return results.map(() => ({ meta: {} }));
      } catch (err) {
        db.exec('ROLLBACK');
        throw err;
      }
    },
  };
  return { db, d1 };
}
