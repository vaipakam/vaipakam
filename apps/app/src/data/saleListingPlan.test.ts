/**
 * #126 slice 2 — the per-loan sale-listing plan. The loan page's listing
 * form and the batch both check through it, so its refusals are pinned
 * here with every chain read stubbed. The properties that matter for the
 * batch: a loan the chain would refuse is left out with the reason, a
 * read that fails is THAT loan's refusal, and the late re-check keeps the
 * reviewed figures and leaves out a loan whose statements changed.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ContractFunctionRevertedError, encodeErrorResult, type PublicClient } from 'viem';
import { DIAMOND_ABI_VIEM } from '@vaipakam/contracts/abis';
import { copy } from '../content/copy';
import { AssetType, LoanStatus } from '../lib/types';
import { TxNotSettledError } from '../contracts/ownReceipt';

const reads = vi.hoisted(() => ({
  live: {} as Record<string, unknown>,
  now: 0n,
  sanctioned: false,
  nftHeld: true,
  paused: false,
  lenderMode: 0 as number | 'unreadable',
  quote: { minSellerNet: 900n, maxHeld: 0n } as { minSellerNet: bigint; maxHeld: bigint },
  quotes: 0,
  simulate: null as unknown,
  simulated: [] as unknown[],
}));

vi.mock('../contracts/loanLive', () => ({
  LOAN_STATUS_ACTIVE: 0,
  MIN_SALE_LISTING_SECONDS: 3_600n,
  readLoanLive: vi.fn(async () => reads.live),
  loanEndTimeOf: (live: { endTime: bigint }) => live.endTime,
}));
vi.mock('../contracts/preflights', () => ({
  assertPositionNftHeldLive: vi.fn(async () => {
    if (!reads.nftHeld) throw new Error('position NFT moved');
  }),
  assertAssetNotPausedLive: vi.fn(async () => {
    if (reads.paused) throw new Error('asset paused');
  }),
}));
vi.mock('./sanctions', () => ({
  assertWalletNotSanctionedLive: vi.fn(async () => {
    if (reads.sanctioned) throw new Error('wallet sanctioned');
  }),
}));
vi.mock('./loanSalePending', () => ({
  saleSettlementNow: vi.fn(() => 42n),
}));
vi.mock('./sellerBoundsQuote', () => ({
  readSellerBoundsQuote: vi.fn(async () => {
    reads.quotes += 1;
    return { ...reads.quote, quotedExpiry: 0n, quotedAt: 0n };
  }),
}));
vi.mock('./tariff', () => ({
  FEE_MODE_FULL: 2,
  readFeeEntitlement: vi.fn(async () => {
    if (reads.lenderMode === 'unreadable') throw new Error('rpc down');
    return { lenderMode: reads.lenderMode };
  }),
}));

import {
  boundListingArgs,
  checkSaleListing,
  planSaleListingForBatch,
  reviewedBoundsMoved,
  saleListingNotes,
  type SaleListingCtx,
  type SaleListingLoan,
  type SaleListingPlan,
} from './saleListingPlan';

const DAY = 86_400n;
const ctx: SaleListingCtx = {
  publicClient: {
    getBlock: async () => ({ timestamp: reads.now }),
    simulateContract: async (args: unknown) => {
      reads.simulated.push(args);
      if (reads.simulate) throw reads.simulate;
      return { result: undefined };
    },
  } as unknown as PublicClient,
  diamond: '0x000000000000000000000000000000000000d1a0',
  holder: '0x00000000000000000000000000000000000000b0',
};
const LOAN: SaleListingLoan = {
  loanId: 7,
  lenderTokenId: '13',
  assetType: AssetType.ERC20,
  collateralAssetType: AssetType.ERC20,
  lendingAsset: '0x00000000000000000000000000000000000000a1',
  collateralAsset: '0x00000000000000000000000000000000000000a2',
};
const TERMS = { rateBps: 1_000, listingSeconds: 7n * DAY };
const BOUNDS = { minSellerNet: 900n, maxHeld: 0n };

const revert = (errorName: string, args: readonly unknown[]) =>
  new ContractFunctionRevertedError({
    abi: DIAMOND_ABI_VIEM,
    data: encodeErrorResult({ abi: DIAMOND_ABI_VIEM, errorName, args } as never),
    functionName: 'createLoanSaleOfferBound',
  });

beforeEach(() => {
  reads.now = 100n * DAY;
  reads.live = {
    status: LoanStatus.Active,
    endTime: 130n * DAY,
    interestRateBps: 1_000n,
    sellerClaimOnSale: 0n,
  };
  reads.sanctioned = false;
  reads.nftHeld = true;
  reads.paused = false;
  reads.lenderMode = 0;
  reads.quote = { minSellerNet: 900n, maxHeld: 0n };
  reads.quotes = 0;
  reads.simulate = null;
  reads.simulated = [];
});

describe('checkSaleListing', () => {
  it('passes, simulating the exact bound listing with consent given', async () => {
    expect(await checkSaleListing(ctx, LOAN, TERMS, BOUNDS)).toBeNull();
    expect(reads.simulated).toHaveLength(1);
    expect(reads.simulated[0]).toMatchObject({
      functionName: 'createLoanSaleOfferBound',
      args: [7n, 1_000, true, 7n * DAY, 900n, 0n],
      account: ctx.holder,
    });
  });

  it('throws on the preflight refusals: sanctions, the NFT moved, a paused asset', async () => {
    reads.sanctioned = true;
    await expect(checkSaleListing(ctx, LOAN, TERMS, BOUNDS)).rejects.toThrow('sanctioned');
    reads.sanctioned = false;
    reads.nftHeld = false;
    await expect(checkSaleListing(ctx, LOAN, TERMS, BOUNDS)).rejects.toThrow('moved');
    reads.nftHeld = true;
    reads.paused = true;
    await expect(checkSaleListing(ctx, LOAN, TERMS, BOUNDS)).rejects.toThrow('paused');
  });

  it('refuses a loan no longer active, matured, or too close to maturity, before simulating', async () => {
    reads.live = { ...reads.live, status: LoanStatus.Repaid };
    expect(await checkSaleListing(ctx, LOAN, TERMS, BOUNDS)).toEqual({
      reason: copy.errors.loanAlreadySettled,
      boundsMoved: false,
    });
    reads.live = { ...reads.live, status: LoanStatus.Active, endTime: reads.now };
    expect((await checkSaleListing(ctx, LOAN, TERMS, BOUNDS))?.reason).toBe(
      copy.errors.saleListingMatured,
    );
    reads.live = { ...reads.live, endTime: reads.now + 3_599n };
    expect((await checkSaleListing(ctx, LOAN, TERMS, BOUNDS))?.reason).toBe(
      copy.errors.saleListingTooCloseToMaturity,
    );
    expect(reads.simulated).toHaveLength(0);
  });

  it('marks a refusal of the reviewed figures as moved, and words the cooldown', async () => {
    reads.simulate = revert('ListingFloorBelowReviewed', [800n, 900n]);
    expect((await checkSaleListing(ctx, LOAN, TERMS, BOUNDS))?.boundsMoved).toBe(true);
    reads.simulate = revert('SaleRelistCooldownActive', [1_800_000_000n]);
    const cooldown = await checkSaleListing(ctx, LOAN, TERMS, BOUNDS);
    expect(cooldown?.boundsMoved).toBe(false);
    expect(cooldown?.reason).toContain(copy.errors.saleRelistCooldownActive('').slice(0, 12));
  });
});

describe('reviewedBoundsMoved', () => {
  it('reads a mined-reverted listing as moved, and other unsettled ends as not', () => {
    const hash = `0x${'ab'.repeat(32)}` as const;
    expect(reviewedBoundsMoved(new TxNotSettledError('reverted', hash, 'x'))).toBe(true);
    expect(reviewedBoundsMoved(new TxNotSettledError('cancelled', hash, 'x'))).toBe(false);
    expect(reviewedBoundsMoved(revert('ListingHeldAboveReviewed', [5n, 1n]))).toBe(true);
    expect(reviewedBoundsMoved(new Error('rpc'))).toBe(false);
  });
});

describe('boundListingArgs', () => {
  it('always sends consent as given', () => {
    expect(boundListingArgs(3, TERMS, { minSellerNet: 1n, maxHeld: 2n })).toEqual([
      3n,
      1_000,
      true,
      7n * DAY,
      1n,
      2n,
    ]);
  });
});

describe('planSaleListingForBatch', () => {
  it('quotes, checks and returns the figures to review', async () => {
    reads.quote = { minSellerNet: 950n, maxHeld: 10n };
    const plan = await planSaleListingForBatch(ctx, LOAN, TERMS);
    expect(plan).toEqual({
      kind: 'ready',
      loanId: 7,
      bounds: { minSellerNet: 950n, maxHeld: 10n },
      settlementNow: 42n,
      notes: [],
    });
    expect(reads.simulated[0]).toMatchObject({ args: [7n, 1_000, true, 7n * DAY, 950n, 10n] });
  });

  it('leaves out an NFT-collateral loan without reading anything', async () => {
    const plan = await planSaleListingForBatch(
      ctx,
      { ...LOAN, collateralAssetType: AssetType.ERC721 },
      TERMS,
    );
    expect(plan).toMatchObject({ kind: 'refused', reason: copy.batchSale.ownPageShape });
    expect(reads.quotes).toBe(0);
  });

  it('leaves out a loan whose fee record or interest ledger cannot be read', async () => {
    reads.lenderMode = 'unreadable';
    expect(await planSaleListingForBatch(ctx, LOAN, TERMS)).toMatchObject({ kind: 'refused' });
    reads.lenderMode = 0;
    reads.live = { ...reads.live, sellerClaimOnSale: undefined };
    expect(await planSaleListingForBatch(ctx, LOAN, TERMS)).toMatchObject({
      kind: 'refused',
      reason: copy.loanSale.floorUnavailable,
    });
  });

  it('turns a throwing check into that loan’s refusal', async () => {
    reads.nftHeld = false;
    expect(await planSaleListingForBatch(ctx, LOAN, TERMS)).toMatchObject({
      kind: 'refused',
      loanId: 7,
    });
  });

  it('states the Full mode travelling and a rate above the loan’s own', async () => {
    reads.lenderMode = 2;
    const plan = await planSaleListingForBatch(ctx, LOAN, { ...TERMS, rateBps: 1_200 });
    expect(plan).toMatchObject({
      kind: 'ready',
      notes: [copy.tariff.nftTravelNote, copy.loanSale.sweetenNote],
    });
  });

  it('re-checks against the reviewed figures without quoting again', async () => {
    const reviewed = (await planSaleListingForBatch(ctx, LOAN, TERMS)) as Extract<
      SaleListingPlan,
      { kind: 'ready' }
    >;
    reads.quotes = 0;
    reads.quote = { minSellerNet: 1n, maxHeld: 999n };
    const late = await planSaleListingForBatch(ctx, LOAN, TERMS, reviewed);
    expect(late).toMatchObject({ kind: 'ready', bounds: reviewed.bounds });
    expect(reads.quotes).toBe(0);
  });

  it('leaves out a loan whose statements changed since the review', async () => {
    const reviewed = (await planSaleListingForBatch(ctx, LOAN, TERMS)) as Extract<
      SaleListingPlan,
      { kind: 'ready' }
    >;
    reads.lenderMode = 2;
    expect(await planSaleListingForBatch(ctx, LOAN, TERMS, reviewed)).toMatchObject({
      kind: 'refused',
      reason: copy.batchSale.changedSinceReview,
    });
  });

  it('carries the moved-figures flag on a late refusal', async () => {
    const reviewed = (await planSaleListingForBatch(ctx, LOAN, TERMS)) as Extract<
      SaleListingPlan,
      { kind: 'ready' }
    >;
    reads.simulate = revert('ListingFloorBelowReviewed', [800n, 900n]);
    expect(await planSaleListingForBatch(ctx, LOAN, TERMS, reviewed)).toMatchObject({
      kind: 'refused',
      boundsMoved: true,
    });
  });
});

describe('saleListingNotes', () => {
  it('is empty with nothing to state', () => {
    expect(saleListingNotes({ fullModeTravels: false, aboveLoanRate: false })).toEqual([]);
  });
});
