/**
 * #126 slice 3 — the per-loan refinance-request plan. The loan page's
 * refinance form and the batch both check through it, so its refusals and
 * figures are pinned here with every chain read stubbed. The properties
 * that matter for the batch: a loan the chain would refuse is left out
 * with the reason, a read that fails is THAT loan's refusal, the guardrail
 * write is planned only when the caps do not cover the request, and the
 * late re-check leaves out a loan whose bound grew or whose statements
 * changed.
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
  approval: 0n,
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
  refinancePayoffOf: () => reads.payoff,
  refinanceApprovalOf: () => reads.approval,
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
  REQUEST_WINDOW_DAYS,
  checkRefinanceRequest,
  planRefinanceForBatch,
  refinanceCalls,
  refinancePostRefusal,
  refinanceStatements,
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
  reads.approval = 1_010_000n;
  reads.sanctioned = false;
  reads.discovery = { kind: 'none' };
  reads.saleBlock = null;
  reads.offsetBlock = null;
  reads.payloads = [];
});

describe('checkRefinanceRequest', () => {
  it('plans the request, its guardrails, the payoff, top-up and approval', async () => {
    const plan = (await checkRefinanceRequest(ctx, LOAN, TERMS, FEES)) as RefinanceRequestReady;
    expect(plan.kind).toBe('ready');
    expect(plan.payoff).toBe(1_010_000n);
    // The payoff's interest share plus the 0.2% initiation fee on the
    // new principal, which arrives in the same transaction.
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

  it('plans no guardrail write when the caps already cover the request', async () => {
    reads.caps = { enabled: true, maxRateBps: 1_000, maxNewExpiry: 10_000n * DAY };
    const plan = (await checkRefinanceRequest(ctx, LOAN, TERMS, FEES)) as RefinanceRequestReady;
    expect(plan.caps).toBeNull();
    expect(refinanceCalls(plan).map((c) => c.functionName)).toEqual(['createOffer']);
  });

  it('puts the guardrail write before the request it needs', async () => {
    const plan = (await checkRefinanceRequest(ctx, LOAN, TERMS, FEES)) as RefinanceRequestReady;
    expect(refinanceCalls(plan)).toEqual([
      {
        functionName: 'setAutoRefinanceCaps',
        args: [7n, true, 900, plan.caps!.maxNewExpiry],
      },
      { functionName: 'createOffer', args: [plan.payload] },
    ]);
  });

  it('states the headroom and a request clamped to the grace end', async () => {
    reads.live = { ...reads.live, endTime: reads.now + 2n * DAY };
    reads.approval = 1_050_000n;
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
    reads.approval = 1_005_000n;
    expect(await planRefinanceForBatch(ctx, LOAN, TERMS, FEES, reviewed)).toMatchObject({
      kind: 'ready',
    });
    reads.approval = 1_020_000n;
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
