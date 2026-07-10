// src/facets/NFTPrepayListingFacet.sol
// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {LibVaipakam} from "../libraries/LibVaipakam.sol";
import {LibFacet} from "../libraries/LibFacet.sol";
import {ConsolidationFacet} from "./ConsolidationFacet.sol";
import {LibCollateralSettlement} from "../libraries/LibCollateralSettlement.sol";
import {LibERC721} from "../libraries/LibERC721.sol";
import {DiamondAccessControl} from "../libraries/LibAccessControl.sol";
import {DiamondPausable} from "../libraries/LibPausable.sol";
import {DiamondReentrancyGuard} from "../libraries/LibReentrancyGuard.sol";
import {IVaipakamErrors} from "../interfaces/IVaipakamErrors.sol";
import {IListingExecutorRecorder} from "../seaport/IListingExecutorRecorder.sol";
import {
    FeeLeg,
    MAX_FEE_LEGS,
    PREPAY_MODE_FIXED_PRICE,
    PREPAY_MODE_DUTCH
} from "../seaport/PrepayTypes.sol";
import {VaipakamNFTFacet} from "./VaipakamNFTFacet.sol";
import {VaipakamVaultImplementation} from "../VaipakamVaultImplementation.sol";
import {IVaipakamPrepayContext} from "../seaport/IVaipakamPrepayContext.sol";
import {LibPrepayOrder} from "../libraries/LibPrepayOrder.sol";
import {LibPrepayListingWiring} from "../libraries/LibPrepayListingWiring.sol";
import {CollateralListingExecutor} from "../seaport/CollateralListingExecutor.sol";
import {PrepayListingFacet} from "./PrepayListingFacet.sol";

/**
 * @title NFTPrepayListingFacet
 * @author Vaipakam Developer Team
 * @notice T-086 step 6: the borrower-facing diamond surface for the
 *         prepay-collateral-listing flow. The four entry points let
 *         the current borrower-position-NFT holder propose / update /
 *         cancel a Seaport sale of the collateral NFT, and a fifth
 *         (permissionless) entry lets anyone clean up an expired
 *         listing post-grace.
 *
 *         How the pieces fit (full flow, end to end):
 *
 *           1. Borrower (= current `borrowerNftHolder`) chooses an
 *              `askPrice` covering at least `liveFloor × (1 +
 *              bufferBps)`. Off-chain, the frontend constructs a
 *              `FULL_RESTRICTED` Seaport order with the vault as
 *              `offerer`, the {CollateralListingExecutor} singleton
 *              as both ERC-1271 signer and zone, the three
 *              consideration legs (lender / treasury / borrower) as
 *              §5.5 of the design doc spells out, and computes the
 *              order's hash.
 *
 *           2. Borrower calls {postPrepayListing}(loanId, askPrice,
 *              orderHash, conduit). The facet validates authority +
 *              opt-in + ask vs floor + grace window, **locks** the
 *              borrower-position NFT via
 *              `LibERC721._lock(LockReason.PrepayCollateralListing)`,
 *              **records** the orderHash on the executor (so the
 *              executor's ERC-1271 path returns the magic value at
 *              fill time), and **bookkeeps** the active orderHash on
 *              `s.prepayListingOrderHash[loanId]` so cancel paths
 *              can find it without the caller passing it back in.
 *
 *           3. Frontend posts the signed order to OpenSea / a
 *              compatible Seaport book.
 *
 *           4. A buyer fills the order on Seaport. Seaport (a)
 *              consults the vault's ERC-1271 (which delegates to the
 *              executor's `isValidSignature`), (b) pulls the NFT
 *              from the vault, (c) routes the three consideration
 *              legs, (d) fires the executor's `validateOrder` zone
 *              callback. The executor's zone callback then
 *              call-backs into the diamond's
 *              {PrepayListingFacet.executorFinalizePrepaySale} —
 *              that's the path that flips Active → Settled,
 *              unlocks the borrower NFT, settles the borrower's
 *              VPFI LIF rebate.
 *
 *           5. If the buyer never shows: the borrower can
 *              {cancelPrepayListing} pre-grace, or anyone can
 *              {cancelExpiredPrepayListing} post-grace as the
 *              permissionless safety net. Both clear the orderHash
 *              on the executor + the diamond's bookkeeping +
 *              release the lock.
 *
 * @dev   Pausable. Mirrors the existing facet conventions
 *        (`DiamondPausable` for the `whenNotPaused` gate;
 *        `DiamondAccessControl` for role storage even though this
 *        facet has no role-gated entries — keeps the inheritance
 *        chain symmetric with sister facets so future selector
 *        sweeps don't have to special-case this one). The
 *        permissionless cancel path INTENTIONALLY does not carry
 *        `whenNotPaused` — see {cancelExpiredPrepayListing} for why.
 *
 *        The executor address is read from
 *        `s.collateralListingExecutor` (set via the admin entry on
 *        the step-5 `PrepayListingFacet`). If unset the facet
 *        reverts {ExecutorNotSet} — every post/update/cancel path
 *        must talk to the executor, so an unconfigured singleton is
 *        a hard error rather than silent fallthrough.
 */
contract NFTPrepayListingFacet is
    DiamondPausable,
    DiamondReentrancyGuard,
    DiamondAccessControl,
    IVaipakamErrors
{
    // ─── Events ─────────────────────────────────────────────────────────

    /// @notice Emitted when the borrower posts a new prepay listing.
    /// @dev    T-086 step 14 — `conduitKey`, `salt`, and `executor`
    ///         are emitted so the off-chain indexer fallback (#311)
    ///         can autonomously reconstruct the canonical Seaport
    ///         `OrderComponents` and republish to OpenSea even when
    ///         the borrower's browser closed between tx-confirm and
    ///         the dapp's immediate POST. `executor` is the pinned
    ///         address used as the order's `zone` — emitting it
    ///         (rather than relying on `s.collateralListingExecutor`
    ///         being still-current at indexer-ingest time) makes the
    ///         reconstruction robust to a governance executor
    ///         rotation between post and indexer ingest. The
    ///         resolved `conduit` address stays for backward
    ///         compatibility + cheap reads (the indexer doesn't
    ///         have to re-call the ConduitController to map back).
    /// @dev T-086 Round-5 Block A (#313) — emits the full `FeeLeg[]`
    ///       as event data (NOT a hashed root) so the indexer's
    ///       autonomous-publish fallback path can populate
    ///       `prepay_listings.fee_legs_json` from chain logs alone.
    ///       See §14.6 of the merged design + the Round-5.1 errata.
    /// @dev T-086 Round-5 Block B (#309) — extended with Dutch
    ///       fields: `endAskPrice`, `auctionEndTime`, `mode` (= 0
    ///       for fixed-price, 1 for Dutch). The single shared event
    ///       shape keeps the indexer's event-coverage allowlist
    ///       tight + lets the `auction_mode` D1 column be a single
    ///       discriminator on the same row. For fixed-price posts
    ///       `endAskPrice == askPrice` and `auctionEndTime == 0`.
    ///
    ///       **Topic-hash change vs Round-4 / Block A.** Appending
    ///       the three trailing fields rotates the event's keccak256
    ///       topic-hash. The indexer's decoder derives its event-
    ///       coverage allowlist from the current ABI bundle; an
    ///       indexer redeployment whose cursor or backfill range
    ///       crosses a pre-Block-B emission would SILENTLY SKIP the
    ///       old-shape log (viem returns `eventName: undefined` and
    ///       the handler's `else if` chain falls through).
    ///
    ///       Pre-live discipline (`memory/project_platform_prelive.md`):
    ///       no production deployment exists today, so no legacy
    ///       on-chain emissions persist anywhere except short-lived
    ///       testnet rehearsals. The operator's rollout rule for
    ///       mainnet (and any new testnet) is to deploy the indexer
    ///       with a **fresh cursor that starts at the deploy block
    ///       of the new diamond** — pre-Block-B logs from old
    ///       diamonds aren't replayed. Adding a legacy-ABI fallback
    ///       decoder to the indexer was considered + rejected as
    ///       unnecessary for the pre-live case + a footgun (the
    ///       legacy decoder would silently mask any future event
    ///       shape regression).
    /// @custom:event-category state-change/loan-mutation
    event PrepayListingPosted(
        uint256 indexed loanId,
        address indexed lister,
        bytes32 indexed orderHash,
        uint256 askPrice,
        address conduit,
        bytes32 conduitKey,
        uint256 salt,
        address executor,
        uint256 endAskPrice,
        uint256 auctionEndTime,
        uint8 mode,
        FeeLeg[] feeLegs
    );

    /// @notice Emitted when the borrower updates an existing
    ///         listing's ask price + orderHash (a re-sign with the
    ///         live floor, typically a few hours into the listing
    ///         once interest has eaten through the buffer).
    /// @dev    T-086 step 14 — see {PrepayListingPosted} for why
    ///         `conduitKey`, `salt`, and `executor` are emitted.
    ///         The update path's `newSalt` is the borrower's fresh
    ///         random for this re-sign; the new conduitKey may
    ///         equal the old one or change; the executor is the
    ///         current executor at the update tx (governance may
    ///         have rotated between post and update).
    /// @dev T-086 Round-5 Block A (#313) — same FeeLeg[] tail as
    ///       {PrepayListingPosted}. See §14.6 + Round-5.1 errata.
    /// @dev T-086 Round-5 Block B (#309) — same Dutch-fields
    ///       extension as {PrepayListingPosted}. For fixed-price
    ///       updates `newEndAskPrice == newAskPrice` and
    ///       `newAuctionEndTime == 0`.
    /// @custom:event-category state-change/loan-mutation
    event PrepayListingUpdated(
        uint256 indexed loanId,
        address indexed lister,
        bytes32 oldOrderHash,
        bytes32 indexed newOrderHash,
        uint256 newAskPrice,
        address conduit,
        bytes32 newConduitKey,
        uint256 newSalt,
        address executor,
        uint256 newEndAskPrice,
        uint256 newAuctionEndTime,
        uint8 mode,
        FeeLeg[] feeLegs
    );

    /// @notice Emitted on every listing cancel — by the borrower
    ///         pre-grace, by anyone post-grace.
    /// @custom:event-category state-change/loan-mutation
    event PrepayListingCanceled(
        uint256 indexed loanId,
        address indexed caller,
        bytes32 indexed orderHash,
        CancelReason reason
    );

    /// @notice #1144 (S10 Invariant B) — emitted by `syncPrepaySaleListing`. When
    ///         `flaggedFound` is true, at least one live consideration recipient
    ///         was sanctions-flagged, was registered in `sanctionsConfirmedFlagged`,
    ///         and the listing was cancelled. When false, every recipient read
    ///         clean (or the oracle was unavailable) and the listing is untouched.
    /// @custom:event-category state-change/loan-mutation
    event PrepaySaleListingSynced(
        uint256 indexed loanId,
        address indexed caller,
        bool flaggedFound
    );

    // ─── Errors ─────────────────────────────────────────────────────────

    /// @notice `msg.sender` does not currently hold the loan's
    ///         borrower-position NFT (someone bought/transferred it
    ///         after the loan opened — only the current holder may
    ///         post / update / cancel).
    error NotPositionHolder(uint256 loanId, address caller, address expected);

    /// @notice The loan's lender consent flag is `false`. Set at
    ///         loan-init from the offer; cannot be flipped on a
    ///         live loan.
    error PrepayListingNotAllowed(uint256 loanId);
    /// @notice T-086 Round-8 (#358) Codex round-8 P2 #5 — raised
    ///         when `postPrepayListing` or `updatePrepayListing` is
    ///         called against a loan whose parent offer has a
    ///         carried-through parallel-sale listing live. The two
    ///         listings would share the ERC721 per-token conduit
    ///         approval slot; the loan-keyed `wire` would overwrite
    ///         the parallel-sale's approval. Borrower must call
    ///         `OfferParallelSaleFacet.releaseParallelSaleLock(offerId)`
    ///         first.
    error SiblingParallelSaleListingLive(uint256 loanId, uint96 offerId);

    /// @notice Loan is not `Active` (already Settled / Repaid /
    ///         Defaulted / Liquidated).
    error PrepayLoanNotActive(uint256 loanId, LibVaipakam.LoanStatus actual);

    /// @notice Trying to post on a loan that already has a live
    ///         listing — use {updatePrepayListing} instead.
    error PrepayListingAlreadyExists(uint256 loanId, bytes32 existingOrderHash);

    /// @notice No active listing for `loanId`. Either none ever
    ///         posted, or a prior cancel cleared it.
    error PrepayListingNotFound(uint256 loanId);

    /// @notice `askPrice` is below `liveFloor × (1 + bufferBps)`
    ///         at sign time.
    error AskBelowFloor(uint256 loanId, uint256 askPrice, uint256 minAsk);

    /// @notice Trying to act inside the grace window when the
    ///         action is only valid after grace expiry
    ///         ({cancelExpiredPrepayListing}).
    error GraceNotExpired(uint256 loanId, uint256 nowTime, uint256 gracePeriodEnd);

    /// @notice Round-5 Block B (#309) post-merge polish — Codex P2:
    ///         Dutch listings can be cleaned up once their
    ///         `auctionEndTime` has passed (Seaport rejects fills
    ///         after that tick, so the borrower's NFT is locked
    ///         to a dead order). This revert fires when a caller
    ///         tries to clean up a Dutch listing whose
    ///         `auctionEndTime` hasn't yet passed.
    error AuctionWindowStillOpen(uint256 loanId, uint256 nowTime, uint256 auctionEndTime);

    /// @notice Trying to post / update at or after grace expiry.
    ///         Borrower must close via {DefaultedFacet} from here
    ///         on; pre-grace borrower listings are no longer
    ///         meaningful.
    error PrepayGraceWindowClosed(uint256 loanId, uint256 nowTime, uint256 gracePeriodEnd);

    /// @notice Conduit not in the executor's governance allow-list.
    error ConduitNotApproved(address conduit);

    /// @notice Executor singleton not configured. Governance must
    ///         call `PrepayListingFacet.setCollateralListingExecutor`
    ///         first.
    error ExecutorNotSet();

    /// @notice The loan's collateral isn't an ERC721 in v1. ERC1155
    ///         lands in step 9 (the design doc §7 + §13 step 15
    ///         deferral).
    error UnsupportedCollateralForV1(LibVaipakam.AssetType collateralType);

    /// @notice The loan's principal isn't ERC20. T-086 Seaport prepay
    ///         flow emits ERC20 consideration legs unconditionally
    ///         (`LibPrepayOrder._components`) and the executor's
    ///         `_assertOrderContent` rejects non-ERC20 lendingAsset
    ///         at fill time; recording a listing on an NFT-rental
    ///         loan would create orphan bookkeeping.
    error UnsupportedPrincipalForV1(LibVaipakam.AssetType principalType);

    /// @notice Buffer-bps not configured yet. The first ADMIN call
    ///         to `ConfigFacet.setPrepayListingBufferBps` enables
    ///         the path; the storage default 0 is the
    ///         intentional pre-config block.
    error PrepayListingBufferNotConfigured();

    /// @notice Caller-supplied zero `orderHash` — Seaport never
    ///         produces a zero hash so it's an obvious sentinel
    ///         the facet uses for "no listing".
    error ZeroOrderHash();

    /// @notice The borrower-position NFT is already locked under a
    ///         different reason (e.g. Preclose offset, EarlyWithdrawal
    ///         sale). Posting a prepay listing would overwrite that
    ///         reason and `_unlock` at cancel/fill time would clear
    ///         the older flow's lock state. Concurrent strategic
    ///         flows are not supported in v1; the borrower must
    ///         resolve the existing flow first.
    error BorrowerNFTAlreadyLocked(uint256 tokenId, LibERC721.LockReason currentReason);

    /// @notice Master kill-switch is off. ADMIN flips it on once
    ///         steps 7 (vault approval) + 10 (default-flow lock-
    ///         bypass) are wired end-to-end.
    error PrepayListingDisabled();

    // ─── Round-5 Block A (#313) errors ──────────────────────────────────

    /// @notice Borrower supplied more fee legs than the protocol cap
    ///         (`MAX_FEE_LEGS = 4`). The cap exists primarily as a
    ///         DoS bound on the executor's per-leg iteration; bumping
    ///         it requires a coordinated executor + facet update.
    error FeeLegsExceedCap(uint256 supplied, uint256 cap);

    /// @notice One of the supplied fee legs has a zero recipient
    ///         (would route the leg's tokens into oblivion at fill
    ///         time, defeating the OpenSea-fee-enforcement model
    ///         this surface exists to support).
    error FeeLegInvalidRecipient(uint256 idx);

    /// @notice One of the supplied fee legs has a zero amount on
    ///         either the start or end side. Zero legs clutter the
    ///         order shape without economic effect; the dapp should
    ///         pass a shorter array instead.
    error FeeLegInvalidAmount(uint256 idx);

    /// @notice Round-5 Block A: fixed-price posts MUST set
    ///         `startAmount == endAmount` on every fee leg. The
    ///         `≥` form is reserved for Dutch entry points
    ///         (Block B); accepting a decaying fee leg on the
    ///         fixed-price path would produce a hybrid order whose
    ///         cancel-time reconstruction (no auction-mode tag)
    ///         couldn't rebuild the original shape.
    error FeeLegDecayNotAllowedOnFixedPrice(uint256 idx);

    /// @notice Round-5 Block A: the sum-of-considerations equality
    ///         (`askPrice == lenderLeg + treasuryLeg + borrowerLeg +
    ///         sum(feeLegs.amount)`) failed. Either the dapp
    ///         miscomputed the fee amounts against the gross
    ///         askPrice, the schedule it queried changed mid-flight,
    ///         or `askPrice` doesn't cover the protocol legs plus
    ///         the buffer plus fees. The borrower's remainder
    ///         (after the buffer-bps margin on the protocol legs)
    ///         must be ≥ 0.
    error AskBelowFloorPlusFees(uint256 loanId, uint256 askPrice, uint256 required);

    // Round-5 Block B (#309) — Dutch-mode entry points + their
    // mode-specific errors live on the sibling facet
    // {NFTPrepayDutchListingFacet}. Shared storage (LibVaipakam) +
    // the same recorder interface keep both facets coherent on the
    // wire; the split is purely a bytecode-budget concern (see the
    // Dutch facet's natspec for the "Tag too large" rationale).

    // ─── Cancel-reason enum ─────────────────────────────────────────────

    /// @dev `Borrower` — current borrower-position holder cancelled
    ///      pre-grace; `GraceExpired` — permissionless cleanup
    ///      post-grace. Future reasons (e.g. lender-driven cancel
    ///      under default-flow lock-bypass — see design doc §5.4)
    ///      can append more enum values without renumbering.
    /// @dev T-086 Round-6 / Block D (#345) — `ReplacedByMatch` is
    ///      emitted by `NFTPrepayListingAtomicFacet`'s mandatory
    ///      auto-clear (§17.11 step 0(g) of the Round-6 design
    ///      doc) when a borrower clicks Match on a posted v1
    ///      listing: the atomic-match facet clears the existing
    ///      orderHash + lock as STEP 0 before constructing its
    ///      own counter-order, and emits this canceled-event
    ///      reason so the indexer can distinguish a
    ///      replaced-by-atomic-match cancel from a borrower's
    ///      manual cancel or a permissionless grace-expired one.
    enum CancelReason {
        Borrower,
        GraceExpired,
        ReplacedByMatch,
        // #1144 (S10 Invariant B) — cancelled by the permissionless
        // `syncPrepaySaleListing`: a live consideration recipient was found
        // sanctions-flagged and registered, so the listing is torn down so it
        // can't fill.
        SanctionsSync
    }

    // ─── Borrower entry: postPrepayListing ──────────────────────────────

    /// @notice Open a Seaport prepay-listing for a live loan's
    ///         collateral NFT.
    /// @dev    See contract-level natspec for the end-to-end flow
    ///         + the listing-time validation rules. Preconditions
    ///         (each reverting with the named error):
    ///           • `loan.status == Active`             → {PrepayLoanNotActive}
    ///           • `loan.allowsPrepayListing == true`  → {PrepayListingNotAllowed}
    ///           • `loan.collateralAssetType == ERC721` → {UnsupportedCollateralForV1}
    ///           • `block.timestamp < gracePeriodEnd`  → {PrepayGraceWindowClosed}
    ///           • caller owns borrower-position NFT   → {NotPositionHolder}
    ///           • no active listing on `loanId`        → {PrepayListingAlreadyExists}
    ///           • `conduit` ∈ executor allow-list      → {ConduitNotApproved}
    ///           • `askPrice ≥ floor × (1 + bufferBps)` → {AskBelowFloor}
    ///           • `cfgPrepayListingBufferBps > 0`      → {PrepayListingBufferNotConfigured}
    /// @param loanId       Loan being listed against.
    /// @param askPrice     Total sale price in the loan's principal
    ///                     token. The diamond constructs the
    ///                     Seaport order's consideration legs
    ///                     (lender + treasury + borrower) from
    ///                     this + the live floor.
    /// @param salt         Borrower-supplied nonce included in the
    ///                     Seaport order's `OrderComponents.salt`
    ///                     field. Ensures hash uniqueness across
    ///                     repeated re-signs of similar shapes;
    ///                     opaque to the diamond.
    /// @param conduitKey   The 32-byte Seaport conduit identifier
    ///                     (NOT the conduit address). The diamond
    ///                     resolves the key to its deployed
    ///                     address via Seaport's
    ///                     `ConduitController.getConduit(key)` and
    ///                     verifies the address is in the
    ///                     executor's `approvedConduits` allow-list.
    /// @return orderHash   The Seaport orderHash the frontend
    ///                     publishes to OpenSea / a Seaport order
    ///                     book. Identical to what
    ///                     `seaport.getOrderHash(components)`
    ///                     would return for the diamond-
    ///                     constructed `OrderComponents`.
    function postPrepayListing(
        uint256 loanId,
        uint256 askPrice,
        uint256 salt,
        bytes32 conduitKey,
        FeeLeg[] calldata feeLegs
    ) external nonReentrant whenNotPaused returns (bytes32 orderHash) {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        LibVaipakam.Loan storage loan = s.loans[loanId];

        if (!s.cfgPrepayListingEnabled) revert PrepayListingDisabled();
        if (loan.status != LibVaipakam.LoanStatus.Active) {
            revert PrepayLoanNotActive(loanId, loan.status);
        }
        if (!loan.allowsPrepayListing) {
            revert PrepayListingNotAllowed(loanId);
        }
        // T-086 Round-8 (#358) Codex round-8 P2 #5 — block loan-keyed
        // listing while a carried-through PARALLEL-SALE listing is
        // live on the loan's parent offer. For ERC721 collateral the
        // conduit approval is a per-token single slot; if the loan-
        // keyed listing uses a different conduit, its `wire` would
        // OVERWRITE the parallel-sale listing's approval, leaving the
        // parallel-sale order still ERC-1271-signable but unfillable.
        // Borrower must `releaseParallelSaleLock(offerId)` first.
        if (s.offerPrepayListingOrderHash[uint96(loan.offerId)] != bytes32(0)) {
            revert SiblingParallelSaleListingLive(loanId, uint96(loan.offerId));
        }
        // ERC721 + ERC1155 supported (step 15 + #306 fix). ERC20
        // collateral isn't listable on Seaport (no NFT identifier).
        if (
            loan.collateralAssetType != LibVaipakam.AssetType.ERC721 &&
            loan.collateralAssetType != LibVaipakam.AssetType.ERC1155
        ) {
            revert UnsupportedCollateralForV1(loan.collateralAssetType);
        }
        // Codex round-1 P2 fix on PR #317 — gate on ERC20 principal.
        // The executor's `_assertOrderContent` rejects non-ERC20
        // lendingAsset at fill time; `LibPrepayOrder._components`
        // emits ERC20 consideration legs unconditionally. An
        // NFT-rental loan with `allowsPrepayListing=true` would
        // therefore record an UNFILLABLE listing here while still
        // taking the borrower-NFT lock + executor + vault binding —
        // creating orphan state until manual cancel. Hard-reject
        // at the facet boundary instead of relying on the executor
        // and the frontend availability gate to keep this invariant.
        if (loan.assetType != LibVaipakam.AssetType.ERC20) {
            revert UnsupportedPrincipalForV1(loan.assetType);
        }

        // Listing-already-exists check fires BEFORE the lock check
        // so a same-facet double-post gets the more specific error;
        // the lock check then catches cross-flow collisions
        // (Preclose offset / EarlyWithdrawal sale).
        bytes32 existing = s.prepayListingOrderHash[loanId];
        if (existing != bytes32(0)) {
            revert PrepayListingAlreadyExists(loanId, existing);
        }
        LibERC721.LockReason currentLock = LibERC721.lockOf(loan.borrowerTokenId);
        if (currentLock != LibERC721.LockReason.None) {
            revert BorrowerNFTAlreadyLocked(loan.borrowerTokenId, currentLock);
        }

        // Grace-window upper bound.
        uint256 gracePeriodEnd = _gracePeriodEnd(loan);
        if (block.timestamp >= gracePeriodEnd) {
            revert PrepayGraceWindowClosed(loanId, block.timestamp, gracePeriodEnd);
        }

        // Authority — must currently hold the borrower-position NFT.
        address holder = VaipakamNFTFacet(address(this)).ownerOf(loan.borrowerTokenId);
        if (holder != msg.sender) {
            revert NotPositionHolder(loanId, msg.sender, holder);
        }
        // #818 Tier-1 sanctions — posting a collateral-sale listing creates
        // fresh state that routes value to the holder on fill. The atomic-match
        // / auto-list / executor-callback paths are already gated; the manual
        // post/update paths were not. `holder == msg.sender` here, so screening
        // the caller screens the listing's beneficiary.
        LibVaipakam._assertNotSanctioned(msg.sender);
        // #825-r2 (P1) — also screen every fee-leg recipient: a fee leg pays an
        // arbitrary caller-supplied address on fill, so the holder screen alone
        // would leave that value-to-flagged route open.
        LibPrepayListingWiring.assertFeeLegRecipientsNotSanctioned(feeLegs);

        // #656b (#594) — consolidate the borrower side to the current holder
        // before the order is built + the vault cached, so the listing binds the
        // holder's vault and the position isn't locked out of consolidation
        // under the listing hash (no live hash here — lock-check above).
        LibFacet.crossFacetCall(
            abi.encodeWithSelector(
                ConsolidationFacet.eagerConsolidateToHolder.selector,
                loanId,
                /* isLenderSide */ false
            ),
            bytes4(0)
        );

        // Live-floor + buffer + fee-legs validation.
        IListingExecutorRecorder executor = _requireExecutor(s);
        _validateFeeLegsFixedPrice(feeLegs);
        _requireAskCoversFloorWithFees(loanId, askPrice, s.cfgPrepayListingBufferBps, feeLegs);

        // #306 architectural fix — diamond CONSTRUCTS the Seaport
        // order from verified loan parameters + derives the
        // orderHash via Seaport's own `getOrderHash` view. The
        // borrower-controlled inputs (`askPrice`, `salt`,
        // `conduitKey`, `feeLegs`) are bound to a known canonical
        // order shape; the vault's ERC-1271 can never authorise a
        // different shape.
        orderHash = _buildAndRecord(s, loan, loanId, askPrice, salt, conduitKey, executor, feeLegs);

        // T-086 step 14 — emit `conduitKey` + `salt` + `executor`
        // so the indexer can reconstruct the canonical Seaport
        // OrderComponents off-chain and autonomously republish to
        // OpenSea even if the borrower's browser closed between
        // tx-confirm and the dapp's immediate proxy POST. Emitting
        // `executor` (rather than relying on the current global
        // `s.collateralListingExecutor` at indexer-ingest time) makes
        // the reconstruction safe across a governance executor
        // rotation between post and ingest. See #311.
        emit PrepayListingPosted(
            loanId,
            msg.sender,
            orderHash,
            askPrice,
            _resolveConduit(executor, conduitKey),
            conduitKey,
            salt,
            address(executor),
            askPrice,                    // endAskPrice (fixed-price → start)
            0,                           // auctionEndTime sentinel
            PREPAY_MODE_FIXED_PRICE,
            feeLegs
        );
    }

    /// @dev Heavy-lifting helper extracted so `postPrepayListing`
    ///      stays under stack-depth + the diamond facet under
    ///      EIP-170. Resolves the conduit address from the
    ///      borrower-supplied `conduitKey`, verifies allow-list
    ///      membership, builds the canonical order shape via
    ///      `LibPrepayOrder.buildAndHash`, locks the borrower
    ///      NFT, records on the executor, and wires the vault.
    function _buildAndRecord(
        LibVaipakam.Storage storage s,
        LibVaipakam.Loan storage loan,
        uint256 loanId,
        uint256 askPrice,
        uint256 salt,
        bytes32 conduitKey,
        IListingExecutorRecorder executor,
        FeeLeg[] calldata feeLegs
    ) private returns (bytes32 orderHash) {
        // Resolve conduit address from key via Seaport's
        // ConduitController; bind (key, address) on-chain so a
        // borrower can't supply a mismatched pair.
        address conduit = _resolveConduit(executor, conduitKey);
        if (!executor.approvedConduits(conduit)) {
            revert ConduitNotApproved(conduit);
        }

        // Build the canonical Seaport order + derive its hash.
        IVaipakamPrepayContext.PrepayContext memory pctx =
            IVaipakamPrepayContext(address(this)).getPrepayContext(loanId, block.timestamp);
        address vaultAddr = s.userVaipakamVaults[loan.borrower];
        // T-086 Block D #346 round-8: standardised vault-missing
        // symbol across postPrepayListing + updatePrepayListing +
        // Dutch + atomic facets.
        if (vaultAddr == address(0)) revert LibPrepayListingWiring.VaultNotDeployed(loan.borrower);
        orderHash = LibPrepayOrder.buildAndHash(
            pctx,
            vaultAddr,
            address(executor),
            CollateralListingExecutor(address(executor)).seaport(),
            askPrice,
            pctx.lenderLeg,
            pctx.treasuryLeg,
            salt,
            conduitKey,
            feeLegs
        );

        // Atomic state mutations — lock → bookkeep → record →
        // wire vault. Effects-before-interactions: storage writes
        // BEFORE the external calls to executor + vault, even
        // though both are trusted singletons.
        LibERC721._lock(loan.borrowerTokenId, LibERC721.LockReason.PrepayCollateralListing);
        s.prepayListingOrderHash[loanId] = orderHash;
        s.prepayListingExecutor[loanId] = address(executor);
        // T-086 #316 + Round-5 Block A (#313) + Round-5 Block B (#309) —
        // recordOrder pins every sign-time input + the auction-mode
        // tag. Fixed-price stamps `endAskPrice == askPrice` and
        // `auctionEndTime == 0` so cancel-time reconstruction reads
        // `pctx.graceEnd` as Seaport endTime (matching the Round-4
        // shape verbatim). Block B's Dutch entry points pass
        // `mode = PREPAY_MODE_DUTCH` + the auction-end-time +
        // end-ask values; the executor's cancel-time dispatcher
        // picks the right component builder.
        executor.recordOrder(
            orderHash,
            loanId,
            conduit,
            conduitKey,
            salt,
            block.timestamp,
            askPrice,
            askPrice,                    // endAskPrice = askPrice
            0,                           // auctionEndTime = 0 sentinel
            PREPAY_MODE_FIXED_PRICE,
            feeLegs,
            // T-086 Round-7 (Issue #355) — signed-leg snapshot.
            // Fixed-price orders set consideration[0].amount =
            // pctx.lenderLeg, consideration[1].amount = pctx.treasuryLeg
            // verbatim per LibPrepayOrder.buildAndHash.
            pctx.lenderLeg,
            pctx.treasuryLeg
        );
        _wireVaultForListing(s, loan, orderHash, conduit, address(executor));
    }

    /// @dev Resolve a `conduitKey` to its deployed conduit address
    ///      via Seaport's ConduitController. Shared by
    ///      `postPrepayListing` (record + emit) and
    ///      `updatePrepayListing` (record + emit).
    function _resolveConduit(
        IListingExecutorRecorder executor,
        bytes32 conduitKey
    ) private view returns (address) {
        return LibPrepayOrder.resolveConduit(
            CollateralListingExecutor(address(executor)).seaport(),
            conduitKey
        );
    }

    // ─── Borrower entry: updatePrepayListing ────────────────────────────

    /// @notice Replace the live listing with a fresh ask + orderHash.
    /// @dev    Same preconditions as {postPrepayListing} EXCEPT a
    ///         live listing MUST already exist (otherwise call
    ///         `post`). The implementation clears the old orderHash
    ///         on the executor + diamond bookkeeping, then records
    ///         the new one — the lock stays on throughout (an
    ///         update is a re-sign, not a cancel + re-post race
    ///         window).
    function updatePrepayListing(
        uint256 loanId,
        uint256 newAskPrice,
        uint256 newSalt,
        bytes32 newConduitKey,
        FeeLeg[] calldata feeLegs
    ) external nonReentrant whenNotPaused returns (bytes32 newOrderHash) {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        LibVaipakam.Loan storage loan = s.loans[loanId];

        if (!s.cfgPrepayListingEnabled) revert PrepayListingDisabled();
        if (loan.status != LibVaipakam.LoanStatus.Active) {
            revert PrepayLoanNotActive(loanId, loan.status);
        }
        if (!loan.allowsPrepayListing) {
            revert PrepayListingNotAllowed(loanId);
        }
        // Codex round-8 P2 #5 — same sibling-parallel-sale block
        // as `postPrepayListing`. Update could rotate the conduit
        // key, which would overwrite the parallel-sale's approval.
        if (s.offerPrepayListingOrderHash[uint96(loan.offerId)] != bytes32(0)) {
            revert SiblingParallelSaleListingLive(loanId, uint96(loan.offerId));
        }
        // Codex round-2 P2 fix on PR #317 — same principal-type gate
        // as `postPrepayListing`. Without it, a pre-PR orphan
        // listing on an NFT-rental loan (from before round-1's
        // post-time check landed) could still be re-signed via
        // `update` — recreating the orphan bookkeeping until manual
        // cancel.
        if (loan.assetType != LibVaipakam.AssetType.ERC20) {
            revert UnsupportedPrincipalForV1(loan.assetType);
        }

        uint256 gracePeriodEnd = _gracePeriodEnd(loan);
        if (block.timestamp >= gracePeriodEnd) {
            revert PrepayGraceWindowClosed(loanId, block.timestamp, gracePeriodEnd);
        }

        address holder = VaipakamNFTFacet(address(this)).ownerOf(loan.borrowerTokenId);
        if (holder != msg.sender) {
            revert NotPositionHolder(loanId, msg.sender, holder);
        }
        // #818 Tier-1 sanctions — see `postPrepayListing`. `holder == msg.sender`.
        LibVaipakam._assertNotSanctioned(msg.sender);
        // #825-r2 (P1) — screen fee-leg recipients (see `postPrepayListing`).
        LibPrepayListingWiring.assertFeeLegRecipientsNotSanctioned(feeLegs);

        bytes32 oldOrderHash = s.prepayListingOrderHash[loanId];
        if (oldOrderHash == bytes32(0)) {
            revert PrepayListingNotFound(loanId);
        }

        IListingExecutorRecorder currentExecutor = _requireExecutor(s);
        _validateFeeLegsFixedPrice(feeLegs);
        _requireAskCoversFloorWithFees(loanId, newAskPrice, s.cfgPrepayListingBufferBps, feeLegs);

        // Clear the old order on the EXECUTOR THAT ORIGINALLY
        // recorded it — survives a governance rotation between
        // post and update (Codex P2 round-2 fix on PR #300).
        address pinnedExecutor = s.prepayListingExecutor[loanId];
        if (pinnedExecutor != address(0)) {
            IListingExecutorRecorder(pinnedExecutor).clearOrder(oldOrderHash);
        }

        // Vault-side: revoke the old orderHash → executor binding
        // BEFORE building the new one (so the vault's ERC-1271
        // can't briefly authorise BOTH the old and new hashes in
        // any half-state). Round-6 Block D #346: route through the
        // shared `LibPrepayListingWiring.unwire` so v1 fixed +
        // v1 Dutch + v2 atomic facets all clear vault state via
        // the same primitive. The vault-existence precondition
        // is enforced upfront so `_buildAndRecordUpdate` below
        // sees a non-zero offerer.
        address vaultAddr = s.userVaipakamVaults[loan.borrower];
        if (vaultAddr == address(0)) revert LibPrepayListingWiring.VaultNotDeployed(loan.borrower);
        LibPrepayListingWiring.unwire(s, loan, oldOrderHash);

        // Build + record the new order with the canonical shape
        // (same construction as `postPrepayListing` — `LibPrepayOrder`
        // staticcalls Seaport's `getOrderHash` over verified
        // OrderComponents). #306 architectural fix.
        newOrderHash = _buildAndRecordUpdate(
            s, loan, loanId, newAskPrice, newSalt, newConduitKey, currentExecutor, feeLegs
        );

        // T-086 step 14 — same `conduitKey` + `salt` + `executor`
        // emit shape as `PrepayListingPosted` so the indexer
        // fallback can republish an update verbatim (see #311).
        emit PrepayListingUpdated(
            loanId,
            msg.sender,
            oldOrderHash,
            newOrderHash,
            newAskPrice,
            _resolveConduit(currentExecutor, newConduitKey),
            newConduitKey,
            newSalt,
            address(currentExecutor),
            newAskPrice,                 // newEndAskPrice (fixed-price → start)
            0,                           // newAuctionEndTime sentinel
            PREPAY_MODE_FIXED_PRICE,
            feeLegs
        );
    }

    /// @dev Heavy-lifting helper for `updatePrepayListing` that
    ///      writes the post-rotation state (mirror of
    ///      `_buildAndRecord` minus the lock — lock stays on
    ///      across an update, only the orderHash + executor +
    ///      vault binding rotate).
    function _buildAndRecordUpdate(
        LibVaipakam.Storage storage s,
        LibVaipakam.Loan storage loan,
        uint256 loanId,
        uint256 askPrice,
        uint256 salt,
        bytes32 conduitKey,
        IListingExecutorRecorder executor,
        FeeLeg[] calldata feeLegs
    ) private returns (bytes32 newOrderHash) {
        address conduit = _resolveConduit(executor, conduitKey);
        if (!executor.approvedConduits(conduit)) {
            revert ConduitNotApproved(conduit);
        }

        IVaipakamPrepayContext.PrepayContext memory pctx =
            IVaipakamPrepayContext(address(this)).getPrepayContext(loanId, block.timestamp);
        address vaultAddr = s.userVaipakamVaults[loan.borrower];
        newOrderHash = LibPrepayOrder.buildAndHash(
            pctx,
            vaultAddr,
            address(executor),
            CollateralListingExecutor(address(executor)).seaport(),
            askPrice,
            pctx.lenderLeg,
            pctx.treasuryLeg,
            salt,
            conduitKey,
            feeLegs
        );

        s.prepayListingOrderHash[loanId] = newOrderHash;
        s.prepayListingExecutor[loanId] = address(executor);
        // T-086 #316 + Round-5 Block A (#313) + Round-5 Block B (#309) +
        // Round-7 Issue #355 — same sign-time-input pinning as the post
        // path including fee legs + the auction-mode tag + the signed-
        // leg snapshot. Fixed-price stamps `endAskPrice == askPrice`
        // and `auctionEndTime == 0`; the signed legs come from the live
        // pctx since LibPrepayOrder.buildAndHash sets
        // consideration[0/1].amount = pctx.lenderLeg / pctx.treasuryLeg
        // verbatim.
        executor.recordOrder(
            newOrderHash,
            loanId,
            conduit,
            conduitKey,
            salt,
            block.timestamp,
            askPrice,
            askPrice,                    // endAskPrice = askPrice
            0,                           // auctionEndTime = 0 sentinel
            PREPAY_MODE_FIXED_PRICE,
            feeLegs,
            pctx.lenderLeg,
            pctx.treasuryLeg
        );

        // Vault rotation: register the new orderHash binding +
        // re-grant the conduit approval (idempotent if conduit
        // unchanged; updates target if the borrower picked a
        // different conduitKey for the re-sign).
        // T-086 Round-6 / Block D (#345) — delegated to the shared
        // `LibPrepayListingWiring.wire` so both v1 post + update and
        // the new atomic-match facet stay in lock-step. v1 behavior
        // unchanged.
        LibPrepayListingWiring.wire(s, loan, newOrderHash, conduit, address(executor));
    }

    // ─── Borrower entry: cancelPrepayListing ────────────────────────────

    /// @notice Borrower-side cancel of a live listing.
    /// @dev    Authority gated on current borrower-position holder
    ///         (same gate as `post` / `update`). Permits cancel
    ///         pre- AND post-grace; this is the borrower's
    ///         explicit cancel, distinct from the permissionless
    ///         {cancelExpiredPrepayListing}. We release the lock
    ///         + clear the diamond bookkeeping + tell the executor
    ///         to clear the orderHash.
    function cancelPrepayListing(uint256 loanId) external nonReentrant whenNotPaused {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        LibVaipakam.Loan storage loan = s.loans[loanId];

        // INTENTIONALLY no loan-status gate (Codex P2 round-2 fix).
        // No-status-gate retained — even though `RepayFacet.repayLoan`,
        // `PrecloseFacet` (direct + offset), and `RefinanceFacet` now
        // call `LibPrepayCleanup.clearActiveListing` atomically with
        // their Active→Repaid transition (T-086 follow-up to step
        // 14), this borrower escape hatch remains the safety net for
        // any pre-PR row that may have slipped through OR any future
        // close path that forgets to wire the cleanup. The operation
        // is no-fund-movement (lock release + bookkeeping clear),
        // safe across every terminal state. Cancel is idempotent;
        // calling it after the terminal already swept is a cheap
        // no-op via the orderHash early-return.

        address holder = VaipakamNFTFacet(address(this)).ownerOf(loan.borrowerTokenId);
        if (holder != msg.sender) {
            revert NotPositionHolder(loanId, msg.sender, holder);
        }

        bytes32 orderHash = s.prepayListingOrderHash[loanId];
        if (orderHash == bytes32(0)) {
            revert PrepayListingNotFound(loanId);
        }

        // T-086 Round-7 (Issue #355) — borrower's grace-window cancel is
        // the escape hatch from the permissionless auto-list-at-floor
        // path: SET the sticky opt-out flag so a same-block keeper can
        // not immediately re-list after this cancel. Round-3.4 (Raja
        // P2 #3): BOTH conditions must hold — we're in the grace
        // window AND a live listing was actually unwound (the
        // `orderHash != 0` check above already guarantees the second).
        // Outside-grace cancels (during the active loan) don't set the
        // flag — the borrower has time to repay or reconsider their
        // listing plan; only the grace-window cancel is the
        // "stop the auto-list" signal.
        if (LibVaipakam.isGraceWindow(loan)) {
            s.prepayListingAutoListOptedOut[loanId] = true;
        }

        _cancel(s, loan, loanId, orderHash, CancelReason.Borrower);
    }

    // ─── T-086 Round-7 (Issue #355) — auto-list opt-out controls ─────────

    /// @notice Emitted when the borrower clears the auto-list opt-out
    ///         flag, re-enabling permissionless `autoListAtFloorOnGrace`
    ///         calls for the loan.
    /// @custom:event-category state-change/loan-mutation
    event AutoListOptOutCleared(uint256 indexed loanId, address indexed clearedBy);

    /// @notice Borrower-only clear of the per-loan auto-list opt-out
    ///         flag. Counter-action to the sticky flag set by
    ///         `cancelPrepayListing` when invoked during the grace
    ///         window. Lets a borrower who changed their mind explicitly
    ///         re-enable permissionless `autoListAtFloorOnGrace` rotation
    ///         without canceling-and-not-cancelling games.
    /// @dev    Gated on current borrower-position holder (same gate as
    ///         `post` / `update` / `cancel`). `whenNotPaused` because
    ///         the flag flip is a state-change op — operationally
    ///         dormant while the diamond is paused, parallel to the
    ///         post / update paths. `nonReentrant` for parity with
    ///         every other position-holder-gated entry.
    ///
    ///         No-op semantics if the flag is already `false`: emits
    ///         `AutoListOptOutCleared` regardless so a frontend's
    ///         "I cleared this" UX confirmation can rely on the event.
    /// @param loanId Loan whose opt-out to clear.
    function clearAutoListOptOut(uint256 loanId) external nonReentrant whenNotPaused {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        LibVaipakam.Loan storage loan = s.loans[loanId];

        address holder = VaipakamNFTFacet(address(this)).ownerOf(loan.borrowerTokenId);
        if (holder != msg.sender) {
            revert NotPositionHolder(loanId, msg.sender, holder);
        }

        s.prepayListingAutoListOptedOut[loanId] = false;
        emit AutoListOptOutCleared(loanId, msg.sender);
    }

    // ─── Permissionless entry: cancelExpiredPrepayListing ───────────────

    /// @notice Permissionless cleanup of a listing whose grace
    ///         window has expired without a fill.
    /// @dev    Three rationale points worth keeping in mind:
    ///
    ///         1. **Lock liveness.** The borrower-position NFT
    ///            stays locked until either a fill (zone callback
    ///            unlocks) or a cancel (this path / borrower
    ///            cancel). If neither runs, the borrower can't
    ///            transfer / re-list. Permissionless cleanup
    ///            removes the dependency on the borrower being
    ///            alive at grace expiry.
    ///
    ///         2. **Default-flow interplay.** Per design doc §5.4,
    ///            `DefaultedFacet.markDefaulted` and
    ///            `RiskFacet.triggerLiquidation` ALSO unlock the
    ///            borrower NFT as their first step if the lock
    ///            reason is `PrepayCollateralListing`. So
    ///            `cancelExpiredPrepayListing` is a *parallel*
    ///            safety net, not a strict prerequisite — either
    ///            this OR the default trigger can run; whichever
    ///            wins first leaves the loan in the right state.
    ///
    ///         3. **No `whenNotPaused`.** The cleanup path
    ///            INTENTIONALLY does NOT gate on pause — if the
    ///            diamond is paused, locked NFTs would otherwise
    ///            stay locked indefinitely while users wait for
    ///            unpause. The cancel is a no-fund-movement
    ///            operation (just releases a lock + clears a
    ///            mapping); it's safe to run while paused.
    function cancelExpiredPrepayListing(uint256 loanId) external nonReentrant {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        LibVaipakam.Loan storage loan = s.loans[loanId];

        // INTENTIONALLY no loan-status gate here. After grace
        // expiry, `DefaultedFacet.markDefaulted` / RiskFacet
        // liquidation might flip the loan to `Defaulted` /
        // `Liquidated` BEFORE this cleanup runs. The design-doc
        // §5.4 plan has those default-flow facets unlock the
        // borrower NFT themselves as their first step (step 10),
        // but until that wires up the borrower NFT would sit
        // locked with no escape if we gated this cleanup on
        // `Active`. So: any loan-status is acceptable here. The
        // operation is no-fund-movement (just lock release +
        // bookkeeping clear); safe across every terminal state.

        bytes32 orderHash = s.prepayListingOrderHash[loanId];
        if (orderHash == bytes32(0)) {
            revert PrepayListingNotFound(loanId);
        }

        // Round-5 Block B (#309) post-merge polish — Codex P2 (mode-
        // aware permissionless cleanup):
        //   - Fixed-price listings (or no recorded mode):
        //     cleanup is valid at strict `block.timestamp >
        //     gracePeriodEnd`. Matches the existing semantics +
        //     the executor's `block.timestamp > pctx.graceEnd →
        //     GraceExpired` reject.
        //   - Dutch listings: cleanup is valid at strict
        //     `block.timestamp > auctionEndTime`. Seaport rejects
        //     fills past `OrderComponents.endTime` (which the
        //     facet stamped as `auctionEndTime` for Dutch), so the
        //     order is functionally dead at that tick + the
        //     borrower-position NFT shouldn't have to wait until
        //     grace to be unlocked. The facet enforces
        //     `auctionEndTime <= gracePeriodEnd` at post-time, so
        //     the Dutch cleanup window opens earlier than (or at
        //     the same tick as) the grace cleanup window.
        // Resolve the recorded executor + mode + auctionEndTime by
        // calling the executor's auto-generated public getter for
        // `orderContext`. We discard most fields with named-
        // variable assignment to keep the destructure compact.
        address pinnedExecutor = s.prepayListingExecutor[loanId];
        uint8 mode = PREPAY_MODE_FIXED_PRICE;
        uint64 auctionEndTime = 0;
        if (pinnedExecutor != address(0)) {
            (
                ,                       // loanId
                ,                       // conduit
                ,                       // conduitKey
                ,                       // salt
                ,                       // startTime
                ,                       // askPrice
                ,                       // endAskPrice
                uint64 storedAuctionEnd,
                uint8 storedMode
            ) = CollateralListingExecutor(pinnedExecutor).orderContext(orderHash);
            mode = storedMode;
            auctionEndTime = storedAuctionEnd;
        }

        if (mode == PREPAY_MODE_DUTCH) {
            if (block.timestamp <= uint256(auctionEndTime)) {
                revert AuctionWindowStillOpen(
                    loanId,
                    block.timestamp,
                    uint256(auctionEndTime)
                );
            }
        } else {
            // Fixed-price (or pre-Block-B record): require grace.
            uint256 gracePeriodEnd = _gracePeriodEnd(loan);
            if (block.timestamp <= gracePeriodEnd) {
                revert GraceNotExpired(loanId, block.timestamp, gracePeriodEnd);
            }
        }

        _cancel(s, loan, loanId, orderHash, CancelReason.GraceExpired);
    }

    // ─── #1144 (S10 Invariant B): syncPrepaySaleListing ─────────────────

    /// @notice Permissionless sanctions sync for a LOAN-keyed prepay-collateral
    ///         listing. Reads every LIVE consideration recipient the order pays —
    ///         the current lender- and borrower-position holders plus the recorded
    ///         fee-leg recipients — and, on an authoritative oracle-up `Flagged`
    ///         read, COMMITS the flag to `sanctionsConfirmedFlagged` (via
    ///         `LibVaipakam.syncBuyerSanctionsFlag`) and CANCELS the listing so it
    ///         can no longer fill.
    /// @dev    The S10 Invariant B counterpart to Invariant A's deferred-claim
    ///         freeze: the prepay-sale channel pays holders INLINE inside the atomic
    ///         Seaport fill, where a `mustFreezeParty`-revert would roll its own
    ///         registry write back (Codex #1136-r5 R5-1). So the registration must
    ///         be committed by THIS separate, non-reverting call; the fill path then
    ///         consults the registry fail-closed as a backstop
    ///         (`CollateralListingExecutor._recipientBarred`). Permissionless like
    ///         `refreshSanctionsFlag` — a keeper, the counterparty, or anyone can
    ///         call it. Never reverts on a flag (it ACTS on it); reverts only when
    ///         there is no live listing to sync. `syncBuyerSanctionsFlag` no-ops on
    ///         an oracle outage and self-heals a stale marker on a clean read, so a
    ///         clean listing is never cancelled. See
    ///         docs/DesignsAndPlans/S10CentralEnforcement.md §2 Invariant B.
    function syncPrepaySaleListing(uint256 loanId) external nonReentrant {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        LibVaipakam.Loan storage loan = s.loans[loanId];

        bytes32 orderHash = s.prepayListingOrderHash[loanId];
        if (orderHash == bytes32(0)) {
            revert PrepayListingNotFound(loanId);
        }

        bool flaggedFound = false;
        // The two live position holders paid by consideration[0] / consideration[2].
        // `_ownerOfRaw` (raw SLOAD → address(0) for a burned token) keeps the sync
        // non-reverting even on a terminalized loan whose NFTs are gone.
        flaggedFound =
            _syncRecipientFlag(s, LibERC721._ownerOfRaw(loan.lenderTokenId)) ||
            flaggedFound;
        flaggedFound =
            _syncRecipientFlag(s, LibERC721._ownerOfRaw(loan.borrowerTokenId)) ||
            flaggedFound;

        // The recorded fee-leg recipients (the executor persisted them at post
        // time; the zone callback re-screens the live set, which this pre-registers).
        address pinnedExecutor = s.prepayListingExecutor[loanId];
        if (pinnedExecutor != address(0)) {
            FeeLeg[] memory legs =
                IListingExecutorRecorder(pinnedExecutor).orderFeeLegs(orderHash);
            for (uint256 i = 0; i < legs.length; ) {
                flaggedFound = _syncRecipientFlag(s, legs[i].recipient) || flaggedFound;
                unchecked {
                    ++i;
                }
            }
        }

        if (flaggedFound) {
            _cancel(s, loan, loanId, orderHash, CancelReason.SanctionsSync);
        }
        emit PrepaySaleListingSynced(loanId, msg.sender, flaggedFound);
    }

    /// @dev Register `who`'s live sanctions status into the committed registry
    ///      (no-op on `address(0)` / an oracle outage; self-heals a stale marker on
    ///      a clean read) and report whether it is now confirmed-flagged.
    function _syncRecipientFlag(LibVaipakam.Storage storage s, address who)
        private
        returns (bool)
    {
        LibVaipakam.syncBuyerSanctionsFlag(who);
        return who != address(0) && s.sanctionsConfirmedFlagged[who];
    }

    // ─── View: getPrepayListingOrderHash (read-side for frontends) ──────

    /// @notice Active orderHash for `loanId`, or `bytes32(0)` if
    ///         none. Indexer + frontend read this to render the
    ///         "your loan has a live listing" UI.
    function getPrepayListingOrderHash(uint256 loanId) external view returns (bytes32) {
        return LibVaipakam.storageSlot().prepayListingOrderHash[loanId];
    }

    /// @notice T-086 Round-7 (#355) follow-up (Codex round-13 P2 #3) —
    ///         production read of the per-loan auto-list opt-out flag.
    ///         `true` means the borrower has cancelled mid-grace + has
    ///         NOT yet called `clearAutoListOptOut`; permissionless
    ///         `autoListAtFloorOnGrace` reverts `AutoListBorrowerOptedOut`
    ///         while the flag is set. Indexer + frontend read this so
    ///         the keeper UI / "auto-list enabled?" banner can render
    ///         live state without optimistic-retry guesswork against
    ///         the auto-list reverts.
    function getPrepayListingAutoListOptedOut(uint256 loanId) external view returns (bool) {
        return LibVaipakam.storageSlot().prepayListingAutoListOptedOut[loanId];
    }

    /// @notice Current configured prepay-listing buffer in BPS.
    ///         Frontend reads this to compute "minimum ask" in the
    ///         post-listing UI without an extra cross-facet call.
    function getPrepayListingBufferBps() external view returns (uint256) {
        return LibVaipakam.storageSlot().cfgPrepayListingBufferBps;
    }

    /// @notice Master kill-switch state for the prepay-listing feature.
    ///         Mirrors `cfgPrepayListingEnabled` (set via
    ///         {ConfigFacet.setPrepayListingEnabled}). Both
    ///         `postPrepayListing` and `updatePrepayListing` revert
    ///         {PrepayListingDisabled} while this is false; cancel
    ///         paths (borrower + permissionless-expired) intentionally
    ///         stay open even with the switch off so an in-flight
    ///         listing can always be unwound. Frontend reads this to
    ///         render an "unavailable on this chain" notice instead of
    ///         a form that's guaranteed to revert at submit.
    function getPrepayListingEnabled() external view returns (bool) {
        return LibVaipakam.storageSlot().cfgPrepayListingEnabled;
    }

    // ─── Internal helpers ───────────────────────────────────────────────

    /// @dev Computes `startTime + durationDays + grace(durationDays)`.
    ///      Same shape the step-5 `PrepayListingFacet.getPrepayContext`
    ///      uses — kept inlined here (not factored into a library)
    ///      so step 6 has no extra library coupling beyond the
    ///      step-3 settlement math. If a future step factors this
    ///      into a `LibLoanTime.gracePeriodEnd(loan)` helper,
    ///      every facet should switch in lockstep.
    function _gracePeriodEnd(LibVaipakam.Loan storage loan) private view returns (uint256) {
        uint256 endTime = uint256(loan.startTime) + (uint256(loan.durationDays) * 1 days);
        return endTime + LibVaipakam.gracePeriod(loan.durationDays);
    }

    /// @dev Loads the executor address, reverting {ExecutorNotSet}
    ///      if zero. Returns the typed interface handle so the
    ///      caller can immediately use `recordOrder` / `clearOrder`
    ///      / `approvedConduits` without re-casting.
    function _requireExecutor(LibVaipakam.Storage storage s)
        private
        view
        returns (IListingExecutorRecorder)
    {
        address executor = s.collateralListingExecutor;
        if (executor == address(0)) revert ExecutorNotSet();
        return IListingExecutorRecorder(executor);
    }

    /// @dev Validates `askPrice ≥ liveFloor × (10000 + bufferBps) / 10000`.
    ///      `liveFloor` is the step-3 closed-form pre-default floor
    ///      consumed by every prepay-listing path. The buffer is
    ///      the fillability headroom — without it the listing
    ///      becomes unfillable seconds after sign as interest
    ///      accrues.
    function _requireAskCoversFloor(
        uint256 loanId,
        uint256 askPrice,
        uint256 bufferBps
    ) private view {
        // Buffer must be configured; storage default 0 is the
        // intentional pre-config block (see ConfigFacet natspec).
        if (bufferBps == 0) revert PrepayListingBufferNotConfigured();

        uint256 floor = LibCollateralSettlement.liveFloor(loanId, block.timestamp);
        // `(10000 + bufferBps)` capped at 11000 by ConfigFacet
        // bounds; `floor × 11000` for any realistic loan is
        // well below 2^256, so no overflow guard needed.
        uint256 minAsk = (floor * (10_000 + bufferBps)) / 10_000;
        if (askPrice < minAsk) revert AskBelowFloor(loanId, askPrice, minAsk);
    }

    /// @dev Round-5 Block A (#313) — fee-leg shape validation for
    ///      fixed-price posts. Per §14.5 of the design + the
    ///      Round-5.1 errata, the fixed-price path REQUIRES
    ///      `startAmount == endAmount` on every leg (the `≥` form
    ///      is reserved for Dutch entry points). The other
    ///      invariants — cap, non-zero recipient, non-zero amounts
    ///      — are also enforced again at the executor's
    ///      `recordOrder` boundary, but fail-fast at the facet
    ///      gives the borrower the most specific error.
    function _validateFeeLegsFixedPrice(FeeLeg[] calldata feeLegs) private pure {
        if (feeLegs.length > MAX_FEE_LEGS) {
            revert FeeLegsExceedCap(feeLegs.length, MAX_FEE_LEGS);
        }
        for (uint256 i = 0; i < feeLegs.length; ) {
            if (feeLegs[i].recipient == address(0)) {
                revert FeeLegInvalidRecipient(i);
            }
            if (feeLegs[i].startAmount == 0 || feeLegs[i].endAmount == 0) {
                revert FeeLegInvalidAmount(i);
            }
            if (feeLegs[i].startAmount != feeLegs[i].endAmount) {
                revert FeeLegDecayNotAllowedOnFixedPrice(i);
            }
            unchecked { ++i; }
        }
    }

    /// @dev Round-5 Block A (#313) + Round-5.1 errata — replacement
    ///      for the Round-4 `_requireAskCoversFloor` that also folds
    ///      fee legs into the coverage check.
    ///
    ///      Per the merged Round-5 design §14.5 + errata Codex P2
    ///      line 740: the borrower-leg derivation is
    ///        `borrowerLeg = askPrice − lenderLeg − treasuryLeg − sum(feeLegs.amount)`
    ///      and the borrower must still earn ≥ 0 after the protocol-
    ///      legs buffer is applied. The buffer applies ONLY to the
    ///      protocol legs (lender + treasury); fee legs are fixed-
    ///      amount obligations not subject to drift.
    ///
    ///      Concretely, the invariant we enforce is:
    ///        `askPrice ≥ (lender + treasury) × (1 + bufferBps/10000)
    ///                    + sum(feeLegs.amount)`
    ///      For fixed-price `feeLegs[i].startAmount == endAmount`
    ///      (validated separately) so the sum is unambiguous.
    function _requireAskCoversFloorWithFees(
        uint256 loanId,
        uint256 askPrice,
        uint256 bufferBps,
        FeeLeg[] calldata feeLegs
    ) private view {
        if (bufferBps == 0) revert PrepayListingBufferNotConfigured();

        uint256 floor = LibCollateralSettlement.liveFloor(loanId, block.timestamp);
        uint256 feeSum = 0;
        for (uint256 i = 0; i < feeLegs.length; ) {
            // Fixed-price invariant ensures `start == end`; either
            // value works for the sum. We read `startAmount` so the
            // helper is forward-compatible with a future caller
            // that has validated monotonicity differently.
            feeSum += uint256(feeLegs[i].startAmount);
            unchecked { ++i; }
        }

        // Buffered floor on protocol legs + raw fee total. The
        // protocol-leg buffer is the fillability headroom against
        // mid-listing interest accrual; fee legs are sign-time
        // obligations the borrower signed for and not subject to
        // drift, so they get added at face value.
        uint256 minAsk = (floor * (10_000 + bufferBps)) / 10_000 + feeSum;
        if (askPrice < minAsk) {
            revert AskBelowFloorPlusFees(loanId, askPrice, minAsk);
        }
    }

    /// @dev Shared finalization for {cancelPrepayListing} +
    ///      {cancelExpiredPrepayListing}. Sequence:
    ///        1. unlock borrower-position NFT
    ///        2. clear diamond's per-loan orderHash slot
    ///        3. tell the executor to clear its `orderContext`
    ///           binding (idempotent on the executor side)
    ///        4. emit the standard event with the right reason.
    function _cancel(
        LibVaipakam.Storage storage s,
        LibVaipakam.Loan storage loan,
        uint256 loanId,
        bytes32 orderHash,
        CancelReason reason
    ) private {
        // Resolve the executor to clear on: the address pinned at
        // post/update time (Codex P2 round-2 fix). Survives a
        // governance rotation while the listing was live — the
        // current `s.collateralListingExecutor` might already
        // point at a successor.
        address pinnedExecutor = s.prepayListingExecutor[loanId];
        // The post/update paths always set both `orderHash` AND
        // `executor` atomically, so a non-zero orderHash invariably
        // pairs with a non-zero executor address. We still guard
        // defensively here in case a future migration introduces
        // an unset-executor state mid-rollout.
        if (pinnedExecutor == address(0)) revert ExecutorNotSet();

        LibERC721._unlock(loan.borrowerTokenId);
        delete s.prepayListingOrderHash[loanId];
        delete s.prepayListingExecutor[loanId];
        IListingExecutorRecorder(pinnedExecutor).clearOrder(orderHash);

        // T-086 step 7 — vault-side cleanup. ERC721 explicitly
        // revokes the per-token approval; ERC1155 leaves the
        // operator approval in place — `revokeListingOrderHash`
        // is the authoritative safety primitive (orderHash
        // binding invalidated → vault.isValidSignature returns
        // INVALID → no fill regardless of operator approval
        // state). Matches the standard Seaport ERC1155 conduit
        // pattern.
        //
        // T-086 Round-6 / Block D (#345) — body extracted into
        // `LibPrepayListingWiring.unwire` so the new sibling facet
        // `NFTPrepayListingAtomicFacet`'s mandatory auto-clear
        // step (§17.11 step 0(f) of the Round-6 design doc) can
        // call the SAME cleanup. v1 behavior preserved byte-for-
        // byte: silently no-ops for the unset-vault case; ERC721-
        // only operator-approval revoke; both asset types get the
        // orderHash binding revoke.
        LibPrepayListingWiring.unwire(s, loan, orderHash);

        emit PrepayListingCanceled(loanId, msg.sender, orderHash, reason);
    }

    /// @dev Shared helper for `postPrepayListing`'s vault wiring.
    ///      Looks up the borrower's vault, grants the conduit
    ///      approval (per-token for ERC721, operator-wide for
    ///      ERC1155), and pins the orderHash → executor binding
    ///      on the vault's ERC-1271 mapping.
    function _wireVaultForListing(
        LibVaipakam.Storage storage s,
        LibVaipakam.Loan storage loan,
        bytes32 orderHash,
        address conduit,
        address executor
    ) private {
        // T-086 Round-6 / Block D (#345) — body extracted into the
        // shared `LibPrepayListingWiring` library so the new sibling
        // facet `NFTPrepayListingAtomicFacet` can call the SAME
        // wiring without duplicating the asset-type-aware approval
        // grant + ERC-1271 binding logic. v1 behavior preserved
        // byte-for-byte — the library's `wire` does exactly what the
        // private body did before the refactor.
        LibPrepayListingWiring.wire(s, loan, orderHash, conduit, executor);
    }

    /// @dev Read-only borrower-vault lookup. Reverts via
    ///      {LibPrepayListingWiring.VaultNotDeployed} for the
    ///      unset case. T-086 Block D #346 round-8 standardised
    ///      the vault-missing symbol across all prepay-listing
    ///      facets; the legitimate "executor address unset"
    ///      precondition still reverts {ExecutorNotSet} from its
    ///      own check site in `_requireExecutor`.
    function _userVault(
        LibVaipakam.Storage storage s,
        address user
    ) private view returns (VaipakamVaultImplementation) {
        address vaultAddr = s.userVaipakamVaults[user];
        if (vaultAddr == address(0)) revert LibPrepayListingWiring.VaultNotDeployed(user);
        return VaipakamVaultImplementation(vaultAddr);
    }

}
