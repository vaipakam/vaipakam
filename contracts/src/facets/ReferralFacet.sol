// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {LibVaipakam} from "../libraries/LibVaipakam.sol";
import {LibAccessControl, DiamondAccessControl} from "../libraries/LibAccessControl.sol";
import {DiamondPausable} from "../libraries/LibPausable.sol";
import {LibReferral} from "../libraries/LibReferral.sol";
import {LibFeeShares} from "../libraries/LibFeeShares.sol";
import {LibVaultOutflow} from "../libraries/LibVaultOutflow.sol";
import {IVaipakamErrors} from "../interfaces/IVaipakamErrors.sol";
import {OracleFacet} from "./OracleFacet.sol";

/**
 * @title  ReferralFacet
 * @author Vaipakam Developer Team
 * @notice #3722 — the referral share of the initiation fee
 *         (`docs/DesignsAndPlans/ReferralFeeShareDesign.md`). A wallet that
 *         has never been a loan's borrower binds, once and by its own call,
 *         the address that invited it. For the period fixed then (180 days by
 *         default), every loan it opens as borrower pays a lower initiation
 *         fee (the cut), and its inviter is paid a share of what is collected,
 *         straight to the inviter's wallet when the loan opens. Both come out
 *         of that loan's own fee, above the treasury floor, under the per-loan
 *         ceiling the matcher's and integrator's shares share
 *         ({LibFeeShares}). Nothing is held for an inviter: a share that
 *         cannot be paid goes to the reserve in the same transaction.
 * @dev    Part of the Diamond Standard (EIP-2535). Its own small facet
 *         because the accept facets are near EIP-170: it holds the binding,
 *         the settings, the views, the one fee quote the previews read
 *         ({LibReferral.quote}) and the isolated payment the acceptance
 *         charge ({OfferAcceptFeeFacet}) self-calls.
 */
contract ReferralFacet is DiamondAccessControl, DiamondPausable, IVaipakamErrors {
    /// @notice `newUser` bound `inviter`; its period ends at `endsAt` (fixed
    ///         for this wallet; a later change to the period setting never
    ///         moves it).
    event InviterBound(address indexed newUser, address indexed inviter, uint64 endsAt);
    /// @notice The two rates changed, in basis points of the fee's part above
    ///         the treasury floor. They apply to loans opened after.
    event ReferralRatesSet(uint16 cutBps, uint16 shareBps);
    /// @notice The period given to new bindings changed (0 = the default).
    event ReferralPeriodSet(uint16 periodDays);

    /// @notice The caller has already bound an inviter.
    error ReferralAlreadyBound(address inviter);
    /// @notice The caller has already been a loan's borrower, so it is not new.
    error ReferralAfterFirstBorrow();
    /// @notice The inviter may not be the caller, the zero address, the
    ///         Diamond, a Vaipakam vault or an address on the integrator list.
    error ReferralInviterInvalid(address inviter);
    /// @notice A rate above 30%.
    error InvalidReferralRates(uint256 cutBps, uint256 shareBps);
    /// @notice A period outside 30 to 365 days (0 = the default).
    error InvalidReferralPeriod(uint256 periodDays);

    /// @notice One wallet's referral as the views report it.
    /// @param inviter     The inviter it bound (address(0) = none).
    /// @param endsAt      The end of its period, fixed at the binding.
    /// @param active      Whether a loan opened now would carry the referral.
    /// @param hasBorrowed Whether it has been a loan's borrower (then it can
    ///                    no longer bind).
    struct ReferralView {
        address inviter;
        uint64 endsAt;
        bool active;
        bool hasBorrowed;
    }

    /// @notice One loan's fee with the referral, as a borrow preview quotes it.
    /// @param fee     What the borrower pays, after the hold discount and the
    ///                cut.
    /// @param cut     The amount not charged because of the referral.
    /// @param share   The inviter's share before the per-loan ceiling (the
    ///                ceiling depends on the matcher and integrator the loan
    ///                names, which a borrow preview may not know yet).
    /// @param inviter The inviter in force (address(0) when none).
    struct FeeQuote {
        uint256 fee;
        uint256 cut;
        uint256 share;
        address inviter;
    }

    // ── The binding ──────────────────────────────────────────────────────

    /**
     * @notice Bind `inviter` as the address that invited the caller. Once
     *         only, by the caller's own call, and only while the caller has
     *         never been a loan's borrower. The period starts now and its end
     *         is fixed for the caller.
     */
    function bindInviter(address inviter) external whenNotPaused {
        LibVaipakam._assertNotSanctioned(msg.sender);
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        LibVaipakam.ReferralRecord storage r = s.referralOf[msg.sender];
        if (r.inviter != address(0)) revert ReferralAlreadyBound(r.inviter);
        if (s.hasBorrowed[msg.sender]) revert ReferralAfterFirstBorrow();
        if (
            inviter == address(0) || inviter == msg.sender || inviter == address(this)
                || s.vaultUserOf[inviter] != address(0) || s.integratorOfAddress[inviter] != address(0)
        ) revert ReferralInviterInvalid(inviter);
        uint64 endsAt = uint64(block.timestamp + LibReferral.periodDays() * 1 days);
        r.inviter = inviter;
        r.endsAt = endsAt;
        emit InviterBound(msg.sender, inviter, endsAt);
    }

    // ── Settings ─────────────────────────────────────────────────────────

    /**
     * @notice Set the new user's cut and the inviter's share, each in basis
     *         points of the fee's part above the treasury floor, 0 to 30%.
     *         Zero is a rate (nothing taken off, or nothing paid).
     * @dev    ADMIN_ROLE (the Timelock after handover). Applies to loans
     *         opened after it; nothing already collected is touched.
     *         Refused with `LibFeeShares.MatcherAndCutAboveCeiling` when the
     *         cut rate plus the matcher's rate would pass the per-loan
     *         ceiling.
     */
    function setReferralRates(uint16 cutBps, uint16 shareBps) external onlyRole(LibAccessControl.ADMIN_ROLE) {
        if (cutBps > LibVaipakam.REFERRAL_RATE_BPS_MAX || shareBps > LibVaipakam.REFERRAL_RATE_BPS_MAX) {
            revert InvalidReferralRates(cutBps, shareBps);
        }
        LibVaipakam.ReferralConfig storage c = LibVaipakam.storageSlot().referralCfg;
        c.cutBps = cutBps;
        c.shareBps = shareBps;
        c.ratesSet = true;
        LibFeeShares.requireMatcherAndCutFit();
        emit ReferralRatesSet(cutBps, shareBps);
    }

    /**
     * @notice Set the period given to new bindings, 30 to 365 days; 0
     *         restores the default (180 days).
     * @dev    ADMIN_ROLE. A wallet already bound keeps the end time it was
     *         given.
     */
    function setReferralPeriodDays(uint16 periodDays) external onlyRole(LibAccessControl.ADMIN_ROLE) {
        if (
            periodDays != 0
                && (periodDays < LibVaipakam.REFERRAL_PERIOD_DAYS_MIN || periodDays > LibVaipakam.REFERRAL_PERIOD_DAYS_MAX)
        ) revert InvalidReferralPeriod(periodDays);
        LibVaipakam.storageSlot().referralCfg.periodDays = periodDays;
        emit ReferralPeriodSet(periodDays);
    }

    // ── The payment ──────────────────────────────────────────────────────

    /**
     * @notice Diamond-internal: pay `amount` of `asset`, the share of the
     *         initiation fee of offer `offerId`'s accept, from `lender`'s
     *         vault to the wallet of the inviter `newUser` bound. The
     *         acceptance charge runs this as one isolated step that may fail
     *         alone, and sends the share to the reserve when it does.
     * @dev    Reverts `SanctionedAddress` when the inviter is flagged now and
     *         `TokenDeliveryShort` when less than `amount` arrived, so the
     *         charge can state which.
     */
    function payReferralShare(address lender, address asset, uint256 amount, address newUser, uint256 offerId)
        external
    {
        if (msg.sender != address(this)) revert UnauthorizedCrossFacetCall();
        LibVaipakam._assertNotSanctioned(LibReferral.activeInviter(newUser));
        uint256 delivered = LibVaultOutflow.toReferralShare(lender, asset, amount, newUser, offerId);
        if (delivered != amount) revert TokenDeliveryShort(asset, amount, delivered);
    }

    // ── Views ────────────────────────────────────────────────────────────

    /// @notice `wallet`'s referral.
    function getReferral(address wallet) external view returns (ReferralView memory v) {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        LibVaipakam.ReferralRecord storage r = s.referralOf[wallet];
        v.inviter = r.inviter;
        v.endsAt = r.endsAt;
        v.active = LibReferral.activeInviter(wallet) != address(0);
        v.hasBorrowed = s.hasBorrowed[wallet];
    }

    /// @notice The settings in force, defaults resolved: the two rates and
    ///         the per-loan ceiling in basis points of the fee's part above the
    ///         treasury floor, and the period a binding made now is given.
    function getReferralSettings()
        external
        view
        returns (uint256 cutBps, uint256 shareBps, uint256 periodDays, uint256 ceilingBps)
    {
        (cutBps, shareBps) = LibReferral.rates();
        periodDays = LibReferral.periodDays();
        ceilingBps = LibFeeShares.ceilingBps();
    }

    /// @notice The public counters for loans in `asset`: the cut not charged,
    ///         the shares paid to inviters, the shares sent to the reserve
    ///         instead, and the loans that carried a cut or a share.
    function getReferralTotals(address asset) external view returns (LibVaipakam.ReferralTotals memory) {
        return LibVaipakam.storageSlot().referralTotals[asset];
    }

    /**
     * @notice The initiation fee `borrower` would pay for a new loan of
     *         `principal` of `lendingAsset` over `termDays` opened now: after
     *         its hold discount (the Full bonus too when `fullMode`) and its
     *         referral. The same rule the acceptance charges
     *         ({LibReferral.quote}); every borrow preview reads it here.
     */
    function quoteBorrowerFee(
        address borrower,
        address lendingAsset,
        uint256 principal,
        uint256 termDays,
        bool fullMode
    ) external view returns (FeeQuote memory f) {
        LibReferral.Quote memory q = LibReferral.quote(
            borrower,
            principal,
            termDays,
            OracleFacet(address(this)).checkLiquidity(lendingAsset) == LibVaipakam.LiquidityStatus.Liquid,
            fullMode
        );
        f.fee = q.fee;
        f.cut = q.cut;
        f.share = q.share;
        f.inviter = q.inviter;
    }
}
