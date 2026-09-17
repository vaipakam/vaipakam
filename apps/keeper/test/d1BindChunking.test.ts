/**
 * D1's 100-bound-parameter cap at the call sites that meet it (#2234).
 *
 * `getRemitAckAttempts` passed one `?` per pending reservation into a single
 * statement, and its caller collects every Pending id in a scan window
 * `MAX_SCAN_PER_TICK = 200` wide. At 99 or more pending the statement
 * exceeded the cap and threw — every tick, identically, because a backlog
 * does not shrink while the pass that would drain it is failing. And the scan
 * cursor had already been persisted, so each failing tick moved past a window
 * whose acknowledgements were never attempted.
 *
 * WHAT THESE TESTS CAN AND CANNOT DO, stated rather than implied.
 *
 * The sqlite harness has NO bind limit: an over-wide statement runs happily
 * here and throws only on D1. So none of this asserts "the database rejected
 * it" — it asserts the SHAPE the fix produces, by counting the statements
 * issued and the binds in each. A test that merely called the function and
 * checked the answer would pass just as well with the fix reverted, which is
 * the trap this file exists to avoid.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { getRemitAckAttempts } from '../src/db';
import { D1_MAX_BOUND_PARAMETERS } from '@vaipakam/lib/d1Binds';
import { createSqliteD1, type SqliteD1 } from './helpers/sqliteD1';

const MIGRATIONS_DIR = new URL('../../indexer/migrations/', import.meta.url);
const ALL_MIGRATIONS = readdirSync(MIGRATIONS_DIR)
  .filter((f) => f.endsWith('.sql'))
  .sort()
  .map((f) => readFileSync(new URL(f, MIGRATIONS_DIR), 'utf8'));

const BASE_CHAIN = 84532;
const DIAMOND = '0x00000000000000000000000000000000000000dd';

/** Every statement the code under test bound, with its bind count. */
interface Recorded {
  sql: string;
  binds: number;
}

/**
 * Wrap the harness so each `.bind(...)` is recorded.
 *
 * Counting binds is the only way to see the cap from inside a harness that
 * does not enforce it.
 */
function recording(h: SqliteD1): { d1: unknown; statements: Recorded[] } {
  const statements: Recorded[] = [];
  const inner = h.d1 as {
    prepare: (sql: string) => { bind: (...a: unknown[]) => unknown };
    batch: (s: unknown[]) => Promise<unknown>;
  };
  const d1 = {
    prepare(sql: string) {
      const stmt = inner.prepare(sql) as Record<string, unknown> & {
        bind: (...a: unknown[]) => unknown;
      };
      return {
        ...stmt,
        bind: (...args: unknown[]) => {
          statements.push({ sql, binds: args.length });
          return stmt.bind(...args);
        },
      };
    },
    batch: (s: unknown[]) => inner.batch(s),
  };
  return { d1, statements };
}

function seedAttempt(h: SqliteD1, remitId: number, attempts: number, lastAt: number) {
  h.db
    .prepare(
      `INSERT INTO keeper_remit_ack
         (base_chain_id, diamond, remit_id, mirror_chain_id, attempts, last_attempt_at)
       VALUES (?, ?, ?, 11155111, ?, ?)`,
    )
    .run(BASE_CHAIN, DIAMOND, remitId, attempts, lastAt);
}

describe('getRemitAckAttempts — D1 bind cap', () => {
  it('keeps every statement within the cap for a full 200-id scan window', async () => {
    const h = createSqliteD1(ALL_MIGRATIONS);
    const ids = Array.from({ length: 200 }, (_, i) => i + 1);
    for (const id of ids) seedAttempt(h, id, id % 5, 1_700_000_000 + id);
    const { d1, statements } = recording(h);

    const out = await getRemitAckAttempts(d1 as never, BASE_CHAIN, DIAMOND, ids);

    expect(statements.length).toBeGreaterThan(1);
    for (const s of statements) {
      expect(s.binds).toBeLessThanOrEqual(D1_MAX_BOUND_PARAMETERS);
    }
    // Every id still answered — chunking must not lose the tail.
    expect(out.size).toBe(200);
    expect(out.get(200)).toEqual({ attempts: 0, lastAttemptAt: 1_700_000_200 });
    expect(out.get(1)).toEqual({ attempts: 1, lastAttemptAt: 1_700_000_001 });
  });

  it('is one statement when the window fits, so the chunking costs nothing at low volume', async () => {
    const h = createSqliteD1(ALL_MIGRATIONS);
    const ids = Array.from({ length: 12 }, (_, i) => i + 1);
    for (const id of ids) seedAttempt(h, id, 1, 1_700_000_000);
    const { d1, statements } = recording(h);

    await getRemitAckAttempts(d1 as never, BASE_CHAIN, DIAMOND, ids);

    expect(statements).toHaveLength(1);
    // 2 fixed binds (base chain, diamond) + 12 ids.
    expect(statements[0].binds).toBe(14);
  });

  it('issues no statement at all for an empty id list', async () => {
    const h = createSqliteD1(ALL_MIGRATIONS);
    const { d1, statements } = recording(h);

    const out = await getRemitAckAttempts(d1 as never, BASE_CHAIN, DIAMOND, []);

    expect(out.size).toBe(0);
    expect(statements).toHaveLength(0);
  });

  it('reports a missing row as absent rather than as zero attempts', async () => {
    // The caller distinguishes "never attempted" from "attempted at T" to
    // apply its backoff; a chunked read must not turn one into the other.
    const h = createSqliteD1(ALL_MIGRATIONS);
    seedAttempt(h, 7, 3, 1_700_000_777);
    const { d1 } = recording(h);

    const out = await getRemitAckAttempts(d1 as never, BASE_CHAIN, DIAMOND, [7, 8]);

    expect(out.get(7)).toEqual({ attempts: 3, lastAttemptAt: 1_700_000_777 });
    expect(out.has(8)).toBe(false);
  });

  it('does not read another diamond rows', async () => {
    // The diamond bind is one of the two fixed binds the chunker reserves;
    // dropping it from a chunk would widen the read silently.
    const h = createSqliteD1(ALL_MIGRATIONS);
    const other = '0x00000000000000000000000000000000000000ee';
    h.db
      .prepare(
        `INSERT INTO keeper_remit_ack
           (base_chain_id, diamond, remit_id, mirror_chain_id, attempts, last_attempt_at)
         VALUES (?, ?, 1, 11155111, 9, 1)`,
      )
      .run(BASE_CHAIN, other);
    const { d1 } = recording(h);

    const out = await getRemitAckAttempts(d1 as never, BASE_CHAIN, DIAMOND, [1]);

    expect(out.size).toBe(0);
  });
});
