/**
 * T-086 Round-5 Block C (#309 Mode B) — OpenSea Offers section
 * mounted on the loan-details page right after
 * `PrepayListingActions`.
 *
 * Splits the offers UI out of `PrepayListingActions` so the
 * mounting site doesn't pay the pctx-fetch cost twice and so
 * the offers panel can ship even when the main listing form
 * decides to render its disabled state (master kill-switch off,
 * conflicting lock, etc.).
 *
 * The component owns:
 *   1. A pctx fetch (lenderLeg + treasuryLeg + bufferBps) used
 *      by the threshold filter inside `useOpenSeaOffers`.
 *   2. The `useOpenSeaOffers` polling hook.
 *   3. The `matchOffer` callback that calls
 *      `prepayListing.updatePrepayListing` to rotate the
 *      canonical Seaport order to the offer's price.
 *
 * v1 ships the **fee-free** path: empty `feeLegs[]` passed to
 * `updatePrepayListing` + the threshold collapses to the
 * protocol-leg buffer. Fee-enforced collection support is a
 * follow-up that re-fetches the OpenSea collection schedule at
 * match time + threads recomputed `FeeLeg[]` (per §15.3 line ~310's
 * "re-fetch on every match-offer click" rule).
 */

import { useEffect, useState } from 'react';
import type { UseNFTPrepayListingResult } from '../../hooks/useNFTPrepayListing';
import { useDiamondRead } from '../../contracts/useDiamond';
import { OpenSeaOffersPanel } from './OpenSeaOffersPanel';
import { useOpenSeaOffers } from '../../hooks/useOpenSeaOffers';

export interface OpenSeaOffersSectionProps {
  loanId: bigint;
  chainId: number;
  principalAsset: string;
  collateralAsset: string;
  collateralTokenId: bigint;
  prepayListing: UseNFTPrepayListingResult;
}

export function OpenSeaOffersSection({
  loanId,
  chainId,
  principalAsset,
  collateralAsset,
  collateralTokenId,
  prepayListing,
}: OpenSeaOffersSectionProps) {
  const diamond = useDiamondRead();

  const [threshold, setThreshold] = useState<{
    lenderLeg: bigint;
    treasuryLeg: bigint;
    bufferBps: number;
    principalAsset: string;
  } | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const d = diamond as unknown as {
          getPrepayContext: (
            id: bigint,
            asOf: bigint,
          ) => Promise<{
            lenderLeg: bigint;
            treasuryLeg: bigint;
          } | unknown[]>;
          getPrepayListingBufferBps: () => Promise<bigint>;
        };
        const asOf = BigInt(Math.floor(Date.now() / 1000));
        const [ctx, buf] = await Promise.all([
          d.getPrepayContext(loanId, asOf),
          d.getPrepayListingBufferBps(),
        ]);
        if (cancelled) return;
        const lenderLeg = (ctx as { lenderLeg?: bigint }).lenderLeg ?? 0n;
        const treasuryLeg = (ctx as { treasuryLeg?: bigint }).treasuryLeg ?? 0n;
        setThreshold({
          lenderLeg,
          treasuryLeg,
          bufferBps: Number(buf),
          principalAsset,
        });
      } catch {
        // Older deploy or transient RPC blip — leave threshold null;
        // the hook will treat every offer as unacceptable until pctx
        // resolves so the borrower can't match against a stale floor.
        if (!cancelled) setThreshold(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [diamond, loanId, principalAsset, prepayListing.listing?.updatedAt]);

  // VITE_AGENT_ORIGIN is the agent Worker's public URL (e.g.
  // `https://agent.vaipakam.com`). If unset, the panel renders the
  // disabled state — the indexer's autonomous OpenSea publish is the
  // canonical safety net; the offers UI is a per-page feature that
  // requires the agent proxy.
  const agentOrigin =
    (import.meta.env.VITE_AGENT_ORIGIN as string | undefined) ?? null;

  const offersResult = useOpenSeaOffers(
    agentOrigin,
    chainId,
    collateralAsset,
    collateralTokenId,
    threshold ?? {
      lenderLeg: 0n,
      treasuryLeg: 0n,
      bufferBps: 0,
      principalAsset,
    },
    { paused: threshold === null },
  );

  if (!agentOrigin) return null;

  return (
    <OpenSeaOffersPanel
      loanId={loanId}
      offersResult={offersResult}
      hasActiveListing={prepayListing.listing !== null && prepayListing.listing !== undefined}
      actionLoading={prepayListing.actionLoading}
      onMatchOffer={async (offer) => {
        // v1 ships fee-free: empty `feeLegs[]` rotation. The borrower
        // is taking the offer's value as the new ask; the existing
        // listing's salt + conduitKey are preserved through the
        // updatePrepayListing call. The bidder is told out-of-band
        // before the borrower clicks Match (per §15.3's race-window
        // warning, rendered inside the panel's confirm modal).
        const live = prepayListing.listing;
        if (!live || live.salt === null || live.conduitKey === null) {
          // Pre-Block-A row that never got conduit_key / salt
          // populated. Without them the JS reconstruction can't
          // hash to the on-chain orderHash, so the executor's
          // ERC-1271 rejects the rotated order. Refuse the match
          // and let the borrower cancel + re-post via the normal
          // post flow.
          return false;
        }
        return prepayListing.updatePrepayListing(
          loanId,
          offer.value,
          BigInt(live.salt),
          live.conduitKey as `0x${string}`,
          [],
        );
      }}
    />
  );
}
