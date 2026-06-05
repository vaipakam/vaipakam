// src/facets/PrepayListingFacet.sol
// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {LibVaipakam} from "../libraries/LibVaipakam.sol";
import {LibMetricsHooks} from "../libraries/LibMetricsHooks.sol";
import {LibCollateralSettlement} from "../libraries/LibCollateralSettlement.sol";
import {LibLifecycle} from "../libraries/LibLifecycle.sol";
import {LibERC721} from "../libraries/LibERC721.sol";
import {LibVPFIDiscount} from "../libraries/LibVPFIDiscount.sol";
import {LibAccessControl, DiamondAccessControl} from "../libraries/LibAccessControl.sol";
import {DiamondPausable} from "../libraries/LibPausable.sol";
import {IVaipakamErrors} from "../interfaces/IVaipakamErrors.sol";
import {IVaipakamPrepayContext} from "../seaport/IVaipakamPrepayContext.sol";
import {IVaipakamPrepayCallbacks} from "../seaport/IVaipakamPrepayCallbacks.sol";
import {VaipakamNFTFacet} from "./VaipakamNFTFacet.sol";
import {VaipakamVaultImplementation} from "../VaipakamVaultImplementation.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

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
 *              the live-floor + grace + recipient + treasury resolution
 *              inside the diamond's storage context (where the
 *              libraries it consults — `LibCollateralSettlement`,
 *              `LibVaipakam.gracePeriod` — actually have the storage
 *              they expect). Codex P0 on PR #288 Round 1 caught that
 *              the executor was calling those libraries directly, in
 *              its own (empty) storage context. The view here is the
 *              fix: the executor goes through this facet for every
 *              storage read.
 *
 *           2. **`executorFinalizePrepaySale(loanId)`** — the
 *              privileged finalization callback. Called by the
 *              executor's `validateOrder` post-transfer hook. Gated
 *              by `msg.sender == storedExecutor`; the executor
 *              singleton is the ONLY caller authorized to flip a loan
 *              from Active → Settled via this path. Performs three
 *              atomic mutations:
 *                a. `loan.status = Settled` via `LibLifecycle.transition`.
 *                b. `LibERC721._unlock(loan.borrowerTokenId)` — releases
 *                   the listing lock (LockReason.PrepayCollateralListing
 *                   from #285).
 *                c. `LibVPFIDiscount.settleBorrowerLifProper(loan)` —
 *                   load-bearing per CLAUDE.md; ensures the borrower's
 *                   Phase-5 VPFI rebate accrues correctly on this
 *                   proper-close path.
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

        // Floor legs — these route through `LibCollateralSettlement`
        // which reads `LibVaipakam.storageSlot()` internally. Because
        // THIS call runs inside the diamond proxy via delegatecall,
        // the storage slot resolves against the DIAMOND's storage —
        // the loan record + cfgTreasuryFeeBps + (eventually)
        // cfgPrecloseFeeBps all read live values.
        ctx.lenderLeg = LibCollateralSettlement.principalPlusAccruedInterest(
            loanId, asOfTimestamp
        );
        ctx.treasuryLeg = LibCollateralSettlement.treasuryAndPrecloseFee(
            loanId, asOfTimestamp
        );

        // Grace boundary = startTime + durationDays + gracePeriod(durationDays).
        // The duration-tiered grace bucket is governance-tunable via
        // `ConfigFacet.setGraceBuckets`; we honor the live config.
        uint256 endTime = uint256(loan.startTime) + (loan.durationDays * 1 days);
        ctx.graceEnd = endTime + LibVaipakam.gracePeriod(loan.durationDays);

        // Current position-NFT holders. Reads the diamond's own NFT
        // surface via the same `VaipakamNFTFacet.ownerOf` selector
        // any other facet would.
        ctx.lenderNftOwner = VaipakamNFTFacet(address(this)).ownerOf(loan.lenderTokenId);
        ctx.borrowerNftOwner = VaipakamNFTFacet(address(this)).ownerOf(loan.borrowerTokenId);

        // Current treasury address (re-derived; an order's signed
        // treasury recipient is checked against THIS value at fill
        // time, so a governance rotation between sign + fill is
        // reflected immediately).
        ctx.treasury = s.treasury;

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
    function executorFinalizePrepaySale(uint256 loanId) external override whenNotPaused {
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

        // ── Atomic finalization ─────────────────────────────────────────
        // 1. Lifecycle transition Active → Settled (also fires metrics
        //    hook via LibLifecycle).
        // 2. Release the borrower-NFT lock so the borrower can transfer
        //    / re-list / etc. after the sale.
        // 3. Settle the borrower's Phase-5 VPFI LIF rebate — every
        //    proper-close path in this codebase calls this (per
        //    CLAUDE.md "VPFI Fee Discounts — Phase 5 flow" §5).
        LibLifecycle.transition(loan, LibVaipakam.LoanStatus.Active, LibVaipakam.LoanStatus.Settled);
        LibERC721._unlock(loan.borrowerTokenId);
        LibVPFIDiscount.settleBorrowerLifProper(loan);

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
    function markOfferConsumedBySale(uint96 offerId) external override whenNotPaused {
        _assertOfferExecutor(offerId);
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        s.offerConsumedBySale[uint256(offerId)] = true;
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
        emit OfferConsumedBySale(offerId, msg.sender);
    }

    /// @inheritdoc IVaipakamPrepayCallbacks
    function recordOfferSaleProceeds(
        uint96 offerId,
        address principalAsset,
        uint256 amount
    ) external override whenNotPaused {
        _assertOfferExecutor(offerId);
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        // Resolve the borrower from the offer row so the credit lands
        // against the right user. The offer creator is the borrower in
        // the parallel-sale flow (offer.offerType is borrower).
        address borrower = s.offers[uint256(offerId)].creator;
        if (borrower == address(0)) revert NotOfferExecutor(offerId, msg.sender);

        // Diamond received `consideration[0]` from Seaport at fill
        // time (round-3.1 against Codex round-3 P1 #1 line 4390 —
        // recipient is the diamond, NOT the vault directly, so this
        // callback can run the credit through the standard
        // protocol-tracked-balance accountant).
        //
        // Transfer the ERC20 from the diamond's balance to the
        // borrower's vault contract address; THEN stamp the
        // protocol-tracked balance counter so the borrower can
        // withdraw via `vaultWithdrawERC20`.
        address vaultAddr = s.userVaipakamVaults[borrower];
        if (vaultAddr == address(0)) revert NotOfferExecutor(offerId, msg.sender);
        SafeERC20.safeTransfer(IERC20(principalAsset), vaultAddr, amount);
        LibVaipakam.recordVaultDeposit(borrower, principalAsset, amount);

        emit OfferSaleProceedsCredited(offerId, borrower, principalAsset, amount);
    }

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
        LibVaipakam._assertNotSanctioned(borrowerWallet);
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
