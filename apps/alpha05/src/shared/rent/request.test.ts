import { describe, expect, it } from 'vitest';
import { listParams, requestParams, type ListDraft } from './listModel';
import { requestReceipt } from './requestReceipt';
import { requestBlockers, requestChangedBetween, requestCost, requestNeedsApproval, requestPromptCount, requestTokenNote, type RequestReview } from './requestReview';

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
} as unknown as Parameters<typeof requestBlockers>[2];

/** An ERC-721 token asked for at 2 USDC a day for 10 days, pro-rata, open until cancelled. */
function draft(over: Partial<ListDraft> = {}): ListDraft {
  return { nft: NFT, standard: 'erc721', tokenId: 42n, quantity: 1n, payment: USDC, dailyFee: 2_000_000n, days: 10n, fullTerm: false, expiresAt: 0n, ...over };
}

function review(over: Partial<RequestReview> = {}): RequestReview {
  const d = over.draft ?? draft();
  return {
    identity: 'w',
    account: ME,
    diamond: DIAMOND,
    draft: d,
    params: requestParams(d),
    token: { owner: OTHER, approved: null, approvedForAll: false, blockNumber: 1n },
    paymentClass: 'liquid',
    bufferBps: 500n,
    graceSeconds: 86_400n,
    maxDurationDays: 365n,
    vault: ZERO,
    funds: { balance: 100_000_000n, allowance: 0n },
    approvalSteps: 1,
    verdict: { kind: 'needs-approval' },
    readAt: 1,
    ...over,
  };
}

describe('requestParams', () => {
  it('is the listing’s terms on a renter-side offer, with no collateral and no rate', () => {
    const d = draft({ fullTerm: true });
    expect(requestParams(d)).toEqual({ ...listParams(d), offerType: 1 });
    expect(requestParams(d)).toMatchObject({ lendingAsset: NFT, assetType: 1, tokenId: 42n, amount: 2_000_000n, prepayAsset: USDC, collateralAmount: 0n, interestRateBps: 0n, useFullTermInterest: true });
  });
});

describe('requestBlockers', () => {
  it('opens for a funded wallet whose only step is the approval of the rent and buffer', () => {
    const r = review();
    expect(requestCost(r)).toMatchObject({ rent: 20_000_000n, buffer: 1_000_000n, total: 21_000_000n });
    expect(requestBlockers(r, null, copy)).toEqual([]);
    expect(requestNeedsApproval(r)).toBe(true);
    expect(requestPromptCount(r)).toBe(2);
    expect(requestPromptCount(review({ approvalSteps: 0, funds: { balance: 100_000_000n, allowance: 21_000_000n } }))).toBe(1);
  });
  it('states a shortfall instead of the protocol’s pull refusal', () => {
    const r = review({ funds: { balance: 20_000_000n, allowance: 0n }, verdict: { kind: 'refused', code: 'ERC20InsufficientBalance', reason: 'x' } });
    expect(requestBlockers(r, null, copy)).toEqual(['rentRequest.blockShortfall']);
  });
  it('refuses a token this wallet holds, and only notes one that does not exist yet', () => {
    expect(requestBlockers(review({ token: { owner: ME, approved: null, approvedForAll: false, blockNumber: 1n } }), null, copy)).toEqual(['rentRequest.blockOwnToken']);
    const missing = review({ token: { owner: null, approved: null, approvedForAll: false, blockNumber: 1n } });
    expect(requestTokenNote(missing)).toBe('no-token');
    expect(requestBlockers(missing, null, copy)).toEqual([]);
    expect(requestTokenNote(review({ draft: draft({ standard: 'erc1155', quantity: 3n }), token: null }))).toBe('none');
  });
  it('names a risk step, words a refusal for a renter, and refuses a distrusted payment token', () => {
    expect(requestBlockers(review({ verdict: { kind: 'refused', code: 'RiskTierTooLow', reason: 'x' } }), null, copy)).toEqual(['risk.blockTier']);
    expect(requestBlockers(review({ verdict: { kind: 'refused', code: 'VpfiNotAllowedAsRentalPrepay', reason: 'x' } }), null, copy)).toEqual(['rentRequest.blockRefused']);
    expect(requestBlockers(review({ paymentClass: 'distrusted' }), null, copy)).toEqual(['rentList.blockDistrusted']);
  });
});

describe('requestChangedBetween', () => {
  it('names the buffer, the verdict, the token and the funds when each moved, and nothing when nothing did', () => {
    expect(requestChangedBetween(review(), review(), copy)).toBeNull();
    expect(requestChangedBetween(review(), review({ bufferBps: 700n }), copy)).toBe('rent.changedBuffer');
    expect(requestChangedBetween(review(), review({ verdict: { kind: 'ok' } }), copy)).toBe('rentRequest.changedVerdict');
    expect(requestChangedBetween(review(), review({ token: { owner: ME, approved: null, approvedForAll: false, blockNumber: 2n } }), copy)).toBe('request.changedToken');
    expect(requestChangedBetween(review(), review({ funds: { balance: 1n, allowance: 0n } }), copy)).toBe('accept.changedFunds');
  });
});

describe('requestReceipt', () => {
  it('moves the rent and buffer out now, shows the buffer at today’s setting, and states the start and the consequences', () => {
    const receipt = requestReceipt(review(), null, copy);
    expect(receipt.rows[0]).toMatchObject({ label: 'rent.rowPay', value: { kind: 'amount', amount: 21_000_000n }, movesOut: true, binding: false });
    expect(receipt.rows.find((x) => x.label === 'rent.rowBuffer')).toMatchObject({ value: { text: 'rentRequest.buffer' }, binding: false });
    expect(receipt.rows.find((x) => x.label === 'rent.rowTerm')?.value).toMatchObject({ text: 'rentRequest.term' });
    expect(receipt.consequences).toContain('rentRequest.loseOpen');
    expect(receipt.consequences).toContain('rentRequest.loseStart');
    // The buffer is the setting in force when the request lands: stated, and
    // neither it nor the total is shown as bound by the request.
    expect(receipt.consequences).toContain('rentRequest.loseBufferRace');
    expect(receipt.rows.find((x) => x.label === 'rent.rowBuffer')?.binding).toBe(false);
    expect(receipt.rows.find((x) => x.label === 'rent.rowPay')?.binding).toBe(false);
    expect(receipt.prompts).toBe(2);
  });
  it('says when the token does not exist yet, and when the request lapses', () => {
    const receipt = requestReceipt(review({ draft: draft({ expiresAt: 1_900_000_000n }), token: { owner: null, approved: null, approvedForAll: false, blockNumber: 1n } }), null, copy);
    expect(receipt.rows.find((x) => x.label === 'rentRequest.rowNft')?.value).toMatchObject({ text: 'rentRequest.nftMissing' });
    expect(receipt.consequences).toContain('rentRequest.loseLapse');
  });
});
