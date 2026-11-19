// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {LibVaipakam} from "./LibVaipakam.sol";
import {LibEntitlement} from "./LibEntitlement.sol";
import {LibCloseoutFreeze} from "./LibCloseoutFreeze.sol";
import {LibFacet} from "./LibFacet.sol";
import {LibPositionNFT} from "./LibPositionNFT.sol";
import {LibVPFIDiscount} from "./LibVPFIDiscount.sol";
import {LibFeeFloor} from "./LibFeeFloor.sol";

/// @notice The one host of {LibInterestPayment.book}, reached by self-call:
///         `RepayPeriodicFacet.bookInterestPayment`.
interface IInterestPaymentHost {
    function bookInterestPayment(uint256 loanId, uint256 gross, uint256 recovered, uint8 source)
        external
        returns (uint256 lenderPaid, uint256 settled);
}

/**
 * @title LibInterestPayment — the one booking of interest paid on an open loan.
 * @notice #3681 — interest paid in the middle of a loan without touching
 *         principal has two sources: the periodic settlement's forced sale
 *         (out of sale proceeds) and the "pay my interest" standing
 *         instruction (out of the borrower-position holder's payment
 *         reserve). Both book it here, once, so they cannot drift:
 *
 *         1. The treasury share is the loan's stamped rate on the gross
 *            interest, less the current lender-position holder's yield-fee
 *            discount (resolved by `VPFIDiscountFacet`, as a partial
 *            repayment resolves it).
 *         2. Lender first on a short recovery (design decision 2026-11-16):
 *            the lender side receives up to its net interest before the
 *            treasury receives anything.
 *         3. The lender side's part is held for the lender position, open
 *            seller claims first (`LibCloseoutFreeze.holdActiveLenderResident`).
 *         4. The treasury's part goes through the one fee host
 *            (`LibFacet.transferToTreasury`), which splits it as for any
 *            interest.
 *         5. What arrived — the lender side's delivered part plus the
 *            treasury's part — counts as interest settled on the loan, so it
 *            leaves the remaining debt, the health factor and the amount
 *            due at repayment.
 *
 *         The PERIOD is not credited here. Each caller closes the period
 *         its own way, once: the forced sale advances the checkpoint after
 *         its booking, and the standing instruction credits the payment
 *         through `LibPeriodicInterest.creditInterestPaid`, which closes the
 *         period inline at its end. Crediting here as well would advance a
 *         sale's period twice.
 *
 * @dev    The interest must already sit in the Diamond. Hosted once, on
 *         `RepayPeriodicFacet.bookInterestPayment`, which the forced sale
 *         and the standing-instruction executor both reach by self-call.
 */
library LibInterestPayment {
    /// @notice Where the interest came from.
    uint8 internal constant SOURCE_PERIODIC_SALE = 0;
    uint8 internal constant SOURCE_PAYMENT_RESERVE = 1;

    /// @notice Interest was paid on an open loan, without touching principal.
    /// @param source     {SOURCE_PERIODIC_SALE} or {SOURCE_PAYMENT_RESERVE}.
    /// @param gross      The interest the payment was for.
    /// @param recovered  What reached the Diamond toward it (`<= gross`).
    /// @param lenderPaid What the lender side received (sellers' claims and
    ///                   the holder's held share together).
    /// @param treasuryPaid What the treasury share sent to the fee host.
    /// @param settled    What now counts as settled on the loan.
    /// @custom:event-category state-change/loan-mutation
    event InterestPaymentBooked(
        uint256 indexed loanId,
        uint8 indexed source,
        address asset,
        uint256 gross,
        uint256 recovered,
        uint256 lenderPaid,
        uint256 treasuryPaid,
        uint256 settled
    );

    /// @notice A booking was asked to take more than the interest it is for.
    error InterestRecoveredAboveGross(uint256 recovered, uint256 gross);

    /// @notice Book `recovered` of `gross` interest, sitting in the Diamond,
    ///         as paid on `loanId`. See the library notes.
    /// @return lenderPaid What the lender side received.
    /// @return settled    What was added to the loan's settled interest.
    function book(uint256 loanId, uint256 gross, uint256 recovered, uint8 source)
        internal
        returns (uint256 lenderPaid, uint256 settled)
    {
        if (recovered > gross) revert InterestRecoveredAboveGross(recovered, gross);
        if (recovered == 0) return (0, 0);
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        LibVaipakam.Loan storage loan = s.loans[loanId];
        address asset = loan.principalAsset;

        (uint256 cut, uint256 net) = LibEntitlement.splitTreasury(loan, gross);
        (uint256 lenderExtra, uint256 newCut) =
            _resolveYieldFee(loan, LibPositionNFT.ownerOf(loan.lenderTokenId), gross, cut);
        if (lenderExtra > 0) {
            net += lenderExtra;
            cut = newCut;
        }

        uint256 lenderAmount = recovered < net ? recovered : net;
        uint256 treasuryAmount = recovered - lenderAmount;

        // Sellers' claims are paid out of the interest first; what the lender
        // side receives is all interest, so the gross of it is what was
        // recovered and its net is the lender side's amount.
        lenderPaid = LibCloseoutFreeze.holdActiveLenderResident(
            s, loanId, loan, asset, lenderAmount, recovered, lenderAmount
        );
        // The one call to the fee host on this path. The share is cut from
        // the interest recovered, so it carries the interest basis (#3649
        // stage 3): the host splits it at the floor and the reserve's part is
        // recorded, as on a full repayment or a forced sale.
        LibFacet.transferToTreasury(
            asset, treasuryAmount, LibFeeFloor.interest(recovered, LibVaipakam.effectiveTreasuryFeeBps(loan))
        );

        settled = lenderPaid + treasuryAmount;
        loan.interestSettled += settled;
        emit InterestPaymentBooked(
            loanId, source, asset, gross, recovered, lenderPaid, treasuryAmount, settled
        );
    }

    /// @dev The lender's yield-fee discount through its one host, short-
    ///      circuited for the ineligible case so a Diamond without the
    ///      discount facet books as before. Same routing as
    ///      `RepayFacet._hostResolveLenderYieldFee`.
    function _resolveYieldFee(
        LibVaipakam.Loan storage loan,
        address settlingLender,
        uint256 interest,
        uint256 treasuryShare
    ) private returns (uint256 lenderExtra, uint256 newTreasury) {
        if (treasuryShare == 0 || !LibVPFIDiscount.lenderYieldFeeEligible(loan, settlingLender)) {
            return (0, treasuryShare);
        }
        bytes memory ret = LibFacet.crossFacetCallReturn(
            abi.encodeWithSignature(
                "resolveLenderYieldFeeFor(uint256,address,uint256,uint256)",
                loan.id,
                settlingLender,
                interest,
                treasuryShare
            ),
            bytes4(0)
        );
        (lenderExtra, newTreasury, ) = abi.decode(ret, (uint256, uint256, uint256));
    }
}
