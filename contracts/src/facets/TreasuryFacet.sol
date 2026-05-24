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
    /// @custom:event-category state-change/vault-mutation
    event VPFIMinted(address indexed to, uint256 amount);

    /// @notice Emitted on a successful `convertTreasuryAsset`.
    /// @param tokenIn The input asset whose treasury balance was converted.
    /// @param amountIn The full input balance consumed.
    /// @param targetCount The number of configured target legs the
    ///        input was split across. Per-leg amounts are recoverable
    ///        from the `treasuryBalances` deltas and the `LibSwap`
    ///        swap-event stream (keyed on the sentinel `loanId == 0`).
    /// @custom:event-category state-change/treasury-mutation
    event TreasuryConverted(
        address indexed tokenIn,
        uint256 amountIn,
        uint256 targetCount
    );

    // Facet-specific errors (InvalidAddress, NotCanonicalVPFIChain inherited
    // from IVaipakamErrors).
    error ZeroAmount();
    error VPFITokenNotRegistered();
    /// @notice `convertTreasuryAsset` requires Diamond-as-treasury
    ///         mode (`s.treasury == address(this)`) — only then does
    ///         `treasuryBalances` track convertible funds.
    error TreasuryNotDiamond();
    /// @notice The conversion eligibility gate (USD-value OR max-interval)
    ///         has not been met yet.
    error ConversionNotEligible();
    /// @notice No target allocation is configured — governance must call
    ///         `ConfigFacet.setTreasuryConvertTargets` first.
    error TreasuryConvertNoTargets();
    /// @notice The per-target `calls` / `minOuts` arrays do not match the
    ///         configured target count.
    error TreasuryConvertArityMismatch(uint256 provided, uint256 expected);
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
        // supply arrives exclusively via the Chainlink CCIP CCT (Cross-Chain Token) peer bridge
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
     * @notice Convert one accumulated treasury asset into the governance-
     *         configured target allocation.
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
     *      The target allocation is the fully governance-configurable
     *      `s.treasuryConvertTargets` list (`ConfigFacet.setTreasuryConvertTargets`)
     *      — an ordered set of `(asset, bps)` entries summing to 10000.
     *      The input balance is split pro-rata; the FINAL entry absorbs
     *      integer-division rounding. `perTargetCalls[i]` / `minOuts[i]`
     *      align with target `i`, so both arrays must have exactly the
     *      configured target count.
     *
     *      One `tokenIn` per call (a keeper loops off-chain): each call
     *      is atomic and independently auditable. Each leg routes through
     *      `LibSwap.swapWithFailover` — the same ranked-adapter try-list
     *      machinery `RiskFacet.triggerLiquidation` uses — with the
     *      sentinel `loanId = 0` (loan ids are 1-based) marking a
     *      treasury conversion in the swap-event stream. A leg whose
     *      target equals `tokenIn` is credited straight back (no
     *      self-swap).
     *
     * @param tokenIn The treasury asset to convert (non-zero, non-empty balance).
     * @param perTargetCalls Ranked adapter try-list per configured target.
     * @param minOuts Slippage floor per configured target.
     */
    function convertTreasuryAsset(
        address tokenIn,
        LibSwap.AdapterCall[][] calldata perTargetCalls,
        uint256[] calldata minOuts
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

        uint256 n = s.treasuryConvertTargets.length;
        if (n == 0) revert TreasuryConvertNoTargets();
        if (perTargetCalls.length != n) {
            revert TreasuryConvertArityMismatch(perTargetCalls.length, n);
        }
        if (minOuts.length != n) {
            revert TreasuryConvertArityMismatch(minOuts.length, n);
        }

        // CEI — zero the input balance and stamp the conversion time
        // before any external swap call.
        s.treasuryBalances[tokenIn] = 0;
        s.treasuryLastConversionAt = uint64(block.timestamp);

        // Split pro-rata; the final target absorbs the rounding dust so
        // the legs always sum back to exactly `balance`.
        uint256 allocated;
        for (uint256 i = 0; i < n; ++i) {
            LibVaipakam.TreasuryConvertTarget storage t = s.treasuryConvertTargets[i];
            uint256 amount = (i == n - 1)
                ? balance - allocated
                : (balance * t.bps) / LibVaipakam.BASIS_POINTS;
            allocated += amount;
            _convertLeg(tokenIn, t.asset, amount, minOuts[i], perTargetCalls[i], s);
        }

        emit TreasuryConverted(tokenIn, balance, n);
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
