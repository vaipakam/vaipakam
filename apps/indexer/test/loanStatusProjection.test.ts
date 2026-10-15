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
import { handleLoanById } from '../src/loanRoutes';
import { createBudget } from '../src/subrequestBudget';
import { pad, toHex, toEventSelector } from 'viem';

const LOAN_SETTLED = toEventSelector('LoanSettled(uint256)');
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
    h.db.prepare('UPDATE loans SET terminal_block = 100, terminal_at = 500, terminal_at_verified = 1 WHERE chain_id = ? AND loan_id = 44').run(CHAIN);
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
  /** The tx hash names its block, so the receipt mock can answer by default
   *  with the canonical block of every ledgered event. */
  const txOf = (loanId: number, block: number) =>
    `0x${loanId.toString(16).padStart(32, '0')}${block.toString(16).padStart(32, '0')}`;
  const ledger = (h: SqliteD1, loanId: number, kind: string, block: number, at: number) =>
    h.db
      .prepare(
        `INSERT INTO activity_events (chain_id, block_number, log_index, tx_hash, kind, loan_id, args_json, block_at)
         VALUES (?, ?, 0, ?, ?, ?, '{}', ?)`,
      )
      .run(CHAIN, block, txOf(loanId, block), kind, loanId, at);
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
    /** Blocks whose transactions the node no longer returns (reorganised away). */
    discarded: Set<number> = new Set(),
    /** Blocks whose re-included transaction no longer emits LoanSettled. */
    noLog: Set<number> = new Set(),
    /** Blocks whose receipt read fails in transport. */
    unreadable: Set<number> = new Set(),
  ) =>
    ({
      getTransactionReceipt: async ({ hash }: { hash: string }) => {
        const loanId = parseInt(hash.slice(2, 34), 16);
        const block = parseInt(hash.slice(34), 16);
        if (discarded.has(block)) {
          const e = new Error('Transaction receipt not found'); // viem's own error name
          e.name = 'TransactionReceiptNotFoundError';
          throw e;
        }
        if (unreadable.has(block)) throw new Error('fetch failed');
        return {
          status: 'success',
          blockNumber: BigInt(block),
          logs: noLog.has(block)
            ? []
            : [{ address: DIAMOND, topics: [LOAN_SETTLED, pad(toHex(BigInt(loanId)), { size: 32 })] }],
        };
      },
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

  it('takes the provenance only from an event the chain confirms, never from a discarded one (#2476 r7)', async () => {
    const h = createSqliteD1(ALL_MIGRATIONS);
    seedLoan(h, 70, 'internal_matched');
    ledger(h, 70, 'LoanSettled', 1000, 1); // reorganised away
    ledger(h, 70, 'LoanSettled', 1005, 1); // the canonical replacement
    expect(await heal(h, chain({ 1000: 10, 1005: 15 }, () => 3, undefined, new Set([1000])))).toEqual([70]);
    expect(row(h, 70)).toEqual({ status: 'settled', terminal_block: 1005, terminal_at: 15 });
  });

  it('takes no provenance from a receipt that no longer carries this loan’s LoanSettled (#2476 r9, r11)', async () => {
    const h = createSqliteD1(ALL_MIGRATIONS);
    seedLoan(h, 73, 'internal_matched');
    ledger(h, 73, 'LoanSettled', 1400, 1);
    // The chain says Settled, so the status lands — with block and time unknown.
    expect(await heal(h, chain({ 1400: 1 }, () => 3, undefined, new Set(), new Set([1400])))).toEqual([73]);
    expect(row(h, 73)).toEqual({ status: 'settled', terminal_block: null, terminal_at: null });
  });

  it('writes nothing this lap when a receipt read fails in transport (#2476 r11)', async () => {
    const h = createSqliteD1(ALL_MIGRATIONS);
    seedLoan(h, 77, 'internal_matched');
    ledger(h, 77, 'LoanSettled', 1800, 1);
    expect(await heal(h, chain({ 1800: 1 }, () => 3, undefined, new Set(), new Set(), new Set([1800])))).toEqual([]);
    expect(row(h, 77).status).toBe('internal_matched');
  });

  it('revisits an undated settlement and fills it once a receipt can be read (#2476 r13)', async () => {
    const h = createSqliteD1(ALL_MIGRATIONS);
    seedLoan(h, 79, 'internal_matched');
    ledger(h, 79, 'LoanSettled', 2100, 1);
    await heal(h, chain({ 2100: 9 }, () => 3, undefined, new Set([2100]))); // receipt unavailable
    expect(row(h, 79)).toEqual({ status: 'settled', terminal_block: null, terminal_at: null });
    // A later lap, the receipt is readable: the same lane fills the provenance.
    expect(await heal(h, chain({ 2100: 9 }))).toEqual([79]);
    expect(row(h, 79)).toEqual({ status: 'settled', terminal_block: 2100, terminal_at: 9 });
    // A fully dated settlement is not selected again.
    const seen = { reads: [] as Array<{ id: number; block: bigint }> };
    await heal(h, chain({ 2100: 9 }, () => 3, seen));
    expect(seen.reads.map((r) => r.id)).not.toContain(79);
  });

  it('selects candidates through their indexes, never a walk over every loan (#2476 r13)', async () => {
    const h = createSqliteD1(ALL_MIGRATIONS);
    const seen: string[] = [];
    const d1 = h.d1 as { prepare(sql: string): unknown };
    const spy = { DB: { prepare: (sql: string) => (seen.push(sql), d1.prepare(sql)) } } as unknown as Env;
    await settleFromLedger(chain({}) as never, DIAMOND, spy, CHAIN, budget(), 777n);
    const select = seen.find((q) => q.includes('UNION'));
    expect(select).toBeDefined();
    const plan = (h.db.prepare(`EXPLAIN QUERY PLAN ${select}`).all(CHAIN, 0, 20) as { detail: string }[])
      .map((r) => r.detail)
      .join('\n');
    // Both branches SEEK on the rotation bound, not just on the chain.
    expect(plan).toMatch(/USING (COVERING )?INDEX idx_loans_chain_status_loan \(chain_id=\? AND status=\? AND loan_id>\?\)/);
    expect(plan).toMatch(/USING (COVERING )?INDEX idx_loans_settled_unverified \(chain_id=\? AND loan_id>\?\)/);
    expect(plan).toMatch(/USING (COVERING )?INDEX idx_activity_chain_loan/);
    expect(plan).not.toMatch(/SCAN loans|sqlite_autoindex_loans/);
  });

  it('a previous Worker’s scan-time settlement — even one written after 0060 — is re-dated from the chain (#2476 r15)', async () => {
    const h = createSqliteD1(ALL_MIGRATIONS);
    // What the old handler writes, before OR after the migration: the right
    // block, the scan's clock, and (being old code) no verification marker.
    seedLoan(h, 81, 'settled');
    h.db.prepare('UPDATE loans SET terminal_block = 2200, terminal_at = 1_999_999_999 WHERE chain_id = ? AND loan_id = 81').run(CHAIN);
    ledger(h, 81, 'LoanSettled', 2200, 1_999_999_999);
    expect(await heal(h, chain({ 2200: 1_234 }))).toEqual([81]);
    expect(row(h, 81)).toEqual({ status: 'settled', terminal_block: 2200, terminal_at: 1_234 });
    const v = h.db.prepare('SELECT terminal_at_verified AS v FROM loans WHERE chain_id = ? AND loan_id = 81').get(CHAIN) as { v: number };
    expect(v.v).toBe(1);
    // Verified now: not selected again.
    const seen = { reads: [] as Array<{ id: number; block: bigint }> };
    await heal(h, chain({ 2200: 1_234 }, () => 3, seen));
    expect(seen.reads.map((r) => r.id)).not.toContain(81);
  });

  it('works at most a few already-settled rows per tick, so a wrong status keeps priority (#2476 r16)', async () => {
    const h = createSqliteD1(ALL_MIGRATIONS);
    // Eight settled rows whose provenance cannot be confirmed (receipts gone)…
    for (let id = 300; id < 308; id++) {
      seedLoan(h, id, 'settled');
      ledger(h, id, 'LoanSettled', id, 1);
    }
    // …and one terminal row whose STATUS is wrong, later in the same page.
    seedLoan(h, 310, 'internal_matched');
    ledger(h, 310, 'LoanSettled', 310, 1);
    const seen = { reads: [] as Array<{ id: number; block: bigint }> };
    const discarded = new Set([300, 301, 302, 303, 304, 305, 306, 307]);
    expect(await heal(h, chain({ 310: 9 }, () => 3, seen, discarded))).toEqual([310]);
    // Only three settled rows were worked; the terminal row still was.
    expect(seen.reads.filter((r) => r.id < 310)).toHaveLength(3);
    expect(row(h, 310).status).toBe('settled');
  });

  it('a later confirmed LoanSettled dates a settlement the heal recorded undated', async () => {
    const h = createSqliteD1(ALL_MIGRATIONS);
    seedLoan(h, 78, 'internal_matched');
    ledger(h, 78, 'LoanSettled', 1900, 1);
    await heal(h, chain({}, () => 3, undefined, new Set([1900])));
    expect(row(h, 78)).toEqual({ status: 'settled', terminal_block: null, terminal_at: null });
    expect(await settleLoanRow(env(h), CHAIN, 78, 1950, 4242)).toBe(true);
    expect(row(h, 78)).toEqual({ status: 'settled', terminal_block: 1950, terminal_at: 4242 });
  });

  it('tries a second candidate only while the budget still covers the rest of the row (#2476 r9)', async () => {
    const h = createSqliteD1(ALL_MIGRATIONS);
    seedLoan(h, 74, 'internal_matched');
    ledger(h, 74, 'LoanSettled', 1500, 1); // the canonical one, tried second
    ledger(h, 74, 'LoanSettled', 1505, 1); // newest, discarded
    // A metered client: every call spends one subrequest, as in production.
    const metered = (b: ReturnType<typeof createBudget>) => {
      const inner = chain({ 1500: 9 }, () => 3, undefined, new Set([1505])) as unknown as Record<string, (...a: unknown[]) => unknown>;
      return new Proxy(inner, {
        get: (t, k) => (...a: unknown[]) => {
          b.subrequests.remaining--;
          return t[k as string](...a);
        },
      });
    };
    // D1 statements are subrequests too, as the production meter counts them.
    const meteredEnv = (b: ReturnType<typeof createBudget>) => {
      const d1 = h.d1 as { prepare(sql: string): unknown };
      return {
        DB: {
          prepare: (sql: string) => {
            b.subrequests.remaining--;
            return d1.prepare(sql);
          },
        },
      } as unknown as Env;
    };
    // Two reads before the row, its six-request reservation: the first receipt
    // fits, a second candidate would not.
    const tight = createBudget(8, 'test', 1_000);
    expect(await settleFromLedger(metered(tight) as never, DIAMOND, meteredEnv(tight), CHAIN, tight, 777n)).toEqual([]);
    expect(row(h, 74).status).toBe('internal_matched');
    const roomy = createBudget(20, 'test', 1_000);
    expect(await settleFromLedger(metered(roomy) as never, DIAMOND, meteredEnv(roomy), CHAIN, roomy, 777n)).toEqual([74]);
    expect(row(h, 74).terminal_block).toBe(1500);
  });

  it('settles the chain-confirmed status with UNKNOWN provenance when no receipt can be found (pruned) (#2476 r11)', async () => {
    const h = createSqliteD1(ALL_MIGRATIONS);
    seedLoan(h, 71, 'internal_matched');
    ledger(h, 71, 'LoanSettled', 1100, 1);
    expect(await heal(h, chain({ 1100: 1 }, () => 3, undefined, new Set([1100])))).toEqual([71]);
    expect(row(h, 71)).toEqual({ status: 'settled', terminal_block: null, terminal_at: null });
  });

  it('still reports what it settled when the rotation pointer cannot be saved (#2476 r7)', async () => {
    const h = createSqliteD1(ALL_MIGRATIONS);
    seedLoan(h, 72, 'internal_matched');
    ledger(h, 72, 'LoanSettled', 1200, 1);
    const d1 = h.d1 as { prepare(sql: string): unknown };
    const failingCursor = {
      DB: {
        prepare: (sql: string) => {
          if (sql.includes('INSERT INTO indexer_cursor')) throw new Error('D1 write failed');
          return d1.prepare(sql);
        },
      },
    } as unknown as Env;
    // Fill a whole page so the pointer advances and must be written.
    for (let id = 200; id < 220; id++) {
      seedLoan(h, id, 'internal_matched');
      ledger(h, id, 'LoanSettled', 2000 + id, 1);
    }
    const got = await settleFromLedger(chain({}) as never, DIAMOND, failingCursor, CHAIN, budget(), 777n);
    expect(got).toContain(72);
    expect(got).toHaveLength(20);
  });

  it('never starts a row it could not also write the rotation pointer after (#2476 r8)', async () => {
    const h = createSqliteD1(ALL_MIGRATIONS);
    seedLoan(h, 80, 'internal_matched');
    ledger(h, 80, 'LoanSettled', 1300, 1);
    // Exactly one row's cost left: no room for the pointer write after it.
    expect(await settleFromLedger(chain({ 1300: 1 }) as never, DIAMOND, env(h), CHAIN, createBudget(5, 'test', 1_000), 777n)).toEqual([]);
    expect(row(h, 80).status).toBe('internal_matched');
    expect(await settleFromLedger(chain({ 1300: 1 }) as never, DIAMOND, env(h), CHAIN, createBudget(6, 'test', 1_000), 777n)).toEqual([80]);
  });

  it('does not settle a row when its reads ran over and the live budget no longer covers the write and pointer (#2476 r10)', async () => {
    const h = createSqliteD1(ALL_MIGRATIONS);
    seedLoan(h, 75, 'internal_matched');
    ledger(h, 75, 'LoanSettled', 1600, 1);
    const b = createBudget(20, 'test', 1_000);
    // A client whose status read RETRIES, spending far more than reserved.
    const inner = chain({ 1600: 1 }) as unknown as Record<string, (...a: unknown[]) => unknown>;
    const retrying = new Proxy(inner, {
      get: (t, k) => (...a: unknown[]) => {
        b.subrequests.remaining -= k === 'readContract' ? 18 : 1;
        return t[k as string](...a);
      },
    });
    expect(await settleFromLedger(retrying as never, DIAMOND, env(h), CHAIN, b, 777n)).toEqual([]);
    expect(row(h, 75).status).toBe('internal_matched');
    // The pointer did not move past it: the next lap, with room, settles it.
    expect(await heal(h, chain({ 1600: 1 }))).toEqual([75]);
  });

  it('does not start at all when the setup reads are not covered (#2476 r10)', async () => {
    const h = createSqliteD1(ALL_MIGRATIONS);
    seedLoan(h, 76, 'internal_matched');
    ledger(h, 76, 'LoanSettled', 1700, 1);
    expect(await settleFromLedger(chain({ 1700: 1 }) as never, DIAMOND, env(h), CHAIN, createBudget(2, 'test', 1_000), 777n)).toEqual([]);
    expect(await settleFromLedger(chain({ 1700: 1 }) as never, DIAMOND, env(h), CHAIN, createBudget(1_000, 'test', 2), 777n)).toEqual([]);
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

describe('PrepayCollateralSaleSettled — a close the ledger heal can never date (#2476 r16)', () => {
  const prepayLog = (loanId: number, block: number) => ({
    eventName: 'PrepayCollateralSaleSettled',
    args: { loanId: BigInt(loanId) },
    blockNumber: BigInt(block),
    transactionHash: `0x${'ab'.repeat(32)}`,
    logIndex: 0,
  });
  const verified = (h: SqliteD1, id: number) =>
    h.db.prepare('SELECT terminal_at AS t, terminal_at_verified AS v FROM loans WHERE chain_id = ? AND loan_id = ?').get(CHAIN, id);

  it('stamps the block time as verified, and a failed block read as unknown — never the scan clock', async () => {
    const h = createSqliteD1(ALL_MIGRATIONS);
    seedLoan(h, 60, 'active');
    seedLoan(h, 61, 'active');
    await processLoanLogs(
      [prepayLog(60, 100), prepayLog(61, 200)] as never,
      { DB: h.d1 } as unknown as Env,
      CHAIN,
      new Map([[100n, 500], [200n, 1_999_999_999]]),
      stubClient,
      DIAMOND,
      new Set([200n]),
    );
    expect(verified(h, 60)).toEqual({ t: 500, v: 1 });
    expect(verified(h, 61)).toEqual({ t: null, v: 0 });
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

  it('never settles a row still indexed active or fallback_pending — the repair owns a missed terminal (#2476 r12)', async () => {
    const h = createSqliteD1(ALL_MIGRATIONS);
    seedLoan(h, 51, 'active');
    seedLoan(h, 52, 'fallback_pending');
    expect(await settleLoanRow(env(h), CHAIN, 51, 100, 500)).toBe(false);
    expect(await settleLoanRow(env(h), CHAIN, 52, 100, 500)).toBe(false);
    expect((at(h, 51) as { status: string }).status).toBe('active');
    expect((at(h, 52) as { status: string }).status).toBe('fallback_pending');
  });

  it('fills what it does not know: a missing or different block, an unverified time — never a verified one (#2476 r12, r15)', async () => {
    const h = createSqliteD1(ALL_MIGRATIONS);
    const ver = (id: number) =>
      (h.db.prepare('SELECT terminal_at_verified AS v FROM loans WHERE chain_id = ? AND loan_id = ?').get(CHAIN, id) as { v: number }).v;
    seedLoan(h, 53, 'internal_matched');
    expect(await settleLoanRow(env(h), CHAIN, 53, null, null)).toBe(true);
    expect(at(h, 53)).toEqual({ status: 'settled', b: null, t: null });
    expect(await settleLoanRow(env(h), CHAIN, 53, 300, null)).toBe(true); // block known, time still not
    expect(at(h, 53)).toEqual({ status: 'settled', b: 300, t: null });
    expect(ver(53)).toBe(0);
    // A DIFFERENT confirmed block replaces the one recorded (an orphaned
    // event's block, say), with its own time.
    expect(await settleLoanRow(env(h), CHAIN, 53, 999, 7)).toBe(true);
    expect(at(h, 53)).toEqual({ status: 'settled', b: 999, t: 7 });
    expect(ver(53)).toBe(1);
    // A verified time is never rewritten, and an undated replay changes nothing.
    expect(await settleLoanRow(env(h), CHAIN, 53, 999, 42)).toBe(false);
    expect(await settleLoanRow(env(h), CHAIN, 53, null, null)).toBe(false);
    expect(at(h, 53)).toEqual({ status: 'settled', b: 999, t: 7 });
  });

  it('the loan route serves a settled time only when it is verified (#2476 r15)', async () => {
    const h = createSqliteD1(ALL_MIGRATIONS);
    seedLoan(h, 55, 'settled');
    h.db.prepare('UPDATE loans SET terminal_block = 400, terminal_at = 1_999_999_999 WHERE chain_id = ? AND loan_id = 55').run(CHAIN);
    const served = async () => {
      const res = await handleLoanById(new Request(`https://idx/loans/55?chainId=${CHAIN}`), { DB: h.d1 } as unknown as Env, '55');
      return ((await res.json()) as { loan?: { terminalAt: number | null }; terminalAt?: number | null });
    };
    const first = await served();
    expect((first.loan ?? first).terminalAt).toBeNull(); // a scan clock is not stated as the settlement time
    await settleLoanRow(env(h), CHAIN, 55, 400, 1_234);
    const second = await served();
    expect((second.loan ?? second).terminalAt).toBe(1_234);
  });

  it('clears the repair marker: a settlement from the chain is not the repair’s (#2476 r12)', async () => {
    const h = createSqliteD1(ALL_MIGRATIONS);
    seedLoan(h, 54, 'repaid');
    h.db.prepare('UPDATE loans SET terminal_by_repair = 1 WHERE chain_id = ? AND loan_id = 54').run(CHAIN);
    await settleLoanRow(env(h), CHAIN, 54, 100, 1);
    expect((h.db.prepare('SELECT terminal_by_repair AS m FROM loans WHERE chain_id = ? AND loan_id = 54').get(CHAIN) as { m: number }).m).toBe(0);
  });
});
