// src/facets/NFTPrepayAutoListFacet.sol
// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {LibVaipakam} from "../libraries/LibVaipakam.sol";
import {LibERC721} from "../libraries/LibERC721.sol";
import {LibPrepayOrder} from "../libraries/LibPrepayOrder.sol";
import {LibPrepayListingWiring} from "../libraries/LibPrepayListingWiring.sol";
import {LibAutoList} from "../libraries/LibAutoList.sol";
import {DiamondPausable} from "../libraries/LibPausable.sol";
import {DiamondReentrancyGuard} from "../libraries/LibReentrancyGuard.sol";
import {IListingExecutorRecorder} from "../seaport/IListingExecutorRecorder.sol";
import {IVaipakamPrepayContext} from "../seaport/IVaipakamPrepayContext.sol";
import {VaipakamNFTFacet} from "./VaipakamNFTFacet.sol";
import {FeeLeg, PREPAY_MODE_FIXED_PRICE} from "../seaport/PrepayTypes.sol";
import {LibFacet} from "../libraries/LibFacet.sol";
import {ConsolidationFacet} from "./ConsolidationFacet.sol";

/**
 * @title  NFTPrepayAutoListFacet
 * @author Vaipakam Developer Team
 * @notice T-086 Round-7 (Issue #355) — permissionless `autoListAtFloorOnGrace`
 *         entry point. While a loan is in its grace window, ANY caller
 *         (typically a keeper bot) can either post a fresh fixed-price-
 *         at-floor Seaport listing (Case A — no existing listing) or
 *         rotate an aspirational / stale-leg / late-decaying listing
 *         down to the protocol-mandated floor (Case B).
 *
 *         Lives as its own facet (separate from `NFTPrepayListingFacet`)
 *         because the existing facet is already at the EIP-170 ceiling
 *         and the auto-list orchestration adds ~400 LOC. The B-cond
 *         predicate math lives in {LibAutoList}; the rotation +
 *         post primitives reuse {LibPrepayOrder}, {LibPrepayListingWiring},
 *         and the executor's typed `orderFeeLegs` / `orderProtocolLegs`
 *         getters.
 *
 *         Design doc: §18 of `docs/DesignsAndPlans/NFTCollateralSaleAndAuction.md`.
 *
 *         Trust model: same as `cancelExpiredPrepayListing` /
 *         `markDefaulted` — permissionless trigger, reads on-chain
 *         state, no oracle. The borrower can opt out via
 *         {NFTPrepayListingFacet.cancelPrepayListing} during grace
 *         (sets the sticky `prepayListingAutoListOptedOut[loanId]`
 *         flag) and re-enable via
 *         {NFTPrepayListingFacet.clearAutoListOptOut} (§18.7).
 */
contract NFTPrepayAutoListFacet is DiamondPausable, DiamondReentrancyGuard {
    // ─── Errors ─────────────────────────────────────────────────────────

    error GraceNotStarted(uint256 loanId, uint256 nowTime, uint256 loanEnd);
    error GraceExpired(uint256 loanId, uint256 nowTime, uint256 gracePeriodEnd);
    error PrepayLoanNotActive(uint256 loanId, LibVaipakam.LoanStatus actualStatus);
    error PrepayListingNotAllowed(uint256 loanId);
    error UnsupportedCollateralForV1(LibVaipakam.AssetType collateralAssetType);
    error UnsupportedPrincipalForV1(LibVaipakam.AssetType principalAssetType);
    error PrepayListingDisabled();
    error PrepayListingBufferNotConfigured();
    error ExecutorNotSet();
    error AutoListConduitNotConfigured();
    error VaultNotDeployed(address borrower);
    error NotEligibleAutoLister(address caller);
    error BorrowerSanctioned(uint256 loanId, address currentHolder);
    error AutoListBorrowerOptedOut(uint256 loanId);
    error AutoListAlreadyAtOrBelowFloor(uint256 loanId);
    error AutoListExecutorMigrationStale(uint256 loanId, address recordedExecutor, address currentExecutor);

    // ─── Events ─────────────────────────────────────────────────────────

    /// @notice T-086 Round-7 follow-up (Codex round-12 P2 #2) — Case A
    ///         emits the EXISTING `PrepayListingPosted` event (declared
    ///         on `NFTPrepayListingFacet`) byte-for-byte. Solidity
    ///         allows the same event signature on multiple contracts;
    ///         the topic hash is identical so the indexer's existing
    ///         `PrepayListingPosted` handler catches auto-list Case A
    ///         posts without per-event-type branching. The `lister`
    ///         field identifies the caller — for auto-list it is the
    ///         keeper (caller != ownerOf), letting the indexer pivot
    ///         third-party rotations by comparing `lister` to the
    ///         loan's borrower-position holder.
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

    /// @notice T-086 Round-7 follow-up (Codex round-12 P2 #2) — Case B
    ///         emits the EXISTING `PrepayListingUpdated` event
    ///         byte-for-byte. Same indexer-reuse rationale as
    ///         `PrepayListingPosted` above. The B-cond reason tag the
    ///         earlier `AutoListRotated` event surfaced is derivable
    ///         off-chain from the recorded `OrderContext` of the OLD
    ///         orderHash (mode + ask shape + Dutch timing) vs. the
    ///         live pctx, so no on-chain event field is required.
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

    // ─── Public entry ───────────────────────────────────────────────────

    /// @notice Permissionless grace-period auto-list-at-floor trigger.
    /// @dev    See contract-level natspec + §18 of the design doc.
    /// @param  loanId Loan to auto-list.
    function autoListAtFloorOnGrace(uint256 loanId)
        external
        nonReentrant
        whenNotPaused
    {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        LibVaipakam.Loan storage loan = s.loans[loanId];

        // ── Tier-1 sanctions on caller (§18.10) ────────────────────────
        LibVaipakam._assertNotSanctioned(msg.sender);

        // ── Loan-shape preconditions ───────────────────────────────────
        if (loan.status != LibVaipakam.LoanStatus.Active) {
            revert PrepayLoanNotActive(loanId, loan.status);
        }
        if (!loan.allowsPrepayListing) revert PrepayListingNotAllowed(loanId);
        if (
            loan.collateralAssetType != LibVaipakam.AssetType.ERC721 &&
            loan.collateralAssetType != LibVaipakam.AssetType.ERC1155
        ) revert UnsupportedCollateralForV1(loan.collateralAssetType);
        if (loan.assetType != LibVaipakam.AssetType.ERC20) {
            revert UnsupportedPrincipalForV1(loan.assetType);
        }

        // ── Config + opt-out gates ─────────────────────────────────────
        if (!s.cfgPrepayListingEnabled) revert PrepayListingDisabled();
        if (s.cfgPrepayListingBufferBps == 0) revert PrepayListingBufferNotConfigured();
        if (s.collateralListingExecutor == address(0)) revert ExecutorNotSet();
        if (s.prepayListingAutoListOptedOut[loanId]) revert AutoListBorrowerOptedOut(loanId);

        // ── Grace-window predicate (§18.7 canonical helper) ────────────
        // Split into the two precondition reverts the design enumerates
        // so the dapp / keeper UX can distinguish "too early" from
        // "too late" without reading the helper's combined bool.
        uint256 loanEnd =
            uint256(loan.startTime) + (uint256(loan.durationDays) * 1 days);
        if (block.timestamp < loanEnd) {
            revert GraceNotStarted(loanId, block.timestamp, loanEnd);
        }
        uint256 gracePeriodEnd = loanEnd + LibVaipakam.gracePeriod(loan.durationDays);
        if (block.timestamp >= gracePeriodEnd) {
            revert GraceExpired(loanId, block.timestamp, gracePeriodEnd);
        }

        // ── Caller is NOT the current position holder (§18.7) ─────────
        address currentHolder =
            VaipakamNFTFacet(address(this)).ownerOf(loan.borrowerTokenId);
        if (msg.sender == currentHolder) revert NotEligibleAutoLister(msg.sender);

        // ── Tier-1 sanctions on surplus recipient (§18.10) ─────────────
        if (LibVaipakam.isSanctionedAddress(currentHolder)) {
            revert BorrowerSanctioned(loanId, currentHolder);
        }

        // #656c (#594) — on the Case-A creation path only (no existing
        // listing), consolidate the borrower side to the current holder
        // BEFORE the holder's vault is cached below, so the fresh listing
        // binds the holder's vault (re-anchors `loan.borrower` to the
        // holder). Case B (rotation of a live listing) needs no
        // consolidation: a live listing locks the borrower NFT, so the
        // position can't have been transferred since the listing was created
        // — whichever creation path posted it already consolidated. The
        // gate condition is an immediately-consumed re-read of the slot
        // (one extra warm SLOAD) so the long-lived `existingOrderHash` local
        // below keeps its original short live-range and the Case-B
        // rotation's stack budget is unchanged. Cross-facet to the
        // internal-only `ConsolidationFacet` (Tier-2 skip-not-block).
        if (s.prepayListingOrderHash[loanId] == bytes32(0)) {
            _consolidateBorrowerToHolder(loanId);
        }

        // ── Vault deployed ─────────────────────────────────────────────
        address vaultAddr = s.userVaipakamVaults[loan.borrower];
        if (vaultAddr == address(0)) revert VaultNotDeployed(loan.borrower);

        // ── Dispatch on existing listing presence ──────────────────────
        bytes32 existingOrderHash = s.prepayListingOrderHash[loanId];
        IVaipakamPrepayContext.PrepayContext memory pctx =
            IVaipakamPrepayContext(address(this)).getPrepayContext(loanId, block.timestamp);

        if (existingOrderHash == bytes32(0)) {
            _caseAPost(s, loan, loanId, pctx, vaultAddr);
        } else {
            _caseBRotate(
                s,
                loan,
                loanId,
                pctx,
                vaultAddr,
                existingOrderHash,
                loanEnd,
                gracePeriodEnd
            );
        }
    }

    /// @dev #656c (#594) — consolidate the borrower side to the current
    ///      position holder before the Case-A creation path caches the
    ///      borrower's vault. Cross-facet to the internal-only
    ///      `ConsolidationFacet` (Tier-2 skip-not-block); no-op when the
    ///      position hasn't been transferred or the loan is terminal.
    function _consolidateBorrowerToHolder(uint256 loanId) private {
        LibFacet.crossFacetCall(
            abi.encodeWithSelector(
                ConsolidationFacet.eagerConsolidateToHolder.selector,
                loanId,
                /* isLenderSide */ false
            ),
            bytes4(0)
        );
    }

    // ─── Case A — fresh post when no listing exists ─────────────────────

    function _caseAPost(
        LibVaipakam.Storage storage s,
        LibVaipakam.Loan storage loan,
        uint256 loanId,
        IVaipakamPrepayContext.PrepayContext memory pctx,
        address vaultAddr
    ) private {
        bytes32 conduitKey = s.cfgPrepayListingAutoListConduitKey;
        if (conduitKey == bytes32(0)) revert AutoListConduitNotConfigured();

        IListingExecutorRecorder executor =
            IListingExecutorRecorder(s.collateralListingExecutor);
        address conduit = LibPrepayOrder.resolveConduit(
            executor.seaport(),
            conduitKey
        );
        // Allow-list check at the diamond surface — same fail-fast
        // semantics the borrower-post path uses (gives a clean
        // precondition signal vs bouncing through recordOrder).
        if (!executor.approvedConduits(conduit)) revert AutoListConduitNotConfigured();

        uint256 askPrice = LibAutoList.askAtFloor(pctx, s.cfgPrepayListingBufferBps);
        // Per-loan nonce keeps the salt unique against a same-block
        // cancel-and-relist or update-and-relist (Codex round-1 P2
        // on PR #356). `++` returns pre-increment value.
        uint64 nonce = s.prepayListingAutoListNonce[loanId];
        s.prepayListingAutoListNonce[loanId] = nonce + 1;
        uint256 salt = uint256(keccak256(
            abi.encode(loanId, block.timestamp, msg.sender, nonce)
        ));

        // Build the canonical Seaport orderHash. Auto-list posts
        // protocol-only (no fee legs) — fee-enforced collections
        // will sit unmatched until the borrower cancels + re-lists
        // with proper feeLegs (§18.5 Case D documented limitation).
        FeeLeg[] memory emptyFeeLegs = new FeeLeg[](0);
        bytes32 orderHash = LibPrepayOrder.buildAndHashMem(
            pctx,
            vaultAddr,
            address(executor),
            executor.seaport(),
            askPrice,
            pctx.lenderLeg,
            pctx.treasuryLeg,
            salt,
            conduitKey,
            emptyFeeLegs
        );

        // ── Effects (lock + slot writes) ───────────────────────────────
        LibERC721._lock(loan.borrowerTokenId, LibERC721.LockReason.PrepayCollateralListing);
        s.prepayListingOrderHash[loanId] = orderHash;
        s.prepayListingExecutor[loanId] = address(executor);

        // ── Interactions (executor + vault) ────────────────────────────
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
            emptyFeeLegs,
            pctx.lenderLeg,
            pctx.treasuryLeg
        );
        LibPrepayListingWiring.wire(s, loan, orderHash, conduit, address(executor));

        emit PrepayListingPosted(
            loanId,
            msg.sender,
            orderHash,
            askPrice,
            conduit,
            conduitKey,
            salt,
            address(executor),
            askPrice,                    // endAskPrice = askPrice
            0,                           // auctionEndTime sentinel
            PREPAY_MODE_FIXED_PRICE,
            emptyFeeLegs
        );
    }

    // ─── Case B — rotation gate + rotation steps ────────────────────────

    function _caseBRotate(
        LibVaipakam.Storage storage s,
        LibVaipakam.Loan storage loan,
        uint256 loanId,
        IVaipakamPrepayContext.PrepayContext memory pctx,
        address vaultAddr,
        bytes32 existingOrderHash,
        uint256 loanEnd,
        uint256 gracePeriodEnd
    ) private {
        // ── Pinned-executor + migration-staleness check ────────────────
        // §18.5: rotation reads the PINNED executor for the old order
        // (NOT the current `s.collateralListingExecutor`, which may
        // have been rotated by governance since the old order was
        // posted) so `clearOrder` lands on the right contract. If
        // pinned != current we revert ExecutorMigrationStale — the
        // operator surfaces a real migration gap rather than silently
        // letting the auto-list path skip live listings.
        address pinnedExecutor = s.prepayListingExecutor[loanId];
        address currentExecutor = s.collateralListingExecutor;
        if (pinnedExecutor != currentExecutor) {
            revert AutoListExecutorMigrationStale(loanId, pinnedExecutor, currentExecutor);
        }

        // ── Snapshot the executor's `_orderFeeLegs` BEFORE `clearOrder`
        //    wipes it (round-3.6 + round-3.8). `recordedFeeLegs` is needed by
        //    BOTH the B-cond gate AND `_performRotation`, so it's snapshotted
        //    here. The `_orderProtocolLegs` + `OrderContext` reads (only the
        //    B-cond gate consumes them) are deferred into `_pickBCondReason`
        //    (#656c) so they don't sit live in this frame across the
        //    snapshot→gate→rotation span — that frame relief is what lets the
        //    Case-A consolidate hook in the entry fit the viaIR stack budget.
        //    All three reads still run before `_performRotation`'s
        //    `clearOrder`, so the snapshot ordering is preserved.
        IListingExecutorRecorder exec = IListingExecutorRecorder(pinnedExecutor);
        FeeLeg[] memory recordedFeeLegs = exec.orderFeeLegs(existingOrderHash);

        // ── Evaluate B-cond gates ──────────────────────────────────────
        uint256 askAtFloor_ = LibAutoList.askAtFloor(pctx, s.cfgPrepayListingBufferBps);
        bool shouldRotate = _pickBCondReason(
            exec,
            existingOrderHash,
            pctx,
            recordedFeeLegs,
            askAtFloor_,
            gracePeriodEnd,
            loanEnd,
            s.cfgPrepayListingDutchGraceMarginSec
        );
        if (!shouldRotate) revert AutoListAlreadyAtOrBelowFloor(loanId);

        // ── Rotation steps (per §18.5) ─────────────────────────────────
        _performRotation(
            s,
            loan,
            loanId,
            pctx,
            vaultAddr,
            existingOrderHash,
            pinnedExecutor,
            recordedFeeLegs,
            askAtFloor_
        );
    }

    // ─── Helpers ────────────────────────────────────────────────────────

    /// @dev Returns true if any B-cond rotation trigger fires (caller
    ///      reverts `AlreadyAtOrBelowFloor` otherwise). Evaluated in the
    ///      order documented in §18.5; gates check independently and
    ///      short-circuit on first hit.
    ///
    ///      #656c — the `_orderProtocolLegs` (recorded lender/treasury) +
    ///      `OrderContext` reads live HERE rather than in `_caseBRotate`:
    ///      only the gate consumes them, so confining them to this frame
    ///      keeps `_caseBRotate`'s per-function viaIR stack peak below the
    ///      ceiling. Both reads still happen before the caller's
    ///      `_performRotation` → `clearOrder`, so the pre-clear snapshot
    ///      semantics are unchanged.
    function _pickBCondReason(
        IListingExecutorRecorder exec,
        bytes32 existingOrderHash,
        IVaipakamPrepayContext.PrepayContext memory pctx,
        FeeLeg[] memory recordedFeeLegs,
        uint256 askAtFloor_,
        uint256 gracePeriodEnd,
        uint256 loanEnd,
        uint256 dutchGraceMarginSec
    ) private view returns (bool) {
        (uint128 recordedLender, uint128 recordedTreasury) =
            exec.orderProtocolLegs(existingOrderHash);
        (
            uint8 ctxMode,
            uint192 ctxAskPrice,
            uint128 ctxEndAskPrice,
            uint64 ctxStartTime,
            uint64 ctxAuctionEndTime
        ) = exec.orderContextRead(existingOrderHash);

        if (LibAutoList.b_cond_5_dutchExpired(ctxMode, ctxAuctionEndTime)) {
            return true;
        }
        if (LibAutoList.b_cond_1_fixedPriceAboveFloor(
            ctxMode, uint256(ctxAskPrice), askAtFloor_, recordedFeeLegs
        )) {
            return true;
        }
        if (LibAutoList.b_cond_2_signedLegsShort(pctx, recordedLender, recordedTreasury)) {
            return true;
        }
        if (LibAutoList.b_cond_3a_dutchNeverReachesFee(
            ctxMode, uint256(ctxEndAskPrice), askAtFloor_, recordedFeeLegs
        )) {
            return true;
        }
        if (LibAutoList.b_cond_3b_dutchReachesFloorTooLate(
            ctxMode,
            uint256(ctxAskPrice),
            uint256(ctxEndAskPrice),
            uint256(ctxStartTime),
            uint256(ctxAuctionEndTime),
            askAtFloor_,
            recordedFeeLegs,
            gracePeriodEnd,
            loanEnd,
            dutchGraceMarginSec
        )) {
            return true;
        }
        return false;
    }

    /// @dev Steps 2-9 from §18.5: snapshot already taken; unwire →
    ///      clearOrder (which wipes `_orderFeeLegs` +
    ///      `_orderProtocolLegs` on the executor) → normalize fee
    ///      legs Dutch-to-fixed → buildAndHash → record + wire fresh.
    ///      Step 2 (the snapshot) happened in the caller because the
    ///      snapshot inputs flow into both the B-cond gate AND this
    ///      rotation.
    function _performRotation(
        LibVaipakam.Storage storage s,
        LibVaipakam.Loan storage loan,
        uint256 loanId,
        IVaipakamPrepayContext.PrepayContext memory pctx,
        address vaultAddr,
        bytes32 oldOrderHash,
        address pinnedExecutor,
        FeeLeg[] memory recordedFeeLegs,
        uint256 askAtFloor_
    ) private {
        // Step 2.5 — snapshot the recorded conduit + conduitKey from
        // the OLD `OrderContext` BEFORE `clearOrder` wipes them.
        // Round-2 against Codex round-13 P2 #2 fix: the previous
        // round-2 code read these AFTER clearOrder, which returned
        // (0, 0) for every rotation and broke Case B end-to-end.
        // Mirrors the round-3.6 fee-leg snapshot reordering done in
        // the caller (`_caseBRotate`).
        IListingExecutorRecorder executor = IListingExecutorRecorder(pinnedExecutor);
        (address conduit, bytes32 conduitKey) = executor.orderContextConduit(oldOrderHash);
        if (!executor.approvedConduits(conduit)) revert AutoListConduitNotConfigured();

        // Step 3 — clear the vault's per-orderHash binding.
        LibPrepayListingWiring.unwire(s, loan, oldOrderHash);

        // Step 4 — clear the executor's pinned binding (also wipes
        // _orderFeeLegs + _orderProtocolLegs for `oldOrderHash`;
        // we already snapshotted both, AND the OrderContext-conduit
        // pair above).
        executor.clearOrder(oldOrderHash);

        // Step 5 — normalize the preserved feeLegs from Dutch decay
        // shape (`startAmount > endAmount` allowed) into fixed-price
        // shape (`startAmount == endAmount`) per round-3.3 / Codex
        // round-4 P2. For fixed-price-to-fixed-price the loop is a
        // no-op (start already equals end at post-time).
        uint256 preservedFeeSum = 0;
        for (uint256 i = 0; i < recordedFeeLegs.length; ) {
            uint96 startAmt = recordedFeeLegs[i].startAmount;
            recordedFeeLegs[i].endAmount = startAmt;
            preservedFeeSum += uint256(startAmt);
            unchecked { ++i; }
        }

        // Step 6 — rotatedAsk includes the preserved fee-leg total.
        uint256 rotatedAsk = askAtFloor_ + preservedFeeSum;
        uint64 nonce = s.prepayListingAutoListNonce[loanId];
        s.prepayListingAutoListNonce[loanId] = nonce + 1;
        uint256 salt = uint256(keccak256(
            abi.encode(loanId, block.timestamp, msg.sender, nonce)
        ));

        // Step 7 — recordOrder on the CURRENT executor (== pinned
        // here per the migration-staleness gate in the caller).
        // Conduit + conduitKey were snapshotted from the OLD
        // `OrderContext` at the top of this helper, before
        // `clearOrder` wiped them.

        bytes32 newOrderHash = LibPrepayOrder.buildAndHashMem(
            pctx,
            vaultAddr,
            address(executor),
            executor.seaport(),
            rotatedAsk,
            pctx.lenderLeg,
            pctx.treasuryLeg,
            salt,
            conduitKey,
            recordedFeeLegs
        );

        // Step 8 — restamp the diamond slots (NFT lock stays
        // across the rotation — only the orderHash + executor +
        // vault binding rotate).
        s.prepayListingOrderHash[loanId] = newOrderHash;
        s.prepayListingExecutor[loanId] = address(executor);

        executor.recordOrder(
            newOrderHash,
            loanId,
            conduit,
            conduitKey,
            salt,
            block.timestamp,
            rotatedAsk,
            rotatedAsk,                  // endAskPrice = askPrice
            0,                           // auctionEndTime = 0 sentinel
            PREPAY_MODE_FIXED_PRICE,
            recordedFeeLegs,
            pctx.lenderLeg,
            pctx.treasuryLeg
        );

        // Step 9 — wire the new orderHash to the vault.
        LibPrepayListingWiring.wire(s, loan, newOrderHash, conduit, address(executor));

        // T-086 Round-7 follow-up (Codex round-12 P2 #2) — emit the
        // EXISTING `PrepayListingUpdated` event byte-for-byte. Indexers
        // pivot third-party rotations off `lister != ownerOf`; no new
        // event ABI required. The B-cond reason that the previous
        // `AutoListRotated` event carried is derivable off-chain from
        // the old `OrderContext` (mode + ask shape + Dutch timing) vs.
        // the live pctx.
        emit PrepayListingUpdated(
            loanId,
            msg.sender,
            oldOrderHash,
            newOrderHash,
            rotatedAsk,
            conduit,
            conduitKey,
            salt,
            address(executor),
            rotatedAsk,                  // newEndAskPrice = newAskPrice
            0,                           // newAuctionEndTime sentinel
            PREPAY_MODE_FIXED_PRICE,
            recordedFeeLegs
        );
    }
}
