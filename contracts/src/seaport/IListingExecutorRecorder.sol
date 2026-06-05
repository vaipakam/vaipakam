// src/seaport/IListingExecutorRecorder.sol
// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {FeeLeg, OfferContext} from "./PrepayTypes.sol";

/**
 * @title IListingExecutorRecorder
 * @author Vaipakam Developer Team
 * @notice T-086 step 6: the diamond-facing surface of
 *         {CollateralListingExecutor} that {NFTPrepayListingFacet}
 *         calls into when borrowers post / update / cancel
 *         prepay-collateral listings.
 *
 *         Three responsibilities the interface narrows the executor's
 *         API down to (so the borrower-facing facet's audit surface
 *         lists exactly the executor entry points it depends on):
 *
 *           1. **`recordOrder(orderHash, loanId, conduit, conduitKey,
 *              salt, startTime, askPrice)`** — pin a Seaport
 *              `orderHash → (loanId, conduit, …)` binding on the
 *              executor before Seaport processes a signed order.
 *              Diamond-gated on the executor side
 *              (`msg.sender == vaipakamDiamond`); the listing facet
 *              is the ONLY surface that legitimately calls it.
 *              T-086 #316 extended the recorded shape so the
 *              executor can rebuild the canonical `OrderComponents`
 *              at cleanup time without re-fetching from the diamond.
 *
 *           2. **`clearOrder(orderHash)`** — remove the binding so a
 *              previously-signed order can no longer fill. Called on
 *              borrower cancel, on the permissionless grace-expired
 *              cancel, and as the first leg of an update (clear the
 *              old hash before recording the new one). Idempotent on
 *              the executor side. T-086 #316 extended this surface
 *              to ALSO forward `Seaport.cancel` for the matching
 *              orderHash (best-effort) so OpenSea's catalog refreshes
 *              within ~30s.
 *
 *           3. **`approvedConduits(conduit)`** — view-only allow-list
 *              membership check. The facet uses it to fail-fast at
 *              `postPrepayListing` time with a meaningful error
 *              (`ConduitNotApproved`) instead of bouncing through
 *              `recordOrder`'s revert — gives the caller a clean
 *              precondition signal.
 *
 * @dev    Defined in `contracts/src/seaport/` next to the executor
 *         it abstracts, matching the existing convention of
 *         {IVaipakamPrepayContext} (diamond view surface) and
 *         {IVaipakamPrepayCallbacks} (executor → diamond callback).
 *         This file adds the third direction: diamond → executor
 *         order-record surface.
 */
interface IListingExecutorRecorder {
    /// @notice Pin a Seaport `orderHash → (loanId, conduit, ...,
    ///         feeLegs, mode)` binding. The recorded shape captures
    ///         every borrower-controlled + sign-time input so the
    ///         executor can rebuild the canonical `OrderComponents`
    ///         at cleanup time and forward `Seaport.cancel` for fast
    ///         OpenSea catalog refresh.
    ///
    ///         **Mode-tag semantics (Round-5 Block B, Issue #309):**
    ///           - `mode == PREPAY_MODE_FIXED_PRICE (0)` — the
    ///             Round-4 / Block A path. `endAskPrice` MUST equal
    ///             `askPrice`; `auctionEndTime` MUST be zero (the
    ///             Seaport `endTime` is the loan's `gracePeriodEnd`
    ///             and is re-derived from the diamond view at cancel
    ///             time, not from this field). Fee legs MUST satisfy
    ///             `startAmount == endAmount` per-leg.
    ///           - `mode == PREPAY_MODE_DUTCH (1)` — the Block B
    ///             path. `endAskPrice ≤ askPrice` (where `askPrice`
    ///             is interpreted as the start ask); `auctionEndTime`
    ///             > `startTime + MIN_AUCTION_WINDOW` AND ≤
    ///             `loan.gracePeriodEnd`. The Seaport `endTime` is
    ///             `auctionEndTime`. Fee legs MAY decay
    ///             (`startAmount ≥ endAmount` per-leg).
    ///
    ///         The executor's `recordOrder` validates the mode tag +
    ///         every cross-field consistency rule. The diamond facet
    ///         performs the richer borrower-leg-monotonicity check
    ///         that requires reading the live pctx; the executor
    ///         doesn't duplicate that — it trusts the diamond, then
    ///         re-checks every fill-time invariant in the zone
    ///         callback.
    ///
    ///         See {CollateralListingExecutor.recordOrder} for the
    ///         full check stack + storage layout.
    function recordOrder(
        bytes32 orderHash,
        uint256 loanId,
        address conduit,
        bytes32 conduitKey,
        uint256 salt,
        uint256 startTime,
        uint256 askPrice,
        uint256 endAskPrice,
        uint256 auctionEndTime,
        uint8 mode,
        FeeLeg[] calldata feeLegs,
        uint256 signedLenderAmount,
        uint256 signedTreasuryAmount
    ) external;

    /// @notice Remove a binding. Idempotent. T-086 #316: while the
    ///         binding still exists, the executor reconstructs the
    ///         canonical `OrderComponents` and forwards
    ///         `Seaport.cancel` so OpenSea's marketplace catalog
    ///         refreshes the listing within ~30s of the cleanup.
    ///         The cancel emit is best-effort; reconstruction
    ///         mismatch (NFT-holder transfer, counter increment,
    ///         treasury rotation) gracefully falls back to no-op.
    ///         See {CollateralListingExecutor.clearOrder}.
    function clearOrder(bytes32 orderHash) external;

    /// @notice Allow-list membership for `conduit`.
    function approvedConduits(address conduit) external view returns (bool);

    /// @notice T-086 Round-7 (Issue #355) — typed read accessor for the
    ///         per-order fee-leg snapshot. Returns the full
    ///         `FeeLeg[]` recorded at `recordOrder` time; the empty
    ///         array for an unknown or fee-free orderHash. Auto-list
    ///         Case-B rotation reads this BEFORE `clearOrder` wipes
    ///         the snapshot.
    function orderFeeLegs(bytes32 orderHash) external view returns (FeeLeg[] memory);

    /// @notice T-086 Round-7 (Issue #355) — narrow per-order read
    ///         surface bundling the `OrderContext` fields the auto-
    ///         list-at-floor B-cond gates read. Returns the
    ///         auction-mode tag + ask shape + Dutch timing fields
    ///         from the executor's `OrderContext` storage. Returns
    ///         zero / default fields for an unknown orderHash.
    /// @dev    Kept narrow on purpose — the executor's
    ///         `OrderContext` includes loanId / conduit / conduitKey
    ///         / salt that the auto-list path doesn't need (Case B
    ///         inherits the conduit from the existing listing via
    ///         the wired vault binding, NOT from this read).
    function orderContextRead(bytes32 orderHash)
        external
        view
        returns (
            uint8 mode,
            uint192 askPrice,
            uint128 endAskPrice,
            uint64 startTime,
            uint64 auctionEndTime
        );

    /// @notice T-086 Round-7 follow-up (Codex round-12 P2 #1) —
    ///         return the per-order conduit address + key recorded at
    ///         `recordOrder` time. Auto-list Case-B rotations MUST
    ///         reuse the EXISTING listing's conduit (the borrower's
    ///         original approved choice) rather than swap to the
    ///         Case-A default; otherwise rotations on listings posted
    ///         with a non-default conduit fail the executor's
    ///         allow-list check (or silently change the conduit out
    ///         from under the borrower).
    function orderContextConduit(bytes32 orderHash)
        external
        view
        returns (address conduit, bytes32 conduitKey);

    /// @notice T-086 Round-7 (Issue #355) — the Seaport address bound
    ///         at executor-init time. Read by the auto-list path so
    ///         `LibPrepayOrder.buildAndHash` can construct the
    ///         canonical order against the same Seaport the executor
    ///         routes fills through.
    function seaport() external view returns (address);

    /// @notice T-086 Round-7 (Issue #355) — read accessor for the
    ///         per-order signed-leg snapshot. Returns the
    ///         `consideration[0].amount` (lender) and
    ///         `consideration[1].amount` (treasury) recorded at sign
    ///         time for `orderHash`. The auto-list-at-floor B-cond-2
    ///         gate reads these directly to decide rotation: when live
    ///         `pctx.lenderLeg` or `pctx.treasuryLeg` exceeds the
    ///         signed amount the order is unfillable
    ///         (CollateralListingExecutor._assertOrderContent reverts
    ///         `LenderShortPaid` / `TreasuryShortPaid` at fill time),
    ///         so the keeper rotates to a fresh fixed-price-at-floor
    ///         listing.
    ///
    ///         Returns `(0, 0)` for an unknown or already-cleared
    ///         orderHash.
    ///
    ///         Populated by `recordOrder` — signed amounts come in as
    ///         the new `signedLenderAmount` + `signedTreasuryAmount`
    ///         args, not re-derived from `askPrice` (which would
    ///         silently treat borrower-leg slack as protocol coverage
    ///         — see Round-7 §18.5 B-cond-2 rationale).
    function orderProtocolLegs(bytes32 orderHash) external view returns (uint128 lender, uint128 treasury);

    // ─── T-086 Round-8 (#358) — Offer-keyed surface ────────────────────
    //
    // §19.6 introduced a DEDICATED offer-keyed binding (parallel to the
    // loan-keyed `recordOrder` / `clearOrder` / `orderContext` above)
    // because the executor's `ctx.loanId == 0` is the unrecorded-order
    // revert sentinel. The pre-loan branch's binding lives in
    // `offerContext[orderHash]` on the concrete executor; the
    // interface widening below lets the diamond + tests reach it
    // without casting through the concrete class.
    //
    // Three new members for the no-loan / parallel-sale path:
    //   - `recordOfferOrder(orderHash, ctx, feeLegs)` — round-3.7
    //     widened with `FeeLeg[]` per Codex round-7 P2 line 5015
    //     (the seller-signed schedule MUST be persisted at record-time
    //     so the zone callback can compare live consideration items to
    //     the sign-time schedule).
    //   - `clearOfferOrder(orderHash)` — symmetric cleanup; MUST invoke
    //     `_tryCancelOnSeaportOffer` (round-3.9 against Codex round-9
    //     P3 line 4724).
    //   - `offerFeeLegs(orderHash)` — typed array getter for the
    //     persisted seller-signed schedule (§19.7e).
    //
    // The `offerContext(orderHash)` view is the auto-generated
    // public-mapping getter on `CollateralListingExecutor` and is
    // intentionally NOT widened here — Solidity's auto-getter for a
    // mapping to a struct with a nested dynamic type would force
    // tuple-style returns; tests + the diamond callbacks read the
    // typed struct directly off the concrete executor.

    /// @notice T-086 Round-8 (#358) §19.6 — pin a pre-loan Seaport
    ///         `orderHash → OfferContext` binding for the no-loan
    ///         branch. Diamond-only. The fee-leg array is the
    ///         SELLER-signed schedule (the vault, as Seaport offerer,
    ///         binds these legs into the canonical order at
    ///         offer-create time — see §19.4 Scenario A bullet 2).
    ///
    ///         The interface uses `CollateralListingExecutor.OfferContext`
    ///         declared on the concrete executor; the diamond facet
    ///         imports the struct alongside the interface so the
    ///         calldata-shape matches at the ABI boundary.
    ///
    ///         See {CollateralListingExecutor.recordOfferOrder}.
    function recordOfferOrder(
        bytes32 orderHash,
        OfferContext calldata ctx,
        FeeLeg[] calldata feeLegs
    ) external;

    /// @notice T-086 Round-8 (#358) §19.6 — remove an offer-keyed
    ///         binding. Diamond-only. Idempotent (no-op for an
    ///         already-cleared or never-recorded orderHash). MUST
    ///         invoke `_tryCancelOnSeaportOffer` (round-3.9 P3 line
    ///         4724 dependency for the §19.4 Scenario C two-layer
    ///         rejection claim).
    ///
    ///         See {CollateralListingExecutor.clearOfferOrder}.
    function clearOfferOrder(bytes32 orderHash) external;

    /// @notice T-086 Round-8 (#358) §19.7e — typed array getter for
    ///         the per-offer-order fee-leg snapshot. Returns the full
    ///         seller-signed `FeeLeg[]` recorded at `recordOfferOrder`
    ///         time; the empty array for an unknown / fee-free
    ///         orderHash.
    ///
    ///         The §19.3 offer-accept teardown step 3 reads this
    ///         BEFORE `clearOfferOrder` wipes the snapshot so the
    ///         fresh active-loan order can carry the same fee schedule
    ///         (preserving `activeLoanAskWithFees` per round-3.7).
    function offerFeeLegs(bytes32 orderHash) external view returns (FeeLeg[] memory);
}
