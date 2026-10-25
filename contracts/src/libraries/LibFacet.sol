// src/libraries/LibFacet.sol
// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {LibVaipakam} from "./LibVaipakam.sol";
import {LibRevert} from "./LibRevert.sol";
import {LibDelivery} from "./LibDelivery.sol";
import {IVaipakamErrors} from "../interfaces/IVaipakamErrors.sol";
import {VaultFactoryFacet} from "../facets/VaultFactoryFacet.sol";
import {LibNumeraireValueRead} from "./LibNumeraireValueRead.sol";
import {ITreasuryFeeHost} from "../interfaces/ITreasuryFeeHost.sol";

/// @title LibFacet
/// @notice Shared facet-level helpers previously duplicated across
///         PrecloseFacet and EarlyWithdrawalFacet. Consolidating them here
///         reduces bytecode and keeps treasury / vault / cross-facet-call
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

    /// @dev Moves `amount` of `asset` the Diamond holds (a treasury share of
    ///      proceeds) to the configured treasury and records the accrual of
    ///      what ARRIVED. Uses {recordTreasuryAccrual} so `treasuryBalances`
    ///      only grows when the funds stay at the Diamond (i.e.
    ///      `s.treasury == address(this)`). When treasury is external, the
    ///      tokens physically leave the Diamond and no IOU should remain.
    ///      No-op on zero.
    ///
    ///      #2440 — hosted on TreasuryFeeFacet (`collectFeeFromDiamond`),
    ///      which measures the push and refuses one that cost the Diamond more
    ///      than `amount`. Every Diamond-held treasury share goes through here;
    ///      a hand-written `safeTransfer(treasury, x)` + accrual of `x` books a
    ///      fee that may not have arrived. Where the Diamond is the treasury
    ///      the host moves nothing and accrues all of `amount` (#2623).
    /// @return accrued What the treasury received and was credited with.
    function transferToTreasury(address asset, uint256 amount) internal returns (uint256 accrued) {
        if (amount == 0) return 0;
        return abi.decode(
            crossFacetCallReturn(
                abi.encodeWithSelector(
                    ITreasuryFeeHost.collectFeeFromDiamond.selector,
                    asset,
                    amount
                ),
                IVaipakamErrors.TreasuryTransferFailed.selector
            ),
            (uint256)
        );
    }

    /// @dev Canonical treasury-accrual sink. Use at every fee site — whether
    ///      the caller pushes via `safeTransfer(treasury, x)`,
    ///      `safeTransferFrom(payer, treasury, x)`, or routes through an
    ///      vault's `vaultWithdrawERC20(..., treasury, x)`. This keeps the
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
        // AnalyticalGettersDesign §3.2 / D5 — per-asset day-bucket
        // running total. dayIndex resets every UTC midnight; the
        // ring-buffer mapping is unbounded but only the last
        // {1..365} entries per asset are read by `getRevenueStats`.
        s.treasuryAccrualByDay[asset][block.timestamp / 1 days] += amount;
        accrueTreasuryFee(asset, amount);
    }

    /// @dev Records a timestamped, numeraire-priced fee accrual against the
    ///      analytics log only. Internal to {recordTreasuryAccrual} and
    ///      {transferToTreasury}; callers that need the full "move + record"
    ///      behaviour should use one of those instead. The value is the
    ///      shared rule's (#2419), 1e18-scaled and rounded down, read
    ///      best-effort: when the rule cannot value the asset (no or
    ///      untrusted price, unreadable decimals) the event is logged with
    ///      `numeraireValue == 0`, but the asset-denominated fee is still
    ///      captured in `treasuryBalances[asset]` when treasury is the
    ///      Diamond. The log is analytics and never blocks the settlement it
    ///      records: an event value above the field's width is stored at the
    ///      field's maximum, and the cumulative total stops at the uint256
    ///      maximum instead of overflowing. No-op on zero amount.
    function accrueTreasuryFee(address asset, uint256 amount) private {
        if (amount == 0) return;
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        uint256 numeraireValue = LibNumeraireValueRead.valueOrZero(asset, amount);
        // casting to 'uint192' is safe because the comparison takes every
        // value that does not fit
        // forge-lint: disable-next-line(unsafe-typecast)
        uint192 logged = numeraireValue > type(uint192).max ? type(uint192).max : uint192(numeraireValue);
        s.feeLedger.push(
            LibVaipakam.FeeEvent({
                timestamp: uint64(block.timestamp),
                numeraireValue: logged
            })
        );
        uint256 cumulative = s.feeLedgerTotal;
        s.feeLedgerTotal = numeraireValue > type(uint256).max - cumulative
            ? type(uint256).max
            : cumulative + numeraireValue;
    }

    /// @dev Resolves (and lazily deploys) the per-user vault proxy.
    ///      Wraps the diamond's own `getOrCreateUserVault` selector so
    ///      failure data is bubbled via LibRevert.
    function getOrCreateVault(address user) internal returns (address) {
        (bool success, bytes memory data) = address(this).call(
            abi.encodeWithSelector(
                VaultFactoryFacet.getOrCreateUserVault.selector,
                user
            )
        );
        LibRevert.bubbleOnFailureTyped(
            success,
            data,
            IVaipakamErrors.VaultResolutionFailed.selector
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

    /// @dev #2440 — `VaultFactoryFacet.vaultWithdrawERC20` with its measured
    ///      delivery decoded: returns what `recipient` received, never more
    ///      than `amount`. For a caller that books the arrival; a payout to a
    ///      wallet books nothing and keeps the plain {crossFacetCall}.
    function vaultWithdrawDelivered(
        address user,
        address token,
        address recipient,
        uint256 amount,
        bytes4 fallbackSelector
    ) internal returns (uint256) {
        return abi.decode(
            crossFacetCallReturn(
                abi.encodeWithSelector(
                    VaultFactoryFacet.vaultWithdrawERC20.selector,
                    user,
                    token,
                    recipient,
                    amount
                ),
                fallbackSelector
            ),
            (uint256)
        );
    }

    /// @dev #2440 — outcome 1 of {LibDelivery} (a VOLUNTARY flow): the vault
    ///      withdraw, refused unless `recipient` received all of `amount`.
    function vaultWithdrawExact(
        address user,
        address token,
        address recipient,
        uint256 amount,
        bytes4 fallbackSelector
    ) internal {
        LibDelivery.requireFull(
            token,
            amount,
            vaultWithdrawDelivered(user, token, recipient, amount, fallbackSelector)
        );
    }

    /// @dev Deposits `amount` of `asset` into the new lender's vault and
    ///      records it in `heldForLender`. No-op on zero.
    function depositForNewLender(
        address asset,
        address newLender,
        uint256 amount,
        uint256 loanId
    ) internal {
        if (amount == 0) return;
        address vault = getOrCreateVault(newLender);
        // #2440 — outcome 1 of {LibDelivery}: this funds the new lender's held
        // claim inside a voluntary sale, so it is refused unless the vault
        // received all of `amount`, and the claim names `amount`.
        LibDelivery.pushExact(asset, vault, amount);
        LibVaipakam.storageSlot().heldForLender[loanId] += amount;
        // #597 Codex #672 P2 — tick the protocol-tracked vault balance, like the
        // sibling `depositFromPayerForLender` (via `vaultDepositERC20From`) does.
        // Without this the held-for-lender claim (`ClaimFacet` withdraws the FULL
        // `heldForLender` via `vaultWithdrawERC20` → `recordVaultWithdraw`, which
        // decrements tracked) would underflow on this Diamond-resident deposit,
        // AND the #597 VPFI reservation of the full held would subtract an
        // untracked amount from the lender's free balance (over-locking unrelated
        // stake). Callers: the option-1 shortfall of both sale routes
        // (`sellLoanViaBuyOffer` and the listed sale's completion).
        LibVaipakam.recordVaultDeposit(newLender, asset, amount);
    }

    /// @dev T-037 — `safeTransferFrom`-based variant of
    ///      {transferToTreasury}: pulls `amount` directly from `payer` to
    ///      the configured treasury, skipping the Diamond as an
    ///      atomic-transit intermediary. Requires `payer` to have
    ///      previously approved the Diamond to spend `amount` of `asset`.
    ///      Records the accrual via {recordTreasuryAccrual} the same way
    ///      the Diamond-resident variant does, so `treasuryBalances` stays
    ///      self-consistent on Diamond-as-treasury deployments. No-op on
    ///      zero. The pull and the accrual run in
    ///      `TreasuryFeeFacet.collectFeeFromPayer` (#2440).
    function transferFromPayerToTreasury(
        address payer,
        address asset,
        uint256 amount
    ) internal {
        if (amount == 0) return;
        // #1281-011 / #2440 — hosted on TreasuryFeeFacet, which refuses the pull
        // unless the treasury received all of it, so the accrual never records
        // a fee that did not arrive. `payer` approved the Diamond for this
        // move upstream (every caller is a Diamond facet that gated it, e.g.
        // repayLoan / precloseDirect), and the recipient is the admin-set
        // treasury.
        crossFacetCall(
            abi.encodeWithSelector(
                ITreasuryFeeHost.collectFeeFromPayer.selector,
                payer,
                asset,
                amount
            ),
            IVaipakamErrors.TreasuryTransferFailed.selector
        );
    }

    /// @dev #2440 — draw a fee from `user`'s vault into the treasury and
    ///      accrue what the treasury received, which is returned. Hosted on
    ///      `TreasuryFeeFacet.collectFeeFromVault`; never refuses a short
    ///      delivery (the treasury bears a token's own transfer charge, since
    ///      no party is booked as paid by this leg). Returns 0 without a call
    ///      when `amount` is zero.
    function vaultFeeToTreasury(
        address user,
        address asset,
        uint256 amount
    ) internal returns (uint256) {
        if (amount == 0) return 0;
        return abi.decode(
            crossFacetCallReturn(
                abi.encodeWithSelector(
                    ITreasuryFeeHost.collectFeeFromVault.selector,
                    user,
                    asset,
                    amount
                ),
                IVaipakamErrors.TreasuryTransferFailed.selector
            ),
            (uint256)
        );
    }

    /// @dev T-037 — `safeTransferFrom`-based variant of
    ///      {depositForNewLender}: pulls `amount` directly from `payer`
    ///      into the new lender's vault, skipping the Diamond. Same
    ///      `heldForLender` accounting as the Diamond-resident variant.
    ///      No-op on zero.
    ///
    ///      Routed through the cross-payer chokepoint so the
    ///      protocolTrackedVaultBalance counter ticks under
    ///      `newLender` (the vault owner). Replaces the prior direct
    ///      `safeTransferFrom`.
    function depositFromPayerForLender(
        address asset,
        address payer,
        address newLender,
        uint256 amount,
        uint256 loanId
    ) internal {
        if (amount == 0) return;
        crossFacetCall(
            abi.encodeWithSelector(
                VaultFactoryFacet.vaultDepositERC20From.selector,
                payer,
                newLender,
                asset,
                amount
            ),
            IVaipakamErrors.VaultDepositFailed.selector
        );
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
