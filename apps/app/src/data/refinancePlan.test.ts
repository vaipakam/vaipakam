/**
 * #126 slice 3 — the per-loan refinance-request plan. The loan page's
 * refinance form and the batch both check through it, so its refusals and
 * figures are pinned here with every chain read stubbed. The properties
 * that matter for the batch: a loan the chain would refuse is left out
 * with the reason, a read that fails is THAT loan's refusal, the guardrail
 * write is planned only when the caps do not cover the request, and the
 * late re-check leaves out a loan whose bound or spare amount grew or
 * whose statements changed.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PublicClient } from 'viem';
import { copy } from '../content/copy';
import { AssetType, LoanStatus } from '../lib/types';

const DAY = 86_400n;
const reads = vi.hoisted(() => ({
  live: {} as Record<string, unknown>,
  now: 0n,
  caps: { enabled: false, maxRateBps: 0, maxNewExpiry: 0n },
  fees: { treasuryFeeBps: 200, loanInitiationFeeBps: 20, maxOfferDurationDays: 365 },
  grace: 0n,
  payoff: 0n,
  bound: 0n,
  /** When set, the bound as the contract would size it at a request
   *  expiry — so a test can see the clock move it (#3311). */
  boundAt: null as null | ((expiresAt: bigint) => bigint),
  route: 'permit' as 'permit' | 'approval',
  quoteArgs: [] as Array<Record<string, unknown>>,
  sanctioned: false,
  discovery: { kind: 'none' } as Record<string, unknown>,
  saleBlock: null as string | null,
  offsetBlock: null as string | null,
  payloads: [] as unknown[],
}));

vi.mock('../contracts/loanLive', () => ({
  LOAN_STATUS_ACTIVE: 0,
  readLoanLive: vi.fn(async () => reads.live),
  loanEndTimeOf: (live: { endTime: bigint }) => live.endTime,
}));
// #1558 — the payoff figures and the route come from the contract; the
// quote reader is stubbed so the plan's use of them is what is pinned.
vi.mock('../contracts/refinancePayoffPermit', () => ({
  readPayoffRoute: vi.fn(async () => reads.route),
  readPayoffQuote: vi.fn(async (a: Record<string, unknown>) => {
    reads.quoteArgs.push(a);
    const bound = reads.boundAt ? reads.boundAt(a.expiresAt as bigint) : reads.bound;
    return {
      route: a.route,
      payoff: reads.payoff,
      bound,
      // #3042 — the wallet's share today: the payoff less the new loan's
      // net principal, by the real rule over the mocked payoff.
      topUp:
        reads.payoff -
        ((a.requestAmount as bigint) -
          ((a.requestAmount as bigint) * BigInt(a.loanInitiationFeeBps as number)) / 10_000n),
      growth: bound > reads.payoff ? bound - reads.payoff : 0n,
      lastFillable: (a.expiresAt as bigint) - 1n,
      permit: null,
    };
  }),
}));
vi.mock('../contracts/preflights', () => ({
  assertPositionNftHeldLive: vi.fn(async () => undefined),
  assertAssetNotPausedLive: vi.fn(async () => undefined),
  readGraceSecondsLive: vi.fn(async () => reads.grace),
}));
vi.mock('./sanctions', () => ({
  assertWalletNotSanctionedLive: vi.fn(async () => {
    if (reads.sanctioned) throw new Error('wallet sanctioned');
  }),
}));
vi.mock('./fees', () => ({
  readLiveProtocolFees: vi.fn(async () => reads.fees),
}));
vi.mock('./refinanceDiscovery', () => ({
  discoverRefinanceRequest: vi.fn(async () => reads.discovery),
}));
vi.mock('./closeOutPlan', () => ({
  saleSettlementRefusal: vi.fn(async () => reads.saleBlock),
  offsetLockRefusal: vi.fn(async () => reads.offsetBlock),
}));
vi.mock('../lib/offerSchema', () => ({
  toRefinanceOfferPayload: (_live: unknown, loanId: number, opts: unknown) => {
    const payload = { loanId, ...(opts as object) };
    reads.payloads.push(payload);
    return payload;
  },
}));

import {
  REFINANCE_REVIEW_MAX_AGE_SECONDS,
  REQUEST_WINDOW_DAYS,
  checkRefinanceRequest,
  planRefinanceForBatch,
  refinanceCalls,
  refinancePostRefusal,
  refinanceStatements,
  reviewedBoundMoved,
  type RefinanceBatchPlan,
  type RefinanceCtx,
  type RefinanceLoan,
  type RefinanceRequestReady,
} from './refinancePlan';

const HOLDER = '0x00000000000000000000000000000000000000b0' as const;
const ctx: RefinanceCtx = {
  publicClient: {
    getBlock: async () => ({ timestamp: reads.now }),
    readContract: async () => reads.caps,
  } as unknown as PublicClient,
  diamond: '0x000000000000000000000000000000000000d1a0',
  holder: HOLDER,
};
const LOAN = {
  loanId: 7,
  offerId: 3,
  lenderTokenId: '13',
  borrowerTokenId: '14',
  assetType: AssetType.ERC20,
  collateralAssetType: AssetType.ERC20,
  lendingAsset: '0x00000000000000000000000000000000000000a1',
  collateralAsset: '0x00000000000000000000000000000000000000a2',
} as unknown as RefinanceLoan;
const TERMS = { rateBps: 900, durationDays: 30 };
const FEES = { treasuryFeeBps: 200, loanInitiationFeeBps: 20, maxOfferDurationDays: 365 };

type Ready = Extract<RefinanceBatchPlan, { kind: 'ready' }>;

beforeEach(() => {
  reads.now = 100n * DAY;
  reads.live = {
    status: LoanStatus.Active,
    borrower: HOLDER,
    principal: 1_000_000n,
    principalAsset: '0x00000000000000000000000000000000000000a1',
    endTime: 200n * DAY,
    durationDays: 100n,
    periodicInterestCadence: 0,
  };
  reads.caps = { enabled: false, maxRateBps: 0, maxNewExpiry: 0n };
  reads.fees = { ...FEES };
  reads.grace = 3n * DAY;
  reads.payoff = 1_010_000n;
  reads.bound = 1_010_000n;
  reads.boundAt = null;
  reads.route = 'permit';
  reads.quoteArgs = [];
  reads.sanctioned = false;
  reads.discovery = { kind: 'none' };
  reads.saleBlock = null;
  reads.offsetBlock = null;
  reads.payloads = [];
});

describe('checkRefinanceRequest', () => {
  it('plans the request, its guardrails, the payoff, top-up and bound', async () => {
    const plan = (await checkRefinanceRequest(ctx, LOAN, TERMS, FEES)) as RefinanceRequestReady;
    expect(plan.kind).toBe('ready');
    expect(plan.payoff).toBe(1_010_000n);
    // The payoff's interest share plus the 0.2% initiation fee on the
    // new principal: the new loan's net principal pays the rest inside
    // the Diamond (#3042).
    expect(plan.topUp).toBe(10_000n + 2_000n);
    expect(plan.headroom).toBe(0n);
    expect(plan.requestExpiry).toBe(reads.now + REQUEST_WINDOW_DAYS * DAY);
    expect(plan.caps).toEqual({
      rateBps: 900,
      maxNewExpiry: reads.now + (30n + REQUEST_WINDOW_DAYS) * DAY,
    });
    expect(plan.payload).toMatchObject({
      loanId: 7,
      rateBpsMax: 900,
      durationDays: 30,
      consent: true,
      expiresAt: plan.requestExpiry,
    });
    expect(plan.pastDue).toBe(false);
    expect(plan.expiryGraceClamped).toBe(false);
  });

  it('sizes the payoff from the contract for the request’s own expiry, on the route the Diamond routes', async () => {
    const plan = (await checkRefinanceRequest(ctx, LOAN, TERMS, FEES)) as RefinanceRequestReady;
    expect(plan.route).toBe('permit');
    expect(plan.bound).toBe(1_010_000n);
    // The permit expires with the request: its last fillable moment.
    expect(plan.permitDeadline).toBe(plan.requestExpiry - 1n);
    expect(reads.quoteArgs[0]).toMatchObject({
      loanId: 7n,
      offerId: 0n,
      chainNow: reads.now,
      expiresAt: plan.requestExpiry,
      graceSeconds: 3n * DAY,
      route: 'permit',
      // #3042 — what sizes the wallet's share: the request asks for the
      // old principal, at the live fee rate.
      requestAmount: reads.live.principal,
      loanInitiationFeeBps: FEES.loanInitiationFeeBps,
    });
    reads.route = 'approval';
    const bridge = (await checkRefinanceRequest(ctx, LOAN, TERMS, FEES)) as RefinanceRequestReady;
    expect(bridge.route).toBe('approval');
  });

  it('plans no guardrail write when the caps already cover the request', async () => {
    reads.caps = { enabled: true, maxRateBps: 1_000, maxNewExpiry: 10_000n * DAY };
    const plan = (await checkRefinanceRequest(ctx, LOAN, TERMS, FEES)) as RefinanceRequestReady;
    expect(plan.caps).toBeNull();
    expect(refinanceCalls(plan, 99n).map((c) => c.functionName)).toEqual(['createOffer']);
  });

  it('puts the guardrail write before the request it needs, the deadline last on the request', async () => {
    const plan = (await checkRefinanceRequest(ctx, LOAN, TERMS, FEES)) as RefinanceRequestReady;
    expect(refinanceCalls(plan, 99n)).toEqual([
      {
        functionName: 'setAutoRefinanceCaps',
        args: [7n, true, 900, plan.caps!.maxNewExpiry],
      },
      { functionName: 'createOffer', args: [plan.payload, 99n] },
    ]);
  });

  it('states the headroom and a request clamped to the grace end', async () => {
    reads.live = { ...reads.live, endTime: reads.now + 2n * DAY };
    reads.bound = 1_050_000n;
    const plan = (await checkRefinanceRequest(ctx, LOAN, TERMS, FEES)) as RefinanceRequestReady;
    expect(plan.headroom).toBe(40_000n);
    expect(plan.graceEnd).toBe(reads.now + 5n * DAY);
    expect(plan.expiryGraceClamped).toBe(true);
  });

  it('refuses a settled loan, a fallback loan, a transferred position and a loan past grace', async () => {
    reads.live = { ...reads.live, status: LoanStatus.Repaid };
    expect(await checkRefinanceRequest(ctx, LOAN, TERMS, FEES)).toMatchObject({
      kind: 'refused',
      reason: copy.errors.loanAlreadySettled,
    });
    reads.live = { ...reads.live, status: LoanStatus.FallbackPending };
    expect(await checkRefinanceRequest(ctx, LOAN, TERMS, FEES)).toMatchObject({
      reason: copy.refinance.inFallback,
    });
    reads.live = {
      ...reads.live,
      status: LoanStatus.Active,
      borrower: '0x00000000000000000000000000000000000000c0',
    };
    expect(await checkRefinanceRequest(ctx, LOAN, TERMS, FEES)).toMatchObject({
      reason: copy.errors.refinanceNotOriginalBorrower,
    });
    reads.live = { ...reads.live, borrower: HOLDER, endTime: reads.now - 4n * DAY };
    expect(await checkRefinanceRequest(ctx, LOAN, TERMS, FEES)).toMatchObject({
      reason: copy.errors.refinancePastGrace,
    });
  });

  it('marks a fee config that moved since the review', async () => {
    reads.fees = { ...FEES, loanInitiationFeeBps: 30 };
    expect(await checkRefinanceRequest(ctx, LOAN, TERMS, FEES)).toMatchObject({
      kind: 'refused',
      reason: copy.match.termsChanged,
      feesMoved: true,
    });
  });

  it('throws on a preflight refusal', async () => {
    reads.sanctioned = true;
    await expect(checkRefinanceRequest(ctx, LOAN, TERMS, FEES)).rejects.toThrow('sanctioned');
  });
});

// #3311 — the send is judged at the request the review described. Before
// it, the send re-derived the expiry from the live block, so a bound sized
// at the last fillable moment was always a few seconds larger than the
// reviewed one and every submit refused.
describe('checkRefinanceRequest at a reviewed request (#3311)', () => {
  const WINDOW = REQUEST_WINDOW_DAYS * DAY;
  // In grace-free time the payoff at the last fillable moment still grows
  // with every second of interest — the clock alone moves this bound.
  const growingBound = (expiresAt: bigint) => 1_010_000n + (expiresAt - 130n * DAY);

  it('passes a send seconds after the review, posting the reviewed expiry', async () => {
    reads.boundAt = growingBound;
    const review = (await checkRefinanceRequest(ctx, LOAN, TERMS, FEES)) as RefinanceRequestReady;
    reads.now += 30n;
    // The cause, shown: re-derived at the live block the bound has grown.
    const rederived = (await checkRefinanceRequest(ctx, LOAN, TERMS, FEES)) as RefinanceRequestReady;
    expect(rederived.bound).toBeGreaterThan(review.bound);
    const send = (await checkRefinanceRequest(ctx, LOAN, TERMS, FEES, {
      requestExpiry: review.requestExpiry,
    })) as RefinanceRequestReady;
    expect(send.kind).toBe('ready');
    expect(send.bound).toBe(review.bound);
    expect(reviewedBoundMoved(send, review)).toBe(false);
    // Everything the send writes is the reviewed request's.
    expect(send.requestExpiry).toBe(review.requestExpiry);
    expect(send.permitDeadline).toBe(review.permitDeadline);
    expect(send.payload).toMatchObject({ expiresAt: review.requestExpiry });
    expect(send.caps).toEqual({
      rateBps: 900,
      maxNewExpiry: review.requestExpiry + BigInt(TERMS.durationDays) * DAY,
    });
    expect(reads.quoteArgs.at(-1)).toMatchObject({ expiresAt: review.requestExpiry, chainNow: reads.now });
  });

  it('refuses a bound that grew at the reviewed deadline', async () => {
    const review = (await checkRefinanceRequest(ctx, LOAN, TERMS, FEES)) as RefinanceRequestReady;
    reads.now += 30n;
    reads.bound = review.bound + 1n;
    const send = (await checkRefinanceRequest(ctx, LOAN, TERMS, FEES, {
      requestExpiry: review.requestExpiry,
    })) as RefinanceRequestReady;
    expect(send.requestExpiry).toBe(review.requestExpiry);
    expect(reviewedBoundMoved(send, review)).toBe(true);
    // A bound that shrank is fine.
    reads.bound = review.bound - 1n;
    const shrunk = (await checkRefinanceRequest(ctx, LOAN, TERMS, FEES, {
      requestExpiry: review.requestExpiry,
    })) as RefinanceRequestReady;
    expect(reviewedBoundMoved(shrunk, review)).toBe(false);
  });

  it('refuses a payoff route that changed', async () => {
    const review = (await checkRefinanceRequest(ctx, LOAN, TERMS, FEES)) as RefinanceRequestReady;
    reads.route = 'approval';
    const send = (await checkRefinanceRequest(ctx, LOAN, TERMS, FEES, {
      requestExpiry: review.requestExpiry,
    })) as RefinanceRequestReady;
    expect(send.bound).toBe(review.bound);
    expect(reviewedBoundMoved(send, review)).toBe(true);
  });

  it('forces a re-review once the review is older than the stated chain-time age', async () => {
    expect(REFINANCE_REVIEW_MAX_AGE_SECONDS).toBe(600n);
    const review = (await checkRefinanceRequest(ctx, LOAN, TERMS, FEES)) as RefinanceRequestReady;
    const pin = { requestExpiry: review.requestExpiry };
    reads.now = review.requestExpiry - WINDOW + REFINANCE_REVIEW_MAX_AGE_SECONDS;
    expect(await checkRefinanceRequest(ctx, LOAN, TERMS, FEES, pin)).toMatchObject({ kind: 'ready' });
    reads.now += 1n;
    expect(await checkRefinanceRequest(ctx, LOAN, TERMS, FEES, pin)).toMatchObject({
      kind: 'refused',
      reason: copy.refinance.reviewStale(10),
      feesMoved: false,
    });
    expect(reads.payloads).toHaveLength(2);
  });

  it('does not call a review stale when the send’s node is behind the review’s', async () => {
    const review = (await checkRefinanceRequest(ctx, LOAN, TERMS, FEES)) as RefinanceRequestReady;
    reads.now -= 12n;
    const send = (await checkRefinanceRequest(ctx, LOAN, TERMS, FEES, {
      requestExpiry: review.requestExpiry,
    })) as RefinanceRequestReady;
    expect(send.kind).toBe('ready');
    expect(send.payload).toMatchObject({ expiresAt: review.requestExpiry });
  });
});

describe('refinancePostRefusal', () => {
  it('refuses a request on record, open or expired, and a search that cannot answer', async () => {
    reads.discovery = { kind: 'found', open: true };
    expect(await refinancePostRefusal(ctx, LOAN)).toBe(copy.refinance.alreadyOpen);
    expect(await refinancePostRefusal(ctx, LOAN, 'see its page')).toBe('see its page');
    reads.discovery = { kind: 'found', open: false };
    expect(await refinancePostRefusal(ctx, LOAN)).toBe(copy.refinance.expiredBlocksNew);
    reads.discovery = { kind: 'unknown', reason: 'capped' };
    expect(await refinancePostRefusal(ctx, LOAN)).toBe(copy.refinance.cappedBlocks);
    reads.discovery = { kind: 'none' };
    expect(await refinancePostRefusal(ctx, LOAN)).toBeNull();
  });
});

describe('planRefinanceForBatch', () => {
  it('returns the ready request with the loan page’s statements', async () => {
    const plan = (await planRefinanceForBatch(ctx, LOAN, TERMS, FEES)) as Ready;
    expect(plan.kind).toBe('ready');
    expect(plan.notes).toEqual([
      copy.refinance.whenEndsComposed(copy.refinance.expiresAfterDays(30)),
    ]);
  });

  it('states past due, keeping periods current and the end of scheduled interest', async () => {
    reads.live = { ...reads.live, endTime: reads.now - DAY, periodicInterestCadence: 1 };
    const plan = (await planRefinanceForBatch(ctx, LOAN, TERMS, FEES)) as Ready;
    expect(plan.notes.slice(0, 3)).toEqual([
      copy.refinance.graceNote,
      copy.refinance.periodicWarning,
      copy.refinance.cadenceChangeNote,
    ]);
  });

  it('leaves out a rental without reading anything', async () => {
    const plan = await planRefinanceForBatch(
      ctx,
      { ...LOAN, assetType: AssetType.ERC721 },
      TERMS,
      FEES,
    );
    expect(plan).toMatchObject({ kind: 'refused', reason: copy.batchRefinance.ownPageRental });
    expect(reads.payloads).toHaveLength(0);
  });

  it('leaves out a loan with an accepted sale, a request on record or an open offset', async () => {
    reads.saleBlock = 'sale';
    expect(await planRefinanceForBatch(ctx, LOAN, TERMS, FEES)).toMatchObject({ reason: 'sale' });
    reads.saleBlock = null;
    reads.discovery = { kind: 'found', open: true };
    expect(await planRefinanceForBatch(ctx, LOAN, TERMS, FEES)).toMatchObject({
      reason: copy.batchRefinance.ownPageOpenRequest,
    });
    reads.discovery = { kind: 'none' };
    reads.offsetBlock = 'offset';
    expect(await planRefinanceForBatch(ctx, LOAN, TERMS, FEES)).toMatchObject({
      reason: 'offset',
    });
  });

  it('turns a throwing check into that loan’s refusal', async () => {
    reads.sanctioned = true;
    expect(await planRefinanceForBatch(ctx, LOAN, TERMS, FEES)).toMatchObject({
      kind: 'refused',
      loanId: 7,
    });
  });

  it('keeps a loan whose bound shrank, and leaves out one whose bound grew', async () => {
    const reviewed = (await planRefinanceForBatch(ctx, LOAN, TERMS, FEES)) as Ready;
    reads.bound = 1_005_000n;
    expect(await planRefinanceForBatch(ctx, LOAN, TERMS, FEES, reviewed)).toMatchObject({
      kind: 'ready',
    });
    reads.bound = 1_020_000n;
    expect(await planRefinanceForBatch(ctx, LOAN, TERMS, FEES, reviewed)).toMatchObject({
      kind: 'refused',
      reason: copy.batchRefinance.changedSinceReview,
    });
  });

  it('re-checks at the reviewed expiry, so the clock alone leaves nothing out (#3311)', async () => {
    reads.boundAt = (expiresAt) => 1_010_000n + (expiresAt - 130n * DAY);
    const reviewed = (await planRefinanceForBatch(ctx, LOAN, TERMS, FEES)) as Ready;
    reads.now += 45n;
    const late = (await planRefinanceForBatch(ctx, LOAN, TERMS, FEES, reviewed)) as Ready;
    expect(late.kind).toBe('ready');
    expect(late.payload).toMatchObject({ expiresAt: reviewed.requestExpiry });
    expect(late.permitDeadline).toBe(reviewed.permitDeadline);
  });

  it('leaves out a loan whose review is older than the stated age (#3311)', async () => {
    const reviewed = (await planRefinanceForBatch(ctx, LOAN, TERMS, FEES)) as Ready;
    reads.now += REFINANCE_REVIEW_MAX_AGE_SECONDS + 1n;
    expect(await planRefinanceForBatch(ctx, LOAN, TERMS, FEES, reviewed)).toMatchObject({
      kind: 'refused',
      reason: copy.refinance.reviewStale(10),
    });
  });

  it('leaves out a loan whose payoff route changed since the review', async () => {
    const reviewed = (await planRefinanceForBatch(ctx, LOAN, TERMS, FEES)) as Ready;
    reads.route = 'approval';
    expect(await planRefinanceForBatch(ctx, LOAN, TERMS, FEES, reviewed)).toMatchObject({
      kind: 'refused',
      reason: copy.batchRefinance.changedSinceReview,
    });
  });

  it('leaves out a loan whose spare amount grew while its bound held', async () => {
    // In grace the bound is fixed at the grace end while the payoff, and
    // so the spare amount, grows with each day's late fee.
    const reviewed = (await planRefinanceForBatch(ctx, LOAN, TERMS, FEES)) as Ready;
    reads.payoff = reads.payoff + 5_000n;
    expect(await planRefinanceForBatch(ctx, LOAN, TERMS, FEES, reviewed)).toMatchObject({
      kind: 'refused',
      reason: copy.batchRefinance.changedSinceReview,
    });
  });

  it('leaves out a loan whose statements changed since the review', async () => {
    const reviewed = (await planRefinanceForBatch(ctx, LOAN, TERMS, FEES)) as Ready;
    reads.live = { ...reads.live, endTime: reads.now - DAY };
    expect(await planRefinanceForBatch(ctx, LOAN, TERMS, FEES, reviewed)).toMatchObject({
      kind: 'refused',
      reason: copy.batchRefinance.changedSinceReview,
    });
  });
});

describe('refinanceStatements', () => {
  it('is the one list of loan-dependent statements the form and the batch both make', () => {
    expect(
      refinanceStatements({ pastDue: false, periodic: false, expiryGraceClamped: false, graceEnd: 0n }),
    ).toEqual({
      pastDue: null,
      keepPeriodsCurrent: null,
      cadenceChange: null,
      whenEnds: copy.refinance.whenEndsComposed(copy.refinance.expiresAfterDays(30)),
    });
    expect(
      refinanceStatements({ pastDue: true, periodic: true, expiryGraceClamped: false, graceEnd: 0n }),
    ).toMatchObject({
      pastDue: copy.refinance.graceNote,
      keepPeriodsCurrent: copy.refinance.periodicWarning,
      cadenceChange: copy.refinance.cadenceChangeNote,
    });
  });
});
