import { describe, expect, it } from 'vitest';
import type { StoredOffer } from '../offers/acceptTerms';
import type { AcceptPreview } from '../offers/reads';
import { takeReceipt } from './takeReceipt';
import { isRentRequest, takeApprovalPrompts, takeBlockers, takeChangedBetween, takeCost, takeLack, takePromptCount, type TakeReview } from './takeReview';

type Hex = `0x${string}`;

const NFT: Hex = '0x5555555555555555555555555555555555555555';
const USDC: Hex = '0x6666666666666666666666666666666666666666';
const ME: Hex = '0x1111111111111111111111111111111111111111';
const RENTER: Hex = '0x2222222222222222222222222222222222222222';
const DIAMOND: Hex = '0x3333333333333333333333333333333333333333';
const ZERO: Hex = '0x0000000000000000000000000000000000000000';

const copy = {
  text: (k: string) => k,
  format: (k: string) => k,
} as unknown as Parameters<typeof takeBlockers>[2];

/** A renter's request for ERC-721 #42 at 2 USDC a day for 10 days, pro-rata. */
function offer(over: Partial<StoredOffer> = {}): StoredOffer {
  return {
    id: 7n,
    creator: RENTER,
    offerType: 1,
    lendingAsset: NFT,
    amount: 2_000_000n,
    amountMax: 2_000_000n,
    interestRateBps: 0n,
    interestRateBpsMax: 0n,
    collateralAsset: ZERO,
    collateralAmount: 0n,
    durationDays: 10n,
    assetType: 1,
    tokenId: 42n,
    quantity: 1n,
    prepayAsset: USDC,
    useFullTermInterest: false,
    ...over,
  } as StoredOffer;
}

function review(over: Partial<TakeReview> = {}): TakeReview {
  return {
    identity: 'w',
    account: ME,
    diamond: DIAMOND,
    offerId: 7n,
    offer: offer(),
    state: 'open',
    preview: { effectivePrincipal: 2_000_000n, error: 'None' } as AcceptPreview,
    linkedLoanId: 0n,
    riskTermsHash: '0x01',
    holding: { kind: 'erc721', state: { owner: ME, approved: null, approvedForAll: false, blockNumber: 1n } },
    nftClass: 'illiquid',
    prepayClass: 'liquid',
    graceSeconds: 86_400n,
    requestBufferBps: 500n,
    todayBufferBps: 600n,
    protocolShareBps: 200n,
    vault: ZERO,
    gate: 0,
    creatorGate: 0,
    readAt: 1,
    ...over,
  };
}

describe('isRentRequest', () => {
  it('is a renter-side rental, never an owner’s listing or a loan', () => {
    expect(isRentRequest(offer())).toBe(true);
    expect(isRentRequest(offer({ offerType: 0 }))).toBe(false);
    expect(isRentRequest(offer({ assetType: 0 }))).toBe(false);
  });
});

describe('takeBlockers', () => {
  it('opens when the wallet holds the NFT and only the approval stands between', () => {
    const r = review();
    expect(takeBlockers(r, null, copy)).toEqual([]);
    expect(takeCost(r)).toMatchObject({ rent: 20_000_000n, buffer: 1_000_000n, total: 21_000_000n, bufferFrom: 'listing' });
    expect(takeApprovalPrompts(r)).toBe(1);
    expect(takePromptCount(r)).toBe(3);
    expect(takePromptCount(review({ holding: { kind: 'erc721', state: { owner: ME, approved: DIAMOND, approvedForAll: false, blockNumber: 1n } } }))).toBe(2);
  });
  it('says when the token does not exist, another wallet holds it, or too few units are held', () => {
    expect(takeBlockers(review({ holding: { kind: 'erc721', state: { owner: null, approved: null, approvedForAll: false, blockNumber: 1n } } }), null, copy)).toEqual(['rentList.blockNoToken']);
    expect(takeBlockers(review({ holding: { kind: 'erc721', state: { owner: RENTER, approved: null, approvedForAll: false, blockNumber: 1n } } }), null, copy)).toEqual(['rentTake.blockNotHeld']);
    const multi = review({ offer: offer({ assetType: 2, quantity: 5n }), holding: { kind: 'erc1155', state: { balance: 3n, approvedForAll: false, blockNumber: 1n } } });
    expect(takeLack(multi)).toEqual({ kind: 'units', missing: 2n });
    expect(takeBlockers(multi, null, copy)).toEqual(['rentTake.blockUnits']);
    expect(takeApprovalPrompts(multi)).toBe(2);
  });
  it('words the protocol’s refusal and the state for an owner, and names a renter-side gate', () => {
    expect(takeBlockers(review({ preview: { effectivePrincipal: 2_000_000n, error: 'OfferAlreadyAccepted' } as AcceptPreview }), null, copy)).toEqual(['rentTake.err.OfferAlreadyAccepted']);
    expect(takeBlockers(review({ state: 'cancelled' }), null, copy)).toEqual(['rentTake.blockState']);
    expect(takeBlockers(review({ creatorGate: 2 }), null, copy)).toEqual(['rentTake.blockCreatorGate']);
    expect(takeBlockers(review({ gate: 1 }), null, copy)).toEqual(['risk.blockTier']);
  });
});

describe('takeChangedBetween', () => {
  it('names what moved, and nothing when nothing did', () => {
    expect(takeChangedBetween(review(), review(), copy)).toBeNull();
    expect(takeChangedBetween(review(), review({ state: 'accepted' }), copy)).toBe('rentTake.changedRequest');
    expect(takeChangedBetween(review(), review({ protocolShareBps: 300n }), copy)).toBe('accept.changedClass');
    expect(takeChangedBetween(review(), review({ holding: { kind: 'erc721', state: { owner: ME, approved: DIAMOND, approvedForAll: false, blockNumber: 2n } } }), copy)).toBe('request.changedToken');
  });
});

describe('takeReceipt', () => {
  it('moves the NFT out, names the renter, and states what is already in the renter’s vault', () => {
    const receipt = takeReceipt(review(), null, copy);
    expect(receipt.rows[0]).toMatchObject({ label: 'rentList.rowLock', movesOut: true, binding: true });
    expect(receipt.rows.find((x) => x.label === 'rentTake.rowRenter')?.value).toMatchObject({ text: RENTER });
    expect(receipt.rows.find((x) => x.label === 'rentTake.rowHeld')?.value).toMatchObject({ text: 'rentTake.held' });
    expect(receipt.rows.find((x) => x.label === 'rent.rowBuffer')).toMatchObject({ value: { text: 'rentTake.bufferRequest' }, binding: true });
    expect(receipt.rows.find((x) => x.label === 'rentList.rowEarn')).toMatchObject({ value: { text: 'rentTake.earn' }, binding: true });
    expect(receipt.consequences).toContain('rentTake.loseHeld');
    expect(receipt.prompts).toBe(3);
  });
  it('says when the share is unread, when no buffer was recorded, and names the take-back for an ERC-1155 approval', () => {
    const receipt = takeReceipt(
      review({ protocolShareBps: null, requestBufferBps: 0n, offer: offer({ assetType: 2, quantity: 2n }), holding: { kind: 'erc1155', state: { balance: 2n, approvedForAll: false, blockNumber: 1n } } }),
      null,
      copy,
    );
    expect(receipt.rows.find((x) => x.label === 'rentList.rowEarn')?.value).toMatchObject({ text: 'rentTake.earnUnread' });
    expect(receipt.consequences).toContain('rentTake.loseBufferToday');
    expect(receipt.consequences).toContain('rentTake.loseOperator');
    expect(receipt.prompts).toBe(4);
  });
});
