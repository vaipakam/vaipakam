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
import { effectiveCollateralMax, refreshStubOffers } from '../src/chainIndexer';
import { CURSOR_WRITE_RESERVE, createBudget, meterEnv, spend } from '../src/subrequestBudget';
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

describe('the range backfill lane (#2382 r1)', () => {
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

  it('stops while the cursor write is still affordable, however large the backlog', async () => {
    const h = createSqliteD1(migrations());
    for (let i = 1; i <= 20; i++) seed(h, { offer_id: String(i) });
    const budget = createBudget(10);
    const reads: number[] = [];
    await refreshStubOffers(
      costlyClient(budget, reads),
      '0x0' as never,
      84532,
      meterEnv({ DB: h.d1 } as unknown as Env, budget) as unknown as Env,
      budget,
    );
    // 10 − 1 (the selection) = 9: two rows at 3 each leave 3, below 3 + 1.
    expect(reads.length).toBe(2);
    expect(budget.subrequests.remaining).toBeGreaterThanOrEqual(CURSOR_WRITE_RESERVE);
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
