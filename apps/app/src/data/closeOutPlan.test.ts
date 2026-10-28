/**
 * #126 — the per-loan close-out plan. The page and the batch both plan
 * through it, so its refusals and its pull are pinned here with every
 * chain read stubbed. The property that matters for the batch: a loan
 * that would need something disclosed is left out with the reason, and
 * a read that fails is THAT loan's refusal, never the batch's.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PublicClient } from 'viem';
import { copy } from '../content/copy';
import { AssetType, LoanStatus } from '../lib/types';

const reads = vi.hoisted(() => ({
  live: {} as Record<string, bigint | number | boolean>,
  due: 0n,
  now: 0n,
  grace: 0n,
  sale: 'none' as string,
  refinance: { kind: 'none' } as Record<string, unknown>,
  lock: 0,
  sanctioned: false,
  nftHeld: true,
  tariff: 0n as bigint | 'unreadable',
}));

vi.mock('../contracts/loanLive', () => ({
  LOAN_STATUS_ACTIVE: 0,
  readLoanLive: vi.fn(async () => reads.live),
  readRepaymentDueLive: vi.fn(async () => reads.due),
  loanEndTimeOf: (live: { endTime: bigint }) => live.endTime,
}));
vi.mock('../contracts/preflights', () => ({
  assertPositionNftHeldLive: vi.fn(async () => {
    if (!reads.nftHeld) throw new Error('position NFT moved');
  }),
  readGraceSecondsLive: vi.fn(async () => reads.grace),
}));
vi.mock('./sanctions', () => ({
  assertWalletNotSanctionedLive: vi.fn(async () => {
    if (reads.sanctioned) throw new Error('wallet sanctioned');
  }),
}));
vi.mock('./saleListingHold', () => ({ probeSaleHoldLive: vi.fn(async () => reads.sale) }));
vi.mock('./tariff', () => ({
  readFeeEntitlement: vi.fn(async () => {
    if (reads.tariff === 'unreadable') throw new Error('rpc down');
    return { borrowerTariffPaid: reads.tariff, lenderTariffPaid: 0n };
  }),
}));
vi.mock('./refinanceDiscovery', () => ({
  discoverRefinanceRequest: vi.fn(async () => reads.refinance),
}));

import {
  planCloseOutForBatch,
  planPreclose,
  planRepay,
  type CloseOutCtx,
  type CloseOutLoan,
} from './closeOutPlan';

const DAY = 86_400n;
const ctx: CloseOutCtx = {
  publicClient: {
    getBlock: async () => ({ timestamp: reads.now }),
    readContract: async () => reads.lock,
  } as unknown as PublicClient,
  diamond: '0x000000000000000000000000000000000000d1a0',
  holder: '0x00000000000000000000000000000000000000b0',
};
const LOAN: CloseOutLoan = {
  loanId: 7,
  offerId: 3,
  borrowerTokenId: '14',
  lenderTokenId: '13',
  assetType: AssetType.ERC20,
  collateralAssetType: AssetType.ERC20,
  lendingAsset: '0x00000000000000000000000000000000000000a1',
};

beforeEach(() => {
  reads.now = 100n * DAY;
  reads.live = {
    status: LoanStatus.Active,
    endTime: 130n * DAY,
    startTime: 70n * DAY,
    useFullTermInterest: true,
    durationDays: 60n,
    principal: 1_000_000n,
    interestRateBps: 1_000n,
  };
  reads.due = 1_010_000n;
  reads.grace = 3n * DAY;
  reads.sale = 'none';
  reads.refinance = { kind: 'none' };
  reads.lock = 0;
  reads.sanctioned = false;
  reads.nftHeld = true;
  reads.tariff = 0n;
});

// 2 days of 10% on 1,000,000 plus 1.5% of it.
const PAD = (1_000_000n * 1_000n * 2n) / (365n * 10_000n) + 15_000n;

describe('planRepay', () => {
  it('plans the contract figure plus the day-boundary pad on the live term', async () => {
    expect(await planRepay(ctx, LOAN)).toEqual({
      kind: 'ready',
      loanId: 7,
      action: 'repay',
      functionName: 'repayLoan',
      pull: { token: LOAN.lendingAsset, due: 1_010_000n, approve: 1_010_000n + PAD },
      liveStatus: LoanStatus.Active,
      pastDue: false,
      fullTermInterest: true,
      notes: [],
    });
  });

  it('refuses a settled loan and a loan past grace', async () => {
    reads.live = { ...reads.live, status: LoanStatus.Repaid };
    expect(await planRepay(ctx, LOAN)).toMatchObject({ kind: 'refused', reason: copy.errors.loanAlreadySettled });
    reads.live = { ...reads.live, status: LoanStatus.Active };
    reads.now = 134n * DAY;
    expect(await planRepay(ctx, LOAN)).toMatchObject({ kind: 'refused', reason: copy.errors.pastGrace });
  });

  it('throws when the position NFT has moved', async () => {
    reads.nftHeld = false;
    await expect(planRepay(ctx, LOAN)).rejects.toThrow('position NFT moved');
  });
});

describe('planPreclose', () => {
  it('refuses past grace and on an open offset', async () => {
    reads.now = 134n * DAY;
    expect(await planPreclose(ctx, LOAN)).toMatchObject({ kind: 'refused', reason: copy.errors.preclosePastGrace });
    reads.now = 100n * DAY;
    reads.lock = 1; // LOCK_PRECLOSE_OFFSET
    expect(await planPreclose(ctx, LOAN)).toMatchObject({ kind: 'refused', reason: copy.offset.blockedOtherPaths });
  });

  it('settles a fully paid-down Active loan (due 0) and refuses a settled one', async () => {
    reads.due = 0n;
    expect(await planPreclose(ctx, LOAN)).toMatchObject({ kind: 'ready', pull: { due: 0n, approve: PAD } });
    reads.live = { ...reads.live, status: LoanStatus.Repaid };
    expect(await planPreclose(ctx, LOAN)).toMatchObject({ kind: 'refused', reason: copy.errors.loanAlreadySettled });
  });
});

describe('planCloseOutForBatch', () => {
  it('passes a loan with nothing to disclose', async () => {
    expect(await planCloseOutForBatch(ctx, LOAN, 'repay')).toMatchObject({ kind: 'ready', loanId: 7 });
  });

  it('leaves out a rental', async () => {
    const rental = { ...LOAN, assetType: AssetType.ERC721 };
    expect(await planCloseOutForBatch(ctx, rental, 'repay')).toMatchObject({
      kind: 'refused',
      reason: copy.batchClose.ownPageRental,
    });
  });

  it('leaves out a loan with an accepted sale waiting to complete', async () => {
    reads.sale = 'accepted';
    expect(await planCloseOutForBatch(ctx, LOAN, 'repay')).toMatchObject({
      kind: 'refused',
      reason: copy.saleHold.completionPaused,
    });
  });

  it('leaves out a loan with an open refinance request, and one the search could not answer', async () => {
    reads.refinance = { kind: 'found', open: true };
    expect(await planCloseOutForBatch(ctx, LOAN, 'preclose')).toMatchObject({
      kind: 'refused',
      reason: copy.batchClose.ownPageRefinance,
    });
    reads.refinance = { kind: 'unknown', reason: 'rpc' };
    expect(await planCloseOutForBatch(ctx, LOAN, 'preclose')).toMatchObject({
      kind: 'refused',
      reason: copy.refinance.uncheckedBlocks,
    });
  });

  it('leaves out a loan with an open offset', async () => {
    reads.lock = 1;
    expect(await planCloseOutForBatch(ctx, LOAN, 'repay')).toMatchObject({
      kind: 'refused',
      reason: copy.offset.blockedOtherPaths,
    });
  });

  it('leaves out a loan in its fallback cure', async () => {
    reads.live = { ...reads.live, status: LoanStatus.FallbackPending };
    expect(await planCloseOutForBatch(ctx, LOAN, 'repay')).toMatchObject({
      kind: 'refused',
      reason: copy.batchClose.ownPageFallback,
    });
  });

  it('turns a failed read into that loan\'s refusal', async () => {
    reads.sanctioned = true;
    const plan = await planCloseOutForBatch(ctx, LOAN, 'preclose');
    expect(plan.kind).toBe('refused');
  });

  it('states an early close\'s interest mode, its late fee and a paid tariff', async () => {
    expect(await planCloseOutForBatch(ctx, LOAN, 'preclose')).toMatchObject({
      kind: 'ready',
      notes: [copy.preclose.fullTermNote],
    });
    reads.now = 131n * DAY; // past due, inside grace
    reads.tariff = 5n;
    expect(await planCloseOutForBatch(ctx, LOAN, 'preclose')).toMatchObject({
      kind: 'ready',
      notes: [copy.preclose.fullTermNote, copy.preclose.graceFeeReceiptNote, copy.tariff.precloseNoRefundWarn],
    });
    expect(await planCloseOutForBatch(ctx, LOAN, 'repay')).toMatchObject({ kind: 'ready', notes: [] });
  });

  it('leaves out an early close whose tariff record cannot be read', async () => {
    reads.tariff = 'unreadable';
    expect(await planCloseOutForBatch(ctx, LOAN, 'preclose')).toMatchObject({ kind: 'refused' });
    expect(await planCloseOutForBatch(ctx, LOAN, 'repay')).toMatchObject({ kind: 'ready' });
  });
});
