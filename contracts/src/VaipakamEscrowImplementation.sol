// src/VaipakamEscrowImplementation.sol
// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {UUPSUpgradeable} from "@openzeppelin/contracts/proxy/utils/UUPSUpgradeable.sol";
import {OwnableUpgradeable} from "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import {ERC165Upgradeable} from "@openzeppelin/contracts-upgradeable/utils/introspection/ERC165Upgradeable.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {IERC721Receiver} from "@openzeppelin/contracts/token/ERC721/IERC721Receiver.sol";
import {IERC1155} from "@openzeppelin/contracts/token/ERC1155/IERC1155.sol";
import {IERC1155Receiver} from "@openzeppelin/contracts/token/ERC1155/IERC1155Receiver.sol";
import {IERC165} from "@openzeppelin/contracts/utils/introspection/IERC165.sol";
import {IERC4907} from "./interfaces/IERC4907.sol";
import {EscrowFactoryFacet} from "./facets/EscrowFactoryFacet.sol";

/**
 * @title VaipakamEscrowImplementation
 * @author Vaipakam Developer Team
 * @notice This is the upgradable implementation for per-user escrow contracts in the Vaipakam platform.
 * @dev This contract uses UUPS for upgradeability and Ownable for access control (owned by the Diamond).
 *      It handles ERC20 deposits/withdrawals and NFT (ERC721/1155) deposits/withdrawals.
 *      Supports ERC-4907 for rentable NFTs: setUser, userOf, userExpires (calls on external NFT contracts).
 *      Implements IERC721Receiver and IERC1155Receiver for safe transfers.
 *      For ERC721 rentals: Escrow calls setUser without necessarily holding the NFT (assumes operator approval).
 *      For ERC1155: Holds tokens, calls setUser if the contract supports IERC4907 (try-catch to handle non-support).
 *      Custom errors for gas efficiency. No reentrancy as asset ops are atomic.
 *      Initialize sets owner to Diamond. Expand for Phase 2 (e.g., multi-asset batches).
 */
contract VaipakamEscrowImplementation is
    UUPSUpgradeable,
    OwnableUpgradeable,
    ERC165Upgradeable,
    IERC721Receiver,
    IERC1155Receiver
{
    using SafeERC20 for IERC20;
    address private DIAMOND;
    address private IMPLEMENTATION_ADDRESS;

    /// @dev Escrow-side rental wrapper state. Authoritative for this platform:
    ///      external integrators SHOULD query the escrow (via the factory
    ///      wrappers) rather than the underlying NFT, since not all rented
    ///      NFTs implement IERC4907. One (nftContract, tokenId) slot holds a
    ///      list of concurrent rentals so ERC-1155 can expose the active
    ///      aggregate quantity and the minimum active expiry. ERC-721
    ///      rentals always collapse to a single entry with quantity = 1.
    ///      Storage kept at the tail of the layout for UUPS-upgrade safety.
    struct RentalEntry {
        address user;
        uint64 expires;
        uint128 quantity;
    }
    mapping(address => mapping(uint256 => RentalEntry[])) private _rentalEntries;

    // Custom errors for clarity and gas efficiency.
    /// @dev Caller is not the Diamond (or this contract itself via
    ///      self-call). Replaces the prior string revert
    ///      `"Only Diamond can execute"`.
    error NotAuthorized();
    error InvalidAmount();
    error TransferFailed();
    /// @dev A staticcall into the Diamond for data-read returned
    ///      `success == false`. Replaces `"Diamond call failed"`.
    error DiamondCallFailed();
    /// @dev Caller passed a quantity value that would overflow `uint128`
    ///      when packed into a {RentalEntry}. Replaces
    ///      `"quantity overflow"`.
    error QuantityOverflow();
    /// @dev An NFT (ERC-721 / ERC-1155) was pushed into this escrow via a
    ///      `safeTransferFrom` whose operator was neither the Diamond nor
    ///      this escrow itself. Direct user-initiated transfers are
    ///      rejected because every protocol-tracked deposit is mediated by
    ///      the Diamond — anything else would arrive without a matching
    ///      ledger entry and could only be recovered by an admin sweep.
    error UnauthorizedNFTSender();

    /// @dev Shared check for every function that must be callable only by
    ///      the owning Diamond (or via a controlled self-call). Consolidates
    ///      the repeated `msg.sender == DIAMOND || msg.sender == address(this)`
    ///      guard into one site so any future hardening (e.g. routing via
    ///      a dedicated facet) only has to change here.
    modifier onlyDiamond() {
        if (msg.sender != DIAMOND && msg.sender != address(this)) {
            revert NotAuthorized();
        }
        _;
    }

    /**
     * @notice Initializes the escrow implementation.
     * @dev Sets the owner to the Diamond proxy. Called on deployment.
     *      Uses initializer modifier to prevent re-init.
     */
    function initialize(
        address diamondAddress,
        address implAddress
    ) external initializer {
        __Ownable_init(diamondAddress); // Diamond as owner
        __ERC165_init();
        DIAMOND = diamondAddress;
        IMPLEMENTATION_ADDRESS = implAddress;
    }

    /**
     * @notice Deposits ERC-20 tokens into this escrow.
     * @dev Safe transfer from caller. Callable by owner (Diamond/facets).
     * @param token The ERC-20 token address.
     * @param amount The amount to deposit.
     */
    function depositERC20(address token, uint256 amount) external onlyOwner {
        IERC20(token).safeTransferFrom(msg.sender, address(this), amount);
    }

    // /**
    //  * @notice Gets a user's escrow proxy.
    //  * @dev View function to get user's escrow proxy address.
    //  * @param user The user address.
    //  * @return proxy The user's escrow proxy address.
    //  */
    // function getUserEscrow(address user) public returns (address proxy) {
    //     LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
    //     proxy = s.userVaipakamEscrows[user];
    // }

    /**
     * @notice Withdraws ERC-20 tokens from this escrow to a recipient.
     * @dev Safe transfer. Callable by owner (Diamond/facets).
     * @param token The ERC-20 token address.
     * @param recipient The recipient address.
     * @param amount The amount to withdraw.
     */
    function withdrawERC20(
        address token,
        address recipient,
        uint256 amount
    ) external onlyDiamond {
        IERC20(token).safeTransfer(recipient, amount);
    }

    /**
     * @notice Deposits an ERC-721 NFT into this escrow.
     * @dev Safe transfer from caller. Callable by owner.
     * @param nftContract The NFT contract address.
     * @param tokenId The token ID.
     */
    function depositERC721(
        address nftContract,
        uint256 tokenId
    ) external onlyDiamond {
        IERC721(nftContract).safeTransferFrom(
            msg.sender,
            address(this),
            tokenId
        );
    }

    /**
     * @notice Withdraws an ERC-721 NFT from this escrow to a recipient.
     * @dev Safe transfer. Callable by owner.
     * @param nftContract The NFT contract address.
     * @param tokenId The token ID.
     * @param recipient The recipient address.
     */
    function withdrawERC721(
        address nftContract,
        uint256 tokenId,
        address recipient
    ) external onlyDiamond {
        IERC721(nftContract).safeTransferFrom(
            address(this),
            recipient,
            tokenId
        );
    }

    /**
     * @notice Deposits ERC-1155 tokens into this escrow.
     * @dev Safe transfer from caller. Callable by owner.
     * @param nftContract The NFT contract address.
     * @param tokenId The token ID.
     * @param amount The amount to deposit.
     */
    function depositERC1155(
        address nftContract,
        uint256 tokenId,
        uint256 amount
    ) external onlyDiamond {
        IERC1155(nftContract).safeTransferFrom(
            msg.sender,
            address(this),
            tokenId,
            amount,
            ""
        );
    }

    /**
     * @notice Withdraws ERC-1155 tokens from this escrow to a recipient.
     * @dev Safe transfer. Callable by owner.
     * @param nftContract The NFT contract address.
     * @param tokenId The token ID.
     * @param amount The amount to withdraw.
     * @param recipient The recipient address.
     */
    function withdrawERC1155(
        address nftContract,
        uint256 tokenId,
        uint256 amount,
        address recipient
    ) external onlyDiamond {
        IERC1155(nftContract).safeTransferFrom(
            address(this),
            recipient,
            tokenId,
            amount,
            ""
        );
    }

    /**
     * @notice Approves this escrow as operator for an ERC-721 NFT (for rentals without holding).
     * @dev Calls IERC721.approve. Callable by owner (facets for lender offers).
     * @param nftContract The NFT contract address.
     * @param tokenId The token ID.
     */
    function approveERC721(
        address nftContract,
        uint256 tokenId
    ) external onlyDiamond {
        IERC721(nftContract).approve(address(this), tokenId);
    }

    /**
     * @notice Gets an offer amount from LibVaipakam via Diamond call.
     * @dev Example to read shared storage from escrow context.
     * @param offerId The offer ID.
     * @return amount The offer amount.
     */
    function getOfferAmountFromDiamond(
        uint256 offerId
    ) external view returns (uint256 amount) {
        (bool success, bytes memory result) = DIAMOND.staticcall(
            abi.encodeWithSelector(
                EscrowFactoryFacet.getOfferAmount.selector,
                offerId
            )
        );
        if (!success) revert DiamondCallFailed();
        amount = abi.decode(result, (uint256));
    }

    // function getDiamond() public view returns (address) {
    //     return DIAMOND;
    // }

    /**
     * @notice Sets the temporary user (renter) for a rentable NFT.
     * @dev Calls IERC4907.setUser on the external NFT contract.
     *      Uses try-catch to handle non-supporting contracts (reverts if fail).
     *      For ERC721: Assumes prior approval as operator.
     *      For ERC1155: Assumes held in escrow.
     *      Callable by owner (facets for loan acceptance).
     * @param nftContract The NFT contract address.
     * @param tokenId The token ID.
     * @param user The temporary user address.
     * @param expires The UNIX timestamp for expiration.
     */
    function setUser(
        address nftContract,
        uint256 tokenId,
        address user,
        uint64 expires
    ) external onlyDiamond {
        // ERC-721 single-slot semantics: replace the list with the new entry
        // (or clear it when `user` is zero, the reset path).
        delete _rentalEntries[nftContract][tokenId];
        if (user != address(0)) {
            _rentalEntries[nftContract][tokenId].push(
                RentalEntry({user: user, expires: expires, quantity: 1})
            );
        }
        bool forwards;
        try IERC165(nftContract).supportsInterface(type(IERC4907).interfaceId)
            returns (bool ok)
        {
            forwards = ok;
        } catch {
            forwards = false;
        }
        if (forwards) {
            IERC4907(nftContract).setUser(tokenId, user, expires);
        }
    }

    /**
     * @notice Records an ERC-1155 rental alongside any other active rentals
     *         already held in this escrow for the same (nftContract, tokenId).
     * @dev Aggregate-capable variant of {setUser} used for partial-quantity
     *      ERC-1155 rentals. If `user` already has an entry, its row is
     *      replaced; otherwise a new row is appended. Passing `quantity == 0`
     *      removes the user's entry. Expired rows encountered on the way are
     *      pruned to bound storage growth. IERC4907 forwarding is skipped —
     *      1155 rental is a first-party Vaipakam semantic and the underlying
     *      contract is not required to implement it.
     */
    function setUser1155(
        address nftContract,
        uint256 tokenId,
        address user,
        uint64 expires,
        uint256 quantity
    ) external onlyDiamond {
        if (quantity > type(uint128).max) revert QuantityOverflow();
        RentalEntry[] storage list = _rentalEntries[nftContract][tokenId];

        // Compact expired entries and locate any existing row for `user`.
        uint256 write;
        uint256 existingIdx = type(uint256).max;
        uint256 listLen = list.length;
        for (uint256 read; read < listLen; ) {
            RentalEntry memory e = list[read];
            if (e.user == user) {
                existingIdx = write;
            } else if (e.expires < block.timestamp) {
                // drop expired others
                unchecked { ++read; }
                continue;
            }
            if (write != read) {
                list[write] = e;
            }
            unchecked {
                ++write;
                ++read;
            }
        }
        while (list.length > write) {
            list.pop();
        }

        if (quantity == 0 || user == address(0)) {
            if (existingIdx != type(uint256).max) {
                uint256 last = list.length - 1;
                if (existingIdx != last) {
                    list[existingIdx] = list[last];
                }
                list.pop();
            }
            return;
        }

        if (existingIdx != type(uint256).max) {
            list[existingIdx] = RentalEntry({
                user: user,
                expires: expires,
                quantity: uint128(quantity)
            });
        } else {
            list.push(
                RentalEntry({
                    user: user,
                    expires: expires,
                    quantity: uint128(quantity)
                })
            );
        }
    }

    /**
     * @notice Gets the current user of a rentable NFT.
     * @dev Returns the first still-active entry. ERC-721 rentals collapse to
     *      a single entry so this preserves standard 4907 semantics. For
     *      ERC-1155 with concurrent renters this returns the first active
     *      user; integrators needing the full set should read the per-entry
     *      state via a future enumeration helper.
     */
    function userOf(
        address nftContract,
        uint256 tokenId
    ) external view returns (address) {
        RentalEntry[] storage list = _rentalEntries[nftContract][tokenId];
        uint256 listLen = list.length;
        for (uint256 i; i < listLen; ) {
            if (list[i].expires >= block.timestamp) return list[i].user;
            unchecked { ++i; }
        }
        return address(0);
    }

    /**
     * @notice Returns the minimum active expiry across all concurrent rentals
     *         for (nftContract, tokenId), or 0 if none are active.
     */
    function userExpires(
        address nftContract,
        uint256 tokenId
    ) external view returns (uint64) {
        RentalEntry[] storage list = _rentalEntries[nftContract][tokenId];
        uint256 listLen = list.length;
        uint64 minExp;
        for (uint256 i; i < listLen; ) {
            uint64 exp = list[i].expires;
            if (exp >= block.timestamp && (minExp == 0 || exp < minExp)) {
                minExp = exp;
            }
            unchecked { ++i; }
        }
        return minExp;
    }

    /**
     * @notice Returns the active aggregate rented quantity for (nftContract,
     *         tokenId). Expired entries are excluded. For ERC-721 this is
     *         either 0 or 1; for ERC-1155 it is the sum of concurrent
     *         active-renter quantities recorded via {setUser1155}.
     */
    function userQuantity(
        address nftContract,
        uint256 tokenId
    ) external view returns (uint256) {
        RentalEntry[] storage list = _rentalEntries[nftContract][tokenId];
        uint256 listLen = list.length;
        uint256 total;
        for (uint256 i; i < listLen; ) {
            if (list[i].expires >= block.timestamp) {
                unchecked {
                    total += list[i].quantity;
                }
            }
            unchecked { ++i; }
        }
        return total;
    }

    // Receiver hooks for safe transfers — accept ONLY when the operator
    // is the Diamond or a self-call. Any other operator means the NFT was
    // pushed in directly by a user / third-party; we revert so the
    // transfer fails atomically (no orphan asset, no off-ledger balance).
    // ERC-20 cannot be gated this way (no callback) — frontend warning +
    // operational sweep are the controls there.
    function onERC721Received(
        address operator,
        address,
        uint256,
        bytes calldata
    ) external view returns (bytes4) {
        if (operator != DIAMOND && operator != address(this)) {
            revert UnauthorizedNFTSender();
        }
        return IERC721Receiver.onERC721Received.selector;
    }

    function onERC1155Received(
        address operator,
        address,
        uint256,
        uint256,
        bytes calldata
    ) external view returns (bytes4) {
        if (operator != DIAMOND && operator != address(this)) {
            revert UnauthorizedNFTSender();
        }
        return IERC1155Receiver.onERC1155Received.selector;
    }

    function onERC1155BatchReceived(
        address operator,
        address,
        uint256[] calldata,
        uint256[] calldata,
        bytes calldata
    ) external view returns (bytes4) {
        if (operator != DIAMOND && operator != address(this)) {
            revert UnauthorizedNFTSender();
        }
        return IERC1155Receiver.onERC1155BatchReceived.selector;
    }

    // Supports interface for ERC165
    function supportsInterface(
        bytes4 interfaceId
    ) public view virtual override(ERC165Upgradeable, IERC165) returns (bool) {
        return
            interfaceId == type(IERC721Receiver).interfaceId ||
            interfaceId == type(IERC1155Receiver).interfaceId ||
            super.supportsInterface(interfaceId);
    }

    // UUPS authorize upgrade
    function _authorizeUpgrade(
        address newImplementation
    ) internal override onlyOwner {}

    /// @dev Storage gap reserved for future upgrade-safe state additions.
    ///      Each future storage var added to this contract must decrement
    ///      the array length by the number of slots it consumes so the
    ///      overall layout footprint stays constant. Without this gap,
    ///      a Phase-2 feature that introduces new escrow state would
    ///      collide with storage slots already in use on per-user
    ///      ERC1967 proxies deployed during Phase 1. 50 slots ≈ room
    ///      for ~50 uint256-sized fields (or proportionally fewer
    ///      mappings / arrays / larger structs); sized conservatively.
    uint256[50] private __gap;
}
