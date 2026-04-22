// src/facets/AddCollateralFacet.sol
// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {LibVaipakam} from "../libraries/LibVaipakam.sol";
import {LibLifecycle} from "../libraries/LibLifecycle.sol";
import {LibAuth} from "../libraries/LibAuth.sol";
import {LibFacet} from "../libraries/LibFacet.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {DiamondReentrancyGuard} from "../libraries/LibReentrancyGuard.sol";
import {DiamondPausable} from "../libraries/LibPausable.sol";
import {IVaipakamErrors} from "../interfaces/IVaipakamErrors.sol";
import {OracleFacet} from "./OracleFacet.sol";
import {RiskFacet} from "./RiskFacet.sol";
import {VaipakamNFTFacet} from "./VaipakamNFTFacet.sol";

/**
 * @title AddCollateralFacet
 * @author Vaipakam Developer Team
 * @notice This facet allows borrowers to add more ERC-20 collateral to active loans in the Vaipakam P2P lending platform.
 * @dev Part of the Diamond Standard (EIP-2535). Uses shared LibVaipakam storage.
 *      Enables borrowers with liquid collateral loans to proactively reduce LTV and avoid liquidation
 *      when their collateral value is declining (Phase 1 Addition per README Section "Allow Borrower to Add Collateral").
 *      Only supports ERC-20 liquid collateral (same type as the existing loan collateral).
 *      Adding collateral always improves Health Factor and reduces LTV, so no minimum threshold is enforced.
 *      Transfers additional collateral directly into borrower's escrow proxy and updates loan.collateralAmount.
 *      Custom errors, events, ReentrancyGuard, Pausable. Cross-facet calls for escrow and risk calculations.
 *      Callable only by the borrower of the loan. Expand for Phase 2 (e.g., multi-collateral types).
 */
contract AddCollateralFacet is DiamondReentrancyGuard, DiamondPausable, IVaipakamErrors {
    using SafeERC20 for IERC20;

    // ─── Events ───────────────────────────────────────────────────────────────

    /// @notice Emitted when a FallbackPending loan is cured by a collateral
    ///         top-up that restores HF above MIN_HEALTH_FACTOR. The previously
    ///         held diamond-side collateral has been moved back to the
    ///         borrower's escrow and the snapshot cleared; the loan is Active.
    event LoanCuredFromFallback(
        uint256 indexed loanId,
        address indexed borrower,
        uint256 restoredCollateralAmount,
        uint256 newHF
    );

    /// @notice Emitted when a borrower adds collateral to an active loan.
    /// @param loanId The active loan ID.
    /// @param borrower The borrower's address.
    /// @param amountAdded The additional collateral deposited.
    /// @param newCollateralAmount The total collateral after the addition.
    /// @param newHF The updated Health Factor (scaled to 1e18) after adding collateral.
    /// @param newLTV The updated LTV (in basis points) after adding collateral.
    event CollateralAdded(
        uint256 indexed loanId,
        address indexed borrower,
        uint256 amountAdded,
        uint256 newCollateralAmount,
        uint256 newHF,
        uint256 newLTV
    );

    // Shared errors inherited from IVaipakamErrors

    // ─── External Functions ───────────────────────────────────────────────────

    /**
     * @notice Adds additional ERC-20 collateral to an active loan.
     * @dev Only the current borrower-side position NFT owner can call this.
     *      With native transfer locking during strategic flows (Preclose
     *      Option 3 offset, EarlyWithdrawal sale) the NFT never leaves its
     *      owner, so a plain ownerOf check is sufficient.
     *      Only liquid collateral loans are supported.
     *      Transfers `amount` of the existing collateral asset from the caller into the borrower's escrow.
     *      Updates loan.collateralAmount. Emits CollateralAdded with new HF and LTV.
     *      Does not enforce a minimum HF check (adding collateral always improves position).
     *      Reverts if loan is not active, caller is not the borrower-NFT owner,
     *      amount is zero, or collateral is illiquid.
     * @param loanId The ID of the active loan to top up.
     * @param amount The additional collateral amount (in the collateral asset's native decimals).
     */
    function addCollateral(
        uint256 loanId,
        uint256 amount
    ) external nonReentrant whenNotPaused {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        LibVaipakam.Loan storage loan = s.loans[loanId];

        LibAuth.requireBorrowerNFTOwner(loan);
        // FallbackPending is accepted: README allows the borrower to cure a
        // failed liquidation by topping up collateral until the lender claims.
        if (
            loan.status != LibVaipakam.LoanStatus.Active &&
            loan.status != LibVaipakam.LoanStatus.FallbackPending
        ) revert LoanNotActive();
        if (amount == 0) revert InvalidAmount();

        // Per-asset pause: topping up new collateral into a paused asset
        // is a creation path (it increases diamond-held exposure).
        // Blocking here still lets the borrower exit via repay / default
        // paths which do NOT call requireAssetNotPaused.
        LibFacet.requireAssetNotPaused(loan.collateralAsset);

        // Only liquid collateral can be topped up (illiquid assets have $0 platform value)
        // Check the collateral asset's liquidity directly via oracle
        LibVaipakam.LiquidityStatus collateralLiquidity = OracleFacet(address(this))
            .checkLiquidity(loan.collateralAsset);
        if (collateralLiquidity != LibVaipakam.LiquidityStatus.Liquid)
            revert IlliquidAsset();

        // Get (or create) the borrower's escrow proxy
        address borrowerEscrow = LibFacet.getOrCreateEscrow(msg.sender);

        // Transfer collateral from borrower directly into their escrow proxy
        IERC20(loan.collateralAsset).safeTransferFrom(
            msg.sender,
            borrowerEscrow,
            amount
        );

        // Update loan collateral amount
        loan.collateralAmount += amount;

        // Calculate new HF and LTV for event emission (best-effort; failures don't revert)
        uint256 newHF;
        uint256 newLTV;
        (bool success, bytes memory result) = address(this).staticcall(
            abi.encodeWithSelector(RiskFacet.calculateHealthFactor.selector, loanId)
        );
        if (success && result.length > 0) {
            newHF = abi.decode(result, (uint256));
        }

        (success, result) = address(this).staticcall(
            abi.encodeWithSelector(RiskFacet.calculateLTV.selector, loanId)
        );
        if (success && result.length > 0) {
            newLTV = abi.decode(result, (uint256));
        }

        emit CollateralAdded(
            loanId,
            msg.sender,
            amount,
            loan.collateralAmount,
            newHF,
            newLTV
        );

        // Cure path: a FallbackPending loan reactivates only when both HF and
        // LTV are back within the same caps enforced at initiation
        // (MIN_HEALTH_FACTOR and assetRiskParams[collateral].maxLtvBps).
        // Anything looser leaves the loan in FallbackPending and the lender
        // can still claim at any time.
        if (
            loan.status == LibVaipakam.LoanStatus.FallbackPending &&
            newHF >= LibVaipakam.MIN_HEALTH_FACTOR &&
            newLTV <= s.assetRiskParams[loan.collateralAsset].maxLtvBps
        ) {
            _cureFallback(loanId, loan, borrowerEscrow);
            emit LoanCuredFromFallback(loanId, msg.sender, loan.collateralAmount, newHF);
        }
    }

    /// @dev Restores a FallbackPending loan to Active. The diamond-side
    ///      collateral (recorded in fallbackSnapshot) is pushed back into the
    ///      borrower escrow, the snapshot is cleared, claim records are wiped
    ///      so neither side can pull against a stale split, and the NFTs are
    ///      relabeled to "Loan Initiated".
    function _cureFallback(
        uint256 loanId,
        LibVaipakam.Loan storage loan,
        address borrowerEscrow
    ) internal {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        LibVaipakam.FallbackSnapshot storage snap = s.fallbackSnapshot[loanId];

        uint256 held = snap.lenderCollateral +
            snap.treasuryCollateral +
            snap.borrowerCollateral;
        if (held > 0) {
            IERC20(loan.collateralAsset).safeTransfer(borrowerEscrow, held);
        }

        delete s.fallbackSnapshot[loanId];
        delete s.lenderClaims[loanId];
        delete s.borrowerClaims[loanId];

        // Cure path: FallbackPending -> Active.
        LibLifecycle.transition(
            loan,
            LibVaipakam.LoanStatus.FallbackPending,
            LibVaipakam.LoanStatus.Active
        );

        LibFacet.crossFacetCall(
            abi.encodeWithSelector(
                VaipakamNFTFacet.updateNFTStatus.selector,
                loan.lenderTokenId,
                loanId,
                LibVaipakam.LoanPositionStatus.LoanInitiated
            ),
            NFTStatusUpdateFailed.selector
        );
        LibFacet.crossFacetCall(
            abi.encodeWithSelector(
                VaipakamNFTFacet.updateNFTStatus.selector,
                loan.borrowerTokenId,
                loanId,
                LibVaipakam.LoanPositionStatus.LoanInitiated
            ),
            NFTStatusUpdateFailed.selector
        );
    }
}
