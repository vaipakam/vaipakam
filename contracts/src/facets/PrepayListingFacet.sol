// src/facets/PrepayListingFacet.sol
// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {LibVaipakam} from "../libraries/LibVaipakam.sol";
import {LibFacet} from "../libraries/LibFacet.sol";
import {LibMetricsHooks} from "../libraries/LibMetricsHooks.sol";
import {LibPrepayCleanup} from "../libraries/LibPrepayCleanup.sol";
import {LibUserVault} from "../libraries/LibUserVault.sol";
import {DiamondReentrancyGuard} from "../libraries/LibReentrancyGuard.sol";
import {LibCollateralSettlement} from "../libraries/LibCollateralSettlement.sol";
import {LibLifecycle} from "../libraries/LibLifecycle.sol";
import {LibERC721} from "../libraries/LibERC721.sol";
import {LibVPFIDiscount} from "../libraries/LibVPFIDiscount.sol";
import {LibAccessControl, DiamondAccessControl} from "../libraries/LibAccessControl.sol";
import {DiamondPausable} from "../libraries/LibPausable.sol";
import {IVaipakamErrors} from "../interfaces/IVaipakamErrors.sol";
import {IVaipakamPrepayContext} from "../seaport/IVaipakamPrepayContext.sol";
import {IVaipakamPrepayCallbacks} from "../seaport/IVaipakamPrepayCallbacks.sol";
import {IListingExecutorRecorder} from "../seaport/IListingExecutorRecorder.sol";
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
    function markOfferConsumedBySale(uint96 offerId) external override whenNotPaused nonReentrant {
        _assertOfferExecutor(offerId);
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        // Codex round-6 P2 #4 — only stamp `offerConsumedBySale` for
        // TRUE Scenario A (no loan ever existed). For the keep-listing-
        // live Scenario B (loan was accepted, sale-fill settled the
        // loan), `_settleLoanFromParallelSale` has already transitioned
        // the loan Active → Settled and emitted
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
            _settleLoanFromParallelSale(
                offerId, principalAsset, amount, vaultAddr, borrower
            );
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
        SafeERC20.safeTransfer(IERC20(principalAsset), vaultAddr, amount);
        LibVaipakam.recordVaultDeposit(borrower, principalAsset, amount);
        emit OfferSaleProceedsCredited(offerId, borrower, principalAsset, amount);
    }

    /// @dev T-086 Round-8 (#358) Codex round-3 user-directed redesign —
    ///      atomic split + settle for the keep-listing-live design.
    ///      Reads pctx via `LibCollateralSettlement` (identical shape to
    ///      the loan-keyed `IVaipakamPrepayContext.getPrepayContext`),
    ///      pays lender + treasury directly from the proceeds the
    ///      diamond just received, credits remainder to the borrower's
    ///      vault, then runs the standard proper-close finalization
    ///      (status → Settled, unlock borrower NFT, Phase 5 LIF settle).
    ///      Factored to keep `recordOfferSaleProceeds` under viaIR's
    ///      stack budget.
    function _settleLoanFromParallelSale(
        uint96 offerId,
        address principalAsset,
        uint256 amount,
        address borrowerVault,
        address borrower
    ) private {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        uint256 loanId = s.offerIdToLoanId[uint256(offerId)];
        LibVaipakam.Loan storage loan = s.loans[loanId];
        if (loan.status != LibVaipakam.LoanStatus.Active) {
            revert PrepayLoanNotActive(loanId, loan.status);
        }
        // Codex round-5 P1 #2 — block fills past graceEnd. Loans
        // stay `Active` until someone explicitly calls
        // DefaultedFacet.markDefaulted (or RiskFacet's HF-liquidation
        // triggers), so a GTC parallel-sale order could otherwise
        // fill after maturity + grace and settle a loan that's now
        // operationally in default territory. Mirrors the loan-keyed
        // executor's `if (block.timestamp > pctx.graceEnd) revert
        // GraceExpired(loanId)` check and the RepayFacet
        // `RepaymentPastGracePeriod` revert. After grace, the only
        // valid terminal is default → NFT to lender; routing through
        // the split path would let a borrower's stale-priced listing
        // pre-empt a default that's already overdue.
        uint256 graceEnd = uint256(loan.startTime)
            + (uint256(loan.durationDays) * 1 days)
            + LibVaipakam.gracePeriod(loan.durationDays);
        if (block.timestamp > graceEnd) {
            revert ParallelSaleFillPastGrace(offerId, block.timestamp, graceEnd);
        }

        // Defensive — the executor-side floor invariant guarantees
        // proceeds >= lenderLeg + treasuryLeg via the pre-loan-floor's
        // full-duration interest hedge, but re-check here as defense-
        // in-depth (matches the active-loan path's lender/treasury
        // short-paid revert posture).
        uint256 lenderLeg =
            LibCollateralSettlement.principalPlusAccruedInterest(loanId, block.timestamp);
        uint256 treasuryLeg =
            LibCollateralSettlement.treasuryAndPrecloseFee(loanId, block.timestamp);
        if (amount < lenderLeg + treasuryLeg) {
            revert ProceedsBelowLenderTreasury(
                offerId, amount, lenderLeg + treasuryLeg
            );
        }

        // Distribute proceeds.
        address lenderHolder = VaipakamNFTFacet(address(this))
            .ownerOf(loan.lenderTokenId);
        // #821 (#825-r4 residual) — this Scenario-B settlement pays the LIVE
        // lender holder its leg directly from the parallel-sale proceeds. The
        // sign-time screen on the offer can't see this diamond-resolved holder,
        // so a holder flagged after the listing was recorded would be paid here.
        // Screen it at fill: the settlement runs inside the atomic Seaport fill
        // (via the executor zone callback), so a revert aborts the whole fill —
        // the buyer's funds are never committed, nothing is stranded.
        // #821 (Codex #832) — screen the LIVE lender holder (the direct recipient
        // of this leg). The borrower remainder leg below resolves the current
        // borrower-position holder through `getOrCreateUserVault`, which screens
        // that recipient too. No stale stored-party (`loan.lender`/`loan.borrower`)
        // screen is needed: #821's position-NFT transfer restriction stops a
        // flagged wallet from becoming a holder via a post-flag transfer, so a
        // flagged party can't be paid here, while a legitimate pre-flag buyer
        // (whom a stored-party screen would wrongly freeze) settles cleanly.
        //
        // #1144 (S10 Invariant B) — the sign-time screen and this fill-time screen
        // are both fail-OPEN oracle reads, so a holder flagged during an oracle
        // outage would still be paid. `assertRecipientNotBarred` adds the fail-
        // closed BACKSTOP: it ALSO reverts on a COMMITTED `sanctionsConfirmedFlagged`
        // marker, which the permissionless `syncPrepaySaleOffer(offerId)` (or
        // `refreshSanctionsFlag`) commits out-of-band. So even mid-outage a
        // registered-flagged holder can't be paid, and — because the marker was
        // committed by a SEPARATE call — the atomic fill's revert here doesn't roll
        // it back (the revert-loses-the-marker failure the sync is designed around).
        LibVaipakam.assertRecipientNotBarred(lenderHolder);
        address treasury = s.treasury;
        SafeERC20.safeTransfer(IERC20(principalAsset), lenderHolder, lenderLeg);
        SafeERC20.safeTransfer(IERC20(principalAsset), treasury, treasuryLeg);
        // Codex round-5 P2 #3 — every treasury-fee site MUST pair the
        // transfer with `LibFacet.recordTreasuryAccrual` so the
        // `treasuryBalances` invariant holds (the Diamond-as-treasury
        // deploy pattern only credits the accrual lane to the
        // accountant, not to an external recipient). Without this,
        // accept-then-sold loans's treasury cut would land at the
        // configured treasury address but NOT be reflected in
        // `treasuryBalances` for downstream analytics + payroll.
        LibFacet.recordTreasuryAccrual(principalAsset, treasuryLeg);

        // Codex round-9 P1 #2 + round-10 P1 — route the remainder to
        // the CURRENT borrower-position NFT holder (mirrors the loan-
        // keyed prepay path's `pctx.borrowerNftOwner` resolution at
        // fill time). Borrower-position NFTs are transferable on
        // secondary markets.
        //
        // Round-10 P1: if the current holder hasn't created a vault
        // yet, lazily create one via `LibUserVault.getOrCreate` rather
        // than falling back to the ORIGINAL borrower (which would
        // strand the holder's economic surplus with the seller). The
        // lazy-create path is the same one the offer-accept flow uses,
        // so the holder's vault is provisioned as the same per-user
        // proxy address Vaipakam already expects.
        address remainderRecipient = VaipakamNFTFacet(address(this))
            .ownerOf(loan.borrowerTokenId);
        // #1144 (S10 Invariant B) — same fail-closed registry backstop on the
        // borrower-remainder recipient (the `getOrCreateUserVault` screen below is
        // itself fail-OPEN, so a registered-flagged holder needs this explicit bar).
        LibVaipakam.assertRecipientNotBarred(remainderRecipient);
        address remainderVault = LibUserVault.getOrCreate(remainderRecipient);
        uint256 remainder;
        unchecked { remainder = amount - lenderLeg - treasuryLeg; }
        if (remainder > 0) {
            SafeERC20.safeTransfer(IERC20(principalAsset), remainderVault, remainder);
            LibVaipakam.recordVaultDeposit(remainderRecipient, principalAsset, remainder);
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

        // Proper-close finalization — identical to the loan-keyed
        // `executorFinalizePrepaySale` shape.
        LibLifecycle.transition(
            loan, LibVaipakam.LoanStatus.Active, LibVaipakam.LoanStatus.Settled
        );
        LibERC721._unlock(loan.borrowerTokenId);
        LibVPFIDiscount.settleBorrowerLifProper(loan);

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

        emit OfferSaleProceedsSplit(
            offerId, loanId, lenderHolder, lenderLeg, treasury, treasuryLeg,
            remainderRecipient, remainder
        );
        // Codex round-4 P2 #3 — also emit the loan-keyed terminal event
        // the existing indexer (`chainIndexer.ts`) listens for to flip
        // the D1 loan row to `settled`. Without this, accept-then-sold
        // loans would stay `active` in the indexer even after the
        // on-chain settle. Reuses the established
        // `PrepayCollateralSaleSettled` event; the indexer's
        // existing handler runs verbatim with no schema work.
        emit PrepayCollateralSaleSettled(loanId, msg.sender);
    }

    /// @notice T-086 Round-8 (#358) Codex round-3 user-directed redesign
    ///         — emitted on the post-acceptance parallel-sale fill path.
    ///         Distinct from `OfferSaleProceedsCredited` (Scenario A,
    ///         full credit to borrower) so the indexer can render the
    ///         split breakdown + the loan's terminal flip together.
    /// @custom:event-category state-change/loan-mutation
    event OfferSaleProceedsSplit(
        uint96 indexed offerId,
        uint256 indexed loanId,
        address lender,
        uint256 lenderAmount,
        address treasury,
        uint256 treasuryAmount,
        address borrower,
        uint256 borrowerRemainder
    );

    /// @notice T-086 Round-8 (#358) Codex round-3 — raised when a
    ///         post-acceptance parallel-sale fill's proceeds don't
    ///         cover the lender + treasury entitlements. Mirrors the
    ///         loan-keyed `LenderShortPaid` / `TreasuryShortPaid`
    ///         posture. The pre-loan floor formula prevents this
    ///         under the happy path; the revert is defensive.
    error ProceedsBelowLenderTreasury(uint96 offerId, uint256 amount, uint256 required);
    /// @notice T-086 Round-8 (#358) Codex round-5 P1 #2 — raised when
    ///         a post-acceptance parallel-sale fill is attempted past
    ///         the loan's graceEnd. Mirrors the loan-keyed executor's
    ///         `GraceExpired` and RepayFacet's
    ///         `RepaymentPastGracePeriod` posture.
    error ParallelSaleFillPastGrace(uint96 offerId, uint256 nowTimestamp, uint256 graceEnd);
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
