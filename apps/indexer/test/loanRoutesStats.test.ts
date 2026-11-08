/**
 * GET /loans/stats — status buckets and the ERC-20 / NFT split.
 *
 * The companion to `offerRoutesStats.test.ts`, and owed for the same
 * reason: #2069 changed this handler's counting three times — sale
 * vehicles excluded from all three aggregates, every persisted status
 * named so the buckets sum to the published total, and the asset-type
 * split re-keyed off `lending_asset` after `is_stub` proved too broad.
 * Each was verified by reading the SQL and by what the live endpoint
 * returned that day, which is not a test.
 *
 * The subtle one is the asset split, and it is the reason `is_stub`
 * cannot be the discriminator. TWO paths set that flag:
 *
 *   - fallback B (no details event, canonical read-back failed) inserts
 *     `asset_type = 0` and `lending_asset = '0x'` whatever the loan
 *     actually is — so counting those publishes every such NFT rental
 *     as an active ERC-20 loan;
 *   - the companion-event path sets `is_stub` too, but only because the
 *     position token ids are missing; it writes the REAL asset type.
 *
 * Keying on the flag therefore dropped correctly-classified loans from
 * both subtotals while healing was merely pending. `lending_asset` is
 * what actually distinguishes "we do not know" from "we know, and are
 * waiting on something else".
 */
import { describe, expect, it } from 'vitest';
import { handleLoansStats } from '../src/loanRoutes';
import type { Env } from '../src/env';
import { createSqliteD1, type SqliteD1 } from './helpers/sqliteD1';

const CHAIN_ID = 84532;

/** Minimal `loans` projection — the columns the stats aggregates read. */
const LOANS_DDL = `
CREATE TABLE loans (
  chain_id          INTEGER NOT NULL,
  loan_id           INTEGER NOT NULL,
  status            TEXT    NOT NULL,
  lending_asset     TEXT    NOT NULL DEFAULT '0x',
  asset_type        INTEGER NOT NULL DEFAULT 0,
  principal         TEXT    NOT NULL DEFAULT '0',
  interest_rate_bps INTEGER NOT NULL DEFAULT 0,
  is_stub           INTEGER NOT NULL DEFAULT 0,
  is_sale_vehicle   INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (chain_id, loan_id)
);`;

const INDEXER_CURSOR_DDL = `
CREATE TABLE indexer_cursor (
  chain_id   INTEGER NOT NULL,
  kind       TEXT    NOT NULL,
  last_block INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (chain_id, kind)
);`;

/** The columns the #3366 liquidator window reads. */
const ACTIVITY_DDL = `
CREATE TABLE activity_events (
  chain_id     INTEGER NOT NULL,
  block_number INTEGER NOT NULL,
  log_index    INTEGER NOT NULL,
  kind         TEXT    NOT NULL,
  args_json    TEXT    NOT NULL,
  block_at     INTEGER NOT NULL,
  PRIMARY KEY (chain_id, block_number, log_index)
);`;

const ERC20 = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const NFT = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

let nextLoanId = 1;

function insert(
  h: SqliteD1,
  o: {
    status: string;
    /** '0x' — the metadata-less default fallback B leaves behind. */
    lendingAsset?: string;
    /** 0 = ERC-20, 1 = NFT rental. */
    assetType?: 0 | 1;
    isStub?: boolean;
    saleVehicle?: boolean;
    principal?: string;
    chainId?: number;
  },
): void {
  h.db
    .prepare(
      `INSERT INTO loans
         (chain_id, loan_id, status, lending_asset, asset_type,
          principal, interest_rate_bps, is_stub, is_sale_vehicle)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      o.chainId ?? CHAIN_ID,
      nextLoanId++,
      o.status,
      o.lendingAsset ?? '0x',
      o.assetType ?? 0,
      o.principal ?? '0',
      0,
      o.isStub ? 1 : 0,
      o.saleVehicle ? 1 : 0,
    );
}

async function stats(h: SqliteD1): Promise<Record<string, any>> { // eslint-disable-line @typescript-eslint/no-explicit-any
  const env = { DB: h.d1, RPC_BASE_SEPOLIA: 'http://127.0.0.1:9' } as unknown as Env;
  const res = await handleLoansStats(
    new Request(`https://x/loans/stats?chainId=${CHAIN_ID}`),
    env,
  );
  return (await res.json()) as Record<string, number>;
}

function fresh(): SqliteD1 {
  nextLoanId = 1;
  return createSqliteD1([LOANS_DDL, INDEXER_CURSOR_DDL, ACTIVITY_DDL]);
}

describe('GET /loans/stats — buckets and the asset split', () => {
  it('excludes sale vehicles from the status counts', async () => {
    const h = fresh();
    insert(h, { status: 'active', saleVehicle: true });
    insert(h, { status: 'active', lendingAsset: ERC20 });
    const s = await stats(h);
    expect(s.active).toBe(1);
    expect(s.total).toBe(1);
  });

  it('excludes sale vehicles from the asset-type subtotals too', async () => {
    // The two figures sit on one card. If the subtotals counted a
    // vehicle the status count excluded, they could exceed the `active`
    // beside them — two numbers on the same card disagreeing, which is
    // worse than either being wrong alone.
    const h = fresh();
    insert(h, { status: 'active', lendingAsset: ERC20, saleVehicle: true });
    insert(h, { status: 'active', lendingAsset: ERC20 });
    const s = await stats(h);
    expect(s.erc20ActiveLoans + s.nftRentalsActive).toBeLessThanOrEqual(s.active);
    expect(s.erc20ActiveLoans).toBe(1);
  });

  it('splits active loans by asset type', async () => {
    const h = fresh();
    insert(h, { status: 'active', lendingAsset: ERC20, assetType: 0 });
    insert(h, { status: 'active', lendingAsset: NFT, assetType: 1 });
    const s = await stats(h);
    expect(s.erc20ActiveLoans).toBe(1);
    expect(s.nftRentalsActive).toBe(1);
  });

  it('keeps a metadata-less row out of the asset split, but IN the total', async () => {
    // Fallback B writes `asset_type = 0` regardless of what the loan is,
    // so counting it would publish an NFT rental as an active ERC-20
    // loan. It is still a real loan, so it must stay in `active` and
    // `total` — dropped from the split, not from existence.
    const h = fresh();
    insert(h, { status: 'active', lendingAsset: '0x', isStub: true });
    const s = await stats(h);
    expect(s.erc20ActiveLoans).toBe(0);
    expect(s.nftRentalsActive).toBe(0);
    expect(s.active).toBe(1);
    expect(s.total).toBe(1);
  });

  it('counts a stub that DOES carry its asset metadata', async () => {
    // The companion-event path sets `is_stub` while writing the real
    // asset type — it is waiting on token ids, not on the asset. Keying
    // the split on `is_stub` dropped these, which is its own inaccuracy:
    // a correctly classified loan omitted because something unrelated
    // had not healed yet.
    const h = fresh();
    insert(h, { status: 'active', lendingAsset: NFT, assetType: 1, isStub: true });
    const s = await stats(h);
    expect(s.nftRentalsActive).toBe(1);
    expect(s.erc20ActiveLoans).toBe(0);
  });

  it('publishes every counted status, so the buckets sum to the total', async () => {
    const h = fresh();
    insert(h, { status: 'active', lendingAsset: ERC20 });
    insert(h, { status: 'repaid' });
    insert(h, { status: 'defaulted' });
    insert(h, { status: 'liquidated' });
    insert(h, { status: 'settled' });
    insert(h, { status: 'fallback_pending' });
    insert(h, { status: 'internal_matched' });
    insert(h, { status: 'some_future_status' });

    const s = await stats(h);
    const named =
      s.active +
      s.repaid +
      s.defaulted +
      s.liquidated +
      s.settled +
      s.fallbackPending +
      s.internalMatched +
      s.other;
    expect(named).toBe(s.total);
    expect(s.total).toBe(8);
    expect(s.other).toBe(1);
  });

  it('counts only the requested chain', async () => {
    const h = fresh();
    insert(h, { status: 'active', lendingAsset: ERC20 });
    insert(h, { status: 'active', lendingAsset: ERC20, chainId: 8453 });
    const s = await stats(h);
    expect(s.total).toBe(1);
  });
});

describe('GET /loans/stats — distinct liquidators (#3366)', () => {
  const KEEPER = '0xD9257B636E17D5714DD54F260c9F7EB81349E49B';
  const A = '0x1111111111111111111111111111111111111111';
  const B = '0x2222222222222222222222222222222222222222';
  let idx = 0;
  function liq(h: SqliteD1, kind: string, args: Record<string, unknown>, ageDays: number): void {
    const now = Math.floor(Date.now() / 1000);
    h.db
      .prepare(
        `INSERT INTO activity_events (chain_id, block_number, log_index, kind, args_json, block_at)
         VALUES (?, ?, 0, ?, ?, ?)`,
      )
      .run(CHAIN_ID, ++idx, kind, JSON.stringify(args), now - Math.round(ageDays * 86_400));
  }

  it('counts distinct third parties per window, keeper apart, from the event field', async () => {
    const h = fresh();
    liq(h, 'HFLiquidationTriggered', { loanId: '1', liquidator: A }, 1);
    // Same address in a different case and on another route: still one.
    liq(h, 'LoanPartiallyLiquidated', { loanId: '2', liquidator: A.toUpperCase().replace('0X', '0x') }, 2);
    liq(h, 'LiquidationDiscounted', { loanId: '3', liquidator: B }, 20);
    liq(h, 'HFLiquidationTriggered', { loanId: '4', liquidator: KEEPER }, 3);
    // Outside both windows.
    liq(h, 'HFLiquidationTriggered', { loanId: '5', liquidator: '0x3333333333333333333333333333333333333333' }, 40);
    const { liquidators: l } = await stats(h);
    expect(l.keeperAddress).toBe(KEEPER.toLowerCase());
    expect(l.windows['7d'].primary).toMatchObject({ thirdParty: 1, keeper: 1, events: 3 });
    expect(l.windows['30d'].primary).toMatchObject({ thirdParty: 2, keeper: 1, events: 4 });
    expect(l.windows['30d'].primary.byRoute.hf).toEqual({ thirdParty: 1, keeper: 1, events: 2 });
    expect(l.windows['30d'].primary.byRoute.discounted).toEqual({ thirdParty: 1, keeper: 0, events: 1 });
  });

  it('reports the other routes apart and never infers a caller for LoanLiquidated', async () => {
    const h = fresh();
    liq(h, 'InternalMatchExecuted', { loanIdA: '1', matcher: A }, 1);
    liq(h, 'PeriodicInterestAutoLiquidated', { loanId: '2', settler: KEEPER }, 1);
    liq(h, 'LoanLiquidated', { loanId: '3', proceeds: '1', treasuryFee: '0' }, 1);
    liq(h, 'LoanLiquidated', { loanId: '4', proceeds: '1', treasuryFee: '0' }, 10);
    const { liquidators: l } = await stats(h);
    expect(l.windows['30d'].primary).toMatchObject({ thirdParty: 0, keeper: 0, events: 0 });
    expect(l.windows['30d'].otherRoutes).toMatchObject({ thirdParty: 1, keeper: 1, events: 2 });
    expect(l.windows['7d'].callerNotRecorded.events).toBe(1);
    expect(l.windows['30d'].callerNotRecorded.events).toBe(2);
    expect(l.caveats.join(' ')).toMatch(/not independent operators/);
  });
});
