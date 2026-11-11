import { describe, expect, it } from 'vitest';
import { encodeAbiParameters, encodeEventTopics, type Log } from 'viem';
import { directOfferKey, buildAcceptTerms } from '../offers/acceptTerms';
import { SIGNED_OFFER } from './mySignedOrders';
import { signedFillFrom, storedOfferFromSigned } from './signedFill';
import type { SignedOrderWire } from './signedOrder';

type Hex = `0x${string}`;

const DIAMOND = '0x00000000000000000000000000000000000000dd' as Hex;
const WETH = '0x00000000000000000000000000000000000000a1';
const LIQ = '0x00000000000000000000000000000000000000b2';
const MAKER = '0x00000000000000000000000000000000000000c3';
const TAKER = '0x00000000000000000000000000000000000000d4' as Hex;
const ZERO = '0x0000000000000000000000000000000000000000';
const HASH = `0x${'cd'.repeat(32)}` as Hex;

function order(patch: Partial<SignedOrderWire> = {}): SignedOrderWire {
  return {
    offerType: '0',
    lendingAsset: WETH,
    amount: '100',
    amountMax: '0',
    interestRateBps: '625',
    interestRateBpsMax: '700',
    collateralAsset: LIQ,
    collateralAmount: '500',
    collateralAmountMax: '0',
    durationDays: '30',
    assetType: '0',
    collateralAssetType: '0',
    tokenId: '0',
    quantity: '0',
    collateralTokenId: '0',
    collateralQuantity: '0',
    prepayAsset: ZERO,
    allowsPartialRepay: true,
    allowsPrepayListing: false,
    allowsParallelSale: false,
    expiresAt: '2000',
    fillMode: '1',
    periodicInterestCadence: '1',
    refinanceTargetLoanId: '0',
    useFullTermInterest: false,
    creatorFull: false,
    creatorMaxCStar: '0',
    creatorAllowFullDowngrade: false,
    signer: MAKER,
    nonce: '7',
    deadline: '2000',
    ...patch,
  };
}

describe('the offer a signed order’s fill writes', () => {
  it('copies the terms, makes the signer its creator and collapses a zero ceiling to the floor', () => {
    const o = storedOfferFromSigned(order());
    expect(o).toMatchObject({
      id: 0n,
      creator: MAKER,
      amount: 100n,
      amountMax: 100n,
      collateralAmount: 500n,
      collateralAmountMax: 500n,
      interestRateBpsMax: 700n,
    });
    expect(o).toMatchObject({ allowsPartialRepay: true, periodicInterestCadence: 1, amountFilled: 0n, accepted: false });
    expect(storedOfferFromSigned(order({ amountMax: '150' })).amountMax).toBe(150n);
  });
  it('keys the taker’s signed terms by the order’s hash, never by an offer id', () => {
    const ctx = {
      acceptor: TAKER,
      linkedLoanId: 0n,
      riskTermsHash: HASH,
      nonce: 1n,
      deadline: 2n,
      illiquidLending: false,
      illiquidCollateral: false,
    };
    const offer = storedOfferFromSigned(order());
    expect(buildAcceptTerms(offer, { ...ctx, offerKey: HASH }).offerKey).toBe(HASH);
    // Without one, the stored-offer key applies (a stored offer's path).
    expect(buildAcceptTerms(offer, ctx).offerKey).toBe(directOfferKey(0n));
  });
});

describe('what a fill did, from its own log', () => {
  const filled = (orderHash: Hex, at: Hex = DIAMOND): Log =>
    ({
      address: at,
      topics: encodeEventTopics({ abi: SIGNED_OFFER, eventName: 'SignedOfferFilled', args: { orderHash, signer: MAKER, acceptor: TAKER } }),
      data: encodeAbiParameters([{ type: 'uint256' }, { type: 'uint256' }], [41n, 9n]),
    }) as unknown as Log;
  it('finds the offer and the loan the fill of this order wrote', () => {
    expect(signedFillFrom([filled(HASH)], DIAMOND, HASH)).toEqual({ offerId: 41n, loanId: 9n });
  });
  it('ignores another order’s fill and a log from another contract', () => {
    expect(signedFillFrom([filled(`0x${'ef'.repeat(32)}`)], DIAMOND, HASH)).toBeNull();
    expect(signedFillFrom([filled(HASH, '0x00000000000000000000000000000000000000ee')], DIAMOND, HASH)).toBeNull();
  });
});
