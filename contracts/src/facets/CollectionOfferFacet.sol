// src/facets/CollectionOfferFacet.sol
// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {LibVaipakam} from "../libraries/LibVaipakam.sol";
import {LibTiming} from "../libraries/LibTiming.sol";
import {LibFacet} from "../libraries/LibFacet.sol";
import {LibCollateralSet} from "../libraries/LibCollateralSet.sol";
import {LibPositionNFT} from "../libraries/LibPositionNFT.sol";
import {LibMetricsHooks} from "../libraries/LibMetricsHooks.sol";
import {LibIntentFill} from "../libraries/LibIntentFill.sol";
import {LibOfferMatchExecute} from "../libraries/LibOfferMatchExecute.sol";
import {LibServiceCapacity} from "../libraries/LibServiceCapacity.sol";
import {LibVaultOutflow} from "../libraries/LibVaultOutflow.sol";
import {LibOfferRefund} from "../libraries/LibOfferRefund.sol";
import {LibAccessControl, DiamondAccessControl} from "../libraries/LibAccessControl.sol";
import {DiamondReentrancyGuard} from "../libraries/LibReentrancyGuard.sol";
import {DiamondPausable} from "../libraries/LibPausable.sol";
import {LibAcceptTerms} from "../libraries/LibAcceptTerms.sol";
import {LibSignedOffer} from "../libraries/LibSignedOffer.sol";
import {IVaipakamErrors} from "../interfaces/IVaipakamErrors.sol";
import {OfferCreateFacet} from "./OfferCreateFacet.sol";
import {OfferMaterializeFacet} from "./OfferMaterializeFacet.sol";
import {OfferAcceptFacet} from "./OfferAcceptFacet.sol";
import {OfferMatchFacet} from "./OfferMatchFacet.sol";
import {EncumbranceMutateFacet} from "./EncumbranceMutateFacet.sol";

/**
 * @title  CollectionOfferFacet
 * @author Vaipakam Developer Team
 * @notice NFT collection offers (#3328): one lender offer against a SET of
 *         collateral tokens (a whole collection, an id range, or a listed
 *         set such as the ids with a trait) for a stated number of loans.
 * @dev    The offer is a parent lender offer on the book. Its principal is
 *         reserved for every loan (`amount` = `amountMax` = principal per
 *         loan × loans; `amountFilled` counts what fills have drawn) and
 *         the side record `collectionOffer[offerId]` holds the set, the
 *         principal per loan, the loans and the fills. The parent never
 *         fills directly: plain accept and match refuse it
 *         (`CollectionParentNotFillable`). Each fill draws one loan's
 *         principal from the parent's reserve and materializes a one-token
 *         lender slice (`OfferMaterializeFacet.createCollectionSlice`), which
 *         the borrower then accepts through the ordinary accept
 *         (`fillCollectionOffer`) or a matcher pairs with a posted borrower
 *         offer through the match core (`matchCollectionOffer`). Every
 *         origination check of those paths applies to the slice; this facet
 *         adds the set's own checks (`takeFailure`, the one rule the fill
 *         and the view `wouldTake` both read). A failed fill reverts whole,
 *         so the parent's count and reserve are restored exactly.
 */
contract CollectionOfferFacet is DiamondReentrancyGuard, DiamondPausable, DiamondAccessControl, IVaipakamErrors {
    /// @notice Default and bounds of the most loans one offer funds.
    uint16 internal constant DEFAULT_MAX_LOANS = 50;
    uint16 internal constant MAX_MAX_LOANS = 200;
    /// @notice Default and bounds of the longest offer lifetime.
    uint32 internal constant DEFAULT_MAX_EXPIRY = 30 days;
    uint32 internal constant MIN_MAX_EXPIRY = 1 days;
    uint32 internal constant MAX_MAX_EXPIRY = 90 days;
    /// @notice The most ids a creation event publishes in full.
    uint256 internal constant MAX_PUBLISHED_IDS = 256;

    /// @notice Why a collection offer would not take a token now. `None`
    ///         means it would (the slice's own accept or match checks still
    ///         apply).
    enum TakeFailure {
        None,
        NotCollectionOffer,
        Closed,
        Expired,
        TermsTooFresh,
        NoLoansLeft,
        OwnOffer,
        NotInSet
    }

    /// @notice A collection offer was posted. `publishedIds` is the full
    ///         list of a Listed set when its lender published it on-chain
    ///         (at most 256 ids); empty otherwise, when `listHash` names the
    ///         list file the app and indexer keep.
    /// @custom:event-category state-change/offer-mutation
    event CollectionOfferCreated(
        uint256 indexed offerId,
        address indexed lender,
        LibVaipakam.CollateralSetKind kind,
        uint256 perLoan,
        uint16 loans,
        uint256 low,
        uint256 high,
        bytes32 root,
        uint32 listCount,
        bytes32 listHash,
        string label,
        uint256[] exclusions,
        uint256[] publishedIds
    );
    /// @notice One loan opened from a collection offer, against `tokenId`,
    ///         through the one-token slice `sliceOfferId`.
    /// @custom:event-category state-change/offer-mutation
    event CollectionOfferFilled(
        uint256 indexed offerId,
        uint256 indexed loanId,
        uint256 tokenId,
        uint256 sliceOfferId,
        uint16 loansLeft
    );
    /// @notice The lender lowered the loans left; `released` principal went
    ///         back to their wallet.
    /// @custom:event-category state-change/offer-mutation
    event CollectionOfferReduced(uint256 indexed offerId, uint16 loansLeftBefore, uint16 loansLeft, uint256 released);
    /// @notice The collection-offer limits changed.
    event CollectionOfferLimitsSet(uint16 maxLoans, uint32 maxExpirySecs);

    /// @notice The offer is not a collection offer.
    error NotCollectionOffer(uint256 offerId);
    /// @notice The collection offer would not take the token now.
    error CollectionTakeRefused(uint256 offerId, uint256 tokenId, TakeFailure reason);
    /// @notice A collection offer lends an ERC-20 against ERC-721 or
    ///         ERC-1155 collateral, at one amount and one rate, with no
    ///         refinance target; the collateral may not be a platform
    ///         position token.
    error CollectionOfferShape();
    /// @notice The number of loans is zero or above the limit.
    error CollectionLoansOutOfRange(uint256 loans, uint256 max);
    /// @notice A collection offer must expire, no later than the limit.
    error CollectionExpiryOutOfRange(uint256 expiresAt, uint256 latest);
    /// @notice The published ids are for a Listed set only, at most 256 of
    ///         them, and as many as the stated count.
    error CollectionPublishedIdsInvalid();
    /// @notice A reduction must leave at least one loan and fewer than are
    ///         left now (to withdraw the offer whole, cancel it).
    error CollectionReductionInvalid(uint16 loansLeft, uint16 requested);
    /// @notice Only the offer's lender (its account manager) may do this.
    error NotCollectionOfferLender();

    /// @notice #3328 — what a borrower presents to fill a signed collection
    ///         offer: the token, its Listed-set proof (empty otherwise), and
    ///         the excluded ids the signed `exclusionsHash` names (empty when
    ///         none).
    struct SignedTake {
        uint256 tokenId;
        bytes32[] proof;
        uint256[] exclusions;
    }

    /// @notice One loan opened from a SIGNED collection offer, against
    ///         `tokenId`, through the one-token slice `sliceOfferId`;
    ///         `loansLeft` is how many more the order admits.
    /// @custom:event-category state-change/offer-mutation
    event SignedCollectionOfferFilled(
        bytes32 indexed orderHash,
        address indexed signer,
        address indexed borrower,
        uint256 tokenId,
        uint256 sliceOfferId,
        uint256 loanId,
        uint16 loansLeft
    );
    /// @notice A signed collection offer must have started (its signed start
    ///         time is not in the future) and must expire, and its signature
    ///         deadline must pass, no later than the start time plus the
    ///         longest lifetime.
    error SignedCollectionLifetimeInvalid(uint64 startTime, uint64 expiresAt, uint256 deadline, uint256 latest);
    /// @notice The signed collection offer would not take the token: the
    ///         caller is its maker, it has no loans left, or the token is not
    ///         in its set.
    error SignedCollectionTakeRefused(bytes32 orderHash, uint256 tokenId, TakeFailure reason);

    // ─── Settings ─────────────────────────────────────────────────────────

    /// @notice Set the most loans one offer funds (1 to 200) and the longest
    ///         time from creation to expiry (1 to 90 days).
    function setCollectionOfferLimits(uint16 maxLoans, uint32 maxExpirySecs)
        external
        onlyRole(LibAccessControl.ADMIN_ROLE)
    {
        if (maxLoans == 0 || maxLoans > MAX_MAX_LOANS) {
            revert ParameterOutOfRange("collectionMaxLoans", maxLoans, 1, MAX_MAX_LOANS);
        }
        if (maxExpirySecs < MIN_MAX_EXPIRY || maxExpirySecs > MAX_MAX_EXPIRY) {
            revert ParameterOutOfRange("collectionMaxExpiry", maxExpirySecs, MIN_MAX_EXPIRY, MAX_MAX_EXPIRY);
        }
        LibVaipakam.CollectionOfferConfig storage c = LibVaipakam.storageSlot().collectionCfg;
        c.maxLoans = maxLoans;
        c.maxExpirySecs = maxExpirySecs;
        emit CollectionOfferLimitsSet(maxLoans, maxExpirySecs);
    }

    /// @notice The collection-offer limits in effect.
    function getCollectionOfferLimits() public view returns (uint16 maxLoans, uint32 maxExpirySecs) {
        LibVaipakam.CollectionOfferConfig storage c = LibVaipakam.storageSlot().collectionCfg;
        maxLoans = c.maxLoans == 0 ? DEFAULT_MAX_LOANS : c.maxLoans;
        maxExpirySecs = c.maxExpirySecs == 0 ? DEFAULT_MAX_EXPIRY : c.maxExpirySecs;
    }

    // ─── The lender ───────────────────────────────────────────────────────

    /// @notice Post a collection offer: lend `params.amount` against any one
    ///         token of `set`, for up to `loans` loans. The principal for
    ///         every loan is pulled from the caller's wallet now and reserved
    ///         to the offer. `params.collateralTokenId` is ignored (each fill
    ///         names its token); for ERC-1155, `params.collateralQuantity` is
    ///         the quantity every loan takes. The caller's illiquid-collateral
    ///         consent covers every token in the set.
    /// @param params       The terms of each loan; `amount` is per loan.
    /// @param set          The collateral set.
    /// @param loans        The number of loans the offer funds.
    /// @param publishedIds A Listed set's full id list, when the lender
    ///                     publishes it on-chain (at most 256; else empty).
    /// @param validUntil   The latest time this request may land.
    /// @return offerId     The parent offer id.
    function createCollectionOffer(
        LibVaipakam.CreateOfferParams calldata params,
        LibCollateralSet.SetInput calldata set,
        uint16 loans,
        uint256[] calldata publishedIds,
        uint64 validUntil
    ) external nonReentrant whenNotPaused returns (uint256 offerId) {
        LibTiming.requireDeadline(validUntil);
        _checkShape(params, set, loans, publishedIds);
        offerId = _createParent(params, loans);
        LibVaipakam.CollectionOffer storage c = LibVaipakam.storageSlot().collectionOffer[offerId];
        LibCollateralSet.write(c.set, set);
        c.perLoan = params.amount;
        c.loans = loans;
        _emitCreated(offerId, params.amount, loans, set, publishedIds);
    }

    /// @notice Lower the loans a collection offer still funds to
    ///         `loansLeft`; the released principal goes to the vault of the
    ///         holder of the offer's position token as free balance (#3744,
    ///         payout rule 2026-11-19). For that holder's account manager.
    ///         At least one loan must stay; to withdraw the offer whole,
    ///         cancel it.
    function reduceCollectionLoans(uint256 offerId, uint16 loansLeft) external nonReentrant whenNotPaused {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        LibVaipakam.CollectionOffer storage c = s.collectionOffer[offerId];
        LibVaipakam.Offer storage p = s.offers[offerId];
        if (c.set.kind == LibVaipakam.CollateralSetKind.None) revert NotCollectionOffer(offerId);
        if (!LibOfferRefund.managedBy(p, msg.sender)) revert NotCollectionOfferLender();
        TakeFailure open = _openFailure(s, offerId, p);
        if (open != TakeFailure.None) revert CollectionTakeRefused(offerId, 0, open);
        uint16 left = c.loans - c.filled;
        if (loansLeft == 0 || loansLeft >= left) revert CollectionReductionInvalid(left, loansLeft);
        uint16 cut = left - loansLeft;
        uint256 released = uint256(cut) * c.perLoan;
        c.loans -= cut;
        p.amount -= released;
        p.amountMax -= released;
        _decrementReserve(offerId, released);
        LibOfferRefund.refund(offerId, LibVaultOutflow.ERC20, p.lendingAsset, 0, released, true);
        emit CollectionOfferReduced(offerId, left, loansLeft, released);
    }

    // ─── Fills ────────────────────────────────────────────────────────────

    /// @notice Borrow from a collection offer against your token `tokenId`
    ///         (`proof` proves a Listed set's membership; empty otherwise).
    ///         The token is taken from your wallet as in any accept.
    /// @param terms The caller's signed acceptance of the one-token loan:
    ///        its `offerKey` is {fillKey}`(offerId, tokenId)` and every
    ///        loan-affecting field binds against the slice (the parent's
    ///        terms with this token), including the risk-and-terms consent.
    function fillCollectionOffer(
        uint256 offerId,
        uint256 tokenId,
        bytes32[] calldata proof,
        LibAcceptTerms.AcceptTerms calldata terms,
        bytes calldata signature
    ) external nonReentrant whenNotPaused returns (uint256 loanId) {
        uint256 slice = _drawSlice(offerId, tokenId, proof, msg.sender);
        OfferAcceptFacet(address(this)).verifyAndBindAccept(slice, fillKey(offerId, tokenId), terms, signature, msg.sender);
        loanId = _acceptSlice(slice, terms.riskAndTermsConsent);
        _afterFill(LibVaipakam.storageSlot(), offerId, tokenId, slice, loanId);
    }

    /// @notice Borrow from a SIGNED collection offer against your token
    ///         (design section 6). Nothing was reserved when the lender
    ///         signed: the loan's principal is drawn from the lender's free
    ///         vault balance now, and a fill that finds it short is refused.
    ///         Each fill is one loan of the signed per-loan `amount`; the
    ///         order's fill ledger admits at most `loans` of them, and every
    ///         signed-offer check applies (fee caps, taker, co-signer,
    ///         nonce, cancel floor, deadline, expiry).
    /// @param take  The token, its Listed-set proof, and the excluded ids
    ///        the signed `exclusionsHash` names.
    /// @param terms The caller's signed acceptance of the one-token loan:
    ///        its `offerKey` is {signedFillKey}`(orderHash, tokenId)`.
    function fillSignedCollectionOffer(
        LibSignedOffer.SignedOffer calldata o,
        bytes calldata sig,
        LibSignedOffer.OfferSet calldata set,
        SignedTake calldata take,
        LibAcceptTerms.AcceptTerms calldata terms,
        bytes calldata acceptSig,
        LibSignedOffer.FillAuth calldata auth
    ) external nonReentrant whenNotPaused returns (uint256 loanId) {
        bytes32 orderHash = LibSignedOffer.hashStruct(o);
        LibSignedOffer.requireFillable(o, orderHash, msg.sender, o.amount, auth, true);
        (bool ok, ) = LibSignedOffer.verify(o, sig, set);
        if (!ok) revert LibSignedOffer.SignedOfferBadSignature();
        _requireSignedTake(o, orderHash, take);
        // Consume one loan BEFORE any external interaction (CEI).
        uint256 filledBefore = _consumeSignedLoan(o, orderHash, take.tokenId);
        uint256 slice = _materializeSignedSlice(o, take.tokenId, filledBefore);
        OfferAcceptFacet(address(this)).verifyAndBindAccept(
            slice, signedFillKey(orderHash, take.tokenId), terms, acceptSig, msg.sender
        );
        loanId = _acceptSlice(slice, terms.riskAndTermsConsent);
        emit SignedCollectionOfferFilled(
            orderHash, o.signer, msg.sender, take.tokenId, slice, loanId, uint16(o.loans - (filledBefore / o.amount) - 1)
        );
    }

    /// @notice Pair a collection offer with a posted borrower offer whose
    ///         collateral token is in the set. Anyone may call it; the caller
    ///         is the matcher and earns the match share like any match.
    function matchCollectionOffer(uint256 offerId, uint256 borrowerOfferId, bytes32[] calldata proof)
        external
        nonReentrant
        whenNotPaused
        returns (uint256 loanId)
    {
        // The same gates `matchOffers` applies to its caller: the matcher is
        // paid a match share, so it is screened; matching is off until the
        // switch is on; the solver capacity charge comes last.
        LibVaipakam._assertNotSanctioned(msg.sender);
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        if (!s.protocolCfg.partialFillEnabled) revert LibOfferMatchExecute.FunctionDisabled(3);
        LibVaipakam.Offer storage b = s.offers[borrowerOfferId];
        uint256 tokenId = b.collateralTokenId;
        uint256 slice = _drawSlice(offerId, tokenId, proof, b.creator);
        // One runtime copy of the match core, on OfferMatchFacet.
        loanId = abi.decode(
            LibFacet.crossFacetCallReturn(
                abi.encodeWithSelector(
                    OfferMatchFacet.matchCoreInternal.selector, slice, borrowerOfferId, msg.sender
                ),
                bytes4(0)
            ),
            (uint256)
        );
        LibIntentFill.retireLenderSlice(s, slice);
        _afterFill(s, offerId, tokenId, slice, loanId);
        LibServiceCapacity.chargeSolver();
    }

    // ─── Views ────────────────────────────────────────────────────────────

    /// @notice The `AcceptTerms.offerKey` a borrower signs to fill SIGNED
    ///         collection offer `orderHash` with `tokenId`.
    function signedFillKey(bytes32 orderHash, uint256 tokenId) public pure returns (bytes32) {
        return keccak256(abi.encode("vaipakam.signed-collection-fill", orderHash, tokenId));
    }

    /// @notice The `AcceptTerms.offerKey` a borrower signs to fill collection
    ///         offer `offerId` with `tokenId`.
    function fillKey(uint256 offerId, uint256 tokenId) public pure returns (bytes32) {
        return keccak256(abi.encode("vaipakam.collection-fill", offerId, tokenId));
    }

    /// @notice Whether collection offer `offerId` would take `tokenId` from
    ///         `taker` now, and if not, why. The fill refuses with exactly
    ///         this reason; the slice's own accept or match checks (consent,
    ///         risk access, sanctions, loan-to-value) come after it.
    function wouldTake(uint256 offerId, uint256 tokenId, bytes32[] calldata proof, address taker)
        external
        view
        returns (TakeFailure)
    {
        return takeFailure(offerId, tokenId, proof, taker);
    }

    /// @notice A collection offer's record: its set, principal per loan,
    ///         loans funded and loans filled.
    function getCollectionOffer(uint256 offerId)
        external
        view
        returns (LibVaipakam.CollateralSet memory set, uint256 perLoan, uint16 loans, uint16 filled)
    {
        LibVaipakam.CollectionOffer storage c = LibVaipakam.storageSlot().collectionOffer[offerId];
        return (c.set, c.perLoan, c.loans, c.filled);
    }

    /// @notice The one rule of whether `offerId` takes `tokenId` from
    ///         `taker` now (see {wouldTake}).
    function takeFailure(uint256 offerId, uint256 tokenId, bytes32[] calldata proof, address taker)
        public
        view
        returns (TakeFailure)
    {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        LibVaipakam.CollectionOffer storage c = s.collectionOffer[offerId];
        if (c.set.kind == LibVaipakam.CollateralSetKind.None) return TakeFailure.NotCollectionOffer;
        LibVaipakam.Offer storage p = s.offers[offerId];
        TakeFailure open = _openFailure(s, offerId, p);
        if (open != TakeFailure.None) return open;
        if (block.timestamp < LibTiming.termsReadyAt(p.termsSetAt)) return TakeFailure.TermsTooFresh;
        if (c.filled >= c.loans) return TakeFailure.NoLoansLeft;
        if (taker == p.creator) return TakeFailure.OwnOffer;
        if (!LibCollateralSet.contains(c.set, tokenId, proof)) return TakeFailure.NotInSet;
        return TakeFailure.None;
    }

    // ─── Internals ────────────────────────────────────────────────────────

    /// @dev Closed (taken off the book, cancelled or never created) or expired.
    function _openFailure(LibVaipakam.Storage storage s, uint256 offerId, LibVaipakam.Offer storage p)
        private
        view
        returns (TakeFailure)
    {
        if (p.creator == address(0) || p.accepted || s.offerCancelled[offerId]) return TakeFailure.Closed;
        if (LibVaipakam.isOfferExpired(p)) return TakeFailure.Expired;
        return TakeFailure.None;
    }

    /// @dev The set's checks, then one loan drawn from the parent's reserve
    ///      and the one-token lender slice made from it.
    function _drawSlice(uint256 offerId, uint256 tokenId, bytes32[] calldata proof, address taker)
        private
        returns (uint256 slice)
    {
        TakeFailure f = takeFailure(offerId, tokenId, proof, taker);
        if (f != TakeFailure.None) revert CollectionTakeRefused(offerId, tokenId, f);
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        LibVaipakam.CollectionOffer storage c = s.collectionOffer[offerId];
        LibVaipakam.Offer storage p = s.offers[offerId];
        uint256 perLoan = c.perLoan;
        c.filled += 1;
        p.amountFilled += perLoan;
        _decrementReserve(offerId, perLoan);
        bytes memory res = LibFacet.crossFacetCallReturn(
            abi.encodeWithSelector(
                OfferMaterializeFacet.createCollectionSlice.selector,
                p.creator,
                _sliceParams(p, perLoan, tokenId),
                LibSignedOffer.MakerFull(p.creatorFull, p.creatorMaxCStar, p.creatorAllowFullDowngrade)
            ),
            bytes4(0)
        );
        slice = abi.decode(res, (uint256));
    }

    /// @dev The slice: the parent's terms for one loan against `tokenId`.
    function _sliceParams(LibVaipakam.Offer storage p, uint256 perLoan, uint256 tokenId)
        private
        view
        returns (LibVaipakam.CreateOfferParams memory q)
    {
        q.offerType = LibVaipakam.OfferType.Lender;
        q.lendingAsset = p.lendingAsset;
        q.amount = perLoan;
        q.amountMax = perLoan;
        q.interestRateBps = p.interestRateBps;
        q.interestRateBpsMax = p.interestRateBps;
        q.collateralAsset = p.collateralAsset;
        q.collateralAmount = p.collateralAmount;
        q.collateralAmountMax = p.collateralAmount;
        q.durationDays = p.durationDays;
        q.assetType = LibVaipakam.AssetType.ERC20;
        q.creatorRiskAndTermsConsent = p.creatorRiskAndTermsConsent;
        q.collateralAssetType = p.collateralAssetType;
        q.collateralTokenId = tokenId;
        q.collateralQuantity = p.collateralQuantity;
        q.allowsPartialRepay = p.allowsPartialRepay;
        q.periodicInterestCadence = p.periodicInterestCadence;
        q.expiresAt = p.expiresAt;
        q.fillMode = LibVaipakam.FillMode.Aon;
        q.allowsPrepayListing = p.allowsPrepayListing;
        q.useFullTermInterest = p.useFullTermInterest;
        q.lifecycleFlex = p.lifecycleFlex;
    }

    function _afterFill(LibVaipakam.Storage storage s, uint256 offerId, uint256 tokenId, uint256 slice, uint256 loanId)
        private
    {
        LibVaipakam.CollectionOffer storage c = s.collectionOffer[offerId];
        uint16 left = c.loans - c.filled;
        emit CollectionOfferFilled(offerId, loanId, tokenId, slice, left);
        if (left == 0) _closeSpent(s, offerId, s.offers[offerId]);
    }

    /// @dev Every loan filled or reduced away: the parent leaves the book the
    ///      way a fully filled lender offer does.
    function _closeSpent(LibVaipakam.Storage storage s, uint256 offerId, LibVaipakam.Offer storage p) private {
        LibFacet.crossFacetCall(
            abi.encodeWithSelector(EncumbranceMutateFacet.releaseOfferPrincipalLien.selector, offerId),
            bytes4(0)
        );
        p.accepted = true;
        delete s.offerIdByPositionTokenId[p.positionTokenId];
        LibMetricsHooks.onOfferAccepted(offerId);
        emit LibOfferMatchExecute.OfferClosed(offerId, LibOfferMatchExecute.OfferCloseReason.FullyFilled);
    }

    /// @dev The one seam every draw on the parent's reserve passes (a fill or
    ///      a reduction). The reserve is the parent token's backing, so the
    ///      parent offer's own token is marked here (#3710 §3.1): its state
    ///      number goes up and it waits, so a price agreed against the larger
    ///      reserve cannot fill against the smaller one.
    function _decrementReserve(uint256 offerId, uint256 amount) private {
        LibFacet.crossFacetCall(
            abi.encodeWithSelector(EncumbranceMutateFacet.decrementOfferPrincipalLien.selector, offerId, amount),
            bytes4(0)
        );
        LibPositionNFT.markOfferValueOut(offerId);
    }

    function _checkShape(
        LibVaipakam.CreateOfferParams calldata params,
        LibCollateralSet.SetInput calldata set,
        uint16 loans,
        uint256[] calldata publishedIds
    ) private view {
        if (
            params.offerType != LibVaipakam.OfferType.Lender
                || params.assetType != LibVaipakam.AssetType.ERC20
                || params.collateralAssetType == LibVaipakam.AssetType.ERC20
                || params.collateralAsset == LibPositionNFT._storage().core
                || params.refinanceTargetLoanId != 0
                || (params.amountMax != 0 && params.amountMax != params.amount)
                || (params.interestRateBpsMax != 0 && params.interestRateBpsMax != params.interestRateBps)
                || (params.collateralAmountMax != 0 && params.collateralAmountMax != params.collateralAmount)
        ) revert CollectionOfferShape();
        LibCollateralSet.validate(set);
        (uint16 maxLoans, uint32 maxExpiry) = getCollectionOfferLimits();
        if (loans == 0 || loans > maxLoans) revert CollectionLoansOutOfRange(loans, maxLoans);
        uint256 latest = block.timestamp + maxExpiry;
        if (params.expiresAt == 0 || params.expiresAt > latest) {
            revert CollectionExpiryOutOfRange(params.expiresAt, latest);
        }
        uint256 n = publishedIds.length;
        if (
            n != 0
                && (set.kind != LibVaipakam.CollateralSetKind.Listed || n > MAX_PUBLISHED_IDS || n != set.listCount)
        ) revert CollectionPublishedIdsInvalid();
    }

    /// @dev The parent offer through the one creation rule: the principal of
    ///      every loan pulled and reserved, the book bounds applied (the
    ///      parent counts once toward the open-offer cap).
    function _createParent(LibVaipakam.CreateOfferParams calldata params, uint16 loans)
        private
        returns (uint256 offerId)
    {
        LibVaipakam.CreateOfferParams memory q = params;
        q.amount = params.amount * loans;
        q.amountMax = q.amount;
        q.interestRateBpsMax = params.interestRateBps;
        q.collateralAmountMax = params.collateralAmount;
        q.collateralTokenId = 0;
        q.fillMode = LibVaipakam.FillMode.Aon;
        bytes memory res = LibFacet.crossFacetCallReturn(
            abi.encodeWithSelector(OfferCreateFacet.createCollectionParent.selector, msg.sender, q),
            bytes4(0)
        );
        offerId = abi.decode(res, (uint256));
    }

    function _emitCreated(
        uint256 offerId,
        uint256 perLoan,
        uint16 loans,
        LibCollateralSet.SetInput calldata set,
        uint256[] calldata publishedIds
    ) private {
        emit CollectionOfferCreated(
            offerId, msg.sender, set.kind, perLoan, loans, set.low, set.high, set.root,
            set.listCount, set.listHash, set.label, set.exclusions, publishedIds
        );
    }

    /// @dev Route the slice through the ordinary accept, as the caller.
    function _acceptSlice(uint256 slice, bool consent) private returns (uint256 loanId) {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        s.signedOfferAcceptor = msg.sender;
        bytes memory res = LibFacet.crossFacetCallReturn(
            abi.encodeWithSelector(OfferAcceptFacet.acceptOfferInternal.selector, slice, consent),
            bytes4(0)
        );
        s.signedOfferAcceptor = address(0);
        loanId = abi.decode(res, (uint256));
    }

    /// @dev The signed collection offer's own checks: its shape (the on-chain
    ///      form's), its loan count, its lifetime from the signed start time,
    ///      the set's terms, and the caller's token in the set.
    function _requireSignedTake(LibSignedOffer.SignedOffer calldata o, bytes32 orderHash, SignedTake calldata take)
        private
        view
    {
        if (
            o.offerType != uint8(LibVaipakam.OfferType.Lender)
                || o.setKind > uint8(LibVaipakam.CollateralSetKind.Listed)
                || o.assetType != uint8(LibVaipakam.AssetType.ERC20)
                || o.collateralAssetType == uint8(LibVaipakam.AssetType.ERC20)
                || o.collateralAsset == LibPositionNFT._storage().core
                || o.refinanceTargetLoanId != 0
                || o.amount == 0
                || (o.amountMax != 0 && o.amountMax != o.amount)
                || (o.interestRateBpsMax != 0 && o.interestRateBpsMax != o.interestRateBps)
                || (o.collateralAmountMax != 0 && o.collateralAmountMax != o.collateralAmount)
        ) revert CollectionOfferShape();
        (uint16 maxLoans, uint32 maxExpiry) = getCollectionOfferLimits();
        if (o.loans == 0 || o.loans > maxLoans) revert CollectionLoansOutOfRange(o.loans, maxLoans);
        // The lifetime runs from when the maker signed, not from the fill: an
        // order withheld past it is expired whatever its own expiry says.
        uint256 latest = uint256(o.startTime) + maxExpiry;
        if (
            o.startTime > block.timestamp || o.expiresAt == 0 || o.expiresAt > latest
                || o.deadline == 0 || o.deadline > latest
        ) revert SignedCollectionLifetimeInvalid(o.startTime, o.expiresAt, o.deadline, latest);
        if (msg.sender == o.signer) revert SignedCollectionTakeRefused(orderHash, take.tokenId, TakeFailure.OwnOffer);
        LibCollateralSet.validateSigned(
            LibVaipakam.CollateralSetKind(o.setKind),
            o.setLow,
            o.setHigh,
            o.setRoot,
            o.setListCount,
            o.exclusionsHash,
            take.exclusions.length
        );
        if (
            !LibCollateralSet.containsSigned(
                LibVaipakam.CollateralSetKind(o.setKind),
                o.setLow,
                o.setHigh,
                o.setRoot,
                o.exclusionsHash,
                take.exclusions,
                take.tokenId,
                take.proof
            )
        ) revert SignedCollectionTakeRefused(orderHash, take.tokenId, TakeFailure.NotInSet);
    }

    /// @dev Count one loan against the order's fill ledger; returns the
    ///      principal filled before it. A cancelled order's ledger stands at
    ///      its ceiling, so it has no loans left.
    function _consumeSignedLoan(LibSignedOffer.SignedOffer calldata o, bytes32 orderHash, uint256 tokenId)
        private
        returns (uint256 filledBefore)
    {
        mapping(bytes32 => uint256) storage ledger = LibVaipakam.storageSlot().signedOfferFilled;
        filledBefore = ledger[orderHash];
        if (filledBefore + o.amount > LibSignedOffer.ceilingOf(o)) {
            revert SignedCollectionTakeRefused(orderHash, tokenId, TakeFailure.NoLoansLeft);
        }
        ledger[orderHash] = filledBefore + o.amount;
    }

    /// @dev The one-token lender slice of the signed terms, materialized
    ///      from the signer's free vault balance.
    function _materializeSignedSlice(LibSignedOffer.SignedOffer calldata o, uint256 tokenId, uint256 filledBefore)
        private
        returns (uint256 slice)
    {
        LibVaipakam.CreateOfferParams memory q = LibSignedOffer.toCreateOfferParams(o);
        q.amountMax = q.amount;
        q.interestRateBpsMax = q.interestRateBps;
        q.collateralAmountMax = q.collateralAmount;
        q.collateralTokenId = tokenId;
        q.fillMode = LibVaipakam.FillMode.Aon;
        bytes memory res = LibFacet.crossFacetCallReturn(
            abi.encodeWithSelector(
                OfferMaterializeFacet.createSignedCollectionSlice.selector,
                o.signer,
                q,
                LibSignedOffer.makerFullFor(o, filledBefore, o.amount)
            ),
            bytes4(0)
        );
        slice = abi.decode(res, (uint256));
    }
}
