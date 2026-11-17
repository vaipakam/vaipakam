// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {LibVaipakam} from "../libraries/LibVaipakam.sol";
import {LibInitiationFee} from "../libraries/LibInitiationFee.sol";
import {LibVPFIDiscount} from "../libraries/LibVPFIDiscount.sol";
import {LibPositionNFT} from "../libraries/LibPositionNFT.sol";
import {LibAccessControl, DiamondAccessControl} from "../libraries/LibAccessControl.sol";

/**
 * @title  FeeLevelsFacet
 * @author Vaipakam Developer Team
 * @notice #3649 — the loan initiation fee by term
 *         (`docs/DesignsAndPlans/FeeLevelsDesign.md`): its term settings and
 *         the views that state the fee for a principal and a term. The rule
 *         itself is {LibInitiationFee}; every charger and preview reads it.
 * @dev    Part of the Diamond Standard (EIP-2535). Its own facet because
 *         `ConfigFacet`, which keeps the base rate and the interest share
 *         (`setFeesConfig`), had about 500 bytes of EIP-170 room. The base
 *         rate is one of the four settings the rule reads; it stays where it
 *         was set and is bounded against these.
 */
contract FeeLevelsFacet is DiamondAccessControl {
    /// @notice A term setting is outside its bounds, or the four settings
    ///         together would make the rate fall with the term or the fee at
    ///         the longest admissible term exceed the fee ceiling.
    error InvalidLoanInitiationFeeTerms(uint256 baseTermDays, uint256 yearlyBps, uint256 yearDays);

    /// @notice Emitted when the term settings change. Zero in a field means
    ///         its default.
    event LoanInitiationFeeTermsSet(uint16 baseTermDays, uint16 yearlyBps, uint16 yearDays);

    /// @dev The settings' bounds. The base term is a short loan; the one-year
    ///      point is about a year; the yearly rate may not push the fee at the
    ///      longest term the platform admits (`MAX_OFFER_DURATION_DAYS_CEIL`)
    ///      above {MAX_FEE_BPS}, the ceiling every protocol fee shares.
    uint256 private constant MIN_BASE_TERM_DAYS = 1;
    uint256 private constant MAX_BASE_TERM_DAYS = 90;
    uint256 private constant MIN_YEAR_DAYS = 180;
    uint256 private constant MAX_YEAR_DAYS = 730;
    uint256 private constant MAX_FEE_BPS = 5_000;

    /**
     * @notice Set the initiation fee's term settings: the term up to which
     *         the base rate applies, the yearly rate, and the one-year point
     *         at which the rate reaches it. Pass 0 for a field to restore its
     *         default (30 days, 1% a year, 365 days).
     * @dev    ADMIN_ROLE (the Timelock after handover). A loan's fee is fixed
     *         when it opens, so a change never reprices an open loan; an
     *         extension's added fee is priced on the settings in force when
     *         it takes effect. Refuses settings under which the rate would
     *         fall with the term (base rate above the yearly rate, base term
     *         not before the one-year point) or the fee at the longest
     *         admissible term would exceed the fee ceiling.
     */
    function setLoanInitiationFeeTerms(uint16 baseTermDays, uint16 yearlyBps, uint16 yearDays)
        external
        onlyRole(LibAccessControl.ADMIN_ROLE)
    {
        LibVaipakam.LifTermConfig storage c = LibVaipakam.storageSlot().lifTermCfg;
        c.baseTermDays = baseTermDays;
        c.yearlyBps = yearlyBps;
        c.yearDays = yearDays;
        (uint256 b, uint256 t0, uint256 y, uint256 d) = LibInitiationFee.terms();
        if (
            t0 < MIN_BASE_TERM_DAYS || t0 > MAX_BASE_TERM_DAYS || d < MIN_YEAR_DAYS || d > MAX_YEAR_DAYS
                || y < b || y * LibVaipakam.MAX_OFFER_DURATION_DAYS_CEIL > MAX_FEE_BPS * d
        ) revert InvalidLoanInitiationFeeTerms(t0, y, d);
        emit LoanInitiationFeeTermsSet(baseTermDays, yearlyBps, yearDays);
    }

    /// @notice The four settings in force, defaults resolved: base rate
    ///         (bps), base term (days), yearly rate (bps), one-year point
    ///         (days).
    function getLoanInitiationFeeTerms()
        external
        view
        returns (uint256 baseBps, uint256 baseTermDays, uint256 yearlyBps, uint256 yearDays)
    {
        return LibInitiationFee.terms();
    }

    /**
     * @notice The initiation fee a loan of `principal` and agreed term
     *         `termDays` pays before any discount, as an amount and as a rate.
     * @return fee         The amount, in the lending asset's units.
     * @return rateBpsDown The rate in whole basis points, rounded down.
     * @return rateBpsUp   The rate in whole basis points, rounded up (what a
     *                     signed order's fee cap is compared with).
     */
    function quoteLoanInitiationFee(uint256 principal, uint256 termDays)
        external
        view
        returns (uint256 fee, uint256 rateBpsDown, uint256 rateBpsUp)
    {
        fee = LibInitiationFee.feeOf(principal, termDays);
        rateBpsDown = LibInitiationFee.rateBpsDown(termDays);
        rateBpsUp = LibInitiationFee.rateBpsUp(termDays);
    }

    /**
     * @notice What extending loan `loanId` now, to end at `newEndTime`,
     *         would add to its initiation fee (#3649).
     * @return gross       The added fee before any discount.
     * @return fee         After the current borrower-position holder's
     *                     hold-tier discount: what the extension charges, and
     *                     what the borrower's extension limit is checked
     *                     against.
     * @return paidDays    The term the fee is paid for now.
     * @return newPaidDays The term it would be paid for after.
     * @dev    The figure holds for an extension made now; the settings, the
     *         principal outstanding, the holder's tier and paused time can
     *         move it before one lands.
     */
    function quoteExtensionFee(uint256 loanId, uint256 newEndTime)
        external
        view
        returns (uint256 gross, uint256 fee, uint256 paidDays, uint256 newPaidDays)
    {
        LibVaipakam.Loan storage loan = LibVaipakam.storageSlot().loans[loanId];
        (gross, paidDays, newPaidDays) = LibInitiationFee.extensionFee(loan, newEndTime);
        if (gross > 0) {
            fee = LibVPFIDiscount.borrowerLifDiscounted(
                LibPositionNFT.ownerOf(loan.borrowerTokenId),
                gross,
                loan.principalLiquidity == LibVaipakam.LiquidityStatus.Liquid,
                false
            );
        }
    }
}
