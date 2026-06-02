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
import { useTokenMeta } from '../../lib/tokenMeta';
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
  // Codex P2 review #328 — fetch the principal-token decimals so
  // the panel renders non-18-decimal offers (USDC=6, USDT=6,
  // WBTC=8) correctly. Match `PrepayListingActions`' pattern: the
  // panel-side decimals default to 18 until `meta` resolves.
  const meta = useTokenMeta(principalAsset);
  const decimals = meta?.decimals ?? 18;

  const [threshold, setThreshold] = useState<{
    lenderLeg: bigint;
    treasuryLeg: bigint;
    bufferBps: number;
    principalAsset: string;
  } | null>(null);

  // Codex P2 review #328 — refresh the floor on a timer, not just
  // when the listing row changes. For pro-rata loans left open
  // across a whole-day accrual boundary, `lenderLeg` /
  // `treasuryLeg` shift as interest accrues but the listing row's
  // `updatedAt` doesn't tick. Without a periodic refresh the panel
  // would let the borrower click Match on an offer that was
  // acceptable yesterday but reverts on-chain today with
  // `AskBelowFloorPlusFees`. 60 s is the same cadence
  // `PrepayListingActions`'s floor refresh uses for the same
  // reason.
  const [floorTick, setFloorTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setFloorTick((n) => n + 1), 60_000);
    return () => clearInterval(id);
  }, []);

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
  }, [diamond, loanId, principalAsset, prepayListing.listing?.updatedAt, floorTick]);

  // VITE_AGENT_ORIGIN is the agent Worker's public URL (e.g.
  // `https://agent.vaipakam.com`). If unset, the panel renders the
  // disabled state — the indexer's autonomous OpenSea publish is the
  // canonical safety net; the offers UI is a per-page feature that
  // requires the agent proxy.
  const agentOrigin =
    (import.meta.env.VITE_AGENT_ORIGIN as string | undefined) ?? null;

  const live = prepayListing.listing;
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
    // Codex P2 review #328 — pause polling when there's no live
    // listing OR threshold hasn't resolved. Without this, the loan
    // card's mounting gate keeps the section visible (with a
    // "Post a fixed-price listing first" hint) but the hook keeps
    // burning the shared OpenSea quota every 30 s on rows the UI
    // will never render. Pausing also avoids surfacing offers
    // before the threshold is known (which would always classify
    // as unacceptable).
    { paused: threshold === null || live === null || live === undefined },
  );

  if (!agentOrigin) return null;

  // Pre-migration-0016 rows never had `conduit_key` / `salt`
  // populated on the indexer's `prepay_listings` row. Without them
  // the JS reconstruction can't hash to the on-chain orderHash,
  // so a `updatePrepayListing` rotation would have the vault's
  // ERC-1271 reject the rotated order (Raja review #328: surface
  // this BEFORE the borrower clicks Match instead of a silent
  // no-op on click). `live` was already pulled at the top of the
  // body so the `useOpenSeaOffers` pause flag could consult it.
  const listingPreMigration =
    live !== null &&
    live !== undefined &&
    (live.salt === null || live.conduitKey === null);

  if (listingPreMigration) {
    return (
      <div
        id={`opensea-offers-pre-migration-${loanId}`}
        className="card loan-actions-card"
      >
        <div className="action-group">
          <div className="action-title">OpenSea Offers (English mode)</div>
          <div className="alert alert-warning">
            This listing was posted before the offer-matching surface
            was added. Cancel the current listing and re-post via the
            actions card above to enable matching against incoming
            OpenSea offers.
          </div>
        </div>
      </div>
    );
  }

  // T-086 Round-5 Block C — fixed-price-only for v1 (Raja/Grok
  // review #328 nit #2). The current Match callback calls
  // `updatePrepayListing` which would rotate a live Dutch listing
  // into fixed-price at the offer's value — a mode change is
  // technically supported on-chain but surprises the borrower vs
  // the release note's "deferred" framing. Hide the section + show
  // a banner instead. Matching against a Dutch listing lands as a
  // follow-up that calls `updatePrepayDutchListing` with the
  // offer's value + fresh decay parameters.
  const listingIsDutch = live !== null && live !== undefined && live.auctionMode === 1;
  if (listingIsDutch) {
    return (
      <div
        id={`opensea-offers-dutch-deferred-${loanId}`}
        className="card loan-actions-card"
      >
        <div className="action-group">
          <div className="action-title">OpenSea Offers (English mode)</div>
          <div className="alert alert-info">
            Matching incoming OpenSea offers against a live Dutch
            listing is coming in v1.1. For now, the Dutch decay path
            is the price-discovery mechanism — Seaport's native
            interpolation handles the per-block decayed price, and
            any buyer can fulfill at the current interpolated value.
          </div>
        </div>
      </div>
    );
  }

  return (
    <OpenSeaOffersPanel
      loanId={loanId}
      offersResult={offersResult}
      hasActiveListing={live !== null && live !== undefined}
      actionLoading={prepayListing.actionLoading}
      decimals={decimals}
      onMatchOffer={async (offer) => {
        // v1 ships fee-free: empty `feeLegs[]` rotation. The borrower
        // is taking the offer's value as the new ask; the existing
        // listing's salt + conduitKey are preserved through the
        // updatePrepayListing call. The bidder is told out-of-band
        // before the borrower clicks Match (per §15.3's race-window
        // warning, rendered inside the panel's confirm modal).
        // The pre-migration short-circuit above guarantees `live`
        // is non-null + both fields are populated by the time this
        // callback fires.
        if (!live || live.salt === null || live.conduitKey === null) {
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
