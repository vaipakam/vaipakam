// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {LibVaipakam} from "./LibVaipakam.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {LibVpfiRecycle} from "./LibVpfiRecycle.sol";
import {VaultFactoryFacet} from "../facets/VaultFactoryFacet.sol";
import {IVaipakamErrors} from "../interfaces/IVaipakamErrors.sol";

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
 * @dev Library, delegatecalled from `NotificationFeeFacet.markNotifBilled` (the
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
 *      Discount record (#973 / "L26"): moving VPFI out of a user's vault
 *      must refresh their fee-discount tier record — otherwise the payer
 *      keeps a stale tier on VPFI that has already left. Since #1820 the
 *      vault withdrawal does that itself, at the write, as every VPFI
 *      movement does; the bill writes no stamp of its own.
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

    /// @notice Emitted when a wallet sets or revokes its consent to be
    ///         billed for paid notifications (#2721). `cap` is the most VPFI
    ///         it agreed to pay per loan side; zero revokes.
    /// @custom:event-category informational/config
    event NotificationFeeConsentSet(address indexed user, uint256 previousCap, uint256 cap);

    error NotifFeeVpfiTokenNotSet();
    /// @notice #2721 — `payer` has not agreed to pay `fee` per loan side:
    ///         it never consented, revoked, or capped its consent below the
    ///         fee now configured. Nothing is debited.
    error NotificationFeeNotConsented(address payer, uint256 fee, uint256 consentedCap);
    /// @notice #2721 — a paid-notification fee is billed only on a loan
    ///         that is still open. Nothing is debited.
    error NotificationBillingLoanNotActive(uint256 loanId);
    /// @notice #2721 — a consent cap above the protocol's fee ceiling would
    ///         record a figure no bill can reach; consent to the ceiling
    ///         itself to accept any fee governance can set.
    error NotificationFeeConsentAboveCeiling(uint256 cap, uint256 ceiling);

    /// @notice The flat VPFI amount (18-dec, raw) billed per loan-side
    ///         notification — the configured native-VPFI tariff.
    /// @dev    Recycling M1 (#1346): a flat quantity read straight from
    ///         `cfgNotificationFee()`. No oracle, no ETH/numeraire peg —
    ///         the §14.2 conversion class is forbidden at launch.
    function vpfiAmountForFee() internal view returns (uint256) {
        return LibVaipakam.cfgNotificationFee();
    }

    /// @notice Records `user`'s consent to be billed for paid notifications
    ///         (#2721): at most `cap` VPFI per loan side. Zero revokes.
    /// @dev    The only writer of `notificationFeeConsentCap`. The consent is
    ///         the user's own: the caller (`ProfileFacet`) passes
    ///         `msg.sender`, never an argument. A cap above
    ///         `MAX_NOTIFICATION_FEE_CEIL` is refused rather than stored, so
    ///         the record always names a fee a bill could actually charge.
    function setConsent(address user, uint256 cap) internal {
        if (cap > LibVaipakam.MAX_NOTIFICATION_FEE_CEIL) {
            revert NotificationFeeConsentAboveCeiling(cap, LibVaipakam.MAX_NOTIFICATION_FEE_CEIL);
        }
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        emit NotificationFeeConsentSet(user, s.notificationFeeConsentCap[user], cap);
        s.notificationFeeConsentCap[user] = cap;
    }

    /// @notice #2769 — the payer must read clean on the sanctions oracle before
    ///         a fee leaves its vault.
    /// @dev    A flagged wallet's vault is frozen, not seized, so the protocol
    ///         must not charge it. Billing is discretionary and retryable, so
    ///         the bill FAILS CLOSED while screening is unavailable: a refused
    ///         bill leaves the side unbilled for a later retry, while a bill
    ///         taken during an outage could not be undone. Three outcomes:
    ///           - no oracle configured: no screen, the deploy-window rule
    ///             every Tier-1 gate follows;
    ///           - the oracle (or the payer's declared recovery source) flags
    ///             the payer: `SanctionedAddress(payer)`;
    ///           - the oracle is set but cannot be read:
    ///             `SanctionsOracleUnavailable()`.
    ///         The vault withdrawal also screens its owner, but that screen
    ///         fails open during an outage and reports from deep inside the
    ///         withdrawal. This one states the rule where the fee is charged.
    function _requireClearedPayer(LibVaipakam.Storage storage s, address payer) private view {
        if (s.sanctionsOracle == address(0)) return;
        LibVaipakam.SanctionsRead st = LibVaipakam.sanctionsStatus(payer);
        if (st == LibVaipakam.SanctionsRead.Flagged) revert LibVaipakam.SanctionedAddress(payer);
        if (st == LibVaipakam.SanctionsRead.Unavailable) revert IVaipakamErrors.SanctionsOracleUnavailable();
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
    ///
    ///         Three refusals run before anything moves. The loan must be
    ///         `Active`, and `payer` must have consented, through
    ///         {setConsent}, to a cap at least the fee being billed (#2721).
    ///         Where a sanctions oracle is configured, `payer` must also read
    ///         clean on it, and an unreadable oracle refuses the bill
    ///         (#2769, {_requireClearedPayer}). The billing role therefore
    ///         cannot charge a wallet that never agreed to pay, charge more
    ///         than it agreed to, charge on a closed loan, or charge a
    ///         flagged wallet. An already-billed side stays a silent no-op
    ///         whatever its loan's status, so a retry never turns into a
    ///         revert.
    /// @param  payer         The vault owner (lender or borrower). The
    ///                       caller (`NotificationFeeFacet.markNotifBilled`) supplies
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

        if (loan.status != LibVaipakam.LoanStatus.Active) {
            revert NotificationBillingLoanNotActive(loanId);
        }
        uint256 vpfiAmount = vpfiAmountForFee();
        uint256 consentedCap = s.notificationFeeConsentCap[payer];
        if (consentedCap == 0 || vpfiAmount > consentedCap) {
            revert NotificationFeeNotConsented(payer, vpfiAmount, consentedCap);
        }
        _requireClearedPayer(s, payer);

        address vpfi = s.vpfiToken;
        if (vpfi == address(0)) revert NotifFeeVpfiTokenNotSet();

        // 1. Pull VPFI from the payer's vault into Diamond custody. The
        //    Diamond is the privileged caller of the user's vault proxy
        //    (`onlyDiamondInternal`). Reverts if the user has no vault OR
        //    insufficient VPFI; those reverts surface to the watcher,
        //    which logs them and skips the on-chain `markNotifBilled`
        //    write — the billed flag stays false until they top up VPFI.
        //    #1566 closure 2 — snapshot the Diamond's balance first: the
        //    bucket credit in step 3 is a delta-checked OPERATION that
        //    verifies the balance actually rose by the tariff. The
        //    withdraw refreshes the payer's tier record itself (#1820).
        uint256 balanceBefore = IERC20(vpfi).balanceOf(address(this));
        VaultFactoryFacet(address(this)).vaultWithdrawERC20(
            payer,
            vpfi,
            address(this),
            vpfiAmount
        );

        // 2. Credit the recycle bucket now that the tariff sits on the
        //    Diamond — the first live non-forfeit absorption class
        //    (governor §4.1 Layer 0). refId = loanId for per-loan
        //    observability on the `VpfiRecycled` feed. The tag is the
        //    operation's own — there is no generic tagged credit any more.
        LibVpfiRecycle.creditNotificationFee(loanId, vpfiAmount, balanceBefore);

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
