/**
 * `recordActivityEvents` — the LEDGER half of the #1794 coverage guardrail,
 * enforced by EXECUTION (round-69 redesign).
 *
 * The property that matters for coverage: every decoded log the scan hands
 * the ledger produces exactly one `activity_events` INSERT, binding the
 * references `pluckActivityRefs` resolves for it, and the returned count is
 * the number of rows that actually landed. A ledger that skips iterations,
 * swallows a failure into a fake success, drops references on the floor, or
 * batches rows away would fail these assertions by observation — no
 * AST-level reasoning about loops, catches, or SQL string shapes required.
 */
import { describe, expect, it } from 'vitest';
import { pluckActivityRefs, recordActivityEvents } from '../src/chainIndexer';
import { surface, synthesizeArgs } from './helpers/activityRefsSynth';

interface Recorded {
  sql: string;
  binds: unknown[];
}

/**
 * Recording D1 stub. Every prepared statement is captured with its binds;
 * behavior is scripted per-call:
 *   - SELECTs answer with `selectResults`
 *   - the Nth activity INSERT reports `meta.changes` from `changesFor(n)`
 */
function fakeDb(opts?: {
  selectResults?: Array<Record<string, unknown>>;
  changesFor?: (insertOrdinal: number) => number;
}) {
  const statements: Recorded[] = [];
  // Statements whose run() actually EXECUTED — recorded separately from the
  // merely-bound set (Codex round-71 P2): a bound-but-never-run INSERT is a
  // row that never reaches D1, and counting it as a write let a fabricated
  // result stand in for an execution. The one-row-per-log assertions read
  // this set; `statements` remains for SELECT-shape assertions.
  const executed: Recorded[] = [];
  let insertOrdinal = 0;
  const db = {
    prepare(sql: string) {
      return {
        bind(...binds: unknown[]) {
          statements.push({ sql, binds });
          return {
            async run() {
              executed.push({ sql, binds });
              if (/INSERT[\s\S]*INTO\s+activity_events/i.test(sql)) {
                insertOrdinal += 1;
                return { meta: { changes: opts?.changesFor?.(insertOrdinal) ?? 1 } };
              }
              return { meta: { changes: 1 } };
            },
            async all() {
              executed.push({ sql, binds });
              return { results: opts?.selectResults ?? [] };
            },
            async first() {
              executed.push({ sql, binds });
              return (opts?.selectResults ?? [])[0] ?? null;
            },
            async raw() {
              executed.push({ sql, binds });
              return [];
            },
          };
        },
      };
    },
  };
  return { statements, executed, db };
}

const CHAIN_ID = 84532;

function makeLog(
  eventName: string,
  args: Record<string, unknown>,
  n: number,
): {
  eventName: string;
  args: Record<string, unknown>;
  blockNumber: bigint;
  transactionHash: string;
  logIndex: number;
} {
  return {
    eventName,
    args,
    blockNumber: BigInt(1000 + n),
    transactionHash: `0x${String(n).padStart(64, '0')}`,
    logIndex: n,
  };
}

const activityInserts = (statements: Recorded[]) =>
  statements.filter((s) => /INSERT[\s\S]*INTO\s+activity_events/i.test(s.sql));

describe('recordActivityEvents — executed against a recording DB', () => {
  it('inserts exactly one row per decoded log, binding the plucked references', async () => {
    const logs = [
      makeLog('LoanStatusChanged', { loanId: 41n, from: 0, to: 1 }, 1),
      makeLog('LoanStatusChanged', { loanId: 42n, from: 1, to: 2 }, 2),
      // an unmapped event still gets a row — with NULL references, which is
      // exactly what the coverage suite polices on the mapping side
      makeLog('SomeEventNobodyMapped', { foo: 7n }, 3),
    ];
    const { executed, db } = fakeDb();
    const inserted = await recordActivityEvents(
      logs,
      { DB: db } as never,
      CHAIN_ID,
      new Map([[logs[0].blockNumber, 111]]),
    );

    const inserts = activityInserts(executed);
    expect(inserts).toHaveLength(logs.length);
    expect(inserted).toBe(logs.length);

    // Bind layout: (chain_id, block_number, log_index, tx_hash, kind,
    //               loan_id, offer_id, actor, args_json, block_at)
    logs.forEach((log, i) => {
      const expected = pluckActivityRefs(log.eventName, log.args);
      const binds = inserts[i].binds;
      expect(binds[0]).toBe(CHAIN_ID);
      expect(binds[1]).toBe(Number(log.blockNumber));
      expect(binds[2]).toBe(log.logIndex);
      expect(binds[3]).toBe(log.transactionHash.toLowerCase());
      expect(binds[4]).toBe(log.eventName);
      expect(binds[5]).toBe(expected.loanId);
      expect(binds[6]).toBe(expected.offerId);
      expect(binds[7]).toBe(expected.actor);
      expect(typeof binds[8]).toBe('string'); // args_json survives serialization
    });
    expect(inserts[0].binds[5]).toBe(41);
    expect(inserts[1].binds[5]).toBe(42);
    expect(inserts[2].binds[5]).toBeNull();
  });

  it('records one row per event for EVERY compiled event', async () => {
    // The one-insert-per-log contract over the WHOLE derived surface, not a
    // hand-picked pair (Codex round-70 P2): `recordActivityEvents` carries
    // event-specific branches (the OfferConsumedBySale enrichment today),
    // and a future branch that skips or suppresses an insert for some other
    // real event must fail here — a two-event batch would never see it.
    // ALL compiled events, not only the reference-carrying subset (Codex
    // round-71 P2): actor-only events (Transfer, vault deposits, rewards)
    // traverse the same recording path and must each land a row too.
    const events = [...surface.argShapes.keys()].sort();
    const logs = events.map((e, i) => makeLog(e, synthesizeArgs(e), i + 1));
    const { executed, db } = fakeDb();
    const inserted = await recordActivityEvents(
      logs,
      { DB: db } as never,
      CHAIN_ID,
      new Map(),
    );
    const inserts = activityInserts(executed);
    expect(inserts).toHaveLength(logs.length);
    expect(inserted).toBe(logs.length);
    logs.forEach((log, i) => {
      const expected = pluckActivityRefs(log.eventName, log.args);
      expect(inserts[i].binds[4], `${log.eventName} row kind`).toBe(log.eventName);
      // loan_id / offer_id only — the actor can legitimately differ from a
      // raw-args pluck on the enrichment branch (creator merged in first).
      expect(inserts[i].binds[5], `${log.eventName} loan_id`).toBe(expected.loanId);
      expect(inserts[i].binds[6], `${log.eventName} offer_id`).toBe(expected.offerId);
    });
  });

  it('counts only rows that actually landed (INSERT OR IGNORE duplicates excluded)', async () => {
    const logs = [
      makeLog('LoanStatusChanged', { loanId: 1n, from: 0, to: 1 }, 1),
      makeLog('LoanStatusChanged', { loanId: 2n, from: 0, to: 1 }, 2),
      makeLog('LoanStatusChanged', { loanId: 3n, from: 0, to: 1 }, 3),
    ];
    // the second insert is a replay the unique index swallows
    const { executed, db } = fakeDb({ changesFor: (n) => (n === 2 ? 0 : 1) });
    const inserted = await recordActivityEvents(logs, { DB: db } as never, CHAIN_ID, new Map());
    expect(activityInserts(executed)).toHaveLength(3); // still executed per log
    expect(inserted).toBe(2); // but only the landed rows are counted
  });

  it('a failing insert propagates instead of advancing past the batch', async () => {
    const logs = [
      makeLog('LoanStatusChanged', { loanId: 1n, from: 0, to: 1 }, 1),
      makeLog('LoanStatusChanged', { loanId: 2n, from: 0, to: 1 }, 2),
    ];
    const { db } = fakeDb();
    const throwing = {
      prepare(sql: string) {
        const stmt = db.prepare(sql);
        return {
          bind(...binds: unknown[]) {
            const bound = stmt.bind(...binds);
            return {
              ...bound,
              async run() {
                if (/INSERT[\s\S]*INTO\s+activity_events/i.test(sql) && binds[5] === 2) {
                  throw new Error('D1 write failed');
                }
                return bound.run();
              },
            };
          },
        };
      },
    };
    // The caller (the scan) advances `indexer_cursor` only after this resolves,
    // so a rejected batch must REJECT — a swallowed failure here would let the
    // cursor advance past a log whose row never landed.
    await expect(
      recordActivityEvents(logs, { DB: throwing } as never, CHAIN_ID, new Map()),
    ).rejects.toThrow('D1 write failed');
  });

  it('enriches OfferConsumedBySale args with the offer creator for the participants walk', async () => {
    const logs = [makeLog('OfferConsumedBySale', { offerId: 9n, executor: '0xEXEC' }, 1)];
    const { executed, db } = fakeDb({
      selectResults: [{ offer_id: 9, creator: '0xborrower' }],
    });
    await recordActivityEvents(logs, { DB: db } as never, CHAIN_ID, new Map());
    const [insert] = activityInserts(executed);
    expect(insert).toBeDefined();
    expect(String(insert.binds[8])).toContain('"creator":"0xborrower"');
    // ...and the creator lookup bound EXACTLY the chain id followed by the
    // consumed offer ids (Codex round-70 P2): a stub that answers regardless
    // of bindings would keep this green while a production lookup that
    // dropped the ids or left placeholders unbound returns no creator — or
    // fails the whole batch — on real D1.
    const select = executed.find((s) => /FROM offers/i.test(s.sql));
    expect(select?.binds).toEqual([CHAIN_ID, 9]);
    expect((select?.sql.match(/\?/g) ?? []).length).toBe(select?.binds.length);
  });
});
