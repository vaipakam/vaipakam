/**
 * The off-chain check on every loan-status change (#2337): the diagram it
 * enforces, the three ways an announcement can disagree with it, replay
 * safety, and what `/health/ingest` reports from it.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { createSqliteD1 } from './helpers/sqliteD1';
import {
  ALLOWED_LOAN_STATUS_EDGES,
  LIFECYCLE_LIST_LIMIT,
  LOAN_STATUS as S,
  judgeObservation,
  lifecycleObservations,
  readLifecycleHealth,
  recordLoanLifecycle,
  type LifecycleLog,
  type TrackedLoan,
} from '../src/loanLifecycleGuard';
import { readIngestHealth } from '../src/healthRoutes';
import { createSchemaGate } from '../src/schemaGate';

const MIGRATIONS_DIR = new URL('../migrations/', import.meta.url);
const migrations = () =>
  readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .map((f) => readFileSync(new URL(f, MIGRATIONS_DIR), 'utf8'));

const CHAIN = 84532;
const TX = (n: number) => `0x${n.toString(16).padStart(64, '0')}`;

function initiated(loanId: number, block: number, logIndex: number): LifecycleLog {
  return { eventName: 'LoanInitiated', args: { loanId: BigInt(loanId) }, blockNumber: BigInt(block), transactionHash: TX(block * 1000 + logIndex), logIndex };
}
function moved(loanId: number, from: number, to: number, block: number, logIndex: number): LifecycleLog {
  return {
    eventName: 'LoanStatusChanged',
    args: { loanId: BigInt(loanId), from, to },
    blockNumber: BigInt(block),
    transactionHash: TX(block * 1000 + logIndex),
    logIndex,
  };
}
const times = (...blocks: number[]) => new Map(blocks.map((b) => [BigInt(b), 1_700_000_000 + b]));

describe('the status diagram', () => {
  it('is the diagram the functional spec states, and Settled is final', () => {
    const edges = [...ALLOWED_LOAN_STATUS_EDGES].flatMap(([from, tos]) => [...tos].map((to) => `${from}->${to}`)).sort();
    expect(edges).toEqual(
      [
        `${S.Active}->${S.Repaid}`,
        `${S.Active}->${S.Defaulted}`,
        `${S.Active}->${S.FallbackPending}`,
        `${S.Active}->${S.InternalMatched}`,
        `${S.FallbackPending}->${S.Active}`,
        `${S.FallbackPending}->${S.Repaid}`,
        `${S.FallbackPending}->${S.Defaulted}`,
        `${S.FallbackPending}->${S.InternalMatched}`,
        `${S.Repaid}->${S.Settled}`,
        `${S.Defaulted}->${S.Settled}`,
        `${S.InternalMatched}->${S.Settled}`,
      ].sort(),
    );
    expect(ALLOWED_LOAN_STATUS_EDGES.get(S.Settled)?.size).toBe(0);
  });
});

describe('judgeObservation', () => {
  const at = (status: number, fromInitiation = true): TrackedLoan => ({ status, fromInitiation, lastBlock: 10, lastLogIndex: 3 });
  const obs = (from: number, to: number, block = 11, logIndex = 0) => lifecycleObservations([moved(1, from, to, block, logIndex)])[0];

  it('accepts an allowed move from the status last seen', () => {
    expect(judgeObservation(at(S.Active), obs(S.Active, S.FallbackPending))).toEqual({
      next: { status: S.FallbackPending, fromInitiation: true, lastBlock: 11, lastLogIndex: 0 },
      reasons: [],
      expected: S.Active,
    });
  });

  it('names a move the diagram does not allow, including an unknown status number', () => {
    expect(judgeObservation(at(S.Settled), obs(S.Settled, S.Active))?.reasons).toEqual(['edge']);
    expect(judgeObservation(at(S.Active), obs(S.Active, 9))?.reasons).toEqual(['edge']);
    expect(judgeObservation(at(S.Repaid), obs(S.Repaid, S.Defaulted))?.reasons).toEqual(['edge']);
  });

  it('names a move that does not start from the status last seen', () => {
    // Active → Repaid is allowed, but the last announcement left the loan Defaulted.
    expect(judgeObservation(at(S.Defaulted), obs(S.Active, S.Repaid))).toMatchObject({ reasons: ['continuity'], expected: S.Defaulted });
    expect(judgeObservation(at(S.Defaulted), obs(S.Active, S.Active))?.reasons).toEqual(['edge', 'continuity']);
  });

  it('checks a loan first seen part-way through its life against the diagram only', () => {
    const first = judgeObservation(null, obs(S.FallbackPending, S.Active));
    expect(first).toEqual({
      next: { status: S.Active, fromInitiation: false, lastBlock: 11, lastLogIndex: 0 },
      reasons: [],
      expected: null,
    });
    expect(judgeObservation(null, obs(S.Settled, S.Repaid))?.reasons).toEqual(['edge']);
  });

  it('names an initiation of a loan already being tracked', () => {
    const r = judgeObservation(at(S.Repaid), lifecycleObservations([initiated(1, 12, 0)])[0]);
    expect(r).toMatchObject({ reasons: ['reinitiated'], expected: S.Repaid, next: { status: S.Active, fromInitiation: true } });
  });

  it('skips an announcement at or before the position already applied (a replayed scan)', () => {
    expect(judgeObservation(at(S.Active), obs(S.Active, S.Repaid, 10, 3))).toBeNull();
    expect(judgeObservation(at(S.Active), obs(S.Active, S.Repaid, 10, 1))).toBeNull();
    expect(judgeObservation(at(S.Active), obs(S.Active, S.Repaid, 9, 99))).toBeNull();
    expect(judgeObservation(at(S.Active), obs(S.Active, S.Repaid, 10, 4))).not.toBeNull();
  });
});

describe('recordLoanLifecycle', () => {
  const db = () => createSqliteD1(migrations());

  it('tracks a loan from initiation through settlement with no violation, in chain order whatever the log order', async () => {
    const h = db();
    const logs = [moved(1, S.Repaid, S.Settled, 101, 2), moved(1, S.Active, S.Repaid, 101, 1), initiated(1, 100, 5)];
    const r = await recordLoanLifecycle(h.d1 as never, CHAIN, logs, times(100, 101));
    expect(r).toEqual({ applied: 3, violations: 0 });
    expect(h.db.prepare('SELECT * FROM loan_lifecycle_state').all()).toEqual([
      { chain_id: CHAIN, loan_id: 1, status: S.Settled, from_initiation: 1, last_block: 101, last_log_index: 2 },
    ]);
    expect(h.db.prepare('SELECT COUNT(*) AS n FROM loan_lifecycle_violation').get()).toEqual({ n: 0 });
  });

  it('records each disagreement once, with the status last seen, and keeps tracking', async () => {
    const h = db();
    await recordLoanLifecycle(h.d1 as never, CHAIN, [initiated(7, 100, 0), moved(7, S.Active, S.Defaulted, 100, 1)], times(100));
    // The next announcement claims the loan left Repaid, which it never reached.
    const logs = [moved(7, S.Repaid, S.Settled, 105, 4)];
    expect(await recordLoanLifecycle(h.d1 as never, CHAIN, logs, times(105))).toEqual({ applied: 1, violations: 1 });
    // Replayed: nothing re-applied, nothing recorded twice.
    expect(await recordLoanLifecycle(h.d1 as never, CHAIN, logs, times(105))).toEqual({ applied: 0, violations: 0 });
    expect(h.db.prepare('SELECT * FROM loan_lifecycle_violation').all()).toEqual([
      {
        chain_id: CHAIN,
        tx_hash: TX(105_004),
        log_index: 4,
        loan_id: 7,
        block_number: 105,
        event: 'LoanStatusChanged',
        from_status: S.Repaid,
        to_status: S.Settled,
        expected_status: S.Defaulted,
        reasons: 'continuity',
        block_time: 1_700_000_105,
      },
    ]);
    expect(h.db.prepare('SELECT status FROM loan_lifecycle_state WHERE loan_id = 7').get()).toEqual({ status: S.Settled });
  });

  it('writes nothing for a block with no loan announcements', async () => {
    const h = db();
    const other: LifecycleLog = { eventName: 'OfferCreated', args: {}, blockNumber: 5n, transactionHash: TX(1), logIndex: 0 };
    expect(await recordLoanLifecycle(h.d1 as never, CHAIN, [other], new Map())).toEqual({ applied: 0, violations: 0 });
  });

  it('refuses to record a violation without the chain time of its block', async () => {
    const h = db();
    await expect(recordLoanLifecycle(h.d1 as never, CHAIN, [moved(1, S.Settled, S.Active, 9, 0)], new Map())).rejects.toThrow(/no chain time/);
    // Nothing was written: the state change and the violation travel together.
    expect(h.db.prepare('SELECT COUNT(*) AS n FROM loan_lifecycle_state').get()).toEqual({ n: 0 });
  });
});

describe('readLifecycleHealth', () => {
  it('reports per chain the loans tracked, how many from initiation, and every violation counted', async () => {
    const h = createSqliteD1(migrations());
    await recordLoanLifecycle(h.d1 as never, CHAIN, [initiated(1, 100, 0), moved(2, S.Active, S.Repaid, 100, 1)], times(100));
    await recordLoanLifecycle(h.d1 as never, 97, [moved(3, S.Settled, S.Active, 50, 0)], times(50));
    const out = await readLifecycleHealth(h.d1 as never);
    expect(out?.chains).toEqual([
      {
        chainId: 97,
        trackedLoans: 1,
        trackedFromInitiation: 0,
        violations: 1,
        listed: [
          {
            txHash: TX(50_000),
            logIndex: 0,
            loanId: 3,
            blockNumber: 50,
            event: 'LoanStatusChanged',
            from: S.Settled,
            to: S.Active,
            expected: null,
            reasons: ['edge'],
            blockTime: 1_700_000_050,
          },
        ],
        truncated: false,
      },
      { chainId: CHAIN, trackedLoans: 2, trackedFromInitiation: 1, violations: 0, listed: [], truncated: false },
    ]);
  });

  it('lists at most the limit, oldest first, and says the list is truncated', async () => {
    const h = createSqliteD1(migrations());
    const n = LIFECYCLE_LIST_LIMIT + 3;
    const logs = Array.from({ length: n }, (_, i) => moved(1000 + i, S.Settled, S.Active, 200 + i, 0));
    await recordLoanLifecycle(h.d1 as never, CHAIN, logs, times(...logs.map((_, i) => 200 + i)));
    const c = (await readLifecycleHealth(h.d1 as never))!.chains[0];
    expect(c.violations).toBe(n);
    expect(c.listed).toHaveLength(LIFECYCLE_LIST_LIMIT);
    expect(c.listed[0].blockNumber).toBe(200);
    expect(c.truncated).toBe(true);
  });

  it('is null only while the tables do not exist, and a failed read throws', async () => {
    expect(await readLifecycleHealth(createSqliteD1([]).d1 as never)).toBeNull();
    const faulty = {
      prepare: () => {
        throw new Error('D1_ERROR: internal error');
      },
    };
    await expect(readLifecycleHealth(faulty as never)).rejects.toThrow(/internal error/);
  });

  it('is part of the /health/ingest answer', async () => {
    const h = createSqliteD1(migrations());
    await recordLoanLifecycle(h.d1 as never, CHAIN, [moved(3, S.Settled, S.Active, 50, 0)], times(50));
    const out = await readIngestHealth(h.d1 as never, [CHAIN], createSchemaGate(), 1_100);
    expect(out.lifecycle?.chains.map((c) => [c.chainId, c.violations])).toEqual([[CHAIN, 1]]);
  });
});
