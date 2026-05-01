// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {LibVaipakam} from "./LibVaipakam.sol";
import {OracleFacet} from "../facets/OracleFacet.sol";
import {EscrowFactoryFacet} from "../facets/EscrowFactoryFacet.sol";
import {AggregatorV3Interface} from "@chainlink/contracts/src/v0.8/shared/interfaces/AggregatorV3Interface.sol";

/**
 * @title LibNotificationFee
 * @notice T-032 — pricing + collection helpers for the per-loan-side
 *         notification fee. Charged in VPFI from the user's escrow
 *         on the FIRST PaidPush-tier notification fired by the
 *         off-chain hf-watcher Worker. Routed directly to treasury
 *         in a single transfer (no Diamond custody) via the existing
 *         {EscrowFactoryFacet.escrowWithdrawERC20} privileged path.
 *
 * @dev Library, delegatecalled from `LoanFacet.markNotifBilled` (the
 *      `NOTIF_BILLER_ROLE`-gated external entry). `address(this)`
 *      resolves to the Diamond inside any function below.
 *
 *      Pricing model:
 *        Phase 1 (default): ETH/USD oracle × fixed VPFI/ETH rate
 *          (`VPFI_PER_ETH_FIXED_PHASE1 = 1e15`, i.e. 1 VPFI = 0.001 ETH).
 *          Both VPFI and ETH are 18-decimal so the rate is unitless.
 *        Phase 2 / governance: when `s.notificationFeeUsdOracle` is
 *          set non-zero, that AggregatorV3Interface is consulted as
 *          a direct VPFI/USD (or VPFI/<denomination>) feed and the
 *          fixed-rate fallback is skipped.
 *
 *      No Diamond custody window — the VPFI moves user-escrow →
 *      treasury in one privileged escrow call. The Diamond never
 *      touches the asset, so the `notification fee` flow doesn't
 *      contribute to any "in-flight" Diamond balance state.
 */
library LibNotificationFee {
    /// @notice Emitted when a loan-side's first notification triggers
    ///         a successful bill. Indexes the loan + side + payer for
    ///         off-chain reconciliation against the watcher's
    ///         per-notification audit log.
    event NotificationFeeBilled(
        uint256 indexed loanId,
        bool indexed isLenderSide,
        address indexed payer,
        uint256 vpfiAmount,
        uint256 feeUsd1e18
    );

    error NotifFeeWethNotSet();
    error NotifFeeOracleStale();
    error NotifFeeOraclePriceZero();
    error NotifFeeVpfiTokenNotSet();
    error NotifFeeTreasuryNotSet();

    /// @notice Computes the VPFI amount (18-dec, raw) equivalent to
    ///         `cfgNotificationFeeUsd()` at the current price feeds.
    /// @dev    Two pricing paths:
    ///           - Plugged oracle (`s.notificationFeeUsdOracle != 0`):
    ///             interpreted as a direct VPFI/<denomination> feed.
    ///             Used in Phase 2 / when governance swaps the
    ///             reference asset (USD → EUR / JPY etc.).
    ///           - Phase 1 fallback: ETH/USD via OracleFacet
    ///             (which delegates to Chainlink) × the fixed rate
    ///             `VPFI_PER_ETH_FIXED_PHASE1 = 1e15`.
    ///         Reverts on stale / zero / unconfigured oracle so a
    ///         broken price source fails the bill rather than charging
    ///         a wildly wrong amount.
    function vpfiAmountForUsdFee() internal view returns (uint256) {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        uint256 feeUsd1e18 = LibVaipakam.cfgNotificationFeeUsd();

        // Phase 2 / governance path — direct VPFI/<denomination> feed.
        address pluggedOracle = s.protocolCfg.notificationFeeUsdOracle;
        if (pluggedOracle != address(0)) {
            AggregatorV3Interface feed = AggregatorV3Interface(pluggedOracle);
            (, int256 answer, , uint256 updatedAt, ) = feed.latestRoundData();
            if (updatedAt == 0) revert NotifFeeOracleStale();
            if (answer <= 0) revert NotifFeeOraclePriceZero();
            uint8 dec = feed.decimals();
            uint256 vpfiPriceUsd = uint256(answer);
            // vpfiAmount (1e18, since VPFI is 18-dec) =
            //   feeUsd1e18 × 10^dec / vpfiPriceUsd
            // Both `feeUsd1e18` and the implicit-1e18 result share
            // the same scaling; `10^dec` cancels the feed's native
            // decimals on `vpfiPriceUsd`.
            return (feeUsd1e18 * (10 ** uint256(dec))) / vpfiPriceUsd;
        }

        // Phase 1 fallback — ETH/USD × fixed VPFI/ETH rate.
        address weth = s.wethContract;
        if (weth == address(0)) revert NotifFeeWethNotSet();
        (uint256 ethPrice, uint8 ethDec) =
            OracleFacet(address(this)).getAssetPrice(weth);
        if (ethPrice == 0) revert NotifFeeOraclePriceZero();

        // Normalise ETH price to 1e18 USD scale.
        uint256 ethPriceUsd1e18 = (ethPrice * 1e18) / (10 ** uint256(ethDec));
        if (ethPriceUsd1e18 == 0) revert NotifFeeOraclePriceZero();

        // vpfiPriceUsd1e18 = ethPriceUsd1e18 × VPFI_PER_ETH_FIXED_PHASE1 / 1e18
        // vpfiAmount       = feeUsd1e18 × 1e18 / vpfiPriceUsd1e18
        //                  = feeUsd1e18 × 1e36 / (ethPriceUsd1e18 × VPFI_PER_ETH_FIXED_PHASE1)
        //
        // Numerical sanity at typical values:
        //   feeUsd1e18 = 2e18, ETH price = $4000 ⇒ ethPriceUsd1e18 = 4000e18
        //   vpfiAmount = 2e18 × 1e36 / (4000e18 × 1e15)
        //              = 2e54 / 4e36 = 5e17  (i.e. 0.5 VPFI). ✓
        //
        // Overflow check: 2e18 × 1e36 = 2e54, well below uint256 max (≈1.16e77).
        return (feeUsd1e18 * 1e36) /
            (ethPriceUsd1e18 * LibVaipakam.VPFI_PER_ETH_FIXED_PHASE1);
    }

    /// @notice Bills a loan-side once. Idempotent — repeated calls on
    ///         an already-billed side are silent no-ops, matching the
    ///         "first notification only" UX promise of T-032.
    /// @dev    Pulls VPFI from `payer`'s user-escrow → treasury in a
    ///         single `escrowWithdrawERC20` call. No Diamond custody.
    ///         Increments `s.notificationFeesAccrued` for operator
    ///         visibility.
    /// @param  loanId        Loan to bill.
    /// @param  isLenderSide  true ⇒ bill the lender side; false ⇒ borrower.
    /// @param  payer         The escrow owner (lender or borrower).
    ///                       The caller (LoanFacet.markNotifBilled)
    ///                       supplies whichever party matches
    ///                       `isLenderSide`.
    function bill(uint256 loanId, bool isLenderSide, address payer) internal {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        LibVaipakam.Loan storage loan = s.loans[loanId];

        // Idempotent — see NatSpec. Watcher may call this multiple
        // times under retry; only the first should debit.
        if (isLenderSide) {
            if (loan.lenderNotifBilled) return;
        } else {
            if (loan.borrowerNotifBilled) return;
        }

        uint256 vpfiAmount = vpfiAmountForUsdFee();

        address vpfi = s.vpfiToken;
        if (vpfi == address(0)) revert NotifFeeVpfiTokenNotSet();
        address treasury = s.treasury;
        if (treasury == address(0)) revert NotifFeeTreasuryNotSet();

        // Direct: user-escrow → treasury. The Diamond is the
        // privileged caller of the user's escrow proxy
        // (`onlyDiamond` modifier) but never holds the asset itself.
        // Reverts if the user has no escrow OR insufficient VPFI;
        // those reverts surface to the watcher, which logs them and
        // skips the on-chain `markNotifBilled` write — meaning the
        // user's billed flag stays false until they top up VPFI.
        EscrowFactoryFacet(address(this)).escrowWithdrawERC20(
            payer,
            vpfi,
            treasury,
            vpfiAmount
        );

        if (isLenderSide) {
            loan.lenderNotifBilled = true;
        } else {
            loan.borrowerNotifBilled = true;
        }
        s.notificationFeesAccrued += vpfiAmount;

        emit NotificationFeeBilled(
            loanId,
            isLenderSide,
            payer,
            vpfiAmount,
            LibVaipakam.cfgNotificationFeeUsd()
        );
    }
}
