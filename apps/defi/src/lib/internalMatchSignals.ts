import type { LoanSummary } from '../types/loan';

/** LTV (in BPS) below the loan's liquidation threshold at which the
 *  Dashboard surfaces a "near-liquidation, awaiting internal match"
 *  warning. Borrowers see this BEFORE their loan crosses into the
 *  internal-match-only priority window — so they have time to top
 *  up collateral or repay before a bot matches them out. Matches
 *  §B.2.2 from `docs/internal/PendingTasks-2026-05-14.md`. */
export const NEAR_INTERNAL_MATCH_WINDOW_BPS = 500; // 5% LTV runway

/**
 * Returns `true` when the loan is within
 * `NEAR_INTERNAL_MATCH_WINDOW_BPS` of its snapshotted per-tier
 * liquidation threshold (but still below it — so no liquidator
 * path is yet open). The Dashboard renders a CTA chip beside the
 * loan row when this fires so borrowers can act before the match
 * window opens.
 *
 * Returns `false` when:
 * - The loan lacks a snapshotted threshold (legacy diamonds —
 *   liquidationLtvBpsAtInit === 0).
 * - The loan's current LTV isn't available (oracle outage / no
 *   live LTV feed).
 * - The loan's current LTV is already at or above the threshold
 *   (different banner applies — see ClaimActionBar / the
 *   "approaching liquidation" inline copy).
 */
export function isNearInternalMatchWindow(
  loan: Pick<LoanSummary, 'liquidationLtvBpsAtInit'>,
  currentLtvBps: bigint | number | null,
): boolean {
  if (currentLtvBps === null) return false;
  const ltv = Number(currentLtvBps);
  const floor = loan.liquidationLtvBpsAtInit;
  if (floor === 0) return false; // no snapshot (legacy / illiquid)
  return ltv >= floor - NEAR_INTERNAL_MATCH_WINDOW_BPS && ltv < floor;
}
