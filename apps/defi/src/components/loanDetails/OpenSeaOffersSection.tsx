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
  type ParsedFeeSchedule,
} from '../../lib/openseaFeeSchedule';

export interface OpenSeaOffersSectionProps {
  loanId: bigint;
  chainId: number;
  principalAsset: string;
  collateralAsset: string;
  collateralTokenId: bigint;
  /** #336 — vault's locked NFT quantity. ERC721: always `1n`.
   *  ERC1155: the on-chain `collateralQuantity` from the loan
   *  struct. The normalizer enforces an exact-quantity match
   *  for ERC1155 offers — partial-fill collection offers stay
   *  on OpenSea but don't appear in the Match panel. Pre-#336
   *  the panel banner-gated ERC1155 collateral entirely
   *  (round-7 P2 #328); the gate was lifted along with the
   *  normalizer's quantity check + the previously-required
   *  `collateralAssetType` prop was dropped (only `2` mattered
   *  and that case is now handled inside the hook). */
  collateralQuantity: bigint;
  prepayListing: UseNFTPrepayListingResult;
}

export function OpenSeaOffersSection({
  loanId,
  chainId,
  principalAsset,
  collateralAsset,
  collateralTokenId,
  collateralQuantity,
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
  // T-086 Round-6 / Block D (#345) — Codex PR #346 round-1 P2.
  // `listingPreMigration` (the "v1 row missing salt/conduitKey"
  // gate) and `dutchRunwayTooShort` (the "Dutch listing under
  // 1 hour" gate) are stale: the atomic match-rotation flow does
  // NOT consume the v1 listing's salt / conduitKey / auctionEndTime
  // (the facet picks its own at match time per §17.4). Both
  // predicates have been removed from `canMatch` and from the
  // banner short-circuits below.
  // #336 — ERC1155 banner gate removed. The normalizer now
  // enforces an exact-quantity match against `collateralQuantity`,
  // so partial-fill offers are filtered at the normalize step
  // rather than gating the whole panel away. ERC1155 loans now
  // poll + classify offers identically to ERC721.
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
  // T-086 Round-6 / Block D (#345) — Codex PR #346 round-2 P2
  // #511. `dutchRowIsMalformed` was kept across round-2 as a
  // last-mile guard against indexer rows missing decay fields,
  // but the atomic facet doesn't consume those fields either,
  // so the predicate is no longer load-bearing. Removed.

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
  // T-086 Round-6 / Block D (#345) — Codex PR #346 round-1 P2.
  // The Dutch 1-hour-runway gate (`dutchRunwayTooShort`) is stale
  // for the same reason as `listingPreMigration` above — atomic
  // match doesn't consume the existing listing's auctionEndTime.

  // T-086 Round-6 / Block D (#345) — Codex PR #346 round-1 P2.
  // Atomic match-rotation does NOT consume the live listing's
  // `salt`, `conduitKey`, `auctionMode`, or `auctionEndTime` —
  // the facet picks its own salt + conduit key + grace boundary
  // for the freshly-constructed counter-order, and §17.11 step 0
  // supports `existingHash == 0` (matching without a prior v1
  // post). The historical v1-listing prerequisites (`listingPre
  // Migration`, `dutchRowIsMalformed`, `dutchRunwayTooShort`)
  // therefore no longer gate the Match button. A borrower with
  // an allowsPrepayListing-true loan can match any acceptable
  // OpenSea offer regardless of v1 listing state.
  //
  // We keep `live` reachable for the panel's banner / context
  // text (so a borrower with a live v1 listing sees the existing
  // status) — but the gating boolean is open.
  const canMatch = true;

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
    collateralQuantity,
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
          // The schedule cache (`feeCheck`) is paired with the
          // CURRENT loan's slug at the post-hook block below — no
          // self-reference to `offersResult.slug` inside the hook
          // input. (TDZ would otherwise trip at runtime and at
          // TypeScript's block-scoped-used-before-declaration
          // check.) The single-frame window where the previous
          // loan's `feeBpsTotal` might leak into the new loan's
          // classification is bounded by the section's
          // `stateMatchesLoan` synchronous gate (returns null until
          // `recordedLoanId` catches up), so no misleading row
          // reaches the DOM. T-086 Block D: the atomic facet's
          // on-chain re-check is the authoritative fee gate at
          // match time.
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
    // `feeBpsTotal: 10_000` sentinel above. T-086 Block D / Codex
    // round-3 P2 on PR #346: the Match button is no longer gated
    // on `effectiveFeeSchedule` — the atomic facet re-checks the
    // bidder order's fee sum on-chain.
    {
      paused:
        threshold === null ||
        !canMatch,
    },
  );

  // T-086 Block D / Codex round-3 P2 on PR #346: the `feeCheck`
  // cache still feeds `feeBpsTotal` + `minRequiredFeeBps` into
  // `useOpenSeaOffers` for offer-side filtering, but no longer
  // gates the Match button itself — `effectiveFeeSchedule` +
  // `feeScheduleMatchesSlug` (which derived the render-time gate
  // from `feeCheck.slug === offersResult.slug && feeCheck.schedule
  // !== null`) were deleted with the gate. The atomic facet does
  // the authoritative fee-sum check on-chain at match time.

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
  // #336 — ERC1155 banner short-circuit removed. The normalizer
  // enforces an exact-quantity match against `collateralQuantity`,
  // so partial-fill collection offers are filtered at the
  // normalize step (stay visible on OpenSea but don't reach the
  // panel). Full-quantity offers behave exactly like ERC721
  // offers — Match rotates the canonical order to the offer's
  // value and the bidder fulfills for the whole locked lot.

  // T-086 Round-6 / Block D (#345) — Codex PR #346 round-1 P2.
  // The atomic match-rotation flow does NOT consume the existing
  // v1 listing's salt / conduitKey / auctionEndTime, and §17.11
  // step 0 supports `existingHash == 0` (match without a prior
  // post). The `listingPreMigration` + `dutchRunwayTooShort`
  // banners that previously short-circuited the offers panel are
  // therefore stale and have been removed; the offers panel
  // renders for every loan with allowsPrepayListing=true.
  //
  // Codex PR #346 round-2 P2 #511 — `dutchRowIsMalformed` was the
  // last remaining v1-listing-state gate. The atomic facet
  // doesn't consume `live.auctionEndTime` / `endAskPrice` either,
  // so a borrower whose Dutch row is missing those fields can
  // still match via §17.11 step 0's `existingHash` auto-clear
  // path. Banner dropped.

  return (
    <OpenSeaOffersPanel
      loanId={loanId}
      offersResult={offersResult}
      hasActiveListing={live !== null && live !== undefined}
      // T-086 Round-6 / Block D (#345) + Codex PR #346 round-3 P2:
      // Match must NOT be gated on the OpenSea fee-schedule fetch.
      // The atomic match-rotation path no longer sends fee legs and
      // the on-chain facet re-checks the bidder order's actual fee
      // sum (`Σ(bidder fees) <= effectiveAsk`). #331's render-time
      // gate is dropped — the schedule fetch is now advisory only,
      // used for the optional preview in the UI rather than to
      // disable Match. If `/opensea/collection` is briefly down or
      // returns malformed data, Match stays clickable and the
      // on-chain re-check is the authoritative gate.
      actionLoading={prepayListing.actionLoading}
      decimals={decimals}
      onMatchOffer={async (offer) => {
        // The borrower is taking the offer's value as the new ask;
        // T-086 Round-6 / Block D (#345) — atomic match-rotation
        // does NOT need the v1 listing's `salt` or `conduitKey`
        // (the facet picks its own fresh salt + OpenSea conduit
        // key at match-time per §17.4). The borrower can match
        // even without ever posting a v1 listing — §17.11 step 0
        // supports `existingHash == 0` and skips auto-clear. The
        // round-1 v1 prerequisite checks (`live.salt` / `live.
        // conduitKey`) are dropped here.
        //
        // Codex PR #346 round-1 P2 — also reject decaying bidder
        // offers (`offer.value` represents `price.current` but
        // the on-chain shape gate requires `startAmount ==
        // endAmount` on the bidder's offer item). If
        // `offer.priceIsDecaying` is set, the Match button
        // shouldn't have been clickable; defensively fail closed
        // in case the section's filter missed it.
        if (offer.priceIsDecaying) {
          // eslint-disable-next-line no-console
          console.warn('[onMatchOffer] declining decaying bidder offer (atomic shape gate)');
          return false;
        }

        // #331 — re-fetch the fee schedule at confirm time. For
        // the v1 two-step path this was load-bearing (the dapp
        // computed `feeLegs[]` from the schedule and passed it
        // through). For the Round-6 atomic path the bidder's
        // signed Offer carries the fees in its consideration and
        // the on-chain facet asserts the sum invariant directly,
        // so the schedule re-fetch is ADVISORY only — a transient
        // /opensea/collection failure must NOT block an otherwise
        // valid atomic Match (Codex PR #346 round-1 P2). We still
        // refresh the cache so the panel's threshold compare stays
        // honest on the next render, but a null result no longer
        // aborts the click.
        let freshSchedule: ParsedFeeSchedule | null = null;
        if (offersResult.slug) {
          try {
            const recheck = await fetch(
              `${agentOrigin}/opensea/collection/${encodeURIComponent(offersResult.slug)}?chainId=${chainId}`,
            );
            if (recheck.ok) {
              freshSchedule = parseOpenSeaFeeSchedule(await recheck.json());
            }
          } catch {
            // Network blip — leave freshSchedule null; advisory only.
          }
        }
        if (freshSchedule !== null && offersResult.slug) {
          setFeeCheck({ slug: offersResult.slug, schedule: freshSchedule });
        }

        // For Round-6 atomic the per-leg `feeLegs` is no longer
        // sent on-chain (the bidder's signed Offer carries them in
        // its consideration). The legacy `freshSchedule >= 10_000`
        // degenerate-rate gate + `computeFeeLegs` per-leg-rounding
        // gate are therefore advisory threshold heuristics, not
        // hard blocks (Codex PR #346 round-1 P2). The §17.5-bis
        // on-chain sum invariant is the authoritative check.

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
        // T-086 Round-6 / Block D (#345) — atomic match-rotation
        // via Seaport `matchAdvancedOrders`. Replaces the v1 two-
        // step Match flow (`updatePrepayListing(newAsk = offer_value)`
        // + bidder's separate `Seaport.fulfillOrder`) with a single
        // atomic tx — no race window for a third-party snipe.
        //
        // The on-chain atomic facet does NOT take a feeLegs
        // argument — the bidder's signed Offer carries the
        // OpenSea / creator fees in ITS consideration, and the
        // facet asserts the sum invariant directly (Round-6 design
        // doc §17.7 + §17.10). The dapp's fresh-fee-schedule
        // re-fetch above stays as advisory polish (the threshold
        // cache stays honest on next render) but does NOT gate
        // the click.
        //
        // The atomic path does NOT fire the #335 dapp-side
        // breadcrumb POST — the indexer's `PrepayListingMatched`
        // event handler writes it from on-chain (race-window
        // prevention per §17.13). The v1 `live.auctionMode` /
        // `live.salt` / `live.conduitKey` are no longer threaded
        // through (the atomic facet picks its own salt + conduit
        // key for the freshly-constructed counter-order).
        return prepayListing.matchOpenSeaOffer(loanId, {
          orderHash: offer.orderHash as `0x${string}`,
          bidder: offer.bidder as `0x${string}`,
          collateralContract: collateralAsset as `0x${string}`,
          collateralTokenId,
        });
      }}
    />
  );
}
