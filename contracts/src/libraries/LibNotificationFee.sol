// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {LibVaipakam} from "./LibVaipakam.sol";
import {OracleFacet} from "../facets/OracleFacet.sol";
import {EscrowFactoryFacet} from "../facets/EscrowFactoryFacet.sol";

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
 *      Pricing model — currency-agnostic, anchored to ETH/numeraire:
 *        Phase 1 (default): the stored `notificationFee` is in the
 *          active numeraire (USD by post-deploy default; whatever
 *          governance rotated to). `OracleFacet.getAssetPrice(WETH)`
 *          returns ETH/numeraire post-B1. Multiplied by the fixed
 *          peg `VPFI_PER_ETH_FIXED_PHASE1 = 1e15` (1 VPFI = 0.001
 *          ETH, both 18-dec — peg is unit-agnostic, describes the
 *          VPFI-to-ETH ratio), this yields a synthetic VPFI/numeraire
 *          rate. The stored fee divides directly to give the VPFI
 *          amount. No USD-intermediate is involved end to end.
 *        Phase 2 (governance / VPFI lists): when VPFI lists on an
 *          exchange, governance can replace the fixed peg with a
 *          live VPFI/numeraire feed and the fee → VPFI math becomes
 *          a single `feeNumeraire / vpfiPriceNumeraire` divide.
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
    ///         per-notification audit log. `feeNumeraire1e18` is the
    ///         configured fee in the ACTIVE NUMERAIRE (USD by
    ///         post-deploy default); off-chain consumers can read the
    ///         current numeraire identity via
    ///         `ConfigFacet.getNumeraireSymbol()` to label the figure.
    event NotificationFeeBilled(
        uint256 indexed loanId,
        bool indexed isLenderSide,
        address indexed payer,
        uint256 vpfiAmount,
        uint256 feeNumeraire1e18
    );

    error NotifFeeWethNotSet();
    error NotifFeeOracleStale();
    error NotifFeeOraclePriceZero();
    error NotifFeeVpfiTokenNotSet();
    error NotifFeeTreasuryNotSet();

    /// @notice Computes the VPFI amount (18-dec, raw) equivalent to
    ///         `cfgNotificationFee()` at the current price feeds,
    ///         anchored to ETH/numeraire.
    /// @dev    Anchor: the active numeraire (USD by post-deploy
    ///         default, governance-rotatable). After B1,
    ///         `OracleFacet.getAssetPrice(WETH)` returns the
    ///         numeraire-quoted ETH price natively — governance
    ///         repoints `s.ethNumeraireFeed` at a Chainlink
    ///         ETH/<numeraire> feed when it rotates. Combined with
    ///         the fixed peg `VPFI_PER_ETH_FIXED_PHASE1 = 1e15`
    ///         (1 VPFI = 0.001 ETH; peg is unit-agnostic, describes
    ///         the VPFI-to-ETH ratio), the math is:
    ///           vpfiPriceNumeraire = ethPriceNumeraire × peg / 1e18
    ///           vpfiAmount         = feeNumeraire × 1e18 / vpfiPriceNumeraire
    ///                              = feeNumeraire × 1e36
    ///                                  / (ethPriceNumeraire × peg)
    ///
    ///         End-to-end in the active numeraire: stored fee is in
    ///         numeraire-units, oracle return is in numeraire-units,
    ///         resulting VPFI amount is correctly priced regardless
    ///         of whether the numeraire is USD, EUR, JPY, or XAU. No
    ///         USD-intermediate at any step.
    ///
    ///         Reverts on stale / zero / unconfigured oracle so a
    ///         broken price source fails the bill rather than charging
    ///         a wildly wrong amount.
    function vpfiAmountForFee() internal view returns (uint256) {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        uint256 feeNumeraire1e18 = LibVaipakam.cfgNotificationFee();

        address weth = s.wethContract;
        if (weth == address(0)) revert NotifFeeWethNotSet();
        (uint256 ethPrice, uint8 ethDec) =
            OracleFacet(address(this)).getAssetPrice(weth);
        if (ethPrice == 0) revert NotifFeeOraclePriceZero();

        // Normalise ETH price to 1e18 numeraire scale.
        uint256 ethPriceNumer1e18 = (ethPrice * 1e18) / (10 ** uint256(ethDec));
        if (ethPriceNumer1e18 == 0) revert NotifFeeOraclePriceZero();

        // vpfiPriceNumer1e18 = ethPriceNumer1e18 × VPFI_PER_ETH_FIXED_PHASE1 / 1e18
        // vpfiAmount         = feeNumer1e18 × 1e18 / vpfiPriceNumer1e18
        //                    = feeNumer1e18 × 1e36 / (ethPriceNumer1e18 × VPFI_PER_ETH_FIXED_PHASE1)
        //
        // Numerical sanity at typical values (USD-as-numeraire):
        //   feeNumer = 2e18, ETH price = $4000 ⇒ ethPriceNumer = 4000e18
        //   vpfiAmount = 2e18 × 1e36 / (4000e18 × 1e15)
        //              = 2e54 / 4e36 = 5e17  (i.e. 0.5 VPFI). ✓
        //
        // Overflow check: 2e18 × 1e36 = 2e54, well below uint256 max (≈1.16e77).
        return (feeNumeraire1e18 * 1e36) /
            (ethPriceNumer1e18 * LibVaipakam.VPFI_PER_ETH_FIXED_PHASE1);
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

        uint256 vpfiAmount = vpfiAmountForFee();

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
            LibVaipakam.cfgNotificationFee()
        );
    }
}
