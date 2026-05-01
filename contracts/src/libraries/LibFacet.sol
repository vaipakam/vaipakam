// src/libraries/LibFacet.sol
// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {LibVaipakam} from "./LibVaipakam.sol";
import {LibRevert} from "./LibRevert.sol";
import {IVaipakamErrors} from "../interfaces/IVaipakamErrors.sol";
import {EscrowFactoryFacet} from "../facets/EscrowFactoryFacet.sol";
import {OracleFacet} from "../facets/OracleFacet.sol";

/// @title LibFacet
/// @notice Shared facet-level helpers previously duplicated across
///         PrecloseFacet and EarlyWithdrawalFacet. Consolidating them here
///         reduces bytecode and keeps treasury / escrow / cross-facet-call
///         behavior in lockstep between the two settlement paths.
library LibFacet {
    using SafeERC20 for IERC20;

    /// @dev Returns the current treasury address from shared storage.
    function getTreasury() internal view returns (address) {
        return LibVaipakam.storageSlot().treasury;
    }

    /// @dev Reserve-pause guard. Reverts AssetPaused(asset)
    ///      iff governance has paused this asset through
    ///      {AdminFacet.pauseAsset}. `address(0)` is treated as "no
    ///      asset on this leg" and is always allowed — call sites MUST
    ///      still pass the sentinel through so future invariant-checks
    ///      (e.g. requiring a non-zero address on liquid legs) can be
    ///      added in one place. Exit paths (repay / liquidate / claim /
    ///      withdraw) intentionally do not call this helper; only
    ///      creation paths do.
    function requireAssetNotPaused(address asset) internal view {
        if (asset == address(0)) return;
        if (LibVaipakam.storageSlot().assetPaused[asset]) {
            revert IVaipakamErrors.AssetPaused(asset);
        }
    }

    /// @dev Transfers `amount` of `asset` from the Diamond to the configured
    ///      treasury and records the accrual. Uses
    ///      {recordTreasuryAccrual} so `treasuryBalances` only grows when
    ///      the funds stay at the Diamond (i.e. `s.treasury == address(this)`).
    ///      When treasury is external, the tokens physically leave the
    ///      Diamond and no IOU should remain. No-op on zero.
    function transferToTreasury(address asset, uint256 amount) internal {
        if (amount == 0) return;
        IERC20(asset).safeTransfer(LibVaipakam.storageSlot().treasury, amount);
        recordTreasuryAccrual(asset, amount);
    }

    /// @dev Canonical treasury-accrual sink. Use at every fee site — whether
    ///      the caller pushes via `safeTransfer(treasury, x)`,
    ///      `safeTransferFrom(payer, treasury, x)`, or routes through an
    ///      escrow's `escrowWithdrawERC20(..., treasury, x)`. This keeps the
    ///      `treasuryBalances` invariant self-consistent with
    ///      `TreasuryFacet.claimTreasuryFees` (treasuryBalances = unclaimed
    ///      IOU held at the Diamond) and funnels the analytics log via
    ///      {accrueTreasuryFee} so MetricsFacet windows stay truthful.
    ///
    ///      Rule: `treasuryBalances[asset]` only increases when the
    ///      configured treasury is the Diamond itself. External-treasury
    ///      deployments leave nothing at the Diamond to sweep.
    ///      No-op on zero.
    function recordTreasuryAccrual(address asset, uint256 amount) internal {
        if (amount == 0) return;
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        if (s.treasury == address(this)) {
            s.treasuryBalances[asset] += amount;
        }
        accrueTreasuryFee(asset, amount);
    }

    /// @dev Records a timestamped, USD-priced fee accrual against the
    ///      analytics log only. Internal to {recordTreasuryAccrual} and
    ///      {transferToTreasury}; callers that need the full "move + record"
    ///      behaviour should use one of those instead. Pricing is
    ///      best-effort: when OracleFacet has no feed for the asset (e.g.
    ///      illiquid / stale), the event is logged with `usdValue == 0`,
    ///      but the asset-denominated fee is still captured in
    ///      `treasuryBalances[asset]` when treasury is the Diamond.
    ///      No-op on zero amount.
    function accrueTreasuryFee(address asset, uint256 amount) private {
        if (amount == 0) return;
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        uint256 usdValue = _priceForAccrual(asset, amount);
        s.feeEventsLog.push(
            LibVaipakam.FeeEvent({
                timestamp: uint64(block.timestamp),
                usdValue: uint192(usdValue)
            })
        );
        s.cumulativeFeesUSD += usdValue;
    }

    /// @dev Best-effort USD pricing for fee-accrual events. Returns 0 if the
    ///      oracle lookup reverts (e.g. asset lacks a Chainlink feed), so a
    ///      fee accrual never blocks a settlement path.
    function _priceForAccrual(
        address asset,
        uint256 amount
    ) private view returns (uint256) {
        if (asset == address(0) || amount == 0) return 0;
        (bool ok, bytes memory ret) = address(this).staticcall(
            abi.encodeWithSelector(OracleFacet.getAssetPrice.selector, asset)
        );
        if (!ok || ret.length < 64) return 0;
        (uint256 price, uint8 decimals) = abi.decode(ret, (uint256, uint8));
        return (amount * price) / (10 ** decimals);
    }

    /// @dev Resolves (and lazily deploys) the per-user escrow proxy.
    ///      Wraps the diamond's own `getOrCreateUserEscrow` selector so
    ///      failure data is bubbled via LibRevert.
    function getOrCreateEscrow(address user) internal returns (address) {
        (bool success, bytes memory data) = address(this).call(
            abi.encodeWithSelector(
                EscrowFactoryFacet.getOrCreateUserEscrow.selector,
                user
            )
        );
        LibRevert.bubbleOnFailureTyped(
            success,
            data,
            IVaipakamErrors.EscrowResolutionFailed.selector
        );
        return abi.decode(data, (address));
    }

    /// @dev Invokes another facet via the diamond's own address.  On
    ///      failure, re-raises the inner revert verbatim; otherwise falls
    ///      back to the caller-supplied typed error selector.
    function crossFacetCall(bytes memory data, bytes4 fallbackSelector) internal {
        (bool success, bytes memory ret) = address(this).call(data);
        LibRevert.bubbleOnFailureTyped(success, ret, fallbackSelector);
    }

    /// @dev Mutating variant of {crossFacetCall} that returns the raw
    ///      return-data buffer for the caller to ABI-decode.
    function crossFacetCallReturn(
        bytes memory data,
        bytes4 fallbackSelector
    ) internal returns (bytes memory) {
        (bool success, bytes memory ret) = address(this).call(data);
        LibRevert.bubbleOnFailureTyped(success, ret, fallbackSelector);
        return ret;
    }

    /// @dev Deposits `amount` of `asset` into the new lender's escrow and
    ///      records it in `heldForLender`. No-op on zero.
    function depositForNewLender(
        address asset,
        address newLender,
        uint256 amount,
        uint256 loanId
    ) internal {
        if (amount == 0) return;
        address escrow = getOrCreateEscrow(newLender);
        IERC20(asset).safeTransfer(escrow, amount);
        LibVaipakam.storageSlot().heldForLender[loanId] += amount;
    }

    /// @dev T-037 — `safeTransferFrom`-based variant of
    ///      {transferToTreasury}: pulls `amount` directly from `payer` to
    ///      the configured treasury, skipping the Diamond as an
    ///      atomic-transit intermediary. Requires `payer` to have
    ///      previously approved the Diamond to spend `amount` of `asset`.
    ///      Records the accrual via {recordTreasuryAccrual} the same way
    ///      the Diamond-resident variant does, so `treasuryBalances` stays
    ///      self-consistent on Diamond-as-treasury deployments. No-op on
    ///      zero.
    function transferFromPayerToTreasury(
        address payer,
        address asset,
        uint256 amount
    ) internal {
        if (amount == 0) return;
        IERC20(asset).safeTransferFrom(
            payer,
            LibVaipakam.storageSlot().treasury,
            amount
        );
        recordTreasuryAccrual(asset, amount);
    }

    /// @dev T-037 — `safeTransferFrom`-based variant of
    ///      {depositForNewLender}: pulls `amount` directly from `payer`
    ///      into the new lender's escrow, skipping the Diamond. Same
    ///      `heldForLender` accounting as the Diamond-resident variant.
    ///      No-op on zero.
    function depositFromPayerForLender(
        address asset,
        address payer,
        address newLender,
        uint256 amount,
        uint256 loanId
    ) internal {
        if (amount == 0) return;
        address escrow = getOrCreateEscrow(newLender);
        IERC20(asset).safeTransferFrom(payer, escrow, amount);
        LibVaipakam.storageSlot().heldForLender[loanId] += amount;
    }

    /// @dev Staticcall variant for read-only cross-facet reads (e.g. HF/LTV).
    function crossFacetStaticCall(
        bytes memory data,
        bytes4 fallbackSelector
    ) internal view returns (bytes memory) {
        (bool success, bytes memory ret) = address(this).staticcall(data);
        LibRevert.bubbleOnFailureTyped(success, ret, fallbackSelector);
        return ret;
    }
}
