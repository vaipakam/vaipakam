import { describe, it, expect } from 'vitest';
import type { LoanSummary, LoanRole } from '../types/loan';
import { LoanStatus } from '../types/loan';
import type { LoanRisk } from './useLoanRisks';
import { groupLoansByOffer } from './useOfferGroupedLoans';

/**
 * Issue #124 — Pure-function tests for the offer-grouping math.
 * Doesn't render React, doesn't touch ChainProvider, so unaffected
 * by Issue #85's test-setup gap on apps/defi's component tests.
 */

function makeLoan(overrides: Partial<LoanSummary>): LoanSummary {
  return {
    id: 1n,
    offerId: 1n,
    principal: 1000n * 10n ** 18n,
    principalAsset: '0xaa',
    assetType: 0,
    principalTokenId: 0n,
    interestRateBps: 1000n,
    durationDays: 30n,
    startTime: 1700000000n,
    status: LoanStatus.Active,
    role: 'lender' as LoanRole,
    collateralAsset: '0xbb',
    collateralAmount: 1n * 10n ** 18n,
    collateralAssetType: 0,
    collateralTokenId: 0n,
    lenderTokenId: 0n,
    borrowerTokenId: 0n,
    allowsPartialRepay: false,
    liquidationLtvBpsAtInit: 7500,
    ...overrides,
  };
}

describe('groupLoansByOffer', () => {
  it('groups loans by offerId', () => {
    const loans = [
      makeLoan({ id: 1n, offerId: 10n }),
      makeLoan({ id: 2n, offerId: 10n }),
      makeLoan({ id: 3n, offerId: 20n }),
    ];
    const groups = groupLoansByOffer(loans, new Map());
    expect(groups).toHaveLength(2);
    const offer10 = groups.find((g) => g.offerId === 10n);
    const offer20 = groups.find((g) => g.offerId === 20n);
    expect(offer10?.children).toHaveLength(2);
    expect(offer20?.children).toHaveLength(1);
  });

  it('computes SUM of principal across children', () => {
    const loans = [
      makeLoan({ id: 1n, offerId: 10n, principal: 1000n }),
      makeLoan({ id: 2n, offerId: 10n, principal: 2500n }),
    ];
    const [group] = groupLoansByOffer(loans, new Map());
    expect(group?.totalPrincipal).toBe(3500n);
  });

  it('computes WEIGHTED-AVG rate, not plain mean (per card My-take block)', () => {
    // $1k at 10% APR (1000 bps) + $99k at 5% APR (500 bps)
    // Plain mean would be 7.5% — WRONG.
    // Weighted = (1000*1000 + 99000*500) / (1000 + 99000)
    //          = (1,000,000 + 49,500,000) / 100,000
    //          = 50,500,000 / 100,000 = 505 bps = 5.05%
    const loans = [
      makeLoan({ id: 1n, offerId: 10n, principal: 1000n, interestRateBps: 1000n }),
      makeLoan({ id: 2n, offerId: 10n, principal: 99000n, interestRateBps: 500n }),
    ];
    const [group] = groupLoansByOffer(loans, new Map());
    expect(group?.effectiveRateBps).toBe(505n);
  });

  it('weighted-avg collapses to plain rate when all children share the rate', () => {
    const loans = [
      makeLoan({ id: 1n, offerId: 10n, principal: 1000n, interestRateBps: 800n }),
      makeLoan({ id: 2n, offerId: 10n, principal: 5000n, interestRateBps: 800n }),
      makeLoan({ id: 3n, offerId: 10n, principal: 250n, interestRateBps: 800n }),
    ];
    const [group] = groupLoansByOffer(loans, new Map());
    expect(group?.effectiveRateBps).toBe(800n);
  });

  it('picks MIN(HF) across active children only', () => {
    const loans = [
      makeLoan({ id: 1n, offerId: 10n, status: LoanStatus.Active }),
      makeLoan({ id: 2n, offerId: 10n, status: LoanStatus.Active }),
      // Repaid child with a "worse" HF should NOT influence parent's
      // HF — terminal loans don't carry liquidation risk anymore.
      makeLoan({ id: 3n, offerId: 10n, status: LoanStatus.Repaid }),
    ];
    const risks = new Map<string, LoanRisk>([
      ['1', { ltv: 5000n, hf: 2n * 10n ** 18n }],
      ['2', { ltv: 6000n, hf: 15n * 10n ** 17n }], // 1.5e18
      ['3', { ltv: 9000n, hf: 5n * 10n ** 17n }], // 0.5e18 — Repaid, should be ignored
    ]);
    const [group] = groupLoansByOffer(loans, risks);
    expect(group?.minHf).toBe(15n * 10n ** 17n); // 1.5, not 0.5
  });

  it('returns null minHf when no active children have HF data', () => {
    const loans = [
      makeLoan({ id: 1n, offerId: 10n, status: LoanStatus.Repaid }),
      makeLoan({ id: 2n, offerId: 10n, status: LoanStatus.Settled }),
    ];
    const risks = new Map<string, LoanRisk>([
      ['1', { ltv: 5000n, hf: 2n * 10n ** 18n }],
    ]);
    const [group] = groupLoansByOffer(loans, risks);
    expect(group?.minHf).toBeNull();
  });

  it('buckets collateral per-asset for mixed-collateral groups', () => {
    const loans = [
      makeLoan({ id: 1n, offerId: 10n, collateralAsset: '0xCC', collateralAmount: 100n }),
      makeLoan({ id: 2n, offerId: 10n, collateralAsset: '0xCC', collateralAmount: 200n }),
      makeLoan({ id: 3n, offerId: 10n, collateralAsset: '0xDD', collateralAmount: 5000n }),
    ];
    const [group] = groupLoansByOffer(loans, new Map());
    const buckets = Array.from(group!.collateralByAsset.values());
    expect(buckets).toHaveLength(2);
    const cc = buckets.find((b) => b.asset === '0xCC');
    const dd = buckets.find((b) => b.asset === '0xDD');
    expect(cc?.totalAmount).toBe(300n);
    expect(cc?.childCount).toBe(2);
    expect(dd?.totalAmount).toBe(5000n);
    expect(dd?.childCount).toBe(1);
  });

  it('counts per-status correctly', () => {
    const loans = [
      makeLoan({ id: 1n, offerId: 10n, status: LoanStatus.Active }),
      makeLoan({ id: 2n, offerId: 10n, status: LoanStatus.Active }),
      makeLoan({ id: 3n, offerId: 10n, status: LoanStatus.Repaid }),
      makeLoan({ id: 4n, offerId: 10n, status: LoanStatus.Defaulted }),
    ];
    const [group] = groupLoansByOffer(loans, new Map());
    expect(group?.counts.active).toBe(2);
    expect(group?.counts.repaid).toBe(1);
    expect(group?.counts.defaulted).toBe(1);
    expect(group?.counts.total).toBe(4);
  });

  it('computes earliestStartTime + latestEndTime correctly', () => {
    const loans = [
      makeLoan({ id: 1n, offerId: 10n, startTime: 1000n, durationDays: 30n }),
      makeLoan({ id: 2n, offerId: 10n, startTime: 2000n, durationDays: 60n }),
    ];
    const [group] = groupLoansByOffer(loans, new Map());
    expect(group?.earliestStartTime).toBe(1000n);
    // latestEndTime = max(1000 + 30*86400, 2000 + 60*86400)
    //               = max(2_593_000, 5_186_000) = 5_186_000
    expect(group?.latestEndTime).toBe(2000n + 60n * 86_400n);
  });

  it('single-child group still returned — render-side decides flat vs card', () => {
    const loans = [makeLoan({ id: 1n, offerId: 10n })];
    const groups = groupLoansByOffer(loans, new Map());
    expect(groups).toHaveLength(1);
    expect(groups[0]?.children).toHaveLength(1);
  });

  it('groups sorted by earliestStartTime then offerId', () => {
    const loans = [
      makeLoan({ id: 1n, offerId: 30n, startTime: 1000n }),
      makeLoan({ id: 2n, offerId: 10n, startTime: 500n }),
      makeLoan({ id: 3n, offerId: 20n, startTime: 500n }),
    ];
    const groups = groupLoansByOffer(loans, new Map());
    expect(groups.map((g) => g.offerId)).toEqual([10n, 20n, 30n]);
  });
});
