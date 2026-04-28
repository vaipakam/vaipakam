import { useEffect, useMemo, useState } from 'react';
import type { Address } from 'viem';
import {
  useDiamondPublicClient,
  useDiamondRead,
  useReadChain,
} from '../contracts/useDiamond';
import { DEFAULT_CHAIN } from '../contracts/config';
import { DIAMOND_ABI_VIEM as DIAMOND_ABI } from '../contracts/abis';
import { batchCalls, encodeBatchCalls } from '../lib/multicall';
import { useLogIndex } from './useLogIndex';
import { toOfferData, type OfferData, type RawOffer } from '../pages/OfferBook';

const ZERO_ADDR = '0x0000000000000000000000000000000000000000';

/**
 * Returns the connected wallet's currently-open offers (i.e. offers the
 * caller created that haven't been accepted or canceled yet), newest first
 * by id.
 *
 * How it works
 * ------------
 * The log-index records every `OfferCreated` event with its `creator`
 * address. We filter that stream for the caller's address, then narrow
 * to ids still in `openOfferIds` (so accepted / canceled offers drop
 * out). One `getOffer` multicall fetches the surviving rows. This is
 * cheaper than fetching every open offer's details and filtering by
 * creator on the client — only the caller's own offers ever round-trip.
 *
 * Used by the Dashboard's "Your Active Offers" card. Replaces the
 * inline `myActiveOffers` derivation that used to live on the OfferBook
 * page (which carried a heavier set of side-effects — the lift to
 * Dashboard makes "your stuff" symmetric with the Your Loans card).
 */
export function useMyActiveOffers(address: string | null) {
  const { events, openOfferIds, loading: indexLoading } = useLogIndex();
  const diamondRead = useDiamondRead();
  const publicClient = useDiamondPublicClient();
  const activeReadChain = useReadChain();

  const [offers, setOffers] = useState<OfferData[]>([]);
  const [loading, setLoading] = useState(false);

  // Open offer ids the connected wallet created. Walks the indexed
  // OfferCreated stream rather than scanning every open offer detail —
  // an open book of N entries collapses to "M offers I created" with
  // O(events) work and a single multicall over those M ids.
  const myOpenOfferIds = useMemo(() => {
    if (!address) return [] as bigint[];
    const lower = address.toLowerCase();
    const openSet = new Set(openOfferIds.map((id) => id.toString()));
    return events
      .filter((e) => e.kind === 'OfferCreated')
      .filter((e) => {
        const creator = e.args.creator;
        return typeof creator === 'string' && creator.toLowerCase() === lower;
      })
      .map((e) => {
        const offerId = e.args.offerId;
        return typeof offerId === 'string' ? BigInt(offerId) : null;
      })
      .filter((id): id is bigint => id !== null && openSet.has(id.toString()));
  }, [events, openOfferIds, address]);

  useEffect(() => {
    if (indexLoading) return;
    if (!address || myOpenOfferIds.length === 0) {
      setOffers([]);
      return;
    }
    let cancelled = false;
    setLoading(true);
    (async () => {
      try {
        const target = (activeReadChain.diamondAddress ?? DEFAULT_CHAIN.diamondAddress) as Address;
        let decoded: Array<RawOffer | null>;
        try {
          const calls = encodeBatchCalls(
            target,
            DIAMOND_ABI,
            'getOffer',
            myOpenOfferIds.map((id) => [id] as const),
          );
          decoded = await batchCalls<RawOffer>(publicClient, DIAMOND_ABI, 'getOffer', calls);
          if (decoded.every((d) => d === null)) throw new Error('multicall empty');
        } catch {
          decoded = [];
          for (const id of myOpenOfferIds) {
            try {
              decoded.push((await diamondRead.getOffer(id)) as RawOffer);
            } catch {
              decoded.push(null);
            }
          }
        }
        if (cancelled) return;
        const fresh = decoded
          .filter((raw): raw is RawOffer =>
            !!raw &&
            raw.creator?.toLowerCase() !== ZERO_ADDR &&
            !raw.accepted,
          )
          .map(toOfferData)
          .sort((a, b) => (a.id > b.id ? -1 : a.id < b.id ? 1 : 0));
        setOffers(fresh);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [
    address,
    myOpenOfferIds,
    indexLoading,
    diamondRead,
    publicClient,
    activeReadChain.diamondAddress,
  ]);

  return { offers, loading };
}
