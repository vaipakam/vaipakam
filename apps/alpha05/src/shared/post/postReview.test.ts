import { describe, expect, it } from 'vitest';
import { createParams, ZERO } from './postModel';
import { changedBetween, judgeDryRun, judgeLimit, needsApproval, readLtv, promptCount, postBlockers, postRiskNeed, type PostReview } from './postReview';
import { postReceipt } from './postReceipt';
import { matchConsequences, rangeConsequences } from './requestReceipt';

type Hex = `0x${string}`;
const lending = '0x00000000000000000000000000000000000000a1' as Hex;
const collateral = '0x00000000000000000000000000000000000000c1' as Hex;
const account = '0x00000000000000000000000000000000000000e1' as Hex;
const diamond = '0x00000000000000000000000000000000000000d1' as Hex;
const other = '0x00000000000000000000000000000000000000f1' as Hex;

/** A copy stand-in that returns the key, so a test reads which line was chosen. */
const copy = { text: (k: string) => k, format: (k: string) => k } as unknown as Parameters<typeof postBlockers>[2];

function review(over: Partial<PostReview> = {}): PostReview {
  const parsed = {
    amount: 1_000n,
    amountMax: 1_000n,
    collateral: 5_000n,
    collateralFloor: 5_000n,
    fillMode: 'partial' as const,
    cadence: 0 as const,
    rateBps: 800n,
    durationDays: 30,
    expiry: '7d' as const,
    fullTerm: true,
    allowsPartialRepay: false,
    tariff: null,
    guardBps: null,
  };
  const draft = { side: 'borrower' as const, parsed, pair: { lending, collateral, leg: { kind: 'erc20' as const } }, expiresAt: 1_000n };
  return {
    identity: 'w',
    account,
    diamond,
    draft,
    params: createParams(parsed, draft.pair, draft.expiresAt, draft.side),
    verdict: { kind: 'needs-approval' },
    lendingClass: 'liquid',
    collateralClass: 'liquid',
    risk: {
      direct: { kind: 'value', bps: 5_000n },
      largest: null,
      largestAtFloor: null,
      directWithinLimit: 'not-asked',
      directCeiling: null,
      start: { kind: 'hf', floor: 1_500_000_000_000_000_000n, tiered: false },
      partialFill: true,
    },
    maxDurationDays: 365n,
    graceSeconds: 86_400n,
    periodGraceSeconds: null,
    tariff: null,
    guardPriced: null,
    lifBps: 20n,
    protocolShareBps: null,
    vault: ZERO,
    holding: { kind: 'erc20', funds: { balance: 10_000n, allowance: 0n }, approvalSteps: 1 },
    readAt: 1,
    ...over,
  };
}

/** `VaultDepositFailed()`'s selector. */
const VAULT_DEPOSIT_FAILED = '0xa81e042f' as Hex;

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
  it("reads the protocol's wrap of a bare pull revert (a lender's WETH) as the pull while the allowance is short, and as a refusal once it covers", () => {
    expect(judgeDryRun({ kind: 'reverted', error: revertWith(VAULT_DEPOSIT_FAILED) }, false)).toEqual({ kind: 'needs-approval' });
    expect(judgeDryRun({ kind: 'reverted', error: revertWith(VAULT_DEPOSIT_FAILED) }, true).kind).toBe('refused');
  });
  it('never excuses a revert once the allowance covers the collateral', () => {
    expect(judgeDryRun({ kind: 'reverted', error: revertWith('0xfb8f41b2') }, true).kind).toBe('refused');
  });
});

describe('postBlockers', () => {
  it('names a guard on a pair that cannot be priced, read alone or refused by the dry run, once', () => {
    const covered = { holding: { kind: 'erc20' as const, funds: { balance: 10_000n, allowance: 10_000n }, approvalSteps: 0 } };
    expect(postBlockers(review({ ...covered, guardPriced: false, verdict: { kind: 'ok' } }), null, copy)).toEqual(['request.blockGuardUnpriced']);
    expect(postBlockers(review({ ...covered, guardPriced: true, verdict: { kind: 'refused', code: 'OfferPriceGuardUnpriced', reason: 'r' } }), null, copy)).toEqual([
      'request.blockGuardUnpriced',
    ]);
    expect(postBlockers(review({ ...covered, guardPriced: true, verdict: { kind: 'ok' } }), null, copy)).toEqual([]);
    expect(changedBetween(review({ guardPriced: true }), review({ guardPriced: false }), copy)).toBe('request.changedGuardPriced');
  });

  it('names a shortfall and keeps the protocol refusal it explains out', () => {
    const r = review({ holding: { kind: 'erc20', funds: { balance: 1_000n, allowance: 0n }, approvalSteps: 1 }, verdict: { kind: 'refused', code: 'X', reason: 'r' } });
    expect(postBlockers(r, null, copy)).toEqual(['request.blockShortfall']);
  });
  it("states the protocol's refusal and an unreadable answer", () => {
    expect(postBlockers(review({ verdict: { kind: 'refused', code: 'X', reason: 'r' } }), null, copy)).toEqual(['request.blockRefused']);
    expect(postBlockers(review({ verdict: { kind: 'unreadable', reason: 'r' } }), null, copy)).toEqual(['request.blockUnread']);
    expect(postBlockers(review(), null, copy)).toEqual([]);
  });
  it('names a risk-access refusal with its step, even beside a shortfall, and reads its need', () => {
    const r = review({ verdict: { kind: 'refused', code: 'RiskTierTooLow', reason: 'x' }, holding: { kind: 'erc20', funds: { balance: 0n, allowance: 0n }, approvalSteps: 1 } });
    expect(postBlockers(r, null, copy)).toEqual(['request.blockShortfall', 'risk.blockTier']);
    expect(postRiskNeed(r)).toBe('tier');
    expect(postRiskNeed(review({ verdict: { kind: 'refused', code: 'IlliquidPairNotConsented', reason: 'x' } }))).toBe('pair-consent');
    expect(postRiskNeed(review())).toBeNull();
  });
  it('names a distrusted leg', () => {
    expect(postBlockers(review({ collateralClass: 'distrusted' }), null, copy)).toEqual(['accept.blockDistrusted']);
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

describe('postReceipt', () => {
  it('counts the approval prompt and states every lifecycle term and the lapse rule', () => {
    const r = review();
    expect(promptCount(r)).toBe(2);
    const receipt = postReceipt(r, null, copy);
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
    const never = postReceipt(review({ draft: { ...r.draft, expiresAt: 0n } }), null, copy);
    expect(never.consequences).toContain('request.loseOpen');
  });
  it('states no loan-to-value for an illiquid leg', () => {
    const receipt = postReceipt(review({ collateralClass: 'illiquid', risk: { ...review().risk, direct: { kind: 'unpriced' } } }), null, copy);
    expect(receipt.consequences).toContain('accept.loseIlliquidCollateral');
    expect(receipt.consequences).not.toContain('accept.loseLiquidation');
  });
});

/** A review of a request locking ERC-721 token #7, as the wallet stands on it. */
function nftReview(state: { owner: Hex | null; approved?: Hex | null; forAll?: boolean }, over: Partial<PostReview> = {}): PostReview {
  const base = review();
  const leg = { kind: 'erc721' as const, tokenId: 7n };
  const parsed = { ...base.draft.parsed, collateral: 1n, collateralFloor: 1n };
  const draft = { ...base.draft, parsed, pair: { lending, collateral, leg } };
  return {
    ...base,
    draft,
    params: createParams(parsed, draft.pair, draft.expiresAt, draft.side),
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
    expect(postBlockers(nftReview({ owner: null }, refused), null, copy)).toEqual(['request.blockNoToken']);
    expect(postBlockers(nftReview({ owner: other }, refused), null, copy)).toEqual(['request.blockNotHeld']);
    expect(postBlockers(nftReview({ owner: account }, refused), null, copy)).toEqual(['request.blockRefused']);
    expect(postBlockers(nftReview({ owner: account }), null, copy)).toEqual([]);
  });
  it('names a move of the token or its approval between reads', () => {
    expect(changedBetween(nftReview({ owner: account }), nftReview({ owner: account }), copy)).toBeNull();
    expect(changedBetween(nftReview({ owner: account }), nftReview({ owner: other }), copy)).toBe('request.changedToken');
    expect(changedBetween(nftReview({ owner: account }), nftReview({ owner: account, approved: diamond }), copy)).toBe('request.changedToken');
  });
  it('locks the token by name with a one-token approval row, and states the in-kind default', () => {
    const receipt = postReceipt(nftReview({ owner: account }), null, copy);
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
function multiReview(state: { balance: bigint; forAll?: boolean }, quantity = 3n, over: Partial<PostReview> = {}): PostReview {
  const base = review();
  const leg = { kind: 'erc1155' as const, tokenId: 7n, quantity };
  const parsed = { ...base.draft.parsed, collateral: quantity, collateralFloor: quantity };
  const draft = { ...base.draft, parsed, pair: { lending, collateral, leg } };
  return {
    ...base,
    draft,
    params: createParams(parsed, draft.pair, draft.expiresAt, draft.side),
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
    expect(postBlockers(multiReview({ balance: 2n }, 3n, refused), null, copy)).toEqual(['request.blockUnits']);
    expect(postBlockers(multiReview({ balance: 3n }, 3n, refused), null, copy)).toEqual(['request.blockRefused']);
    expect(postBlockers(multiReview({ balance: 3n }), null, copy)).toEqual([]);
  });
  it('names a move of the balance or the approval between reads', () => {
    expect(changedBetween(multiReview({ balance: 5n }), multiReview({ balance: 5n }), copy)).toBeNull();
    expect(changedBetween(multiReview({ balance: 5n }), multiReview({ balance: 1n }), copy)).toBe('request.changedToken');
    expect(changedBetween(multiReview({ balance: 1n }), multiReview({ balance: 2n }), copy)).toBe('request.changedToken');
    expect(changedBetween(multiReview({ balance: 5n }), multiReview({ balance: 5n, forAll: true }), copy)).toBe('request.changedToken');
  });
  it('locks the quantity by name with a collection-wide approval row that says it is taken back', () => {
    const receipt = postReceipt(multiReview({ balance: 5n }), null, copy);
    expect(receipt.rows.find((x) => x.label === 'request.rowLock')?.value).toEqual({ kind: 'text', text: 'asset.nft1155' });
    expect(receipt.rows.find((x) => x.label === 'accept.rowApproval')?.value).toEqual({ kind: 'text', text: 'request.approvalOperator' });
    const already = postReceipt(multiReview({ balance: 5n, forAll: true }), null, copy);
    expect(already.rows.find((x) => x.label === 'accept.rowApproval')?.value).toEqual({ kind: 'text', text: 'request.approvalOperatorEnough' });
    expect(receipt.prompts).toBe(3);
  });
  it("classes the token's missing-operator error as the approval's to clear", () => {
    expect(judgeDryRun({ kind: 'reverted', error: revertWith('0xe237d922') }, false)).toEqual({ kind: 'needs-approval' });
  });
});

/** A review of a ranged request: 1,000 to 4,000 against 5,000 locked, 2,000 of
 *  it for the smallest loan. */
function rangedReview(over: Partial<PostReview> = {}, risk: Partial<PostReview['risk']> = {}): PostReview {
  const base = review();
  const parsed = { ...base.draft.parsed, amountMax: 4_000n, collateralFloor: 2_000n };
  const draft = { ...base.draft, parsed };
  return {
    ...base,
    draft,
    params: createParams(parsed, draft.pair, draft.expiresAt, draft.side),
    risk: { ...base.risk, largest: { kind: 'value', bps: 8_000n }, largestAtFloor: { kind: 'value', bps: 16_000n }, directWithinLimit: 'within', ...risk },
    ...over,
  };
}

/** A viem-like decoded custom-error revert. */
const decoded = (errorName: string, args: unknown[]) => Object.assign(new Error('execution reverted'), { cause: { data: { errorName, args } } });

describe('a ranged request (OFF-10 / OFF-16)', () => {
  it('states both ends, the floor and what returns, the fill mode and the matching switch', () => {
    const receipt = postReceipt(rangedReview(), null, copy);
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
    const basic = postReceipt(rangedReview({}, { directWithinLimit: 'over', directCeiling: 900n, partialFill: false }), null, copy);
    expect(basic.rows.map((x) => x.label)).not.toContain('request.rowHfFloor');
    expect(basic.consequences).toEqual(expect.arrayContaining(['request.loseDirectOver', 'request.loseMatchingOff']));
    const advanced = postReceipt(rangedReview(), null, copy, true);
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
    expect(postReceipt(r, null, copy).rows.find((x) => x.label === 'request.rowLtvDirect')?.value).toEqual({ kind: 'text', text: 'request.ltvWorthless' });
  });
  it('turns the ceiling the protocol names into the blocker, by the range it refused', () => {
    const verdict = judgeDryRun({ kind: 'reverted', error: decoded('MaxLendingAboveCeiling', [4_000n, 3_100n]) }, true);
    expect(verdict).toMatchObject({ kind: 'refused', code: 'MaxLendingAboveCeiling', ceiling: 3_100n });
    expect(postBlockers(rangedReview({ verdict }), null, copy)).toEqual(['request.blockCeilingRange']);
    expect(postBlockers(review({ verdict }), null, copy)).toEqual(['request.blockCeiling']);
    // A bound on the request, so a shortfall never hides it.
    const short = { kind: 'erc20' as const, funds: { balance: 0n, allowance: 0n }, approvalSteps: 1 };
    expect(postBlockers(rangedReview({ verdict, holding: short }), null, copy)).toEqual(['request.blockShortfall', 'request.blockCeilingRange']);
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
    const row = postReceipt(rangedReview(), null, copy).rows.find((x) => x.label === 'request.rowLtvLargest');
    expect(row?.value).toEqual({ kind: 'text', text: 'request.ltvSpan' });
    expect(matchConsequences(rangedReview(), null, copy)).toEqual(['request.loseMatchLocksFloor', 'request.loseMatchKeepsRest']);
  });
  it('says a match may lock less than everything without a collateral range, and warns in Basic', () => {
    const base = rangedReview({}, { largestAtFloor: null });
    const parsed = { ...base.draft.parsed, collateralFloor: base.draft.parsed.collateral };
    const r = { ...base, draft: { ...base.draft, parsed } };
    expect(postReceipt(r, null, copy).rows.find((x) => x.label === 'request.rowLtvLargest')?.value).toEqual({ kind: 'text', text: 'request.ltvAllLocked' });
    expect(matchConsequences(r, null, copy)).toEqual(['request.loseMatchLocksLess', 'request.loseMatchKeepsRest']);
    // A single-value request can be matched too, so the warning is not a range's alone.
    expect(postReceipt(review(), null, copy).consequences).toContain('request.loseMatchLocksLess');
  });
  it('drops the risk warning where no loan-to-value applies, and both only where no match can fill it', () => {
    expect(matchConsequences(review({ risk: { ...review().risk, partialFill: false } }), null, copy)).toEqual([]);
    // An unpriced pair has no loan-to-value, but a match still keeps the rest committed to the request.
    expect(matchConsequences(review({ risk: { ...review().risk, start: { kind: 'none' } } }), null, copy)).toEqual(['request.loseMatchKeepsRest']);
    expect(matchConsequences(review({ risk: { ...review().risk, partialFill: null } }), null, copy)).toEqual(['request.loseMatchLocksLess', 'request.loseMatchKeepsRest']);
  });
  it('states a start-of-loan limit that could not be read, never dropping the row', () => {
    const unread = postReceipt(review({ risk: { ...review().risk, start: { kind: 'unread' } } }), null, copy, true);
    expect(unread.rows.find((x) => x.label === 'request.rowHfFloor')?.value).toEqual({ kind: 'text', text: 'request.hfFloorUnread' });
    const tiered = postReceipt(review({ risk: { ...review().risk, start: { kind: 'hf', floor: 10n ** 18n, tiered: true } } }), null, copy, true);
    expect(tiered.rows.find((x) => x.label === 'request.rowHfFloor')?.value).toEqual({ kind: 'text', text: 'request.hfFloorTiered' });
    const none = postReceipt(review({ risk: { ...review().risk, start: { kind: 'none' } } }), null, copy, true);
    expect(none.rows.map((x) => x.label)).not.toContain('request.rowHfFloor');
  });
});

describe('an interest schedule (OFF-14)', () => {
  const scheduled = (cadence: 0 | 1 | 2 | 3 | 4, over: Partial<PostReview> = {}, base = review()): PostReview => {
    const parsed = { ...base.draft.parsed, cadence };
    const draft = { ...base.draft, parsed };
    return { ...base, draft, params: createParams(parsed, draft.pair, draft.expiresAt, draft.side), ...over };
  };
  const row = (r: PostReview, label: string, advanced = false) => postReceipt(r, null, copy, advanced).rows.find((x) => x.label === label);

  it('states interest at repayment as one bound line, with no schedule consequence', () => {
    const r = scheduled(0);
    expect(row(r, 'accept.rowSchedule')?.value).toEqual({ kind: 'text', text: 'accept.scheduleNone' });
    expect(row(r, 'request.rowPeriod')).toBeUndefined();
    expect(postReceipt(r, null, copy).consequences).not.toContain('request.loseCadenceFixed');
  });
  it('states the schedule, each period, its grace and the sale a missed period brings, in Basic', () => {
    const r = scheduled(1, { periodGraceSeconds: 86_400n });
    expect(r.params.periodicInterestCadence).toBe(1);
    expect(row(r, 'accept.rowSchedule')?.value).toEqual({ kind: 'text', text: 'accept.scheduleEvery' });
    expect(row(r, 'request.rowPeriod')?.binding).toBe(true);
    expect(row(r, 'request.rowPeriodGrace')?.binding).toBe(false);
    expect(row(r, 'request.rowPeriodSettle')).toBeUndefined();
    expect(postReceipt(r, null, copy).consequences).toEqual(expect.arrayContaining(['request.loseCadence', 'request.loseCadenceFixed']));
  });
  it('labels what is owed as the whole term with instalments counted, not as what is left at the due date', () => {
    expect(row(scheduled(0), 'accept.rowOwe')).toBeDefined();
    expect(row(scheduled(1), 'accept.rowOwe')).toBeUndefined();
    expect(row(scheduled(1), 'accept.rowOweTotal')?.binding).toBe(true);
    const ranged = scheduled(1, {}, rangedReview());
    expect(row(ranged, 'request.rowOweDirectTotal')).toBeDefined();
    expect(row(ranged, 'request.rowOweLargestTotal')).toBeDefined();
    expect(row(ranged, 'request.rowOweDirect')).toBeUndefined();
  });
  it('says an unread grace instead of a figure, and states the keeper posture in Advanced only', () => {
    const r = scheduled(2);
    expect(row(r, 'request.rowPeriodGrace')?.value).toEqual({ kind: 'text', text: 'request.periodGraceUnread' });
    expect(postReceipt(r, null, copy).consequences).toContain('request.loseCadenceUnread');
    expect(postReceipt(r, null, copy, true).rows.find((x) => x.label === 'request.rowPeriodSettle')?.value).toEqual({ kind: 'text', text: 'request.settleUnknown' });
    expect(postReceipt(r, null, copy, true, 'present').rows.find((x) => x.label === 'request.rowPeriodSettle')?.value).toEqual({ kind: 'text', text: 'request.settleArmed' });
  });
  it('states each period at both ends of a range', () => {
    const r = scheduled(1, {}, rangedReview());
    expect(row(r, 'request.rowPeriodDirect')).toBeDefined();
    expect(row(r, 'request.rowPeriodLargest')).toBeDefined();
  });
  it("turns the protocol's schedule refusal into a blocker that says why", () => {
    const verdict = judgeDryRun({ kind: 'reverted', error: decoded('CadenceNotAllowed', [1, 30n, 5n, 1000n]) }, true);
    expect(verdict).toMatchObject({ kind: 'refused', code: 'CadenceNotAllowed', schedule: { kind: 'below-threshold', principal: 5n, threshold: 1000n } });
    expect(postBlockers(scheduled(1, { verdict }), null, copy, 'USD')).toEqual(['request.blockSchedule']);
    const off = judgeDryRun({ kind: 'reverted', error: decoded('PeriodicInterestDisabled', []) }, false);
    expect(off).toMatchObject({ kind: 'refused', schedule: { kind: 'switch-off' } });
  });
  it('names a re-read whose period grace moved', () => {
    expect(changedBetween(scheduled(1, { periodGraceSeconds: 86_400n }), scheduled(1, { periodGraceSeconds: 172_800n }), copy)).toBe('request.changedConfig');
  });
});

describe('the fill mode row', () => {
  it('is left out for one amount at the default mode, which the whole-amount row already states', () => {
    const labels = postReceipt(review(), null, copy).rows.map((x) => x.label);
    expect(labels).toContain('request.rowWhole');
    expect(labels).not.toContain('request.rowFill');
  });
});

describe('the Full fee tariff (OFF-22)', () => {
  const E = 10n ** 18n;
  const withTariff = (over: { allowDowngrade?: boolean; maxCStar?: bigint; enabled?: boolean | null; freeVpfi?: bigint | null } = {}): PostReview => {
    const base = review();
    const choice = { maxCStar: over.maxCStar ?? 6n * E, allowDowngrade: over.allowDowngrade ?? false };
    const parsed = { ...base.draft.parsed, tariff: choice };
    const quote = { cStar: 5n * E, numeraireOk: true };
    return {
      ...base,
      draft: { ...base.draft, parsed },
      tariff: {
        choice,
        read: {
          enabled: over.enabled === undefined ? true : over.enabled,
          smallest: quote,
          largest: quote,
          liquid: true,
          freeVpfi: over.freeVpfi === undefined ? 10n * E : over.freeVpfi,
        },
        why: {},
      },
    };
  };
  const labels = (r: PostReview) => postReceipt(r, null, copy).rows.map((x) => x.label);

  it('adds nothing without the tariff', () => {
    expect(labels(review())).not.toContain('request.rowTariff');
    expect(promptCount(review())).toBe(2);
  });
  it('states the choice, the switch, the tariff, the ceiling, the rule and the free VPFI, and counts the arm prompt', () => {
    const r = withTariff();
    for (const k of ['request.rowTariff', 'request.rowTariffSwitch', 'request.rowTariffQuote', 'request.rowTariffCeiling', 'request.rowTariffFail', 'request.rowTariffVault'])
      expect(labels(r)).toContain(k);
    const rows = postReceipt(r, null, copy).rows;
    expect(rows.find((x) => x.label === 'request.rowTariffCeiling')?.binding).toBe(true);
    expect(rows.find((x) => x.label === 'request.rowTariffQuote')?.binding).toBe(false);
    expect(promptCount(r)).toBe(3);
    expect(postReceipt(r, null, copy).consequences).toEqual(expect.arrayContaining(['request.loseTariffPaid', 'request.loseTariffLif', 'request.loseTariffGap']));
  });
  it('blocks when every loan would be refused, and warns instead when loans may open without it', () => {
    expect(postBlockers(withTariff({ enabled: false }), null, copy)).toContain('request.blockTariffEvery');
    expect(postBlockers(withTariff({ maxCStar: E }), null, copy)).toContain('request.blockTariffEvery');
    const open = withTariff({ enabled: false, allowDowngrade: true });
    expect(postBlockers(open, null, copy)).not.toContain('request.blockTariffEvery');
    expect(postReceipt(open, null, copy).consequences).toContain('request.loseTariffOffOpen');
  });
  it('states a vault short of the tariff as the rule chosen, and an unread vault as unknown', () => {
    expect(postReceipt(withTariff({ freeVpfi: E }), null, copy).consequences).toContain('request.loseTariffVaultAllRefuse');
    expect(postReceipt(withTariff({ freeVpfi: E, allowDowngrade: true }), null, copy).consequences).toContain('request.loseTariffVaultAllOpen');
    expect(postReceipt(withTariff({ freeVpfi: null }), null, copy).consequences).toContain('request.loseTariffUnread');
    expect(postBlockers(withTariff({ freeVpfi: E }), null, copy)).not.toContain('request.blockTariffEvery');
  });
  it('names a moved tariff read on a re-check', () => {
    expect(changedBetween(withTariff(), withTariff({ freeVpfi: E }), copy)).toBe('request.changedTariff');
    expect(changedBetween(withTariff(), withTariff(), copy)).toBeNull();
  });
});

/** A lender's own offer: posting locks the amount lent, not the collateral. */
function lenderReview(over: Partial<PostReview> = {}): PostReview {
  const base = review();
  const draft = { ...base.draft, side: 'lender' as const };
  return { ...base, draft, params: createParams(draft.parsed, draft.pair, draft.expiresAt, 'lender'), protocolShareBps: 200n, ...over };
}

describe('a lender posting an offer', () => {
  const labels = (r: PostReview) => postReceipt(r, null, copy).rows.map((x) => x.label);

  it('measures the approval and the shortfall against the amount lent, not the collateral', () => {
    // The base wallet holds 10,000 of the stake; the offer lends 1,000 and asks for 5,000 collateral.
    const short = lenderReview({ holding: { kind: 'erc20', funds: { balance: 999n, allowance: 0n }, approvalSteps: 1 } });
    expect(postBlockers(short, null, copy)).toEqual(['lendOffer.blockShortfall']);
    const enough = lenderReview({ holding: { kind: 'erc20', funds: { balance: 1_000n, allowance: 1_000n }, approvalSteps: 0 } });
    expect(needsApproval(enough)).toBe(false);
    expect(postBlockers(enough, null, copy)).toEqual([]);
    // The same allowance would not cover a borrower's 5,000 collateral.
    expect(needsApproval(review({ holding: enough.holding }))).toBe(true);
  });

  it('names a refusal and a change as the offer, and never the collateral ceiling remedy', () => {
    const refused = lenderReview({ verdict: { kind: 'refused', code: 'MaxLendingAboveCeiling', reason: 'r', ceiling: 1n } });
    expect(postBlockers(refused, null, copy)).toEqual(['lendOffer.blockRefused']);
    expect(changedBetween(lenderReview(), lenderReview({ verdict: { kind: 'ok' } }), copy)).toBe('lendOffer.changedVerdict');
    expect(changedBetween(lenderReview(), lenderReview({ protocolShareBps: 300n }), copy)).toBe('request.changedConfig');
  });

  it("states what locks, what the borrower must lock, the protocol's share as today's figure, and the lender's consequences", () => {
    const r = postReceipt(lenderReview(), null, copy);
    const lock = r.rows.find((x) => x.label === 'lendOffer.rowLock')!;
    expect(lock.movesOut).toBe(true);
    expect(lock.value).toMatchObject({ kind: 'amount', asset: lending, amount: 1_000n });
    expect(r.rows.find((x) => x.label === 'lendOffer.rowCollateral')!.value).toMatchObject({ asset: collateral, amount: 5_000n });
    expect(r.rows.find((x) => x.label === 'lendAccept.rowShare')!.binding).toBe(false);
    expect(r.rows.find((x) => x.label === 'lendAccept.rowBack')!.binding).toBe(false);
    expect(labels(lenderReview())).not.toContain('request.rowLock');
    expect(labels(lenderReview())).not.toContain('request.rowReceive');
    expect(r.consequences).toEqual(
      expect.arrayContaining(['lendOffer.loseLocked', 'lendOffer.loseTaken', 'lendOffer.loseMatch', 'lendAccept.loseDefault', 'lendAccept.losePosition', 'lendOffer.loseBinding']),
    );
    expect(r.consequences).not.toContain('accept.loseDefault');
    expect(r.title).toBe('lendOffer.title');
  });

  it('says an unread share is unread, never zero, and drops the figure built on it', () => {
    const r = postReceipt(lenderReview({ protocolShareBps: null }), null, copy);
    expect(r.rows.find((x) => x.label === 'lendAccept.rowShare')!.value).toMatchObject({ text: 'lendOffer.shareUnread' });
    expect(r.rows.map((x) => x.label)).not.toContain('lendAccept.rowBack');
  });

  it('states the matching switch in every state: on, off and unread', () => {
    const on = postReceipt(lenderReview(), null, copy);
    expect(on.rows.find((x) => x.label === 'lendOffer.rowMatching')?.value).toEqual({ kind: 'text', text: 'lendOffer.matchingOn' });
    const off = postReceipt(lenderReview({ risk: { ...review().risk, partialFill: false } }), null, copy);
    expect(off.consequences).toContain('lendOffer.loseMatchOff');
    expect(off.consequences).not.toContain('lendOffer.loseMatch');
    expect(off.rows.find((x) => x.label === 'lendOffer.rowMatching')?.value).toEqual({ kind: 'text', text: 'lendOffer.matchingOff' });
    const unread = postReceipt(lenderReview({ risk: { ...review().risk, partialFill: null } }), null, copy);
    expect(unread.consequences).toContain('lendOffer.loseMatchUnread');
    expect(unread.rows.find((x) => x.label === 'lendOffer.rowMatching')?.value).toEqual({ kind: 'text', text: 'request.matchingUnread' });
  });
});

describe('a lending offer with parts (OFF-10 / OFF-11)', () => {
  /** The whole amount 1,000, lent in parts of at least 250, against 5,000 of collateral. */
  function partsReview(over: Partial<PostReview> = {}): PostReview {
    const base = lenderReview();
    const parsed = { ...base.draft.parsed, amount: 250n, amountMax: 1_000n };
    const draft = { ...base.draft, parsed };
    return { ...base, draft, params: createParams(parsed, draft.pair, draft.expiresAt, 'lender'), ...over };
  }

  it('sizes every figure on the whole amount a direct take borrows, and states the smallest part and the share of collateral it asks', () => {
    const r = postReceipt(partsReview(), null, copy);
    const row = (label: string) => r.rows.find((x) => x.label === label);
    expect(row('lendOffer.rowLock')!.value).toMatchObject({ amount: 1_000n });
    expect(row('lendOffer.rowAmount')!.value).toMatchObject({ amount: 1_000n });
    expect(row('lendOffer.rowPartMin')!.value).toMatchObject({ amount: 250n });
    expect(row('request.rowWhole')!.value).toMatchObject({ text: 'lendOffer.rangeFill' });
    expect(row('request.rowFill')!.value).toMatchObject({ text: 'request.fillModePartial' });
    expect(row('lendOffer.rowCollateralWhole')!.value).toMatchObject({ amount: 5_000n });
    expect(row('lendOffer.rowCollateralPart')!.value).toMatchObject({ amount: 1_250n });
    expect(row('lendOffer.rowCollateral')).toBeUndefined();
    // 0.2% of the whole 1,000 is 2; a part would have shown 0.
    expect(row('lendAccept.rowFee')!.value).toMatchObject({ amount: 2n });
    expect(row('lendOffer.rowBorrowerGetsWhole')!.value).toMatchObject({ amount: 998n });
    expect(row('lendOffer.rowInterestWhole')).toBeDefined();
    expect(row('lendOffer.rowBackWhole')).toBeDefined();
    expect(row('lendOffer.rowLtvAny')).toBeDefined();
  });

  it('states the parts, the switch, the end of a direct take, the share of collateral and the fixed fill mode', () => {
    const r = postReceipt(partsReview(), null, copy);
    expect(r.consequences).toEqual(
      expect.arrayContaining(['lendOffer.loseRangeParts', 'lendOffer.loseRangeMatch', 'lendOffer.loseRangeNoDirect', 'lendOffer.loseRangeShare', 'lendOffer.loseFillFixed']),
    );
    expect(r.consequences).not.toContain('lendOffer.loseMatch');
    const off = postReceipt(partsReview({ risk: { ...review().risk, partialFill: false } }), null, copy);
    expect(off.consequences).toContain('lendOffer.loseRangeMatchOff');
    const unread = postReceipt(partsReview({ risk: { ...review().risk, partialFill: null } }), null, copy);
    expect(unread.consequences).toContain('lendOffer.loseRangeMatchUnread');
  });

  it('fixes a chosen fill mode on a single amount too, and states it', () => {
    const r = postReceipt(lenderReview({ draft: { ...lenderReview().draft, parsed: { ...lenderReview().draft.parsed, fillMode: 'aon' } } }), null, copy);
    expect(r.rows.find((x) => x.label === 'request.rowFill')!.value).toMatchObject({ text: 'request.fillModeAon' });
    expect(r.consequences).toEqual(expect.arrayContaining(['lendOffer.loseMatch', 'lendOffer.loseFillFixed']));
    expect(postReceipt(lenderReview(), null, copy).consequences).not.toContain('lendOffer.loseFillFixed');
  });

  it("turns the protocol's collateral floor into the lender's blocker, with the least collateral it asks", () => {
    const verdict = judgeDryRun({ kind: 'reverted', error: decoded('MinCollateralBelowFloor', [4_000n, 4_500n]) }, true);
    expect(verdict).toMatchObject({ kind: 'refused', code: 'MinCollateralBelowFloor', minCollateral: 4_500n });
    expect(postBlockers(partsReview({ verdict }), null, copy)).toEqual(['lendOffer.blockCollateralFloor']);
    // A request is never told to ask for more collateral.
    expect(postBlockers(review({ verdict, holding: { kind: 'erc20', funds: { balance: 10_000n, allowance: 10_000n }, approvalSteps: 0 } }), null, copy)).toEqual([
      'request.blockRefused',
    ]);
  });
});

describe("a lending offer's interest schedule and Full fee tariff (OFF-14 / OFF-22)", () => {
  const E = 10n ** 18n;
  /** The whole amount 1,000, optionally in parts of at least 250, with a monthly schedule. */
  function scheduledOffer(parts: boolean, over: Partial<PostReview> = {}): PostReview {
    const base = lenderReview();
    const parsed = { ...base.draft.parsed, cadence: 1 as const, ...(parts ? { amount: 250n, amountMax: 1_000n } : {}) };
    const draft = { ...base.draft, parsed };
    return { ...base, draft, params: createParams(parsed, draft.pair, draft.expiresAt, 'lender'), periodGraceSeconds: 86_400n, ...over };
  }
  function tariffOffer(over: { allowDowngrade?: boolean; enabled?: boolean } = {}): PostReview {
    const base = scheduledOffer(true);
    const choice = { maxCStar: 6n * E, allowDowngrade: over.allowDowngrade ?? false };
    const parsed = { ...base.draft.parsed, cadence: 0 as const, tariff: choice };
    return {
      ...base,
      draft: { ...base.draft, parsed },
      tariff: {
        choice,
        read: { enabled: over.enabled ?? true, smallest: { cStar: E, numeraireOk: true }, largest: { cStar: 4n * E, numeraireOk: true }, liquid: true, freeVpfi: 10n * E },
        why: {},
      },
    };
  }

  it('states each period on all of it and on the smallest part, and words a missed period as paid to the lender', () => {
    const r = postReceipt(scheduledOffer(true), null, copy, true, 'present');
    const row = (label: string) => r.rows.find((x) => x.label === label);
    expect(r.rows.find((x) => x.label === 'accept.rowSchedule')!.value).toMatchObject({ text: 'accept.scheduleEvery' });
    expect(row('lendOffer.rowPeriodWhole')?.binding).toBe(true);
    expect(row('lendOffer.rowPeriodPart')?.binding).toBe(true);
    expect(row('request.rowPeriodDirect')).toBeUndefined();
    expect(row('request.rowPeriodSettle')!.value).toMatchObject({ text: 'request.settleArmed' });
    expect(row('lendOffer.rowInterestWholeTotal')).toBeDefined();
    expect(row('lendOffer.rowInterestWhole')).toBeUndefined();
    expect(r.consequences).toEqual(expect.arrayContaining(['lendOffer.loseCadence', 'lendOffer.loseCadenceFixed']));
    expect(r.consequences).not.toContain('request.loseCadence');
  });

  it('states one period figure without parts, and the whole term as a total with instalments counted', () => {
    const r = postReceipt(scheduledOffer(false), null, copy);
    expect(r.rows.find((x) => x.label === 'request.rowPeriod')).toBeDefined();
    expect(r.rows.find((x) => x.label === 'lendAccept.rowInterestTotal')).toBeDefined();
    expect(r.rows.find((x) => x.label === 'lendAccept.rowInterestDue')).toBeUndefined();
    expect(postReceipt(scheduledOffer(false, { periodGraceSeconds: null }), null, copy).consequences).toContain('lendOffer.loseCadenceUnread');
  });

  it("states the tariff at the smallest part and at the whole amount, with what it gives a lender and the offer's gap", () => {
    const r = postReceipt(tariffOffer(), null, copy);
    const labels = r.rows.map((x) => x.label);
    expect(labels).toEqual(expect.arrayContaining(['request.rowTariff', 'request.rowTariffSmallest', 'request.rowTariffLargest', 'request.rowTariffCeiling']));
    expect(r.rows.find((x) => x.label === 'request.rowTariff')!.value).toMatchObject({ text: 'lendOffer.tariffArmedAfter' });
    expect(r.consequences).toEqual(expect.arrayContaining(['lendOffer.loseTariffPaid', 'lendOffer.loseTariffYield', 'lendOffer.loseTariffHolder', 'lendOffer.loseTariffGap']));
    expect(r.consequences).not.toContain('request.loseTariffLif');
    expect(promptCount(tariffOffer())).toBe(3);
  });

  it("refuses in the offer's words when every loan would be refused", () => {
    const off = tariffOffer({ enabled: false });
    expect(postBlockers(off, null, copy)).toContain('lendOffer.blockTariffEvery');
    expect(postReceipt(off, null, copy).consequences).toContain('lendOffer.loseTariffOffRefuse');
    const open = tariffOffer({ enabled: false, allowDowngrade: true });
    expect(postBlockers(open, null, copy)).not.toContain('lendOffer.blockTariffEvery');
    expect(postReceipt(open, null, copy).consequences).toContain('request.loseTariffOffOpen');
  });
});
