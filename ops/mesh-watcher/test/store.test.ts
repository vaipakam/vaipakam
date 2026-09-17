/**
 * `AlertStore` retention semantics, over the real schema.
 *
 * The existing suite exercises only this module's failure contract — that a
 * D1 rejection comes back as a value rather than a throw. Nothing checked
 * what the retention ops actually DELETE, which is how the two of them could
 * be rewritten (#2234, Codex #2235 r1 P2) with 239 green tests saying nothing
 * about whether the behaviour survived.
 *
 * WHY THEY WERE REWRITTEN. Both were `DELETE … WHERE x NOT IN (keep)`, which
 * carries the whole keep set as bound parameters in ONE statement, and D1
 * caps a statement at 100 of them. A `NOT IN` cannot be split the way an
 * `IN` can — `NOT IN (A)` then `NOT IN (B)` deletes everything in B on the
 * first pass — so they are phrased positively now: read what is stored, work
 * out what is not kept, delete that in bounded batches.
 *
 * WHAT THESE TESTS CANNOT DO: node:sqlite has no bind limit, so an over-wide
 * statement runs happily here. The width assertions therefore count binds
 * rather than relying on the engine to refuse anything.
 */
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { AlertStore, type StoreOp } from '../src/store';

const DDL = readFileSync(new URL('../migrations/0001_init.sql', import.meta.url), 'utf8');

type SqlValue = number | string | null;

/** Minimal D1-shaped adapter, recording each statement's bind count. */
function harness() {
  const db = new DatabaseSync(':memory:');
  db.exec(DDL);
  const bound: { sql: string; binds: number }[] = [];
  const make = (sql: string, args: SqlValue[]) => ({
    all: async () => ({ results: db.prepare(sql).all(...args) }),
    first: async () => db.prepare(sql).get(...args) ?? null,
    run: async () => ({ meta: { changes: Number(db.prepare(sql).run(...args).changes) } }),
    /**
     * `.all()`, not `.run()`, so a batched SELECT hands its rows back the way
     * D1 does — `selectDue` now reads through `batch()` and a shim that
     * dropped the rows would make it look like nothing had ever been sent.
     * (The same correction the indexer's and keeper's shims carry.)
     */
    __exec: () => db.prepare(sql).all(...args),
  });
  const d1 = {
    prepare(sql: string) {
      return {
        bind: (...args: SqlValue[]) => {
          bound.push({ sql, binds: args.length });
          return make(sql, args);
        },
        ...make(sql, []),
      };
    },
    async batch(stmts: Array<{ __exec: () => unknown }>) {
      db.exec('BEGIN');
      try {
        const out = stmts.map((s) => s.__exec());
        db.exec('COMMIT');
        return out.map((rows) => ({ results: rows as unknown[], meta: {} }));
      } catch (err) {
        db.exec('ROLLBACK');
        throw err;
      }
    },
  };
  return { db, bound, store: new AlertStore(d1 as unknown as D1Database) };
}

function seedStreak(db: DatabaseSync, chainId: number, signal = 'sig') {
  db.prepare(
    `INSERT INTO streak_state (chain_id, signal, marker, streak, updated_at)
     VALUES (?, ?, '0', 1, 0)`,
  ).run(chainId, signal);
}

function seedAlert(db: DatabaseSync, key: string) {
  db.prepare(
    `INSERT INTO alert_sent (alert_key, last_sent_at, fingerprint) VALUES (?, 0, 'f')`,
  ).run(key);
}

const streakChains = (db: DatabaseSync) =>
  (db.prepare('SELECT DISTINCT chain_id FROM streak_state ORDER BY chain_id').all() as {
    chain_id: number;
  }[]).map((r) => r.chain_id);

const alertKeys = (db: DatabaseSync) =>
  (db.prepare('SELECT alert_key FROM alert_sent ORDER BY alert_key').all() as {
    alert_key: string;
  }[]).map((r) => r.alert_key);

describe('pruneStreaks', () => {
  it('keeps exactly the named chains and drops the rest', async () => {
    const { db, store } = harness();
    for (const id of [1, 2, 3, 4]) seedStreak(db, id);

    const r = await store.commit([{ kind: 'pruneStreaks', keepChainIds: [2, 4] }]);

    expect(r.ok).toBe(true);
    expect(streakChains(db)).toEqual([2, 4]);
  });

  it('keeps every row of a kept chain, across signals', async () => {
    // The delete is keyed on chain, not on (chain, signal) — a rewrite that
    // dropped the other signals' rows would still leave the chain present.
    const { db, store } = harness();
    seedStreak(db, 7, 'a');
    seedStreak(db, 7, 'b');
    seedStreak(db, 8, 'a');

    await store.commit([{ kind: 'pruneStreaks', keepChainIds: [7] }]);

    expect(
      (db.prepare('SELECT signal FROM streak_state ORDER BY signal').all() as {
        signal: string;
      }[]).map((r) => r.signal),
    ).toEqual(['a', 'b']);
  });

  it('empties the table when nothing is kept', async () => {
    const { db, store } = harness();
    for (const id of [1, 2]) seedStreak(db, id);

    await store.commit([{ kind: 'pruneStreaks', keepChainIds: [] }]);

    expect(streakChains(db)).toEqual([]);
  });

  it('deletes nothing when every stored chain is kept', async () => {
    const { db, store } = harness();
    for (const id of [1, 2]) seedStreak(db, id);

    await store.commit([{ kind: 'pruneStreaks', keepChainIds: [1, 2, 99] }]);

    expect(streakChains(db)).toEqual([1, 2]);
  });

  it('stays within D1 bind cap with a keep set far past it', async () => {
    // The chain set is read from the canonical Diamond's
    // `getExpectedSourceChainIds()`, which has no on-chain length ceiling —
    // the reason the old `NOT IN` phrasing was unsound.
    const { db, bound, store } = harness();
    for (let id = 1; id <= 400; id++) seedStreak(db, id);
    const keep = Array.from({ length: 150 }, (_, i) => i + 1);

    await store.commit([{ kind: 'pruneStreaks', keepChainIds: keep }]);

    expect(streakChains(db)).toEqual(keep);
    const deletes = bound.filter((b) => /DELETE FROM streak_state/.test(b.sql));
    expect(deletes.length).toBeGreaterThan(1);
    for (const d of deletes) expect(d.binds).toBeLessThanOrEqual(100);
  });
});

describe('retainAlerts', () => {
  it('keeps exactly the named keys and drops the rest', async () => {
    const { db, store } = harness();
    for (const k of ['a', 'b', 'c']) seedAlert(db, k);

    await store.commit([{ kind: 'retainAlerts', keepKeys: ['b'] }]);

    expect(alertKeys(db)).toEqual(['b']);
  });

  it('empties the table when nothing is kept', async () => {
    const { db, store } = harness();
    for (const k of ['a', 'b']) seedAlert(db, k);

    await store.commit([{ kind: 'retainAlerts', keepKeys: [] }]);

    expect(alertKeys(db)).toEqual([]);
  });

  it('stays within D1 bind cap with a keep set far past it', async () => {
    const { db, bound, store } = harness();
    for (let i = 0; i < 300; i++) seedAlert(db, `k${String(i).padStart(3, '0')}`);
    const keep = Array.from({ length: 120 }, (_, i) => `k${String(i).padStart(3, '0')}`);

    await store.commit([{ kind: 'retainAlerts', keepKeys: keep }]);

    expect(alertKeys(db)).toEqual(keep);
    const deletes = bound.filter((b) => /DELETE FROM alert_sent/.test(b.sql));
    expect(deletes.length).toBeGreaterThan(1);
    for (const d of deletes) expect(d.binds).toBeLessThanOrEqual(100);
  });
});

describe('selectDue', () => {
  it('suppresses a repeat inside the quiet window and passes a changed fingerprint', async () => {
    const { db, store } = harness();
    db.prepare(
      `INSERT INTO alert_sent (alert_key, last_sent_at, fingerprint) VALUES ('same', 100, 'f1')`,
    ).run();
    db.prepare(
      `INSERT INTO alert_sent (alert_key, last_sent_at, fingerprint) VALUES ('moved', 100, 'f1')`,
    ).run();

    const r = await store.selectDue(
      [
        { key: 'same', fingerprint: 'f1' },
        { key: 'moved', fingerprint: 'f2' },
        { key: 'fresh', fingerprint: 'f3' },
      ],
      3600,
      150,
    );

    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.map((c) => c.key).sort()).toEqual(['fresh', 'moved']);
  });

  it('stays within D1 bind cap for a candidate list past it, and still suppresses', async () => {
    const { db, bound, store } = harness();
    const keys = Array.from({ length: 250 }, (_, i) => `k${String(i).padStart(3, '0')}`);
    // Every other candidate has been sent recently with the same fingerprint.
    for (let i = 0; i < keys.length; i += 2) {
      db.prepare(
        `INSERT INTO alert_sent (alert_key, last_sent_at, fingerprint) VALUES (?, 100, 'f')`,
      ).run(keys[i]);
    }

    const r = await store.selectDue(
      keys.map((k) => ({ key: k, fingerprint: 'f' })),
      3600,
      150,
    );

    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toHaveLength(125);
    const reads = bound.filter((b) => /FROM alert_sent WHERE alert_key IN/.test(b.sql));
    expect(reads.length).toBeGreaterThan(1);
    for (const rd of reads) expect(rd.binds).toBeLessThanOrEqual(100);
  });
});

describe('commit still cannot throw', () => {
  const exploding = {
    prepare() {
      throw new Error('D1_ERROR: database is unavailable');
    },
    batch() {
      throw new Error('D1_ERROR: database is unavailable');
    },
  } as unknown as D1Database;

  it('returns a failure when the retention READ itself fails', async () => {
    // The positive phrasing added a read inside `build`. It happens inside
    // `commit`'s guard on purpose — a throw from it must come back as a
    // value like every other failure this module absorbs (#1443 r8 P1).
    const ops: StoreOp[] = [{ kind: 'pruneStreaks', keepChainIds: [1, 2] }];
    const r = await new AlertStore(exploding).commit(ops);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.failure.kind).toBe('storage');
  });
});
