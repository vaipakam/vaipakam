// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {LibVaipakam} from "./LibVaipakam.sol";
import {LibVpfiRecycle} from "./LibVpfiRecycle.sol";
import {LibVPFIDiscount} from "./LibVPFIDiscount.sol";
import {VaultFactoryFacet} from "../facets/VaultFactoryFacet.sol";

/**
 * @title LibNotificationFee
 * @notice T-032 — pricing + collection helpers for the per-loan-side
 *         notification tariff. Charged in VPFI from the user's vault on
 *         the FIRST PaidPush-tier notification fired by the off-chain
 *         watcher Worker.
 *
 *         Recycling M1 (#1346, `VpfiRecyclingBalanceGovernorDesign.md`
 *         §4.1 Layer 0 / §5 / §13 / §14.2). Two changes from the T-032
 *         original:
 *           1. **Flat native-VPFI tariff.** The stored `notificationFee`
 *              IS the VPFI wei amount billed — a quantity, not a
 *              numeraire figure converted through the ETH/numeraire oracle
 *              and the `VPFI_PER_ETH_FIXED_PHASE1` peg. The launch-era
 *              conversion class (§14.2) is forbidden, so the peg path is
 *              retired here; `vpfiAmountForFee()` now reads the flat
 *              tariff directly.
 *           2. **Custody re-route into the recycle loop.** The bill no
 *              longer moves user-vault → treasury directly. It pulls the
 *              VPFI into **Diamond custody** and credits the recycle
 *              bucket via `LibVpfiRecycle.credit(NotificationFee, …)` —
 *              the first live non-forfeit absorption class. The tokens
 *              stay in Diamond custody as protocol-owned recycled reward
 *              runway (governor §5), never routed to treasury.
 *
 * @dev Library, delegatecalled from `LoanFacet.markNotifBilled` (the
 *      `NOTIF_BILLER_ROLE`-gated external entry). `address(this)`
 *      resolves to the Diamond inside any function below.
 *
 *      Bucket-separation invariant (governor §5) holds by construction:
 *      the tariff arrives FRESH from a user's vault, so crediting it never
 *      grows the ledger's right-hand side past the Diamond balance — the
 *      `credit()` chokepoint additionally enforces this
 *      (`InsufficientRecycleBacking` reverts if the tokens are not on the
 *      Diamond), which is why the withdraw MUST precede the credit.
 *
 *      Discount restamp (#973 / "L26"): moving VPFI out of a user's vault
 *      must re-stamp their time-weighted discount accumulator at the
 *      post-mutation balance — otherwise the payer keeps a stale
 *      fee-tier/staking stamp on VPFI that has already left. Every other
 *      VPFI-debit path does this; the pre-M1 bill path skipped it. The
 *      re-route closes that gap with a `rollupUserDiscount` tail.
 */
library LibNotificationFee {
    /// @notice Emitted when a loan-side's first notification triggers a
    ///         successful bill. Indexes the loan + side + payer for
    ///         off-chain reconciliation against the watcher's
    ///         per-notification audit log. `vpfiAmount` is the flat VPFI
    ///         tariff billed.
    /// @dev    The 5th field is retained across the Recycling M1 (#1346)
    ///         re-denomination purely for **event-topic stability**: the
    ///         topic hash is `keccak256("NotificationFeeBilled(uint256,
    ///         bool,address,uint256,uint256)")`, so keeping the 5-field
    ///         shape lets a cold reindex decode pre- and post-M1 logs with
    ///         one derived ABI entry (the indexer's `rewardLoopLedger`
    ///         backfill replays historical bills as retention debits —
    ///         a dropped field would change the topic and silently skip
    ///         those old logs, overstating retained VPFI). Under the flat
    ///         tariff the configured fee IS the billed amount, so
    ///         `configuredFeeVpfi1e18 == vpfiAmount`; the field is kept
    ///         (rather than removed) for that decode-stability reason.
    /// @custom:event-category state-change/treasury-mutation
    event NotificationFeeBilled(
        uint256 indexed loanId,
        bool indexed isLenderSide,
        address indexed payer,
        uint256 vpfiAmount,
        uint256 configuredFeeVpfi1e18
    );

    error NotifFeeVpfiTokenNotSet();

    /// @notice The flat VPFI amount (18-dec, raw) billed per loan-side
    ///         notification — the configured native-VPFI tariff.
    /// @dev    Recycling M1 (#1346): a flat quantity read straight from
    ///         `cfgNotificationFee()`. No oracle, no ETH/numeraire peg —
    ///         the §14.2 conversion class is forbidden at launch.
    function vpfiAmountForFee() internal view returns (uint256) {
        return LibVaipakam.cfgNotificationFee();
    }

    /// @notice Bills a loan-side once. Idempotent — repeated calls on an
    ///         already-billed side are silent no-ops, matching the "first
    ///         notification only" UX promise of T-032.
    /// @dev    Pulls the flat VPFI tariff from `payer`'s vault into Diamond
    ///         custody, re-stamps the payer's discount accumulator at the
    ///         post-mutation balance (#973/L26), then credits the recycle
    ///         bucket (`RecycleSource.NotificationFee`). Order matters:
    ///         the withdraw must land the tokens on the Diamond BEFORE
    ///         `credit()`, whose backing check reverts otherwise.
    ///         Increments `s.notificationFeesAccrued` for operator
    ///         visibility.
    /// @param  loanId        Loan to bill (used as the recycle refId).
    /// @param  isLenderSide  true ⇒ bill the lender side; false ⇒ borrower.
    /// @param  payer         The vault owner (lender or borrower). The
    ///                       caller (`LoanFacet.markNotifBilled`) supplies
    ///                       whichever party matches `isLenderSide`.
    function bill(uint256 loanId, bool isLenderSide, address payer) internal {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        LibVaipakam.Loan storage loan = s.loans[loanId];

        // Idempotent — see NatSpec. Watcher may call this multiple times
        // under retry; only the first should debit.
        if (isLenderSide) {
            if (loan.lenderNotifBilled) return;
        } else {
            if (loan.borrowerNotifBilled) return;
        }

        uint256 vpfiAmount = vpfiAmountForFee();

        address vpfi = s.vpfiToken;
        if (vpfi == address(0)) revert NotifFeeVpfiTokenNotSet();

        // 1. Pull VPFI from the payer's vault into Diamond custody. The
        //    Diamond is the privileged caller of the user's vault proxy
        //    (`onlyDiamondInternal`). Reverts if the user has no vault OR
        //    insufficient VPFI; those reverts surface to the watcher,
        //    which logs them and skips the on-chain `markNotifBilled`
        //    write — the billed flag stays false until they top up VPFI.
        VaultFactoryFacet(address(this)).vaultWithdrawERC20(
            payer,
            vpfi,
            address(this),
            vpfiAmount
        );

        // 2. Restamp the payer's time-weighted discount accumulator at the
        //    post-mutation tracked balance (#973/L26). `vaultWithdrawERC20`
        //    has already decremented the tracked counter, so the current
        //    tracked balance IS the post-mutation staked figure.
        LibVPFIDiscount.rollupUserDiscount(
            payer,
            s.protocolTrackedVaultBalance[payer][vpfi]
        );

        // 3. Credit the recycle bucket now that the tariff sits on the
        //    Diamond — the first live non-forfeit absorption class
        //    (governor §4.1 Layer 0). refId = loanId for per-loan
        //    observability on the `VpfiRecycled` feed.
        LibVpfiRecycle.credit(
            LibVpfiRecycle.RecycleSource.NotificationFee,
            loanId,
            vpfiAmount
        );

        if (isLenderSide) {
            loan.lenderNotifBilled = true;
        } else {
            loan.borrowerNotifBilled = true;
        }
        s.notificationFeesAccrued += vpfiAmount;

        // 5th field == vpfiAmount under the flat tariff; retained for
        // event-topic stability across the M1 re-denomination (see the
        // event's @dev).
        emit NotificationFeeBilled(
            loanId,
            isLenderSide,
            payer,
            vpfiAmount,
            vpfiAmount
        );
    }
}
