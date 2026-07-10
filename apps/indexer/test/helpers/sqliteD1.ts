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
 * Kept deliberately narrow: no batch(), no exec-through-D1, no named
 * params — the routes under test use none of them. Tests seed rows
 * through the raw `db` handle.
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
  const d1 = {
    prepare(sql: string) {
      const bound = (args: SqlValue[]) => ({
        first: async () => db.prepare(sql).get(...args) ?? null,
        all: async () => ({ results: db.prepare(sql).all(...args) }),
        run: async () => {
          const info = db.prepare(sql).run(...args);
          return { meta: { changes: Number(info.changes) } };
        },
      });
      return { bind: (...args: SqlValue[]) => bound(args), ...bound([]) };
    },
  };
  return { db, d1 };
}
