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
/** The settled block a pass pins its heal reads to. */
const AT = 12_345n;

const migrations = (upTo?: string) =>
  readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql') && (upTo === undefined || f < upTo))
    .sort()
    .map((f) => readFileSync(new URL(f, MIGRATIONS_DIR), 'utf8'));

const seed = (h: ReturnType<typeof createSqliteD1>, extra: Record<string, string | number | null | undefined>) => {
  const base: Record<string, string | number | null | undefined> = {
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
    // Marked for the heal lane by default — the state a new row or the 0054
    // backfill leaves; tests that need an unmarked row say so.
    collateral_range_stale: 1,
    ...extra,
  };
  // A key set to undefined is omitted — how a pre-0054 schema test leaves
  // out a column that schema does not have.
  const cols = Object.keys(base).filter((k) => base[k] !== undefined);
  h.db
    .prepare(`INSERT INTO offers (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`)
    .run(...(cols.map((k) => base[k]) as never[]));
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
    seed(h, { collateral_range_stale: undefined });
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
      AT,
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
      AT,
    );
    expect(none.length).toBe(0);
  });

  it('selects on the explicit marker, not on which columns happen to be NULL (#2382 r6)', async () => {
    const h = createSqliteD1(migrations());
    // Marked, with both columns already set (an amend wrote the ceiling).
    seed(h, { offer_id: '1', collateral_amount_max: '400', collateral_amount_filled: '0', collateral_range_stale: 1 });
    // Unmarked, with both columns NULL (terminal history the backfill skipped).
    seed(h, { offer_id: '2', status: 'fullyFilled', collateral_range_stale: 0 });
    // Marked and terminal (a match marked it, then closed it).
    seed(h, { offer_id: '3', status: 'fullyFilled', collateral_amount_max: null, collateral_amount_filled: null, collateral_range_stale: 1 });
    const budget = createBudget(1_000, 'test', 1_000);
    const reads: number[] = [];
    await refreshStubOffers(
      costlyClient(budget, reads),
      '0x0' as never,
      84532,
      meterEnv({ DB: h.d1 } as unknown as Env, budget) as unknown as Env,
      budget,
      AT,
    );
    expect(reads.sort()).toEqual([1, 3]);
  });
});

describe('a match marks the borrower offer’s fills unread (#2382 r2)', () => {
  it('nulls only the named offers’ fills, which re-queues them for the refresh lane', async () => {
    const h = createSqliteD1(migrations());
    seed(h, { offer_id: '1', collateral_amount_max: '400', collateral_amount_filled: '0', collateral_range_stale: 0 });
    seed(h, { offer_id: '2', collateral_amount_max: '400', collateral_amount_filled: '0', collateral_range_stale: 0 });
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
      AT,
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

describe('the heal lanes run LAST in the pass (#2382 r2/r6)', () => {
  // Structural, like oneTimeBackfillReachability: the property is WHERE the
  // calls sit — after the cursor write and every once-per-scan step, on the
  // scanning AND the caught-up path — which no test of the lane alone can
  // establish. Each function is sliced up to the NEXT top-level function, so
  // a call elsewhere in the file cannot satisfy it (#2382 r6: the previous
  // slice ran on past runChainPass and passed vacuously).
  const src = readFileSync(new URL('../src/chainIndexer.ts', import.meta.url), 'utf8');
  const fn = (decl: string) => {
    const i = src.indexOf(decl);
    expect(i, `${decl} not found`).toBeGreaterThan(-1);
    const next = src.slice(i + decl.length).search(/\n(export )?(async )?function /);
    return src.slice(i, next < 0 ? undefined : i + decl.length + next);
  };
  const pass = fn('async function runChainPass(');
  const heal = fn('async function runHealLanes(');
  const at = (body: string, needle: string, from = 0) => {
    const i = body.indexOf(needle, from);
    expect(i, `${needle} not found`).toBeGreaterThan(-1);
    return i;
  };

  it('runHealLanes runs both lanes inside one try, offers first', () => {
    const t = at(heal, 'try {');
    expect(at(heal, 'await refreshStubOffers(')).toBeGreaterThan(t);
    expect(at(heal, 'await refreshStubLoans(')).toBeGreaterThan(at(heal, 'await refreshStubOffers('));
    expect(at(heal, '} catch')).toBeGreaterThan(at(heal, 'await refreshStubLoans('));
  });

  it('the scanning tail heals after the cursor write and every once-per-scan step, pinned to scanTo', () => {
    const cursor = at(pass, 'INSERT INTO indexer_cursor');
    const call = pass.indexOf('await runHealLanes(', cursor);
    expect(call, 'no heal call after the cursor write').toBeGreaterThan(-1);
    for (const step of ['await materializeNotifications(', 'await _sweepCalendarIfEstablished(']) {
      expect(pass.lastIndexOf(step, call), `${step} must precede the heal`).toBeGreaterThan(cursor);
    }
    expect(pass.slice(call, pass.indexOf(');', call))).toContain('scanTo');
    // The lanes are never called directly from the pass.
    expect(pass).not.toContain('await refreshStubOffers(');
    expect(pass).not.toContain('await refreshStubLoans(');
  });

  it('the caught-up tail heals too, pinned to the cursor (#2382 r6)', () => {
    const quiet = pass.slice(at(pass, 'if (scanFrom > head) {'), at(pass, 'INSERT INTO indexer_cursor'));
    const call = at(quiet, 'await runHealLanes(');
    expect(call).toBeGreaterThan(at(quiet, 'await stampNotifiedWatermark('));
    expect(quiet.slice(call, quiet.indexOf(');', call))).toContain('lastBlock');
  });

  it('a new row is inserted marked for the pinned healer, its range unread (#2382 r6)', () => {
    const p = fn('async function processOfferLogs(');
    expect(p).toContain('is_stub, collateral_range_stale,');
    expect(p).toMatch(/\?, 0, 1, \?, \?, \?, \?, \?, \?\)`/);
  });

  it('has the match handler mark the borrower offer rather than read it', () => {
    const p = fn('async function processOfferLogs(');
    expect(p).toContain('borrowerFillsStale.add(Number(ev.borrowerOfferId))');
    expect(p).toContain('await markBorrowerFillsUnread(env, chainId, [...borrowerFillsStale])');
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
      meterEnv({ DB: h.d1 } as unknown as Env, budget) as unknown as Env, budget, AT);
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

describe('a completed read clears the marker (#2382 r4/r6)', () => {
  const read = async (h: ReturnType<typeof createSqliteD1>, answer: () => unknown) => {
    const budget = createBudget(1_000, 'test', 1_000);
    const seen: number[] = [];
    await refreshStubOffers(
      ({
        async readContract({ args }: { args: [bigint] }) {
          seen.push(Number(args[0]));
          return answer();
        },
      }) as never,
      '0x0' as never,
      84532,
      meterEnv({ DB: h.d1 } as unknown as Env, budget) as unknown as Env,
      budget,
      AT,
    );
    return seen;
  };

  it('a gone struct records a fill of 0 and clears the marker, so the row drops out', async () => {
    const h = createSqliteD1(migrations());
    seed(h, { offer_id: '1', status: 'cancelled', collateral_amount_max: '400', collateral_amount_filled: null });
    const zero = { creator: '0x0000000000000000000000000000000000000000' };
    expect(await read(h, () => zero)).toEqual([1]);
    expect(await read(h, () => zero)).toEqual([]);
    const r = h.db.prepare('SELECT collateral_amount_filled AS f, collateral_range_stale AS s FROM offers').get() as {
      f: string;
      s: number;
    };
    expect(r).toEqual({ f: '0', s: 0 });
  });

  it('a failed read leaves the marker set, so the row is tried again', async () => {
    const h = createSqliteD1(migrations());
    seed(h, { offer_id: '1' });
    const fail = () => {
      throw new Error('rpc dropped');
    };
    expect(await read(h, fail)).toEqual([1]);
    expect(await read(h, fail)).toEqual([1]);
  });
});

describe('heal reads are pinned to the settled scan block (#2382 r5)', () => {
  it('passes the pass’s scanTo to the details and ownerOf reads', async () => {
    const h = createSqliteD1(migrations());
    seed(h, { creator_current_owner: '0x00000000000000000000000000000000000000d0' });
    const blocks: Array<[string, unknown]> = [];
    const budget = createBudget(1_000, 'test', 1_000);
    await refreshStubOffers(
      ({
        async readContract({ functionName, blockNumber }: { functionName: string; blockNumber?: bigint }) {
          blocks.push([functionName, blockNumber]);
          if (functionName === 'getOfferDetails') {
            return {
              creator: '0x00000000000000000000000000000000000000c0', offerType: 1, principalLiquidity: 0,
              collateralLiquidity: 0, accepted: false, assetType: 0, collateralAssetType: 0,
              useFullTermInterest: false, creatorRiskAndTermsConsent: true, allowsPartialRepay: false,
              lendingAsset: '0x00000000000000000000000000000000000000a1', amount: 1n, interestRateBps: 1n,
              collateralAsset: '0x00000000000000000000000000000000000000b1', collateralAmount: 1n,
              durationDays: 1n, tokenId: 0n, positionTokenId: 5n, quantity: 0n, collateralTokenId: 0n,
              collateralQuantity: 0n, prepayAsset: '0x0000000000000000000000000000000000000000',
              amountMax: 1n, amountFilled: 0n, collateralAmountMax: 1n, collateralAmountFilled: 0n,
            };
          }
          return '0x00000000000000000000000000000000000000e0';
        },
      }) as never,
      '0x0' as never,
      84532,
      meterEnv({ DB: h.d1 } as unknown as Env, budget) as unknown as Env,
      budget,
      AT,
    );
    expect(blocks).toEqual([
      ['getOfferDetails', AT],
      ['ownerOf', AT],
    ]);
    // …and a completed read clears the marker.
    const r = h.db.prepare('SELECT collateral_range_stale AS s FROM offers').get() as { s: number };
    expect(r.s).toBe(0);
  });
});
