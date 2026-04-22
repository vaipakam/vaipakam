// src/facets/TreasuryFacet.sol
// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {LibVaipakam} from "../libraries/LibVaipakam.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {DiamondReentrancyGuard} from "../libraries/LibReentrancyGuard.sol";
import {DiamondPausable} from "../libraries/LibPausable.sol";
import {LibAccessControl, DiamondAccessControl} from "../libraries/LibAccessControl.sol";
import {IVaipakamErrors} from "../interfaces/IVaipakamErrors.sol";
import {IVPFIToken} from "../interfaces/IVPFIToken.sol";

/**
 * @title TreasuryFacet
 * @author Vaipakam Developer Team
 * @notice This facet manages treasury fee accumulation and claims for the Vaipakam platform.
 * @dev Part of Diamond Standard (EIP-2535). Uses shared LibVaipakam storage for balances.
 *      Fees (TREASURY_FEE_BPS = 1% of interest + late fees) accumulate in the
 *      diamond proxy at settlement time. LibSettlement is the single source
 *      of truth for the fee split across all settlement paths (repay,
 *      preclose, refinance, partial withdraw).
 *      ADMIN_ROLE-gated claim to a specified address (multi-sig in production).
 *      Supports ERC-20 assets; custom errors, events, ReentrancyGuard, pausable.
 *      Expand for Phase 2 (governance distributions, reserves).
 */
contract TreasuryFacet is DiamondReentrancyGuard, DiamondPausable, DiamondAccessControl, IVaipakamErrors {
    using SafeERC20 for IERC20;

    /// @notice Emitted when treasury fees are claimed.
    /// @param asset The ERC-20 asset claimed.
    /// @param amount The claimed amount.
    /// @param claimant The address receiving the claim (specified by owner).
    event TreasuryFeesClaimed(
        address indexed asset,
        uint256 amount,
        address indexed claimant
    );

    /// @notice Emitted when VPFI is minted through the treasury's admin
    ///         mint path. Mirrors (but does not replace) the token's own
    ///         Minted event — this one captures that the mint originated
    ///         from the Diamond's ADMIN_ROLE flow for governance audit.
    /// @param to     Recipient of the freshly-minted VPFI.
    /// @param amount Amount minted (18 decimals).
    event VPFIMinted(address indexed to, uint256 amount);

    // Facet-specific errors (InvalidAddress, NotCanonicalVPFIChain inherited
    // from IVaipakamErrors).
    error ZeroAmount();
    error VPFITokenNotRegistered();

    /**
     * @notice Claims accumulated treasury fees for an asset.
     * @dev ADMIN_ROLE-only. Sweeps the full accumulated balance for `asset`
     *      to `claimant` (typically a multi-sig wallet). Zeroes
     *      `treasuryBalances[asset]` BEFORE the transfer (CEI pattern).
     *      Reverts InvalidAddress on zero claimant, ZeroAmount if no
     *      balance to claim. Emits TreasuryFeesClaimed.
     * @param asset The ERC-20 asset to sweep.
     * @param claimant The recipient of the swept balance (non-zero).
     */
    function claimTreasuryFees(
        address asset,
        address claimant
    ) external nonReentrant whenNotPaused onlyRole(LibAccessControl.ADMIN_ROLE) {
        if (claimant == address(0)) revert InvalidAddress();

        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        uint256 balance = s.treasuryBalances[asset];
        if (balance == 0) revert ZeroAmount();

        // Update balance before transfer (CEI pattern)
        s.treasuryBalances[asset] = 0;

        // Transfer to claimant
        IERC20(asset).safeTransfer(claimant, balance);

        emit TreasuryFeesClaimed(asset, balance, claimant);
    }

    /**
     * @notice View function to get treasury balance for an asset.
     * @dev Returns accumulated fees (from repayments, forfeitures, etc.).
     * @param asset The ERC-20 asset.
     * @return balance The treasury balance for the asset.
     */
    function getTreasuryBalance(
        address asset
    ) external view returns (uint256 balance) {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        return s.treasuryBalances[asset];
    }

    /**
     * @notice Mint VPFI to `to` through the registered token.
     * @dev Phase 1 tokenomics — see docs/TokenomicsTechSpec.md §2 and §8.
     *      Two off-chain prerequisites must be satisfied before this call
     *      succeeds:
     *        1. VPFITokenFacet.setVPFIToken(...) has registered the
     *           canonical VPFI proxy with the Diamond; otherwise reverts
     *           {VPFITokenNotRegistered}.
     *        2. The token's owner (timelock / multi-sig) has called
     *           `VPFIToken.setMinter(diamond)` so the Diamond is the
     *           authorized minter; otherwise the inner call reverts
     *           {IVPFIToken.NotMinter} and its data is bubbled up.
     *
     *      This function is the single minting primitive used by the
     *      Diamond. Allocation-table mints (founders' vesting wallets,
     *      audit payouts, bug-bounty funding, etc.) route through it
     *      under ADMIN_ROLE. Per-user reward claims (interaction rewards,
     *      scheduled in a later rollout phase) will call it cross-facet
     *      from ClaimFacet / RewardsFacet on the user's pull.
     *
     *      Cap enforcement is delegated to the token itself
     *      (ERC20CappedUpgradeable in VPFIToken) so the 230M invariant is
     *      preserved regardless of which Diamond code path mints.
     *
     * @param to     Recipient of the freshly-minted VPFI (non-zero).
     * @param amount VPFI amount in 18 decimals (non-zero).
     */
    function mintVPFI(
        address to,
        uint256 amount
    ) external nonReentrant whenNotPaused onlyRole(LibAccessControl.ADMIN_ROLE) {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();

        // Canonical-chain gate: only the Base (mainnet) / Base Sepolia
        // (testnet) Diamond can mint. On every other chain in the mesh
        // supply arrives exclusively via the LayerZero OFT V2 peer bridge
        // from the canonical adapter, so minting locally would break the
        // 230M global-cap invariant.
        if (!s.isCanonicalVPFIChain) revert NotCanonicalVPFIChain();

        if (to == address(0)) revert InvalidAddress();
        if (amount == 0) revert ZeroAmount();

        address token = s.vpfiToken;
        if (token == address(0)) revert VPFITokenNotRegistered();

        IVPFIToken(token).mint(to, amount);

        emit VPFIMinted(to, amount);
    }
}
