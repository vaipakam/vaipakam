// src/facets/TreasuryFacet.sol
// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {LibVaipakam} from "../libraries/LibVaipakam.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {DiamondReentrancyGuard} from "../libraries/LibReentrancyGuard.sol";
import {DiamondPausable} from "../libraries/LibPausable.sol";
import {LibAccessControl, DiamondAccessControl} from "../libraries/LibAccessControl.sol";
import {IVaipakamErrors} from "../interfaces/IVaipakamErrors.sol";
import {IVPFIToken} from "../interfaces/IVPFIToken.sol";
import {LibSwap} from "../libraries/LibSwap.sol";
import {OracleFacet} from "./OracleFacet.sol";

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
    /// @custom:event-category state-change/treasury-mutation
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
    /// @custom:event-category state-change/escrow-mutation
    event VPFIMinted(address indexed to, uint256 amount);

    /// @notice Emitted on a successful `convertTreasuryToTargetMix`.
    /// @param tokenIn The input asset whose treasury balance was converted.
    /// @param amountIn The full input balance consumed.
    /// @param toEth Input amount routed to the WETH leg.
    /// @param toWbtc Input amount routed to the wrapped-BTC leg (0 if unset).
    /// @param toVpfi Input amount routed to the VPFI leg (absorbs rounding).
    /// @custom:event-category state-change/treasury-mutation
    event TreasuryConverted(
        address indexed tokenIn,
        uint256 amountIn,
        uint256 toEth,
        uint256 toWbtc,
        uint256 toVpfi
    );

    // Facet-specific errors (InvalidAddress, NotCanonicalVPFIChain inherited
    // from IVaipakamErrors).
    error ZeroAmount();
    error VPFITokenNotRegistered();
    /// @notice `convertTreasuryToTargetMix` requires Diamond-as-treasury
    ///         mode (`s.treasury == address(this)`) — only then does
    ///         `treasuryBalances` track convertible funds.
    error TreasuryNotDiamond();
    /// @notice The conversion eligibility gate (USD-value OR max-interval)
    ///         has not been met yet.
    error ConversionNotEligible();
    /// @notice A required convert-target address (WETH or VPFI) is unset.
    error TreasuryConvertTargetUnset();
    /// @notice A conversion leg's swap soft-failed across every adapter.
    error TreasuryConvertSwapFailed(address tokenOut);

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

    /**
     * @notice Convert one accumulated treasury asset into the governance
     *         target mix (WETH / wrapped-BTC / VPFI).
     * @dev T-600. Legal-safe path: protocol-internal asset management —
     *      every output stays inside the Diamond (`recipient =
     *      address(this)`), credited back into `treasuryBalances`. There
     *      is NO insider beneficiary and NO per-tx auto-route; subsequent
     *      distribution (buyback / staker boost / budget) is a separate
     *      governance action.
     *
     *      Requires Diamond-as-treasury mode — `treasuryBalances` only
     *      tracks convertible funds when `s.treasury == address(this)`.
     *
     *      One `tokenIn` per call (a keeper loops off-chain): each call
     *      is atomic and independently auditable. Each leg routes through
     *      `LibSwap.swapWithFailover` — the same ranked-adapter try-list
     *      machinery `RiskFacet.triggerLiquidation` uses — with the
     *      sentinel `loanId = 0` (loan ids are 1-based) marking a
     *      treasury conversion in the swap-event stream. The VPFI leg
     *      absorbs integer-division rounding (treasury-favouring).
     *
     *      A leg whose target equals `tokenIn` is credited straight back
     *      (no self-swap). The wrapped-BTC leg is skipped — its share
     *      folding into the VPFI remainder — when `treasuryWbtcAsset`
     *      is unset.
     *
     * @param tokenIn The treasury asset to convert (non-zero, non-empty balance).
     * @param ethCalls Ranked adapter try-list for the tokenIn → WETH leg.
     * @param wbtcCalls Ranked adapter try-list for the tokenIn → wBTC leg.
     * @param vpfiCalls Ranked adapter try-list for the tokenIn → VPFI leg.
     * @param minOutEth Slippage floor for the WETH leg.
     * @param minOutWbtc Slippage floor for the wBTC leg.
     * @param minOutVpfi Slippage floor for the VPFI leg.
     */
    function convertTreasuryToTargetMix(
        address tokenIn,
        LibSwap.AdapterCall[] calldata ethCalls,
        LibSwap.AdapterCall[] calldata wbtcCalls,
        LibSwap.AdapterCall[] calldata vpfiCalls,
        uint256 minOutEth,
        uint256 minOutWbtc,
        uint256 minOutVpfi
    ) external nonReentrant whenNotPaused onlyRole(LibAccessControl.ADMIN_ROLE) {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();

        // Diamond-as-treasury precondition.
        if (s.treasury != address(this)) revert TreasuryNotDiamond();
        if (tokenIn == address(0)) revert InvalidAddress();

        uint256 balance = s.treasuryBalances[tokenIn];
        if (balance == 0) revert ZeroAmount();

        // Eligibility: USD-value OR max-interval, whichever first.
        if (!_eligibleForConversion(tokenIn, balance)) {
            revert ConversionNotEligible();
        }

        address weth = s.wethContract;
        address wbtc = s.treasuryWbtcAsset; // may be address(0) → leg skipped
        address vpfi = s.vpfiToken;
        if (weth == address(0) || vpfi == address(0)) {
            revert TreasuryConvertTargetUnset();
        }

        // Target split. VPFI is the remainder, so it absorbs both
        // integer-division rounding and a skipped (unset) wBTC leg.
        uint256 toEth = (balance * LibVaipakam.cfgTreasuryConvertEthBps())
            / LibVaipakam.BASIS_POINTS;
        uint256 toWbtc = wbtc == address(0)
            ? 0
            : (balance * LibVaipakam.cfgTreasuryConvertWbtcBps())
                / LibVaipakam.BASIS_POINTS;
        uint256 toVpfi = balance - toEth - toWbtc;

        // CEI — zero the input balance and stamp the conversion time
        // before any external swap call.
        s.treasuryBalances[tokenIn] = 0;
        s.treasuryLastConversionAt = uint64(block.timestamp);

        _convertLeg(tokenIn, weth, toEth, minOutEth, ethCalls, s);
        if (wbtc != address(0)) {
            _convertLeg(tokenIn, wbtc, toWbtc, minOutWbtc, wbtcCalls, s);
        }
        _convertLeg(tokenIn, vpfi, toVpfi, minOutVpfi, vpfiCalls, s);

        emit TreasuryConverted(tokenIn, balance, toEth, toWbtc, toVpfi);
    }

    /// @dev Settle one conversion leg. `tokenIn == tokenOut` short-circuits
    ///      (the slice already IS the target — credit it straight back, no
    ///      self-swap). Otherwise routes through `LibSwap.swapWithFailover`;
    ///      a soft-failure across every adapter reverts the WHOLE call so
    ///      the zeroed input balance is rolled back — funds are never lost.
    function _convertLeg(
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint256 minOut,
        LibSwap.AdapterCall[] calldata calls,
        LibVaipakam.Storage storage s
    ) private {
        if (amountIn == 0) return;
        if (tokenIn == tokenOut) {
            s.treasuryBalances[tokenOut] += amountIn;
            return;
        }
        (bool ok, uint256 outAmount, ) = LibSwap.swapWithFailover(
            0, // loanId sentinel — 0 marks a treasury conversion
            tokenIn,
            tokenOut,
            amountIn,
            minOut,
            address(this),
            calls
        );
        if (!ok) revert TreasuryConvertSwapFailed(tokenOut);
        s.treasuryBalances[tokenOut] += outAmount;
    }

    /// @dev Conversion eligibility — true when EITHER the time since the
    ///      last conversion has exceeded the configured max interval, OR
    ///      the input balance's numeraire value clears the configured
    ///      threshold. The numeraire leg is best-effort: an oracle that
    ///      reverts / has no feed leaves only the time leg in force
    ///      (mirrors `LibFacet.accrueTreasuryFee`'s best-effort pricing).
    function _eligibleForConversion(address tokenIn, uint256 balance)
        private
        view
        returns (bool)
    {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        uint256 maxInterval =
            LibVaipakam.cfgTreasuryConvertMaxIntervalDays() * 1 days;
        // Never-converted (`treasuryLastConversionAt == 0`) ⇒ the time
        // leg is trivially satisfied — the first conversion is allowed.
        if (block.timestamp - s.treasuryLastConversionAt >= maxInterval) {
            return true;
        }
        (bool ok, uint256 price, uint8 feedDec) =
            OracleFacet(address(this)).tryGetAssetPrice(tokenIn);
        if (!ok || price == 0) return false;
        uint8 tokenDec = IERC20Metadata(tokenIn).decimals();
        uint256 numeraireValue =
            (balance * price * 1e18) / (10 ** feedDec) / (10 ** tokenDec);
        return numeraireValue >= LibVaipakam.cfgTreasuryConvertUsdThreshold();
    }
}
