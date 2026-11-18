// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {LibVaipakam} from "../libraries/LibVaipakam.sol";
import {LibInitiationFee} from "../libraries/LibInitiationFee.sol";
import {LibFeeFloor} from "../libraries/LibFeeFloor.sol";
import {LibFeeShares} from "../libraries/LibFeeShares.sol";
import {LibVPFIDiscount} from "../libraries/LibVPFIDiscount.sol";
import {LibPositionNFT} from "../libraries/LibPositionNFT.sol";
import {LibAccessControl, DiamondAccessControl} from "../libraries/LibAccessControl.sol";

/**
 * @title  FeeLevelsFacet
 * @author Vaipakam Developer Team
 * @notice #3649 — the loan initiation fee by term
 *         (`docs/DesignsAndPlans/FeeLevelsDesign.md`): its term settings and
 *         the views that state the fee for a principal and a term; and the
 *         treasury floors of the fees that feed the reserve (stage 3,
 *         {LibFeeFloor}). The rule
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

    /// @notice A treasury floor is outside its bounds.
    error InvalidTreasuryFeeFloors(uint256 initiationBps, uint256 interestBps);
    /// @notice #3682 — a fee-share ceiling outside 40% to 70% (0 = default).
    error InvalidFeeShareCeiling(uint256 ceilingBps);

    /// @notice Emitted when the treasury floors change. Zero in a field means
    ///         its default.
    event TreasuryFeeFloorsSet(uint16 initiationBps, uint16 interestBps);
    /// @notice #3682 — the per-loan fee-share ceiling changed (0 = default).
    event FeeShareCeilingSet(uint16 ceilingBps);
    /// @notice The matcher's rate changed (0 = the 1% default), in basis
    ///         points of the initiation fee's part above the treasury floor.
    ///         Same signature as before #3722 moved it here from ConfigFacet.
    /// @custom:event-category informational/config
    event LifMatcherFeeBpsSet(uint16 newBps);
    /// @notice A matcher's rate above the 50% fee ceiling. Same signature as
    ///         ConfigFacet's.
    error InvalidFeeBps(uint256 bps, uint256 maxAllowed);

    /// @dev The matcher's rate's outer bound, ConfigFacet's `MAX_FEE_BPS`.
    uint16 private constant MAX_MATCHER_FEE_BPS = 5_000;

    /// @dev The settings' bounds. The base term is a short loan; the one-year
    ///      point is about a year; the yearly rate may not push the fee at the
    ///      longest term the platform admits (`MAX_OFFER_DURATION_DAYS_CEIL`)
    ///      above {MAX_FEE_BPS}, the ceiling every protocol fee shares.
    uint256 private constant MIN_BASE_TERM_DAYS = 1;
    uint256 private constant MAX_BASE_TERM_DAYS = 90;
    uint256 private constant MIN_YEAR_DAYS = 180;
    uint256 private constant MAX_YEAR_DAYS = 730;
    uint256 private constant MAX_FEE_BPS = 5_000;
    /// @dev The treasury floors' outer bounds (#3649 stage 3): 0.2% of the
    ///      principal and 5% of the interest. Inside them the half rule
    ///      binds: a floor may not exceed half the rate it is taken from
    ///      (checked here against the rates in force, and by
    ///      `ConfigFacet.setFeesConfig` against the floors in force), so the
    ///      part above the floor never closes.
    uint256 private constant MAX_INITIATION_FLOOR_BPS = 20;
    uint256 private constant MAX_INTEREST_FLOOR_BPS = 500;

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

    /**
     * @notice Set the treasury floors of the two fees that feed the reserve
     *         (`ShortfallReserveDesign.md` section 8): the share of a loan's
     *         principal the treasury keeps from its initiation fee, and the
     *         share of the interest it keeps from its share of interest. The
     *         part of each fee above its floor is the reserve's. Pass 0 for a
     *         field to restore its default (0.1% and 1%). Refuses a floor
     *         above half the rate it is taken from (the base initiation rate
     *         and the interest share in force), or above 0.2% / 5%.
     * @dev    ADMIN_ROLE (the Timelock after handover). A change applies to
     *         fees collected after it and never touches one already
     *         collected; it moves no amount a user pays, only how the
     *         treasury's receipt is split.
     */
    function setTreasuryFeeFloors(uint16 initiationBps, uint16 interestBps)
        external
        onlyRole(LibAccessControl.ADMIN_ROLE)
    {
        if (initiationBps > MAX_INITIATION_FLOOR_BPS || interestBps > MAX_INTEREST_FLOOR_BPS) {
            revert InvalidTreasuryFeeFloors(initiationBps, interestBps);
        }
        LibVaipakam.FeeFloorConfig storage c = LibVaipakam.storageSlot().feeFloorCfg;
        c.initiationBps = initiationBps;
        c.interestBps = interestBps;
        (uint256 initiationFloor, uint256 interestFloor) = LibFeeFloor.floorsBps();
        if (
            2 * initiationFloor > LibVaipakam.cfgLoanInitiationFeeBps()
                || 2 * interestFloor > LibVaipakam.cfgTreasuryFeeBps()
        ) revert InvalidTreasuryFeeFloors(initiationFloor, interestFloor);
        emit TreasuryFeeFloorsSet(initiationBps, interestBps);
    }

    /**
     * @notice #3682 / #3722 — set the per-loan ceiling on the parts taken from
     *         the initiation fee's part above the treasury floor (the new
     *         user's referral cut and the matcher's, integrator's and inviter's
     *         shares together), in basis points of that part. 0 restores the
     *         60% default; otherwise 40% to 70% (`ReferralFeeShareDesign.md`
     *         2.1). Refused with `LibFeeShares.MatcherAndCutAboveCeiling`
     *         when it would sit below the matcher's rate plus the referral cut
     *         rate, which are never reduced at a loan. When the sum would
     *         exceed it, the inviter's share is reduced first, then the
     *         integrator's; the reserve receives the rest. Applies to fees
     *         collected after it.
     */
    function setFeeShareCeiling(uint16 ceilingBps) external onlyRole(LibAccessControl.ADMIN_ROLE) {
        if (
            ceilingBps != 0
                && (ceilingBps < LibVaipakam.FEE_SHARE_CEILING_BPS_MIN || ceilingBps > LibVaipakam.FEE_SHARE_CEILING_BPS_MAX)
        ) revert InvalidFeeShareCeiling(ceilingBps);
        LibVaipakam.storageSlot().feeShareCfg.ceilingBps = ceilingBps;
        LibFeeShares.requireMatcherAndCutFit();
        emit FeeShareCeilingSet(ceilingBps);
    }

    /**
     * @notice Set the matcher's share of the initiation fee, in basis points
     *         of the fee's part above the treasury floor. 0 restores the
     *         default (1%); at most 50%.
     * @dev    ADMIN_ROLE. Moved here from ConfigFacet in #3722 (ConfigFacet
     *         had no room left under EIP-170), beside the per-loan ceiling it
     *         is checked against: refused with
     *         `LibFeeShares.MatcherAndCutAboveCeiling` when the new rate plus
     *         the referral cut rate would pass that ceiling, so a matcher's
     *         share is never reduced at a loan. Read it with
     *         `ConfigFacet.getLifMatcherFeeBps`. Applies to fees collected
     *         after it.
     */
    function setLifMatcherFeeBps(uint16 newBps) external onlyRole(LibAccessControl.ADMIN_ROLE) {
        if (newBps > MAX_MATCHER_FEE_BPS) revert InvalidFeeBps(newBps, MAX_MATCHER_FEE_BPS);
        LibVaipakam.storageSlot().protocolCfg.lifMatcherFeeBps = newBps;
        LibFeeShares.requireMatcherAndCutFit();
        emit LifMatcherFeeBpsSet(newBps);
    }

    /// @notice The per-loan ceiling in force, default resolved, in basis
    ///         points of the initiation fee's part above the treasury floor.
    function getFeeShareCeiling() external view returns (uint256) {
        return LibFeeShares.ceilingBps();
    }

    /// @notice The treasury floors in force, defaults resolved, in basis
    ///         points: of the principal for the initiation fee, of the
    ///         interest for the interest share.
    function getTreasuryFeeFloors() external view returns (uint256 initiationBps, uint256 interestBps) {
        return LibFeeFloor.floorsBps();
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
