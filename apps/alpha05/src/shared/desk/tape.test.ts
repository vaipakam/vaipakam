import { getAddress } from 'viem';
import { describe, expect, it } from 'vitest';
import type { IndexerClient } from '../reads/world/indexerClient';
import { IndexerUnavailable } from '../reads/world/indexerClient';
import { bookRowFrom } from '../offers/book';
import { BORROWER, LENDER, TLIQ, WETH } from '../offers/testOffer';
import { deskLadder, ownOrders } from './markets';
import { candleFrom, fillFrom, parsePeriod, readCandles, readTape, runs, TAPE_LIMIT, type Candle } from './tape';

const MARKET = { lending: getAddress(WETH), collateral: getAddress(TLIQ), durationDays: 30 };
const SCOPE = {
  lendingAsset: WETH.toLowerCase(),
  collateralAsset: TLIQ.toLowerCase(),
  durationDays: 30,
  placement: 'agreed-terms-backed',
  excludeSaleVehicles: true,
};
const UNPLACED = { count: 0, capped: false };

function loan(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    loanId: 7,
    lendingAsset: WETH.toLowerCase(),
    collateralAsset: TLIQ.toLowerCase(),
    marketDurationDays: 30,
    initRateBps: 520,
    initPrincipal: '50000000000000000',
    // The live terms, which a repayment or an extension rewrites; the tape
    // never reads them.
    interestRateBps: 900,
    principal: '1',
    durationDays: 60,
    startAt: 1_000,
    isSaleVehicle: false,
    ...over,
  };
}

function indexer(answers: unknown[]): IndexerClient & { paths: string[] } {
  const paths: string[] = [];
  return {
    origin: 'https://index.test',
    paths,
    getJson: async <T>(path: string) => {
      paths.push(path);
      const a = answers.shift();
      if (a instanceof Error) throw a;
      return a as T;
    },
  };
}

describe('the fills tape (OFF-75)', () => {
  it('reads the terms agreed at opening, never the live terms', () => {
    const f = fillFrom(loan(), MARKET);
    expect(f).toEqual({ loanId: 7n, startAt: 1_000, rateBps: 520n, principal: 50_000_000_000_000_000n });
  });

  it('keeps a fill whose amount the index has not confirmed, with no amount', () => {
    expect(fillFrom(loan({ initPrincipal: null }), MARKET).principal).toBeNull();
  });

  it('refuses a row that is not this market’s fill', () => {
    expect(() => fillFrom(loan({ isSaleVehicle: true }), MARKET)).toThrow();
    expect(() => fillFrom(loan({ marketDurationDays: null }), MARKET)).toThrow();
    expect(() => fillFrom(loan({ marketDurationDays: 14 }), MARKET)).toThrow();
    expect(() => fillFrom(loan({ collateralAsset: WETH }), MARKET)).toThrow();
    expect(() => fillFrom(loan({ initRateBps: null }), MARKET)).toThrow();
  });

  it('asks for the market’s loans without sale bookkeeping, newest first, and counts what it could not read', async () => {
    const ix = indexer([
      {
        loans: [loan({ loanId: 3, startAt: 500 }), loan({ loanId: 9, startAt: 2_000 }), loan({ loanId: 4, marketDurationDays: 14 })],
        scope: SCOPE,
        unplaced: { count: 2, capped: false },
        nextBefore: null,
      },
    ]);
    const t = await readTape(ix, 84532, MARKET);
    expect(ix.paths[0]).toContain('/loans/recent?');
    expect(ix.paths[0]).toContain(`limit=${TAPE_LIMIT + 1}`);
    expect(ix.paths[0]).toContain('durationDays=30');
    expect(ix.paths[0]).toContain('excludeSaleVehicles=1');
    expect(t.fills.map((f) => f.loanId)).toEqual([9n, 3n]);
    expect(t.unread).toBe(1);
    expect(t.unplaced).toEqual({ count: 2, capped: false });
    expect(t.more).toBe(false);
  });

  it('says older loans exist only when the index returns a row past the page', async () => {
    const loans = Array.from({ length: TAPE_LIMIT + 1 }, (_, i) => loan({ loanId: 100 - i }));
    const t = await readTape(indexer([{ loans, scope: SCOPE, unplaced: UNPLACED, nextBefore: 80 }]), 84532, MARKET);
    expect(t.more).toBe(true);
    expect(t.fills).toHaveLength(TAPE_LIMIT);
    expect(t.fills[TAPE_LIMIT - 1]!.loanId).toBe(BigInt(100 - TAPE_LIMIT + 1));
  });

  it('does not claim older loans when the page is exactly full, even with a cursor', async () => {
    const loans = Array.from({ length: TAPE_LIMIT }, (_, i) => loan({ loanId: 100 - i }));
    const t = await readTape(indexer([{ loans, scope: SCOPE, unplaced: UNPLACED, nextBefore: 81 }]), 84532, MARKET);
    expect(t.more).toBe(false);
    expect(t.fills).toHaveLength(TAPE_LIMIT);
  });

  it('refuses an answer not scoped to the market, and one with no count of unplaced loans', async () => {
    await expect(readTape(indexer([{ loans: [], scope: { ...SCOPE, durationDays: 14 }, unplaced: UNPLACED }]), 84532, MARKET)).rejects.toBeInstanceOf(
      IndexerUnavailable,
    );
    await expect(readTape(indexer([{ loans: [], scope: { ...SCOPE, excludeSaleVehicles: false }, unplaced: UNPLACED }]), 84532, MARKET)).rejects.toBeInstanceOf(
      IndexerUnavailable,
    );
    await expect(readTape(indexer([{ loans: [], scope: SCOPE }]), 84532, MARKET)).rejects.toBeInstanceOf(IndexerUnavailable);
  });
});

function bucket(over: Record<string, unknown> = {}): Record<string, unknown> {
  return { t: 3_600, open: 500, high: 550, low: 480, close: 520, fills: 3, principalTotal: '90000', unrecordedPrincipalFills: 1, ...over };
}

describe('the executed-rate chart (OFF-75)', () => {
  it('reads a period, and refuses one whose first or last rate lies outside its range or that saw no loan', () => {
    expect(candleFrom(bucket())).toEqual({ t: 3_600, open: 500n, high: 550n, low: 480n, close: 520n, fills: 3, principalTotal: 90_000n, unrecorded: 1 });
    expect(() => candleFrom(bucket({ close: 600 }))).toThrow();
    expect(() => candleFrom(bucket({ fills: 0 }))).toThrow();
    expect(() => candleFrom(bucket({ principalTotal: 9e21 }))).toThrow();
  });

  it('asks the index for the period’s step and range, oldest period first', async () => {
    const ix = indexer([{ buckets: [bucket({ t: 7_200 }), bucket({ t: 3_600 }), { t: 'x' }], unplaced: UNPLACED, truncated: true }]);
    const c = await readCandles(ix, 84532, MARKET, '7d');
    expect(ix.paths[0]).toContain('/loans/rate-candles?');
    expect(ix.paths[0]).toContain('interval=1h');
    expect(ix.paths[0]).toContain('range=7d');
    expect(c.candles.map((x) => x.t)).toEqual([3_600, 7_200]);
    expect(c.unread).toBe(1);
    expect(c.truncated).toBe(true);
    expect(c.partial).toBe(false);
    expect(c.stepSec).toBe(3_600);
  });

  it('says the only period is partial when the read ended inside it', async () => {
    const c = await readCandles(indexer([{ buckets: [bucket({ t: 3_600 })], unplaced: UNPLACED, truncated: true }]), 84532, MARKET, '7d');
    expect(c.partial).toBe(true);
    const whole = await readCandles(indexer([{ buckets: [bucket({ t: 3_600 })], unplaced: UNPLACED, truncated: false }]), 84532, MARKET, '7d');
    expect(whole.partial).toBe(false);
  });

  it('joins only periods that follow one another, so an empty period stays a gap', () => {
    const at = (t: number) => ({ t }) as Candle;
    const r = runs([at(0), at(10), at(20), at(40), at(60), at(70)], 10);
    expect(r.map((run) => run.map((c) => c.t))).toEqual([[0, 10, 20], [40], [60, 70]]);
  });

  it('opens on 30 days unless the address names a served period', () => {
    expect(parsePeriod(null)).toBe('30d');
    expect(parsePeriod('all')).toBe('all');
    expect(parsePeriod('1y')).toBe('30d');
  });
});

describe('your open offers on the ladder (OFF-75)', () => {
  const json = (over: Record<string, unknown>) => ({
    offerId: 12,
    status: 'active',
    creator: LENDER,
    offerType: 0,
    lendingAsset: WETH,
    collateralAsset: TLIQ,
    assetType: 0,
    collateralAssetType: 0,
    tokenId: '0',
    collateralTokenId: '0',
    collateralQuantity: '0',
    quantity: '0',
    amount: '1000',
    amountMax: '2000',
    amountFilled: '0',
    interestRateBps: 500,
    interestRateBpsMax: 500,
    collateralAmount: '5000',
    durationDays: 30,
    prepayAsset: '0x0000000000000000000000000000000000000000',
    expiresAt: 0,
    isSaleVehicle: false,
    isOffsetVehicle: false,
    refinanceTargetLoanId: 0,
    positionFlow: null,
    ...over,
  });

  it('lists only the viewer’s offers, with what was taken of the most it can lend', () => {
    const rows = [
      bookRowFrom(json({ offerId: 1, amountFilled: '500' })),
      bookRowFrom(json({ offerId: 2, creator: BORROWER, offerType: 1, interestRateBps: 400, interestRateBpsMax: 450 })),
      bookRowFrom(json({ offerId: 3, creator: BORROWER, interestRateBps: 600, interestRateBpsMax: 600 })),
    ];
    const l = deskLadder(rows, MARKET, 0);
    expect(ownOrders(l, LENDER.toUpperCase().replace('0X', '0x'))).toEqual([{ id: 1n, lender: true, rateBps: 500n, total: 2000n, taken: 500n, open: 1500n }]);
    expect(ownOrders(l, BORROWER).map((o) => [o.id, o.lender, o.rateBps])).toEqual([
      [3n, true, 600n],
      [2n, false, 450n],
    ]);
  });

  it('leaves out an offer the ladder left out', () => {
    const l = deskLadder([bookRowFrom(json({ offerId: 1, amountFilled: '2000' }))], MARKET, 0);
    expect(ownOrders(l, LENDER)).toEqual([]);
  });
});
