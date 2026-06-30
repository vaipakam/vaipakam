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
import {IVaipakamPrepayContext} from "../seaport/IVaipakamPrepayContext.sol";
import {LibPrepayOrder} from "../libraries/LibPrepayOrder.sol";
import {LibPrepayListingWiring} from "../libraries/LibPrepayListingWiring.sol";
import {CollateralListingExecutor} from "../seaport/CollateralListingExecutor.sol";
import {NFTPrepayListingFacet} from "./NFTPrepayListingFacet.sol";
import {LibFacet} from "../libraries/LibFacet.sol";
import {ConsolidationFacet} from "./ConsolidationFacet.sol";

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

    // ─── Internal memory-struct (viaIR stack relief) ────────────────────

    /// @dev #656c — the borrower-supplied Dutch order scalars, bundled so
    ///      they ride in memory (read on-demand via mload) instead of as
    ///      simultaneously-live stack locals across the build + record +
    ///      emit span. Purely a compilation-stack lever; never persisted.
    struct DutchParams {
        uint256 startAskPrice;
        uint256 endAskPrice;
        uint256 auctionEndTime;
        uint256 salt;
        bytes32 conduitKey;
    }

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
        // #818 Tier-1 sanctions — posting a Dutch collateral-sale listing routes
        // value to the holder on fill; `holder == msg.sender`. See the fixed-price
        // `postPrepayListing` for the rationale.
        LibVaipakam._assertNotSanctioned(msg.sender);
        // #825-r2 (P1) — screen fee-leg recipients (see `postPrepayListing`).
        LibPrepayListingWiring.assertFeeLegRecipientsNotSanctioned(feeLegs);

        // #656c (#594) — consolidate the borrower side to the current holder
        // before the order is built + the vault cached, so the listing binds the
        // holder's vault and the position isn't locked out of consolidation
        // under the listing hash (no live hash here — the existence + lock
        // checks above guarantee it).
        _consolidateBorrowerToHolder(loanId);

        IListingExecutorRecorder executor = _requireExecutor(s);
        _validateFeeLegsDutch(feeLegs);

        // #656c — bundle the borrower-supplied Dutch scalars into one memory
        // struct so the five values that are otherwise live from entry through
        // the post-build `emit` (read by both `_buildAndRecordDutch` and the
        // event) stay off the stack (read on-demand via mload). This is the
        // per-function viaIR stack relief that lets the consolidate hook fit;
        // the orderHash output is byte-identical (same scalar values reach
        // `LibPrepayOrder.buildAndHashDutch`).
        DutchParams memory p = DutchParams({
            startAskPrice: startAskPrice,
            endAskPrice: endAskPrice,
            auctionEndTime: auctionEndTime,
            salt: salt,
            conduitKey: conduitKey
        });

        orderHash = _buildAndRecordDutch(s, loan, loanId, p, executor, feeLegs, /* lockNft */ true);

        emit PrepayListingPosted(
            loanId,
            msg.sender,
            orderHash,
            p.startAskPrice,
            _resolveConduit(executor, p.conduitKey),
            p.conduitKey,
            p.salt,
            address(executor),
            p.endAskPrice,
            p.auctionEndTime,
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
        // #818 Tier-1 sanctions — see `postPrepayDutchListing`. `holder == msg.sender`.
        LibVaipakam._assertNotSanctioned(msg.sender);
        // #825-r2 (P1) — screen fee-leg recipients (see `postPrepayListing`).
        LibPrepayListingWiring.assertFeeLegRecipientsNotSanctioned(feeLegs);

        bytes32 oldOrderHash = s.prepayListingOrderHash[loanId];
        if (oldOrderHash == bytes32(0)) revert PrepayListingNotFound(loanId);

        IListingExecutorRecorder currentExecutor = _requireExecutor(s);
        _validateFeeLegsDutch(feeLegs);

        address pinnedExecutor = s.prepayListingExecutor[loanId];
        if (pinnedExecutor != address(0)) {
            IListingExecutorRecorder(pinnedExecutor).clearOrder(oldOrderHash);
        }
        // Round-6 Block D #346: canonical unwire helper. Reverts
        // `VaultNotDeployed` if borrower has no vault (same precondition
        // the old inline check enforced; the symbol now aligns across
        // fixed/Dutch/atomic facets).
        address vaultAddr = s.userVaipakamVaults[loan.borrower];
        if (vaultAddr == address(0)) revert LibPrepayListingWiring.VaultNotDeployed(loan.borrower);
        LibPrepayListingWiring.unwire(s, loan, oldOrderHash);

        // #656c — share the post-path builder (lockNft == false keeps the
        // lock continuous across the rotation). See `_buildAndRecordDutch`.
        DutchParams memory p = DutchParams({
            startAskPrice: newStartAskPrice,
            endAskPrice: newEndAskPrice,
            auctionEndTime: newAuctionEndTime,
            salt: newSalt,
            conduitKey: newConduitKey
        });
        newOrderHash = _buildAndRecordDutch(s, loan, loanId, p, currentExecutor, feeLegs, /* lockNft */ false);

        emit PrepayListingUpdated(
            loanId,
            msg.sender,
            oldOrderHash,
            newOrderHash,
            p.startAskPrice,
            _resolveConduit(currentExecutor, p.conduitKey),
            p.conduitKey,
            p.salt,
            address(currentExecutor),
            p.endAskPrice,
            p.auctionEndTime,
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
        return endTime + LibVaipakam.loanGracePeriod(loan);
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

    /// @dev #656c — consolidate the borrower side to the current position
    ///      holder before a listing-creation path caches the borrower's vault.
    ///      Cross-facet to the internal-only `ConsolidationFacet`
    ///      (Tier-2 skip-not-block); no-op when the position hasn't been
    ///      transferred or the loan is terminal.
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

    /// @dev #656c — unified post/update Dutch builder. Called from BOTH
    ///      `postPrepayDutchListing` (`lockNft == true`) and
    ///      `updatePrepayDutchListing` (`lockNft == false`, the lock stays
    ///      continuous across the rotation). The two-call-site shape keeps
    ///      the optimizer from inlining the heavy `recordOrder` marshalling
    ///      back into the entry frames — that isolation is the per-function
    ///      viaIR stack relief that lets the consolidate hook fit in the
    ///      post entry. `p` carries the order scalars in memory so they
    ///      ride off-stack at the call boundary; the orderHash output is
    ///      byte-identical to the pre-merge builders (same scalar values
    ///      reach `LibPrepayOrder.buildAndHashDutch`).
    function _buildAndRecordDutch(
        LibVaipakam.Storage storage s,
        LibVaipakam.Loan storage loan,
        uint256 loanId,
        DutchParams memory p,
        IListingExecutorRecorder executor,
        FeeLeg[] calldata feeLegs,
        bool lockNft
    ) private returns (bytes32 orderHash) {
        if (p.startAskPrice < p.endAskPrice) revert AskNotMonotonic(p.startAskPrice, p.endAskPrice);

        address conduit = _resolveConduit(executor, p.conduitKey);
        if (!executor.approvedConduits(conduit)) revert ConduitNotApproved(conduit);

        IVaipakamPrepayContext.PrepayContext memory pctx =
            IVaipakamPrepayContext(address(this)).getPrepayContext(loanId, p.auctionEndTime);
        _assertDutchSolvency(loanId, p.startAskPrice, p.endAskPrice, pctx, feeLegs);

        address vaultAddr = s.userVaipakamVaults[loan.borrower];
        if (vaultAddr == address(0)) revert LibPrepayListingWiring.VaultNotDeployed(loan.borrower);

        orderHash = LibPrepayOrder.buildAndHashDutch(
            pctx,
            vaultAddr,
            address(executor),
            CollateralListingExecutor(address(executor)).seaport(),
            p.startAskPrice,
            p.endAskPrice,
            pctx.lenderLeg,
            pctx.treasuryLeg,
            p.auctionEndTime,
            p.salt,
            p.conduitKey,
            feeLegs
        );

        // Post path locks the borrower NFT; the update path keeps the
        // existing lock continuous across the rotation (no re-lock race).
        if (lockNft) {
            LibERC721._lock(loan.borrowerTokenId, LibERC721.LockReason.PrepayCollateralListing);
        }
        s.prepayListingOrderHash[loanId] = orderHash;
        s.prepayListingExecutor[loanId] = address(executor);

        executor.recordOrder(
            orderHash,
            loanId,
            conduit,
            p.conduitKey,
            p.salt,
            block.timestamp,
            p.startAskPrice,
            p.endAskPrice,
            p.auctionEndTime,
            PREPAY_MODE_DUTCH,
            feeLegs,
            // T-086 Round-7 (Issue #355) — signed-leg snapshot. Dutch
            // orders sign consideration[0/1].amount as the projected
            // lender/treasury legs at auctionEndTime, which is exactly
            // the pctx pulled at `getPrepayContext(loanId,
            // auctionEndTime)` above; LibPrepayOrder.buildAndHashDutch
            // forwards these as the signed amounts.
            pctx.lenderLeg,
            pctx.treasuryLeg
        );

        // Round-6 Block D #346: route through shared library so v1
        // fixed + v1 Dutch + v2 atomic facets all hit the same wiring
        // primitive. The `vaultAddr` precondition above is redundant
        // with the library's own `VaultNotDeployed` revert; keeping
        // the upfront check so the buildAndHashDutch call below sees
        // a non-zero offerer.
        LibPrepayListingWiring.wire(s, loan, orderHash, conduit, address(executor));
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

    // Round-6 Block D #346: `_wireVaultForListing` + `_grantConduitApproval`
    // moved into `LibPrepayListingWiring` so v1 fixed + v1 Dutch + v2
    // atomic facets all share a single wiring primitive. The Dutch
    // facet now invokes `LibPrepayListingWiring.wire` / `.unwire`
    // directly at the call sites above.
}
