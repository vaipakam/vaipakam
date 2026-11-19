// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {LibVaipakam} from "../libraries/LibVaipakam.sol";
import {LibRateReference} from "../libraries/LibRateReference.sol";
import {IRateReference} from "../interfaces/IRateReference.sol";

/**
 * @title  RateLinkFacet
 * @author Vaipakam Developer Team
 * @notice The one place the Diamond applies the rate reference to fixed-rate
 *         offers, intent slots and accepts (#3635 part A, #3713;
 *         `MarketLinkedRateLimitsDesign.md` section 4,
 *         `TermAverageAndLinkGuardsDesign.md` sections 3, 5, 6):
 *         - the **linked bound** a maker's link produces now (the averaged
 *           reference over the window the loan's term reads, or the term
 *           average, plus the maker's margin, floored at zero), or why the
 *           link cannot be used now;
 *         - the **warning band** check on every write or take of a fixed
 *           rate, refused unless the step carries its acknowledgement;
 *         - the check that a link may be written at all.
 *         Every creator, editor, match host, previewer and accept path calls
 *         these through a self-call, so none of them carries a second copy of
 *         the rule and the hosts near the size limit spend one call each.
 * @dev    Read-only: every entry is a view over the rate reference and the
 *         stored offer, so it needs no caller gate. It moves no funds and
 *         changes no state. The match rule on rate (the midpoint of the two
 *         makers' effective bounds) lives here too, as {matchRate}, so the
 *         four match hosts make one call for it instead of carrying it.
 */
contract RateLinkFacet {
    /// @notice Warnings mask bit: the checked fixed rate is far ABOVE the
    ///         term average (outside the band). Bit 0 is reserved for the
    ///         collateral-concentration warning (#3685).
    uint8 public constant WARN_FAR_ABOVE = 1 << 1;
    /// @notice Warnings mask bit: the checked fixed rate is far BELOW the
    ///         term average.
    uint8 public constant WARN_FAR_BELOW = 1 << 2;

    /// @notice A link was written for an asset this chain has no rate
    ///         reference for.
    error RateLinkNoReference(address asset);
    /// @notice A link's margin is beyond plus or minus the protocol's
    ///         maximum interest rate, or a kind is not a link kind.
    error RateLinkInvalid(uint8 kind, int256 marginBps);
    /// @notice A link on an offer kind that does not take one in this build
    ///         (an NFT rental, a loan-sale offer, a refinance request).
    error RateLinkNotOffered();
    /// @notice A maker's rate limit is linked to the rate reference and the
    ///         link cannot be used now (1 reference unavailable for the
    ///         window this loan's term reads, 2 a term over 30 days while the
    ///         reference is unusual or not known).
    error RateLinkUnavailable(uint8 refusal);
    /// @notice A direct accept of a rate-linked offer: the offer's effective
    ///         endpoint now (`rateBps`) is worse for the acceptor than the
    ///         rate they signed (`limitBps`): above it on a lender's offer,
    ///         below it on a borrower's.
    error RateBeyondAcceptorLimit(uint256 rateBps, uint256 limitBps);
    /// @notice A fixed rate outside the warning band around the term average
    ///         was written or taken without the step's acknowledgement.
    /// @param asset       The lending asset.
    /// @param termDays    The term the check used.
    /// @param rateBps     The rate checked.
    /// @param averageBps  The term average, in basis points (rounded down).
    /// @param above       True when the rate is far above, false far below.
    error RateFarFromTermAverage(address asset, uint256 termDays, uint256 rateBps, uint256 averageBps, bool above);

    /// @notice The two makers' rate limits as the match core reads them
    ///         (#3635 A): each typed range, link and margin, and the term the
    ///         loan would run (the borrower's).
    struct PairRates {
        address asset;
        uint256 termDays;
        uint256 lenderFloor;
        uint256 lenderMax;
        uint8 lenderKind;
        int16 lenderMargin;
        uint256 borrowerFloor;
        uint256 borrowerMax;
        uint8 borrowerKind;
        int16 borrowerMargin;
    }

    /// @notice {matchRate}'s refusal when the two effective ranges do not
    ///         overlap. 1 and 2 are a link refusal
    ///         (`IRateReference.LinkRefusal`).
    uint8 internal constant NO_OVERLAP = 3;

    /// @notice The one match rule on rate (#3635 A): the overlap of the two
    ///         makers' EFFECTIVE bounds (the lender's floor the higher of its
    ///         typed floor and its linked rate, the borrower's ceiling the
    ///         lower of its typed ceiling and its linked rate), and the rate
    ///         the loan opens at, the midpoint of that overlap. `refusal` is 0,
    ///         a link refusal (1 reference unavailable, 2 reference unusual)
    ///         or 3 when the ranges do not overlap; `fromLink` is true when a
    ///         link set (or met) a bound the overlap used.
    function matchRate(PairRates calldata p) external view returns (uint256 rateBps, uint8 refusal, bool fromLink) {
        uint256 lo = p.lenderFloor;
        uint256 hi = p.borrowerMax;
        uint256 bound;
        if (p.lenderKind != 0) {
            (bound, refusal) = rateLinkBound(p.asset, p.termDays, p.lenderKind, p.lenderMargin, true);
            if (refusal != 0) return (0, refusal, false);
            if (bound >= lo) (lo, fromLink) = (bound, true);
        }
        if (p.borrowerKind != 0) {
            (bound, refusal) = rateLinkBound(p.asset, p.termDays, p.borrowerKind, p.borrowerMargin, false);
            if (refusal != 0) return (0, refusal, false);
            if (bound <= hi) (hi, fromLink) = (bound, true);
        }
        if (p.borrowerFloor > lo) lo = p.borrowerFloor;
        if (p.lenderMax < hi) hi = p.lenderMax;
        if (lo > hi) return (0, NO_OVERLAP, false);
        rateBps = (lo + hi) / 2;
    }

    /// @notice The price of one instant-market source with a market link
    ///         (#3635 A): the higher of its typed floor and its linked rate
    ///         for the fill's term. Refused by name while the link cannot be
    ///         used.
    function linkedFloor(address asset, uint256 termDays, uint8 kind, int16 marginBps, uint256 typedFloor)
        external
        view
        returns (uint256 rateBps)
    {
        (uint256 bound, uint8 refusal) = rateLinkBound(asset, termDays, kind, marginBps, true);
        if (refusal != 0) revert RateLinkUnavailable(refusal);
        rateBps = bound > typedFloor ? bound : typedFloor;
    }

    /// @notice The rate reference this Diamond reads, or zero when none.
    function getRateReference() external view returns (address) {
        (bool ok, IRateReference rr) = LibRateReference.tryReference();
        return ok ? address(rr) : address(0);
    }

    /// @notice The bound a link of `kind` with `marginBps` produces now for a
    ///         loan of `termDays` on `asset`, in basis points, and why it
    ///         cannot be used (0 none, 1 reference unavailable, 2 reference
    ///         unusual). A LENDER's bound is a floor and rounds up; a
    ///         BORROWER's is a ceiling and rounds down, so rounding never
    ///         loosens a maker's own limit.
    /// @dev    The window follows the loan's term and a term over 30 days
    ///         waits while the reference is unusual or not known; both rules
    ///         are the rate reference's ({IRateReference.linkedRate}).
    function rateLinkBound(address asset, uint256 termDays, uint8 kind, int16 marginBps, bool lenderSide)
        public
        view
        returns (uint256 boundBps, uint8 refusal)
    {
        (bool ok, IRateReference rr) = LibRateReference.tryReference();
        if (!ok) return (0, uint8(IRateReference.LinkRefusal.ReferenceUnavailable));
        (uint256 rate1e18, IRateReference.LinkRefusal why) =
            rr.linkedRate(asset, termDays, IRateReference.LinkKind(kind));
        if (why != IRateReference.LinkRefusal.None) return (0, uint8(why));
        // 1 bps = 1e14 at the 1e18 scale.
        uint256 base = lenderSide ? (rate1e18 + 1e14 - 1) / 1e14 : rate1e18 / 1e14;
        int256 linked = int256(base) + int256(marginBps);
        boundBps = linked > 0 ? uint256(linked) : 0;
    }

    /// @notice The effective rate bounds of a stored offer now: the typed
    ///         range tightened by its link, and why the link cannot be used
    ///         (0 when it can or the offer has none). A lender's floor is the
    ///         higher of its typed floor and the linked rate; a borrower's
    ///         ceiling the lower of its typed ceiling and the linked rate.
    ///         `termDays` is the term of the loan the fill would open.
    function offerRateBounds(uint256 offerId, uint256 termDays)
        public
        view
        returns (uint256 loBps, uint256 hiBps, uint8 refusal)
    {
        LibVaipakam.Offer storage o = LibVaipakam.storageSlot().offers[offerId];
        loBps = o.interestRateBps;
        hiBps = o.interestRateBpsMax == 0 ? o.interestRateBps : o.interestRateBpsMax;
        if (o.linkKind == 0) return (loBps, hiBps, 0);
        bool lender = o.offerType == LibVaipakam.OfferType.Lender;
        uint256 bound;
        (bound, refusal) = rateLinkBound(o.lendingAsset, termDays, o.linkKind, o.linkMarginBps, lender);
        if (refusal != 0) return (loBps, hiBps, refusal);
        if (lender) {
            if (bound > loBps) loBps = bound;
        } else if (bound < hiBps) {
            hiBps = bound;
        }
    }

    /// @notice Where `rateBps` for `termDays` sits against the warning band,
    ///         as every preview states it: the band itself and the warnings
    ///         mask the same rate would carry. No reference, or no term
    ///         average, means no band and an empty mask.
    function rateWarnings(address asset, uint256 termDays, uint256 rateBps)
        public
        view
        returns (uint8 warnings, IRateReference.Band memory band)
    {
        (bool ok, IRateReference rr) = LibRateReference.tryReference();
        if (!ok) return (0, band);
        band = rr.band(asset, termDays, rateBps);
        if (band.outside) warnings = band.above ? WARN_FAR_ABOVE : WARN_FAR_BELOW;
    }

    /// @notice The one band check on a write or take of a fixed rate
    ///         (#3713 section 6.4): refused by name when `rateBps` is outside
    ///         the band and the step does not carry its acknowledgement;
    ///         otherwise returns the warnings mask the step's event carries.
    function checkRateWrite(address asset, uint256 termDays, uint256 rateBps, bool acknowledged)
        public
        view
        returns (uint8 warnings)
    {
        IRateReference.Band memory band;
        (warnings, band) = rateWarnings(asset, termDays, rateBps);
        if (warnings != 0 && !acknowledged) {
            revert RateFarFromTermAverage(asset, termDays, rateBps, band.termAverage1e18 / 1e14, band.above);
        }
    }

    /// @notice The rate the warning band checks for stored offer `offerId`
    ///         (#3713 section 6.4, the design thread's ruling): a lender's
    ///         floor, a borrower's ceiling. `checked` is false for an offer
    ///         the band does not apply to: an NFT rental (its rate is a daily
    ///         fee) and a lender-sale offer (its rate is the sold loan's).
    function offerCheckedRate(uint256 offerId) public view returns (bool checked, uint256 rateBps) {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        LibVaipakam.Offer storage o = s.offers[offerId];
        if (o.assetType != LibVaipakam.AssetType.ERC20 || s.saleVehicleCreate || s.saleOfferToLoanId[offerId] != 0) {
            return (false, 0);
        }
        if (o.offerType == LibVaipakam.OfferType.Lender) return (true, o.interestRateBps);
        return (true, o.interestRateBpsMax == 0 ? o.interestRateBps : o.interestRateBpsMax);
    }

    /// @notice The one admission of a stored offer's rate terms, run by every
    ///         writer of an offer's rate (creation through
    ///         `OfferBookFacet.openOfferOnBook`, both edits on
    ///         `OfferMutateFacet`): refuses a link the offer may not carry,
    ///         then runs the band check on the offer's checked rate for its
    ///         own term. Returns the warnings mask the step's event carries.
    ///         An edit that leaves the checked rate unchanged passes
    ///         `acknowledged = true` (it asks for no new flag) and still gets
    ///         the mask the offer's rate now carries.
    /// @param offerId      The offer, already written with its new terms.
    /// @param acknowledged The step's `rateFarFromAverageAcknowledged`.
    /// @param linkWritten  The step wrote the link (a creation, or an edit
    ///                     of the link): only then is it admitted, so an edit
    ///                     of the amount never fails on a link written
    ///                     under an earlier reference.
    function admitOfferRate(uint256 offerId, bool acknowledged, bool linkWritten)
        external
        view
        returns (uint8 warnings)
    {
        LibVaipakam.Offer storage o = LibVaipakam.storageSlot().offers[offerId];
        (bool checked, uint256 rateBps) = offerCheckedRate(offerId);
        if (linkWritten && (o.linkKind != 0 || o.linkMarginBps != 0)) {
            // A link belongs on an ERC-20 lending offer only: never a rental,
            // a lender-sale offer or a refinance request.
            if (!checked || o.refinanceTargetLoanId != 0) revert RateLinkNotOffered();
            requireLinkAdmissible(o.lendingAsset, o.linkKind, o.linkMarginBps);
        }
        if (!checked) return 0;
        return checkRateWrite(o.lendingAsset, o.durationDays, rateBps, acknowledged);
    }

    /// @notice The rate a loan opens at from offer `offerId`, whether a market
    ///         link set it, and the taker's band check (#3635 A, #3713
    ///         section 6.4). Called once by `LoanFacet` for every loan it
    ///         opens, after it has booked `bookedRateBps`:
    ///         - a match (the match override is active) keeps the match rate,
    ///           already computed on both makers' effective bounds, and its
    ///           `rateFromLink`;
    ///         - a direct accept of a rate-linked offer opens at the offer's
    ///           effective endpoint for its term (a lender's effective floor,
    ///           a borrower's effective ceiling), refused while the link
    ///           cannot be used, and refused when that endpoint is worse for
    ///           a signing acceptor than the rate they signed;
    ///         - a taker step (a signed direct accept, or an instant-market
    ///           fill) is band-checked on the actual rate with its
    ///           acknowledgement. A third-party match asks for none.
    ///         A rental or a lender-sale offer returns `bookedRateBps`
    ///         unchanged: the band does not apply to it.
    function originationRate(uint256 offerId, uint256 bookedRateBps)
        external
        view
        returns (uint256 rateBps, bool fromLink)
    {
        rateBps = bookedRateBps;
        (bool checked,) = offerCheckedRate(offerId);
        if (!checked) return (rateBps, false);
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        LibVaipakam.Offer storage o = s.offers[offerId];
        bool matched = s.matchOverride.active;
        if (matched) {
            fromLink = s.matchOverride.rateFromLink;
        } else if (o.linkKind != 0) {
            bool lender = o.offerType == LibVaipakam.OfferType.Lender;
            (uint256 lo, uint256 hi, uint8 refusal) = offerRateBounds(offerId, o.durationDays);
            if (refusal != 0) revert RateLinkUnavailable(refusal);
            rateBps = lender ? lo : hi;
            fromLink = true;
            if (s.acceptAckActive) {
                uint256 limit = s.acceptAckRateLimitBps;
                if (lender ? rateBps > limit : rateBps < limit) revert RateBeyondAcceptorLimit(rateBps, limit);
            }
        }
        if (s.instantTakerActive) {
            checkRateWrite(o.lendingAsset, o.durationDays, rateBps, s.instantRateFarAck);
        } else if (s.acceptAckActive && !matched) {
            checkRateWrite(o.lendingAsset, o.durationDays, rateBps, s.acceptAckRateFarAck);
        }
    }

    /// @notice The warnings mask loan `loanId` opened with (#3719): bit 1 its
    ///         rate is far above the term average for its term, bit 2 far
    ///         below. Bit 0 (collateral concentration, #3685) is not set
    ///         here. A rental, or a loan with no reference or term average,
    ///         carries none.
    function loanRateWarnings(uint256 loanId) external view returns (uint8 warnings) {
        LibVaipakam.Loan storage l = LibVaipakam.storageSlot().loans[loanId];
        if (l.assetType != LibVaipakam.AssetType.ERC20) return 0;
        (warnings,) = rateWarnings(l.principalAsset, l.durationDays, l.interestRateBps);
    }

    /// @notice Refuse a link that may not be written: a kind that is not a
    ///         link kind, a margin beyond plus or minus the protocol maximum
    ///         rate, or an asset with no rate reference. `kind == 0` (no
    ///         link) always passes.
    function requireLinkAdmissible(address asset, uint8 kind, int16 marginBps) public view {
        if (kind == 0) {
            if (marginBps != 0) revert RateLinkInvalid(kind, marginBps);
            return;
        }
        int256 maxRate = int256(LibVaipakam.MAX_INTEREST_BPS);
        if (kind > uint8(IRateReference.LinkKind.TermAverage) || marginBps > maxRate || marginBps < -maxRate) {
            revert RateLinkInvalid(kind, marginBps);
        }
        (bool ok, IRateReference rr) = LibRateReference.tryReference();
        if (!ok || rr.newestSeries(asset) == 0) revert RateLinkNoReference(asset);
    }
}
