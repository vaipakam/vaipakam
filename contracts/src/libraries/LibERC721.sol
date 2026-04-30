// src/libraries/LibERC721.sol
// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {IERC721Receiver} from "@openzeppelin/contracts/token/ERC721/IERC721Receiver.sol";
import {LibVaipakam} from "./LibVaipakam.sol";

/**
 * @title LibERC721
 * @notice Diamond-safe ERC721 implementation using ERC-7201 namespaced storage.
 * @dev Replaces OpenZeppelin's ERC721 inheritance which uses regular storage
 *      slots that collide across facets in a diamond proxy. Stores all ERC721
 *      state (owners, balances, approvals, name, symbol) at a fixed storage slot.
 *      Also stores VaipakamNFT-specific metadata (statuses, offerIds, loanIds, roles, IPFS URIs).
 */
library LibERC721 {
    /// @dev ERC-7201 namespaced storage slot.
    ///      keccak256(abi.encode(uint256(keccak256("vaipakam.storage.ERC721")) - 1)) & ~bytes32(uint256(0xff))
    bytes32 private constant ERC721_STORAGE_POSITION =
        0xffc14e8dfa13b7ea215d815404bdf757f7212df791bac9ce070c8e8dcd574f00;

    /// @dev Reason a position NFT is temporarily non-transferable. Set by the
    ///      facet that initiated the flow; cleared on completion or cancel.
    ///      Front-run prevention during multi-step strategic flows — see
    ///      PrecloseFacet Option 3 (offset) and EarlyWithdrawalFacet (sale).
    enum LockReason { None, PrecloseOffset, EarlyWithdrawalSale }

    /// @dev APPEND-ONLY POST-LAUNCH. New fields go at the end; never reorder,
    ///      rename, or change types of existing fields on live diamonds.
    struct ERC721Storage {
        string name;
        string symbol;
        mapping(uint256 => address) owners;
        mapping(address => uint256) balances;
        mapping(uint256 => address) tokenApprovals;
        mapping(address => mapping(address => bool)) operatorApprovals;
        bool initialized;
        // VaipakamNFT-specific metadata
        mapping(uint256 => LibVaipakam.LoanPositionStatus) nftStatuses;
        mapping(uint256 => uint256) offerIds;
        mapping(uint256 => uint256) loanIds;
        mapping(uint256 => bool) isLenderRoles;
        // Image-URI configuration — granular per (LoanPositionStatus,
        // isLender) pair, with per-side defaults for any state that
        // wasn't explicitly populated. Lookup chain consumed by
        // `VaipakamNFTFacet.tokenURI`:
        //   1. statusImageURIs[status][isLender]      — exact match
        //   2. defaultLenderImage / defaultBorrowerImage — per-side fallback
        //   3. contractImageURI                          — collection-level fallback
        //   4. empty string                              — last resort
        // Replaces the prior 4-slot scheme (lenderActive/Closed +
        // borrowerActive/Closed). Pre-launch reorder; admin-only
        // setters via VaipakamNFTFacet.setImageURIForStatus +
        // setDefaultImage. Governance-transferable at any time by
        // rotating ADMIN_ROLE.
        mapping(LibVaipakam.LoanPositionStatus => mapping(bool => string)) statusImageURIs;
        string defaultLenderImage;
        string defaultBorrowerImage;
        // Collection-level metadata (contractURI convention + EIP-2981 royalties).
        string contractImageURI;
        address royaltyReceiver;
        uint96 royaltyBps;
        // Native transfer lock (replaces escrow-custody during strategic
        // flows). A non-None reason blocks transferFrom/safeTransferFrom/
        // approve on the locked tokenId.
        mapping(uint256 => LockReason) locks;

        // ─── ERC721Enumerable state (swap-and-pop indexes) ──────────────
        // Maintained by `_mint`, `_burn`, and `_transfer` so users and
        // indexers can enumerate ownership without event scanning.
        // `ownedTokens[owner][i]` is the i-th token held by `owner`;
        // `ownedTokensIndex[id]` is the position of `id` in that array
        // (only meaningful while `id` is held by its current owner —
        // rewritten on every transfer).
        // `allTokens` is the global list of minted-and-not-burned token
        // IDs; `allTokensIndex[id]` is its position in that array.
        mapping(address => uint256[]) ownedTokens;
        mapping(uint256 => uint256) ownedTokensIndex;
        uint256[] allTokens;
        mapping(uint256 => uint256) allTokensIndex;

        // ─── External-URL base for OpenSea metadata (Tier 2) ────────────
        // Admin-set base URL appended with `?loan=<loanId>&side=<...>`
        // (or `?token=<tokenId>` when no loan exists yet) and emitted
        // in tokenURI's JSON `external_url` field. OpenSea renders a
        // "View on Vaipakam" link that deep-links from the marketplace
        // back into the dApp. Empty string ⇒ field is omitted from
        // the JSON; setter is `VaipakamNFTFacet.setExternalUrlBase`.
        string externalUrlBase;
    }

    event Transfer(address indexed from, address indexed to, uint256 indexed tokenId);
    event Approval(address indexed owner, address indexed approved, uint256 indexed tokenId);
    event ApprovalForAll(address indexed owner, address indexed operator, bool approved);

    error ERC721InvalidOwner(address owner);
    error ERC721NonexistentToken(uint256 tokenId);
    error ERC721IncorrectOwner(address sender, uint256 tokenId, address owner);
    error ERC721InvalidSender(address sender);
    error ERC721InvalidReceiver(address receiver);
    error ERC721InsufficientApproval(address operator, uint256 tokenId);
    error ERC721InvalidApprover(address approver);
    error ERC721InvalidOperator(address operator);
    error ERC721AlreadyInitialized();
    error ERC721Locked(uint256 tokenId, LockReason reason);

    function _storage() internal pure returns (ERC721Storage storage es) {
        bytes32 position = ERC721_STORAGE_POSITION;
        assembly {
            es.slot := position
        }
    }

    function _lock(uint256 tokenId, LockReason reason) internal {
        ERC721Storage storage es = _storage();
        es.locks[tokenId] = reason;
        // Revoke any outstanding approval so a stale approvee can't act on
        // behalf of a locked owner once the flow completes.
        delete es.tokenApprovals[tokenId];
    }

    function _unlock(uint256 tokenId) internal {
        delete _storage().locks[tokenId];
    }

    function lockOf(uint256 tokenId) internal view returns (LockReason) {
        return _storage().locks[tokenId];
    }

    function _requireNotLocked(uint256 tokenId) internal view {
        LockReason r = _storage().locks[tokenId];
        if (r != LockReason.None) revert ERC721Locked(tokenId, r);
    }

    /// @dev Initialize the ERC721 surface for a fresh diamond. Only
    ///      the per-side default image URLs seed at deploy; granular
    ///      per-(status, isLender) overrides are set later by the
    ///      admin via `VaipakamNFTFacet.setImageURIForStatus` (or via
    ///      `ConfigureNFTImageURIs.s.sol`). Reverts on second call.
    function initialize(
        string memory name_,
        string memory symbol_,
        string memory defaultLenderImage_,
        string memory defaultBorrowerImage_
    ) internal {
        ERC721Storage storage es = _storage();
        if (es.initialized) revert ERC721AlreadyInitialized();
        es.name = name_;
        es.symbol = symbol_;
        es.defaultLenderImage = defaultLenderImage_;
        es.defaultBorrowerImage = defaultBorrowerImage_;
        es.initialized = true;
    }

    function ownerOf(uint256 tokenId) internal view returns (address) {
        address owner = _storage().owners[tokenId];
        if (owner == address(0)) revert ERC721NonexistentToken(tokenId);
        return owner;
    }

    function balanceOf(address owner) internal view returns (uint256) {
        if (owner == address(0)) revert ERC721InvalidOwner(address(0));
        return _storage().balances[owner];
    }

    function name() internal view returns (string memory) {
        return _storage().name;
    }

    function symbol() internal view returns (string memory) {
        return _storage().symbol;
    }

    function getApproved(uint256 tokenId) internal view returns (address) {
        ownerOf(tokenId); // reverts if nonexistent
        return _storage().tokenApprovals[tokenId];
    }

    function isApprovedForAll(address owner, address operator) internal view returns (bool) {
        return _storage().operatorApprovals[owner][operator];
    }

    function approve(address to, uint256 tokenId) internal {
        _requireNotLocked(tokenId);
        address owner = ownerOf(tokenId);
        if (to == owner) revert ERC721InvalidOperator(to);
        if (msg.sender != owner && !isApprovedForAll(owner, msg.sender)) {
            revert ERC721InsufficientApproval(msg.sender, tokenId);
        }
        _storage().tokenApprovals[tokenId] = to;
        emit Approval(owner, to, tokenId);
    }

    function setApprovalForAll(address operator, bool approved) internal {
        if (operator == address(0)) revert ERC721InvalidOperator(address(0));
        _storage().operatorApprovals[msg.sender][operator] = approved;
        emit ApprovalForAll(msg.sender, operator, approved);
    }

    function transferFrom(address from, address to, uint256 tokenId) internal {
        _requireNotLocked(tokenId);
        address owner = ownerOf(tokenId);
        if (owner != from) revert ERC721IncorrectOwner(from, tokenId, owner);
        if (to == address(0)) revert ERC721InvalidReceiver(address(0));
        if (!_isAuthorized(owner, msg.sender, tokenId)) {
            revert ERC721InsufficientApproval(msg.sender, tokenId);
        }
        _transfer(from, to, tokenId);
    }

    function safeTransferFrom(address from, address to, uint256 tokenId, bytes memory data) internal {
        transferFrom(from, to, tokenId);
        _checkOnERC721Received(from, to, tokenId, data);
    }

    function _safeMint(address to, uint256 tokenId) internal {
        _mint(to, tokenId);
        _checkOnERC721Received(address(0), to, tokenId, "");
    }

    function _mint(address to, uint256 tokenId) internal {
        if (to == address(0)) revert ERC721InvalidReceiver(address(0));
        ERC721Storage storage es = _storage();
        if (es.owners[tokenId] != address(0)) revert ERC721InvalidSender(address(0));
        es.balances[to] += 1;
        es.owners[tokenId] = to;
        _addTokenToOwnerEnumeration(es, to, tokenId);
        _addTokenToAllTokensEnumeration(es, tokenId);
        emit Transfer(address(0), to, tokenId);
    }

    function _burn(uint256 tokenId) internal {
        ERC721Storage storage es = _storage();
        address owner = ownerOf(tokenId);
        es.balances[owner] -= 1;
        _removeTokenFromOwnerEnumeration(es, owner, tokenId);
        _removeTokenFromAllTokensEnumeration(es, tokenId);
        delete es.owners[tokenId];
        delete es.tokenApprovals[tokenId];
        delete es.locks[tokenId];
        emit Transfer(owner, address(0), tokenId);
    }

    function _transfer(address from, address to, uint256 tokenId) internal {
        ERC721Storage storage es = _storage();
        es.balances[from] -= 1;
        es.balances[to] += 1;
        _removeTokenFromOwnerEnumeration(es, from, tokenId);
        _addTokenToOwnerEnumeration(es, to, tokenId);
        es.owners[tokenId] = to;
        delete es.tokenApprovals[tokenId];
        emit Transfer(from, to, tokenId);
    }

    // ─── ERC721Enumerable view helpers ─────────────────────────────────

    /// @notice Total minted-and-not-burned tokens. See
    ///         {IERC721Enumerable.totalSupply}.
    function totalSupply() internal view returns (uint256) {
        return _storage().allTokens.length;
    }

    /// @notice Token ID at global index. See
    ///         {IERC721Enumerable.tokenByIndex}.
    function tokenByIndex(uint256 index) internal view returns (uint256) {
        ERC721Storage storage es = _storage();
        require(index < es.allTokens.length, "ERC721: global index out of bounds");
        return es.allTokens[index];
    }

    /// @notice Token ID at an owner-scoped index. See
    ///         {IERC721Enumerable.tokenOfOwnerByIndex}.
    function tokenOfOwnerByIndex(address owner, uint256 index) internal view returns (uint256) {
        ERC721Storage storage es = _storage();
        require(index < es.balances[owner], "ERC721: owner index out of bounds");
        return es.ownedTokens[owner][index];
    }

    // ─── ERC721Enumerable index maintenance (swap-and-pop) ─────────────
    //
    // The invariants (while `id` is owned by `owner`):
    //   es.ownedTokens[owner][es.ownedTokensIndex[id]]   == id
    //   es.allTokens       [es.allTokensIndex[id]]       == id
    //
    // On mint/transfer-in: append to both arrays and stamp the id's slot
    // in the corresponding index map.
    // On burn/transfer-out: copy the last element into the removed slot
    // (swap-and-pop) and shorten the array by one. `allTokens` is a
    // global append-only list that only shrinks on burn; `ownedTokens`
    // shrinks on burn and on any transfer out.

    function _addTokenToOwnerEnumeration(ERC721Storage storage es, address to, uint256 tokenId) private {
        uint256 length = es.balances[to] - 1; // balance already incremented
        if (length < es.ownedTokens[to].length) {
            es.ownedTokens[to][length] = tokenId;
        } else {
            es.ownedTokens[to].push(tokenId);
        }
        es.ownedTokensIndex[tokenId] = length;
    }

    function _addTokenToAllTokensEnumeration(ERC721Storage storage es, uint256 tokenId) private {
        es.allTokensIndex[tokenId] = es.allTokens.length;
        es.allTokens.push(tokenId);
    }

    function _removeTokenFromOwnerEnumeration(ERC721Storage storage es, address from, uint256 tokenId) private {
        uint256 lastTokenIndex = es.ownedTokens[from].length - 1;
        uint256 tokenIndex = es.ownedTokensIndex[tokenId];

        // Swap the last token into the removed slot (unless it IS the last).
        if (tokenIndex != lastTokenIndex) {
            uint256 lastTokenId = es.ownedTokens[from][lastTokenIndex];
            es.ownedTokens[from][tokenIndex] = lastTokenId;
            es.ownedTokensIndex[lastTokenId] = tokenIndex;
        }

        delete es.ownedTokensIndex[tokenId];
        es.ownedTokens[from].pop();
    }

    function _removeTokenFromAllTokensEnumeration(ERC721Storage storage es, uint256 tokenId) private {
        uint256 lastTokenIndex = es.allTokens.length - 1;
        uint256 tokenIndex = es.allTokensIndex[tokenId];

        uint256 lastTokenId = es.allTokens[lastTokenIndex];
        es.allTokens[tokenIndex] = lastTokenId;
        es.allTokensIndex[lastTokenId] = tokenIndex;

        delete es.allTokensIndex[tokenId];
        es.allTokens.pop();
    }

    function _isAuthorized(address owner, address spender, uint256 tokenId) internal view returns (bool) {
        return spender != address(0) && (
            owner == spender ||
            isApprovedForAll(owner, spender) ||
            getApproved(tokenId) == spender
        );
    }

    function _checkOnERC721Received(address from, address to, uint256 tokenId, bytes memory data) private {
        if (to.code.length > 0) {
            try IERC721Receiver(to).onERC721Received(msg.sender, from, tokenId, data) returns (bytes4 retval) {
                if (retval != IERC721Receiver.onERC721Received.selector) {
                    revert ERC721InvalidReceiver(to);
                }
            } catch (bytes memory reason) {
                if (reason.length == 0) {
                    revert ERC721InvalidReceiver(to);
                } else {
                    assembly {
                        revert(add(32, reason), mload(reason))
                    }
                }
            }
        }
    }
}
