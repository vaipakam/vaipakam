/**
 * #3205 — a position-bound flow completes only if its position NFT has not
 * moved (any transfer, even away and back) since the flow opened. The indexer
 * records each loan side's last move from the `Transfer` logs it scans and
 * the routes publish the verdict per flow, never by dropping rows. Runs
 * against the real migrated schema; the scan handlers are driven with real
 * decoded-log shapes.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { Env } from '../src/env';
import { processLoanLogs } from '../src/chainIndexer';
import { handleLoanById } from '../src/loanRoutes';
import { handleOfferById } from '../src/offerRoutes';
import { movedSinceOpened } from '../src/positionFlowMoves';
import { createSqliteD1, type SqliteD1 } from './helpers/sqliteD1';

const MIGRATIONS_DIR = new URL('../migrations/', import.meta.url);
const FILES = readdirSync(MIGRATIONS_DIR)
  .filter((f) => f.endsWith('.sql'))
  .sort();
const load = (files: string[]) => files.map((f) => readFileSync(new URL(f, MIGRATIONS_DIR), 'utf8'));
const THIS_MIGRATION = '0085_position_flow_moves.sql';

const CHAIN = 84532;
const DIAMOND = '0x00000000000000000000000000000000000d1a90' as never;
const ZERO = '0x0000000000000000000000000000000000000000';
const LENDER = '0x00000000000000000000000000000000000000a1';
const BORROWER = '0x00000000000000000000000000000000000000b2';
const OTHER = '0x00000000000000000000000000000000000000c3';
const LOAN = 7;
const LENDER_TOKEN = 11n;
const BORROWER_TOKEN = 12n;

const stubClient = {
  readContract: async () => {
    throw new Error('unexpected RPC');
  },
} as never;

function harness(files = FILES) {
  const h = createSqliteD1(load(files));
  const env = { DB: h.d1, RPC_BASE_SEPOLIA: 'http://127.0.0.1:9' } as unknown as Env;
  return { ...h, env };
}

function seedLoan(h: SqliteD1) {
  h.db
    .prepare(
      `INSERT INTO loans (chain_id, loan_id, offer_id, status, lender, borrower,
         principal, collateral_amount, asset_type, collateral_asset_type,
         lending_asset, collateral_asset, duration_days, token_id,
         collateral_token_id, lender_token_id, borrower_token_id,
         lender_current_owner, borrower_current_owner, interest_rate_bps,
         start_time, start_block, start_at, updated_at)
       VALUES (?, ?, 1, 'active', ?, ?, '100', '200', 0, 0, '0xd', '0xc', 30,
         '0', '0', ?, ?, ?, ?, 500, 0, 0, 0, 0)`,
    )
    .run(CHAIN, LOAN, LENDER, BORROWER, String(LENDER_TOKEN), String(BORROWER_TOKEN), LENDER, BORROWER);
}

function seedListing(h: SqliteD1, block: number, logIndex: number) {
  h.db
    .prepare(
      `INSERT INTO prepay_listings (chain_id, loan_id, order_hash, ask_price, conduit,
         lister, posted_at, updated_at, grace_period_end, block_number, tx_hash, log_index)
       VALUES (?, ?, '0xhash', '1', '0xconduit', ?, 0, 0, 0, ?, '0xtx', ?)`,
    )
    .run(CHAIN, LOAN, BORROWER, block, logIndex);
}

interface OfferSeed {
  sale?: boolean;
  offset?: boolean;
  refinance?: number;
  vehicleLoan?: number | null;
  block: number;
  logIndex: number | null;
}

/** Seeds a row with the columns migration 0085 adds when they exist. */
function seedOffer(h: SqliteD1, offerId: number, opts: OfferSeed, withNewColumns = true) {
  const extraCols = withNewColumns ? ', vehicle_loan_id, created_log_index' : '';
  const extraVals = withNewColumns ? ', ?, ?' : '';
  const binds: (number | string | null)[] = [
    CHAIN,
    offerId,
    LENDER,
    opts.block,
    opts.sale ? 1 : 0,
    opts.offset ? 1 : 0,
    opts.refinance ?? 0,
  ];
  if (withNewColumns) binds.push(opts.vehicleLoan ?? null, opts.logIndex);
  h.db
    .prepare(
      `INSERT INTO offers (chain_id, offer_id, status, creator, offer_type, lending_asset,
         collateral_asset, asset_type, collateral_asset_type, amount, interest_rate_bps,
         collateral_amount, duration_days, first_seen_block, first_seen_at, updated_at,
         is_sale_vehicle, is_offset_vehicle, refinance_target_loan_id${extraCols})
       VALUES (?, ?, 'active', ?, 1, '0xd', '0xc', 0, 0, '1', 500, '1', 30, ?, 0, 0, ?, ?, ?${extraVals})`,
    )
    .run(...binds);
}

let logSeq = 0;
const transfer = (tokenId: bigint, from: string, to: string, block: number, logIndex: number) => ({
  eventName: 'Transfer',
  args: { from, to, tokenId },
  blockNumber: BigInt(block),
  transactionHash: `0x${(++logSeq).toString(16).padStart(64, '0')}`,
  logIndex,
});

async function scan(h: ReturnType<typeof harness>, logs: unknown[]) {
  const times = new Map<bigint, number>();
  for (const l of logs as { blockNumber: bigint }[]) times.set(l.blockNumber, 1_000 + Number(l.blockNumber));
  await processLoanLogs(logs as never, h.env, CHAIN, times, stubClient, DIAMOND);
}

async function loanById(h: ReturnType<typeof harness>) {
  const res = await handleLoanById(new Request(`https://idx/loans/${LOAN}?chainId=${CHAIN}`), h.env, String(LOAN));
  return (await res.json()) as {
    prepayListing?: { positionMovedSinceOpened: boolean | null };
    swapToRepayIntent?: { positionMovedSinceOpened: boolean | null };
  };
}

async function offerById(h: ReturnType<typeof harness>, offerId: number) {
  const res = await handleOfferById(new Request(`https://idx/offers/${offerId}?chainId=${CHAIN}`), h.env, String(offerId));
  return (await res.json()) as {
    status: string;
    positionFlow: { kind: string; side: string; loanId: number | null; movedSinceOpened: boolean | null } | null;
  };
}

describe('the moved-since-opened rule', () => {
  it('compares (block, log index) in chain order and never rounds an unknown', () => {
    const at = (block: number, logIndex: number) => ({ block, logIndex });
    expect(movedSinceOpened(at(10, 3), null)).toBe(false);
    expect(movedSinceOpened(at(10, 3), at(10, 2))).toBe(false);
    expect(movedSinceOpened(at(10, 3), at(10, 4))).toBe(true);
    expect(movedSinceOpened(at(10, 3), at(11, 0))).toBe(true);
    expect(movedSinceOpened(at(10, 3), at(9, 99))).toBe(false);
    expect(movedSinceOpened(null, at(11, 0))).toBeNull();
    expect(movedSinceOpened(null, null)).toBeNull();
  });
});

describe('a borrower-side move ends the collateral listing and the swap intent', () => {
  it('a transfer after the listing was posted marks it moved; a mint does not', async () => {
    const h = harness();
    seedLoan(h);
    seedListing(h, 100, 2);
    await scan(h, [transfer(BORROWER_TOKEN, ZERO, BORROWER, 101, 0)]);
    expect((await loanById(h)).prepayListing?.positionMovedSinceOpened).toBe(false);
    await scan(h, [transfer(BORROWER_TOKEN, BORROWER, OTHER, 102, 0)]);
    expect((await loanById(h)).prepayListing?.positionMovedSinceOpened).toBe(true);
  });

  it('away and back still counts as moved', async () => {
    const h = harness();
    seedLoan(h);
    seedListing(h, 100, 2);
    await scan(h, [
      transfer(BORROWER_TOKEN, BORROWER, OTHER, 101, 0),
      transfer(BORROWER_TOKEN, OTHER, BORROWER, 101, 1),
    ]);
    expect((await loanById(h)).prepayListing?.positionMovedSinceOpened).toBe(true);
  });

  it('an update after the move re-arms the listing (its anchor moves past the transfer)', async () => {
    const h = harness();
    seedLoan(h);
    seedListing(h, 100, 2);
    await scan(h, [transfer(BORROWER_TOKEN, BORROWER, OTHER, 101, 0)]);
    // `PrepayListingUpdated` rewrites block_number / log_index to its own log.
    h.db.prepare(`UPDATE prepay_listings SET block_number = 103, log_index = 1 WHERE loan_id = ?`).run(LOAN);
    expect((await loanById(h)).prepayListing?.positionMovedSinceOpened).toBe(false);
  });

  it('a lender-side move leaves the borrower-side listing alone', async () => {
    const h = harness();
    seedLoan(h);
    seedListing(h, 100, 2);
    await scan(h, [transfer(LENDER_TOKEN, LENDER, OTHER, 101, 0)]);
    expect((await loanById(h)).prepayListing?.positionMovedSinceOpened).toBe(false);
  });

  it('a swap intent records where it opened and reads moved after a later transfer', async () => {
    const h = harness();
    seedLoan(h);
    await scan(h, [
      {
        eventName: 'SwapToRepayIntentCommitted',
        args: {
          loanId: BigInt(LOAN),
          orderHash: `0x${'aa'.repeat(32)}`,
          committedBy: BORROWER,
          makerAmount: 1n,
          takerAmount: 1n,
          deadline: 5_000n,
        },
        blockNumber: 100n,
        transactionHash: `0x${'cd'.repeat(32)}`,
        logIndex: 4,
      },
    ]);
    expect((await loanById(h)).swapToRepayIntent?.positionMovedSinceOpened).toBe(false);
    await scan(h, [transfer(BORROWER_TOKEN, BORROWER, OTHER, 100, 9)]);
    expect((await loanById(h)).swapToRepayIntent?.positionMovedSinceOpened).toBe(true);
  });

  it('an intent whose opening point is not recorded reads "cannot tell"', async () => {
    const h = harness();
    seedLoan(h);
    h.db
      .prepare(
        `INSERT INTO swap_to_repay_intents (chain_id, loan_id, order_hash, committed_by,
           maker_amount, taker_amount, deadline, committed_at, committed_tx_hash)
         VALUES (?, ?, '0xh', ?, '1', '1', 0, 0, '0xtx')`,
      )
      .run(CHAIN, LOAN, BORROWER);
    expect((await loanById(h)).swapToRepayIntent?.positionMovedSinceOpened).toBeNull();
  });

  it('a replayed older transfer never moves the recorded last move backwards', async () => {
    const h = harness();
    seedLoan(h);
    await scan(h, [transfer(BORROWER_TOKEN, BORROWER, OTHER, 105, 0)]);
    await scan(h, [transfer(BORROWER_TOKEN, BORROWER, OTHER, 99, 0)]);
    const row = h.db
      .prepare(`SELECT moved_block FROM position_side_moves WHERE loan_id = ? AND side = 'borrower'`)
      .get(LOAN) as { moved_block: number };
    expect(row.moved_block).toBe(105);
  });

  it('a retired receipt moving on records no move', async () => {
    const h = harness();
    seedLoan(h);
    h.db.prepare(`UPDATE loans SET borrower_current_owner = ? WHERE loan_id = ?`).run(ZERO, LOAN);
    await scan(h, [transfer(BORROWER_TOKEN, BORROWER, OTHER, 101, 0)]);
    expect(h.db.prepare(`SELECT COUNT(*) AS n FROM position_side_moves`).get()).toEqual({ n: 0 });
  });
});

describe('position-bound offers carry their verdict on the offer routes', () => {
  it('a lender-sale vehicle is bound by its link event and ends on a lender move', async () => {
    const h = harness();
    seedLoan(h);
    seedOffer(h, 40, { sale: true, block: 100, logIndex: 1 });
    await scan(h, [
      {
        eventName: 'LoanSaleOfferLinked',
        args: { loanId: BigInt(LOAN), saleOfferId: 40n },
        blockNumber: 100n,
        transactionHash: `0x${'ef'.repeat(32)}`,
        logIndex: 2,
      },
    ]);
    expect((await offerById(h, 40)).positionFlow).toEqual({
      kind: 'loanSale',
      side: 'lender',
      loanId: LOAN,
      movedSinceOpened: false,
    });
    // A borrower move does not touch the lender-side sale.
    await scan(h, [transfer(BORROWER_TOKEN, BORROWER, OTHER, 101, 0)]);
    expect((await offerById(h, 40)).positionFlow?.movedSinceOpened).toBe(false);
    await scan(h, [transfer(LENDER_TOKEN, LENDER, OTHER, 101, 1)]);
    const o = await offerById(h, 40);
    expect(o.positionFlow?.movedSinceOpened).toBe(true);
    // Still served, with its own status: the verdict is a field, never a filter.
    expect(o.status).toBe('active');
  });

  it('an offset vehicle and a refinance request are bound to the borrower side', async () => {
    const h = harness();
    seedLoan(h);
    seedOffer(h, 41, { offset: true, block: 100, logIndex: 1 });
    await scan(h, [
      {
        eventName: 'OffsetOfferCreated',
        args: { originalLoanId: BigInt(LOAN), newOfferId: 41n, borrower: BORROWER, shortfallPaid: 0n },
        blockNumber: 100n,
        transactionHash: `0x${'ef'.repeat(32)}`,
        logIndex: 2,
      },
    ]);
    seedOffer(h, 42, { refinance: LOAN, block: 102, logIndex: 0 });
    await scan(h, [transfer(BORROWER_TOKEN, BORROWER, OTHER, 101, 0)]);
    expect((await offerById(h, 41)).positionFlow).toEqual({
      kind: 'offset',
      side: 'borrower',
      loanId: LOAN,
      movedSinceOpened: true,
    });
    // Posted after the move: a new, live request.
    expect((await offerById(h, 42)).positionFlow).toEqual({
      kind: 'refinance',
      side: 'borrower',
      loanId: LOAN,
      movedSinceOpened: false,
    });
  });

  it('an ordinary offer is bound to no position; an unknown anchor reads "cannot tell"', async () => {
    const h = harness();
    seedLoan(h);
    seedOffer(h, 43, { block: 100, logIndex: 0 });
    seedOffer(h, 44, { refinance: LOAN, block: 100, logIndex: null });
    expect((await offerById(h, 43)).positionFlow).toBeNull();
    expect((await offerById(h, 44)).positionFlow?.movedSinceOpened).toBeNull();
  });
});

describe('migration 0085 backfills from the event ledger', () => {
  it('recovers each side’s last move, the offer anchor and the vehicle link', () => {
    const h = createSqliteD1(load(FILES.filter((f) => f < THIS_MIGRATION)));
    seedLoan(h);
    seedOffer(h, 40, { sale: true, block: 100, logIndex: null }, false);
    const act = (block: number, logIndex: number, kind: string, args: Record<string, unknown>, offerId: number | null = null) =>
      h.db
        .prepare(
          `INSERT INTO activity_events (chain_id, block_number, log_index, tx_hash, kind,
             loan_id, offer_id, actor, args_json, block_at)
           VALUES (?, ?, ?, '0xtx', ?, NULL, ?, NULL, ?, ?)`,
        )
        .run(CHAIN, block, logIndex, kind, offerId, JSON.stringify(args), 1_000 + block);
    act(100, 1, 'OfferCreated', { offerId: '40' }, 40);
    act(100, 2, 'LoanSaleOfferLinked', { loanId: String(LOAN), saleOfferId: '40' });
    act(90, 0, 'Transfer', { from: ZERO, to: LENDER, tokenId: String(LENDER_TOKEN) });
    act(101, 0, 'Transfer', { from: '0x00000000000000000000000000000000000000A1', to: OTHER, tokenId: String(LENDER_TOKEN) });
    act(103, 3, 'Transfer', { from: OTHER, to: LENDER, tokenId: String(LENDER_TOKEN) });
    h.db['exec'](readFileSync(new URL(THIS_MIGRATION, MIGRATIONS_DIR), 'utf8'));
    expect(h.db.prepare(`SELECT side, moved_block, moved_log_index FROM position_side_moves`).all()).toEqual([
      { side: 'lender', moved_block: 103, moved_log_index: 3 },
    ]);
    expect(h.db.prepare(`SELECT created_log_index, vehicle_loan_id FROM offers WHERE offer_id = 40`).get()).toEqual({
      created_log_index: 1,
      vehicle_loan_id: LOAN,
    });
  });
});

describe('the loan route lists the offers bound to the loan', () => {
  it('serves each open bound offer with its verdict, so a holder who did not post it can tell', async () => {
    const h = harness();
    seedLoan(h);
    seedOffer(h, 40, { sale: true, vehicleLoan: LOAN, block: 100, logIndex: 1 });
    seedOffer(h, 42, { refinance: LOAN, block: 100, logIndex: 3 });
    seedOffer(h, 43, { block: 100, logIndex: 4 });
    await scan(h, [transfer(BORROWER_TOKEN, BORROWER, OTHER, 101, 0)]);
    const res = await handleLoanById(new Request(`https://idx/loans/${LOAN}?chainId=${CHAIN}`), h.env, String(LOAN));
    const body = (await res.json()) as { positionFlows: unknown[] };
    expect(body.positionFlows).toEqual([
      { offerId: 42, status: 'active', kind: 'refinance', side: 'borrower', loanId: LOAN, movedSinceOpened: true },
      { offerId: 40, status: 'active', kind: 'loanSale', side: 'lender', loanId: LOAN, movedSinceOpened: false },
    ]);
  });
});
