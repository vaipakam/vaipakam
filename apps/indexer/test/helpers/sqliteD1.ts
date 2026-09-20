/**
 * Minimal D1-shaped adapter over Node's built-in `node:sqlite`
 * (DatabaseSync) for route tests whose behaviour IS the SQL — ORDER BY /
 * LIMIT / UNION semantics that a canned-response stub cannot pin
 * (Codex #1145 round-4: per-side price-relevant book caps, the
 * /offers/markets signed-book union). D1 executes real SQLite, so an
 * in-memory SQLite database running the REAL migration DDL is a faithful
 * query engine; only the tiny prepare/bind/first/all/run surface the
 * routes use is adapted.
 *
 * Kept deliberately narrow: no exec-through-D1, no named params — the
 * routes under test use none of them. `batch()` exists because the
 * #1270 market_summary refresh runs its DELETE + INSERT..SELECT as one
 * transactional batch; the adapter mirrors D1's semantics (all-or-
 * nothing) with BEGIN/COMMIT/ROLLBACK. Tests seed rows through the raw
 * `db` handle.
 */
import { DatabaseSync } from 'node:sqlite';

type SqlValue = number | string | bigint | null;

export interface SqliteD1 {
  /** Raw handle for DDL + row seeding in tests. */
  db: DatabaseSync;
  /** Cast this to `D1Database` when building the route `Env`. */
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
    /**
     * Consumed by the adapter's batch() below.
     *
     * `.all()`, not `.run()`, so a statement carrying `RETURNING` hands its
     * rows back the way D1 does (#2231 r7). The quarantine's settle-release
     * decides what to disclose from exactly those rows, and a fake that
     * dropped them could not be used to test the code that reads them — the
     * same reason `meta.changes` is carried per statement below.
     *
     * `changes` still comes from a `run()`-shaped read of the same handle:
     * node:sqlite's `all()` does not report it, and D1 carries both.
     */
    __exec: () => {
      const stmt = db.prepare(sql);
      const rows = stmt.all(...args);
      return { rows, changes: db.prepare('SELECT changes() AS c').get() as { c: number } };
    },
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
        // `meta.changes` PER STATEMENT, as D1 returns it. The adapter used
        // to return a bare `{ meta: {} }` here, which was fine while the
        // only consumer ignored the result — and silently unusable for the
        // #2101 repair, whose compare-and-set decides whether a row was
        // repaired from the FIRST statement's change count. A fake that
        // drops a field the real thing carries cannot be used to test the
        // code that reads it.
        return results.map((info) => {
          const r = info as { rows: unknown[]; changes: { c: number | bigint } };
          return { results: r.rows, meta: { changes: Number(r.changes.c) } };
        });
      } catch (err) {
        db.exec('ROLLBACK');
        throw err;
      }
    },
  };
  return { db, d1 };
}
