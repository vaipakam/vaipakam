import { describe, expect, it } from 'vitest';
import type { StoredOffer } from './acceptTerms';
import { IndexerUnavailable, type IndexerClient } from '../reads/world/indexerClient';
import { gapOf, MATCH_CODE, optionGap, readNearestIndex, whyOf, type Counterparty, type WhyRead } from './whyNotMatching';

type Hex = `0x${string}`;
const lending: Hex = '0x00000000000000000000000000000000000000aa';
const collateral: Hex = '0x00000000000000000000000000000000000000bb';

function offer(over: Partial<StoredOffer> = {}): StoredOffer {
  return {
    id: 1n,
    creator: '0x00000000000000000000000000000000000000cc',
    offerType: 0,
    assetType: 0,
    collateralAssetType: 0,
    lendingAsset: lending,
    collateralAsset: collateral,
    amount: 1_000n,
    amountMax: 1_000n,
    amountFilled: 0n,
    interestRateBps: 700n,
    interestRateBpsMax: 700n,
    collateralAmount: 4_000n,
    collateralAmountMax: 4_000n,
    collateralAmountFilled: 0n,
    durationDays: 30n,
    tokenId: 0n,
    collateralTokenId: 0n,
    quantity: 0n,
    collateralQuantity: 0n,
    prepayAsset: lending,
    useFullTermInterest: true,
    allowsPartialRepay: false,
    allowsPrepayListing: false,
    allowsParallelSale: false,
    refinanceTargetLoanId: 0n,
    parallelSaleOrderHash: '0x00',
    periodicInterestCadence: 0,
    expiresAt: 0n,
    accepted: false,
    creatorFull: false,
    ...over,
  } as StoredOffer;
}

const mine = offer({ id: 1n, offerType: 0, interestRateBps: 700n, interestRateBpsMax: 700n });
const req = (over: Partial<StoredOffer> = {}) => offer({ id: 2n, offerType: 1, interestRateBps: 400n, interestRateBpsMax: 600n, ...over });
// rank -1 takes the counterparty's place in the list given to `read`.
const cp = (o: StoredOffer, code: number | null, state: Counterparty['state'] = 'open', matchRateBps: bigint | null = null, rank = -1): Counterparty => ({
  rank,
  offer: o,
  state,
  code,
  matchRateBps,
});
const read = (counterparties: Counterparty[], switchOn: boolean | null = true, me: StoredOffer = mine): WhyRead => ({
  block: 1n,
  mine: me,
  switchOn,
  counterparties: counterparties.map((c, i) => (c.rank < 0 ? { ...c, rank: i } : c)),
  unread: 0,
});
const ranked = (n: number, oppositeOpen = n) => ({ kind: 'ranked' as const, ids: Array.from({ length: n }, (_, i) => BigInt(i + 2)), oppositeOpen });

function indexer(body: unknown): IndexerClient {
  return { origin: 'https://x', getJson: async () => body as never };
}

describe('why an offer is not matching (#3623)', () => {
  it('names the rate gap from the side the reader is on', () => {
    // The request's range sits below the lender's.
    expect(gapOf(mine, req(), MATCH_CODE.rate)).toEqual({ kind: 'rate', theirs: 600n, mine: 700n, theirsHigh: false });
    const borrower = offer({ offerType: 1, interestRateBps: 300n, interestRateBpsMax: 400n });
    expect(gapOf(borrower, offer({ id: 3n, interestRateBps: 500n, interestRateBpsMax: 550n }), MATCH_CODE.rate)).toEqual({
      kind: 'rate',
      theirs: 500n,
      mine: 400n,
      theirsHigh: true,
    });
  });
  it('names the bounds that miss when the request’s range sits above the lender’s', () => {
    const lender = offer({ interestRateBps: 500n, interestRateBpsMax: 600n });
    const high = req({ interestRateBps: 700n, interestRateBpsMax: 800n });
    expect(gapOf(lender, high, MATCH_CODE.rate)).toEqual({ kind: 'rate', theirs: 700n, mine: 600n, theirsHigh: true });
    expect(gapOf(high, lender, MATCH_CODE.rate)).toEqual({ kind: 'rate', theirs: 600n, mine: 700n, theirsHigh: false });
    // A rate refusal the two ranges do not explain is stated by its code.
    expect(gapOf(lender, req({ interestRateBps: 550n, interestRateBpsMax: 650n }), MATCH_CODE.rate)).toEqual({ kind: 'code', code: MATCH_CODE.rate });
  });
  it('names a term gap, as up-to when the lender is pro-rata', () => {
    expect(gapOf(mine, req({ durationDays: 45n }), MATCH_CODE.duration)).toEqual({ kind: 'term', theirs: 45n, mine: 30n, upTo: false });
    const proRata = offer({ useFullTermInterest: false });
    expect(gapOf(proRata, req({ durationDays: 45n, useFullTermInterest: false }), MATCH_CODE.duration)).toMatchObject({ upTo: true });
  });
  it('names the first lifecycle option that differs, else the bare code', () => {
    expect(optionGap(mine, req({ useFullTermInterest: false, allowsPartialRepay: true }))).toBe('interest-mode');
    expect(gapOf(mine, req({ allowsPartialRepay: true }), MATCH_CODE.terms)).toEqual({ kind: 'option', which: 'partial' });
    expect(gapOf(mine, req({ allowsPrepayListing: true }), MATCH_CODE.terms)).toEqual({ kind: 'option', which: 'prepay' });
    expect(gapOf(mine, req({ periodicInterestCadence: 1 }), MATCH_CODE.terms)).toEqual({ kind: 'option', which: 'cadence' });
    expect(gapOf(mine, req(), MATCH_CODE.terms)).toEqual({ kind: 'code', code: MATCH_CODE.terms });
    expect(gapOf(mine, req(), 6)).toEqual({ kind: 'code', code: 6 });
  });
  it('prefers a pair the protocol would match, then the closest open refusal', () => {
    const matchable = cp(req({ id: 3n }), MATCH_CODE.ok, 'open', 650n, 1);
    expect(whyOf(ranked(2), read([cp(req(), MATCH_CODE.rate), matchable]))).toEqual({ kind: 'matchable', with: matchable });
    const why = whyOf(ranked(2), read([cp(req(), null, 'accepted'), cp(req({ id: 3n }), MATCH_CODE.rate)]));
    // The closer offer was read as taken, so the gap is the closest one.
    expect(why).toMatchObject({ kind: 'gap', gap: { kind: 'rate' }, closerUnknown: 0 });
  });
  it('says when closer offers got no answer, rather than calling a farther refusal the closest', () => {
    // #2 (rank 0) failed to read; #3 (rank 1) answered open with no verdict; #4 refuses on rate.
    const why = whyOf(ranked(3), read([cp(req({ id: 3n }), null, 'open', null, 1), cp(req({ id: 4n }), MATCH_CODE.rate, 'open', null, 2)]));
    expect(why).toMatchObject({ kind: 'gap', with: { rank: 2 }, closerUnknown: 2 });
  });
  it('states an empty side, the switch and an unreadable list', () => {
    expect(whyOf(ranked(0), read([]))).toEqual({ kind: 'none' });
    expect(whyOf(ranked(1), read([cp(req(), null)], false))).toEqual({ kind: 'switch-off' });
    expect(whyOf(ranked(1), read([cp(req(), null)], null))).toEqual({ kind: 'switch-unread' });
    expect(whyOf(ranked(1), read([cp(req(), null, 'cancelled')]))).toEqual({ kind: 'unread' });
    // The switch is stated even when nothing stands on the other side.
    expect(whyOf(ranked(0), read([], false))).toEqual({ kind: 'switch-off' });
    expect(whyOf(ranked(0), read([], null))).toEqual({ kind: 'switch-unread' });
  });
  it('reads the index’s ranking and refuses an answer it cannot read', async () => {
    await expect(readNearestIndex(indexer({ eligible: true, candidates: [{ offerId: 4 }, { offerId: 9 }], oppositeOpen: 7 }), 1, 1n)).resolves.toEqual({
      kind: 'ranked',
      ids: [4n, 9n],
      oppositeOpen: 7,
    });
    await expect(readNearestIndex(indexer({ eligible: false, reason: 'not-open' }), 1, 1n)).resolves.toEqual({ kind: 'ineligible', reason: 'not-open' });
    await expect(readNearestIndex(indexer({ eligible: true, candidates: [{ offerId: 'x' }], oppositeOpen: 1 }), 1, 1n)).rejects.toBeInstanceOf(IndexerUnavailable);
    await expect(readNearestIndex(indexer({ candidates: [] }), 1, 1n)).rejects.toBeInstanceOf(IndexerUnavailable);
  });
});
