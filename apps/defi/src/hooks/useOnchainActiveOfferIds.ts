/**
 * On-chain "all active offer IDs" — reads `MetricsFacet.getActiveOffersCount`
 * and pages `getActiveOffersPaginated(offset, limit)` to assemble the
 * authoritative active-offer-id list straight from the Diamond's
 * `s.activeOfferIdsList`.
 *
 * Why it exists: the OfferBook's fallback path, when the central
 * indexer (D1) is unreachable, used to fall through to the in-browser
 * `eth_getLogs` scan (`useLogIndex`'s `openOfferIds`) — slow on public
 * RPCs and a genesis-scan footgun. With this hook the OfferBook instead
 * sources the open-view id list from the on-chain getter: one
 * `eth_call` for the count + ⌈count/200⌉ for the slices, no log scan.
 * That matters in particular for a static / IPFS deploy where there is
 * no D1 at all — the OfferBook's open view then runs purely on
 * contract getters (`getActiveOffersPaginated` for the ids →
 * `getOffer` per id). `useLogIndex` stays as a deeper fallback for
 * while this getter hasn't resolved yet.
 *
 * `enabled` gates the fetch entirely — the OfferBook passes `true` only
 * once the indexer has *confirmed* failed (`source === 'fallback'`), so
 * a healthy-indexer page never spends the extra RPC. Re-reads on the
 * shared `warm` watermark bump (a new offer / loan landed) and on
 * tab-focus.
 */
import { useEffect, useState } from 'react';
import { type Address } from 'viem';
import { DIAMOND_ABI_VIEM } from '@vaipakam/contracts/abis';
import { useDiamondPublicClient, useReadChain } from '../contracts/useDiamond';
import { useLiveWatermark } from './useLiveWatermark';
import { watermarkPolicy } from './watermarkPolicy';

/** Page size for `getActiveOffersPaginated` — matches the indexer's
 *  PAGE_LIMIT so behaviour is consistent across the two paths. */
const PAGE = 200;
/** Hard cap: 25 pages × 200 = 5000 active offers. If the book ever
 *  genuinely exceeds that, lift the cap (and reconsider whether a
 *  wallet-less browser should be paging the whole book on-chain). */
const MAX_PAGES = 25;

export function useOnchainActiveOfferIds(enabled: boolean): {
  ids: bigint[] | null;
  loading: boolean;
} {
  const chain = useReadChain();
  const diamond = chain.diamondAddress;
  const publicClient = useDiamondPublicClient();
  const { version } = useLiveWatermark(watermarkPolicy('warm'));
  const [ids, setIds] = useState<bigint[] | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    // Disabled (indexer healthy) — don't fetch. We surface `null` for
    // `ids` via the return below rather than resetting state here, so
    // there's no synchronous setState in the effect body.
    if (!enabled || !diamond) return;
    let cancelled = false;
    async function load() {
      setLoading(true);
      try {
        const count = (await publicClient.readContract({
          address: diamond as Address,
          abi: DIAMOND_ABI_VIEM,
          functionName: 'getActiveOffersCount',
        })) as bigint;
        const total = Number(count);
        const out: bigint[] = [];
        for (let p = 0; p < MAX_PAGES && out.length < total; p++) {
          const slice = (await publicClient.readContract({
            address: diamond as Address,
            abi: DIAMOND_ABI_VIEM,
            functionName: 'getActiveOffersPaginated',
            args: [BigInt(p * PAGE), BigInt(PAGE)],
          })) as readonly bigint[];
          if (cancelled) return;
          if (slice.length === 0) break;
          out.push(...slice);
        }
        if (!cancelled) setIds(out);
      } catch {
        // RPC blip — keep whatever `ids` had (or null). The OfferBook
        // falls to `useLogIndex.openOfferIds` while `ids` is null.
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    void load();
    function onVisible() {
      if (document.visibilityState === 'visible') void load();
    }
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      cancelled = true;
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [enabled, diamond, publicClient, version]);

  // When disabled, present `null` (no on-chain list) regardless of any
  // value left in state from a prior enabled spell — the consumer then
  // falls back to its log-scanned list.
  return enabled ? { ids, loading } : { ids: null, loading: false };
}
