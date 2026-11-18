// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {LibVaipakam} from "./LibVaipakam.sol";
import {LibFeeFloor} from "./LibFeeFloor.sol";
import {LibInitiationFee} from "./LibInitiationFee.sol";
import {LibVPFIDiscount} from "./LibVPFIDiscount.sol";

/**
 * @title  LibReferral
 * @author Vaipakam Developer Team
 * @notice #3722 — the one rule for a new loan's initiation fee with the
 *         referral applied (`ReferralFeeShareDesign.md`). A wallet that bound
 *         an inviter pays, inside the period fixed at its binding, a lower fee
 *         (the cut), and its inviter receives a share of what is collected.
 *         Both are rates of A, the fee's part above the treasury floor after
 *         the borrower's hold discount. The cut is never more than the
 *         allowance the hold discount leaves under the fee-discount ceiling
 *         (`MAX_FEE_DISCOUNT_BPS` of the full fee), so the two discounts
 *         together never pass it. The inviter's share is bounded later, with
 *         the integrator's, by {LibFeeShares.bound}. The settings keep the
 *         cut rate plus the matcher's rate under the per-loan ceiling
 *         ({LibFeeShares.requireMatcherAndCutFit}), so the cut is never
 *         reduced there.
 *
 *         The acceptance charge and every borrow preview read this one rule;
 *         the vault outflow policy reads {activeInviter} to derive the payee.
 */
library LibReferral {
    /// @notice Where an inviter's share went. `Paid`: to the inviter's
    ///         wallet. `NoShare`: nothing to pay (a rate of zero, or the
    ///         per-loan ceiling took it all). The other three sent it to the
    ///         reserve: the inviter was flagged by the sanctions list at that
    ///         moment, the payment failed, or it delivered less than was sent.
    enum Outcome {
        Paid,
        NoShare,
        InviterFlagged,
        PaymentFailed,
        DeliveredShort
    }

    /// @notice One loan's fee with the referral applied.
    /// @param fee     What the borrower pays: the discounted fee less the cut.
    /// @param above   A: the discounted fee's part above the treasury floor,
    ///                the base every share is sized on.
    /// @param cut     The part of the fee not charged (0 without a referral).
    /// @param share   The inviter's share before the per-loan ceiling.
    /// @param inviter The inviter in force (address(0) when none).
    struct Quote {
        uint256 fee;
        uint256 above;
        uint256 cut;
        uint256 share;
        address inviter;
    }

    /// @notice The two rates in force, defaults resolved, in basis points of A.
    function rates() internal view returns (uint256 cutBps, uint256 shareBps) {
        LibVaipakam.ReferralConfig storage c = LibVaipakam.storageSlot().referralCfg;
        if (!c.ratesSet) return (LibVaipakam.REFERRAL_CUT_BPS_DEFAULT, LibVaipakam.REFERRAL_SHARE_BPS_DEFAULT);
        return (c.cutBps, c.shareBps);
    }

    /// @notice The period a new binding is given, default resolved, in days.
    function periodDays() internal view returns (uint256) {
        uint16 v = LibVaipakam.storageSlot().referralCfg.periodDays;
        return v == 0 ? LibVaipakam.REFERRAL_PERIOD_DAYS_DEFAULT : v;
    }

    /// @notice The inviter `newUser` bound, while its period runs (up to and
    ///         including its end time); address(0) otherwise.
    function activeInviter(address newUser) internal view returns (address) {
        LibVaipakam.ReferralRecord storage r = LibVaipakam.storageSlot().referralOf[newUser];
        return block.timestamp <= r.endsAt ? r.inviter : address(0);
    }

    /// @notice The fee `borrower` pays for a new loan of `principal` over
    ///         `termDays`, with its hold discount (liquid principal only, plus
    ///         the Full bonus when `fullMode`) and its referral applied.
    function quote(address borrower, uint256 principal, uint256 termDays, bool isLiquid, bool fullMode)
        internal
        view
        returns (Quote memory q)
    {
        uint256 base = LibInitiationFee.feeOf(principal, termDays);
        uint256 discounted = LibVPFIDiscount.borrowerLifDiscounted(borrower, base, isLiquid, fullMode);
        q.above = LibFeeFloor.aboveFloor(discounted, principal);
        q.inviter = activeInviter(borrower);
        if (q.inviter != address(0) && q.above > 0) {
            (uint256 cutBps, uint256 shareBps) = rates();
            // The allowance the hold discount leaves under the ceiling.
            uint256 ceiling = (base * LibVaipakam.MAX_FEE_DISCOUNT_BPS) / LibVaipakam.BASIS_POINTS;
            uint256 taken = base - discounted;
            uint256 allowance = ceiling > taken ? ceiling - taken : 0;
            q.cut = (q.above * cutBps) / LibVaipakam.BASIS_POINTS;
            if (q.cut > allowance) q.cut = allowance;
            q.share = (q.above * shareBps) / LibVaipakam.BASIS_POINTS;
        }
        q.fee = discounted - q.cut;
    }
}
