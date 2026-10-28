/**
 * #1849 — the one derivation of the lender's instant-sale candidates,
 * shared by the exit chooser and the sale tool. Pins the three answers
 * apart (loading, cannot-state, a list) and the facet's admission rules.
 */
import { describe, expect, it } from 'vitest';
import type { LoanLive } from '../contracts/loanLive';
import type { IndexedOffer } from './indexer';
import {
  instantSellCandidatesOf,
  instantSellVerdict,
  type InstantSellInput,
} from './instantSellCandidates';

const DAY = 86_400n;
const LEND = '0x00000000000000000000000000000000000000a1';
const COLL = '0x00000000000000000000000000000000000000c1';
const PREPAY = '0x00000000000000000000000000000000000000d1';
const ME = '0x00000000000000000000000000000000000000e1';
const PRINCIPAL = 1_000n * 10n ** 18n;

/** A 30-day 10% loan started at t=1000, read 10 days in: 20 days remain. */
const START = 1_000n;
const NOW = START + 10n * DAY;
const live = {
  principal: PRINCIPAL,
  interestRateBps: 1_000n,
  startTime: START,
  durationDays: 30n,
  interestAccrualStart: 0n,
  interestRemainingDays: 0,
  interestSettled: 0n,
  useFullTermInterest: false,
  sellerClaimOnSale: 0n,
  readAtTimestamp: NOW,
  collateralAssetType: 0,
  collateralAmount: 2_000n * 10n ** 18n,
  prepayAsset: PREPAY,
  pauseLog: [] as LoanLive['pauseLog'],
} as unknown as LoanLive;

let nextId = 1;
function offer(over: Partial<IndexedOffer> = {}): IndexedOffer {
  return {
    offerId: nextId++,
    offerType: 0,
    assetType: 0,
    amount: PRINCIPAL.toString(),
    amountMax: '0',
    amountFilled: '0',
    lendingAsset: LEND,
    collateralAsset: COLL,
    collateralAssetType: 0,
    prepayAsset: PREPAY,
    durationDays: 30,
    collateralAmount: (1_500n * 10n ** 18n).toString(),
    interestRateBps: 900,
    creator: '0x00000000000000000000000000000000000000b1',
    ...over,
  } as IndexedOffer;
}

function input(over: Partial<InstantSellInput> = {}): InstantSellInput {
  return {
    offers: [],
    offersFailed: false,
    address: ME,
    row: { lendingAsset: LEND, collateralAsset: COLL },
    live,
    chainNow: NOW,
    ...over,
  };
}

describe('instantSellCandidatesOf — the three answers', () => {
  it('is undefined while the offer read is in flight', () => {
    expect(instantSellCandidatesOf(input({ offers: undefined }))).toBeUndefined();
  });

  it('is null, not loading, when the offer read threw', () => {
    expect(
      instantSellCandidatesOf(input({ offers: undefined, offersFailed: true })),
    ).toBeNull();
  });

  it('is null when a refetch failed behind a cached answer', () => {
    // TanStack keeps the last success beside isError: an empty book from
    // before the failure must not read as "no offer matches" now.
    expect(instantSellCandidatesOf(input({ offers: [], offersFailed: true }))).toBeNull();
    expect(
      instantSellCandidatesOf(input({ offers: [offer()], offersFailed: true })),
    ).toBeNull();
  });

  it('is null when the indexer is unavailable', () => {
    expect(instantSellCandidatesOf(input({ offers: null }))).toBeNull();
  });

  it('is null, never [], when the interest ledger is unreadable', () => {
    const noWindow = { ...live, sellerClaimOnSale: undefined } as LoanLive;
    // Even with matching offers in hand: no candidate can be priced.
    expect(
      instantSellCandidatesOf(input({ live: noWindow, offers: [offer()] })),
    ).toBeNull();
    // And even while the offers are still loading.
    expect(
      instantSellCandidatesOf(input({ live: noWindow, offers: undefined })),
    ).toBeNull();
  });

  it('is [] when the market has no compatible offer', () => {
    expect(instantSellCandidatesOf(input({ offers: [] }))).toEqual([]);
  });
});

describe('instantSellCandidatesOf — admission rules', () => {
  it('keeps a compatible offer', () => {
    const o = offer();
    expect(instantSellCandidatesOf(input({ offers: [o] }))).toEqual([o]);
  });

  it.each([
    ['a borrower offer', { offerType: 1 }],
    ['an NFT offer', { assetType: 1 }],
    ['a range offer', { amountMax: (PRINCIPAL * 2n).toString() }],
    ['a partly filled offer', { amountFilled: '1' }],
    ['another lending asset', { lendingAsset: '0x00000000000000000000000000000000000000a2' }],
    ['another collateral asset', { collateralAsset: '0x00000000000000000000000000000000000000c2' }],
    ['another collateral type', { collateralAssetType: 1 }],
    ['another prepay asset', { prepayAsset: '0x00000000000000000000000000000000000000d2' }],
    ['a duration shorter than the remaining term', { durationDays: 19 }],
    ['more collateral than pledged', { collateralAmount: (3_000n * 10n ** 18n).toString() }],
    ['an amount above the principal', { amount: (PRINCIPAL + 1n).toString() }],
    ['an amount below the principal', { amount: (PRINCIPAL - 1n).toString() }],
    ['an expired offer', { expiresAt: Number(NOW) }],
    ['the seller’s own offer', { creator: ME.toUpperCase().replace('0X', '0x') }],
    ['a rate whose shortfall exceeds the principal', { interestRateBps: 1_000_000 }],
  ])('drops %s', (_label, over) => {
    expect(
      instantSellCandidatesOf(input({ offers: [offer(over as Partial<IndexedOffer>)] })),
    ).toEqual([]);
  });

  it('keeps an offer whose duration exactly covers the remaining term', () => {
    const o = offer({ durationDays: 20 });
    expect(instantSellCandidatesOf(input({ offers: [o] }))).toEqual([o]);
  });

  it('has nothing to sell at or past maturity', () => {
    expect(
      instantSellCandidatesOf(
        input({ offers: [offer({ durationDays: 365 })], chainNow: START + 30n * DAY }),
      ),
    ).toEqual([]);
  });

  it('lists the best payout (lowest rate) first', () => {
    const high = offer({ interestRateBps: 1_200 });
    const low = offer({ interestRateBps: 800 });
    const mid = offer({ interestRateBps: 1_000 });
    expect(
      instantSellCandidatesOf(input({ offers: [high, low, mid] }))?.map(
        (o) => o.offerId,
      ),
    ).toEqual([low.offerId, mid.offerId, high.offerId]);
  });

  it('lists nothing without a connected wallet', () => {
    expect(
      instantSellCandidatesOf(input({ offers: [offer()], address: undefined })),
    ).toEqual([]);
  });
});

describe('instantSellVerdict', () => {
  it('maps each answer to the chooser state it promises', () => {
    expect(instantSellVerdict(undefined)).toBe('checking');
    expect(instantSellVerdict(null)).toBe('unknown');
    expect(instantSellVerdict([])).toBe('none');
    expect(instantSellVerdict([offer()])).toBe('some');
  });
});
