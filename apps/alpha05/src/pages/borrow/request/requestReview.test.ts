import { describe, expect, it } from 'vitest';
import { createParams, ZERO } from './requestModel';
import {
  changedBetween,
  matchConsequences,
  judgeDryRun,
  judgeLimit,
  needsApproval,
  rangeConsequences,
  readLtv,
  promptCount,
  requestBlockers,
  requestReceipt,
  requestRiskNeed,
  type RequestReview,
} from './requestReview';

type Hex = `0x${string}`;
const lending = '0x00000000000000000000000000000000000000a1' as Hex;
const collateral = '0x00000000000000000000000000000000000000c1' as Hex;
const account = '0x00000000000000000000000000000000000000e1' as Hex;
const diamond = '0x00000000000000000000000000000000000000d1' as Hex;
const other = '0x00000000000000000000000000000000000000f1' as Hex;

/** A copy stand-in that returns the key, so a test reads which line was chosen. */
const copy = { text: (k: string) => k, format: (k: string) => k } as unknown as Parameters<typeof requestBlockers>[2];

function review(over: Partial<RequestReview> = {}): RequestReview {
  const parsed = {
    amount: 1_000n,
    amountMax: 1_000n,
    collateral: 5_000n,
    collateralFloor: 5_000n,
    fillMode: 'partial' as const,
    rateBps: 800n,
    durationDays: 30,
    expiry: '7d' as const,
    fullTerm: true,
    allowsPartialRepay: false,
  };
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
    risk: { direct: { kind: 'value', bps: 5_000n }, largest: null, largestAtFloor: null, directWithinLimit: 'not-asked', directCeiling: null, start: { kind: 'hf', floor: 1_500_000_000_000_000_000n, tiered: false }, partialFill: true },
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
    const receipt = requestReceipt(review({ collateralClass: 'illiquid', risk: { ...review().risk, direct: { kind: 'unpriced' } } }), null, copy);
    expect(receipt.consequences).toContain('accept.loseIlliquidCollateral');
    expect(receipt.consequences).not.toContain('accept.loseLiquidation');
  });
});

/** A review of a request locking ERC-721 token #7, as the wallet stands on it. */
function nftReview(state: { owner: Hex | null; approved?: Hex | null; forAll?: boolean }, over: Partial<RequestReview> = {}): RequestReview {
  const base = review();
  const leg = { kind: 'erc721' as const, tokenId: 7n };
  const parsed = { ...base.draft.parsed, collateral: 1n, collateralFloor: 1n };
  const draft = { ...base.draft, parsed, pair: { lending, collateral, leg } };
  return {
    ...base,
    draft,
    params: createParams(parsed, draft.pair, draft.expiresAt),
    collateralClass: 'illiquid',
    risk: { ...base.risk, direct: { kind: 'unpriced' } },
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

/** A review of a request locking `quantity` of ERC-1155 token #7. */
function multiReview(state: { balance: bigint; forAll?: boolean }, quantity = 3n, over: Partial<RequestReview> = {}): RequestReview {
  const base = review();
  const leg = { kind: 'erc1155' as const, tokenId: 7n, quantity };
  const parsed = { ...base.draft.parsed, collateral: quantity, collateralFloor: quantity };
  const draft = { ...base.draft, parsed, pair: { lending, collateral, leg } };
  return {
    ...base,
    draft,
    params: createParams(parsed, draft.pair, draft.expiresAt),
    collateralClass: 'illiquid',
    risk: { ...base.risk, direct: { kind: 'unpriced' } },
    holding: { kind: 'erc1155', tokenId: 7n, quantity, state: { balance: state.balance, approvedForAll: state.forAll ?? false, blockNumber: 1n } },
    ...over,
  };
}

describe('an ERC-1155 collateral (NFT-13)', () => {
  it('posts the token, its id and its quantity, with no fungible amount', () => {
    const p = multiReview({ balance: 5n }).params;
    expect(p.collateralAssetType).toBe(2);
    expect(p.collateralTokenId).toBe(7n);
    expect(p.collateralQuantity).toBe(3n);
    expect(p.collateralAmount).toBe(0n);
  });
  it('needs the grant and the revoke, two prompts, unless the collection is already approved (then left alone)', () => {
    expect(needsApproval(multiReview({ balance: 5n }))).toBe(true);
    expect(promptCount(multiReview({ balance: 5n }))).toBe(3);
    expect(needsApproval(multiReview({ balance: 5n, forAll: true }))).toBe(false);
    expect(promptCount(multiReview({ balance: 5n, forAll: true }))).toBe(1);
  });
  it('names a wallet holding too few, and keeps the pull refusal it explains out', () => {
    const refused = { verdict: { kind: 'refused' as const, code: 'X', reason: 'r' } };
    expect(requestBlockers(multiReview({ balance: 2n }, 3n, refused), null, copy)).toEqual(['request.blockUnits']);
    expect(requestBlockers(multiReview({ balance: 3n }, 3n, refused), null, copy)).toEqual(['request.blockRefused']);
    expect(requestBlockers(multiReview({ balance: 3n }), null, copy)).toEqual([]);
  });
  it('names a move of the balance or the approval between reads', () => {
    expect(changedBetween(multiReview({ balance: 5n }), multiReview({ balance: 5n }), copy)).toBeNull();
    expect(changedBetween(multiReview({ balance: 5n }), multiReview({ balance: 1n }), copy)).toBe('request.changedToken');
    expect(changedBetween(multiReview({ balance: 1n }), multiReview({ balance: 2n }), copy)).toBe('request.changedToken');
    expect(changedBetween(multiReview({ balance: 5n }), multiReview({ balance: 5n, forAll: true }), copy)).toBe('request.changedToken');
  });
  it('locks the quantity by name with a collection-wide approval row that says it is taken back', () => {
    const receipt = requestReceipt(multiReview({ balance: 5n }), null, copy);
    expect(receipt.rows.find((x) => x.label === 'request.rowLock')?.value).toEqual({ kind: 'text', text: 'asset.nft1155' });
    expect(receipt.rows.find((x) => x.label === 'accept.rowApproval')?.value).toEqual({ kind: 'text', text: 'request.approvalOperator' });
    const already = requestReceipt(multiReview({ balance: 5n, forAll: true }), null, copy);
    expect(already.rows.find((x) => x.label === 'accept.rowApproval')?.value).toEqual({ kind: 'text', text: 'request.approvalOperatorEnough' });
    expect(receipt.prompts).toBe(3);
  });
  it("classes the token's missing-operator error as the approval's to clear", () => {
    expect(judgeDryRun({ kind: 'reverted', error: revertWith('0xe237d922') }, false)).toEqual({ kind: 'needs-approval' });
  });
});

/** A review of a ranged request: 1,000 to 4,000 against 5,000 locked, 2,000 of
 *  it for the smallest loan. */
function rangedReview(over: Partial<RequestReview> = {}, risk: Partial<RequestReview['risk']> = {}): RequestReview {
  const base = review();
  const parsed = { ...base.draft.parsed, amountMax: 4_000n, collateralFloor: 2_000n };
  const draft = { ...base.draft, parsed };
  return {
    ...base,
    draft,
    params: createParams(parsed, draft.pair, draft.expiresAt),
    risk: { ...base.risk, largest: { kind: 'value', bps: 8_000n }, largestAtFloor: { kind: 'value', bps: 16_000n }, directWithinLimit: 'within', ...risk },
    ...over,
  };
}

/** A viem-like decoded custom-error revert. */
const decoded = (errorName: string, args: unknown[]) => Object.assign(new Error('execution reverted'), { cause: { data: { errorName, args } } });

describe('a ranged request (OFF-10 / OFF-16)', () => {
  it('states both ends, the floor and what returns, the fill mode and the matching switch', () => {
    const receipt = requestReceipt(rangedReview(), null, copy);
    const labels = receipt.rows.map((x) => x.label);
    for (const k of [
      'request.rowAmountMin',
      'request.rowAmountMax',
      'request.rowFloor',
      'request.rowReturned',
      'request.rowFill',
      'request.rowMatching',
      'request.rowOweDirect',
      'request.rowOweLargest',
      'request.rowLtvDirect',
      'request.rowLtvLargest',
    ])
      expect(labels).toContain(k);
    expect(labels).not.toContain('request.rowAmount');
    expect(receipt.rows.find((x) => x.label === 'request.rowReturned')?.value).toEqual({ kind: 'amount', asset: collateral, amount: 3_000n });
    expect(receipt.rows.find((x) => x.label === 'request.rowMatching')?.value).toEqual({ kind: 'text', text: 'request.matchingOn' });
    expect(receipt.consequences).toContain('request.loseFillFixed');
  });
  it('keeps the health-factor floor to Advanced and every risk warning in Basic', () => {
    const basic = requestReceipt(rangedReview({}, { directWithinLimit: 'over', directCeiling: 900n, partialFill: false }), null, copy);
    expect(basic.rows.map((x) => x.label)).not.toContain('request.rowHfFloor');
    expect(basic.consequences).toEqual(expect.arrayContaining(['request.loseDirectOver', 'request.loseMatchingOff']));
    const advanced = requestReceipt(rangedReview(), null, copy, true);
    expect(advanced.rows.map((x) => x.label)).toContain('request.rowHfFloor');
  });
  it('states an unknown limit and an unread switch rather than promising either', () => {
    const r = rangedReview({}, { directWithinLimit: 'unknown', partialFill: null });
    expect(rangeConsequences(r, null, copy)).toEqual(['request.loseDirectUnknown', 'request.loseMatchingUnread', 'request.loseFillFixed']);
    expect(rangeConsequences(rangedReview({}, { directWithinLimit: 'over', directCeiling: null }), null, copy)).toContain('request.loseDirectOverPlain');
  });
  it('adds nothing for a single-value partial request, and fixes a chosen fill mode', () => {
    expect(rangeConsequences(review(), null, copy)).toEqual([]);
    const aon = review();
    const parsed = { ...aon.draft.parsed, fillMode: 'aon' as const };
    expect(rangeConsequences({ ...aon, draft: { ...aon.draft, parsed } }, null, copy)).toEqual(['request.loseFillFixed']);
  });
  it("names a refused collateral value as 'nothing', never 0%", () => {
    const r = rangedReview({}, { direct: { kind: 'worthless' } });
    expect(requestReceipt(r, null, copy).rows.find((x) => x.label === 'request.rowLtvDirect')?.value).toEqual({ kind: 'text', text: 'request.ltvWorthless' });
  });
  it('turns the ceiling the protocol names into the blocker, by the range it refused', () => {
    const verdict = judgeDryRun({ kind: 'reverted', error: decoded('MaxLendingAboveCeiling', [4_000n, 3_100n]) }, true);
    expect(verdict).toMatchObject({ kind: 'refused', code: 'MaxLendingAboveCeiling', ceiling: 3_100n });
    expect(requestBlockers(rangedReview({ verdict }), null, copy)).toEqual(['request.blockCeilingRange']);
    expect(requestBlockers(review({ verdict }), null, copy)).toEqual(['request.blockCeiling']);
    // A bound on the request, so a shortfall never hides it.
    const short = { kind: 'erc20' as const, funds: { balance: 0n, allowance: 0n }, approvalSteps: 1 };
    expect(requestBlockers(rangedReview({ verdict, holding: short }), null, copy)).toEqual(['request.blockShortfall', 'request.blockCeilingRange']);
  });
  it('names a re-read whose risk moved', () => {
    expect(changedBetween(rangedReview(), rangedReview(), copy)).toBeNull();
    expect(changedBetween(rangedReview(), rangedReview({}, { partialFill: false }), copy)).toBe('accept.changedClass');
    expect(changedBetween(rangedReview(), rangedReview({}, { largest: { kind: 'value', bps: 8_100n } }), copy)).toBe('accept.changedClass');
  });
});

describe('judgeLimit (the direct point, asked as a single-value request)', () => {
  it('reads the limit refusal with its ceiling, a pass or a later pull as within, and anything earlier as unknown', () => {
    expect(judgeLimit({ kind: 'reverted', error: decoded('MaxLendingAboveCeiling', [1_000n, 900n]) }, true)).toEqual({ kind: 'over', ceiling: 900n });
    expect(judgeLimit({ kind: 'reverted', error: revertWith('0xa46539d8') }, false)).toEqual({ kind: 'over', ceiling: null });
    expect(judgeLimit({ kind: 'answered' }, true)).toEqual({ kind: 'within' });
    expect(judgeLimit({ kind: 'reverted', error: revertWith('0xfb8f41b2') }, false)).toEqual({ kind: 'within' });
    expect(judgeLimit({ kind: 'reverted', error: decoded('SanctionedAddress', [account]) }, false)).toEqual({ kind: 'unknown' });
    expect(judgeLimit({ kind: 'unreadable', reason: 'x' }, false)).toEqual({ kind: 'unknown' });
  });
  it('never reads a pull error as within once the allowance covers the collateral', () => {
    expect(judgeLimit({ kind: 'reverted', error: revertWith('0xfb8f41b2') }, true)).toEqual({ kind: 'unknown' });
    expect(judgeLimit({ kind: 'reverted', error: new Error('execution reverted') }, true)).toEqual({ kind: 'unknown' });
  });
});

describe('readLtv', () => {
  const client = (answer: () => Promise<unknown>) => ({ readContract: answer }) as unknown as Parameters<typeof readLtv>[0];
  it("reads the protocol's figure, and names a collateral worth nothing instead of 0%", async () => {
    await expect(
      readLtv(
        client(async () => 6_000n),
        diamond,
        lending,
        1n,
        collateral,
        1n,
      ),
    ).resolves.toEqual({ kind: 'value', bps: 6_000n });
    await expect(
      readLtv(
        client(async () => Promise.reject(decoded('ZeroCollateral', []))),
        diamond,
        lending,
        1n,
        collateral,
        1n,
      ),
    ).resolves.toEqual({ kind: 'worthless' });
    await expect(
      readLtv(
        client(async () => Promise.reject(decoded('ZeroPrice', [collateral]))),
        diamond,
        lending,
        1n,
        collateral,
        1n,
      ),
    ).rejects.toBeTruthy();
  });
});

describe('what a match can lock (OFF-16)', () => {
  it('states the largest match from all the collateral to only the floor for a collateral range', () => {
    const row = requestReceipt(rangedReview(), null, copy).rows.find((x) => x.label === 'request.rowLtvLargest');
    expect(row?.value).toEqual({ kind: 'text', text: 'request.ltvSpan' });
    expect(matchConsequences(rangedReview(), null, copy)).toEqual(['request.loseMatchLocksFloor', 'request.loseMatchKeepsRest']);
  });
  it('says a match may lock less than everything without a collateral range, and warns in Basic', () => {
    const base = rangedReview({}, { largestAtFloor: null });
    const parsed = { ...base.draft.parsed, collateralFloor: base.draft.parsed.collateral };
    const r = { ...base, draft: { ...base.draft, parsed } };
    expect(requestReceipt(r, null, copy).rows.find((x) => x.label === 'request.rowLtvLargest')?.value).toEqual({ kind: 'text', text: 'request.ltvAllLocked' });
    expect(matchConsequences(r, null, copy)).toEqual(['request.loseMatchLocksLess', 'request.loseMatchKeepsRest']);
    // A single-value request can be matched too, so the warning is not a range's alone.
    expect(requestReceipt(review(), null, copy).consequences).toContain('request.loseMatchLocksLess');
  });
  it('drops the risk warning where no loan-to-value applies, and both only where no match can fill it', () => {
    expect(matchConsequences(review({ risk: { ...review().risk, partialFill: false } }), null, copy)).toEqual([]);
    // An unpriced pair has no loan-to-value, but a match still keeps the rest committed to the request.
    expect(matchConsequences(review({ risk: { ...review().risk, start: { kind: 'none' } } }), null, copy)).toEqual(['request.loseMatchKeepsRest']);
    expect(matchConsequences(review({ risk: { ...review().risk, partialFill: null } }), null, copy)).toEqual(['request.loseMatchLocksLess', 'request.loseMatchKeepsRest']);
  });
  it('states a start-of-loan limit that could not be read, never dropping the row', () => {
    const unread = requestReceipt(review({ risk: { ...review().risk, start: { kind: 'unread' } } }), null, copy, true);
    expect(unread.rows.find((x) => x.label === 'request.rowHfFloor')?.value).toEqual({ kind: 'text', text: 'request.hfFloorUnread' });
    const tiered = requestReceipt(review({ risk: { ...review().risk, start: { kind: 'hf', floor: 10n ** 18n, tiered: true } } }), null, copy, true);
    expect(tiered.rows.find((x) => x.label === 'request.rowHfFloor')?.value).toEqual({ kind: 'text', text: 'request.hfFloorTiered' });
    const none = requestReceipt(review({ risk: { ...review().risk, start: { kind: 'none' } } }), null, copy, true);
    expect(none.rows.map((x) => x.label)).not.toContain('request.rowHfFloor');
  });
});
