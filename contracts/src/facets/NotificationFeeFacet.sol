// src/facets/NotificationFeeFacet.sol
// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {LibVaipakam} from "../libraries/LibVaipakam.sol";
import {LibNotificationFee} from "../libraries/LibNotificationFee.sol";
import {LibAccessControl, DiamondAccessControl} from "../libraries/LibAccessControl.sol";
import {DiamondPausable} from "../libraries/LibPausable.sol";
import {IVaipakamErrors} from "../interfaces/IVaipakamErrors.sol";

/**
 * @title NotificationFeeFacet
 * @author Vaipakam Developer Team
 * @notice The paid-notification fee, in one place: a wallet's own consent to
 *         be billed, and the billing role's charge against it (T-032, #2721,
 *         #2769).
 * @dev Part of the Diamond Standard (EIP-2535).
 *
 *      WHY A FACET OF ITS OWN (#2769): the charge lived in `LoanFacet` and the
 *      consent in `ProfileFacet`. Screening the payer against the sanctions
 *      oracle where the fee is charged pushed `LoanFacet` 99 bytes over the
 *      EIP-170 limit. Billing a notification is not loan origination, and the
 *      consent's only reader is the charge, so the two move here together:
 *      the one writer of `notificationFeeConsentCap` sits beside its one
 *      reader. Selectors are unchanged by the move.
 *
 *      The pricing and the debit are {LibNotificationFee}; the tariff itself
 *      is governance config on `ConfigFacet` (`setNotificationFee`).
 */
contract NotificationFeeFacet is DiamondPausable, DiamondAccessControl, IVaipakamErrors {

    /**
     * @notice T-032 — record the FIRST PaidPush-tier notification for a
     *         loan-side and immediately bill the corresponding party
     *         flat notification fee in VPFI from their vault into
     *         DIAMOND CUSTODY, which then credits the recycle bucket
     *         (`LibNotificationFee.bill` → `vaultWithdrawERC20(payer, vpfi,
     *         address(this), …)` → `LibVpfiRecycle.credit(NotificationFee,
     *         …)`). #1346 moved this off the direct-to-treasury route; it is
     *         the loop's Layer-0 absorption class. "-equivalent" was stale
     *         too — the amount is a FLAT native-VPFI quantity, not an
     *         oracle conversion.
     * @dev    Idempotent: subsequent calls on an already-billed side
     *         no-op. Reverts on the following — a NON-EXHAUSTIVE list, and
     *         the qualifier is not throat-clearing: three review rounds in
     *         a row found this enumeration wrong in a new direction, so
     *         treat it as the causes worth knowing about rather than as a
     *         closed set:
     *           - the Diamond being PAUSED (`whenNotPaused`, on this
     *             function). Omitted here until #1349 despite sitting in
     *             the signature three lines below the list
     *           - caller missing `NOTIF_BILLER_ROLE`
     *           - loanId past `nextLoanId` or never-initialized
     *             (InvalidLoanStatus)
     *           - the loan is no longer `Active`
     *             (`NotificationBillingLoanNotActive`, #2721)
     *           - the payer never consented, revoked, or capped its
     *             consent below the configured fee
     *             (`NotificationFeeNotConsented`, #2721). The consent is
     *             the payer's own on-chain record
     *             ({setNotificationFeeConsent}); the billing
     *             role cannot create it. This and the status check run
     *             before anything moves, and only for a side not yet billed
     *           - where a sanctions oracle is configured, the payer is
     *             flagged (`SanctionedAddress`) or the oracle cannot be read
     *             (`SanctionsOracleUnavailable`, #2769). Both run before
     *             anything moves, and the second clears on a later retry
     *           - VPFI not configured (`NotifFeeVpfiTokenNotSet`). No
     *             price oracle and no WETH are touched on this path — the fee is
     *             a flat VPFI quantity, so the pre-#1346 "oracle stale /
     *             WETH unset" causes listed here cannot occur
     *           - payer's vault has insufficient VPFI (the watcher's
     *             expected behaviour is to LOG this revert and skip
     *             the notification — the user's billed flag stays
     *             false until they top up VPFI)
     *           - anything the discount RESTAMP raises. After the vault
     *             withdrawal and BEFORE the recycle credit, the billed
     *             flag, the accrual and the event, `bill` calls
     *             `LibVPFIDiscount.rollupUserDiscount` — the BROADCASTING
     *             wrapper. Since #898 / #911 its cross-chain tier push
     *             never reverts the bill: an empty budget, a down or paused
     *             lane, or an empty destination list leaves the payer's
     *             lane OWED (`ProtocolBroadcastFacet.TierPushDeferred`).
     *             The one push failure that still reverts is a call sent
     *             with too little gas (`TierPushOutOfGas`). So a bill that
     *             reverts with a sufficient VPFI balance points at the
     *             vault first: `bill` withdraws through
     *             `vaultWithdrawERC20`, which resolves the vault via
     *             `getOrCreateUserVault` (a sanctions screen and an upgrade
     *             requirement both live there) and spends UNENCUMBERED
     *             balance, so a fully funded vault still reverts
     *             `WithdrawWouldUnderflowLien` when the balance is liened.
     *
     *         The watcher fires this at notification-send time
     *         **only on PaidPush tier** subscribers — FreeTelegram
     *         subscribers are notified for free and never trigger
     *         this call. The on-chain billed flag is the source of
     *         truth that "this loan-side has paid for the notification
     *         service this lifetime." Which subscribers are PaidPush is
     *         the watcher's record, but it no longer decides who CAN be
     *         charged: the payer's on-chain consent does (#2721).
     *
     * @param  loanId        Loan being billed.
     * @param  isLenderSide  true ⇒ bill `loan.lender`; false ⇒ bill
     *                       `loan.borrower`.
     */
    function markNotifBilled(uint256 loanId, bool isLenderSide)
        external
        whenNotPaused
        onlyRole(LibAccessControl.NOTIF_BILLER_ROLE)
    {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        // Loan-existence guard. `nextLoanId` is the highest id ever
        // assigned (pre-increment in `_initiateLoanFinalize` line 158);
        // valid range is [1, nextLoanId] inclusive. Loans are never
        // deleted from `s.loans`, so an in-range id always resolves to
        // a real Loan record. Out-of-range or never-initialized ids
        // return a zeroed Loan struct (lender == address(0)) — that's
        // the case we reject here.
        if (loanId == 0 || loanId > s.nextLoanId) {
            revert InvalidLoanStatus();
        }
        LibVaipakam.Loan storage loan = s.loans[loanId];
        address payer = isLenderSide ? loan.lender : loan.borrower;
        LibNotificationFee.bill(loanId, isLenderSide, payer);
    }

    /**
     * @notice Agree to be billed for paid Push notifications, at most
     *         `maxFeePerLoanSide` VPFI per loan side, or revoke with zero.
     *
     * @dev    The on-chain half of the paid-notification opt-in. The
     *         notification-billing role ({markNotifBilled}) refuses
     *         a payer whose consent is absent or below the fee configured at
     *         billing time, so a compromised billing key cannot charge a
     *         wallet that never agreed to pay, nor more than it agreed to.
     *         The consent covers the caller's own vault only; nobody can set
     *         it for another wallet.
     *
     *         Deliberately NOT `whenNotPaused`: withdrawing consent to be
     *         charged must stay possible at every moment, and granting it
     *         while paused moves nothing (billing is itself paused). Not a
     *         sanctions-screened entry either: it moves no funds, and a
     *         flagged wallet must still be able to revoke. The bill screens
     *         the payer itself, and refuses while the oracle cannot be read
     *         (#2769), so consent never lets a flagged wallet be charged.
     *
     *         Reverts {LibNotificationFee.NotificationFeeConsentAboveCeiling}
     *         above `MAX_NOTIFICATION_FEE_CEIL`; consent to the ceiling itself
     *         accepts any fee governance can set.
     *
     * @param maxFeePerLoanSide Most VPFI (18 decimals) the caller agrees to
     *        pay per loan side; zero revokes.
     */
    function setNotificationFeeConsent(uint256 maxFeePerLoanSide) external {
        LibNotificationFee.setConsent(msg.sender, maxFeePerLoanSide);
    }

    /**
     * @notice `user`'s paid-notification billing consent, and whether it
     *         covers the fee configured right now.
     * @param user The wallet to read.
     * @return maxFeePerLoanSide The most VPFI per loan side `user` agreed to
     *         pay; zero means no consent.
     * @return coversCurrentFee True iff a bill at the current fee would pass
     *         the consent check (the loan must still be active as well).
     */
    function getNotificationFeeConsent(address user)
        external
        view
        returns (uint256 maxFeePerLoanSide, bool coversCurrentFee)
    {
        maxFeePerLoanSide = LibVaipakam.storageSlot().notificationFeeConsentCap[user];
        coversCurrentFee =
            maxFeePerLoanSide != 0 &&
            LibNotificationFee.vpfiAmountForFee() <= maxFeePerLoanSide;
    }
}
