/**
 * #2383 — the asset/amount each activity row moved or offered.
 *
 * Built from REAL decoded logs: every event below is ABI-encoded into topics
 * and data from the compiled Diamond ABI and decoded back the way the scan
 * decodes it, so the args shapes (the nested `fields` / `details` tuples, the
 * bigints) are the chain's, not a hand-written guess. #2378 was withdrawn
 * precisely because hand-shaped args hid those shapes.
 *
 * And run against the REAL migrated schema: `recordActivityEvents` reads the
 * loan and offer records through dynamic `IN (…)` statements, which the
 * SQL-vs-schema guard cannot see statically (#1149), so this file is the
 * covering test that guard asks for.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  decodeEventLog,
  encodeAbiParameters,
  encodeEventTopics,
  type AbiEvent,
} from 'viem';
import { DIAMOND_ABI_VIEM } from '@vaipakam/contracts/abis';
import { recordActivityEvents } from '../src/chainIndexer';
import { handleActivity } from '../src/loanRoutes';
import { activityValue, emptyContext } from '../src/activityValue';
import type { Env } from '../src/env';
import { createSqliteD1 } from './helpers/sqliteD1';

const CHAIN = 84532;
const MIGRATIONS_DIR = new URL('../migrations/', import.meta.url);
const migrations = (upTo?: string) =>
  readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql') && (upTo === undefined || f < upTo))
    .sort()
    .map((f) => readFileSync(new URL(f, MIGRATIONS_DIR), 'utf8'));

const USDC = '0x00000000000000000000000000000000000000a1';
const WETH = '0x00000000000000000000000000000000000000a2';
const NFT = '0x00000000000000000000000000000000000000b1';
const RENT = '0x00000000000000000000000000000000000000c1';
const A1 = '0x00000000000000000000000000000000000000e1';
const A2 = '0x00000000000000000000000000000000000000e2';

const eventAbi = (name: string) =>
  (DIAMOND_ABI_VIEM as readonly AbiEvent[]).find((e) => e.type === 'event' && e.name === name)!;

/** Encode `args` as the chain would emit them, then decode them back. */
function realLog(name: string, args: Record<string, unknown>, tx: number, logIndex: number) {
  const ev = eventAbi(name);
  const topics = encodeEventTopics({ abi: [ev], eventName: name, args } as never);
  const nonIndexed = ev.inputs.filter((i) => !i.indexed);
  const data = encodeAbiParameters(nonIndexed, nonIndexed.map((i) => args[i.name!]) as never);
  const decoded = decodeEventLog({ abi: [ev], topics, data }) as {
    eventName: string;
    args: Record<string, unknown>;
  };
  return {
    eventName: decoded.eventName,
    args: decoded.args,
    blockNumber: 1000n,
    transactionHash: `0x${tx.toString(16).padStart(64, '0')}`,
    logIndex,
  };
}

const offerFields = (o: Partial<Record<string, unknown>>) => ({
  offerType: 0,
  assetType: 0,
  collateralAssetType: 0,
  amount: 0n,
  tokenId: 0n,
  collateralAsset: WETH,
  collateralAmount: 10n,
  interestRateBps: 500n,
  durationDays: 30n,
  amountMax: 0n,
  interestRateBpsMax: 0n,
  collateralAmountMax: 0n,
  creatorRiskAndTermsConsent: true,
  allowsPartialRepay: false,
  periodicInterestCadence: 0,
  expiresAt: 0n,
  fillMode: 0,
  allowsPrepayListing: false,
  refinanceTargetLoanId: 0n,
  ...o,
});

const loanDetails = (d: Partial<Record<string, unknown>>) => ({
  principalAsset: USDC,
  interestRateBps: 500n,
  durationDays: 30n,
  dueTimestamp: 0n,
  assetType: 0,
  collateralAssetType: 0,
  tokenId: 0n,
  quantity: 0n,
  collateralAsset: WETH,
  collateralAmount: 10n,
  collateralTokenId: 0n,
  collateralQuantity: 0n,
  prepayAsset: '0x0000000000000000000000000000000000000000',
  prepayAmount: 0n,
  bufferAmount: 0n,
  riskAndTermsConsentFromBoth: true,
  allowsPartialRepay: false,
  allowsPrepayListing: false,
  periodicInterestCadence: 0,
  matcher: '0x0000000000000000000000000000000000000000',
  healthFactorAtInit: 0n,
  lenderTokenId: 1n,
  borrowerTokenId: 2n,
  treasuryFeeBpsAtInit: 200,
  loanInitiationFeeBpsAtInit: 20,
  ...d,
});

function seedLoan(h: ReturnType<typeof createSqliteD1>, loanId: number, l: Record<string, unknown>) {
  const row: Record<string, unknown> = {
    chain_id: CHAIN,
    loan_id: loanId,
    offer_id: 900 + loanId,
    lender: A1,
    borrower: A2,
    principal: '1',
    collateral_amount: '1',
    start_block: 1,
    start_at: 1,
    updated_at: 1,
    ...l,
  };
  const cols = Object.keys(row);
  h.db
    .prepare(`INSERT INTO loans (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`)
    .run(...(Object.values(row) as never[]));
}

function seedOffer(h: ReturnType<typeof createSqliteD1>, offerId: number, o: Record<string, unknown>) {
  const row: Record<string, unknown> = {
    chain_id: CHAIN,
    offer_id: offerId,
    creator: A1,
    offer_type: 0,
    lending_asset: USDC,
    collateral_asset: WETH,
    asset_type: 0,
    collateral_asset_type: 0,
    amount: '1',
    interest_rate_bps: 500,
    collateral_amount: '1',
    duration_days: 30,
    first_seen_block: 1,
    first_seen_at: 1,
    updated_at: 1,
    ...o,
  };
  const cols = Object.keys(row);
  h.db
    .prepare(`INSERT INTO offers (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`)
    .run(...(Object.values(row) as never[]));
}

type Row = {
  kind: string;
  log_index: number;
  asset: string | null;
  asset_type: number | null;
  amount: string | null;
  amount_max: string | null;
  token_id: string | null;
};

async function record(h: ReturnType<typeof createSqliteD1>, logs: ReturnType<typeof realLog>[]) {
  await recordActivityEvents(logs as never, { DB: h.d1 } as unknown as Env, CHAIN, new Map());
  return h.db
    .prepare(
      'SELECT kind, log_index, asset, asset_type, amount, amount_max, token_id FROM activity_events ORDER BY log_index',
    )
    .all() as Row[];
}

const value = (r: Row) => ({
  asset: r.asset,
  assetType: r.asset_type,
  amount: r.amount,
  amountMax: r.amount_max,
  tokenId: r.token_id,
});

describe('loan start', () => {
  it('puts the principal and its asset on BOTH rows of the pair', async () => {
    const h = createSqliteD1(migrations());
    const rows = await record(h, [
      realLog('LoanInitiated', { loanId: 5n, offerId: 9n, lender: A1, borrower: A2, principal: 1_000_000n, collateralAmount: 10n }, 1, 0),
      realLog('LoanInitiatedDetails', { loanId: 5n, lender: A1, borrower: A2, details: loanDetails({}) }, 1, 1),
    ]);
    for (const r of rows) {
      expect(value(r)).toEqual({ asset: USDC, assetType: 0, amount: '1000000', amountMax: null, tokenId: null });
    }
  });

  it('gives each loan of a multicall its OWN value, matched by id', async () => {
    const h = createSqliteD1(migrations());
    const rows = await record(h, [
      realLog('LoanInitiated', { loanId: 5n, offerId: 9n, lender: A1, borrower: A2, principal: 111n, collateralAmount: 1n }, 1, 0),
      realLog('LoanInitiated', { loanId: 6n, offerId: 10n, lender: A1, borrower: A2, principal: 222n, collateralAmount: 1n }, 1, 1),
      // Details emitted in the OTHER order: position must not decide.
      realLog('LoanInitiatedDetails', { loanId: 6n, lender: A1, borrower: A2, details: loanDetails({ principalAsset: WETH }) }, 1, 2),
      realLog('LoanInitiatedDetails', { loanId: 5n, lender: A1, borrower: A2, details: loanDetails({}) }, 1, 3),
    ]);
    expect(rows.map((r) => [r.kind, r.asset, r.amount])).toEqual([
      ['LoanInitiated', USDC, '111'],
      ['LoanInitiated', WETH, '222'],
      ['LoanInitiatedDetails', WETH, '222'],
      ['LoanInitiatedDetails', USDC, '111'],
    ]);
  });

  it('records an NFT rental by token id, with no amount', async () => {
    const h = createSqliteD1(migrations());
    const rows = await record(h, [
      realLog('LoanInitiated', { loanId: 5n, offerId: 9n, lender: A1, borrower: A2, principal: 1n, collateralAmount: 0n }, 1, 0),
      realLog('LoanInitiatedDetails', { loanId: 5n, lender: A1, borrower: A2, details: loanDetails({ principalAsset: NFT, assetType: 1, tokenId: 42n }) }, 1, 1),
    ]);
    expect(value(rows[0])).toEqual({ asset: NFT, assetType: 1, amount: null, amountMax: null, tokenId: '42' });
  });
});

describe('offer creation and cancellation', () => {
  const created = (offerId: bigint, fields: Record<string, unknown>, tx: number, at: number) => [
    realLog('OfferCreated', { offerId, creator: A1, offerType: 0 }, tx, at),
    realLog('OfferCreatedDetails', { offerId, creator: A1, lendingAsset: USDC, fields: offerFields(fields) }, tx, at + 1),
  ];

  it('an exact offer: amount, no range', async () => {
    const h = createSqliteD1(migrations());
    const rows = await record(h, created(3n, { amount: 500n }, 1, 0));
    for (const r of rows) {
      expect(value(r)).toEqual({ asset: USDC, assetType: 0, amount: '500', amountMax: null, tokenId: null });
    }
  });

  it('a range offer: the minimum AND the ceiling — `amount` alone is only the minimum', async () => {
    const h = createSqliteD1(migrations());
    const rows = await record(h, created(3n, { amount: 500n, amountMax: 2_000n }, 1, 0));
    expect(value(rows[0])).toEqual({ asset: USDC, assetType: 0, amount: '500', amountMax: '2000', tokenId: null });
  });

  it('a multicall creating two offers gives each its own terms', async () => {
    const h = createSqliteD1(migrations());
    const rows = await record(h, [
      ...created(3n, { amount: 500n }, 1, 0),
      ...created(4n, { amount: 700n, amountMax: 900n }, 1, 2),
    ]);
    expect(rows.filter((r) => r.kind === 'OfferCreated').map((r) => [r.amount, r.amount_max])).toEqual([
      ['500', null],
      ['700', '900'],
    ]);
  });

  it('a cancellation carries the cancelled offer’s terms', async () => {
    const h = createSqliteD1(migrations());
    const rows = await record(h, [
      realLog('OfferCanceled', { offerId: 3n, creator: A1 }, 1, 0),
      realLog(
        'OfferCanceledDetails',
        {
          offerId: 3n, creator: A1, offerType: 0, assetType: 0, lendingAsset: USDC, amount: 500n, tokenId: 0n,
          collateralAsset: WETH, collateralAmount: 1n, interestRateBps: 500n, durationDays: 30n,
          amountMax: 800n, interestRateBpsMax: 0n, amountFilled: 0n,
        },
        1,
        1,
      ),
    ]);
    expect(value(rows[0])).toEqual({ asset: USDC, assetType: 0, amount: '500', amountMax: '800', tokenId: null });
  });

  it('an amendment states the new size in the offer’s own asset', async () => {
    const h = createSqliteD1(migrations());
    seedOffer(h, 3, { lending_asset: WETH });
    const rows = await record(h, [
      realLog('OfferModified', { offerId: 3n, creator: A1, amount: 40n, amountMax: 0n, interestRateBps: 1n, interestRateBpsMax: 0n, collateralAmount: 1n, collateralAmountMax: 0n }, 1, 0),
    ]);
    expect(value(rows[0])).toEqual({ asset: WETH, assetType: 0, amount: '40', amountMax: null, tokenId: null });
  });
});

describe('claims — the event carries no asset type; the loan record decides it', () => {
  const claim = (name: string, loanId: bigint, asset: string, amount: bigint) =>
    realLog(name, name === 'BorrowerSurplusClaimed'
      ? { loanId, claimant: A1, asset, amount }
      : { loanId, claimant: A1, asset, amount, newBothClaimed: false }, 1, 0);

  it('an ERC-20 claim of the principal asset states its amount', async () => {
    const h = createSqliteD1(migrations());
    seedLoan(h, 5, { lending_asset: USDC, collateral_asset: WETH });
    const [r] = await record(h, [claim('LenderFundsClaimed', 5n, USDC, 1_100n)]);
    expect(value(r)).toEqual({ asset: USDC, assetType: 0, amount: '1100', amountMax: null, tokenId: null });
  });

  it('an NFT collateral claim names the token and states NO amount', async () => {
    const h = createSqliteD1(migrations());
    seedLoan(h, 5, { lending_asset: USDC, collateral_asset: NFT, collateral_asset_type: 1, collateral_token_id: '77' });
    const [r] = await record(h, [claim('BorrowerFundsClaimed', 5n, NFT, 1n)]);
    expect(value(r)).toEqual({ asset: NFT, assetType: 1, amount: null, amountMax: null, tokenId: '77' });
  });

  it('a rental fee claim in the offer’s prepay asset is ERC-20', async () => {
    const h = createSqliteD1(migrations());
    seedOffer(h, 905, { prepay_asset: RENT });
    seedLoan(h, 5, { lending_asset: NFT, asset_type: 1, token_id: '42', collateral_asset: WETH });
    const [r] = await record(h, [claim('LenderFundsClaimed', 5n, RENT, 300n)]);
    expect(value(r)).toEqual({ asset: RENT, assetType: 0, amount: '300', amountMax: null, tokenId: null });
  });

  it('an asset the loan cannot place, or places two ways, states no type and no amount', async () => {
    const h = createSqliteD1(migrations());
    // Same contract on both sides with different types: which one moved?
    seedLoan(h, 5, { lending_asset: NFT, asset_type: 2, collateral_asset: NFT, collateral_asset_type: 1 });
    seedLoan(h, 6, { lending_asset: USDC, collateral_asset: WETH });
    const rows = await record(h, [
      realLog('BorrowerFundsClaimed', { loanId: 5n, claimant: A1, asset: NFT, amount: 1n, newBothClaimed: false }, 1, 0),
      realLog('LenderFundsClaimed', { loanId: 6n, claimant: A1, asset: RENT, amount: 9n, newBothClaimed: false }, 1, 1),
    ]);
    expect(value(rows[0])).toEqual({ asset: NFT, assetType: null, amount: null, amountMax: null, tokenId: null });
    expect(value(rows[1])).toEqual({ asset: RENT, assetType: null, amount: null, amountMax: null, tokenId: null });
  });
});

describe('fills', () => {
  it('an accept states its fill in the child loan’s principal asset', () => {
    const ctx = emptyContext();
    ctx.loanDetails.set(5, loanDetails({ principalAsset: WETH }));
    expect(activityValue('OfferAccepted', { offerId: 3n, loanId: 5n, matchAmount: 250n }, ctx)).toEqual({
      asset: WETH,
      assetType: 0,
      amount: '250',
      amountMax: null,
      tokenId: null,
    });
  });

  it('an event with no single amount carries nothing', () => {
    expect(activityValue('LoanRepaid', { loanId: 5n }, emptyContext())).toEqual({
      asset: null,
      assetType: null,
      amount: null,
      amountMax: null,
      tokenId: null,
    });
  });
});

describe('/activity serves the value — and a database before 0055 still serves', () => {
  const fetchRows = async (h: ReturnType<typeof createSqliteD1>) => {
    const res = await handleActivity(new Request(`https://x/activity?chainId=${CHAIN}`), {
      DB: h.d1,
    } as unknown as Env);
    expect(res.status).toBe(200);
    return ((await res.json()) as { events: Record<string, unknown>[] }).events;
  };

  it('serves the five fields', async () => {
    const h = createSqliteD1(migrations());
    await record(h, [
      realLog('LoanInitiated', { loanId: 5n, offerId: 9n, lender: A1, borrower: A2, principal: 7n, collateralAmount: 1n }, 1, 0),
      realLog('LoanInitiatedDetails', { loanId: 5n, lender: A1, borrower: A2, details: loanDetails({}) }, 1, 1),
    ]);
    const [first] = await fetchRows(h);
    expect(first).toMatchObject({ asset: USDC, assetType: 0, amount: '7', amountMax: null, tokenId: null });
  });

  it('answers with null fields on a pre-0055 schema', async () => {
    const h = createSqliteD1(migrations('0055'));
    h.db
      .prepare(
        `INSERT INTO activity_events (chain_id, block_number, log_index, tx_hash, kind, args_json, block_at)
         VALUES (?, 1, 0, '0x1', 'LoanRepaid', '{}', 1)`,
      )
      .run(CHAIN);
    const [first] = await fetchRows(h);
    expect(first).toMatchObject({ asset: null, assetType: null, amount: null, amountMax: null, tokenId: null });
  });
});
