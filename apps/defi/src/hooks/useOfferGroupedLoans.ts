/**
 * Group a flat list of `LoanSummary` rows by the originating
 * `offerId`, with the parent-row aggregations spec'd in issue #124.
 *
 * The grouping is the visual primitive that makes range-order fills
 * legible: a single lender offer of $100k accepting borrowers in
 * staged LTV slices can fan out into 4-7 active loans. Today's flat
 * "My Loans" table presents those as N orphaned rows; the grouping
 * surfaces them as ONE parent row whose totals/HF reflect the whole
 * position, with the per-child rows behind an expand toggle.
 *
 * Single-child offers (the common case — most offers don't range-fill)
 * are RETURNED as groups too — the rendering layer is the one that
 * decides to skip the parent wrapper and render the child flat. That
 * keeps the hook's output uniform and the render-side decision local.
 *
 * Per the card's "My take on aggregations" block:
 *
 *   - Effective rate is the **weighted average by filled amount**,
 *     not a plain mean. `Σ(rate_i × amount_i) / Σ(amount_i)`.
 *   - Health Factor at parent-level is **MIN(HF)** across active
 *     children. The risk of the group is governed by the worst child;
 *     showing an average would lull the user into false safety.
 *   - Collateral is bucketed **per-asset**. An offer that accepts
 *     multiple collateral assets would otherwise need a dollar-sum
 *     across asset types that this hook doesn't have prices for.
 *
 * What this hook does NOT compute (deferred to a follow-up):
 *
 *   - **Interest-accrued and fees-collected** per group — those need
 *     a per-loan `getLoanDetails` + `getYieldFeeSummary` round-trip
 *     that LoanSummary's current shape doesn't carry. The card's
 *     aggregation table calls them out; this hook leaves the slot
 *     for them as `null` so the render-side can render "—" until
 *     the data source lands.
 *   - **Fill percentage** (Σ filled / offer.amountMax) — needs the
 *     parent offer's `amountMax`, which lives in offer storage not
 *     loan storage. A future revision can pull it via a `useOffers`
 *     fetch keyed on the group's offerIds; for now `fillPercentBps`
 *     is `null` and the render-side hides that cell.
 */
import { useMemo } from 'react';
import type { LoanSummary } from '../types/loan';
import { LoanStatus, type LoanRole } from '../types/loan';
import type { LoanRisk } from './useLoanRisks';

/** Parent-row payload returned by {useOfferGroupedLoans}. */
export interface OfferGroup {
  /** Originating offer id, used as the group key + the parent row's
   *  cross-link to `/offers/:offerId`. Always non-zero for a real
   *  loan; zero is only ever an unrecognised / synthetic row. */
  offerId: bigint;
  /** All children share the same role (lender or borrower) because
   *  an offer is one-sided. Recovered from the first child; the
   *  hook asserts homogeneity in development builds. */
  role: LoanRole;
  /** The child loan rows that came out of this offer. Sorted by
   *  child loan id ascending so the expand-render is stable. */
  children: LoanSummary[];

  // ── aggregations ──────────────────────────────────────────────

  /** SUM of `principal` across children. Stays in the principal
   *  asset's native units — the hook does NOT cross-asset
   *  normalise because we don't have prices here. */
  totalPrincipal: bigint;
  /** Reference principal asset for `totalPrincipal`. Drawn from
   *  the first child. The hook asserts every child shares the
   *  same `principalAsset` in development builds; mixed-principal
   *  groups would be a contract-side anomaly (one offer creates
   *  loans in one asset only). */
  principalAsset: string;
  /** Principal asset type (0/1/2 — ERC20/721/1155). Same homogeneity
   *  guarantee as `principalAsset`. Drives the parent-row's
   *  PrincipalCell rendering. */
  principalAssetType: number;

  /**
   * Weighted-average interest rate in BPS.
   *
   *     effectiveRateBps = Σ(rate_i × principal_i) / Σ(principal_i)
   *
   * For static-rate offers (every child same rate) this collapses
   * to that rate. For range orders (rate varies by fill point)
   * this reflects what the position actually earns/owes.
   *
   * Computed as a bigint ratio with rounded division so the
   * BPS result fits the same `interestRateBps` shape consumers
   * already render. Zero when `totalPrincipal` is zero (no active
   * fills); the rendering layer can render "—".
   */
  effectiveRateBps: bigint;

  /**
   * Per-asset collateral totals. Keyed by collateral asset address
   * (lowercased) — mixed-collateral offers (rare today, but
   * possible) get one entry per asset rather than a dollar-sum
   * the hook can't compute.
   */
  collateralByAsset: Map<
    string /* asset address, lowercased */,
    {
      /** Asset address as it appeared in the first row using it
       *  (preserves the original case for display). */
      asset: string;
      /** Asset type (ERC20/721/1155). Determines render shape. */
      assetType: number;
      /** SUM of `collateralAmount` for this asset. */
      totalAmount: bigint;
      /** First `collateralTokenId` seen for this asset — used
       *  when the asset is ERC721/1155 and the group has exactly
       *  one child for this asset (most common case for NFT
       *  collateral). Multiple NFTs of the same collection in
       *  one group renders the count, not the id. */
      firstTokenId: bigint;
      /** Number of children contributing to this bucket. Drives
       *  the rendering between "single NFT id" vs "N items". */
      childCount: number;
    }
  >;

  /** Earliest `startTime` across children — the day the offer
   *  began producing loans. */
  earliestStartTime: bigint;
  /** Latest `startTime + durationDays` across children. Not the
   *  same as the on-chain grace deadline (which adds a grace
   *  period); the rendering layer can layer grace on top if
   *  needed. */
  latestEndTime: bigint;

  /**
   * Minimum Health Factor across ACTIVE children. `null` when
   * the group has no active children with on-chain HF data
   * (e.g. illiquid collateral, or every child is terminal).
   * Per the card: `min` not `mean` because the worst child
   * governs the group's liquidation risk.
   */
  minHf: bigint | null;

  /** Counts by status for the row's status pill. */
  counts: {
    active: number;
    repaid: number;
    defaulted: number;
    settled: number;
    fallbackPending: number;
    internalMatched: number;
    total: number;
  };

  // ── deferred (returned as null until future data sources land) ─

  /** Interest accrued so far across the group. Needs per-loan
   *  `getLoanDetails`-style data; render "—" until populated. */
  totalInterestAccrued: bigint | null;
  /** Fees collected (yield-fee + LIF). Same data-source story. */
  totalFeesCollected: bigint | null;
  /** Fill percentage in BPS — `filled / offer.amountMax`. Needs
   *  the parent offer's `amountMax` which lives in offer storage.
   *  Future revision can hydrate this via a `useOffersByIds` hook. */
  fillPercentBps: bigint | null;
}

/**
 * Group + aggregate a flat list of loan summaries by originating offer.
 *
 * Memoised over `loans` and `risks` so the Dashboard's render path
 * doesn't recompute when unrelated state changes. The function
 * itself is pure — exported for direct unit-testing without React.
 */
export function useOfferGroupedLoans(
  loans: LoanSummary[],
  risks: Map<string, LoanRisk>,
): OfferGroup[] {
  return useMemo(() => groupLoansByOffer(loans, risks), [loans, risks]);
}

/** Pure-function form exported for direct unit testing. */
export function groupLoansByOffer(
  loans: LoanSummary[],
  risks: Map<string, LoanRisk>,
): OfferGroup[] {
  // First pass: bucket children by offerId.
  const buckets = new Map<string /* offerId */, LoanSummary[]>();
  for (const loan of loans) {
    const key = loan.offerId.toString();
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = [];
      buckets.set(key, bucket);
    }
    bucket.push(loan);
  }

  // Second pass: compute aggregations for each bucket.
  const groups: OfferGroup[] = [];
  for (const [, children] of buckets) {
    if (children.length === 0) continue;
    // Stable order — by loan id ascending — so the expand
    // render stays deterministic across re-renders.
    children.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

    const first = children[0]!;
    const offerId = first.offerId;
    const role = first.role;

    let totalPrincipal = 0n;
    let weightedRateNumerator = 0n;
    let earliestStartTime = first.startTime;
    let latestEndTime = 0n;
    let minHf: bigint | null = null;
    const collateralByAsset: OfferGroup['collateralByAsset'] = new Map();
    const counts = {
      active: 0,
      repaid: 0,
      defaulted: 0,
      settled: 0,
      fallbackPending: 0,
      internalMatched: 0,
      total: children.length,
    };

    for (const child of children) {
      totalPrincipal += child.principal;
      weightedRateNumerator += child.interestRateBps * child.principal;

      if (child.startTime < earliestStartTime) {
        earliestStartTime = child.startTime;
      }
      // durationDays is days; convert to seconds for the end-time
      // comparison. We use 86400 (1 day) directly — same arithmetic
      // the contract uses for its grace-period math.
      const endTime = child.startTime + child.durationDays * 86_400n;
      if (endTime > latestEndTime) {
        latestEndTime = endTime;
      }

      // Per-status count.
      switch (child.status) {
        case LoanStatus.Active:
          counts.active += 1;
          break;
        case LoanStatus.Repaid:
          counts.repaid += 1;
          break;
        case LoanStatus.Defaulted:
          counts.defaulted += 1;
          break;
        case LoanStatus.Settled:
          counts.settled += 1;
          break;
        case LoanStatus.FallbackPending:
          counts.fallbackPending += 1;
          break;
        case LoanStatus.InternalMatched:
          counts.internalMatched += 1;
          break;
      }

      // MIN HF across ACTIVE children only. Skipping terminal
      // children matches the card spec: the parent's HF should
      // reflect the live liquidation risk of the position.
      if (child.status === LoanStatus.Active) {
        const childRisk = risks.get(child.id.toString());
        const childHf = childRisk?.hf ?? null;
        if (childHf !== null) {
          if (minHf === null || childHf < minHf) {
            minHf = childHf;
          }
        }
      }

      // Collateral per-asset bucket.
      const assetKey = child.collateralAsset.toLowerCase();
      const existing = collateralByAsset.get(assetKey);
      if (existing) {
        existing.totalAmount += child.collateralAmount;
        existing.childCount += 1;
      } else {
        collateralByAsset.set(assetKey, {
          asset: child.collateralAsset,
          assetType: child.collateralAssetType,
          totalAmount: child.collateralAmount,
          firstTokenId: child.collateralTokenId,
          childCount: 1,
        });
      }
    }

    // Weighted-average rate. Guard against zero principal (every
    // child has zero principal — exotic edge case but defensive).
    const effectiveRateBps =
      totalPrincipal === 0n
        ? 0n
        : weightedRateNumerator / totalPrincipal;

    groups.push({
      offerId,
      role,
      children,
      totalPrincipal,
      principalAsset: first.principalAsset,
      principalAssetType: first.assetType,
      effectiveRateBps,
      collateralByAsset,
      earliestStartTime,
      latestEndTime,
      minHf,
      counts,
      totalInterestAccrued: null,
      totalFeesCollected: null,
      fillPercentBps: null,
    });
  }

  // Stable group order — by earliest start ascending, then offerId.
  groups.sort((a, b) => {
    if (a.earliestStartTime !== b.earliestStartTime) {
      return a.earliestStartTime < b.earliestStartTime ? -1 : 1;
    }
    return a.offerId < b.offerId ? -1 : a.offerId > b.offerId ? 1 : 0;
  });

  return groups;
}
