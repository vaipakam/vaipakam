import { useCallback, useEffect, useState } from 'react';
import type { Address } from 'viem';
import { useDiamondRead } from '../contracts/useDiamond';
import { beginStep } from '../lib/journeyLog';

const STALE_MS = 30_000;

/**
 * Per-user dashboard headline read — backs the Dashboard page's
 * scalar cards (rewards pending, VPFI tier, claim counts, side-
 * specific loan counts).
 *
 * One on-chain `eth_call` to
 * `MetricsDashboardFacet.getUserDashboardSnapshot(user)` replaces
 * ~5 separate hook fetches the legacy implementation issued
 * (`useInteractionRewards`,
 * `useUserVPFI`, `useVPFIDiscountConsent`, plus the per-side
 * counts derived from `useUserLoans` + `useMyOffers`).
 *
 * Paginated lists (active loans, offers, claimables) are fetched
 * separately by their dedicated hooks — this hook returns ONLY the
 * always-small scalars per AnalyticalGettersDesign §3.1 / D1.
 *
 * Cache is keyed on the user address so the cache survives wallet
 * switching without a full reload (per-user mini-store).
 */
export interface DashboardSnapshot {
  vaultVpfiBalance: bigint;
  vpfiTier: number;
  interactionRewardsPending: bigint;
  vpfiDiscountConsented: boolean;
  lenderLoanCount: number;
  borrowerLoanCount: number;
  activeOfferCount: number;
  filledOfferCount: number;
  lenderClaimableCount: number;
  borrowerClaimableCount: number;
  fetchedAt: number;
}

const perUserCache = new Map<string, { data: DashboardSnapshot; at: number }>();

export function useDashboardSnapshot(user: Address | null) {
  const diamond = useDiamondRead();
  const cacheKey = user?.toLowerCase() ?? '';
  const [snap, setSnap] = useState<DashboardSnapshot | null>(
    perUserCache.get(cacheKey)?.data ?? null,
  );
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);

  const load = useCallback(async () => {
    if (!user) {
      setSnap(null);
      setLoading(false);
      return;
    }
    const cached = perUserCache.get(cacheKey);
    if (cached && Date.now() - cached.at < STALE_MS) {
      setSnap(cached.data);
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    const step = beginStep({
      area: 'dashboard',
      flow: 'useDashboardSnapshot',
      step: 'getUserDashboardSnapshot',
    });
    try {
      // Solidity returns a struct; ethers / viem decode it as an
      // object with named fields. Cast through `unknown` to dodge
      // the JSON-derived ABI's wide return shape.
      const raw = await (
        diamond as unknown as {
          getUserDashboardSnapshot: (u: Address) => Promise<{
            vaultVpfiBalance: bigint;
            vpfiTier: number;
            interactionRewardsPending: bigint;
            vpfiDiscountConsented: boolean;
            lenderLoanCount: number;
            borrowerLoanCount: number;
            activeOfferCount: number;
            filledOfferCount: number;
            lenderClaimableCount: number;
            borrowerClaimableCount: number;
          }>;
        }
      ).getUserDashboardSnapshot(user);

      const next: DashboardSnapshot = {
        vaultVpfiBalance: BigInt(raw.vaultVpfiBalance ?? 0),
        vpfiTier: Number(raw.vpfiTier ?? 0),
        interactionRewardsPending: BigInt(raw.interactionRewardsPending ?? 0),
        vpfiDiscountConsented: Boolean(raw.vpfiDiscountConsented),
        lenderLoanCount: Number(raw.lenderLoanCount ?? 0),
        borrowerLoanCount: Number(raw.borrowerLoanCount ?? 0),
        activeOfferCount: Number(raw.activeOfferCount ?? 0),
        filledOfferCount: Number(raw.filledOfferCount ?? 0),
        lenderClaimableCount: Number(raw.lenderClaimableCount ?? 0),
        borrowerClaimableCount: Number(raw.borrowerClaimableCount ?? 0),
        fetchedAt: Date.now(),
      };
      perUserCache.set(cacheKey, { data: next, at: Date.now() });
      setSnap(next);
      step.success({
        note: `tier=${next.vpfiTier} loans(L/B)=${next.lenderLoanCount}/${next.borrowerLoanCount}`,
      });
    } catch (err) {
      setError(err as Error);
      step.failure(err);
    } finally {
      setLoading(false);
    }
  }, [diamond, user, cacheKey]);

  useEffect(() => {
    load();
  }, [load]);

  const reload = useCallback(async () => {
    perUserCache.delete(cacheKey);
    await load();
  }, [load, cacheKey]);

  return { snapshot: snap, loading, error, reload };
}

/** Test-only — clears the per-user cache so a fresh fetch always fires. */
export function __clearDashboardSnapshotCache() {
  perUserCache.clear();
}
