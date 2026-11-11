import { describe, expect, it } from 'vitest';
import { encodeAbiParameters, encodeEventTopics, keccak256, type Log } from 'viem';
import { canonicalOrderJson } from '@vaipakam/lib/signedOfferWire';
import { cancelCall, measureSignedCancel, orderSentence, signedCancelBlockers, signedCancelReceipt, targetKey, type SignedCancelReview } from './cancelSigned';
import { mySignedOrderFrom, readMySignedOrders, sharedNonces, SIGNED_OFFER, standingOf, type MySignedOrder } from './mySignedOrders';
import { lapsesAt, orderHashOf, signedStake, SIGNED_OFFER_TYPES, typedMessage, type SignedOrderWire } from './signedOrder';
import { createIndexerClient } from '../reads/world/indexerClient';

type Hex = `0x${string}`;

const WETH = '0x00000000000000000000000000000000000000a1';
const LIQ = '0x00000000000000000000000000000000000000b2';
const ME = '0x00000000000000000000000000000000000000c3';
const OTHER = '0x00000000000000000000000000000000000000d4';
const DIAMOND = '0x00000000000000000000000000000000000000e5' as Hex;
const ZERO = '0x0000000000000000000000000000000000000000';
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
    signer: ME,
    nonce: '7',
    deadline: '2000',
    ...patch,
  };
}

/** A book row as the offer book serves it: the canonical text, parsed. */
function row(o: SignedOrderWire, hash: string = orderHashOf(o)) {
  return { orderHash: hash, signer: o.signer, order: JSON.parse(canonicalOrderJson(o)), signature: '0x', status: 'active', filledAmount: '0' };
}

const mine = (o: SignedOrderWire): MySignedOrder => ({ orderHash: orderHashOf(o), order: o });

const copy = {
  text: (k: string) => k,
  format: (k: string, v: Record<string, string>) => `${k}(${Object.values(v).join(',')})`,
};

describe('the signed order', () => {
  it('hashes as the EIP-712 struct of all 31 fields, in the contract’s order', () => {
    const names = SIGNED_OFFER_TYPES.SignedOffer.map((f) => `${f.type} ${f.name}`).join(',');
    const typeHash = keccak256(new TextEncoder().encode(`SignedOffer(${names})`));
    const o = order();
    const m = typedMessage(o);
    const manual = keccak256(
      encodeAbiParameters([{ type: 'bytes32' }, ...SIGNED_OFFER_TYPES.SignedOffer], [
        typeHash,
        ...SIGNED_OFFER_TYPES.SignedOffer.map((f) => m[f.name]),
      ] as never),
    );
    expect(orderHashOf(o)).toBe(manual);
    expect(orderHashOf(order({ nonce: '8' }))).not.toBe(manual);
  });

  it('a fill draws the whole amount for a lender and the whole collateral for a borrower', () => {
    expect(signedStake(order())).toEqual({ asset: WETH, amount: 10n ** 17n });
    expect(signedStake(order({ amountMax: '0' }))).toEqual({ asset: WETH, amount: 10n ** 17n });
    expect(signedStake(order({ offerType: '1', collateralAmountMax: '600000000' }))).toEqual({ asset: LIQ, amount: 600_000_000n });
    expect(signedStake(order({ offerType: '1', collateralAmountMax: '0' }))).toEqual({ asset: LIQ, amount: 500_000_000n });
  });

  it('lapses at the earlier of its expiry and its deadline, or never', () => {
    expect(lapsesAt(order({ expiresAt: '3000', deadline: '2500' }))).toBe(2500);
    expect(lapsesAt(order({ expiresAt: '0', deadline: '2500' }))).toBe(2500);
    expect(lapsesAt(order({ expiresAt: '0', deadline: '0' }))).toBeNull();
  });
});

describe('your signed orders, from the offer book', () => {
  it('keeps a row only when it is your own order on this market and its hash is the order’s own', () => {
    expect(mySignedOrderFrom(row(order()), ME, market)).toEqual(mine(order()));
    expect(mySignedOrderFrom(row(order(), `0x${'1'.repeat(64)}`), ME, market)).toBeNull();
    expect(mySignedOrderFrom(row(order({ signer: OTHER })), ME, market)).toBeNull();
    expect(mySignedOrderFrom(row(order({ durationDays: '7' })), ME, market)).toBeNull();
    expect(mySignedOrderFrom(row(order({ collateralAsset: OTHER })), ME, market)).toBeNull();
    // Not the book's wire form: an extra field, an address not lowercased.
    expect(mySignedOrderFrom({ ...row(order()), order: { ...row(order()).order, extra: 1 } }, ME, market)).toBeNull();
    expect(
      mySignedOrderFrom({ ...row(order()), order: { ...row(order()).order, lendingAsset: WETH.toUpperCase().replace('0X', '0x') } }, ME, market),
    ).toBeNull();
    expect(mySignedOrderFrom(null, ME, market)).toBeNull();
  });

  it('asks the book scoped to the signer and counts what it could not read', async () => {
    const asked: string[] = [];
    const fetchImpl = (async (url: string) => {
      asked.push(url);
      return new Response(JSON.stringify({ offers: [row(order()), row(order()), row(order({ signer: OTHER })), { junk: true }], truncated: true }), {
        status: 200,
      });
    }) as unknown as typeof fetch;
    const got = await readMySignedOrders(createIndexerClient('https://book.test', fetchImpl), 84532, market, ME as Hex);
    expect(asked[0]).toContain('/signed-offers?chainId=84532&lendingAsset=0x');
    expect(asked[0]).toContain(`signer=${ME}`);
    expect(got).toEqual({ orders: [mine(order())], unread: 2, truncated: true });
  });

  it('refuses an answer without an order list', async () => {
    const fetchImpl = (async () => new Response(JSON.stringify({ rows: [] }), { status: 200 })) as unknown as typeof fetch;
    await expect(readMySignedOrders(createIndexerClient('https://book.test', fetchImpl), 84532, market, ME as Hex)).rejects.toThrow('without an order list');
  });
});

describe('where the chain stands', () => {
  it('a used hash, then a cancelled nonce, then the lapse, in that order', () => {
    expect(standingOf(order(), 1n, true, 9999)).toBe('used');
    expect(standingOf(order(), 0n, true, 9999)).toBe('nonce-cancelled');
    expect(standingOf(order(), 0n, false, 2001)).toBe('lapsed');
    expect(standingOf(order(), 0n, false, 2000)).toBe('open');
    expect(standingOf(order(), null, false, 1)).toBe('unread');
  });

  it('groups only open orders that share a nonce', () => {
    const a = mine(order());
    const b = mine(order({ interestRateBps: '700', interestRateBpsMax: '700' }));
    const c = mine(order({ nonce: '9' }));
    const open = new Map([a, b, c].map((o) => [o.orderHash, 'open' as const]));
    expect([...sharedNonces([a, b, c], open)]).toEqual([['7', [a, b]]]);
    expect(sharedNonces([a, b, c], new Map([...open, [b.orderHash, 'used' as const]])).size).toBe(0);
  });
});

describe('the on-chain cancel', () => {
  const o = mine(order());
  const review = (patch: Partial<SignedCancelReview> = {}): SignedCancelReview => ({
    identity: 'id',
    target: { kind: 'order', order: o },
    standings: { [o.orderHash]: 'open' },
    paused: false,
    dryRun: null,
    readAt: 1,
    ...patch,
  });

  it('sends the order itself, or the nonce', () => {
    expect(cancelCall({ kind: 'order', order: o })).toEqual({ functionName: 'cancelSignedOffer', args: [typedMessage(o.order)] });
    expect(cancelCall({ kind: 'nonce', nonce: '7', orders: [o] })).toEqual({ functionName: 'invalidateSignedOfferNonce', args: [7n] });
    expect(targetKey({ kind: 'nonce', nonce: '7', orders: [o] })).toBe('nonce:7');
  });

  it('states the first thing in the way', () => {
    expect(signedCancelBlockers(review(), OTHER as Hex, copy)).toEqual(['signedCancel.notSigner']);
    expect(signedCancelBlockers(review({ standings: {} }), ME as Hex, copy)).toEqual(['signedCancel.unread']);
    expect(signedCancelBlockers(review({ standings: { [o.orderHash]: 'used' } }), ME as Hex, copy)).toEqual(['signedCancel.used']);
    expect(signedCancelBlockers(review({ standings: { [o.orderHash]: 'lapsed' } }), ME as Hex, copy)).toEqual(['signedCancel.lapsed']);
    expect(signedCancelBlockers(review({ target: { kind: 'nonce', nonce: '7', orders: [o] }, standings: { [o.orderHash]: 'used' } }), ME as Hex, copy)).toEqual(
      ['signedCancel.nonceNothingOpen'],
    );
    expect(signedCancelBlockers(review({ paused: true }), ME as Hex, copy)).toEqual(['signedCancel.paused']);
    expect(signedCancelBlockers(review({ dryRun: 'unread' }), ME as Hex, copy)).toEqual(['signedCancel.dryRunUnread']);
    expect(signedCancelBlockers(review(), ME as Hex, copy)).toEqual([]);
  });

  it('says it moves nothing, that it is the only way, and the race', () => {
    const r = signedCancelReceipt(review(), (_a, v) => v.toString(), copy);
    expect(r.prompts).toBe(1);
    expect(r.rows.map((x) => x.label)).toEqual(['signedCancel.rowOrder', 'signedCancel.rowLapses', 'signedCancel.rowDoes', 'signedCancel.rowMoves']);
    expect(r.consequences).toEqual(['signedCancel.onlyWay', 'signedCancel.race', 'signedCancel.stake(100000000000000000)']);
  });

  it('measures the cancel from the transaction’s own logs', () => {
    const log = (eventName: 'SignedOfferCancelled' | 'SignedOfferNonceBurned', args: Record<string, unknown>, data: Hex = '0x', address: Hex = DIAMOND) =>
      ({ address, topics: encodeEventTopics({ abi: SIGNED_OFFER, eventName, args } as never), data }) as unknown as Log;
    const cancelled = log('SignedOfferCancelled', { orderHash: o.orderHash, signer: ME });
    expect(measureSignedCancel(review(), [cancelled], DIAMOND, ME as Hex, copy)).toEqual([{ status: 'done', label: 'signedCancel.legOrder' }]);
    // Another contract's log, or another order's, is not this cancel.
    expect(
      measureSignedCancel(review(), [log('SignedOfferCancelled', { orderHash: o.orderHash, signer: ME }, '0x', OTHER as Hex)], DIAMOND, ME as Hex, copy)[0]!
        .status,
    ).toBe('not-done');
    const burned = log('SignedOfferNonceBurned', { signer: ME }, encodeAbiParameters([{ type: 'uint256' }], [7n]));
    expect(measureSignedCancel(review({ target: { kind: 'nonce', nonce: '7', orders: [o] } }), [burned], DIAMOND, ME as Hex, copy)).toEqual([
      { status: 'done', label: 'signedCancel.legNonce' },
    ]);
    expect(measureSignedCancel(review({ target: { kind: 'nonce', nonce: '8', orders: [o] } }), [burned], DIAMOND, ME as Hex, copy)[0]!.status).toBe('not-done');
  });
});

describe('the order sentence', () => {
  const words = (_a: Hex, v: bigint) => v.toString();
  it('states an exact order as single figures', () => {
    expect(orderSentence(order(), words, copy)).toBe('signedOrders.lend(100000000000000000,6.25,30,500000000)');
  });
  it('states both ends of every range a signed order allows, low to high', () => {
    const bid = order({
      offerType: '1',
      amount: '50',
      amountMax: '80',
      interestRateBps: '500',
      interestRateBpsMax: '700',
      collateralAmount: '9',
      collateralAmountMax: '12',
    });
    expect(orderSentence(bid, words, copy)).toBe('signedOrders.borrow(signedOrders.range(50,80),signedOrders.range(5,7),30,signedOrders.range(9,12))');
    // A zero upper bound means no range: the single figure stands.
    expect(orderSentence(order({ amountMax: '0' }), words, copy)).toContain('signedOrders.lend(100000000000000000,');
  });
});
