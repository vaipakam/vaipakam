import { getAddress } from 'viem';
import { describe, expect, it } from 'vitest';
import type { IndexerClient } from '../reads/world/indexerClient';
import { bookRowFrom, type BookRow } from '../offers/book';
import { BORROWER, LENDER, TLIQ, WETH } from '../offers/testOffer';
import { deskLadder, LADDER_PAGES, marketFrom, marketKey, openAmount, parseMarketKey, quoteRate, readMarketBook, readMarkets } from './markets';

const ZERO = '0x0000000000000000000000000000000000000000';
const MARKET = { lending: getAddress(WETH), collateral: getAddress(TLIQ), durationDays: 30 };

/** One `/offers/active` row (amounts as text), a lender's offer by default. */
function json(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
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
    prepayAsset: ZERO,
    expiresAt: 0,
    isSaleVehicle: false,
    isOffsetVehicle: false,
    refinanceTargetLoanId: 0,
    positionFlow: null,
    ...over,
  };
}

const row = (over: Record<string, unknown> = {}): BookRow => bookRowFrom(json(over));

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

describe('the market list', () => {
  it('reads each market, counts a row it cannot read, and says when the index cut the list', async () => {
    const ix = indexer([
      {
        markets: [
          {
            lendingAsset: WETH.toLowerCase(),
            collateralAsset: TLIQ.toLowerCase(),
            durationDays: 30,
            lenderOffers: 2,
            borrowerOffers: 1,
            bestAskBps: 500,
            bestBidBps: 450,
          },
          { lendingAsset: WETH, collateralAsset: TLIQ, durationDays: 0, lenderOffers: 1, borrowerOffers: 0, bestAskBps: 500, bestBidBps: null },
          { lendingAsset: 'nope', collateralAsset: TLIQ, durationDays: 7, lenderOffers: 1, borrowerOffers: 0, bestAskBps: 1, bestBidBps: null },
        ],
        truncated: true,
      },
    ]);
    const list = await readMarkets(ix, 84532);
    expect(ix.paths).toEqual(['/offers/markets?chainId=84532']);
    expect(list.truncated).toBe(true);
    expect(list.unread).toBe(2);
    expect(list.markets).toEqual([{ ...MARKET, lenderOffers: 2, borrowerOffers: 1, bestAskBps: 500n, bestBidBps: 450n }]);
  });

  it('keeps an empty side as unknown, never as a zero rate', () => {
    const m = marketFrom({
      lendingAsset: WETH,
      collateralAsset: TLIQ,
      durationDays: 30,
      lenderOffers: 0,
      borrowerOffers: 3,
      bestAskBps: null,
      bestBidBps: 700,
    });
    expect(m.bestAskBps).toBeNull();
    expect(m.bestBidBps).toBe(700n);
  });

  it('refuses an answer without a list rather than showing no markets', async () => {
    await expect(readMarkets(indexer([{ truncated: false }]), 1)).rejects.toThrow(/without a market list/);
  });

  it('round-trips a market through the page address and refuses anything else', () => {
    const key = marketKey(MARKET);
    expect(key).toBe(`${WETH.toLowerCase()}-${TLIQ.toLowerCase()}-30`);
    expect(parseMarketKey(key)).toEqual(MARKET);
    expect(parseMarketKey(null)).toBeNull();
    expect(parseMarketKey(`${WETH}-${TLIQ}-0`)).toBeNull();
    expect(parseMarketKey(`${WETH}-${TLIQ}`)).toBeNull();
    expect(parseMarketKey('junk')).toBeNull();
  });
});

describe('a market’s book', () => {
  it('asks the index for this market alone, without expired offers or vehicles, page after page', async () => {
    const ix = indexer([
      { offers: [json({ offerId: 9 }), { offerId: 'x' }], nextBefore: 9 },
      { offers: [json({ offerId: 4 })], nextBefore: null },
    ]);
    const book = await readMarketBook(ix, 84532, MARKET);
    expect(book.rows.map((r) => r.id)).toEqual([9n, 4n]);
    expect(book.unread).toBe(1);
    expect(book.more).toBe(false);
    const first = new URL(`https://x${ix.paths[0]}`);
    expect(first.pathname).toBe('/offers/active');
    expect(Object.fromEntries(first.searchParams)).toEqual({
      chainId: '84532',
      limit: '50',
      lendingAsset: WETH.toLowerCase(),
      collateralAsset: TLIQ.toLowerCase(),
      durationDays: '30',
      excludeExpired: '1',
      excludeSaleVehicles: '1',
      excludeOffsetVehicles: '1',
    });
    expect(new URL(`https://x${ix.paths[1]}`).searchParams.get('before')).toBe('9');
  });

  it('stops after its bounded number of pages and says there is more', async () => {
    const pages = Array.from({ length: LADDER_PAGES }, (_, i) => ({ offers: [json({ offerId: 100 - i })], nextBefore: 100 - i }));
    const ix = indexer(pages);
    const book = await readMarketBook(ix, 1, MARKET);
    expect(ix.paths).toHaveLength(LADDER_PAGES);
    expect(book.more).toBe(true);
  });
});

describe('the ladder', () => {
  it('quotes a lender at the floor and a borrower at the ceiling', () => {
    expect(quoteRate(row({ interestRateBps: 400, interestRateBpsMax: 900 }))).toBe(400n);
    expect(quoteRate(row({ offerType: 1, interestRateBps: 400, interestRateBpsMax: 900 }))).toBe(900n);
    // A borrower request without a range quotes its one rate.
    expect(quoteRate(row({ offerType: 1, interestRateBps: 400, interestRateBpsMax: 0 }))).toBe(400n);
  });

  it('counts only what is still open of an offer', () => {
    expect(openAmount(row({ amount: '1000', amountMax: '2000', amountFilled: '500' }))).toBe(1500n);
    expect(openAmount(row({ amount: '1000', amountMax: '0', amountFilled: '0' }))).toBe(1000n);
    expect(openAmount(row({ amount: '1000', amountMax: '1000', amountFilled: '1000' }))).toBe(0n);
  });

  it('groups offers by rate, best first on each side, with the derived middle', () => {
    const l = deskLadder(
      [
        row({ offerId: 1, interestRateBps: 600, amount: '100', amountMax: '100' }),
        row({ offerId: 2, interestRateBps: 500, amount: '100', amountMax: '300' }),
        row({ offerId: 3, interestRateBps: 500, amount: '50', amountMax: '50' }),
        row({ offerId: 4, offerType: 1, creator: BORROWER, interestRateBps: 300, interestRateBpsMax: 451, amount: '70', amountMax: '70' }),
        row({ offerId: 5, offerType: 1, creator: BORROWER, interestRateBps: 200, interestRateBpsMax: 300, amount: '10', amountMax: '10' }),
      ],
      MARKET,
      1_000,
    );
    expect(l.asks.map((s) => [s.rateBps, s.offers.map((o) => o.id), s.open])).toEqual([
      [500n, [2n, 3n], 350n],
      [600n, [1n], 100n],
    ]);
    expect(l.bids.map((s) => [s.rateBps, s.open])).toEqual([
      [451n, 70n],
      [300n, 10n],
    ]);
    expect(l.bestAskBps).toBe(500n);
    expect(l.bestBidBps).toBe(451n);
    // (500 + 451) / 2 = 475.5 bps, held exactly in tenths.
    expect(l.middleTenthBps).toBe(4755n);
    expect(l.crossed).toBe(false);
  });

  it('names a crossed ladder and gives no middle with one side empty', () => {
    const crossed = deskLadder(
      [row({ offerId: 1, interestRateBps: 400 }), row({ offerId: 2, offerType: 1, interestRateBps: 400, interestRateBpsMax: 400 })],
      MARKET,
      0,
    );
    expect(crossed.crossed).toBe(true);
    const oneSide = deskLadder([row({ offerId: 1 })], MARKET, 0);
    expect(oneSide.middleTenthBps).toBeNull();
    expect(oneSide.crossed).toBe(false);
  });

  it('leaves out, and counts by reason, every offer nobody can take at this market', () => {
    const l = deskLadder(
      [
        row({ offerId: 1, expiresAt: 500 }),
        row({ offerId: 2, durationDays: 7 }),
        row({ offerId: 3, collateralAssetType: 1 }),
        row({ offerId: 4, isSaleVehicle: true, offerType: 1 }),
        row({ offerId: 5, offerType: 1, refinanceTargetLoanId: 3, positionFlow: { movedSinceOpened: true } }),
        row({ offerId: 6, amount: '10', amountMax: '10', amountFilled: '10' }),
        row({ offerId: 7, expiresAt: 5_000 }),
      ],
      MARKET,
      1_000,
    );
    expect(l.leftOut).toEqual({ expired: 1, notThisMarket: 2, moved: 1, vehicle: 1, filled: 1 });
    expect(l.asks.flatMap((s) => s.offers.map((o) => o.id))).toEqual([7n]);
  });
});
