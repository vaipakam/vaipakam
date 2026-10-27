// src/facets/PrepayListingFacet.sol
// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {LibVaipakam} from "../libraries/LibVaipakam.sol";
import {LibLoanClock} from "../libraries/LibLoanClock.sol";
import {LibFacet} from "../libraries/LibFacet.sol";
import {LibDelivery} from "../libraries/LibDelivery.sol";
import {LibMetricsHooks} from "../libraries/LibMetricsHooks.sol";
import {LibPrepayCleanup} from "../libraries/LibPrepayCleanup.sol";
import {LibReentrancyGuard, DiamondReentrancyGuard} from "../libraries/LibReentrancyGuard.sol";
import {LibCollateralSettlement} from "../libraries/LibCollateralSettlement.sol";
import {LibERC721} from "../libraries/LibERC721.sol";
import {LibVPFIDiscount} from "../libraries/LibVPFIDiscount.sol";
import {LibLenderYieldFeeHost} from "../libraries/LibLenderYieldFeeHost.sol";
import {LibCloseoutFreeze} from "../libraries/LibCloseoutFreeze.sol";
import {LibSettlement} from "../libraries/LibSettlement.sol";
import {LibAccessControl, DiamondAccessControl} from "../libraries/LibAccessControl.sol";
import {DiamondPausable} from "../libraries/LibPausable.sol";
import {IVaipakamErrors} from "../interfaces/IVaipakamErrors.sol";
import {IVaipakamPrepayContext} from "../seaport/IVaipakamPrepayContext.sol";
import {IVaipakamPrepayCallbacks} from "../seaport/IVaipakamPrepayCallbacks.sol";
import {IListingExecutorRecorder} from "../seaport/IListingExecutorRecorder.sol";
import {VaipakamNFTFacet} from "./VaipakamNFTFacet.sol";
import {InteractionRewardsFacet} from "./InteractionRewardsFacet.sol";
import {EncumbranceMutateFacet} from "./EncumbranceMutateFacet.sol";
import {VaipakamVaultImplementation} from "../VaipakamVaultImplementation.sol";

/**
 * @title PrepayListingFacet
 * @author Vaipakam Developer Team
 * @notice T-086 step 5 (commit 2): the diamond's surface for the
 *         `CollateralListingExecutor` singleton to talk to.
 *
 *         This facet hosts three responsibilities:
 *
 *           1. **`getPrepayContext(loanId, asOfTimestamp)`** — a single
 *              bundled view the executor reads for every fill. Runs
 *              the live-floor + grace + recipient resolution
 *              inside the diamond's storage context (where the
 *              libraries it consults — `LibCollateralSettlement`,
 *              `LibVaipakam.gracePeriod` — actually have the storage
 *              they expect). Codex P0 on PR #288 Round 1 caught that
 *              the executor was calling those libraries directly, in
 *              its own (empty) storage context. The view here is the
 *              fix: the executor goes through this facet for every
 *              storage read.
 *
 *           2. **`executorFinalizePrepaySale(loanId, proceeds)`** — the
 *              privileged finalization callback. Called by the
 *              executor's `validateOrder` post-transfer hook. Gated
 *              by `msg.sender == storedExecutor`; the executor
 *              singleton is the ONLY caller authorized to close a
 *              loan through a collateral sale. The sale settles as a
 *              repayment funded by the proceeds the Diamond received
 *              (#2876, {_settleSale}, shared with the offer-keyed
 *              parallel sale): the loan goes Active → Repaid, the
 *              lender's leg waits in the stored lender's vault for
 *              `claimAsLender`, the treasury is paid, and the
 *              borrower's remainder is paid to the holder's wallet or
 *              held for their claim. The close also releases the
 *              listing lock (LockReason.PrepayCollateralListing from
 *              #285) and settles the borrower's Phase-5 LIF
 *              (`LibVPFIDiscount.settleBorrowerLifProper`, load-bearing
 *              per CLAUDE.md).
 *
 *           3. **`setCollateralListingExecutor(address)`** — ADMIN_ROLE-
 *              gated setter. Governance configures which executor
 *              address the diamond trusts. Rotating means a new
 *              executor singleton can take over with no diamond redeploy.
 *
 * @dev   Pausable. The borrower-facing flow (post / update / cancel /
 *         cancelExpired listings) lives in step 6's
 *         `NFTPrepayListingFacet`; this facet is just the
 *         executor↔diamond trust boundary.
 */
contract PrepayListingFacet is
    DiamondPausable,
    DiamondAccessControl,
    DiamondReentrancyGuard,
    IVaipakamErrors,
    IVaipakamPrepayContext,
    IVaipakamPrepayCallbacks
{
    // ─── Events ─────────────────────────────────────────────────────────

    /// @custom:event-category state-change/loan-mutation
    event PrepayCollateralSaleSettled(uint256 indexed loanId, address indexed executor);

    /// @custom:event-category informational/admin
    event CollateralListingExecutorUpdated(address indexed previous, address indexed next);

    // ─── Errors ─────────────────────────────────────────────────────────

    error NotExecutor(address caller, address expected);
    error ExecutorNotSet();
    error PrepayLoanNotActive(uint256 loanId, LibVaipakam.LoanStatus actual);
    /// @notice T-086 Round-8 (#358) §19.7d — the 3 new offer-keyed
    ///         callbacks revert this when called from anyone other
    ///         than the executor pinned at offer-create time
    ///         (`s.offerPrepayListingExecutor[offerId]`). The gate is
    ///         per-offer (not the global `collateralListingExecutor`
    ///         singleton) so a governance rotation between
    ///         offer-create and pre-loan fill can't authorize a
    ///         different executor to call against an already-recorded
    ///         offer.
    error NotOfferExecutor(uint96 offerId, address caller);

    // ─── View: getPrepayContext (called by the executor) ────────────────

    /// @inheritdoc IVaipakamPrepayContext
    function getPrepayContext(uint256 loanId, uint256 asOfTimestamp)
        external
        view
        override
        returns (IVaipakamPrepayContext.PrepayContext memory ctx)
    {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        LibVaipakam.Loan storage loan = s.loans[loanId];

        ctx.status = loan.status;
        ctx.assetType = loan.assetType;
        ctx.collateralAssetType = loan.collateralAssetType;
        ctx.principalAsset = loan.principalAsset;
        ctx.collateralAsset = loan.collateralAsset;
        ctx.collateralTokenId = loan.collateralTokenId;
        ctx.collateralQuantity = loan.collateralQuantity;

        // Floor legs — the repayment split at `asOfTimestamp`, through
        // `LibCollateralSettlement` (#2740). This call runs inside the
        // diamond, so the library reads the DIAMOND's loan record.
        (ctx.lenderLeg, ctx.treasuryLeg) =
            LibCollateralSettlement.saleLegs(loanId, asOfTimestamp);

        // Grace boundary = startTime + durationDays + gracePeriod(durationDays).
        // The duration-tiered grace bucket is governance-tunable via
        // `ConfigFacet.setGraceBuckets`; we honor the live config.
        uint256 endTime = LibLoanClock.maturity(loan);
        ctx.graceEnd = endTime + LibVaipakam.gracePeriod(loan.durationDays);

        // Current position-NFT holders. Reads the diamond's own NFT
        // surface via the same `VaipakamNFTFacet.ownerOf` selector
        // any other facet would.
        ctx.lenderNftOwner = VaipakamNFTFacet(address(this)).ownerOf(loan.lenderTokenId);
        ctx.borrowerNftOwner = VaipakamNFTFacet(address(this)).ownerOf(loan.borrowerTokenId);

        // #306 architectural fix — borrower's per-user vault.
        // The diamond's `NFTPrepayListingFacet.postPrepayListing`
        // consumes this when constructing the canonical Seaport
        // order shape (offerer = vault); the executor's zone
        // callback re-verifies `params.offerer == borrowerVault`
        // at fill time as defense-in-depth.
        ctx.borrowerVault = s.userVaipakamVaults[loan.borrower];
    }

    // ─── Callback: executorFinalizePrepaySale ───────────────────────────

    /// @inheritdoc IVaipakamPrepayCallbacks
    function executorFinalizePrepaySale(uint256 loanId, uint256 proceeds)
        external
        override
        whenNotPaused
    {
        // ── Privileged-caller gate ─────────────────────────────────────
        // The diamond accepts finalization callbacks ONLY from the
        // configured collateralListingExecutor address. Setting the
        // executor is ADMIN_ROLE-gated (see
        // {setCollateralListingExecutor} below), so an unauthorized
        // contract can't impersonate the executor to force-close loans.
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        address expected = s.collateralListingExecutor;
        if (expected == address(0)) revert ExecutorNotSet();
        if (msg.sender != expected) revert NotExecutor(msg.sender, expected);

        // ── Loan-state precondition (defense-in-depth) ─────────────────
        // The executor itself already asserts the loan is Active in its
        // precondition stack, but we re-check here so this method is
        // safe to invoke independently (or against a future executor
        // implementation that misses the check).
        LibVaipakam.Loan storage loan = s.loans[loanId];
        if (loan.status != LibVaipakam.LoanStatus.Active) {
            revert PrepayLoanNotActive(loanId, loan.status);
        }

        // ── Split + proper close (#2876) ───────────────────────────────
        // The order paid its whole proceeds to the Diamond; the executor
        // measured them arriving in full. The split and the close are the
        // ones the offer-keyed parallel sale runs, so the two listing
        // types cannot pay different parties different amounts for the
        // same sale.
        // The Diamond's own atomic match (`NFTPrepayListingAtomicFacet.
        // matchOpenSeaOffer`) reaches this callback under the Diamond guard
        // it already holds; a fill a buyer sends to Seaport directly does
        // not. In that case the guard is taken here, for the settlement's
        // payouts, so no hook they reach can enter a guarded Diamond entry
        // point mid-settlement, and the tier pushes the vault credits queue
        // are flushed on release (#1820).
        bool guardTaken = !LibReentrancyGuard.entered();
        if (guardTaken) LibReentrancyGuard._enter();
        _settleSale(loan, 0, proceeds);

        // T-086 step 6 — clear the diamond's per-loan listing
        // bookkeeping (`s.prepayListingOrderHash[loanId]` +
        // `s.prepayListingExecutor[loanId]`) populated by
        // `NFTPrepayListingFacet.postPrepayListing` /
        // `updatePrepayListing`. Without these deletes, the slots
        // would stay populated forever after a successful fill:
        // `getPrepayListingOrderHash` would keep returning a
        // "live-looking" hash, and the cancel paths would find a
        // hash but couldn't run (status != Active). The executor
        // clears its own `orderContext` from `validateOrder`; these
        // lines are the diamond-side companion clears.
        bytes32 orderHash = s.prepayListingOrderHash[loanId];
        delete s.prepayListingOrderHash[loanId];
        delete s.prepayListingExecutor[loanId];

        // T-086 Round-7 (Issue #355) — sale-settlement is a terminal
        // loan path the same as repay / default / refinance / preclose;
        // the per-loan auto-list state (opt-out flag + nonce) MUST be
        // reset here too. `LibPrepayCleanup.clearActiveListing`
        // (called by the other terminal facets) already performs this
        // reset; this path doesn't route through it (it deletes the
        // listing slots inline above), so we mirror the reset
        // explicitly here. Without it, a future re-use of the loanId
        // slot would inherit stale auto-list state.
        delete s.prepayListingAutoListOptedOut[loanId];
        delete s.prepayListingAutoListNonce[loanId];

        // T-086 step 7 — vault-side cleanup. Seaport's transferFrom
        // at fill time auto-clears the per-token approval (ERC-721
        // standard), so we only need to revoke the orderHash →
        // executor binding here — leaving it populated would let
        // a subsequent ERC-1271 query (e.g. via Seaport.validate
        // pre-registration on a NEW signing of the same content)
        // return the magic value. Guard for the vault-missing
        // edge case to match the cancel-path defensiveness.
        if (orderHash != bytes32(0)) {
            address vaultAddr = s.userVaipakamVaults[loan.borrower];
            if (vaultAddr != address(0)) {
                VaipakamVaultImplementation(vaultAddr).revokeListingOrderHash(orderHash);
            }
        }

        emit PrepayCollateralSaleSettled(loanId, msg.sender);
        if (guardTaken) LibReentrancyGuard._exit();
    }

    // ─── T-086 Round-8 (#358) — Offer-keyed callbacks ──────────────────

    /// @dev Internal gate: revert unless caller is the offer's pinned
    ///      executor. Round-3.2 against Codex round-3.2 P1 #4 line 4803
    ///      — per-offer pin (not the global singleton) so a governance
    ///      rotation between offer-create and pre-loan fill can't
    ///      authorize a different executor to call against an
    ///      already-recorded offer.
    function _assertOfferExecutor(uint96 offerId) private view {
        address pinned = LibVaipakam.storageSlot().offerPrepayListingExecutor[offerId];
        if (pinned == address(0) || msg.sender != pinned) {
            revert NotOfferExecutor(offerId, msg.sender);
        }
    }

    /// @inheritdoc IVaipakamPrepayCallbacks
    function markOfferConsumedBySale(uint96 offerId) external override whenNotPaused nonReentrant {
        _assertOfferExecutor(offerId);
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        // Codex round-6 P2 #4 — only stamp `offerConsumedBySale` for
        // TRUE Scenario A (no loan ever existed). For the keep-listing-
        // live Scenario B (loan was accepted, sale-fill settled the
        // loan), `_settleLoanFromParallelSale` has already transitioned
        // the loan Active → Repaid and emitted
        // `PrepayCollateralSaleSettled`; the offer terminal stays as
        // `Accepted` (which the round-3 user-directed redesign codified
        // in `MetricsFacet.getOfferState`'s precedence order:
        // accepted-first, then consumed-by-sale).
        //
        // Indexer + frontend cascades treat `ConsumedBySale` as
        // Scenario A only — stamping it on an accepted offer would
        // flip the indexer's offer row from `accepted` to
        // `consumed_by_sale` and lose the loan-acceptance history.
        LibVaipakam.Offer storage offerRow = s.offers[uint256(offerId)];
        bool isScenarioA = !offerRow.accepted;
        if (isScenarioA) {
            // Codex round-7 P3 — burn the offer's position NFT on
            // Scenario A terminal, mirroring `OfferCancelFacet.cancelOffer`'s
            // posture. Without this, the position NFT keeps reporting
            // `OfferCreated` status + `offerIds[tokenId]` metadata for
            // a sold-through-OpenSea offer whose collateral no longer
            // exists. Scenario B doesn't burn — the loan's borrower-
            // position NFT is the active one and gets unlocked via
            // `LibERC721._unlock` in `_settleLoanFromParallelSale`.
            LibFacet.crossFacetCall(
                abi.encodeWithSelector(
                    VaipakamNFTFacet.burnNFT.selector,
                    offerRow.positionTokenId
                ),
                NFTBurnFailed.selector
            );
            // Idempotent — the `recordOfferSaleProceeds` Scenario A
            // path already pre-stamps this terminal bit to defeat
            // the P1 reentrancy. This write is the canonical place;
            // the duplicate write here is a no-op SSTORE if the
            // pre-stamp already ran (same call frame, same
            // validateOrder callback).
            s.offerConsumedBySale[uint256(offerId)] = true;
        } // /isScenarioA
        // Codex P2 round-1 — remove the sold offer from the active-
        // offer indexes (activeOfferIdsList / assetPairActiveOfferIds)
        // the same way the accept / cancel terminals do, so
        // getActiveOffersPaginated / getCompatibleOffers / asset-pair
        // views / protocol stats stop advertising an offer that direct
        // accepts now reject with `OfferConsumedBySale`. The
        // `onOfferCancelled` shape is reused here (NOT
        // `onOfferAccepted`) because Scenario A is a fill-without-loan
        // — the indexer's loan-side counter shouldn't tick.
        LibMetricsHooks.onOfferCancelled(uint256(offerId));
        // Codex round-2 P2 #3 — clear the position-NFT reverse map so
        // `MetricsFacet.getUserPositionOffers` (which the docs
        // promise only returns OPEN offers) stops surfacing the
        // consumed offer to the borrower's frontend until some later
        // unrelated cleanup fires. Mirrors
        // `OfferCancelFacet.cancelOffer:411`.
        delete s.offerIdByPositionTokenId[s.offers[uint256(offerId)].positionTokenId];
        // Codex round-3 P2 #2 + round-4 P1 #1 — clear ALL 5 parallel-
        // sale mirror slots (`offerPrepayListingOrderHash`,
        // `offerPrepayListingExecutor`, `Offer.parallelSaleOrderHash`,
        // executor's _offerFeeLegs, vault's listing-hash registration)
        // atomically with the terminal-bit flip. Without this the sold
        // offer keeps a live-looking parallel-sale order hash + vault
        // registration until the borrower manually calls
        // `releaseParallelSaleLock` (which they can't until they
        // realize they need to — the round-2 `cancelOffer` gate now
        // blocks that path too). The post-fill variant SKIPS the ERC721
        // conduit approval revoke because Seaport hasn't finished
        // transferring the NFT out of the vault yet at this point;
        // revoking would break the transfer (round-4 P1 #1). After
        // the transfer completes, the NFT is gone, so the stale
        // approval is meaningless.
        LibPrepayCleanup.clearOfferListingPostFill(offerId);
        // Codex round-7 P2 #1 — `OfferConsumedBySale` event MUST only
        // fire for Scenario A. For Scenario B the indexer treats this
        // event as unconditional terminal-flip and would override the
        // `accepted` row state, losing loan-acceptance history. Use
        // the same `isScenarioA` flag the storage write above gates
        // on.
        if (isScenarioA) {
            emit OfferConsumedBySale(offerId, msg.sender);
        }
    }

    /// @inheritdoc IVaipakamPrepayCallbacks
    function recordOfferSaleProceeds(
        uint96 offerId,
        address principalAsset,
        uint256 amount
    ) external override whenNotPaused nonReentrant {
        _assertOfferExecutor(offerId);
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        // Resolve the borrower from the offer row so the credit lands
        // against the right user. The offer creator is the borrower in
        // the parallel-sale flow (offer.offerType is borrower).
        LibVaipakam.Offer storage offer = s.offers[uint256(offerId)];
        address borrower = offer.creator;
        if (borrower == address(0)) revert NotOfferExecutor(offerId, msg.sender);
        address vaultAddr = s.userVaipakamVaults[borrower];
        if (vaultAddr == address(0)) revert NotOfferExecutor(offerId, msg.sender);

        // T-086 Round-8 (#358) Codex round-3 user-directed redesign —
        // post-acceptance branch (the borrower's offer was already
        // accepted; a loan exists). The pre-loan floor formula (now
        // including full-duration interest) guarantees the proceeds
        // cover the lender + treasury cuts, so we split them here +
        // settle the loan atomically. Listing carries through accept
        // without a teardown step in `_acceptOffer`.
        if (offer.accepted) {
            _settleLoanFromParallelSale(offerId, principalAsset, amount);
            return;
        }

        // Scenario A (no loan ever existed) — credit the borrower's
        // vault in full. Diamond received `consideration[0]` from
        // Seaport at fill time (recipient is the diamond, NOT the
        // vault directly, so this callback runs the credit through
        // the standard protocol-tracked-balance accountant).
        //
        // Codex round-7 P1 — stamp the consumed-by-sale terminal bit
        // BEFORE the ERC20 transfer to defeat a reentrancy via a
        // malicious principal asset's `transfer` hook. Without the
        // pre-stamp, a reentrant `acceptOffer` could spin up a loan
        // on this same offer (whose collateral NFT is gone in the
        // Seaport sale) — catastrophic. With the stamp, the
        // round-2 `OfferConsumedBySale` gate in `_acceptOffer`
        // rejects the reentrant accept.
        s.offerConsumedBySale[uint256(offerId)] = true;
        // #2440 — the tracked balance and the event record what the vault
        // received.
        amount = LibDelivery.pushMeasured(principalAsset, vaultAddr, amount);
        LibVaipakam.recordVaultDeposit(borrower, principalAsset, amount);
        emit OfferSaleProceedsCredited(offerId, borrower, principalAsset, amount);
    }

    /// @dev T-086 Round-8 (#358) — settle an ACCEPTED offer's loan from a
    ///      parallel-sale fill (the keep-listing-live design). The order paid
    ///      its proceeds to the Diamond; the loan is closed and they are
    ///      split by the same {_settleSale} the loan-keyed listing uses
    ///      (#2876).
    function _settleLoanFromParallelSale(
        uint96 offerId,
        address principalAsset,
        uint256 amount
    ) private {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        uint256 loanId = s.offerIdToLoanId[uint256(offerId)];
        LibVaipakam.Loan storage loan = s.loans[loanId];
        if (loan.status != LibVaipakam.LoanStatus.Active) {
            revert PrepayLoanNotActive(loanId, loan.status);
        }
        // The proceeds arrived in the asset the executor pinned from the
        // offer at sign time; the split pays in the loan's lending asset.
        // They are the same by construction (the loan was opened from this
        // offer); refuse rather than pay out a token the Diamond did not
        // receive if they ever differ.
        if (principalAsset != loan.principalAsset) {
            revert SaleProceedsAssetMismatch(loanId, principalAsset, loan.principalAsset);
        }

        // Codex round-10 P2 #2 + round-11 P1 — BLOCK fills while a
        // PrecloseFacet offset offer is live. Unlike loan-keyed prepay
        // listings, the carried offer-keyed parallel-sale listing
        // doesn't take the borrower-position NFT lock, so the borrower
        // CAN post a preclose-offset offer (which DOES lock the
        // borrower-NFT) on top of the carried parallel-sale.
        //
        // The round-10 attempt to tear down the offset inline
        // (stamping `offerCancelled` + deleting both reverse-maps) was
        // incomplete: the offer row, active-offer indexes, position
        // NFT, and vaulted principal stayed intact, and the
        // OfferAcceptFacet doesn't consult `offerCancelled` for the
        // accept path — so a "torn-down" offset offer could still be
        // filled later as an ordinary lender offer, double-spending
        // the lender's principal.
        //
        // The clean fix: require the borrower to cancel the offset
        // offer FIRST via `OfferCancelFacet.cancelOffer` (which runs
        // the full teardown — refund principal + burn position NFT +
        // active-index removal). The buyer's fill reverts; borrower
        // (or anyone on the lazy-clear path) cancels the offset; buyer
        // re-tries the fill.
        if (s.loanToOffsetOfferId[loanId] != 0) {
            revert ParallelSaleBlockedByOpenOffsetOffer(
                offerId, loanId, s.loanToOffsetOfferId[loanId]
            );
        }

        _settleSale(loan, offerId, amount);

        // Codex round-6 P2 #2 — borrower could have ALSO posted a
        // loan-keyed prepay listing on top of the carried-through
        // parallel-sale listing (NFTPrepayListingFacet.postPrepayListing
        // only gates on the borrower-position lock, which the
        // offer-keyed binding doesn't take). If the offer-keyed sale
        // wins, the loan-keyed listing's diamond + executor + vault
        // state would be left dangling. Mirror the manual cleanup
        // executorFinalizePrepaySale does (inline so we don't go
        // through LibPrepayCleanup.clearActiveListing — that revokes
        // the ERC721 conduit approval which we MUST preserve until
        // Seaport's transferFrom completes outside this validateOrder
        // callback per round-4 P1 #1).
        bytes32 loanKeyedHash = s.prepayListingOrderHash[loanId];
        // Codex round-8 P2 #1 — capture the PINNED executor BEFORE
        // we delete the storage slot. Per-loan pin (not the global
        // `s.collateralListingExecutor`) so a governance rotation
        // between post-time and now still forwards `clearOrder` to
        // the executor that actually recorded the binding.
        address loanKeyedExecutor = s.prepayListingExecutor[loanId];
        delete s.prepayListingOrderHash[loanId];
        delete s.prepayListingExecutor[loanId];
        delete s.prepayListingAutoListOptedOut[loanId];
        delete s.prepayListingAutoListNonce[loanId];
        if (loanKeyedHash != bytes32(0)) {
            address loanVault = s.userVaipakamVaults[loan.borrower];
            if (loanVault != address(0)) {
                VaipakamVaultImplementation(loanVault).revokeListingOrderHash(loanKeyedHash);
            }
            if (loanKeyedExecutor != address(0)) {
                IListingExecutorRecorder(loanKeyedExecutor).clearOrder(loanKeyedHash);
            }
        }

        // Codex round-4 P2 #3 — also emit the loan-keyed terminal event
        // the existing indexer (`chainIndexer.ts`) listens for to flip
        // the D1 loan row to `repaid` (#2876: the sale closes the loan as
        // a repayment, and the lender's claim settles it). Without this,
        // accept-then-sold loans would stay `active` in the indexer even
        // after the on-chain close. Reuses the established
        // `PrepayCollateralSaleSettled` event; the indexer's
        // existing handler runs verbatim with no schema work.
        emit PrepayCollateralSaleSettled(loanId, msg.sender);
    }

    /// @dev #2876 — the ONE settlement of a collateral sale, for both listing
    ///      types. The order paid `proceeds` to the Diamond (the executor
    ///      measured them arriving in full); this settles the loan as a
    ///      repayment funded by the sale, at what a repayment at this block
    ///      would owe (`LibCollateralSettlement.salePlan`):
    ///        1. the lender's due, plus the lender yield-fee discount the
    ///           CURRENT lender-position holder qualifies for (resolved by the
    ///           same host repayment uses, {LibLenderYieldFeeHost}), is placed
    ///           in the stored lender's vault behind the receive-side
    ///           exemption and owed to the current holder as a lender claim
    ///           ({LibCloseoutFreeze.freezeLenderProceeds}, the swap-to-repay
    ///           close's own lender leg);
    ///        2. the treasury gets its share net of that discount (accrued as
    ///           it arrived, `LibFacet.transferToTreasury`);
    ///        3. everything the sale raised above the floor goes to the
    ///           CURRENT borrower-position holder's wallet, or is held for
    ///           their claim when they are flagged or the wallet refuses it
    ///           ({LibCloseoutFreeze.payOrHoldBorrowerExtra}).
    ///      The discount moves value between legs 1 and 2 only, so the floor
    ///      (legs 1 + 2 before it) is what the sale must cover and leg 3 is
    ///      the same with or without it.
    ///
    ///      NEUTRAL BETWEEN THE SIDES (owner direction 2026-10-27). Nothing
    ///      about one side's holder can stop the other side's payout. A
    ///      lender holder who is flagged, or whose wallet would refuse the
    ///      token, never meets this transaction: the lender's leg lands in
    ///      the stored lender's vault and waits for `claimAsLender`, whose
    ///      own screen decides when it may leave, exactly as after a
    ///      repayment. A borrower wallet that refuses the remainder has it
    ///      held instead. The one refusal is the borrower's own: a sale is
    ///      the borrower's dealing in their collateral, so a borrower-position
    ///      holder flagged by the time of the fill cannot sell (screened here
    ///      fail-closed on the committed marker, #1144, since the sign-time
    ///      screen cannot see a holder that changed or was flagged after the
    ///      listing). That refusal costs the lender nothing: the loan stays
    ///      Active with every repayment and default right intact.
    ///
    ///      ORDER. Everything the settlement needs (the plan, both holders,
    ///      the discount) is resolved first; then the loan takes its proper
    ///      close ({_closeSoldLoan}, Active -> Repaid); only then does any
    ///      token move. A hook reached from a payout therefore finds the loan
    ///      already Repaid, so it can neither repay nor sell it a second
    ///      time.
    /// @param  offerId The parallel-sale offer, or 0 for a loan-keyed listing.
    function _settleSale(LibVaipakam.Loan storage loan, uint96 offerId, uint256 proceeds)
        private
    {
        uint256 loanId = loan.id;
        // After grace the only valid terminal is the default, so a stale
        // listing cannot pre-empt one that is already overdue (mirrors
        // RepayFacet's `RepaymentPastGracePeriod`; strict `>` like it).
        uint256 graceEnd = LibLoanClock.graceEnd(loan);
        if (block.timestamp > graceEnd) {
            revert SaleFillPastGrace(loanId, block.timestamp, graceEnd);
        }
        LibSettlement.ERC20Settlement memory plan =
            LibCollateralSettlement.salePlan(loanId, block.timestamp);
        uint256 floor = plan.lenderDue + plan.treasuryShare;
        if (proceeds < floor) revert SaleProceedsBelowFloor(loanId, proceeds, floor);

        address lender = LibERC721.ownerOf(loan.lenderTokenId);
        address borrower = LibERC721.ownerOf(loan.borrowerTokenId);
        LibVaipakam.assertRecipientNotBarred(borrower);

        (uint256 lenderExtra, uint256 treasuryNet) = LibLenderYieldFeeHost.resolve(
            loanId, lender, plan.interest + plan.lateFee, plan.treasuryShare
        );

        _closeSoldLoan(loan);

        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        uint256 lenderAmount = plan.lenderDue + lenderExtra;
        LibCloseoutFreeze.freezeLenderProceeds(s, loanId, loan, lenderAmount);
        uint256 treasuryAmount = LibFacet.transferToTreasury(loan.principalAsset, treasuryNet);

        // `lenderExtra + treasuryNet == plan.treasuryShare`, so this is
        // `proceeds - floor`, which the check above keeps non-negative.
        (bool borrowerHeld, uint256 borrowerAmount) = LibCloseoutFreeze.payOrHoldBorrowerExtra(
            s, loanId, loan, borrower, proceeds - lenderAmount - treasuryNet
        );

        emit CollateralSaleProceedsSplit(
            loanId, offerId, loan.principalAsset, proceeds,
            lender, lenderAmount, lenderExtra,
            treasuryAmount,
            borrower, borrowerAmount, borrowerHeld
        );
    }

    /// @dev The proper close every collateral sale takes, inside
    ///      {_settleSale} before any proceeds move. It is a repayment's close
    ///      (the swap-to-repay full close is the template): the validated
    ///      Active -> Repaid edge with both holders' fail-closed claimant
    ///      markers ({EncumbranceMutateFacet.terminalize}), both position NFTs
    ///      to `LoanRepaid`, the borrower-position lock released, the
    ///      borrower's Phase-5 LIF settled (every proper-close path calls
    ///      `settleBorrowerLifProper`, per CLAUDE.md; a rebate it writes is
    ///      paid by `claimAsBorrower`, as after a repayment), and the
    ///      terminal reward close. The lender's claim then moves the loan to
    ///      Settled once the borrower side has nothing left
    ///      ({LibCloseoutFreeze.borrowerSideOpen}). Shared by both listing
    ///      types so their closes cannot drift.
    function _closeSoldLoan(LibVaipakam.Loan storage loan) private {
        LibFacet.crossFacetCall(
            abi.encodeWithSelector(
                EncumbranceMutateFacet.terminalize.selector,
                loan.id,
                LibVaipakam.LoanStatus.Active,
                LibVaipakam.LoanStatus.Repaid
            ),
            bytes4(0)
        );
        LibERC721._unlock(loan.borrowerTokenId);
        _markPositionRepaid(loan.borrowerTokenId, loan.id);
        _markPositionRepaid(loan.lenderTokenId, loan.id);
        LibVPFIDiscount.settleBorrowerLifProper(loan);
        // #1067 — DURABLE terminal reward close: a sale is a proper close,
        // so shrink both reward entries' active windows to today and
        // re-anchor each open side to the live NFT holder.
        // `borrowerClean = true`. Bubbling (#2739): a terminal transition
        // closes its reward entry in the same transaction or reverts.
        LibFacet.crossFacetCall(
            abi.encodeWithSelector(
                InteractionRewardsFacet.terminalRewardClose.selector,
                loan.id,
                true
            ),
            RewardHookCallFailed.selector
        );
    }

    /// @dev A position NFT's status after a sale closed its loan: the loan is
    ///      repaid and the position waits for its claim, as after a repayment.
    function _markPositionRepaid(uint256 tokenId, uint256 loanId) private {
        LibFacet.crossFacetCall(
            abi.encodeWithSelector(
                VaipakamNFTFacet.updateNFTStatus.selector,
                tokenId,
                loanId,
                LibVaipakam.LoanPositionStatus.LoanRepaid
            ),
            NFTStatusUpdateFailed.selector
        );
    }

    /// @notice #2876 — how a collateral sale's proceeds were split, from
    ///         either listing type. Every figure is what its recipient
    ///         received.
    /// @param  loanId          Loan the sale closed.
    /// @param  offerId         The parallel-sale offer, or 0 for a
    ///                         loan-keyed listing.
    /// @param  asset           The lending asset the proceeds were paid in.
    /// @param  proceeds        What the buyer's proceeds leg paid the Diamond.
    /// @param  lender          The lender-position holder the lender's leg
    ///                         is owed to, through `claimAsLender`.
    /// @param  lenderAmount    The lender's due plus `lenderDiscount`, as the
    ///                         stored lender's vault received it for that
    ///                         claim.
    /// @param  lenderDiscount  The part of the treasury's share the holder's
    ///                         yield-fee discount moved to them (0 if none,
    ///                         or if the discount was paid in VPFI instead).
    /// @param  treasuryAmount  What the treasury received.
    /// @param  borrower        The borrower-position holder the remainder
    ///                         is owed to.
    /// @param  borrowerAmount  The remainder above the floor: what the
    ///                         holder's wallet was sent, or what the stored
    ///                         borrower's vault received when it was held.
    /// @param  borrowerHeld    True when the remainder was held for the
    ///                         holder's `claimAsBorrower` (the holder is
    ///                         flagged, or their wallet refused it); false
    ///                         when it was paid to the wallet or there was
    ///                         none.
    /// @custom:event-category state-change/loan-mutation
    event CollateralSaleProceedsSplit(
        uint256 indexed loanId,
        uint96 indexed offerId,
        address asset,
        uint256 proceeds,
        address lender,
        uint256 lenderAmount,
        uint256 lenderDiscount,
        uint256 treasuryAmount,
        address borrower,
        uint256 borrowerAmount,
        bool borrowerHeld
    );

    /// @notice #2876 — a collateral sale's proceeds do not cover what a
    ///         repayment at the fill would owe the lender and the treasury.
    ///         The executor refuses such a fill first; this is the Diamond's
    ///         own check on the figure it splits.
    error SaleProceedsBelowFloor(uint256 loanId, uint256 proceeds, uint256 floor);
    /// @notice #2876 — a collateral sale was filled past the loan's grace
    ///         end, where the only valid terminal is the default. Mirrors
    ///         RepayFacet's `RepaymentPastGracePeriod`.
    error SaleFillPastGrace(uint256 loanId, uint256 nowTimestamp, uint256 graceEnd);
    /// @notice #2876 — a parallel-sale fill paid its proceeds in an asset
    ///         other than the loan's lending asset.
    error SaleProceedsAssetMismatch(uint256 loanId, address paid, address lendingAsset);
    /// @notice T-086 Round-8 (#358) Codex round-11 P1 — raised when a
    ///         carried parallel-sale fill is attempted while the
    ///         borrower has an active PrecloseFacet offset offer linked
    ///         to the loan. Borrower must cancel the offset offer
    ///         first (via `OfferCancelFacet.cancelOffer`, which runs
    ///         the full teardown) before the buyer can fill.
    error ParallelSaleBlockedByOpenOffsetOffer(
        uint96 offerId, uint256 loanId, uint256 offsetOfferId
    );

    /// @inheritdoc IVaipakamPrepayCallbacks
    function assertOfferFillNotSanctioned(uint96 offerId, address borrowerWallet)
        external
        view
        override
    {
        _assertOfferExecutor(offerId);
        // Routes through the diamond's storage slot (this is the
        // load-bearing reason the executor can't call
        // `LibVaipakam._assertNotSanctioned` directly — that helper
        // keys by `address(this)`, so an executor-context call would
        // miss the diamond's sanctions oracle config).
        //
        // #1144 (S10 Invariant B) — SCENARIO-DEPENDENT (Codex #1146-r2 P2):
        //  - Scenario A (pre-loan, `offerIdToLoanId == 0`): `borrowerWallet` (the
        //    offer creator/seller) is the live proceeds recipient and this is its
        //    ONLY screen. A fail-OPEN `_assertNotSanctioned` would let a seller
        //    flagged after listing fill during an outage, so use the registry-aware
        //    fail-closed bar — paired with `syncPrepaySaleOffer` registering the
        //    Scenario-A creator (r1 P1).
        //  - Scenario B (accepted): the sale proceeds are split to the CURRENT
        //    position holders (screened live by `_settleLoanFromParallelSale`'s
        //    `assertRecipientNotBarred`), and `borrowerWallet` here is the STORED
        //    original seller — NOT a live recipient. Applying the registry bar would
        //    let a stale/original-seller marker revert a clean current holder's fill,
        //    so keep the fail-open screen on that vestigial party.
        if (LibVaipakam.storageSlot().offerIdToLoanId[uint256(offerId)] == 0) {
            LibVaipakam.assertRecipientNotBarred(borrowerWallet);
        } else {
            LibVaipakam._assertNotSanctioned(borrowerWallet);
        }
    }

    /// @notice T-086 Round-8 (#358) — emitted on every
    ///         `markOfferConsumedBySale` call. Indexer breadcrumb so
    ///         the offer-pending → ConsumedBySale terminal can be
    ///         caught in the same ingest pass as `OfferCanceled` /
    ///         `OfferAccepted`.
    /// @custom:event-category state-change/offer-mutation
    event OfferConsumedBySale(uint96 indexed offerId, address indexed executor);

    /// @notice T-086 Round-8 (#358) — emitted on every successful
    ///         `recordOfferSaleProceeds` credit. The amount is the
    ///         net stamped onto `protocolTrackedVaultBalance[borrower]
    ///         [principalAsset]`; the borrower's
    ///         `vaultWithdrawERC20(principalAsset, amount)` becomes
    ///         callable for this amount immediately.
    /// @custom:event-category state-change/offer-mutation
    event OfferSaleProceedsCredited(
        uint96 indexed offerId,
        address indexed borrower,
        address indexed principalAsset,
        uint256 amount
    );

    // ─── Admin: setCollateralListingExecutor ────────────────────────────

    /// @notice Set the trusted `CollateralListingExecutor` singleton
    ///         address. The previous executor immediately loses
    ///         finalization rights; rotation supports executor
    ///         upgrades / contract redeploys without diamond changes.
    /// @dev    ADMIN_ROLE-gated. On mainnet this address resolves to
    ///         the governance multisig at deploy, rotated to the
    ///         timelock post-handover (per CLAUDE.md Cross-Chain
    ///         Security Policy). Setting to `address(0)` disables the
    ///         prepay-listing path entirely (next callback reverts
    ///         `ExecutorNotSet`).
    function setCollateralListingExecutor(address executor) external {
        LibAccessControl.checkRole(LibAccessControl.ADMIN_ROLE, msg.sender);
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        address previous = s.collateralListingExecutor;
        s.collateralListingExecutor = executor;
        emit CollateralListingExecutorUpdated(previous, executor);
    }

    // ─── View: getCollateralListingExecutor (read-side for frontends) ───

    /// @notice Current trusted executor address. `address(0)` means the
    ///         prepay-listing path is disabled (no executor configured).
    function getCollateralListingExecutor() external view returns (address) {
        return LibVaipakam.storageSlot().collateralListingExecutor;
    }
}
