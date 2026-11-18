// src/libraries/LibPositionNFT.sol
// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {LibVaipakam} from "./LibVaipakam.sol";
import {LibReentrancyGuard} from "./LibReentrancyGuard.sol";
import {LibRevert} from "./LibRevert.sol";

/// @dev The PositionNFT surface the Diamond reaches (#3205). Declared here
///      rather than imported from the contract so every facet that reads a
///      holder links only this narrow interface.
/// @notice #3710 — the one runtime home of the offer-token mark
///         ({VaipakamNFTFacet.markOfferPositions}).
interface IPositionMarkHost {
    function markOfferPositions(uint256 offerA, uint256 offerB) external;
}

interface IPositionNFTCore {
    function holderOf(uint256 tokenId) external view returns (address);
    function transferCount(uint256 tokenId) external view returns (uint256);
    function isLocked(address holder) external view returns (bool);
    function balanceOf(address holder) external view returns (uint256);
    function tokenOfOwnerByIndex(address holder, uint256 index) external view returns (uint256);
    function mint(address to, uint256 tokenId) external;
    function lockFor(address holder) external;
    function raiseLockDelay(address holder, uint256 delay) external;
    function voidPending(address holder) external;
    function lockOf(address holder)
        external
        view
        returns (bool locked, uint256 delay, uint256 unlockAt, uint256 lowerDelay, uint256 lowerAt);
    function diamond() external view returns (address);
    function MAX_DIAMOND_LOCK_DELAY() external view returns (uint256);
    function refreshMetadata(uint256 tokenA, uint256 tokenB) external;
}

/**
 * @title  LibPositionNFT
 * @author Vaipakam Developer Team
 * @notice The Diamond's side of the position NFTs (#3205,
 *         `VaultOutflowPolicyDesign.md` §3.9). WHO holds a position is
 *         recorded by the standalone {PositionNFT} contract, which no facet
 *         can write; every holder read here goes there. WHAT the position is
 *         (its status, its offer and loan, its side) and the protocol routes
 *         open on it stay in this namespaced storage.
 *
 * @dev    Three Diamond-side records:
 *         - **Retired tokens.** The core never burns. When a position closes
 *           (a claim, a cancelled offer, a position handed to a new token) the
 *           Diamond RETIRES its token here, and every holder read below treats
 *           a retired token exactly as the Diamond treated a burned one before
 *           #3205: {ownerOf} reverts and {holderOrZero} returns 0. The token
 *           stays in its holder's wallet as a receipt.
 *         - **Routes.** A protocol route that must complete for the same
 *           holder that opened it (an offset, a lender sale, a collateral
 *           listing, a swap-to-repay intent) records its reason and the
 *           token's transfer count when it opens. One route per token at a
 *           time, as before. A route no longer blocks a transfer: its
 *           COMPLETION requires the count unchanged ({completeRoute}), so a
 *           position that moved at all cannot complete it; a cancel does not
 *           check it.
 *         - **The core's address**, set once at deploy.
 */
library LibPositionNFT {
    /// @dev ERC-7201 namespaced storage slot, kept from the retired in-Diamond
    ///      ERC-721 so the layout record stays one namespace.
    ///      keccak256(abi.encode(uint256(keccak256("vaipakam.storage.ERC721")) - 1)) & ~bytes32(uint256(0xff))
    bytes32 private constant ERC721_STORAGE_POSITION =
        0xffc14e8dfa13b7ea215d815404bdf757f7212df791bac9ce070c8e8dcd574f00;

    /// @dev Why a protocol route is open on a token. One at a time per token.
    ///      `retiredProtectedOwner` is kept so the member order is unchanged;
    ///      it was a derived reason (protected mode's NFT protection), never
    ///      stored, and is now the PositionNFT core's holder lock.
    enum RouteReason { None, PrecloseOffset, EarlyWithdrawalSale, PrepayCollateralListing, SwapToRepayIntent, retiredProtectedOwner }

    /// @dev APPEND-ONLY. The `retired*` fields held the in-Diamond ERC-721
    ///      before #3205 and are no longer read or written.
    // forge-lint: disable-next-line(pascal-case-struct)
    struct ERC721Storage {
        string retiredName;
        string retiredSymbol;
        mapping(uint256 => address) retiredOwners;
        mapping(address => uint256) retiredBalances;
        mapping(uint256 => address) retiredTokenApprovals;
        mapping(address => mapping(address => bool)) retiredOperatorApprovals;
        bool initialized;
        // VaipakamNFT-specific metadata
        mapping(uint256 => LibVaipakam.LoanPositionStatus) nftStatuses;
        mapping(uint256 => uint256) offerIds;
        mapping(uint256 => uint256) loanIds;
        mapping(uint256 => bool) isLenderRoles;
        // Image-URI configuration consumed by `VaipakamNFTMetadataFacet.tokenURI`
        // (the PositionNFT core's renderer).
        mapping(LibVaipakam.LoanPositionStatus => mapping(bool => string)) statusImageUris;
        string defaultLenderImage;
        string defaultBorrowerImage;
        // Collection-level metadata (contractURI convention + EIP-2981 royalties).
        string contractImageURI;
        address royaltyReceiver;
        uint96 royaltyBps;
        // The open protocol route on each token (see {RouteReason}).
        mapping(uint256 => RouteReason) routes;
        mapping(address => uint256[]) retiredOwnedTokens;
        mapping(uint256 => uint256) retiredOwnedTokensIndex;
        uint256[] retiredAllTokens;
        mapping(uint256 => uint256) retiredAllTokensIndex;
        // Admin-set base URL for the tokenURI JSON's `external_url`.
        string externalUrlBase;
        mapping(address => uint256) retiredLockedTokenCount;
        mapping(address => uint256) retiredOperatorApprovalEpoch;
        mapping(address => mapping(address => uint256)) retiredOperatorApprovalGrantEpoch;
        // ─── #3205 ───────────────────────────────────────────────────────
        /// @dev The PositionNFT core. Set once by `VaipakamNFTFacet.initializeNFT`.
        address core;
        /// @dev Tokens whose position closed. Never cleared.
        mapping(uint256 => bool) retired;
        /// @dev The token's transfer count when its open route started.
        mapping(uint256 => uint256) routeTransferCount;
        // ─── #3413 ───────────────────────────────────────────────────────
        /// @dev RETIRED by #3710: the per-loan value-out stamp, replaced by
        ///      the per-token record {tokenState}. No longer read or written.
        mapping(uint256 => uint256) retiredLoanValueOut;
        /// @dev RETIRED by #3710: the per-offer stamp, as above.
        mapping(uint256 => uint256) retiredOfferValueOut;
        /// @dev The wait in seconds after any value-out; 0 = the default
        ///      ({DEFAULT_TRANSFER_COOLDOWN_SEC}).
        uint32 transferCooldownSec;
        // ─── #3710 ───────────────────────────────────────────────────────
        /// @dev Each token's position state, one word: its state number in
        ///      bits 128.. (how many times value left its position; never
        ///      reset, so it cannot repeat when an offer's token becomes a
        ///      loan's), the block of its latest value-out in bits 64..127,
        ///      and the time it may next move in bits 0..63.
        mapping(uint256 => uint256) tokenState;
        /// @dev The wait in seconds after the holder's own move; 0 = the
        ///      default ({DEFAULT_OWN_MOVE_WAIT_SEC}).
        uint32 ownMoveWaitSec;
    }

    /// @notice #3413 / #3710 — the transfer cooldown when none is set. A
    ///         minute: long enough for a marketplace to act on the metadata
    ///         refresh a value-out sends before the token can change hands.
    uint32 internal constant DEFAULT_TRANSFER_COOLDOWN_SEC = 60;
    /// @notice #3413 — the bounds of a set cooldown. At least one second;
    ///         at most ten minutes, so a position paid regularly is never
    ///         held for long.
    uint32 internal constant MIN_TRANSFER_COOLDOWN_SEC = 1;
    uint32 internal constant MAX_TRANSFER_COOLDOWN_SEC = 600;
    /// @notice #3710 — the wait after the holder's own move (a payout to the
    ///         caller's own position: a collateral withdrawal, a claim, a
    ///         change to its own offer) when none is set, and its bounds. Long
    ///         enough for marketplaces, wallets and explorers to act on the
    ///         metadata refresh before anyone can buy at a stale figure.
    uint32 internal constant DEFAULT_OWN_MOVE_WAIT_SEC = 900;
    uint32 internal constant MIN_OWN_MOVE_WAIT_SEC = 60;
    uint32 internal constant MAX_OWN_MOVE_WAIT_SEC = 3600;

    error PositionNFTNotSet();
    error PositionNFTAlreadySet();
    error ERC721NonexistentToken(uint256 tokenId);
    /// @dev A route is already open on the token for another reason.
    error RouteConflict(uint256 tokenId, RouteReason current, RouteReason attempted);
    /// @dev #3710 — the position's state number is not the one the caller
    ///      priced: value left it since.
    error PositionStateChanged(uint256 tokenId, uint256 expected, uint256 current);
    /// @dev The route's completion found the position moved since it opened.
    error PositionMovedSinceRouteOpened(uint256 tokenId, uint256 countAtOpen, uint256 countNow);
    /// @dev Completion of a route that is not the one open on the token.
    error RouteNotOpen(uint256 tokenId, RouteReason expected, RouteReason current);

    function _storage() internal pure returns (ERC721Storage storage es) {
        bytes32 position = ERC721_STORAGE_POSITION;
        assembly {
            es.slot := position
        }
    }

    // ─── #3413 transfer cooldown, #3710 state number ─────────────────────

    /// @dev Where each field of a {ERC721Storage.tokenState} word sits.
    uint256 private constant STATE_SHIFT = 128;
    uint256 private constant BLOCK_SHIFT = 64;

    /// @notice Record that value left loan `loanId`'s positions now: a payout,
    ///         a collateral reduction or a terms change. Both of its tokens'
    ///         state numbers go up by one, neither may move in this block nor
    ///         until the short wait has passed (a running longer wait is kept),
    ///         and both tokens' metadata is flagged for refresh.
    /// @dev    #3710 — called only from the seams (the outflow policy,
    ///         {LibLoanCollateral}, the loan-terms writer, the held-for-lender
    ///         taker, retiring a token and an offer's token becoming a
    ///         loan's), never path by path.
    function markLoanValueOut(uint256 loanId) internal {
        LibVaipakam.Loan storage loan = LibVaipakam.storageSlot().loans[loanId];
        uint256 lenderToken = loan.lenderTokenId;
        uint256 borrowerToken = loan.borrowerTokenId;
        uint64 wait = transferCooldownSec();
        _markToken(lenderToken, wait);
        _markToken(borrowerToken, wait);
        _refresh(lenderToken, borrowerToken);
    }

    /// @notice One token's value-out (#3710): a loan token minted, or an
    ///         offer's token becoming a loan's, before the loan records its
    ///         token ids. Its state number goes up, it takes the short wait
    ///         and its metadata is flagged for refresh.
    function markTokenValueOut(uint256 tokenId) internal {
        _markToken(tokenId, transferCooldownSec());
        _refresh(tokenId, 0);
    }

    /// @notice Offer `offerId`'s own token: a change to its terms, a match
    ///         drawing on it, or its end. Its state number goes up and it
    ///         waits; the long wait when the caller holds it (its holder
    ///         changed its own offer).
    /// @dev    Reached through one self-call to its host on VaipakamNFTFacet:
    ///         the match core is inlined in four facets near EIP-170, and the
    ///         mark (two core calls) would otherwise be compiled into each.
    function markOfferValueOut(uint256 offerId) internal {
        markOffersValueOut(offerId, 0);
    }

    /// @notice As {markOfferValueOut}, for two offers at once (a match draws
    ///         on both). Offer id 0 is skipped.
    function markOffersValueOut(uint256 offerA, uint256 offerB) internal {
        (bool ok, bytes memory ret) = address(this).call(
            abi.encodeCall(IPositionMarkHost.markOfferPositions, (offerA, offerB))
        );
        LibRevert.bubbleOnFailure(ok, ret, "markOfferPositions");
    }

    /// @notice The body of the offer-token mark, run only by its host
    ///         ({VaipakamNFTFacet.markOfferPositions}): both tokens marked,
    ///         the long wait for a token the caller holds, one refresh call.
    function markOffersValueOutHere(uint256 offerA, uint256 offerB) internal {
        mapping(uint256 => LibVaipakam.Offer) storage offers = LibVaipakam.storageSlot().offers;
        uint256 tokenA = offerA == 0 ? 0 : offers[offerA].positionTokenId;
        uint256 tokenB = offerB == 0 ? 0 : offers[offerB].positionTokenId;
        _markOfferToken(tokenA);
        _markOfferToken(tokenB);
        _refresh(tokenA, tokenB);
    }

    /// @dev One offer token's mark: the short wait, then the long one when
    ///      the caller holds it. One body for both tokens of a match.
    function _markOfferToken(uint256 token) private {
        _markToken(token, transferCooldownSec());
        markHolderMove(token);
    }

    /// @notice #3710 — when the caller of the guarded action in progress holds
    ///         `tokenId`, the value-out is the holder's own move for itself:
    ///         the token waits the long wait. Never shortens a running wait
    ///         and does not move the state number (the value-out's mark did).
    function markHolderMove(uint256 tokenId) internal {
        if (tokenId == 0) return;
        address a = LibReentrancyGuard.actor();
        if (a == address(0) || _storage().retired[tokenId] || _storage().core == address(0)) return;
        if (IPositionNFTCore(_storage().core).holderOf(tokenId) != a) return;
        ERC721Storage storage es = _storage();
        uint256 w = es.tokenState[tokenId];
        uint64 ready = uint64(block.timestamp) + ownMoveWaitSec();
        if (uint64(w) < ready) es.tokenState[tokenId] = (w >> BLOCK_SHIFT << BLOCK_SHIFT) | ready;
    }

    /// @notice The short wait in force (after any value-out), in seconds.
    function transferCooldownSec() internal view returns (uint32 sec) {
        sec = _storage().transferCooldownSec;
        if (sec == 0) sec = DEFAULT_TRANSFER_COOLDOWN_SEC;
    }

    /// @notice The long wait in force (after the holder's own move), in seconds.
    function ownMoveWaitSec() internal view returns (uint32 sec) {
        sec = _storage().ownMoveWaitSec;
        if (sec == 0) sec = DEFAULT_OWN_MOVE_WAIT_SEC;
    }

    /// @notice `tokenId`'s position state (#3710): its state number (how
    ///         many times value has left its position; never reset), the block
    ///         of the latest value-out (the token may not move in it) and the
    ///         time it may next move. All 0 when nothing has left it.
    function stateOf(uint256 tokenId)
        internal
        view
        returns (uint256 stateNumber, uint64 valueOutBlock, uint64 readyAt)
    {
        uint256 w = _storage().tokenState[tokenId];
        return (w >> STATE_SHIFT, uint64(w >> BLOCK_SHIFT), uint64(w));
    }

    /// @notice Revert {PositionStateChanged} unless `tokenId`'s state number
    ///         is `expected` (#3710). A price agreed for one state is a price
    ///         for that state only.
    function requireState(uint256 tokenId, uint256 expected) internal view {
        (uint256 current,,) = stateOf(tokenId);
        if (current != expected) revert PositionStateChanged(tokenId, expected, current);
    }

    /// @dev One more value-out on `tokenId`: its state number goes up by one,
    ///      the block becomes this one, and the time it may move becomes
    ///      `wait` from now unless a longer wait is already running.
    function _markToken(uint256 tokenId, uint64 wait) private {
        if (tokenId == 0) return;
        ERC721Storage storage es = _storage();
        uint256 w = es.tokenState[tokenId];
        uint64 ready = uint64(block.timestamp) + wait;
        if (uint64(w) > ready) ready = uint64(w);
        es.tokenState[tokenId] = (((w >> STATE_SHIFT) + 1) << STATE_SHIFT) | (block.number << BLOCK_SHIFT) | ready;
    }

    // ─── #3710 metadata refresh ──────────────────────────────────────────

    /// @notice Ask the core to emit the ERC-4906 refresh for both of loan
    ///         `loanId`'s tokens: a figure its metadata renders changed. Sent
    ///         at every value-out and at every other change to a rendered
    ///         figure (collateral added, a repayment, a status, the terms).
    /// @dev    Skipped while the core is unset (a minimal test Diamond), so a
    ///         refresh never decides whether a step runs.
    function refreshLoan(uint256 loanId) internal {
        LibVaipakam.Loan storage loan = LibVaipakam.storageSlot().loans[loanId];
        _refresh(loan.lenderTokenId, loan.borrowerTokenId);
    }

    /// @notice As {refreshLoan}, for offer `offerId`'s own token.
    function refreshOffer(uint256 offerId) internal {
        _refresh(LibVaipakam.storageSlot().offers[offerId].positionTokenId, 0);
    }

    /// @notice As {refreshLoan}, for one or two token ids (0 = none).
    function refreshTokens(uint256 tokenA, uint256 tokenB) internal {
        _refresh(tokenA, tokenB);
    }

    function _refresh(uint256 tokenA, uint256 tokenB) private {
        address a = _storage().core;
        if (a == address(0) || (tokenA == 0 && tokenB == 0)) return;
        IPositionNFTCore(a).refreshMetadata(tokenA, tokenB);
    }

    // ─── The core ────────────────────────────────────────────────────────

    /// @notice The PositionNFT core. Reverts while unset, so no holder read
    ///         or mint can silently run against nothing.
    function core() internal view returns (IPositionNFTCore c) {
        address a = _storage().core;
        if (a == address(0)) revert PositionNFTNotSet();
        return IPositionNFTCore(a);
    }

    /// @notice Record the core, once.
    function setCore(address a) internal {
        ERC721Storage storage es = _storage();
        if (es.core != address(0)) revert PositionNFTAlreadySet();
        es.core = a;
    }

    // ─── Holder reads ────────────────────────────────────────────────────

    /// @notice The holder of a live (minted, not retired) position token.
    ///         Reverts otherwise, as the in-Diamond `ownerOf` did for a
    ///         burned or never-minted token.
    function ownerOf(uint256 tokenId) internal view returns (address holder) {
        holder = holderOrZero(tokenId);
        if (holder == address(0)) revert ERC721NonexistentToken(tokenId);
    }

    /// @notice The holder of a live position token, or 0 for a retired or
    ///         never-minted one. Never reverts on the token.
    function holderOrZero(uint256 tokenId) internal view returns (address) {
        if (tokenId == 0 || _storage().retired[tokenId]) return address(0);
        return core().holderOf(tokenId);
    }

    /// @notice How many tokens `holder` holds, live and retired.
    function balanceOf(address holder) internal view returns (uint256) {
        return core().balanceOf(holder);
    }

    /// @notice `holder`'s token at `index` (live or retired).
    function tokenOfOwnerByIndex(address holder, uint256 index) internal view returns (uint256) {
        return core().tokenOfOwnerByIndex(holder, index);
    }

    /// @notice Whether `tokenId` was retired (its position closed).
    function isRetired(uint256 tokenId) internal view returns (bool) {
        return _storage().retired[tokenId];
    }

    /// @notice How many times `tokenId` has been transferred (the core's
    ///         count, which only rises). A flow that must complete for the
    ///         holder that opened it records this and requires it unchanged.
    function transferCountOf(uint256 tokenId) internal view returns (uint256) {
        return core().transferCount(tokenId);
    }

    /// @notice Whether `holder` keeps its tokens under the core's holder lock.
    function isHolderLocked(address holder) internal view returns (bool) {
        address a = _storage().core;
        return a != address(0) && IPositionNFTCore(a).isLocked(holder);
    }

    // ─── Mint and retire ─────────────────────────────────────────────────

    /// @notice Mint a new position token at the core.
    function mint(address to, uint256 tokenId) internal {
        core().mint(to, tokenId);
    }

    /// @notice Mark `tokenId` retired. Idempotent. Clears any open route.
    /// @dev    #3413 — a retired token's position has closed or passed to a
    ///         new token: a cancel refunded an offer's deposit, a match used up
    ///         the rest of it, a final claim paid a side out, or a sale or
    ///         handover re-minted a side to its new holder (the seller paid).
    ///         So retiring stamps the token's position, its loan or else its
    ///         offer, as a value-out: the receipt cannot be sold in the same
    ///         block, nor within the cooldown, to a buyer who priced the live
    ///         position. Every retire comes through here, so no exit path can
    ///         miss it.
    function retire(uint256 tokenId) internal {
        ERC721Storage storage es = _storage();
        if (!es.retired[tokenId]) {
            uint256 loanId = es.loanIds[tokenId];
            if (loanId != 0) {
                markLoanValueOut(loanId);
            } else {
                _markToken(tokenId, transferCooldownSec());
                _refresh(tokenId, 0);
            }
            // A claim or a cancel by the token's own holder is its own move.
            markHolderMove(tokenId);
        }
        es.retired[tokenId] = true;
        delete es.routes[tokenId];
        delete es.routeTransferCount[tokenId];
    }

    // ─── Routes ──────────────────────────────────────────────────────────

    /// @notice Open a route on `tokenId`, recording its transfer count now.
    /// @dev    A live route of another reason refuses (one route per token).
    ///         A route whose position MOVED since it opened is dead: it can
    ///         never complete, so it no longer holds the token, and the new
    ///         route replaces it with a fresh count (#3205 review: a former
    ///         holder's dead route must not encumber the new holder). A
    ///         same-reason re-open of a live route keeps its count, so a
    ///         re-post by the same holder stays bound to that holder; one
    ///         after a move takes the current count, binding the route to the
    ///         holder re-opening it (every opener checks the current holder).
    ///         Each flow's cancel closes only its own reason
    ///         ({closeRouteIfHeldBy}), so a dead flow's later teardown cannot
    ///         clear the route that replaced it.
    /// @param holderAuthenticated True ONLY for a call authenticated as the
    ///        CURRENT holder (or a keeper that holder approved) that supplies
    ///        fresh terms: such a call may rebind a dead route of this same
    ///        reason to the current count, making the flow the current
    ///        holder's own. Any other caller (a permissionless rotation, a
    ///        keeper pass acting without the holder) passes false and is
    ///        refused on a dead same-reason route: a transfer cancels the
    ///        former holder's flow permanently (#3318 Codex r3, design §3.9).
    function openRoute(uint256 tokenId, RouteReason reason, bool holderAuthenticated) internal {
        ERC721Storage storage es = _storage();
        RouteReason current = es.routes[tokenId];
        ownerOf(tokenId); // a retired or unminted token opens no route
        uint256 nowCount = core().transferCount(tokenId);
        uint256 atOpen = es.routeTransferCount[tokenId];
        bool live = current != RouteReason.None && atOpen == nowCount;
        if (live && current != reason) revert RouteConflict(tokenId, current, reason);
        if (!live && current == reason && !holderAuthenticated) {
            revert PositionMovedSinceRouteOpened(tokenId, atOpen, nowCount);
        }
        if (!live) es.routeTransferCount[tokenId] = nowCount;
        es.routes[tokenId] = reason;
    }

    /// @notice Whether the `reason` route bound to `tokenId` is dead: it is no
    ///         longer the open route (closed, or replaced after a move), or the
    ///         position moved since it opened. A flow whose route is dead can
    ///         never complete, so anyone may tear it down (its refund still
    ///         goes where the flow's own rules send it).
    function routeIsDead(uint256 tokenId, RouteReason reason) internal view returns (bool) {
        ERC721Storage storage es = _storage();
        if (es.routes[tokenId] != reason) return true;
        return core().transferCount(tokenId) != es.routeTransferCount[tokenId];
    }

    /// @notice Close the route on `tokenId` without checking (a cancel or a
    ///         teardown). Moves nothing.
    function closeRoute(uint256 tokenId) internal {
        ERC721Storage storage es = _storage();
        delete es.routes[tokenId];
        delete es.routeTransferCount[tokenId];
    }

    /// @notice Close the route only if `reason` is the one open (a teardown
    ///         that may run where it never opened one).
    function closeRouteIfHeldBy(uint256 tokenId, RouteReason reason) internal {
        if (_storage().routes[tokenId] == reason) closeRoute(tokenId);
    }

    /// @notice Require the `reason` route open on `tokenId` and the position
    ///         unmoved since it opened, then close it. Every route COMPLETION
    ///         calls this before it pays or hands over anything.
    function completeRoute(uint256 tokenId, RouteReason reason) internal {
        requireUnmoved(tokenId, reason);
        closeRoute(tokenId);
    }

    /// @notice Require the `reason` route open on `tokenId` and the position
    ///         unmoved since it opened, without closing it (a completion that
    ///         closes the route later in the same transaction).
    function requireUnmoved(uint256 tokenId, RouteReason reason) internal view {
        ERC721Storage storage es = _storage();
        RouteReason current = es.routes[tokenId];
        if (current != reason) revert RouteNotOpen(tokenId, reason, current);
        uint256 atOpen = es.routeTransferCount[tokenId];
        uint256 nowCount = core().transferCount(tokenId);
        if (nowCount != atOpen) revert PositionMovedSinceRouteOpened(tokenId, atOpen, nowCount);
    }

    /// @notice Complete the `reason` route if it is the one open (checked, as
    ///         {completeRoute}); nothing otherwise (a completion that may run
    ///         where its route was never opened, such as the offer-keyed
    ///         parallel sale). Another reason's route is left alone.
    function completeRouteIfHeldBy(uint256 tokenId, RouteReason reason) internal {
        if (_storage().routes[tokenId] == reason) completeRoute(tokenId, reason);
    }

    /// @notice Whether the `reason` route is open on `tokenId` and the
    ///         position has not moved since it opened (for validity reads).
    function isUnmoved(uint256 tokenId, RouteReason reason) internal view returns (bool) {
        ERC721Storage storage es = _storage();
        if (es.routes[tokenId] != reason) return false;
        return core().transferCount(tokenId) == es.routeTransferCount[tokenId];
    }

    /// @notice The route open on `tokenId` (None if none).
    function routeOf(uint256 tokenId) internal view returns (RouteReason) {
        return _storage().routes[tokenId];
    }
}
