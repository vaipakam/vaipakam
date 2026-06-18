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
import {VaultFactoryFacet} from "./VaultFactoryFacet.sol";
import {EncumbranceMutateFacet} from "./EncumbranceMutateFacet.sol";
import {LibEncumbrance} from "../libraries/LibEncumbrance.sol";

/**
 * @title AddCollateralFacet
 * @author Vaipakam Developer Team
 * @notice This facet allows borrowers to add more ERC-20 collateral to active loans in the Vaipakam P2P lending platform.
 * @dev Part of the Diamond Standard (EIP-2535). Uses shared LibVaipakam storage.
 *      Enables borrowers with liquid collateral loans to proactively reduce LTV and avoid liquidation
 *      when their collateral value is declining (Phase 1 Addition per README Section "Allow Borrower to Add Collateral").
 *      Only supports ERC-20 liquid collateral (same type as the existing loan collateral).
 *      Adding collateral always improves Health Factor and reduces LTV, so no minimum threshold is enforced.
 *      Transfers additional collateral directly into borrower's vault proxy and updates loan.collateralAmount.
 *      Custom errors, events, ReentrancyGuard, Pausable. Cross-facet calls for vault and risk calculations.
 *      Callable only by the borrower of the loan. Expand for Phase 2 (e.g., multi-collateral types).
 */
contract AddCollateralFacet is DiamondReentrancyGuard, DiamondPausable, IVaipakamErrors {
    using SafeERC20 for IERC20;

    // ─── Events ───────────────────────────────────────────────────────────────

    /// @notice Emitted when a FallbackPending loan is cured by a collateral
    ///         top-up that restores HF above MIN_HEALTH_FACTOR. The previously
    ///         held diamond-side collateral has been moved back to the
    ///         borrower's vault and the snapshot cleared; the loan is Active.
    /// @custom:event-category state-change/loan-mutation
    event LoanCuredFromFallback(
        uint256 indexed loanId,
        address indexed borrower,
        uint256 restoredCollateralAmount,
        uint256 newHf
    );

    /// @notice Emitted when a borrower adds collateral to an active loan.
    /// @param loanId The active loan ID.
    /// @param borrower The borrower's address.
    /// @param amountAdded The additional collateral deposited.
    /// @param newCollateralAmount The total collateral after the addition.
    /// @param newHf The updated Health Factor (scaled to 1e18) after adding collateral.
    /// @param newLtv The updated LTV (in basis points) after adding collateral.
    /// @custom:event-category state-change/loan-mutation
    event CollateralAdded(
        uint256 indexed loanId,
        address indexed borrower,
        uint256 amountAdded,
        uint256 newCollateralAmount,
        uint256 newHf,
        uint256 newLtv
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
     *      Transfers `amount` of the existing collateral asset from the caller into the borrower's vault.
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
        // T-090 v1.1 (#389) §5.8 — top-ups mutate
        // `loan.collateralAmount` mid-auction; the v1.1 commit's
        // `custodialCollateral` / makerAmount would drift from the
        // loan struct + `postInteraction`'s
        // `actualCollateralConsumed = loan.collateralAmount`
        // accounting would double-count the top-up.
        LibVaipakam.assertNoLiveIntentCommit(loanId);
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        LibVaipakam.Loan storage loan = s.loans[loanId];

        LibAuth.requireBorrowerNftOwner(loan);
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

        // #569 Codex #572 round-2 P2 — resolve the canonical collateral
        // vault as the STORED `loan.borrower`'s, NOT `msg.sender`'s. The
        // borrower-position NFT may have transferred, so the current
        // holder (`requireBorrowerNftOwner` authorizes them) can call
        // this — but the collateral lien is keyed to `loan.borrower`,
        // the original collateral sits in `loan.borrower`'s vault, and
        // the close / claim paths expect the enlarged `collateralAmount`
        // there. The deposit, the lien increment, and the cure-path
        // restore must all target the same vault as the lien.
        address borrowerVault = LibFacet.getOrCreateVault(loan.borrower);

        // Pull the top-up from the CALLER (`msg.sender`, the funding
        // party / current NFT holder) into `loan.borrower`'s vault via
        // the cross-payer chokepoint, so the protocolTrackedVaultBalance
        // counter ticks up under `loan.borrower` (where the lien lives).
        // For the common case (`msg.sender == loan.borrower`) this is
        // identical to the prior `vaultDepositERC20` self-deposit.
        LibFacet.crossFacetCall(
            abi.encodeWithSelector(
                VaultFactoryFacet.vaultDepositERC20From.selector,
                msg.sender,        // payer
                loan.borrower,     // vault owner (= lien.user)
                loan.collateralAsset,
                amount
            ),
            VaultDepositFailed.selector
        );

        // Update loan collateral amount
        loan.collateralAmount += amount;

        // #407 PR 4 round-1 Codex P2 #6 (2026-06-12) — keep the
        // collateral lien in parity with the collateral now sitting in
        // the borrower's vault. #569 Codex #572 round-4 P1 — increment
        // for BOTH Active and FallbackPending. The top-up lands in the
        // vault immediately, so it must be liened immediately, even on a
        // FallbackPending loan that this call doesn't cure (else the
        // top-up is drainable before a later cure). `incrementCollateralLien`
        // is create-if-absent, so it correctly seeds a fresh lien on the
        // released FallbackPending row sized to the top-up (the vault
        // portion) — the snapshot collateral still held in the Diamond
        // is folded in by `_cureFallback`'s own increment when restored.
        // No-op on NFT rentals (D-1).
        LibFacet.crossFacetCall(
            abi.encodeWithSelector(
                EncumbranceMutateFacet.incrementCollateralLien.selector,
                loanId,
                amount
            ),
            bytes4(0)
        );

        // Calculate new HF and LTV for event emission (best-effort; failures don't revert)
        uint256 newHf;
        uint256 newLtv;
        (bool success, bytes memory result) = address(this).staticcall(
            abi.encodeWithSelector(RiskFacet.calculateHealthFactor.selector, loanId)
        );
        if (success && result.length > 0) {
            newHf = abi.decode(result, (uint256));
        }

        (success, result) = address(this).staticcall(
            abi.encodeWithSelector(RiskFacet.calculateLTV.selector, loanId)
        );
        if (success && result.length > 0) {
            newLtv = abi.decode(result, (uint256));
        }

        emit CollateralAdded(
            loanId,
            msg.sender,
            amount,
            loan.collateralAmount,
            newHf,
            newLtv
        );

        // Cure path: a FallbackPending loan reactivates only when both HF and
        // LTV are back within the same caps enforced at initiation
        // (MIN_HEALTH_FACTOR and assetRiskParams[collateral].loanInitMaxLtvBps).
        // Anything looser leaves the loan in FallbackPending and the lender
        // can still claim at any time.
        if (
            loan.status == LibVaipakam.LoanStatus.FallbackPending &&
            newHf >= LibVaipakam.MIN_HEALTH_FACTOR &&
            newLtv <= s.assetRiskParams[loan.collateralAsset].loanInitMaxLtvBps
        ) {
            _cureFallback(loanId, loan, borrowerVault);
            emit LoanCuredFromFallback(loanId, msg.sender, loan.collateralAmount, newHf);
        }
    }

    /// @dev Restores a FallbackPending loan to Active. The diamond-side
    ///      collateral (recorded in fallbackSnapshot) is pushed back into the
    ///      borrower vault, the snapshot is cleared, claim records are wiped
    ///      so neither side can pull against a stale split, and the NFTs are
    ///      relabeled to "Loan Initiated".
    function _cureFallback(
        uint256 loanId,
        LibVaipakam.Loan storage loan,
        address borrowerVault
    ) internal {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        LibVaipakam.FallbackSnapshot storage snap = s.fallbackSnapshot[loanId];

        uint256 held = snap.lenderCollateral +
            snap.treasuryCollateral +
            snap.borrowerCollateral;
        if (held > 0) {
            IERC20(loan.collateralAsset).safeTransfer(borrowerVault, held);
            // #569 Codex #572 round-3 P2 — tick the protocol-tracked
            // counter for the restored snapshot collateral. The cure
            // recreates the lien for the FULL `collateralAmount` below;
            // since the withdraw guard now caps free balance by
            // `protocolTrackedVaultBalance` (round-2 P2), failing to
            // record this Diamond→vault restore would leave the tracked
            // counter below the lien, so the restored collateral could
            // never be returned/liquidated after a later terminal.
            // Mirrors `RepayFacet`'s FallbackPending-cure record.
            LibVaipakam.recordVaultDeposit(
                loan.borrower, loan.collateralAsset, held
            );
        }

        delete s.fallbackSnapshot[loanId];
        delete s.lenderClaims[loanId];
        delete s.borrowerClaims[loanId];
        // #630 — drop any Role-B cash-exit opt-in: this fallback episode is over,
        // so a later, distinct fallback must be re-authorized by the then-owner.
        delete s.lenderBackstopOptIn[loanId];

        // Cure path: FallbackPending -> Active.
        LibLifecycle.transition(
            loan,
            LibVaipakam.LoanStatus.FallbackPending,
            LibVaipakam.LoanStatus.Active
        );

        // #569 Codex #572 round-4 P1 — grow the lien by the restored
        // snapshot collateral `held` (Diamond → vault, above). The
        // top-up(s) that accumulated while the loan was FallbackPending
        // were ALREADY liened by `addCollateral`'s increment (the lien
        // now equals the vault's top-up portion), so this must INCREMENT
        // by `held`, not overwrite — `held + topUps == collateralAmount`.
        // `incrementCollateralLien` is create-if-absent, so this also
        // covers the (held>0, no prior top-up) case where the cure is
        // reached without an `addCollateral` increment. No-op on NFT
        // rentals (D-1) and when `held == 0`.
        LibEncumbrance.incrementCollateralLien(loanId, held);

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
