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
 * Block C-on-fee-enforced (#331, this commit) extends the match
 * surface to fee-enforced collections. The section polls
 * `/opensea/collection/{slug}` once per loan, parses the response
 * into a typed schedule, and uses it for two things:
 *
 *   1. Threshold scaling in `useOpenSeaOffers` so offers are
 *      classified acceptable against the post-fee borrower
 *      remainder, not the gross.
 *   2. At Match-click, a confirm-time re-fetch + `computeFeeLegs`
 *      to build the on-chain `FeeLegInput[]` for
 *      `updatePrepayListing`'s `feeLegs` calldata (per §15.3 step
 *      5's "re-fetch on every match-offer click" rule).
 *
 * Fee-free collections still work the same way — `totalBps === 0`
 * collapses the scaling to the v1 baseline and `computeFeeLegs`
 * returns `[]`.
 */

import { useEffect, useState } from 'react';
import type { UseNFTPrepayListingResult } from '../../hooks/useNFTPrepayListing';
import { useDiamondRead } from '../../contracts/useDiamond';
import { useTokenMeta } from '../../lib/tokenMeta';
import { OpenSeaOffersPanel } from './OpenSeaOffersPanel';
import { useOpenSeaOffers } from '../../hooks/useOpenSeaOffers';
import {
  parseOpenSeaFeeSchedule,
  computeFeeLegs,
  type ParsedFeeSchedule,
} from '../../lib/openseaFeeSchedule';

export interface OpenSeaOffersSectionProps {
  loanId: bigint;
  chainId: number;
  principalAsset: string;
  collateralAsset: string;
  collateralTokenId: bigint;
  /** Codex round-7 P2 review #328 — needed for the ERC1155
   *  defer gate. `0` = ERC20 (rejected upstream), `1` = ERC721,
   *  `2` = ERC1155. The Match flow currently rotates against
   *  the full vaulted `collateralQuantity`; a one-unit OpenSea
   *  offer would mark acceptable then revert on-chain at fill
   *  time. v1 ships ERC721-only; ERC1155 English-match arrives
   *  in a follow-up with a quantity gate inside the hook's
   *  normalizer. */
  collateralAssetType: number;
  prepayListing: UseNFTPrepayListingResult;
}

export function OpenSeaOffersSection({
  loanId,
  chainId,
  principalAsset,
  collateralAsset,
  collateralTokenId,
  collateralAssetType,
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
  // Codex round-8 P2 review #328 — track which loanId the
  // current threshold + offers state belongs to. React Router
  // reuses `LoanDetails` across loan navigations, so the section
  // re-renders with NEW props (loanId, collateral, principal)
  // while the hook + threshold state still hold the PREVIOUS
  // loan's values until the relevant effects re-run after paint.
  // Rendering the panel during that window would let a fast
  // Match click submit `updatePrepayListing` for the new loanId
  // using stale offer data. Synchronous gate: only render the
  // panel when `recordedLoanId === loanId`. Each effect updates
  // this at its leading edge.
  const [recordedLoanId, setRecordedLoanId] = useState<bigint | null>(null);
  const stateMatchesLoan = recordedLoanId === loanId;

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
    // Codex round-4 P2 review #328 — reset the threshold to null
    // BEFORE starting the async pctx read. If the section is
    // reused for a different loan (navigation between loan
    // cards, or the listing row's `updatedAt` changes), the
    // previous loan's threshold lingers in state until the new
    // fetch resolves. During that window the hook stays unpaused
    // and can classify or confirm-match the new loan's offers
    // against the OLD loan's floor/principal — either hiding
    // valid offers or enabling a match that reverts on-chain.
    setThreshold(null);
    // Codex round-8 + round-9 P2 review #328 — DO NOT set
    // `recordedLoanId` here. Setting it at the LEADING edge
    // would let `stateMatchesLoan` flip true on the next paint
    // while the offers hook still has the previous loan's
    // offers/slug cached (the hook's paused-branch clears them
    // only after `paused` has actually flipped true in render —
    // which requires `threshold === null` to have rendered
    // first, AND the hook's effect to fire after that paint).
    // Defer the recordedLoanId update until the threshold has
    // RESOLVED for this loan; by that point `paused` has been
    // true for at least one full render cycle, the offers
    // hook's paused branch has run + cleared offers, and the
    // panel can safely surface the new loan's state.
    let cancelled = false;
    const targetLoanId = loanId;
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
          getPrepayListingEnabled: () => Promise<boolean>;
        };
        // #332 — Dutch listings get classified against the
        // PROJECTED legs the facet itself validates against:
        // `getPrepayContext(loanId, live.auctionEndTime)`. Without
        // this, the threshold uses current-time legs (smaller),
        // which would let `computeAcceptable` classify offers
        // above-current-floor but below-projected-floor as
        // acceptable — the rotation tx would then revert
        // `DutchEndAskBelowProjectedFloorPlusFees`. Fixed-price
        // listings keep using current-time pctx.
        const asOf =
          live !== null &&
          live !== undefined &&
          live.auctionMode === 1 &&
          live.auctionEndTime != null
            ? BigInt(live.auctionEndTime)
            : BigInt(Math.floor(Date.now() / 1000));
        // Codex round-3 P2 review #328 — also check the master
        // kill-switch (`getPrepayListingEnabled`). The actions
        // card already gates on it; if governance has flipped the
        // feature off (or hasn't enabled it yet on a fresh deploy),
        // `updatePrepayListing` reverts `PrepayListingDisabled` and
        // a Match click would always fail. Treat the kill-switch
        // off OR buffer = 0 (storage-default unconfigured state,
        // reverts `PrepayListingBufferNotConfigured`) as "no usable
        // threshold" so the panel renders the disabled state.
        const [ctx, buf, enabled] = await Promise.all([
          d.getPrepayContext(targetLoanId, asOf),
          d.getPrepayListingBufferBps(),
          d.getPrepayListingEnabled(),
        ]);
        if (cancelled) return;
        const lenderLeg = (ctx as { lenderLeg?: bigint }).lenderLeg ?? 0n;
        const treasuryLeg = (ctx as { treasuryLeg?: bigint }).treasuryLeg ?? 0n;
        const bufferBps = Number(buf);
        if (!enabled || bufferBps === 0) {
          setThreshold(null);
          setRecordedLoanId(targetLoanId);
          return;
        }
        setThreshold({
          lenderLeg,
          treasuryLeg,
          bufferBps,
          principalAsset,
        });
        setRecordedLoanId(targetLoanId);
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
  }, [
    diamond,
    loanId,
    principalAsset,
    prepayListing.listing?.updatedAt,
    floorTick,
    // #332 — re-fetch pctx when the auction mode or end time
    // changes. Dutch rows classify against the projected legs at
    // `auctionEndTime`; fixed-price rows classify against
    // current-time legs. A mode flip (e.g. via Match) needs to
    // re-resolve the right `asOf`.
    prepayListing.listing?.auctionMode,
    prepayListing.listing?.auctionEndTime,
  ]);

  // VITE_AGENT_ORIGIN is the agent Worker's public URL (e.g.
  // `https://agent.vaipakam.com`). If unset, the panel renders the
  // disabled state — the indexer's autonomous OpenSea publish is the
  // canonical safety net; the offers UI is a per-page feature that
  // requires the agent proxy.
  const agentOrigin =
    (import.meta.env.VITE_AGENT_ORIGIN as string | undefined) ?? null;

  const live = prepayListing.listing;
  // Codex P2 review #328 + round-3 P2 review — the hook is
  // mounted before the early-return banners for Dutch + pre-
  // migration rows. Compute the "can match" predicate up front so
  // the same boolean drives BOTH the pause flag AND the early
  // returns; otherwise the hook keeps polling for rows that will
  // only ever render an informational banner.
  // Codex round-13 P2 review #328 — use nullish (`== null`) so
  // that an indexer response with omitted-key (undefined) AND
  // explicit-null both classify as pre-migration. A rolling
  // deploy or stale indexer could serve a row without these
  // anchors; without the nullish check, Match could fire and
  // hit `BigInt(undefined)` at the actual onMatchOffer call.
  const listingPreMigration =
    live !== null &&
    live !== undefined &&
    (live.salt == null || live.conduitKey == null);
  // Codex round-8 P2 review #328 — also include the ERC1155
  // defer gate in `canMatch`. Without this, the hook mounts +
  // polls every 30 s for ERC1155 loans even though the UI's
  // later early-return shows only the v1.1-deferred banner.
  // `2` is the on-chain `AssetType.ERC1155` enum value.
  const collateralIsERC1155 = collateralAssetType === 2;
  // #332 (final shape, post round-4 pivot to single-tx) — Dutch
  // listings Match via the atomic `updatePrepayDutchListing`
  // rotation rather than cancel+post-as-fixed-price. The 2-tx
  // shape was abandoned mid-PR because every state-shift vector
  // between the cancel and post (kill switch, buffer, grace,
  // floor, threshold-headroom, indexer-stale-row) needed a
  // separate pre-flight — and even then the failure mode was
  // destructive ("listing destroyed" if cancel succeeded + post
  // reverted). The atomic single-tx shape has the same on-chain
  // checks but its failure mode is "nothing happened" — the live
  // Dutch listing stays intact on revert.
  //
  // The Dutch Match's three original Codex concerns are
  // structurally addressed by:
  //   1. MIN_AUCTION_WINDOW (1h): banner Match when
  //      `live.auctionEndTime - now ≤ MIN_AUCTION_WINDOW +
  //      MATCH_SAFETY` (computed below; `dutchRunwayTooShort`).
  //   2. Projected-end-time floor: threshold effect reads pctx
  //      at `live.auctionEndTime` (not `now`) for Dutch rows,
  //      so `computeAcceptable` classifies against the projected
  //      legs the facet itself validates.
  //   3. Missing Dutch publish path: extended
  //      `publishPrepayListingToOpenSea` (this PR) to accept
  //      Dutch params; `useNFTPrepayListing.updatePrepayDutchListing`
  //      now calls `runOpenSeaPublish` with those params after
  //      the rotation tx confirms.
  //
  // Dutch indexer rows missing `auctionEndTime` or `endAskPrice`
  // STILL pause the hook + render the malformed-Dutch banner —
  // we can't compute the projected pctx or publish without those
  // fields.
  const dutchRowIsMalformed =
    live !== null &&
    live !== undefined &&
    live.auctionMode === 1 &&
    (live.auctionEndTime == null || live.endAskPrice == null);

  // #332 — Dutch grace runway: the diamond requires
  // `newAuctionEndTime > block.timestamp + MIN_AUCTION_WINDOW`
  // (1 hour). When the borrower preserves `live.auctionEndTime`
  // (which is what the Match callback does — see the
  // `onMatchOffer` body), the tx will revert
  // `AuctionWindowTooShort` if `auctionEndTime - now <= 1h`.
  // Banner the panel instead of letting the tx fire.
  //
  // Safety margin on top of the bare 1h floor: 5 minutes covers
  // wallet sign delay + tx mining propagation. The exact
  // boundary is enforced inside the diamond at tx-mining time
  // (`block.timestamp + 1h`), so a borrower clicking with
  // `live.auctionEndTime - now == 1h + 1s` would still revert
  // if the tx takes more than a second to mine.
  const MIN_AUCTION_WINDOW_SECONDS = 60n * 60n;
  const MATCH_SAFETY_SECONDS = 5n * 60n;
  const nowSeconds = BigInt(Math.floor(Date.now() / 1000));
  const dutchRunwayTooShort =
    live !== null &&
    live !== undefined &&
    live.auctionMode === 1 &&
    live.auctionEndTime != null &&
    BigInt(live.auctionEndTime) - nowSeconds <=
      MIN_AUCTION_WINDOW_SECONDS + MATCH_SAFETY_SECONDS;

  const canMatch =
    live !== null &&
    live !== undefined &&
    !listingPreMigration &&
    !collateralIsERC1155 &&
    !dutchRowIsMalformed &&
    !dutchRunwayTooShort;

  // #331 — fee-schedule cache (replaces round-5's tri-state
  // enforcement gate). The dapp polls `/opensea/collection/{slug}`
  // once per loan and parses the response into `ParsedFeeSchedule`.
  // The schedule's `totalBps` then drives the threshold scaling
  // inside `useOpenSeaOffers` so offers are classified acceptable
  // against the post-fee borrower remainder, and `computeFeeLegs`
  // turns the same schedule into on-chain `FeeLegInput[]` at
  // confirm time.
  //
  // **Slug-paired state** (Codex round-7 P2 #328 — preserved):
  // `feeCheck.slug` records which slug the cached `schedule` was
  // fetched FOR. The slug-change effect below resets the cache on
  // navigation between loans, and the post-hook derivation pairs
  // `feeCheck.slug` against the offers feed's slug before unlocking
  // the Match flow. That closes the one-frame window where a
  // navigation re-render could surface the previous loan's
  // schedule against the new loan's offers.
  //
  // **Fee-enforced is no longer a banner.** Round-5's banner
  // short-circuit on fee-enforced collections is removed; the
  // panel now renders the offers list with feeBpsTotal-scaled
  // threshold and uses the schedule at Match time to thread fresh
  // `FeeLegInput[]` through `updatePrepayListing`.
  const [feeCheck, setFeeCheck] = useState<{
    slug: string | null;
    schedule: ParsedFeeSchedule | null;
  }>({ slug: null, schedule: null });

  // OFFERS RESULT (read pass) — feeBpsTotal scales the
  // acceptability classification on fee-enforced collections. The
  // hook is also paused until the schedule has been fetched (any
  // flavor — totalBps=0 fee-free counts) so offers don't briefly
  // render against the fee-free threshold on a collection that
  // turns out to be fee-enforced.
  const offersResult = useOpenSeaOffers(
    agentOrigin,
    chainId,
    collateralAsset,
    collateralTokenId,
    threshold !== null
      ? {
          ...threshold,
          // Codex round-1 P1 #339 — when the schedule hasn't been
          // fetched, pass the degenerate `feeBpsTotal: 10_000`
          // sentinel so every offer classifies as below-threshold
          // via the hook's degenerate-guard branch. This keeps the
          // hook unpaused (so the offers fetch can resolve the
          // slug and unblock the schedule effect) while still
          // preventing misleadingly-acceptable rows from rendering.
          // Once the schedule lands the value swaps to the real
          // `totalBps` and re-classification kicks in on next
          // render.
          //
          // Slug-pairing happens POST-HOOK (see
          // `feeScheduleMatchesSlug` + `effectiveFeeSchedule`
          // below). Doing the pairing inside the hook input would
          // create a self-reference to `offersResult.slug` —
          // that's TDZ, both at runtime and at TypeScript's
          // `block-scoped-used-before-declaration` check. The
          // single-frame window where the previous loan's
          // `feeBpsTotal` might leak into the new loan's
          // classification is bounded by the section's
          // `stateMatchesLoan` synchronous gate (returns null
          // until `recordedLoanId` catches up), so no
          // misleading row reaches the DOM.
          feeBpsTotal: feeCheck.schedule?.totalBps ?? 10_000,
          // Codex round-2 P2 #339 — bake the per-leg-rounding
          // floor into the classification so offers below the
          // smallest-fee row's rounding boundary classify as
          // below-threshold automatically. Without this, the
          // Match button would light up for an offer that
          // `computeFeeLegs` then refuses to settle.
          minRequiredFeeBps: feeCheck.schedule?.minBps ?? 0,
        }
      : {
          // Codex round-3 P2 review #328 — sentinel: when threshold
          // hasn't resolved, mark every offer unacceptable by setting
          // `lenderLeg` to the uint256 max. Defense-in-depth alongside
          // the pause flag.
          lenderLeg:
            0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffn,
          treasuryLeg: 0n,
          bufferBps: 0,
          principalAsset,
          feeBpsTotal: 0,
          minRequiredFeeBps: 0,
        },
    // Codex P2 review #328 — pause polling when there's no live
    // listing OR threshold hasn't resolved OR the listing can't
    // be matched (Dutch / pre-migration). Codex round-1 P1 #339:
    // DO NOT also pause on `feeCheck.schedule === null` — the slug
    // is resolved by this very fetch, so gating the fetch on the
    // schedule (which gates on the slug) creates a chicken-and-egg
    // deadlock. Schedule-not-yet-fetched is handled via the
    // `feeBpsTotal: 10_000` sentinel above; the Match button stays
    // disabled via `actionLoading: effectiveFeeSchedule === null`.
    {
      paused:
        threshold === null ||
        !canMatch,
    },
  );

  // POST-HOOK pairing — the schedule cache must record the slug the
  // hook is currently surfacing offers for. On loan navigation the
  // effect resets the cache to {slug: null, schedule: null} before
  // the next fetch lands; until that re-fetch completes for the new
  // slug, the Match flow stays gated.
  const feeScheduleMatchesSlug =
    feeCheck.slug !== null &&
    feeCheck.slug === offersResult.slug &&
    feeCheck.schedule !== null;
  const effectiveFeeSchedule: ParsedFeeSchedule | null =
    feeScheduleMatchesSlug ? feeCheck.schedule : null;

  useEffect(() => {
    // Reset on slug change so the next-pass fetch runs against
    // the new collection.
    setFeeCheck({ slug: null, schedule: null });
    if (!agentOrigin || !offersResult.slug) return;
    const slugForThisFetch = offersResult.slug;
    let cancelled = false;
    fetch(
      `${agentOrigin}/opensea/collection/${encodeURIComponent(slugForThisFetch)}?chainId=${chainId}`,
    )
      .then((r) => (r.ok ? r.json() : null))
      .then((body) => {
        if (cancelled || body === null) return;
        // `parseOpenSeaFeeSchedule` returns `null` on a
        // structurally-unsafe schedule (malformed required-fee
        // recipient, or fee-leg count over `MAX_FEE_LEGS`). The
        // section's slug-pairing + Match gate both treat
        // `schedule: null` as "couldn't validate → keep Match
        // disabled" — same effect as a transient fetch failure.
        const schedule = parseOpenSeaFeeSchedule(body);
        setFeeCheck({ slug: slugForThisFetch, schedule });
      })
      .catch(() => {
        // Transient failure — leave the cache at null so Match
        // stays disabled rather than incorrectly settling against
        // an empty (= fee-free) default.
      });
    return () => {
      cancelled = true;
    };
  }, [agentOrigin, offersResult.slug, chainId]);

  if (!agentOrigin) return null;

  // Codex round-8 P2 review #328 — synchronous loan-key gate.
  // On client-side navigation between two borrower loan pages,
  // React Router reuses `LoanDetails`; this section re-renders
  // with NEW props while the hook + threshold state still hold
  // the previous loan's values. Suppress the panel until the
  // effects have re-run and `recordedLoanId` catches up.
  if (!stateMatchesLoan) return null;

  // Codex round-7 P2 review #328 — ERC1155 collateral defer
  // gate. The Match callback rotates against `live.askPrice`
  // which the on-chain order pins to the FULL vaulted
  // `collateralQuantity`; a one-unit OpenSea collection offer
  // would mark acceptable in the threshold check then revert at
  // fill time when the buyer pays the unit-priced offer for the
  // whole-quantity NFT. v1 hides the surface; the proper
  // quantity gate (require `offer.consideration[i].amount ==
  // collateralQuantity` inside `normalize`) is the v1.1
  // follow-up.
  if (collateralAssetType === 2) {
    return (
      <div
        id={`opensea-offers-erc1155-deferred-${loanId}`}
        className="card loan-actions-card"
      >
        <div className="action-group">
          <div className="action-title">OpenSea Offers (English mode)</div>
          <div className="alert alert-info">
            English-mode matching against ERC1155 collateral is
            coming in v1.1. The prepay-listing surface still works
            (post / update / cancel via the actions card above);
            only the OpenSea offer-matching shortcut is gated for
            now.
          </div>
        </div>
      </div>
    );
  }

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

  // #332 — Dutch listing whose remaining auction window is too
  // short for the diamond's `_assertDutchWindow` 1-hour minimum.
  // The atomic `updatePrepayDutchListing` rotation preserves the
  // existing `auctionEndTime` (the rotated order behaves like
  // fixed-price-at-`offer.value` for the rest of that window),
  // so if `auctionEndTime - now <= 1h + safety` the tx would
  // revert `AuctionWindowTooShort`. Banner the panel instead of
  // showing offers the borrower can't match.
  if (dutchRunwayTooShort) {
    return (
      <div
        id={`opensea-offers-dutch-runway-${loanId}`}
        className="card loan-actions-card"
      >
        <div className="action-group">
          <div className="action-title">OpenSea Offers (English mode)</div>
          <div className="alert alert-info">
            This Dutch listing's auction window is within its final
            hour. Matching an OpenSea offer would rotate the order
            past the diamond's minimum 1-hour window. Cancel and
            re-post a fresh listing via the actions card above to
            restart the match flow with a full window.
          </div>
        </div>
      </div>
    );
  }

  // #332 — a Dutch listing without an `auctionEndTime` (or with a
  // missing `endAskPrice`) is a malformed indexer row. Banner
  // instead of attempting a rotation that would either revert
  // on-chain or rotate the order with bad decay parameters. Pre-
  // migration short-circuit above covered missing salt/conduit;
  // this covers missing Dutch-specific fields. The same predicate
  // also feeds `canMatch` above so the offers hook stops polling
  // when this banner will render.
  if (dutchRowIsMalformed) {
    return (
      <div
        id={`opensea-offers-dutch-pre-migration-${loanId}`}
        className="card loan-actions-card"
      >
        <div className="action-group">
          <div className="action-title">OpenSea Offers (English mode)</div>
          <div className="alert alert-warning">
            This Dutch listing is missing decay parameters in the
            indexer. Cancel the current listing and re-post via the
            actions card above to enable matching against incoming
            OpenSea offers.
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
      // #331 — block Match clicks until the schedule has been
      // fetched for the CURRENT slug. The disabled-button state
      // piggybacks on `actionLoading` to keep the panel's
      // disable-buttons logic in one place. `effectiveFeeSchedule`
      // resolves non-null only when the cached slug matches the
      // offers feed's slug; until then the gate stays closed.
      actionLoading={
        prepayListing.actionLoading || effectiveFeeSchedule === null
      }
      decimals={decimals}
      onMatchOffer={async (offer) => {
        // The borrower is taking the offer's value as the new ask;
        // the existing listing's salt + conduitKey are preserved
        // through the updatePrepayListing call. The bidder is told
        // out-of-band before the borrower clicks Match (per §15.3's
        // race-window warning, rendered inside the panel's confirm
        // modal). The pre-migration short-circuit above guarantees
        // `live` is non-null + both fields are populated by the
        // time this callback fires.
        if (!live || live.salt == null || live.conduitKey == null) {
          return false;
        }
        if (!offersResult.slug) return false;

        // #331 — re-fetch the fee schedule at confirm time per
        // §15.3 step 5. The panel-mount schedule can stale out if
        // OpenSea publishes a fee-schedule change while the
        // borrower watches the panel; a stale schedule could
        // under-compute the now-required fee amount, causing
        // OpenSea-side rejection at re-publish (the on-chain
        // rotation succeeds, but the bidder can't discover the
        // updated listing). Recomputing on every Match click trades
        // one extra RTT for correctness.
        let freshSchedule: ParsedFeeSchedule | null = null;
        try {
          const recheck = await fetch(
            `${agentOrigin}/opensea/collection/${encodeURIComponent(offersResult.slug)}?chainId=${chainId}`,
          );
          if (recheck.ok) {
            freshSchedule = parseOpenSeaFeeSchedule(await recheck.json());
          }
        } catch {
          // Network error → freshSchedule stays null → fail closed below.
        }
        if (freshSchedule === null) {
          // Couldn't validate the schedule. Invalidate the cached
          // verdict so the gate closes on next paint + abort the
          // Match. The borrower retries; transient failures resolve
          // on the next click.
          setFeeCheck({ slug: offersResult.slug, schedule: null });
          return false;
        }

        // If the fresh schedule's totalBps changed materially since
        // the panel-mount cache, the offer's classification could
        // flip from acceptable to below-threshold under the new
        // scaling. Re-check the closed-form threshold against the
        // FRESH `feeBpsTotal` before committing to the rotation.
        //
        // Codex round-1 P2 #339 — match the hook's `>= 10_000`
        // degenerate threshold here. A 9999-bps schedule produces
        // a finite (very large) min and the closed-form math
        // stays well-defined; only `feeBpsTotal >= 10_000` is
        // structurally unmatchable.
        if (freshSchedule.totalBps >= 10_000) {
          // Degenerate (fees consume the entire price OR more).
          // Refresh the cache + abort; the panel renders an
          // unmatchable state.
          setFeeCheck({ slug: offersResult.slug, schedule: freshSchedule });
          return false;
        }
        if (threshold !== null) {
          const num =
            (threshold.lenderLeg + threshold.treasuryLeg) *
            BigInt(10_000 + threshold.bufferBps);
          const den = BigInt(10_000 - freshSchedule.totalBps);
          const minAfterFresh = den === 0n ? 0n : (num + den - 1n) / den;
          if (offer.value < minAfterFresh) {
            // Fee schedule got more aggressive between panel-mount
            // and click; the offer is no longer acceptable under
            // the new scaling. Refresh the cache so the panel
            // re-renders with the offer correctly greyed out, then
            // abort the Match.
            setFeeCheck({ slug: offersResult.slug, schedule: freshSchedule });
            return false;
          }
        }

        // Build on-chain feeLegs from the FRESH schedule + offer's
        // value. Fee-free collections produce an empty array, which
        // matches the v1 Block C-on-fee-free path exactly.
        //
        // Codex round-1 P2 #339 — `computeFeeLegs` returns `null`
        // when the schedule + askPrice combination would produce a
        // zero-amount leg (diamond reverts `FeeLegInvalidAmount`).
        // Treat the null as fail-closed: refresh the cache (so the
        // panel re-classifies with the fresh schedule) and abort.
        // The borrower's recourse is to wait for a higher offer
        // that clears the per-leg-rounding floor.
        const feeLegs = computeFeeLegs(freshSchedule, offer.value);
        if (feeLegs === null) {
          setFeeCheck({ slug: offersResult.slug, schedule: freshSchedule });
          return false;
        }

        // Refresh the cache with the schedule we actually used —
        // keeps the section's threshold compare consistent on the
        // next render (e.g. if Match was attempted on the borderline
        // case but the tx then reverts and the user retries).
        setFeeCheck({ slug: offersResult.slug, schedule: freshSchedule });

        // #332 (round-5 PIVOT — single-tx in-place rotation for
        // both modes). Branch on the live listing's auctionMode:
        //
        //   - Fixed-price (mode 0): `updatePrepayListing` rotates
        //     the order atomically in one tx. All revert paths
        //     (kill switch, buffer, grace, floor, fees) leave the
        //     listing intact.
        //
        //   - Dutch (mode 1): `updatePrepayDutchListing` rotates
        //     the order atomically with `startAskPrice ==
        //     endAskPrice == offer.value`, collapsing Seaport's
        //     decay to a constant. `live.auctionEndTime` is
        //     preserved (gated above by `dutchRunwayTooShort` so
        //     it always satisfies `MIN_AUCTION_WINDOW`), so the
        //     bidder gets the same remaining window the original
        //     Dutch listing had. Threshold classification used
        //     pctx at `auctionEndTime` (projected legs) so the
        //     diamond's `DutchEndAskBelowProjectedFloorPlusFees`
        //     check is pre-satisfied at the panel level.
        //
        // No multi-tx pre-flight needed — the diamond's atomic
        // execution either commits or reverts the whole call.
        // On revert, the live listing stays unchanged (whether
        // Dutch or fixed-price).
        if (live.auctionMode === 1) {
          if (live.auctionEndTime == null) return false;
          return prepayListing.updatePrepayDutchListing(
            loanId,
            offer.value,
            offer.value,
            BigInt(live.auctionEndTime),
            BigInt(live.salt),
            live.conduitKey as `0x${string}`,
            feeLegs,
          );
        }

        return prepayListing.updatePrepayListing(
          loanId,
          offer.value,
          BigInt(live.salt),
          live.conduitKey as `0x${string}`,
          feeLegs,
        );
      }}
    />
  );
}
