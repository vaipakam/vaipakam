import { describe, expect, it } from 'vitest';
import { canonicalOrderJson } from '@vaipakam/lib/signedOfferWire';
import { createIndexerClient } from '../reads/world/indexerClient';
import { bookSignedOrderFrom, makerCover, readMarketSignedBook, sortSides, standingRateBps, type BookSignedOrder } from './signedBook';
import { orderHashOf, type SignedOrderWire } from './signedOrder';

type Hex = `0x${string}`;

const WETH = '0x00000000000000000000000000000000000000a1';
const LIQ = '0x00000000000000000000000000000000000000b2';
const MAKER = '0x00000000000000000000000000000000000000c3';
const OTHER = '0x00000000000000000000000000000000000000d4';
const ZERO = '0x0000000000000000000000000000000000000000';
const SIG = `0x${'ab'.repeat(65)}`;
const market = { lending: WETH as Hex, collateral: LIQ as Hex, durationDays: 30 };

function order(patch: Partial<SignedOrderWire> = {}): SignedOrderWire {
  return {
    offerType: '0',
    lendingAsset: WETH,
    amount: '100000000000000000',
    amountMax: '100000000000000000',
    interestRateBps: '625',
    interestRateBpsMax: '625',
    collateralAsset: LIQ,
    collateralAmount: '500000000',
    collateralAmountMax: '500000000',
    durationDays: '30',
    assetType: '0',
    collateralAssetType: '0',
    tokenId: '0',
    quantity: '0',
    collateralTokenId: '0',
    collateralQuantity: '0',
    prepayAsset: ZERO,
    allowsPartialRepay: false,
    allowsPrepayListing: false,
    allowsParallelSale: false,
    expiresAt: '2000',
    fillMode: '1',
    periodicInterestCadence: '0',
    refinanceTargetLoanId: '0',
    useFullTermInterest: true,
    creatorFull: false,
    creatorMaxCStar: '0',
    creatorAllowFullDowngrade: false,
    signer: MAKER,
    nonce: '7',
    deadline: '2000',
    ...patch,
  };
}

function row(o: SignedOrderWire, signature: string = SIG) {
  return { orderHash: orderHashOf(o), signer: o.signer, order: JSON.parse(canonicalOrderJson(o)), signature, status: 'active', filledAmount: '0' };
}

const book = (o: SignedOrderWire): BookSignedOrder => ({ orderHash: orderHashOf(o), order: o, signature: SIG as Hex, replayPending: false });

describe('a market’s signed book, from the offer book', () => {
  it('keeps any maker’s order on this market with a readable signature, and nothing else', () => {
    expect(bookSignedOrderFrom(row(order()), market)).toEqual(book(order()));
    expect(bookSignedOrderFrom(row(order({ signer: OTHER })), market)).toEqual(book(order({ signer: OTHER })));
    expect(bookSignedOrderFrom(row(order(), '0x'), market)).toBeNull();
    expect(bookSignedOrderFrom(row(order(), `0x${'ab'.repeat(64)}`), market)).toBeNull();
    expect(bookSignedOrderFrom(row(order({ durationDays: '7' })), market)).toBeNull();
    expect(bookSignedOrderFrom({ ...row(order()), orderHash: `0x${'1'.repeat(64)}` }, market)).toBeNull();
  });

  it('stands a lender at its rate and a borrower at the higher of its two rates', () => {
    expect(standingRateBps(order({ interestRateBps: '500', interestRateBpsMax: '900' }))).toBe(500n);
    expect(standingRateBps(order({ offerType: '1', interestRateBps: '500', interestRateBpsMax: '900' }))).toBe(900n);
    expect(standingRateBps(order({ offerType: '1', interestRateBps: '700', interestRateBpsMax: '0' }))).toBe(700n);
  });

  it('puts the best rate for a taker first on each side, the book’s order kept between equal rates', () => {
    const a1 = book(order({ interestRateBps: '700', interestRateBpsMax: '700', nonce: '1' }));
    const a2 = book(order({ interestRateBps: '500', interestRateBpsMax: '500', nonce: '2' }));
    const a3 = book(order({ interestRateBps: '700', interestRateBpsMax: '700', nonce: '3' }));
    const b1 = book(order({ offerType: '1', interestRateBps: '400', interestRateBpsMax: '400', nonce: '4' }));
    const b2 = book(order({ offerType: '1', interestRateBps: '400', interestRateBpsMax: '800', nonce: '5' }));
    const sides = sortSides([a1, b1, a2, b2, a3]);
    expect(sides.asks.map((o) => o.order.nonce)).toEqual(['2', '1', '3']);
    expect(sides.bids.map((o) => o.order.nonce)).toEqual(['5', '4']);
  });

  it('asks the book for the whole market, not one signer, and counts what it could not read', async () => {
    const asked: string[] = [];
    const fetchImpl = (async (url: string) => {
      asked.push(url);
      const rows = [row(order()), row(order()), row(order({ signer: OTHER, offerType: '1' })), { junk: true }, row(order({ nonce: '9' }), '0x')];
      return new Response(JSON.stringify({ offers: rows, truncated: true, awaitingReplay: 3 }), { status: 200 });
    }) as unknown as typeof fetch;
    const got = await readMarketSignedBook(createIndexerClient('https://book.test', fetchImpl), 84532, market);
    expect(asked[0]).toContain('/signed-offers?chainId=84532&lendingAsset=0x');
    expect(asked[0]).not.toContain('signer=');
    expect(got).toEqual({ asks: [book(order())], bids: [book(order({ signer: OTHER, offerType: '1' }))], unread: 2, truncated: true, awaitingReplay: 3 });
  });

  it('reads the count of orders held back for a re-check: none when not sent, unknown when unreadable', async () => {
    const answer = (body: Record<string, unknown>) =>
      readMarketSignedBook(
        createIndexerClient(
          'https://book.test',
          (async () => new Response(JSON.stringify({ offers: [], ...body }), { status: 200 })) as unknown as typeof fetch,
        ),
        84532,
        market,
      );
    expect((await answer({})).awaitingReplay).toBe(0);
    expect((await answer({ awaitingReplay: 0 })).awaitingReplay).toBe(0);
    expect((await answer({ awaitingReplay: '2' })).awaitingReplay).toBeNull();
    expect((await answer({ awaitingReplay: -1 })).awaitingReplay).toBeNull();
    expect((await answer({ awaitingReplay: 1.5 })).awaitingReplay).toBeNull();
  });

  it('refuses an answer without an order list', async () => {
    const fetchImpl = (async () => new Response(JSON.stringify({ rows: [] }), { status: 200 })) as unknown as typeof fetch;
    await expect(readMarketSignedBook(createIndexerClient('https://book.test', fetchImpl), 84532, market)).rejects.toThrow('without an order list');
  });
});

describe('the maker’s vault against a fill', () => {
  const lend = order();
  const borrow = order({ offerType: '1' });

  it('weighs what a fill of the rest would draw against what the vault holds free', () => {
    expect(makerCover(lend, 'open', 0n, 10n ** 17n)).toEqual({ kind: 'covers', need: 10n ** 17n, free: 10n ** 17n });
    expect(makerCover(lend, 'open', 0n, 10n ** 16n)).toEqual({ kind: 'short', need: 10n ** 17n, free: 10n ** 16n });
    // A part-filled lender order needs only the principal left.
    expect(makerCover(lend, 'partly-filled', 6n * 10n ** 16n, 4n * 10n ** 16n)).toEqual({ kind: 'covers', need: 4n * 10n ** 16n, free: 4n * 10n ** 16n });
    // A borrower order draws collateral.
    expect(makerCover(borrow, 'open', 0n, 499_999_999n)).toEqual({ kind: 'short', need: 500_000_000n, free: 499_999_999n });
  });

  it('says it could not tell when the vault was not read, and weighs nothing that cannot be filled', () => {
    expect(makerCover(lend, 'open', 0n, null)).toEqual({ kind: 'unread' });
    expect(makerCover(lend, 'open', 0n, undefined)).toEqual({ kind: 'unread' });
    for (const s of ['used', 'nonce-cancelled', 'lapsed', 'unread'] as const) expect(makerCover(lend, s, 0n, 10n ** 18n)).toEqual({ kind: 'none' });
  });
});
