import { describe, expect, it } from 'vitest';
import { listParams, parseUnits, type ListDraft } from './listModel';
import { listReceipt } from './listReceipt';
import { listApprovalPrompts, listBlockers, listChangedBetween, listCost, listLack, listPromptCount, rentalListPair, type ListReview } from './listReview';

type Hex = `0x${string}`;

const NFT: Hex = '0x5555555555555555555555555555555555555555';
const USDC: Hex = '0x6666666666666666666666666666666666666666';
const ME: Hex = '0x1111111111111111111111111111111111111111';
const OTHER: Hex = '0x2222222222222222222222222222222222222222';
const DIAMOND: Hex = '0x3333333333333333333333333333333333333333';
const ZERO: Hex = '0x0000000000000000000000000000000000000000';

/** A copy stand-in that returns the key, so a test reads which line was chosen. */
const copy = {
  text: (k: string) => k,
  format: (k: string) => k,
} as unknown as Parameters<typeof listBlockers>[2];

/** An ERC-721 token listed at 2 USDC a day for 10 days, pro-rata, open until cancelled. */
function draft(over: Partial<ListDraft> = {}): ListDraft {
  return { nft: NFT, standard: 'erc721', tokenId: 42n, quantity: 1n, payment: USDC, dailyFee: 2_000_000n, days: 10n, fullTerm: false, expiresAt: 0n, ...over };
}

function review(over: Partial<ListReview> = {}): ListReview {
  const d = over.draft ?? draft();
  return {
    identity: 'w',
    account: ME,
    diamond: DIAMOND,
    draft: d,
    params: listParams(d),
    holding: { kind: 'erc721', state: { owner: ME, approved: null, approvedForAll: false, blockNumber: 1n } },
    paymentClass: 'liquid',
    bufferBps: 500n,
    graceSeconds: 86_400n,
    maxDurationDays: 365n,
    protocolShareBps: 200n,
    vault: ZERO,
    verdict: { kind: 'needs-approval' },
    readAt: 1,
    ...over,
  };
}

describe('listParams', () => {
  it('lends the NFT with one daily fee, no collateral and no rate', () => {
    const p = listParams(draft({ fullTerm: true }));
    expect(p).toMatchObject({ offerType: 0, lendingAsset: NFT, assetType: 1, tokenId: 42n, quantity: 1n, amount: 2_000_000n, amountMax: 2_000_000n, prepayAsset: USDC, useFullTermInterest: true });
    expect(p).toMatchObject({ collateralAsset: ZERO, collateralAmount: 0n, collateralAmountMax: 0n, interestRateBps: 0n, interestRateBpsMax: 0n, creatorRiskAndTermsConsent: true });
  });
  it('carries the quantity of an ERC-1155 token', () => {
    expect(listParams(draft({ standard: 'erc1155', quantity: 5n }))).toMatchObject({ assetType: 2, quantity: 5n });
    expect(parseUnits('0')).toBeNull();
    expect(parseUnits(' 3 ')).toBe(3n);
  });
  it('names the payment token as the pair the risk check judges', () => {
    expect(rentalListPair(draft())).toMatchObject({ lendAsset: NFT, lendType: 1, lendTokenId: 42n, collAsset: ZERO, collType: 0, prepayAsset: USDC });
  });
});

describe('listBlockers', () => {
  it('opens nothing when the wallet holds the NFT and only the approval stands between', () => {
    expect(listBlockers(review(), null, copy)).toEqual([]);
    expect(listApprovalPrompts(review())).toBe(1);
    expect(listPromptCount(review())).toBe(2);
  });
  it('says when the token does not exist or another wallet holds it', () => {
    expect(listBlockers(review({ holding: { kind: 'erc721', state: { owner: null, approved: null, approvedForAll: false, blockNumber: 1n } } }), null, copy)).toEqual(['rentList.blockNoToken']);
    expect(listBlockers(review({ holding: { kind: 'erc721', state: { owner: OTHER, approved: null, approvedForAll: false, blockNumber: 1n } } }), null, copy)).toEqual(['rentList.blockNotHeld']);
  });
  it('counts an ERC-1155 shortfall and two prompts for the operator approval', () => {
    const r = review({ draft: draft({ standard: 'erc1155', quantity: 5n }), holding: { kind: 'erc1155', state: { balance: 3n, approvedForAll: false, blockNumber: 1n } } });
    expect(listLack(r)).toEqual({ kind: 'units', missing: 2n });
    expect(listBlockers(r, null, copy)).toEqual(['rentList.blockUnits']);
    expect(listApprovalPrompts(r)).toBe(2);
  });
  it('words a refusal for an owner, names a risk step, and refuses a distrusted payment token', () => {
    expect(listBlockers(review({ verdict: { kind: 'refused', code: 'VpfiNotAllowedAsRentalPrepay', reason: 'x' } }), null, copy)).toEqual(['rentList.blockRefused']);
    expect(listBlockers(review({ verdict: { kind: 'refused', code: 'RiskTierTooLow', reason: 'x' } }), null, copy)).toEqual(['risk.blockTier']);
    expect(listBlockers(review({ paymentClass: 'distrusted' }), null, copy)).toEqual(['rentList.blockDistrusted']);
  });
});

describe('listChangedBetween', () => {
  it('names the buffer, the verdict and the token when each moved, and nothing when nothing did', () => {
    expect(listChangedBetween(review(), review(), copy)).toBeNull();
    expect(listChangedBetween(review(), review({ bufferBps: 700n }), copy)).toBe('rent.changedBuffer');
    expect(listChangedBetween(review(), review({ verdict: { kind: 'ok' } }), copy)).toBe('rentList.changedVerdict');
    expect(listChangedBetween(review(), review({ holding: { kind: 'erc721', state: { owner: ME, approved: DIAMOND, approvedForAll: false, blockNumber: 2n } } }), copy)).toBe('request.changedToken');
  });
});

describe('listReceipt', () => {
  it('moves the NFT out, binds the buffer the listing fixes now, and states what a renter pays', () => {
    const r = review();
    expect(listCost(r)).toMatchObject({ rent: 20_000_000n, buffer: 1_000_000n, total: 21_000_000n, bufferFrom: 'listing' });
    const receipt = listReceipt(r, null, copy);
    expect(receipt.rows[0]).toMatchObject({ label: 'rentList.rowLock', movesOut: true, binding: true });
    expect(receipt.rows.find((x) => x.label === 'rent.rowBuffer')).toMatchObject({ value: { text: 'rentList.buffer' }, binding: true });
    expect(receipt.rows.find((x) => x.label === 'rentList.rowEarn')?.value).toMatchObject({ text: 'rentList.earn' });
    expect(receipt.rows.find((x) => x.label === 'rent.rowRule')?.value).toMatchObject({ text: 'rentList.ruleProRata' });
    expect(receipt.consequences).toContain('rentList.loseOpen');
    expect(receipt.prompts).toBe(2);
  });
  it('says when the protocol share could not be read, and names the take-back for an ERC-1155 approval', () => {
    const r = review({
      protocolShareBps: null,
      draft: draft({ standard: 'erc1155', quantity: 2n, expiresAt: 1_900_000_000n }),
      holding: { kind: 'erc1155', state: { balance: 2n, approvedForAll: false, blockNumber: 1n } },
    });
    const receipt = listReceipt(r, null, copy);
    expect(receipt.rows.find((x) => x.label === 'rentList.rowEarn')?.value).toMatchObject({ text: 'rentList.earnUnread' });
    expect(receipt.consequences).toContain('rentList.loseLapse');
    expect(receipt.consequences).toContain('rentList.loseOperator');
    expect(receipt.prompts).toBe(3);
  });
});
