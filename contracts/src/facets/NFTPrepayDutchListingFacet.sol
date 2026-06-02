// src/facets/NFTPrepayDutchListingFacet.sol
// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {LibVaipakam} from "../libraries/LibVaipakam.sol";
import {LibERC721} from "../libraries/LibERC721.sol";
import {DiamondAccessControl} from "../libraries/LibAccessControl.sol";
import {DiamondPausable} from "../libraries/LibPausable.sol";
import {DiamondReentrancyGuard} from "../libraries/LibReentrancyGuard.sol";
import {IVaipakamErrors} from "../interfaces/IVaipakamErrors.sol";
import {IListingExecutorRecorder} from "../seaport/IListingExecutorRecorder.sol";
import {
    FeeLeg,
    MAX_FEE_LEGS,
    PREPAY_MODE_DUTCH,
    MIN_AUCTION_WINDOW
} from "../seaport/PrepayTypes.sol";
import {VaipakamNFTFacet} from "./VaipakamNFTFacet.sol";
import {VaipakamVaultImplementation} from "../VaipakamVaultImplementation.sol";
import {IVaipakamPrepayContext} from "../seaport/IVaipakamPrepayContext.sol";
import {LibPrepayOrder} from "../libraries/LibPrepayOrder.sol";
import {CollateralListingExecutor} from "../seaport/CollateralListingExecutor.sol";
import {NFTPrepayListingFacet} from "./NFTPrepayListingFacet.sol";

/**
 * @title NFTPrepayDutchListingFacet
 * @author Vaipakam Developer Team
 * @notice T-086 Round-5 Block B (Issue #309) — Dutch-decay
 *         posting + update entry points for the prepay-collateral
 *         listing flow.
 *
 *         Split out of {NFTPrepayListingFacet} so the combined
 *         compiled bytecode of the borrower-facing prepay-listing
 *         surface stays within solc's jump-table reservation
 *         budget (the Round-4 + Block A fixed-price + cancel
 *         entries already filled the parent facet to the brink;
 *         adding Block B's Dutch surface there tripped solc's
 *         "Tag too large for reserved space" internal compiler
 *         error). Both facets share the same LibVaipakam storage,
 *         the same `IListingExecutorRecorder` interface to the
 *         singleton executor, and the same `PrepayListingPosted` /
 *         `PrepayListingUpdated` event topic hashes — the indexer
 *         sees one canonical event stream regardless of which
 *         facet emitted it.
 *
 *         Design ratified at
 *         {{docs/DesignsAndPlans/NFTCollateralSaleAndAuction.md}}
 *         §15.2 (Dutch decay on Seaport, on-chain only).
 *
 *         The cancel paths live entirely on {NFTPrepayListingFacet}
 *         — there's no Dutch-specific cancel because the orderHash
 *         binding + lock release are mode-agnostic. The executor's
 *         `_tryCancelOnSeaport` dispatches on the recorded `mode`
 *         tag to pick the right canonical-shape reconstruction.
 */
contract NFTPrepayDutchListingFacet is
    DiamondPausable,
    DiamondReentrancyGuard,
    DiamondAccessControl,
    IVaipakamErrors
{
    // ─── Events (mirror of {NFTPrepayListingFacet}'s declarations) ──────
    //
    // The events MUST have identical signatures (including the
    // `indexed` markers) on both facets so the topic hash is the
    // same — the indexer subscribes to a single topic and gets all
    // posts / updates regardless of mode + facet origin.
    //
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

    // ─── Errors ─────────────────────────────────────────────────────────

    // Shared with {NFTPrepayListingFacet} — redeclared at the facet
    // boundary so the ABI surface lists every revert path each facet
    // can produce. Selector hashes are identical on both facets.

    error NotPositionHolder(uint256 loanId, address caller, address expected);
    error PrepayListingNotAllowed(uint256 loanId);
    error PrepayLoanNotActive(uint256 loanId, LibVaipakam.LoanStatus actual);
    error PrepayListingAlreadyExists(uint256 loanId, bytes32 existingOrderHash);
    error PrepayListingNotFound(uint256 loanId);
    error PrepayGraceWindowClosed(uint256 loanId, uint256 nowTime, uint256 gracePeriodEnd);
    error ConduitNotApproved(address conduit);
    error ExecutorNotSet();
    error UnsupportedCollateralForV1(LibVaipakam.AssetType collateralType);
    error UnsupportedPrincipalForV1(LibVaipakam.AssetType principalType);
    error BorrowerNFTAlreadyLocked(uint256 tokenId, LibERC721.LockReason currentReason);
    error PrepayListingDisabled();
    error FeeLegsExceedCap(uint256 supplied, uint256 cap);
    error FeeLegInvalidRecipient(uint256 idx);
    error FeeLegInvalidAmount(uint256 idx);

    // ─── Block-B-specific errors ────────────────────────────────────────

    error AuctionWindowTooShort(uint256 loanId, uint256 supplied, uint256 minWindow);
    error AuctionExceedsGrace(uint256 loanId, uint256 auctionEndTime, uint256 gracePeriodEnd);
    error AskNotMonotonic(uint256 startAskPrice, uint256 endAskPrice);
    error FeeLegNotMonotonic(uint256 idx);
    error BorrowerLegNotMonotonic(uint256 startAmount, uint256 endAmount);
    error DutchStartAskBelowProjectedFloorPlusFees(
        uint256 loanId, uint256 startAskPrice, uint256 required
    );
    error DutchEndAskBelowProjectedFloorPlusFees(
        uint256 loanId, uint256 endAskPrice, uint256 required
    );

    // ─── Borrower entry: postPrepayDutchListing ─────────────────────────

    /// @notice Open a Dutch-decay Seaport prepay-listing for a live
    ///         loan's collateral NFT.
    /// @dev    Round-5 Block B (Issue #309). The borrower-leg of the
    ///         Seaport consideration decays linearly from
    ///         `startAskPrice - projectedLender - projectedTreasury
    ///         - sum(feeLegs.startAmount)` at `block.timestamp` down
    ///         to `endAskPrice - projectedLender - projectedTreasury
    ///         - sum(feeLegs.endAmount)` at `auctionEndTime`. Lender
    ///         + treasury legs stay FIXED at the projected-max
    ///         values at `auctionEndTime` under sign-time governance
    ///         config (design doc §15.2). The Seaport
    ///         `OrderComponents.endTime` is `auctionEndTime` (not
    ///         `gracePeriodEnd`) so the order becomes Seaport-unfillable
    ///         past the auction close.
    function postPrepayDutchListing(
        uint256 loanId,
        uint256 startAskPrice,
        uint256 endAskPrice,
        uint256 auctionEndTime,
        uint256 salt,
        bytes32 conduitKey,
        FeeLeg[] calldata feeLegs
    ) external nonReentrant whenNotPaused returns (bytes32 orderHash) {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        LibVaipakam.Loan storage loan = s.loans[loanId];

        _assertBaselinePreconditions(s, loan, loanId);
        if (s.prepayListingOrderHash[loanId] != bytes32(0)) {
            revert PrepayListingAlreadyExists(loanId, s.prepayListingOrderHash[loanId]);
        }
        LibERC721.LockReason currentLock = LibERC721.lockOf(loan.borrowerTokenId);
        if (currentLock != LibERC721.LockReason.None) {
            revert BorrowerNFTAlreadyLocked(loan.borrowerTokenId, currentLock);
        }

        uint256 gracePeriodEnd = _gracePeriodEnd(loan);
        _assertDutchWindow(loanId, auctionEndTime, gracePeriodEnd);

        address holder = VaipakamNFTFacet(address(this)).ownerOf(loan.borrowerTokenId);
        if (holder != msg.sender) revert NotPositionHolder(loanId, msg.sender, holder);

        IListingExecutorRecorder executor = _requireExecutor(s);
        _validateFeeLegsDutch(feeLegs);

        orderHash = _buildAndRecordDutch(
            s, loan, loanId, startAskPrice, endAskPrice, auctionEndTime,
            salt, conduitKey, executor, feeLegs
        );

        emit PrepayListingPosted(
            loanId,
            msg.sender,
            orderHash,
            startAskPrice,
            _resolveConduit(executor, conduitKey),
            conduitKey,
            salt,
            address(executor),
            endAskPrice,
            auctionEndTime,
            PREPAY_MODE_DUTCH,
            feeLegs
        );
    }

    // ─── Borrower entry: updatePrepayDutchListing ───────────────────────

    /// @notice Replace the live listing with fresh
    ///         `(startAskPrice, endAskPrice, auctionEndTime, salt,
    ///         conduitKey, feeLegs)` Dutch parameters. The atomic
    ///         rotation keeps the borrower-position-NFT lock
    ///         continuous so no re-locking race opens. The update
    ///         path may rotate a fixed-price listing into a Dutch
    ///         one (the lock semantics are mode-agnostic; the
    ///         executor's cancel-time reconstruction reads the
    ///         recorded mode tag, not the prior facet's identity).
    function updatePrepayDutchListing(
        uint256 loanId,
        uint256 newStartAskPrice,
        uint256 newEndAskPrice,
        uint256 newAuctionEndTime,
        uint256 newSalt,
        bytes32 newConduitKey,
        FeeLeg[] calldata feeLegs
    ) external nonReentrant whenNotPaused returns (bytes32 newOrderHash) {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        LibVaipakam.Loan storage loan = s.loans[loanId];

        _assertBaselinePreconditions(s, loan, loanId);

        uint256 gracePeriodEnd = _gracePeriodEnd(loan);
        _assertDutchWindow(loanId, newAuctionEndTime, gracePeriodEnd);

        address holder = VaipakamNFTFacet(address(this)).ownerOf(loan.borrowerTokenId);
        if (holder != msg.sender) revert NotPositionHolder(loanId, msg.sender, holder);

        bytes32 oldOrderHash = s.prepayListingOrderHash[loanId];
        if (oldOrderHash == bytes32(0)) revert PrepayListingNotFound(loanId);

        IListingExecutorRecorder currentExecutor = _requireExecutor(s);
        _validateFeeLegsDutch(feeLegs);

        address pinnedExecutor = s.prepayListingExecutor[loanId];
        if (pinnedExecutor != address(0)) {
            IListingExecutorRecorder(pinnedExecutor).clearOrder(oldOrderHash);
        }
        address vaultAddr = s.userVaipakamVaults[loan.borrower];
        if (vaultAddr == address(0)) revert ExecutorNotSet();
        VaipakamVaultImplementation(vaultAddr).revokeListingOrderHash(oldOrderHash);

        newOrderHash = _buildAndRecordDutchUpdate(
            s, loan, loanId, newStartAskPrice, newEndAskPrice, newAuctionEndTime,
            newSalt, newConduitKey, currentExecutor, feeLegs
        );

        emit PrepayListingUpdated(
            loanId,
            msg.sender,
            oldOrderHash,
            newOrderHash,
            newStartAskPrice,
            _resolveConduit(currentExecutor, newConduitKey),
            newConduitKey,
            newSalt,
            address(currentExecutor),
            newEndAskPrice,
            newAuctionEndTime,
            PREPAY_MODE_DUTCH,
            feeLegs
        );
    }

    // ─── Internal helpers ───────────────────────────────────────────────

    /// @dev Mirror of the parent facet's `_gracePeriodEnd` since each
    ///      facet's bytecode owns its own helpers. The duplication is
    ///      load-bearing for the split — both facets must compute the
    ///      same value from the same loan record.
    function _gracePeriodEnd(LibVaipakam.Loan storage loan) private view returns (uint256) {
        uint256 endTime = uint256(loan.startTime) + (uint256(loan.durationDays) * 1 days);
        return endTime + LibVaipakam.gracePeriod(loan.durationDays);
    }

    function _requireExecutor(LibVaipakam.Storage storage s)
        private
        view
        returns (IListingExecutorRecorder)
    {
        address executor = s.collateralListingExecutor;
        if (executor == address(0)) revert ExecutorNotSet();
        return IListingExecutorRecorder(executor);
    }

    function _resolveConduit(
        IListingExecutorRecorder executor,
        bytes32 conduitKey
    ) private view returns (address) {
        return LibPrepayOrder.resolveConduit(
            CollateralListingExecutor(address(executor)).seaport(),
            conduitKey
        );
    }

    function _assertBaselinePreconditions(
        LibVaipakam.Storage storage s,
        LibVaipakam.Loan storage loan,
        uint256 loanId
    ) private view {
        if (!s.cfgPrepayListingEnabled) revert PrepayListingDisabled();
        if (loan.status != LibVaipakam.LoanStatus.Active) {
            revert PrepayLoanNotActive(loanId, loan.status);
        }
        if (!loan.allowsPrepayListing) revert PrepayListingNotAllowed(loanId);
        if (
            loan.collateralAssetType != LibVaipakam.AssetType.ERC721 &&
            loan.collateralAssetType != LibVaipakam.AssetType.ERC1155
        ) {
            revert UnsupportedCollateralForV1(loan.collateralAssetType);
        }
        if (loan.assetType != LibVaipakam.AssetType.ERC20) {
            revert UnsupportedPrincipalForV1(loan.assetType);
        }
        uint256 gracePeriodEnd = _gracePeriodEnd(loan);
        if (block.timestamp >= gracePeriodEnd) {
            revert PrepayGraceWindowClosed(loanId, block.timestamp, gracePeriodEnd);
        }
    }

    function _assertDutchWindow(
        uint256 loanId,
        uint256 auctionEndTime,
        uint256 gracePeriodEnd
    ) private view {
        if (auctionEndTime <= block.timestamp + MIN_AUCTION_WINDOW) {
            revert AuctionWindowTooShort(loanId, auctionEndTime, MIN_AUCTION_WINDOW);
        }
        if (auctionEndTime > gracePeriodEnd) {
            revert AuctionExceedsGrace(loanId, auctionEndTime, gracePeriodEnd);
        }
    }

    function _validateFeeLegsDutch(FeeLeg[] calldata feeLegs) private pure {
        if (feeLegs.length > MAX_FEE_LEGS) {
            revert FeeLegsExceedCap(feeLegs.length, MAX_FEE_LEGS);
        }
        for (uint256 i = 0; i < feeLegs.length; ) {
            if (feeLegs[i].recipient == address(0)) revert FeeLegInvalidRecipient(i);
            if (feeLegs[i].startAmount == 0 || feeLegs[i].endAmount == 0) {
                revert FeeLegInvalidAmount(i);
            }
            if (feeLegs[i].startAmount < feeLegs[i].endAmount) {
                revert FeeLegNotMonotonic(i);
            }
            unchecked { ++i; }
        }
    }

    function _buildAndRecordDutch(
        LibVaipakam.Storage storage s,
        LibVaipakam.Loan storage loan,
        uint256 loanId,
        uint256 startAskPrice,
        uint256 endAskPrice,
        uint256 auctionEndTime,
        uint256 salt,
        bytes32 conduitKey,
        IListingExecutorRecorder executor,
        FeeLeg[] calldata feeLegs
    ) private returns (bytes32 orderHash) {
        if (startAskPrice < endAskPrice) revert AskNotMonotonic(startAskPrice, endAskPrice);

        address conduit = _resolveConduit(executor, conduitKey);
        if (!executor.approvedConduits(conduit)) revert ConduitNotApproved(conduit);

        IVaipakamPrepayContext.PrepayContext memory pctx =
            IVaipakamPrepayContext(address(this)).getPrepayContext(loanId, auctionEndTime);
        _assertDutchSolvency(loanId, startAskPrice, endAskPrice, pctx, feeLegs);

        address vaultAddr = s.userVaipakamVaults[loan.borrower];
        if (vaultAddr == address(0)) revert ExecutorNotSet();

        orderHash = LibPrepayOrder.buildAndHashDutch(
            pctx,
            vaultAddr,
            address(executor),
            CollateralListingExecutor(address(executor)).seaport(),
            startAskPrice,
            endAskPrice,
            pctx.lenderLeg,
            pctx.treasuryLeg,
            auctionEndTime,
            salt,
            conduitKey,
            feeLegs
        );

        LibERC721._lock(loan.borrowerTokenId, LibERC721.LockReason.PrepayCollateralListing);
        s.prepayListingOrderHash[loanId] = orderHash;
        s.prepayListingExecutor[loanId] = address(executor);

        executor.recordOrder(
            orderHash,
            loanId,
            conduit,
            conduitKey,
            salt,
            block.timestamp,
            startAskPrice,
            endAskPrice,
            auctionEndTime,
            PREPAY_MODE_DUTCH,
            feeLegs
        );
        _wireVaultForListing(s, loan, orderHash, conduit, address(executor));
    }

    function _buildAndRecordDutchUpdate(
        LibVaipakam.Storage storage s,
        LibVaipakam.Loan storage loan,
        uint256 loanId,
        uint256 startAskPrice,
        uint256 endAskPrice,
        uint256 auctionEndTime,
        uint256 salt,
        bytes32 conduitKey,
        IListingExecutorRecorder executor,
        FeeLeg[] calldata feeLegs
    ) private returns (bytes32 orderHash) {
        if (startAskPrice < endAskPrice) revert AskNotMonotonic(startAskPrice, endAskPrice);

        address conduit = _resolveConduit(executor, conduitKey);
        if (!executor.approvedConduits(conduit)) revert ConduitNotApproved(conduit);

        IVaipakamPrepayContext.PrepayContext memory pctx =
            IVaipakamPrepayContext(address(this)).getPrepayContext(loanId, auctionEndTime);
        _assertDutchSolvency(loanId, startAskPrice, endAskPrice, pctx, feeLegs);

        address vaultAddr = s.userVaipakamVaults[loan.borrower];
        orderHash = LibPrepayOrder.buildAndHashDutch(
            pctx,
            vaultAddr,
            address(executor),
            CollateralListingExecutor(address(executor)).seaport(),
            startAskPrice,
            endAskPrice,
            pctx.lenderLeg,
            pctx.treasuryLeg,
            auctionEndTime,
            salt,
            conduitKey,
            feeLegs
        );

        s.prepayListingOrderHash[loanId] = orderHash;
        s.prepayListingExecutor[loanId] = address(executor);

        executor.recordOrder(
            orderHash,
            loanId,
            conduit,
            conduitKey,
            salt,
            block.timestamp,
            startAskPrice,
            endAskPrice,
            auctionEndTime,
            PREPAY_MODE_DUTCH,
            feeLegs
        );

        VaipakamVaultImplementation vault = VaipakamVaultImplementation(vaultAddr);
        vault.registerListingOrderHash(orderHash, address(executor));
        _grantConduitApproval(vault, loan, conduit);
    }

    function _assertDutchSolvency(
        uint256 loanId,
        uint256 startAskPrice,
        uint256 endAskPrice,
        IVaipakamPrepayContext.PrepayContext memory pctx,
        FeeLeg[] calldata feeLegs
    ) private pure {
        uint256 feeSumStart = 0;
        uint256 feeSumEnd = 0;
        for (uint256 i = 0; i < feeLegs.length; ) {
            feeSumStart += uint256(feeLegs[i].startAmount);
            feeSumEnd += uint256(feeLegs[i].endAmount);
            unchecked { ++i; }
        }
        uint256 protocolLegs = pctx.lenderLeg + pctx.treasuryLeg;
        uint256 startMin = protocolLegs + feeSumStart;
        uint256 endMin = protocolLegs + feeSumEnd;
        if (startAskPrice < startMin) {
            revert DutchStartAskBelowProjectedFloorPlusFees(loanId, startAskPrice, startMin);
        }
        if (endAskPrice < endMin) {
            revert DutchEndAskBelowProjectedFloorPlusFees(loanId, endAskPrice, endMin);
        }
        // Derived borrower-leg monotonicity — see design doc §15.2,
        // Codex P2 line 577 + line 740. The subtractions are safe:
        // the two solvency reverts above ensure each ask covers its
        // own min.
        uint256 borrowerStart = startAskPrice - startMin;
        uint256 borrowerEnd = endAskPrice - endMin;
        if (borrowerStart < borrowerEnd) {
            revert BorrowerLegNotMonotonic(borrowerStart, borrowerEnd);
        }
    }

    function _wireVaultForListing(
        LibVaipakam.Storage storage s,
        LibVaipakam.Loan storage loan,
        bytes32 orderHash,
        address conduit,
        address executor
    ) private {
        address vaultAddr = s.userVaipakamVaults[loan.borrower];
        if (vaultAddr == address(0)) revert ExecutorNotSet();
        VaipakamVaultImplementation vault = VaipakamVaultImplementation(vaultAddr);
        _grantConduitApproval(vault, loan, conduit);
        vault.registerListingOrderHash(orderHash, executor);
    }

    function _grantConduitApproval(
        VaipakamVaultImplementation vault,
        LibVaipakam.Loan storage loan,
        address conduit
    ) private {
        if (loan.collateralAssetType == LibVaipakam.AssetType.ERC721) {
            vault.setCollateralOperatorApproval(
                loan.collateralAsset, loan.collateralTokenId, conduit, true
            );
        } else {
            vault.setCollateralOperatorApprovalERC1155(
                loan.collateralAsset, conduit, true
            );
        }
    }
}
