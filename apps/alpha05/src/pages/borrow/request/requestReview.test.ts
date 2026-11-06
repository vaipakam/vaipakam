import { describe, expect, it } from 'vitest';
import { createParams, ZERO } from './requestModel';
import { changedBetween, judgeDryRun, needsApproval, promptCount, requestBlockers, requestReceipt, requestRiskNeed, type RequestReview } from './requestReview';

type Hex = `0x${string}`;
const lending = '0x00000000000000000000000000000000000000a1' as Hex;
const collateral = '0x00000000000000000000000000000000000000c1' as Hex;
const account = '0x00000000000000000000000000000000000000e1' as Hex;
const diamond = '0x00000000000000000000000000000000000000d1' as Hex;
const other = '0x00000000000000000000000000000000000000f1' as Hex;

/** A copy stand-in that returns the key, so a test reads which line was chosen. */
const copy = { text: (k: string) => k, format: (k: string) => k } as unknown as Parameters<typeof requestBlockers>[2];

function review(over: Partial<RequestReview> = {}): RequestReview {
  const parsed = { amount: 1_000n, collateral: 5_000n, rateBps: 800n, durationDays: 30, expiry: '7d' as const, fullTerm: true, allowsPartialRepay: false };
  const draft = { parsed, pair: { lending, collateral, leg: { kind: 'erc20' as const } }, expiresAt: 1_000n };
  return {
    identity: 'w',
    account,
    diamond,
    draft,
    params: createParams(parsed, draft.pair, draft.expiresAt),
    verdict: { kind: 'needs-approval' },
    lendingClass: 'liquid',
    collateralClass: 'liquid',
    ltvBps: 5_000n,
    maxDurationDays: 365n,
    graceSeconds: 86_400n,
    lifBps: 20n,
    vault: ZERO,
    holding: { kind: 'erc20', funds: { balance: 10_000n, allowance: 0n }, approvalSteps: 1 },
    readAt: 1,
    ...over,
  };
}

/** A viem-like revert carrying raw revert data. */
const revertWith = (data: Hex) => Object.assign(new Error('execution reverted'), { data, cause: { data } });

describe('judgeDryRun', () => {
  it('reads an answer as ok and a missing answer as unreadable', () => {
    expect(judgeDryRun({ kind: 'answered' }, false)).toEqual({ kind: 'ok' });
    expect(judgeDryRun({ kind: 'unreadable', reason: 'x' }, false)).toEqual({ kind: 'unreadable', reason: 'x' });
  });
  it("classes the token's pull error, or a revert it cannot name, as the approval's to clear while the allowance is short", () => {
    expect(judgeDryRun({ kind: 'reverted', error: revertWith('0xfb8f41b2') }, false)).toEqual({ kind: 'needs-approval' });
    expect(judgeDryRun({ kind: 'reverted', error: new Error('execution reverted') }, false)).toEqual({ kind: 'needs-approval' });
  });
  it('never excuses a revert once the allowance covers the collateral', () => {
    expect(judgeDryRun({ kind: 'reverted', error: revertWith('0xfb8f41b2') }, true).kind).toBe('refused');
  });
});

describe('requestBlockers', () => {
  it('names a shortfall and keeps the protocol refusal it explains out', () => {
    const r = review({ holding: { kind: 'erc20', funds: { balance: 1_000n, allowance: 0n }, approvalSteps: 1 }, verdict: { kind: 'refused', code: 'X', reason: 'r' } });
    expect(requestBlockers(r, null, copy)).toEqual(['request.blockShortfall']);
  });
  it("states the protocol's refusal and an unreadable answer", () => {
    expect(requestBlockers(review({ verdict: { kind: 'refused', code: 'X', reason: 'r' } }), null, copy)).toEqual(['request.blockRefused']);
    expect(requestBlockers(review({ verdict: { kind: 'unreadable', reason: 'r' } }), null, copy)).toEqual(['request.blockUnread']);
    expect(requestBlockers(review(), null, copy)).toEqual([]);
  });
  it('names a risk-access refusal with its step, even beside a shortfall, and reads its need', () => {
    const r = review({ verdict: { kind: 'refused', code: 'RiskTierTooLow', reason: 'x' }, holding: { kind: 'erc20', funds: { balance: 0n, allowance: 0n }, approvalSteps: 1 } });
    expect(requestBlockers(r, null, copy)).toEqual(['request.blockShortfall', 'risk.blockTier']);
    expect(requestRiskNeed(r)).toBe('tier');
    expect(requestRiskNeed(review({ verdict: { kind: 'refused', code: 'IlliquidPairNotConsented', reason: 'x' } }))).toBe('pair-consent');
    expect(requestRiskNeed(review())).toBeNull();
  });
  it('names a distrusted leg', () => {
    expect(requestBlockers(review({ collateralClass: 'distrusted' }), null, copy)).toEqual(['accept.blockDistrusted']);
  });
});

describe('changedBetween', () => {
  it('names what moved, and nothing when nothing did', () => {
    expect(changedBetween(review(), review({ readAt: 2 }), copy)).toBeNull();
    expect(changedBetween(review(), review({ verdict: { kind: 'ok' } }), copy)).toBe('request.changedVerdict');
    expect(changedBetween(review(), review({ lifBps: 10n }), copy)).toBe('request.changedConfig');
    expect(changedBetween(review(), review({ holding: { kind: 'erc20', funds: { balance: 10_000n, allowance: 0n }, approvalSteps: 2 } }), copy)).toBe('accept.changedFunds');
  });
});

describe('requestReceipt', () => {
  it('counts the approval prompt and states every lifecycle term and the lapse rule', () => {
    const r = review();
    expect(promptCount(r)).toBe(2);
    const receipt = requestReceipt(r, null, copy);
    const labels = receipt.rows.map((x) => x.label);
    for (const k of [
      'request.rowLock',
      'request.rowAmount',
      'request.rowWhole',
      'accept.rowRate',
      'request.rowReceive',
      'accept.rowFee',
      'accept.rowOwe',
      'accept.rowPartial',
      'accept.rowPrepayListing',
      'accept.rowParallelSale',
      'accept.rowRefinance',
      'request.rowExpiry',
      'accept.rowApproval',
    ])
      expect(labels).toContain(k);
    expect(receipt.consequences).toContain('request.loseLapse');
    expect(receipt.consequences).toContain('request.loseTaken');
    const never = requestReceipt(review({ draft: { ...r.draft, expiresAt: 0n } }), null, copy);
    expect(never.consequences).toContain('request.loseOpen');
  });
  it('states no loan-to-value for an illiquid leg', () => {
    const receipt = requestReceipt(review({ collateralClass: 'illiquid', ltvBps: null }), null, copy);
    expect(receipt.consequences).toContain('accept.loseIlliquidCollateral');
    expect(receipt.consequences).not.toContain('accept.loseLiquidation');
  });
});

/** A review of a request locking ERC-721 token #7, as the wallet stands on it. */
function nftReview(state: { owner: Hex | null; approved?: Hex | null; forAll?: boolean }, over: Partial<RequestReview> = {}): RequestReview {
  const base = review();
  const leg = { kind: 'erc721' as const, tokenId: 7n };
  const parsed = { ...base.draft.parsed, collateral: 1n };
  const draft = { ...base.draft, parsed, pair: { lending, collateral, leg } };
  return {
    ...base,
    draft,
    params: createParams(parsed, draft.pair, draft.expiresAt),
    collateralClass: 'illiquid',
    ltvBps: null,
    holding: { kind: 'erc721', tokenId: 7n, state: { owner: state.owner, approved: state.approved ?? null, approvedForAll: state.forAll ?? false, blockNumber: 1n } },
    ...over,
  };
}

describe('an ERC-721 collateral (NFT-13)', () => {
  it('needs one approval prompt unless the token or the collection already lets the protocol move it', () => {
    expect(needsApproval(nftReview({ owner: account }))).toBe(true);
    expect(promptCount(nftReview({ owner: account }))).toBe(2);
    expect(needsApproval(nftReview({ owner: account, approved: diamond }))).toBe(false);
    expect(needsApproval(nftReview({ owner: account, forAll: true }))).toBe(false);
    expect(promptCount(nftReview({ owner: account, forAll: true }))).toBe(1);
  });
  it('names a token that does not exist or that another wallet holds, and keeps the pull refusal it explains out', () => {
    const refused = { verdict: { kind: 'refused' as const, code: 'X', reason: 'r' } };
    expect(requestBlockers(nftReview({ owner: null }, refused), null, copy)).toEqual(['request.blockNoToken']);
    expect(requestBlockers(nftReview({ owner: other }, refused), null, copy)).toEqual(['request.blockNotHeld']);
    expect(requestBlockers(nftReview({ owner: account }, refused), null, copy)).toEqual(['request.blockRefused']);
    expect(requestBlockers(nftReview({ owner: account }), null, copy)).toEqual([]);
  });
  it('names a move of the token or its approval between reads', () => {
    expect(changedBetween(nftReview({ owner: account }), nftReview({ owner: account }), copy)).toBeNull();
    expect(changedBetween(nftReview({ owner: account }), nftReview({ owner: other }), copy)).toBe('request.changedToken');
    expect(changedBetween(nftReview({ owner: account }), nftReview({ owner: account, approved: diamond }), copy)).toBe('request.changedToken');
  });
  it('locks the token by name with a one-token approval row, and states the in-kind default', () => {
    const receipt = requestReceipt(nftReview({ owner: account }), null, copy);
    const lock = receipt.rows.find((x) => x.label === 'request.rowLock');
    expect(lock?.value).toEqual({ kind: 'text', text: 'asset.nft' });
    expect(lock?.movesOut).toBe(true);
    const approval = receipt.rows.find((x) => x.label === 'accept.rowApproval');
    expect(approval?.value).toEqual({ kind: 'text', text: 'request.approvalToken' });
    expect(receipt.consequences).toContain('accept.loseIlliquidCollateral');
    expect(receipt.prompts).toBe(2);
  });
});
