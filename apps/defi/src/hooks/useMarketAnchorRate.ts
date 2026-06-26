import { useEffect, useMemo, useState } from 'react';
import type { Address } from 'viem';
import { DIAMOND_ABI_VIEM as DIAMOND_ABI } from '@vaipakam/contracts/abis';
import { batchCalls, encodeBatchCalls } from '@vaipakam/lib/multicall';
import { useDiamondPublicClient, useReadChain } from '../contracts/useDiamond';
import { DEFAULT_CHAIN } from '../contracts/config';
import { useLogIndex } from './useLogIndex';

/** Minimal slice of `getOffer` we read for the anchor — the full struct
 *  is decoded but only these fields drive the suggestion. */
type AnchorOffer = {
  interestRateBps: bigint;
  lendingAsset: string;
  collateralAsset: string;
};

/**
 * #625 WI-1 — suggested-rate floor for the auto-lend intent form.
 *
 * Reuses the exact signal OfferBook's `MarketRateWidget` surfaces: the
 * interest rate of the freshest recently-MATCHED offer on the chosen
 * `(lendingAsset, collateralAsset)` pair. `recentAcceptedOfferIds` is
 * maintained newest-first, so the first pair match is the freshest one.
 * Returned as bps, or `null` when no recent match exists for the pair
 * (a brand-new market) — the form then shows no suggestion and the
 * lender simply sets their own floor.
 *
 * Intended to be mounted LAZILY (only while the intent form is open
 * with both legs chosen) so the underlying log scan in `useLogIndex`
 * never runs on a bare Dashboard load.
 */
export function useMarketAnchorRate(
  lendingAsset: string,
  collateralAsset: string,
): bigint | null {
  const { recentAcceptedOfferIds } = useLogIndex();
  const publicClient = useDiamondPublicClient();
  const activeChain = useReadChain();
  const [recent, setRecent] = useState<AnchorOffer[]>([]);

  const hasPair = !!lendingAsset && !!collateralAsset;
  const enabled = hasPair && recentAcceptedOfferIds.length > 0;

  useEffect(() => {
    // No synchronous reset here — when the pair clears, `hasPair` makes
    // the memo return null regardless of `recent`, and a new pair's
    // fetch overwrites it post-await (keeps react-hooks/set-state-in-effect
    // happy: every setState lands after an await).
    if (!enabled || !publicClient) return;
    let cancelled = false;
    void (async () => {
      try {
        const target = (activeChain.diamondAddress ??
          DEFAULT_CHAIN.diamondAddress) as Address;
        const calls = encodeBatchCalls(
          target,
          DIAMOND_ABI,
          'getOffer',
          recentAcceptedOfferIds.map((id) => [id] as const),
        );
        const decoded = await batchCalls<AnchorOffer>(
          publicClient,
          DIAMOND_ABI,
          'getOffer',
          calls,
        );
        if (cancelled) return;
        setRecent(decoded.filter((d): d is AnchorOffer => d !== null));
      } catch {
        if (!cancelled) setRecent([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [enabled, publicClient, activeChain.diamondAddress, recentAcceptedOfferIds]);

  return useMemo(() => {
    if (!hasPair) return null;
    // If the current index has no recent accepted offers, surface no
    // anchor even if `recent` still holds a previous fetch's offers
    // (the effect's early-return on an emptied id list intentionally
    // leaves `recent` untouched to avoid a synchronous reset-in-effect).
    if (recentAcceptedOfferIds.length === 0) return null;
    const lend = lendingAsset.toLowerCase();
    const coll = collateralAsset.toLowerCase();
    const hit = recent.find(
      (o) =>
        o.lendingAsset?.toLowerCase() === lend &&
        o.collateralAsset?.toLowerCase() === coll,
    );
    return hit ? hit.interestRateBps : null;
  }, [recent, hasPair, recentAcceptedOfferIds, lendingAsset, collateralAsset]);
}
