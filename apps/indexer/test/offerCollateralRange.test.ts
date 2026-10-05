/**
 * #2382 — a borrower offer's committed collateral range, as the offer API
 * serves it.
 *
 * Pinned: the effective ceiling never carries the chain's 0 sentinel; an
 * unread ceiling serves as null (unknown), never as the floor; and a
 * database that predates migration 0054 still answers the offer routes
 * (`SELECT *` — the schema gate holds writes, not reads).
 */
import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { effectiveCollateralMax, markBorrowerFillsUnread, refreshStubOffers } from '../src/chainIndexer';
import { createBudget, meterEnv, spend } from '../src/subrequestBudget';
import { handleOfferById } from '../src/offerRoutes';
import type { Env } from '../src/env';
import { createSqliteD1 } from './helpers/sqliteD1';

const MIGRATIONS_DIR = new URL('../migrations/', import.meta.url);
const migrations = (upTo?: string) =>
  readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql') && (upTo === undefined || f < upTo))
    .sort()
    .map((f) => readFileSync(new URL(f, MIGRATIONS_DIR), 'utf8'));

const seed = (h: ReturnType<typeof createSqliteD1>, extra: Record<string, string | null>) => {
  const base: Record<string, string | number | null> = {
    chain_id: 84532,
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
  const cols = Object.keys(base);
  h.db
    .prepare(`INSERT INTO offers (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`)
    .run(...(Object.values(base) as never[]));
};

const fetchOffer = async (h: ReturnType<typeof createSqliteD1>) => {
  const res = await handleOfferById(
    new Request('https://x/offers/7?chainId=84532'),
    { DB: h.d1 } as unknown as Env,
    '7',
  );
  expect(res.status).toBe(200);
  return (await res.json()) as Record<string, unknown>;
};

describe('effectiveCollateralMax', () => {
  it('maps the chain 0 sentinel (single-value offer) to the floor', () => {
    expect(effectiveCollateralMax(150n, 0n)).toBe('150');
  });
  it('keeps a real ceiling', () => {
    expect(effectiveCollateralMax(150n, 400n)).toBe('400');
  });
  it('writes null — not the floor — when the field did not decode', () => {
    expect(effectiveCollateralMax(150n, undefined)).toBeNull();
  });
});

describe('offer API — collateral range', () => {
  it('serves the ceiling and the consumed portion once read', async () => {
    const h = createSqliteD1(migrations());
    seed(h, { collateral_amount_max: '400', collateral_amount_filled: '100' });
    const o = await fetchOffer(h);
    expect(o.collateralAmount).toBe('150');
    expect(o.collateralAmountMax).toBe('400');
    expect(o.collateralAmountFilled).toBe('100');
  });

  it('serves null (unknown) for a row not yet re-read', async () => {
    const h = createSqliteD1(migrations());
    seed(h, {});
    const o = await fetchOffer(h);
    expect(o.collateralAmountMax).toBeNull();
    expect(o.collateralAmountFilled).toBeNull();
  });

  it('still answers on a database that predates 0054', async () => {
    const h = createSqliteD1(migrations('0054'));
    seed(h, {});
    const o = await fetchOffer(h);
    expect(o.collateralAmount).toBe('150');
    expect(o.collateralAmountMax).toBeNull();
  });
});

describe('the range backfill lane (#2382 r1/r2)', () => {
  /** A chain client whose every read costs what a full refresh can: the
   *  details read, the ownerOf read and the UPDATE (3), then fails — so the
   *  lane's spending, not the row's content, is what is measured. */
  const costlyClient = (budget: ReturnType<typeof createBudget>, reads: number[]) =>
    ({
      async readContract({ args }: { args: [bigint] }) {
        reads.push(Number(args[0]));
        spend(budget, 3);
        throw new Error('read refused');
      },
    }) as never;

  it('stops starting rows once a row no longer fits either meter (a soft stop)', async () => {
    const h = createSqliteD1(migrations());
    for (let i = 1; i <= 20; i++) seed(h, { offer_id: String(i) });
    // Subrequests: 10 − 1 (the selection) = 9 → three rows at 3 each.
    const budget = createBudget(10, 'test', 1_000);
    const reads: number[] = [];
    await refreshStubOffers(
      costlyClient(budget, reads),
      '0x0' as never,
      84532,
      meterEnv({ DB: h.d1 } as unknown as Env, budget) as unknown as Env,
      budget,
    );
    expect(reads.length).toBe(3);
    // D1 queries are a second ceiling (#2382 r2): with none left after the
    // selection, no row starts however many subrequests remain.
    const tight = createBudget(1_000, 'test', 1);
    const none: number[] = [];
    await refreshStubOffers(
      costlyClient(tight, none),
      '0x0' as never,
      84532,
      meterEnv({ DB: h.d1 } as unknown as Env, tight) as unknown as Env,
      tight,
    );
    expect(none.length).toBe(0);
  });

  it('keeps a row queued until BOTH range columns are read', async () => {
    const h = createSqliteD1(migrations());
    seed(h, { offer_id: '1', collateral_amount_max: '400', collateral_amount_filled: null });
    seed(h, { offer_id: '2', collateral_amount_max: null, collateral_amount_filled: '0' });
    seed(h, { offer_id: '3', collateral_amount_max: '400', collateral_amount_filled: '0' });
    const budget = createBudget(1_000, 'test', 1_000);
    const reads: number[] = [];
    await refreshStubOffers(
      costlyClient(budget, reads),
      '0x0' as never,
      84532,
      meterEnv({ DB: h.d1 } as unknown as Env, budget) as unknown as Env,
      budget,
    );
    expect(reads.sort()).toEqual([1, 2]);
  });
});

describe('a match marks the borrower offer’s fills unread (#2382 r2)', () => {
  it('nulls only the named offers’ fills, which re-queues them for the refresh lane', async () => {
    const h = createSqliteD1(migrations());
    seed(h, { offer_id: '1', collateral_amount_max: '400', collateral_amount_filled: '0' });
    seed(h, { offer_id: '2', collateral_amount_max: '400', collateral_amount_filled: '0' });
    await markBorrowerFillsUnread({ DB: h.d1 } as unknown as Env, 84532, [1]);
    const rows = h.db
      .prepare('SELECT offer_id, collateral_amount_filled AS f FROM offers ORDER BY offer_id')
      .all() as { offer_id: number; f: string | null }[];
    expect(rows).toEqual([
      { offer_id: 1, f: null },
      { offer_id: 2, f: '0' },
    ]);
    // …and the refresh lane picks the marked row up.
    const budget = createBudget(1_000, 'test', 1_000);
    const reads: number[] = [];
    await refreshStubOffers(
      ({
        async readContract({ args }: { args: [bigint] }) {
          reads.push(Number(args[0]));
          throw new Error('read refused');
        },
      }) as never,
      '0x0' as never,
      84532,
      meterEnv({ DB: h.d1 } as unknown as Env, budget) as unknown as Env,
      budget,
    );
    expect(reads).toEqual([1]);
  });

  it('spends one statement batch however many offers it marks', async () => {
    const h = createSqliteD1(migrations());
    const ids = Array.from({ length: 150 }, (_, i) => i + 1);
    for (const i of ids) seed(h, { offer_id: String(i), collateral_amount_filled: '0' });
    const budget = createBudget(1_000, 'test', 1_000);
    await markBorrowerFillsUnread(meterEnv({ DB: h.d1 } as unknown as Env, budget) as unknown as Env, 84532, ids);
    expect(budget.subrequests.limit - budget.subrequests.remaining).toBe(1);
    const n = h.db.prepare('SELECT COUNT(*) AS n FROM offers WHERE collateral_amount_filled IS NULL').get() as { n: number };
    expect(n.n).toBe(150);
  });
});

describe('the heal lanes run LAST in the pass (#2382 r2)', () => {
  // Structural, like oneTimeBackfillReachability: the property is WHERE the
  // calls sit in runChainPass — after the cursor write and every once-per-scan
  // step — which no test of the lane alone can establish. That placement, not
  // a cost estimate, is what keeps an overrun from freezing the chain.
  const src = readFileSync(new URL('../src/chainIndexer.ts', import.meta.url), 'utf8');
  const body = src.slice(src.indexOf('async function runChainPass'), src.indexOf('\nfunction emptyResult'));
  const at = (needle: string) => {
    const i = body.indexOf(needle);
    expect(i, `${needle} not found in runChainPass`).toBeGreaterThan(-1);
    return i;
  };
  it('calls both lanes after the cursor write and the once-per-scan steps, inside a try', () => {
    const offers = at('await refreshStubOffers(');
    const loans = at('await refreshStubLoans(');
    for (const before of [
      'INSERT INTO indexer_cursor',
      'await materializeNotifications(',
      'await _runLoanReconcilePass(',
      'await _sweepCalendarIfEstablished(',
    ]) {
      expect(at(before), `${before} must precede the heal lanes`).toBeLessThan(offers);
    }
    expect(loans).toBeGreaterThan(offers);
    // Each call appears once, and inside the try that keeps a failure from
    // failing the pass.
    expect(body.split('await refreshStubOffers(').length).toBe(2);
    expect(body.lastIndexOf('try {', offers)).toBeGreaterThan(at('await _sweepCalendarIfEstablished('));
  });
  it('has the match handler mark the borrower offer rather than read it', () => {
    const p = src.slice(src.indexOf('async function processOfferLogs'), src.indexOf('export async function markBorrowerFillsUnread'));
    expect(p).toContain('borrowerFillsStale.add(Number(ev.borrowerOfferId))');
    expect(p).toContain('await markBorrowerFillsUnread(env, chainId, [...borrowerFillsStale])');
    // No block-pinned borrower read survives in the scan path.
    expect(src).not.toContain('readOfferFillsAt');
  });
});

describe('a range backfill keeps the offer’s recorded holder (#2382 r3)', () => {
  const CREATOR = '0x00000000000000000000000000000000000000c0';
  const HOLDER = '0x00000000000000000000000000000000000000d0';
  const NEW_HOLDER = '0x00000000000000000000000000000000000000e0';
  const detail = {
    creator: CREATOR, offerType: 1, principalLiquidity: 0, collateralLiquidity: 0, accepted: false,
    assetType: 0, collateralAssetType: 0, useFullTermInterest: false, creatorRiskAndTermsConsent: true,
    allowsPartialRepay: false, lendingAsset: '0x00000000000000000000000000000000000000a1', amount: 1000n,
    interestRateBps: 500n, collateralAsset: '0x00000000000000000000000000000000000000b1', collateralAmount: 150n,
    durationDays: 30n, tokenId: 0n, positionTokenId: 5n, quantity: 0n, collateralTokenId: 0n,
    collateralQuantity: 0n, prepayAsset: '0x0000000000000000000000000000000000000000', amountMax: 1000n,
    amountFilled: 0n, interestRateBpsMax: 500n, collateralAmountMax: 400n, collateralAmountFilled: 0n,
    createdAt: 1n, expiresAt: 0n, fillMode: 0,
  };
  const client = (owner: () => string) =>
    ({
      async readContract({ functionName }: { functionName: string }) {
        if (functionName === 'getOfferDetails') return detail;
        return owner();
      },
    }) as never;
  const run = async (h: ReturnType<typeof createSqliteD1>, owner: () => string) => {
    const budget = createBudget(1_000, 'test', 1_000);
    await refreshStubOffers(client(owner), '0x0' as never, 84532,
      meterEnv({ DB: h.d1 } as unknown as Env, budget) as unknown as Env, budget);
    return h.db.prepare('SELECT creator_current_owner AS o, collateral_amount_max AS m FROM offers').get() as {
      o: string;
      m: string | null;
    };
  };

  it('keeps a recorded transferee when ownerOf does not answer, and still writes the range', async () => {
    const h = createSqliteD1(migrations());
    seed(h, { creator_current_owner: HOLDER });
    const r = await run(h, () => {
      throw new Error('rpc dropped');
    });
    expect(r).toEqual({ o: HOLDER, m: '400' });
  });

  it('writes the holder ownerOf reports', async () => {
    const h = createSqliteD1(migrations());
    seed(h, { creator_current_owner: HOLDER });
    expect((await run(h, () => NEW_HOLDER)).o).toBe(NEW_HOLDER);
  });

  it('falls back to the creator only when nothing is recorded', async () => {
    const h = createSqliteD1(migrations());
    seed(h, { creator_current_owner: '' });
    expect(
      (
        await run(h, () => {
          throw new Error('reverted');
        })
      ).o,
    ).toBe(CREATOR);
  });
});
