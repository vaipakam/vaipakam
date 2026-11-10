// src/libraries/LibPositionNFT.sol
// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {LibVaipakam} from "./LibVaipakam.sol";

/// @dev The PositionNFT surface the Diamond reaches (#3205). Declared here
///      rather than imported from the contract so every facet that reads a
///      holder links only this narrow interface.
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
        /// @dev When value last left each loan's positions (a payout to a
        ///      holder, a collateral withdrawal, a terms change): the block
        ///      number in the high bits, the timestamp in the low 64 bits
        ///      ({_stampNow}). One word, so each stamp is one cheap write.
        mapping(uint256 => uint256) loanValueOut;
        /// @dev When each offer's terms last changed, packed the same way.
        mapping(uint256 => uint256) offerValueOut;
        /// @dev The transfer cooldown in seconds after a value-out; 0 = the
        ///      default ({DEFAULT_TRANSFER_COOLDOWN_SEC}).
        uint32 transferCooldownSec;
    }

    /// @notice #3413 — the transfer cooldown when none is set.
    uint32 internal constant DEFAULT_TRANSFER_COOLDOWN_SEC = 5;
    /// @notice #3413 — the bounds of a set cooldown. At least one second;
    ///         at most ten minutes, so a position paid regularly is never
    ///         held for long.
    uint32 internal constant MIN_TRANSFER_COOLDOWN_SEC = 1;
    uint32 internal constant MAX_TRANSFER_COOLDOWN_SEC = 600;

    error PositionNFTNotSet();
    error PositionNFTAlreadySet();
    error ERC721NonexistentToken(uint256 tokenId);
    /// @dev A route is already open on the token for another reason.
    error RouteConflict(uint256 tokenId, RouteReason current, RouteReason attempted);
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

    // ─── #3413 transfer cooldown ─────────────────────────────────────────

    /// @notice Record that value left loan `loanId`'s positions now: a payout
    ///         to a holder, a collateral withdrawal or a terms change. Neither
    ///         side's token may then move in this block, nor until the
    ///         cooldown has passed, so a sale cannot fill against a position
    ///         emptied just before it.
    function markLoanValueOut(uint256 loanId) internal {
        _storage().loanValueOut[loanId] = _stampNow();
    }

    /// @notice As {markLoanValueOut}, for offer `offerId`'s own token: a
    ///         change to its terms, or its retirement (a cancel refunds the
    ///         deposit; an accept moves it into a loan), which {retire} stamps.
    function markOfferValueOut(uint256 offerId) internal {
        _storage().offerValueOut[offerId] = _stampNow();
    }

    /// @notice The transfer cooldown in force, in seconds.
    function transferCooldownSec() internal view returns (uint32 sec) {
        sec = _storage().transferCooldownSec;
        if (sec == 0) sec = DEFAULT_TRANSFER_COOLDOWN_SEC;
    }

    /// @notice The latest value-out on `tokenId`'s position, and the earliest
    ///         time the token may move after it. Both 0 when none. The token
    ///         may not move in block `valueOutBlock` either.
    /// @dev    A loan token reads its loan's stamp only. A loan slice's token
    ///         also records the offer it came from, but that offer's later
    ///         changes or cancel move nothing out of the slice's loan, so only
    ///         an offer's own token (no loan) reads the offer's stamp.
    function cooldownOf(uint256 tokenId) internal view returns (uint64 valueOutBlock, uint64 readyAt) {
        ERC721Storage storage es = _storage();
        uint256 loanId = es.loanIds[tokenId];
        uint256 st = loanId != 0 ? es.loanValueOut[loanId] : es.offerValueOut[es.offerIds[tokenId]];
        if (st == 0) return (0, 0);
        return (uint64(st >> 64), uint64(st) + uint64(transferCooldownSec()));
    }

    /// @dev The block number above the timestamp, in one word.
    function _stampNow() private view returns (uint256) {
        return (block.number << 64) | block.timestamp;
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
    /// @dev    #3413 — retiring an offer's own token empties it (a cancel
    ///         refunds its deposit, an accept moves it into a loan), so it is
    ///         stamped as a value-out: the receipt cannot be sold in the same
    ///         block, nor within the cooldown, to a buyer who priced the live
    ///         offer. Every retire comes through here, so every offer exit is
    ///         covered. A loan token's exits stamp its loan where value leaves.
    function retire(uint256 tokenId) internal {
        ERC721Storage storage es = _storage();
        uint256 offerId = es.offerIds[tokenId];
        if (offerId != 0 && es.loanIds[tokenId] == 0 && !es.retired[tokenId]) {
            es.offerValueOut[offerId] = _stampNow();
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
