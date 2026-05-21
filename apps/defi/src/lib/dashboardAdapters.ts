/**
 * Adapters from the on-chain `LoanWithRiskAndSide` shape returned by
 * `MetricsDashboardFacet.getUserDashboardLoansBothSides` to the
 * frontend's existing `LoanSummary` + `LoanRisk` value objects.
 *
 * The contract returns the full {LibVaipakam.Loan} struct + LTV +
 * HF + a side tag. The Dashboard table renders against the trim
 * `LoanSummary` shape that the legacy `useUserLoans` hook emits.
 * This module bridges the two so Stage A can swap the data source
 * without touching every render-side ref to `loan.role` or
 * `risks.get(id)`.
 */
import type { Address } from 'viem';
import type { LoanWithRiskAndSide } from '../hooks/useDashboardLoansBothSides';
import type { LoanRisk } from '../hooks/useLoanRisks';
import { type LoanSummary, type LoanStatus, type LoanRole } from '../types/loan';

interface ContractLoanShape {
  id: bigint;
  // Originating offer's id — always present on chain (every loan was
  // accepted from an offer). The Dashboard surfaces this to group
  // children of a range-order parent under one row.
  offerId: bigint;
  principal: bigint;
  principalAsset: Address;
  assetType: number;
  // Contract calls this `tokenId`; LoanSummary calls it `principalTokenId`.
  tokenId: bigint;
  interestRateBps: bigint;
  durationDays: bigint;
  startTime: bigint;
  status: number;
  collateralAsset: Address;
  collateralAmount: bigint;
  collateralAssetType: number;
  collateralTokenId: bigint;
  lenderTokenId: bigint;
  borrowerTokenId: bigint;
  allowsPartialRepay: boolean;
  liquidationLtvBpsAtInit?: number | bigint;
}

/**
 * Adapt one on-chain row to the trim `LoanSummary` shape the
 * Dashboard table renders. The `borrowerSide` boolean tag lifts
 * to the legacy `'lender' | 'borrower'` discriminator.
 */
export function loanWithRiskAndSideToSummary(
  row: LoanWithRiskAndSide,
): LoanSummary {
  // The on-chain return decodes as a tuple-struct; cast through
  // the local interface for type safety on the field reads.
  const loan = row.loan as unknown as ContractLoanShape;
  const role: LoanRole = row.borrowerSide ? 'borrower' : 'lender';
  return {
    id: loan.id,
    offerId: loan.offerId,
    principal: loan.principal,
    principalAsset: loan.principalAsset,
    assetType: Number(loan.assetType),
    principalTokenId: loan.tokenId,
    interestRateBps: loan.interestRateBps,
    durationDays: loan.durationDays,
    startTime: loan.startTime,
    status: Number(loan.status) as LoanStatus,
    role,
    collateralAsset: loan.collateralAsset,
    collateralAmount: loan.collateralAmount,
    collateralAssetType: Number(loan.collateralAssetType),
    collateralTokenId: loan.collateralTokenId,
    lenderTokenId: loan.lenderTokenId,
    borrowerTokenId: loan.borrowerTokenId,
    allowsPartialRepay: Boolean(loan.allowsPartialRepay),
    // Defaults to 0 on legacy diamonds that don't yet carry the
    // per-loan snapshot (the field landed in PR2 of the internal-
    // match work). Consumers treat 0 as "no near-liquidation
    // banner" — exactly the same render as today for those loans.
    liquidationLtvBpsAtInit: Number(loan.liquidationLtvBpsAtInit ?? 0),
  };
}

/**
 * Build the `Map<loanId, LoanRisk>` shape `useLoanRisks` would
 * have returned, sourced from the inline LTV / HF that the new
 * contract method already includes per row. Mirrors the legacy
 * hook's `null`-on-illiquid convention: the contract returns 0
 * for both fields when there's no oracle, so we map 0n → null
 * to preserve the gauge's "no data" rendering.
 */
export function loansToRiskMap(
  rows: LoanWithRiskAndSide[],
): Map<string, LoanRisk> {
  const map = new Map<string, LoanRisk>();
  for (const row of rows) {
    const loan = row.loan as unknown as ContractLoanShape;
    map.set(loan.id.toString(), {
      ltv: row.ltvBps > 0n ? row.ltvBps : null,
      hf: row.healthFactor > 0n ? row.healthFactor : null,
    });
  }
  return map;
}
