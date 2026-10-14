/**
 * HF-liquidation terminal-status projection (#1293).
 *
 * `HFLiquidationTriggered` (full + split terminal) and `LiquidationDiscounted`
 * terminalize a loan Active→Defaulted on-chain via
 * `EncumbranceMutateFacet.terminalize` and emit ONLY their own event — no
 * `LoanDefaulted` companion. Before this fix the indexer had no branch for
 * them, so an HF-liquidated loan was stranded `active` in D1 forever. These
 * tests drive `processLoanLogs` directly (the HF branch flips status off the
 * event alone — no RPC) and assert the projection + its idempotency.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { Env } from '../src/env';
import { processLoanLogs, settleFromLedger, settleLoanRow } from '../src/chainIndexer';
import { createBudget } from '../src/subrequestBudget';
import { createSqliteD1, type SqliteD1 } from './helpers/sqliteD1';

const MIGRATIONS_DIR = new URL('../migrations/', import.meta.url);
const ALL_MIGRATIONS = readdirSync(MIGRATIONS_DIR)
  .filter((f) => f.endsWith('.sql'))
  .sort()
  .map((f) => readFileSync(new URL(f, MIGRATIONS_DIR), 'utf8'));

const CHAIN = 84532;
const DIAMOND = '0x00000000000000000000000000000000000d1a90' as never;
// The HF branches never call the client; a stub that throws surfaces any
// unexpected RPC use as a loud test failure.
const stubClient = {
  readContract: async () => {
    throw new Error('unexpected RPC in an HF-only scan');
  },
} as never;

function seedLoan(h: SqliteD1, loanId: number, status: string) {
  h.db
    .prepare(
      `INSERT INTO loans (chain_id, loan_id, offer_id, status, lender, borrower,
         principal, collateral_amount, asset_type, collateral_asset_type,
         lending_asset, collateral_asset, duration_days, token_id,
         collateral_token_id, lender_token_id, borrower_token_id,
         lender_current_owner, borrower_current_owner, interest_rate_bps,
         start_time, start_block, start_at, updated_at)
       VALUES (?, ?, 1, ?, '0xlend', '0xborrow', '100', '200', 0, 0,
         '0xasset', '0xcoll', 30, '0', '0', '1', '2', '0xlend', '0xborrow',
         500, 0, 0, 0, 0)`,
    )
    .run(CHAIN, loanId, status);
}

function seedActiveLoan(h: SqliteD1, loanId: number) {
  h.db
    .prepare(
      `INSERT INTO loans (chain_id, loan_id, offer_id, status, lender, borrower,
         principal, collateral_amount, asset_type, collateral_asset_type,
         lending_asset, collateral_asset, duration_days, token_id,
         collateral_token_id, lender_token_id, borrower_token_id,
         lender_current_owner, borrower_current_owner, interest_rate_bps,
         start_time, start_block, start_at, updated_at)
       VALUES (?, ?, 1, 'active', '0xlend', '0xborrow', '100', '200', 0, 0,
         '0xasset', '0xcoll', 30, '0', '0', '1', '2', '0xlend', '0xborrow',
         500, 0, 0, 0, 0)`,
    )
    .run(CHAIN, loanId);
}

const hfLog = (
  eventName: string,
  loanId: number,
  block = 100,
  logIndex = 0,
) => ({
  eventName,
  args: {
    loanId: BigInt(loanId),
    liquidator: '0x00000000000000000000000000000000000000ee',
    proceeds: 0n,
  },
  blockNumber: BigInt(block),
  transactionHash: `0x${'ab'.repeat(32)}`,
  logIndex,
});

const statusOf = (h: SqliteD1, loanId: number) =>
  (
    h.db
      .prepare('SELECT status FROM loans WHERE chain_id = ? AND loan_id = ?')
      .get(CHAIN, loanId) as { status: string }
  ).status;

describe('processLoanLogs — HF-liquidation status projection (#1293)', () => {
  const run = (h: SqliteD1, logs: ReturnType<typeof hfLog>[]) =>
    processLoanLogs(
      logs,
      { DB: h.d1 } as unknown as Env,
      CHAIN,
      new Map([[100n, 500]]),
      stubClient,
      DIAMOND,
    );

  it('flips an active loan to defaulted on HFLiquidationTriggered', async () => {
    const h = createSqliteD1(ALL_MIGRATIONS);
    seedActiveLoan(h, 7);
    const res = await run(h, [hfLog('HFLiquidationTriggered', 7)]);
    expect(res.statusUpdates).toBe(1);
    expect(statusOf(h, 7)).toBe('defaulted');
  });

  it('flips an active loan to defaulted on LiquidationDiscounted', async () => {
    const h = createSqliteD1(ALL_MIGRATIONS);
    seedActiveLoan(h, 8);
    const res = await run(h, [hfLog('LiquidationDiscounted', 8)]);
    expect(res.statusUpdates).toBe(1);
    expect(statusOf(h, 8)).toBe('defaulted');
  });

  it('is idempotent on re-scan (guarded on status = active)', async () => {
    const h = createSqliteD1(ALL_MIGRATIONS);
    seedActiveLoan(h, 9);
    await run(h, [hfLog('HFLiquidationTriggered', 9)]);
    const res2 = await run(h, [hfLog('HFLiquidationTriggered', 9)]);
    expect(res2.statusUpdates).toBe(0); // already terminal — no-op
    expect(statusOf(h, 9)).toBe('defaulted');
  });
});

/**
 * #1782 — `LoanStatusChanged`, emitted by `LibLifecycle.transition` for EVERY
 * status edge, is the general safety net behind the specific handlers above.
 * These assert exactly what the handler claims: it flips a stranded row to the
 * terminal status the chain reports, skips the non-terminal edges rather than
 * overwriting a status with a guess, promotes a rescued `fallback_pending` row,
 * and leaves an ALREADY-terminal row alone (Repaid→Settled belongs to the claim
 * handlers, which know whether both sides have claimed).
 *
 * Enum slots are append-only and stable: Active=0, Repaid=1, Defaulted=2,
 * Settled=3, FallbackPending=4, InternalMatched=5.
 */
const statusChangedLog = (
  loanId: number,
  from: number,
  to: number,
  block = 100,
  logIndex = 0,
) => ({
  eventName: 'LoanStatusChanged',
  args: { loanId: BigInt(loanId), from, to },
  blockNumber: BigInt(block),
  transactionHash: `0x${'cd'.repeat(32)}`,
  logIndex,
});

describe('processLoanLogs — LoanStatusChanged safety net (#1782)', () => {
  const run = (h: SqliteD1, logs: ReturnType<typeof statusChangedLog>[]) =>
    processLoanLogs(
      logs,
      { DB: h.d1 } as unknown as Env,
      CHAIN,
      new Map([[100n, 500]]),
      stubClient,
      DIAMOND,
    );

  it.each([
    ['Repaid', 1, 'repaid'],
    ['Defaulted', 2, 'defaulted'],
    ['Settled', 3, 'settled'],
    ['InternalMatched', 5, 'internal_matched'],
  ])('flips an active loan on a terminal edge to %s', async (_n, to, want) => {
    const h = createSqliteD1(ALL_MIGRATIONS);
    seedActiveLoan(h, 20);
    const res = await run(h, [statusChangedLog(20, 0, to as number)]);
    expect(res.statusUpdates).toBe(1);
    expect(statusOf(h, 20)).toBe(want);
  });

  it.each([
    ['Active (a FallbackPending cure)', 0],
    ['FallbackPending', 4],
  ])('does NOT overwrite status on a non-terminal edge to %s', async (_n, to) => {
    const h = createSqliteD1(ALL_MIGRATIONS);
    seedActiveLoan(h, 21);
    const res = await run(h, [statusChangedLog(21, 1, to as number)]);
    expect(res.statusUpdates).toBe(0);
    expect(statusOf(h, 21)).toBe('active');
  });

  it('maps an unknown future enum value to no status write', async () => {
    const h = createSqliteD1(ALL_MIGRATIONS);
    seedActiveLoan(h, 22);
    const res = await run(h, [statusChangedLog(22, 0, 99)]);
    expect(res.statusUpdates).toBe(0);
    expect(statusOf(h, 22)).toBe('active');
  });

  it('promotes a rescued fallback_pending row', async () => {
    const h = createSqliteD1(ALL_MIGRATIONS);
    seedLoan(h, 23, 'fallback_pending');
    const res = await run(h, [statusChangedLog(23, 4, 1)]);
    expect(res.statusUpdates).toBe(1);
    expect(statusOf(h, 23)).toBe('repaid');
  });

  it('leaves an ALREADY-terminal row alone (Repaid -> Settled)', async () => {
    const h = createSqliteD1(ALL_MIGRATIONS);
    seedLoan(h, 24, 'repaid');
    const res = await run(h, [statusChangedLog(24, 1, 3)]);
    expect(res.statusUpdates).toBe(0);
    expect(statusOf(h, 24)).toBe('repaid'); // the claim handlers own this edge
  });

  // The skip cases above cannot discriminate on their own: "nothing happened"
  // is also what you get with no handler at all. This one pairs a skipped edge
  // with a flipped one in the SAME scan, so exactly-one update proves the
  // handler ran AND chose correctly.
  it('skips the non-terminal edge while flipping the terminal one in one scan', async () => {
    const h = createSqliteD1(ALL_MIGRATIONS);
    seedActiveLoan(h, 26); // gets a FallbackPending edge — must stay active
    seedActiveLoan(h, 27); // gets a Repaid edge — must flip
    const res = await run(h, [
      statusChangedLog(26, 0, 4, 100, 0),
      statusChangedLog(27, 0, 1, 100, 1),
    ]);
    expect(res.statusUpdates).toBe(1);
    expect(statusOf(h, 26)).toBe('active');
    expect(statusOf(h, 27)).toBe('repaid');
  });

  it('is idempotent on re-scan', async () => {
    const h = createSqliteD1(ALL_MIGRATIONS);
    seedActiveLoan(h, 25);
    await run(h, [statusChangedLog(25, 0, 1)]);
    const res2 = await run(h, [statusChangedLog(25, 0, 1)]);
    expect(res2.statusUpdates).toBe(0);
    expect(statusOf(h, 25)).toBe('repaid');
  });
});

/**
 * #1782 round-1 P1 — the safety net must not pre-empt a specific handler.
 *
 * `LoanStatusChanged` is emitted by `LibLifecycle.transition` from INSIDE
 * `EncumbranceMutateFacet.terminalize*`, so on an internal match it carries a
 * lower log index than the outer `InternalMatchExecuted` and is seen first.
 * Both writes are guarded on `status IN ('active','fallback_pending')`, so a
 * safety-net write applied inline consumed the guard and `applyMatch`'s
 * write — the one that also refreshes `principal`/`collateral_amount` from a
 * block-pinned read — matched zero rows.
 *
 * These two cases are the reason the safety net is deferred to after the log
 * loop. Both FAIL against the inline version, which is what makes them worth
 * having: the first leaves principal stale at its seeded value, the second
 * strands the row at `internal_matched`.
 */
describe('processLoanLogs — safety net defers to specific handlers (#1782)', () => {
  const detailsClient = (principal: bigint, collateral: bigint, status: number) =>
    ({
      readContract: async () => ({
        principal,
        collateralAmount: collateral,
        status,
      }),
    }) as never;

  const rowOf = (h: SqliteD1, loanId: number) =>
    h.db
      .prepare(
        'SELECT status, principal, collateral_amount FROM loans WHERE chain_id = ? AND loan_id = ?',
      )
      .get(CHAIN, loanId) as {
      status: string;
      principal: string;
      collateral_amount: string;
    };

  it('lets InternalMatchExecuted refresh principal/collateral despite an earlier status edge', async () => {
    const h = createSqliteD1(ALL_MIGRATIONS);
    seedActiveLoan(h, 30); // seeded principal '100', collateral '200'

    const res = await processLoanLogs(
      [
        // Emitted inside terminalize* — lower log index, seen first.
        statusChangedLog(30, 0, 5, 100, 0),
        {
          eventName: 'InternalMatchExecuted',
          args: { loanIdA: 30n, loanIdB: 0n, loanIdC: 0n },
          blockNumber: 100n,
          transactionHash: `0x${'ef'.repeat(32)}`,
          logIndex: 1,
        },
      ] as never,
      { DB: h.d1 } as unknown as Env,
      CHAIN,
      new Map([[100n, 500]]),
      // Chain's block-pinned post-image: fully matched, so principal and
      // collateral are cleared and the status is InternalMatched(5).
      detailsClient(0n, 0n, 5),
      DIAMOND,
    );

    const row = rowOf(h, 30);
    expect(row.status).toBe('internal_matched');
    // THE discriminating assertion. Inline application left these at the
    // seeded '100'/'200' because applyMatch's guarded UPDATE matched no rows.
    expect(row.principal).toBe('0');
    expect(row.collateral_amount).toBe('0');
    expect(res.statusUpdates).toBeGreaterThanOrEqual(1);
  });

  it('takes the LAST edge, so a same-block claim-time settle lands on settled', async () => {
    const h = createSqliteD1(ALL_MIGRATIONS);
    seedActiveLoan(h, 32);

    const res = await processLoanLogs(
      [
        statusChangedLog(32, 0, 5, 100, 0), // Active -> InternalMatched
        statusChangedLog(32, 5, 3, 100, 1), // InternalMatched -> Settled
      ] as never,
      { DB: h.d1 } as unknown as Env,
      CHAIN,
      new Map([[100n, 500]]),
      stubClient,
      DIAMOND,
    );

    // Inline application wrote `internal_matched` on the first edge and then
    // no-opped on the second, stranding the row — and `LoanSettled` only
    // promotes an already-terminal row, so nothing later corrected it. That is
    // the #762 / #766 behaviour this must not regress.
    expect(statusOf(h, 32)).toBe('settled');
    expect(res.statusUpdates).toBe(1);
  });
});

describe('processLoanLogs — LoanSettled is authoritative (#2464)', () => {
  const settledLog = (loanId: number, block = 100, logIndex = 0) => ({
    eventName: 'LoanSettled',
    args: { loanId: BigInt(loanId) },
    blockNumber: BigInt(block),
    transactionHash: `0x${'ef'.repeat(32)}`,
    logIndex,
  });
  const run = (h: SqliteD1, logs: unknown[]) =>
    processLoanLogs(logs as never, { DB: h.d1 } as unknown as Env, CHAIN, new Map([[100n, 500]]), stubClient, DIAMOND);

  it('settles an internally matched row — the case the hand-listed statuses left out', async () => {
    const h = createSqliteD1(ALL_MIGRATIONS);
    seedLoan(h, 40, 'internal_matched');
    const res = await run(h, [settledLog(40)]);
    expect(res.statusUpdates).toBe(1);
    expect(statusOf(h, 40)).toBe('settled');
  });

  it('dates the settlement by the event block, not the scan time, and leaves it unknown without one', async () => {
    const h = createSqliteD1(ALL_MIGRATIONS);
    seedLoan(h, 46, 'internal_matched');
    seedLoan(h, 47, 'internal_matched');
    // Block 100 has a known time (500, from `run`); block 999 does not.
    await run(h, [settledLog(46, 100, 0), settledLog(47, 999, 0)]);
    const at = (id: number) =>
      (h.db.prepare('SELECT terminal_block AS b, terminal_at AS t FROM loans WHERE chain_id = ? AND loan_id = ?').get(CHAIN, id) as {
        b: number;
        t: number | null;
      });
    expect(at(46)).toEqual({ b: 100, t: 500 });
    expect(at(47)).toEqual({ b: 999, t: null });
  });

  it('treats the scan’s wall-clock SENTINEL for a failed block read as unknown, not as the settlement time', async () => {
    const h = createSqliteD1(ALL_MIGRATIONS);
    seedLoan(h, 48, 'internal_matched');
    // What the production caller does when getBlock fails: the map holds
    // now() for the block, and the block is named in the fallback set.
    await processLoanLogs(
      [settledLog(48, 100, 0)] as never,
      { DB: h.d1 } as unknown as Env,
      CHAIN,
      new Map([[100n, 1_999_999_999]]),
      stubClient,
      DIAMOND,
      new Set([100n]),
    );
    const r = h.db.prepare('SELECT status, terminal_at AS t FROM loans WHERE chain_id = ? AND loan_id = ?').get(CHAIN, 48) as {
      status: string;
      t: number | null;
    };
    expect(r).toEqual({ status: 'settled', t: null });
  });

  it('still settles the terminal statuses it always did, and is idempotent on an already-settled row', async () => {
    const h = createSqliteD1(ALL_MIGRATIONS);
    for (const [id, st] of [
      [41, 'repaid'],
      [42, 'defaulted'],
      [43, 'liquidated'],
    ] as const) {
      seedLoan(h, id, st);
    }
    seedLoan(h, 44, 'settled');
    // Already settled AND dated: left alone (an undated one would take the
    // event's time — see settleLoanRow).
    h.db.prepare('UPDATE loans SET terminal_block = 90, terminal_at = 400 WHERE chain_id = ? AND loan_id = 44').run(CHAIN);
    const res = await run(h, [settledLog(41, 100, 0), settledLog(42, 100, 1), settledLog(43, 100, 2), settledLog(44, 100, 3)]);
    expect(res.statusUpdates).toBe(3);
    for (const id of [41, 42, 43, 44]) expect(statusOf(h, id)).toBe('settled');
  });

  it('a claim transaction’s edge plus LoanSettled ends settled, as the chain does', async () => {
    const h = createSqliteD1(ALL_MIGRATIONS);
    seedLoan(h, 45, 'internal_matched');
    // The real claim receipt on Base Sepolia loan 24: LoanStatusChanged(5→3)
    // then LoanSettled, in that order, in one transaction.
    await run(h, [statusChangedLog(45, 5, 3, 100, 0), settledLog(45, 100, 1)]);
    expect(statusOf(h, 45)).toBe('settled');
  });
});

describe('settleFromLedger — the terminal→Settled edge the ledger and the chain both show (#2464, #2476 r6)', () => {
  const ledger = (h: SqliteD1, loanId: number, kind: string, block: number, at: number) =>
    h.db
      .prepare(
        `INSERT INTO activity_events (chain_id, block_number, log_index, tx_hash, kind, loan_id, args_json, block_at)
         VALUES (?, ?, 0, '0x1', ?, ?, '{}', ?)`,
      )
      .run(CHAIN, block, kind, loanId, at);
  const row = (h: SqliteD1, id: number) =>
    h.db.prepare('SELECT status, terminal_block, terminal_at FROM loans WHERE chain_id = ? AND loan_id = ?').get(CHAIN, id) as {
      status: string;
      terminal_block: number | null;
      terminal_at: number | null;
    };
  const budget = () => createBudget(1_000, 'test', 1_000);
  /** A chain whose block reads answer from `times` (throwing otherwise) and
   *  whose loan status is `status(id)` — Settled (3) unless told otherwise. */
  const chain = (
    times: Record<number, number>,
    status: (id: number) => number | Error = () => 3,
    seen: { reads: Array<{ id: number; block: bigint }> } = { reads: [] },
  ) =>
    ({
      getBlock: async ({ blockNumber }: { blockNumber: bigint }) => {
        const t = times[Number(blockNumber)];
        if (t === undefined) throw new Error('block read failed');
        return { timestamp: BigInt(t) };
      },
      readContract: async ({ args, blockNumber }: { args: [bigint]; blockNumber: bigint }) => {
        const id = Number(args[0]);
        seen.reads.push({ id, block: blockNumber });
        const st = status(id);
        if (st instanceof Error) throw st;
        return { status: st };
      },
    }) as never;
  const env = (h: SqliteD1) => ({ DB: h.d1 }) as unknown as Env;
  const heal = (h: SqliteD1, c: unknown) => settleFromLedger(c as never, DIAMOND, env(h), CHAIN, budget(), 777n);

  it('settles a terminal row the chain confirms, dated by a fresh read of its event block, and touches nothing else', async () => {
    const h = createSqliteD1(ALL_MIGRATIONS);
    seedLoan(h, 24, 'internal_matched'); // settled on chain — ledger has it
    // The ledger's block_at is the scan's wall-clock sentinel here; never trusted.
    ledger(h, 24, 'LoanSettled', 48004228, 1_999_999_999);
    seedLoan(h, 28, 'internal_matched'); // still unclaimed — no LoanSettled
    ledger(h, 28, 'OwedAtInternalMatchRecorded', 48059980, 1791888248);
    const seen = { reads: [] as Array<{ id: number; block: bigint }> };
    expect(await heal(h, chain({ 48004228: 1791775970 }, () => 3, seen))).toEqual([24]);
    expect(row(h, 24)).toEqual({ status: 'settled', terminal_block: 48004228, terminal_at: 1791775970 });
    expect(row(h, 28).status).toBe('internal_matched');
    // The canonical read is pinned to the pass's settled block.
    expect(seen.reads).toEqual([{ id: 24, block: 777n }]);
    expect(await heal(h, chain({ 48004228: 1791775970 }))).toEqual([]);
  });

  it('every terminal status takes the edge; an ACTIVE row is the reconciliation repair’s, not this lane’s', async () => {
    const h = createSqliteD1(ALL_MIGRATIONS);
    const cases = [
      [41, 'repaid'],
      [42, 'defaulted'],
      [43, 'liquidated'],
      [44, 'internal_matched'],
      [45, 'active'],
      [46, 'fallback_pending'],
    ] as const;
    for (const [id, st] of cases) {
      seedLoan(h, id, st);
      ledger(h, id, 'LoanSettled', 500 + id, 1);
    }
    expect(await heal(h, chain({ 541: 1, 542: 1, 543: 1, 544: 1, 545: 1, 546: 1 }))).toEqual([41, 42, 43, 44]);
    expect(row(h, 45).status).toBe('active');
    expect(row(h, 46).status).toBe('fallback_pending');
  });

  it('leaves a row the canonical chain does not show Settled exactly as it is (a reorganised-away event)', async () => {
    const h = createSqliteD1(ALL_MIGRATIONS);
    seedLoan(h, 50, 'internal_matched');
    ledger(h, 50, 'LoanSettled', 900, 1);
    expect(await heal(h, chain({ 900: 5 }, () => 5))).toEqual([]);
    expect(row(h, 50)).toEqual({ status: 'internal_matched', terminal_block: null, terminal_at: null });
  });

  it('settles with the time unknown — never the ledger sentinel — when the chain confirms it but the block read fails', async () => {
    const h = createSqliteD1(ALL_MIGRATIONS);
    seedLoan(h, 25, 'internal_matched');
    ledger(h, 25, 'LoanSettled', 700, 1_999_999_999);
    expect(await heal(h, chain({}))).toEqual([25]);
    expect(row(h, 25)).toEqual({ status: 'settled', terminal_block: 700, terminal_at: null });
  });

  it('rotates: rows the chain does not confirm cannot hold the batch, and the walk wraps', async () => {
    const h = createSqliteD1(ALL_MIGRATIONS);
    for (let id = 100; id < 125; id++) {
      seedLoan(h, id, 'internal_matched');
      ledger(h, id, 'LoanSettled', id, 1);
    }
    // 100–119 are not confirmed by the chain; 120–124 are.
    const c = chain({}, (id) => (id >= 120 ? 3 : 5));
    expect(await heal(h, c)).toEqual([]); // first page: 100–119
    expect(await heal(h, c)).toEqual([120, 121, 122, 123, 124]); // next page, then wrap
    const seen = { reads: [] as Array<{ id: number; block: bigint }> };
    await heal(h, chain({}, (id) => (id >= 120 ? 3 : 5), seen));
    expect(seen.reads[0].id).toBe(100); // wrapped to the start
  });

  it('reports the ids it already settled when a later row throws', async () => {
    const h = createSqliteD1(ALL_MIGRATIONS);
    for (const id of [60, 61, 62]) {
      seedLoan(h, id, 'internal_matched');
      ledger(h, id, 'LoanSettled', id, 1);
    }
    const c = chain({ 60: 1, 61: 1, 62: 1 }, (id) => (id === 61 ? new Error('rpc') : 3));
    expect(await heal(h, c)).toEqual([60, 62]);
    expect(row(h, 61).status).toBe('internal_matched');
  });
});

describe('settleLoanRow — one writer for the handler and the heal (#2476 r3)', () => {
  const at = (h: SqliteD1, id: number) =>
    h.db.prepare('SELECT status, terminal_block AS b, terminal_at AS t FROM loans WHERE chain_id = ? AND loan_id = ?').get(CHAIN, id);
  const env = (h: SqliteD1) => ({ DB: h.d1 }) as unknown as Env;

  it('lets a replay that now has the block time date a settlement recorded undated', async () => {
    const h = createSqliteD1(ALL_MIGRATIONS);
    seedLoan(h, 50, 'internal_matched');
    expect(await settleLoanRow(env(h), CHAIN, 50, 100, null)).toBe(true);
    expect(at(h, 50)).toEqual({ status: 'settled', b: 100, t: null });
    // Replay after a partial pass, block read succeeded this time.
    expect(await settleLoanRow(env(h), CHAIN, 50, 100, 500)).toBe(true);
    expect(at(h, 50)).toEqual({ status: 'settled', b: 100, t: 500 });
    // A dated settlement is never rewritten, and an undated replay changes nothing.
    expect(await settleLoanRow(env(h), CHAIN, 50, 100, 777)).toBe(false);
    expect(await settleLoanRow(env(h), CHAIN, 50, 100, null)).toBe(false);
    expect(at(h, 50)).toEqual({ status: 'settled', b: 100, t: 500 });
  });
});
