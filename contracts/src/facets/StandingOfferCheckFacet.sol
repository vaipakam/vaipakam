// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {LibVaipakam} from "../libraries/LibVaipakam.sol";
import {LibOfferMatch} from "../libraries/LibOfferMatch.sol";
import {OfferAcceptFacet} from "./OfferAcceptFacet.sol";
import {OfferPreviewFacet} from "./OfferPreviewFacet.sol";
import {OfferMatchFacet} from "./OfferMatchFacet.sol";

/**
 * @title  StandingOfferCheckFacet
 * @notice #3720 — check ONE standing lender offer a caller points to (a front
 *         end finds it through the indexer) against a borrower's quote, so any
 *         front end can say "a better standing offer exists" without trusting
 *         the platform's indexer for the figure (`IntegratorFeeShareDesign.md`
 *         section 7).
 *
 *         A borrower can take a standing lender offer in only two ways, and
 *         the check runs the platform's own preview of the one that applies:
 *
 *         - **A posted request** ({checkAgainstRequest}): the borrower's own
 *           stored borrower offer, matched against the standing offer. The
 *           match preview's refusals are the test, and the borrower the verdict
 *           speaks for is that request's creator.
 *         - **No posted request** ({checkForAmount}): a direct accept, which
 *           always lends the offer's whole open amount. So a borrower with no
 *           request can be checked only against an offer of exactly its
 *           amount; for any other amount no path exists to test, and the
 *           answer is "not comparable", never "none better".
 *
 *         The check speaks only for the offer it was pointed to: it never says
 *         an offer is the best on the book, and with no offer it answers "not
 *         checked". Nothing that writes reads it, and it carries no copy of a
 *         refusal rule: every refusal is the accept or match preview's own.
 * @dev    Its own facet because OfferPreviewFacet has about 225 bytes of
 *         EIP-170 room. The risk-access gate is outside both previews and
 *         outside this check, as it is for the accept preview
 *         (`RiskPreviewFacet` reports it).
 */
contract StandingOfferCheckFacet {
    /// @notice The four answers. `NotComparable` means no path exists to test
    ///         (a borrower with no posted request wanting part of the offer);
    ///         it never means "no better offer".
    enum Verdict {
        NotChecked,
        NotComparable,
        Refused,
        Checked
    }

    /// @notice Which rule refused, when the verdict is `Refused`.
    ///         `NoSuchOffer`: the pointed offer does not exist (or was
    ///         deleted). `NotALenderOffer`: it is a borrower offer.
    ///         `DifferentTerms`: its assets or term are not the ones quoted
    ///         (accept path only; the match preview checks terms itself).
    ///         `Accept` / `Match`: the preview's own refusal, in `code` (an
    ///         `OfferAcceptFacet.AcceptError` or `LibOfferMatch.MatchError`).
    enum RefusedBy {
        None,
        NoSuchOffer,
        NotALenderOffer,
        DifferentTerms,
        Accept,
        Match
    }

    /// @notice One check's answer. Figures are set only when `Checked`.
    /// @param rateBps    The rate the accept or match would produce.
    /// @param amount     The amount it would lend.
    /// @param beatsQuote True only when it would lend the borrower's whole
    ///                   amount at a strictly lower rate than the quote. A
    ///                   part fill reports its figures with this false.
    struct Check {
        Verdict verdict;
        RefusedBy refusedBy;
        uint8 code;
        uint256 offerId;
        uint256 rateBps;
        uint256 amount;
        bool beatsQuote;
    }

    /**
     * @notice Check standing lender offer `standingOfferId` for the borrower
     *         who posted request `borrowerOfferId`, against `quotedRateBps`.
     *         The borrower's whole amount is the request's open maximum.
     * @param standingOfferId 0 answers `NotChecked`.
     */
    function checkAgainstRequest(uint256 standingOfferId, uint256 borrowerOfferId, uint256 quotedRateBps)
        external
        view
        returns (Check memory c)
    {
        c.offerId = standingOfferId;
        if (!_pointedLenderOffer(c)) return c;
        LibVaipakam.Offer storage request = LibVaipakam.storageSlot().offers[borrowerOfferId];
        address borrower = request.creator;
        LibOfferMatch.MatchResult memory r = OfferMatchFacet(address(this)).previewMatch(
            standingOfferId, borrowerOfferId, borrower, borrower
        );
        if (r.errorCode != LibOfferMatch.MatchError.Ok) {
            return _refused(c, RefusedBy.Match, uint8(r.errorCode));
        }
        uint256 whole = request.amountMax - request.amountFilled;
        return _checked(c, r.matchRateBps, r.matchAmount, whole, quotedRateBps);
    }

    /**
     * @notice Check standing lender offer `standingOfferId` for `borrower`,
     *         who has no posted request and wants `amount` of `lendingAsset`
     *         against `collateralAsset` for `durationDays`, quoted at
     *         `quotedRateBps`. Only a direct accept can take it, and a direct
     *         accept lends the offer's whole open amount, so any other amount
     *         is `NotComparable`.
     * @param standingOfferId 0 answers `NotChecked`.
     */
    function checkForAmount(
        uint256 standingOfferId,
        address borrower,
        address lendingAsset,
        address collateralAsset,
        uint256 durationDays,
        uint256 amount,
        uint256 quotedRateBps
    ) external view returns (Check memory c) {
        c.offerId = standingOfferId;
        if (!_pointedLenderOffer(c)) return c;
        LibVaipakam.Offer storage offer = LibVaipakam.storageSlot().offers[standingOfferId];
        if (
            offer.lendingAsset != lendingAsset || offer.collateralAsset != collateralAsset
                || offer.durationDays != durationDays
        ) return _refused(c, RefusedBy.DifferentTerms, 0);
        if (amount != offer.amountMax - offer.amountFilled) {
            c.verdict = Verdict.NotComparable;
            return c;
        }
        OfferAcceptFacet.AcceptPreview memory p =
            OfferPreviewFacet(address(this)).previewAccept(standingOfferId, borrower);
        if (p.errorCode != OfferAcceptFacet.AcceptError.None) {
            return _refused(c, RefusedBy.Accept, uint8(p.errorCode));
        }
        return _checked(c, p.interestRateBps, p.effectivePrincipal, amount, quotedRateBps);
    }

    /// @dev Answers NotChecked for no offer and Refused for an id that names
    ///      no lender offer; true when the check goes on.
    function _pointedLenderOffer(Check memory c) private view returns (bool) {
        if (c.offerId == 0) return false; // NotChecked
        LibVaipakam.Offer storage offer = LibVaipakam.storageSlot().offers[c.offerId];
        if (offer.creator == address(0)) {
            _refused(c, RefusedBy.NoSuchOffer, 0);
            return false;
        }
        if (offer.offerType != LibVaipakam.OfferType.Lender) {
            _refused(c, RefusedBy.NotALenderOffer, 0);
            return false;
        }
        return true;
    }

    function _refused(Check memory c, RefusedBy by, uint8 code) private pure returns (Check memory) {
        c.verdict = Verdict.Refused;
        c.refusedBy = by;
        c.code = code;
        return c;
    }

    function _checked(Check memory c, uint256 rateBps, uint256 amount, uint256 whole, uint256 quotedRateBps)
        private
        pure
        returns (Check memory)
    {
        c.verdict = Verdict.Checked;
        c.rateBps = rateBps;
        c.amount = amount;
        c.beatsQuote = amount == whole && rateBps < quotedRateBps;
        return c;
    }
}
