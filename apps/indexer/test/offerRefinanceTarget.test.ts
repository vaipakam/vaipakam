/**
 * #2528 — which loan a refinance request is for, as the offer API serves it.
 *
 * Pinned: a read that did not decode the tag writes NULL (unknown), never 0
 * ("not a refinance"); migration 0068 backfills rows indexed before it from
 * each offer's own `OfferCreatedDetails` log, on the right chain only, and
 * leaves a row it cannot reach unknown; the heal lane writes the tag it reads;
 * and a database that predates 0068 still answers the offer routes.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { refinanceTargetFromDetail, refreshStubOffers } from '../src/chainIndexer';
import { createBudget, meterEnv } from '../src/subrequestBudget';
import { handleOfferById } from '../src/offerRoutes';
import type { Env } from '../src/env';
import { createSqliteD1 } from './helpers/sqliteD1';

const MIGRATIONS_DIR = new URL('../migrations/', import.meta.url);
const CHAIN = 84532;
const OTHER_CHAIN = 421614;

const migrationFiles = () =>
  readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort();
const sql = (f: string) => readFileSync(new URL(f, MIGRATIONS_DIR), 'utf8');
/** Every migration strictly before `upTo` (all when omitted). */
const migrations = (upTo?: string) =>
  migrationFiles()
    .filter((f) => upTo === undefined || f < upTo)
    .map(sql);
const MIGRATION_0068 = migrationFiles().find((f) => f.startsWith('0068_'))!;

type H = ReturnType<typeof createSqliteD1>;

const seedOffer = (h: H, extra: Record<string, string | number | null | undefined>) => {
  const base: Record<string, string | number | null | undefined> = {
    chain_id: CHAIN,
    offer_id: 7,
    status: 'active',
    creator: '0xc0',
    offer_type: 1,
    asset_type: 0,
    collateral_asset_type: 0,
    lending_asset: '0xa1',
    collateral_asset: '0xb1',
    amount: '1000',
    interest_rate_bps: 500,
    collateral_amount: '150',
    duration_days: 30,
    first_seen_block: 1,
    first_seen_at: 1,
    updated_at: 1,
    ...extra,
  };
  // A key set to undefined is omitted — how a pre-0068 schema test leaves out
  // the column that schema does not have.
  const cols = Object.keys(base).filter((k) => base[k] !== undefined);
  h.db
    .prepare(`INSERT INTO offers (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`)
    .run(...(cols.map((k) => base[k]) as never[]));
};

let logIndex = 0;
/** An `OfferCreatedDetails` ledger row, args serialized the way the indexer
 *  writes them (bigints as decimal strings, the tuple as a named object). */
const seedCreatedDetails = (h: H, chainId: number, offerId: number, target: string | undefined) => {
  const fields: Record<string, string> = { offerType: '1', amount: '1000' };
  if (target !== undefined) fields.refinanceTargetLoanId = target;
  h.db
    .prepare(
      `INSERT INTO activity_events
         (chain_id, block_number, log_index, tx_hash, kind, args_json, block_at)
       VALUES (?, 1, ?, '0xtx', 'OfferCreatedDetails', ?, 1)`,
    )
    .run(chainId, logIndex++, JSON.stringify({ offerId: String(offerId), creator: '0xc0', fields }));
};

const target = (h: H, chainId: number, offerId: number) =>
  (
    h.db
      .prepare('SELECT refinance_target_loan_id AS t FROM offers WHERE chain_id = ? AND offer_id = ?')
      .get(chainId, offerId) as { t: number | null }
  ).t;

const fetchOffer = async (h: H, offerId = 7) => {
  const res = await handleOfferById(
    new Request(`https://x/offers/${offerId}?chainId=${CHAIN}`),
    { DB: h.d1, RPC_BASE_SEPOLIA: 'http://127.0.0.1:9' } as unknown as Env,
    String(offerId),
  );
  expect(res.status).toBe(200);
  return (await res.json()) as Record<string, unknown>;
};

describe('refinanceTargetFromDetail', () => {
  it('keeps the tagged loan id', () => {
    expect(refinanceTargetFromDetail(42n)).toBe(42);
  });
  it('keeps 0 — a read that decoded the field and found no tag', () => {
    expect(refinanceTargetFromDetail(0n)).toBe(0);
  });
  it('writes null (unknown), never 0, when the field did not decode', () => {
    expect(refinanceTargetFromDetail(undefined)).toBeNull();
  });
  it('writes null for a value past the safe-integer range', () => {
    expect(refinanceTargetFromDetail(2n ** 64n)).toBeNull();
  });
});

describe('migration 0068 backfill', () => {
  it('fills each row from its own OfferCreatedDetails log, and leaves an unreachable row unknown', () => {
    const h = createSqliteD1(migrations(MIGRATION_0068));
    seedOffer(h, { offer_id: 1, refinance_target_loan_id: undefined });
    seedOffer(h, { offer_id: 2, refinance_target_loan_id: undefined });
    seedOffer(h, { offer_id: 3, refinance_target_loan_id: undefined });
    seedOffer(h, { offer_id: 4, refinance_target_loan_id: undefined });
    // Same offer id on another chain: its log must not fill this chain's row.
    seedOffer(h, { chain_id: OTHER_CHAIN, offer_id: 3, refinance_target_loan_id: undefined });
    seedCreatedDetails(h, CHAIN, 1, '9'); // a refinance request for loan 9
    seedCreatedDetails(h, CHAIN, 2, '0'); // not a refinance request
    seedCreatedDetails(h, OTHER_CHAIN, 3, '5'); // the other chain's offer 3
    seedCreatedDetails(h, CHAIN, 4, undefined); // a log shape without the field
    h.db.exec(sql(MIGRATION_0068));
    expect(target(h, CHAIN, 1)).toBe(9);
    expect(target(h, CHAIN, 2)).toBe(0);
    expect(target(h, CHAIN, 3)).toBeNull(); // no log on this chain: unknown
    expect(target(h, CHAIN, 4)).toBeNull(); // log without the field: unknown
    expect(target(h, OTHER_CHAIN, 3)).toBe(5);
  });
});

describe('offer API — refinance target', () => {
  it('serves the tagged loan id', async () => {
    const h = createSqliteD1(migrations());
    seedOffer(h, { refinance_target_loan_id: 9 });
    expect((await fetchOffer(h)).refinanceTargetLoanId).toBe(9);
  });

  it('serves 0 for an offer read as not a refinance request', async () => {
    const h = createSqliteD1(migrations());
    seedOffer(h, { refinance_target_loan_id: 0 });
    expect((await fetchOffer(h)).refinanceTargetLoanId).toBe(0);
  });

  it('serves null (unknown) for a row whose tag was never read', async () => {
    const h = createSqliteD1(migrations());
    seedOffer(h, {});
    expect((await fetchOffer(h)).refinanceTargetLoanId).toBeNull();
  });

  it('still answers on a database that predates 0068', async () => {
    const h = createSqliteD1(migrations(MIGRATION_0068));
    seedOffer(h, { refinance_target_loan_id: undefined });
    const o = await fetchOffer(h);
    expect(o.amount).toBe('1000');
    expect(o.refinanceTargetLoanId).toBeNull();
  });
});

describe('the heal lane writes the tag it reads', () => {
  const detail = (refinanceTargetLoanId: bigint | undefined) => ({
    creator: '0x00000000000000000000000000000000000000c0',
    offerType: 1,
    principalLiquidity: 0,
    collateralLiquidity: 0,
    accepted: false,
    assetType: 0,
    collateralAssetType: 0,
    useFullTermInterest: false,
    creatorRiskAndTermsConsent: true,
    allowsPartialRepay: false,
    lendingAsset: '0x00000000000000000000000000000000000000a1',
    amount: 1000n,
    interestRateBps: 500n,
    collateralAsset: '0x00000000000000000000000000000000000000b1',
    collateralAmount: 150n,
    durationDays: 30n,
    tokenId: 0n,
    positionTokenId: 0n,
    quantity: 0n,
    collateralTokenId: 0n,
    collateralQuantity: 0n,
    prepayAsset: '0x0000000000000000000000000000000000000000',
    ...(refinanceTargetLoanId === undefined ? {} : { refinanceTargetLoanId }),
  });

  const heal = async (h: H, read: ReturnType<typeof detail>) => {
    const budget = createBudget('test', { external: 1_000, d1Queries: 1_000 });
    await refreshStubOffers(
      { readContract: async () => read } as never,
      '0x0' as never,
      CHAIN,
      meterEnv({ DB: h.d1 } as unknown as Env, budget) as unknown as Env,
      budget,
      1n,
    );
  };

  it('fills a stub row with the decoded tag', async () => {
    const h = createSqliteD1(migrations());
    seedOffer(h, { is_stub: 1 });
    await heal(h, detail(9n));
    expect(target(h, CHAIN, 7)).toBe(9);
  });

  it('keeps what is stored when the read did not decode the field', async () => {
    const h = createSqliteD1(migrations());
    seedOffer(h, { is_stub: 1, refinance_target_loan_id: 9 });
    await heal(h, detail(undefined));
    expect(target(h, CHAIN, 7)).toBe(9);
  });
});
