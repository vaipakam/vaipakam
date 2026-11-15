// src/facets/SettlementLegFacet.sol
// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {IERC1155} from "@openzeppelin/contracts/token/ERC1155/IERC1155.sol";
import {LibVaipakam} from "../libraries/LibVaipakam.sol";
import {LibFacet} from "../libraries/LibFacet.sol";
import {LibRevert} from "../libraries/LibRevert.sol";
import {LibEncumbrance} from "../libraries/LibEncumbrance.sol";
import {LibSanctionedLock} from "../libraries/LibSanctionedLock.sol";
import {LibVaultOutflow} from "../libraries/LibVaultOutflow.sol";
import {OutflowReason} from "../vault/VaultOutflowTypes.sol";
import {IVaipakamErrors} from "../interfaces/IVaipakamErrors.sol";
import {VaultFactoryFacet} from "./VaultFactoryFacet.sol";

/**
 * @title  SettlementLegFacet
 * @author Vaipakam Developer Team
 * @notice The one host of the rule for a settlement leg a token refuses to
 *         move (#3669, `docs/DesignsAndPlans/RefusedSettlementLegDesign.md`):
 *         the leg stays in the payer's own vault under a lien for the payee,
 *         and the settlement completes. The loan reaches its terminal state;
 *         the payee's claim releases the leg once the token moves it.
 *
 * @dev    WHY. A token that can freeze an address or pause transfers would
 *         otherwise let a third party hold a loan hostage: a frozen lender
 *         vault made the borrower's repayment revert (so the loan defaulted on
 *         the borrower's collateral), and a frozen borrower vault made the
 *         in-kind default revert (so the loan never closed). Nothing here
 *         waits in the Diamond.
 *
 *         WHICH FAILURES PARK. A leg parks only when the attempt to move it
 *         failed AND the payer holds the whole leg where the park leaves it.
 *         A short holding (a rebase down below the tracked figure) still
 *         reverts with the attempt's own error, so a parked leg can always be
 *         paid in full later.
 *
 *         GAS. Each attempt is given exactly {ATTEMPT_GAS} and is made only
 *         when that much can reach it; with less, the step reverts
 *         {SettlementAttemptOutOfGas}. A caller therefore cannot starve the
 *         attempt to make a deliverable leg park (the rule
 *         `ProtocolBroadcastFacet` applies to its lanes).
 *
 *         TRUST MODEL. Every mutator is `address(this)`-gated: a leg moves a
 *         payer's allowance or a vault's balance, so it is reachable only from
 *         the settlement facets. No reentrancy guard of its own: every caller
 *         already holds the Diamond guard.
 */
contract SettlementLegFacet is IVaipakamErrors {
    /// @notice The gas each attempt to move a leg is given: exactly this,
    ///         well above a vault-to-vault move that also creates the payee's
    ///         vault.
    uint256 internal constant ATTEMPT_GAS = 1_500_000;
    /// @dev The CALL's own cost that the 63/64 rule applies after.
    uint256 private constant CALL_OVERHEAD_GAS = 20_000;

    /// @notice A leg the token refused was left in `payer`'s vault under a
    ///         lien for `loanId`'s lender side.
    /// @custom:event-category state-change/loan-mutation
    event SettlementLegParked(
        uint256 indexed loanId,
        address indexed payer,
        address asset,
        LibVaipakam.AssetType assetType,
        uint256 tokenId,
        uint256 amount
    );
    /// @notice A parked leg left `payer`'s vault for the lender side's vault;
    ///         `arrived` is what reached it.
    /// @custom:event-category state-change/loan-mutation
    event SettlementLegReleased(uint256 indexed loanId, address indexed payer, uint256 arrived);

    /// @notice Less gas was left than an attempt is given; the step reverts so
    ///         a deliverable leg can never be parked by withholding gas.
    error SettlementAttemptOutOfGas();
    /// @notice A leg is already parked for this loan's lender side.
    error SettlementLegAlreadyParked(uint256 loanId);

    // ─── Repayment to the lender side ──────────────────────────────────

    /**
     * @notice Deliver `amount` of `asset` from `payer`'s wallet into the
     *         vault of `loanId`'s stored lender, or, when the token refuses
     *         that delivery, into `payer`'s own vault under a lien for the
     *         lender side.
     * @return parked Whether the leg was parked.
     */
    function deliverLenderDueOrPark(uint256 loanId, address payer, address asset, uint256 amount)
        external
        returns (bool parked)
    {
        _onlySelf();
        if (amount == 0) return false;
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        (bool ok, bytes memory ret) = _attempt(
            abi.encodeCall(VaultFactoryFacet.vaultDepositERC20From, (payer, s.loans[loanId].lender, asset, amount))
        );
        if (ok) return false;
        // The payer must hold, and have granted, the whole leg: otherwise the
        // failure is the payer's own, and it surfaces as it always did.
        if (
            IERC20(asset).balanceOf(payer) < amount
                || IERC20(asset).allowance(payer, address(this)) < amount
        ) LibRevert.bubbleOnFailureTyped(false, ret, VaultDepositFailed.selector);

        LibFacet.crossFacetCall(
            abi.encodeCall(VaultFactoryFacet.vaultDeliverERC20From, (payer, payer, asset, amount, loanId)),
            VaultDepositFailed.selector
        );
        LibEncumbrance.encumberParkedLeg(payer, asset, amount);
        _park(s, loanId, payer, asset, LibVaipakam.AssetType.ERC20, 0, amount, false);
        return true;
    }

    // ─── In-kind default ───────────────────────────────────────────────

    /**
     * @notice The in-kind default's collateral move: the whole collateral
     *         from the borrower's vault into the stored lender's vault, or,
     *         when the token refuses the move, left in the borrower's vault
     *         under the loan's collateral lien for the lender side.
     * @return parked  Whether the collateral was left in place.
     * @return arrived For ERC-20 collateral moved, what reached the lender's
     *                 vault; otherwise the recorded collateral figure.
     */
    function moveInKindCollateralOrPark(uint256 loanId) external returns (bool parked, uint256 arrived) {
        _onlySelf();
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        LibVaipakam.Loan storage loan = s.loans[loanId];
        (bool ok, bytes memory ret) = _attempt(abi.encodeCall(this.inKindMove, (loanId)));
        if (ok) return (false, abi.decode(ret, (uint256)));

        uint256 amount = loan.collateralAssetType == LibVaipakam.AssetType.ERC1155
            ? loan.collateralQuantity
            : (loan.collateralAssetType == LibVaipakam.AssetType.ERC721 ? 1 : loan.collateralAmount);
        if (!_vaultHolds(s.userVaipakamVaults[loan.borrower], loan)) {
            LibRevert.bubbleOnFailureTyped(false, ret, LiquidationFailed.selector);
        }
        // The attempt reverted whole, so the collateral lien is still in place:
        // it is the lien the lender side's release lifts.
        _park(s, loanId, loan.borrower, loan.collateralAsset, loan.collateralAssetType, loan.collateralTokenId, amount, true);
        return (true, loan.collateralAmount);
    }

    /// @notice The in-kind move itself, run as the attempt above. Self-only.
    /// @return arrived What reached the lender's vault (ERC-20), else the
    ///         recorded collateral amount.
    function inKindMove(uint256 loanId) external returns (uint256 arrived) {
        _onlySelf();
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        LibVaipakam.Loan storage loan = s.loans[loanId];
        // The whole collateral moves, so the lien goes first (it would
        // otherwise block the vault withdrawal).
        LibEncumbrance.releaseCollateralLien(loanId);
        arrived = _moveToStoredLender(
            s, loan, loanId, loan.borrower, loan.collateralAsset, loan.collateralAssetType,
            loan.collateralTokenId,
            loan.collateralAssetType == LibVaipakam.AssetType.ERC1155 ? loan.collateralQuantity : loan.collateralAmount,
            OutflowReason.DEFAULT_TRANSFER
        );
        if (loan.collateralAssetType != LibVaipakam.AssetType.ERC20) arrived = loan.collateralAmount;
    }

    // ─── Release ───────────────────────────────────────────────────────

    /**
     * @notice Move `loanId`'s parked lender-side leg out of the payer's vault
     *         into the stored lender's vault, where the lender claim pays it
     *         as any other. No-op when nothing is parked. Called first by the
     *         lender side's claim paths; reverts with the token's own error
     *         while the token still refuses, leaving the row in place.
     */
    function releaseParkedLeg(uint256 loanId) external {
        _onlySelf();
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        LibVaipakam.ParkedLeg memory p = s.parkedLenderLeg[loanId];
        if (p.payer == address(0)) return;
        delete s.parkedLenderLeg[loanId];
        LibVaipakam.Loan storage loan = s.loans[loanId];

        if (p.collateralLien) LibEncumbrance.releaseCollateralLien(loanId);
        else LibEncumbrance.releaseParkedLeg(p.payer, p.asset, p.amount);

        uint256 arrived = _moveToStoredLender(
            s, loan, loanId, p.payer, p.asset, p.assetType, p.tokenId, p.amount,
            p.collateralLien ? OutflowReason.DEFAULT_TRANSFER : OutflowReason.REPAYMENT
        );
        if (p.assetType == LibVaipakam.AssetType.ERC20) {
            // The claim pays what reached the lender's vault.
            s.lenderClaims[loanId].amount = arrived;
            // VPFI has a user-facing exit from the vault: reserve the proceeds
            // until the holder claims, as a delivered leg is (#592).
            if (p.asset == s.vpfiToken) {
                LibEncumbrance.encumberLenderProceeds(loanId, loan.lender, p.asset, arrived);
            }
        }
        emit SettlementLegReleased(loanId, p.payer, arrived);
    }

    // ─── Reads ─────────────────────────────────────────────────────────

    /// @notice The leg parked for `loanId`'s lender side; a zero `payer`
    ///         means none.
    function getParkedLenderLeg(uint256 loanId) external view returns (LibVaipakam.ParkedLeg memory) {
        return LibVaipakam.storageSlot().parkedLenderLeg[loanId];
    }

    // ─── Internals ─────────────────────────────────────────────────────

    function _onlySelf() private view {
        if (msg.sender != address(this)) revert UnauthorizedCrossFacetCall();
    }

    /// @dev One attempt with exactly {ATTEMPT_GAS}, made only when that much
    ///      can reach it.
    function _attempt(bytes memory data) private returns (bool ok, bytes memory ret) {
        if (gasleft() < ATTEMPT_GAS + ATTEMPT_GAS / 63 + CALL_OVERHEAD_GAS) revert SettlementAttemptOutOfGas();
        (ok, ret) = address(this).call{gas: ATTEMPT_GAS}(data);
    }

    function _park(
        LibVaipakam.Storage storage s,
        uint256 loanId,
        address payer,
        address asset,
        LibVaipakam.AssetType assetType,
        uint256 tokenId,
        uint256 amount,
        bool collateralLien
    ) private {
        if (s.parkedLenderLeg[loanId].payer != address(0)) revert SettlementLegAlreadyParked(loanId);
        s.parkedLenderLeg[loanId] = LibVaipakam.ParkedLeg({
            payer: payer,
            asset: asset,
            assetType: assetType,
            collateralLien: collateralLien,
            tokenId: tokenId,
            amount: amount
        });
        emit SettlementLegParked(loanId, payer, asset, assetType, tokenId, amount);
    }

    /// @dev Whether `vault` holds the loan's whole collateral.
    function _vaultHolds(address vault, LibVaipakam.Loan storage loan) private view returns (bool) {
        if (vault == address(0)) return false;
        if (loan.collateralAssetType == LibVaipakam.AssetType.ERC20) {
            return IERC20(loan.collateralAsset).balanceOf(vault) >= loan.collateralAmount;
        }
        if (loan.collateralAssetType == LibVaipakam.AssetType.ERC721) {
            try IERC721(loan.collateralAsset).ownerOf(loan.collateralTokenId) returns (address o) {
                return o == vault;
            } catch {
                return false;
            }
        }
        return IERC1155(loan.collateralAsset).balanceOf(vault, loan.collateralTokenId) >= loan.collateralQuantity;
    }

    /// @dev Returns what arrived (ERC-20), else `amount`.
    /// @dev Move `amount` of a leg from `from`'s vault into the vault of the
    ///      loan's stored lender (the `ClaimCustody` class, where a settlement
    ///      parks the lender side's share until its claim pays the holder).
    ///      Resolves the lender's vault behind the receive-side exemption and
    ///      the payer's behind the move-out exemption (#821), so a flagged
    ///      party never blocks the move.
    function _moveToStoredLender(
        LibVaipakam.Storage storage s,
        LibVaipakam.Loan storage loan,
        uint256 loanId,
        address from,
        address asset,
        LibVaipakam.AssetType assetType,
        uint256 tokenId,
        uint256 amount,
        uint8 reason
    ) private returns (uint256 arrived) {
        arrived = amount;
        LibSanctionedLock.getOrCreateVaultLocked(s, loan.lender, loanId, asset, amount);
        LibSanctionedLock.beginMoveOut(s, from);
        if (assetType == LibVaipakam.AssetType.ERC20) {
            arrived = LibVaultOutflow.toClaimCustody(
                from, LibVaultOutflow.ERC20, asset, 0, amount, loanId, loan.lenderTokenId, reason
            );
        } else if (assetType == LibVaipakam.AssetType.ERC721) {
            LibVaultOutflow.toClaimCustody(
                from, LibVaultOutflow.ERC721, asset, tokenId, 1, loanId, loan.lenderTokenId, reason
            );
        } else {
            LibVaultOutflow.toClaimCustody(
                from, LibVaultOutflow.ERC1155, asset, tokenId, amount, loanId, loan.lenderTokenId, reason
            );
        }
        LibSanctionedLock.endMoveOut(s);
    }
}
