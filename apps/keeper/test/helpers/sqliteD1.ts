/**
 * Minimal D1-shaped adapter over Node's built-in `node:sqlite`
 * (DatabaseSync) — a straight port of the indexer's test shim
 * (apps/indexer/test/helpers/sqliteD1.ts) for keeper tests whose
 * behaviour IS the SQL: the HF-band pass (#1213 PR 2b) reads/writes
 * shared `vaipakam-warm` tables the indexer migrations define, and —
 * since #2450 — its band state in the keeper's private database, so an
 * in-memory SQLite running the real migration DDL is a faithful query
 * engine. `./schemas.ts` builds one of each from the right migrations.
 * Only the tiny prepare/bind/first/all/run surface the keeper uses is
 * adapted.
 *
 * Kept deliberately narrow: no exec-through-D1, no named params.
 * `batch()` mirrors D1's all-or-nothing semantics with
 * BEGIN/COMMIT/ROLLBACK, and — since #2234 — carries each statement's
 * `results` and `meta.changes` the way D1 does. It returned a bare
 * `{ meta: {} }` while nothing read a batched result; `getRemitAckAttempts`
 * now reads one per chunk, and a fake that drops a field the real thing
 * carries cannot be used to test the code that reads it.
 *
 * WHAT THIS HARNESS STILL CANNOT CATCH, said plainly: node:sqlite has no
 * 100-bound-parameter cap, so an over-wide statement passes here and throws
 * on D1. Tests for the chunking therefore assert the SHAPE — how many
 * statements, how many binds each — and never rely on this engine refusing
 * anything.
 *
 * ONE D1 limit it does enforce (#2677): a LIKE or GLOB pattern over 50 bytes
 * is refused, with D1's own message, by overriding `like()` and `glob()` (the
 * functions SQLite evaluates the operators through). The match itself is still
 * SQLite's: the override checks the length and hands the operands to a second,
 * un-overridden connection. Without it, a pattern built from a Diamond address
 * passed every test here and failed every run on D1.
 */
import { DatabaseSync } from 'node:sqlite';

/** D1's cap on a LIKE or GLOB pattern, in bytes. */
export const D1_MAX_PATTERN_BYTES = 50;

function enforceD1PatternCap(db: DatabaseSync): void {
  const native = new DatabaseSync(':memory:');
  for (const op of ['LIKE', 'GLOB'] as const) {
    const plain = native.prepare(`SELECT (?2 ${op} ?1) AS r`);
    const escaped = op === 'LIKE' ? native.prepare(`SELECT (?2 LIKE ?1 ESCAPE ?3) AS r`) : null;
    // `X op Y` is evaluated as `op(Y, X)`: the pattern comes first.
    db.function(op.toLowerCase(), { varargs: true, deterministic: true }, (...args) => {
      const [pattern, value, escape] = args as SqlValue[];
      if (pattern !== null && Buffer.byteLength(String(pattern)) > D1_MAX_PATTERN_BYTES) {
        throw new Error('LIKE or GLOB pattern too complex');
      }
      const row = (escape === undefined || escaped === null ? plain.get(pattern, value) : escaped.get(pattern, value, escape)) as {
        r: SqlValue;
      };
      return row.r;
    });
  }
}

type SqlValue = number | string | bigint | null;

export interface SqliteD1 {
  /** Raw handle for DDL + row seeding in tests. */
  db: DatabaseSync;
  /** Cast this to `D1Database` when calling the code under test. */
  d1: unknown;
}

export function createSqliteD1(ddl: string[]): SqliteD1 {
  const db = new DatabaseSync(':memory:');
  enforceD1PatternCap(db);
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
     * `.all()`, not `.run()`, so a batched SELECT hands its rows back the way
     * D1 does (ported from the indexer's shim, #2231 r7 / #2234). `changes`
     * still comes from a separate read because node:sqlite's `all()` does not
     * report it and D1 carries both.
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
