// src/VaipakamVaultImplementation.sol
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
import {VaultFactoryFacet} from "./facets/VaultFactoryFacet.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import {IListingExecutorValidator} from "./seaport/IListingExecutorValidator.sol";

/**
 * @title VaipakamVaultImplementation
 * @author Vaipakam Developer Team
 * @notice This is the upgradable implementation for per-user vault contracts in the Vaipakam platform.
 * @dev This contract uses UUPS for upgradeability and Ownable for access control (owned by the Diamond).
 *      It handles ERC20 deposits/withdrawals and NFT (ERC721/1155) deposits/withdrawals.
 *      Supports ERC-4907 for rentable NFTs: setUser, userOf, userExpires (calls on external NFT contracts).
 *      Implements IERC721Receiver and IERC1155Receiver for safe transfers.
 *      For ERC721 rentals: Vault calls setUser without necessarily holding the NFT (assumes operator approval).
 *      For ERC1155: Holds tokens, calls setUser if the contract supports IERC4907 (try-catch to handle non-support).
 *      Custom errors for gas efficiency. No reentrancy as asset ops are atomic.
 *      Initialize sets owner to Diamond. Expand for Phase 2 (e.g., multi-asset batches).
 */
contract VaipakamVaultImplementation is
    UUPSUpgradeable,
    OwnableUpgradeable,
    ERC165Upgradeable,
    IERC721Receiver,
    IERC1155Receiver
{
    using SafeERC20 for IERC20;
    address private diamond;
    address private implementationAddress;

    /// @dev Vault-side rental wrapper state. Authoritative for this platform:
    ///      external integrators SHOULD query the vault (via the factory
    ///      wrappers) rather than the underlying NFT, since not all rented
    ///      NFTs implement IERC4907. One (nftContract, tokenId) slot holds a
    ///      list of concurrent rentals so ERC-1155 can expose the active
    ///      aggregate quantity and the minimum active expiry. ERC-721
    ///      rentals always collapse to a single entry with quantity = 1.
    ///      Storage kept at the tail of the layout for UUPS-upgrade safety.
    ///      `rentalId` (#902) keys an ERC-1155 row to the one rental (the
    ///      Diamond's loan id) it records, so concurrent rentals of the same
    ///      token are separate rows and closing one leaves the others; it is
    ///      zero on an ERC-721 row. It packs into the slot `quantity` already
    ///      occupies, so the entry's two-slot stride is unchanged.
    struct RentalEntry {
        address user;
        uint64 expires;
        uint128 quantity;
        uint128 rentalId;
    }
    mapping(address => mapping(uint256 => RentalEntry[])) private _rentalEntries;

    /// @notice #902 — the most ACTIVE ERC-1155 rentals one (nftContract,
    ///         tokenId) may carry in this vault at once.
    /// @dev    Every write to a token's rental list, the closes included,
    ///         walks the whole list, and the Diamond reads it twice more for
    ///         {VaultRentalUpdated}'s aggregate. Without a bound, enough
    ///         concurrent rentals of one token would make a repayment, default
    ///         or handover of any of them cost more than a block allows, and
    ///         that rental could then never close. The bound is enforced where
    ///         a row is added (the accept), so a close always stays within it.
    ///         Expired rows are pruned before the count, so only rentals that
    ///         still confer rights take a place. A constant, not a knob:
    ///         raising it is a code change measured against the close path's
    ///         gas, never a setting.
    uint256 public constant MAX_CONCURRENT_RENTALS_1155 = 64;

    /// @dev T-086 step 7 — Seaport prepay-collateral-listing support,
    ///      and since #1566 S3e the 1inch swap-to-repay order this vault
    ///      makes (validator = the Diamond's `isOrderValid`).
    ///      Maps a Seaport `orderHash` to the executor singleton
    ///      address that recorded it. Populated by
    ///      {registerListingOrderHash} (called by the diamond's
    ///      `NFTPrepayListingFacet.postPrepayListing` /
    ///      `updatePrepayListing`); cleared by
    ///      {revokeListingOrderHash} (called by every cancel path
    ///      + the post-fill finalization). Consumed by this
    ///      contract's {isValidSignature} (ERC-1271) to delegate
    ///      Seaport's sign-time signature verification to the
    ///      executor's {IListingExecutorValidator.isOrderValid}.
    ///
    ///      Per-vault scope: each per-user vault holds the
    ///      orderHash → executor bindings for ITS borrower's
    ///      listings only. The mapping is sparse and small.
    ///
    ///      Storage layout note: appended to the tail of the
    ///      pre-gap layout, paired with a corresponding decrement
    ///      of `__gap` below to keep the overall slot footprint
    ///      constant across UUPS upgrades.
    mapping(bytes32 => address) private _listingExecutor;

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
    /// @dev #902 — a new ERC-1155 rental would take (nftContract, tokenId)
    ///      past {MAX_CONCURRENT_RENTALS_1155} active rows in this vault.
    ///      Raised only when a row is ADDED; updating or removing a rental's
    ///      own row never reverts with it.
    error TooManyConcurrentRentals(address nftContract, uint256 tokenId);
    /// @dev An NFT (ERC-721 / ERC-1155) was pushed into this vault via a
    ///      `safeTransferFrom` whose operator was neither the Diamond nor
    ///      this vault itself. Direct user-initiated transfers are
    ///      rejected because every protocol-tracked deposit is mediated by
    ///      the Diamond — anything else would arrive without a matching
    ///      ledger entry and could only be recovered by an admin sweep.
    error UnauthorizedNFTSender();

    /// @dev Shared check for every function that must be callable only by
    ///      the owning Diamond (or via a controlled self-call). Consolidates
    ///      the repeated `msg.sender == diamond || msg.sender == address(this)`
    ///      guard into one site so any future hardening (e.g. routing via
    ///      a dedicated facet) only has to change here.
    /// @dev Extracted modifier body to keep the modifier itself a thin
    ///      wrapper — every call site inlines the modifier, so the
    ///      check living in a private function dedupes the bytecode.
    function _checkDiamond() private view {
        if (msg.sender != diamond && msg.sender != address(this)) {
            revert NotAuthorized();
        }
    }

    modifier onlyDiamond() {
        _checkDiamond();
        _;
    }

    /**
     * @notice Initializes the vault implementation.
     * @dev Sets the owner to the Diamond proxy. Called on deployment.
     *      Uses initializer modifier to prevent re-init.
     */
    function initialize(
        address diamondAddress,
        address implAddress
    ) external initializer {
        __Ownable_init(diamondAddress); // Diamond as owner
        __ERC165_init();
        diamond = diamondAddress;
        implementationAddress = implAddress;
    }

    /**
     * @notice Deposits ERC-20 tokens into this vault.
     * @dev Safe transfer from caller. Callable by owner (Diamond/facets).
     * @param token The ERC-20 token address.
     * @param amount The amount to deposit.
     */
    // forge-lint: disable-next-line(mixed-case-function)
    function depositERC20(address token, uint256 amount) external onlyOwner {
        IERC20(token).safeTransferFrom(msg.sender, address(this), amount);
    }

    // /**
    //  * @notice Gets a user's vault proxy.
    //  * @dev View function to get user's vault proxy address.
    //  * @param user The user address.
    //  * @return proxy The user's vault proxy address.
    //  */
    // function getUserVault(address user) public returns (address proxy) {
    //     LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
    //     proxy = s.userVaipakamVaults[user];
    // }

    /**
     * @notice Withdraws ERC-20 tokens from this vault to a recipient.
     * @dev Safe transfer. Callable by owner (Diamond/facets).
     * @param token The ERC-20 token address.
     * @param recipient The recipient address.
     * @param amount The amount to withdraw.
     */
    // forge-lint: disable-next-line(mixed-case-function)
    function withdrawERC20(
        address token,
        address recipient,
        uint256 amount
    ) external onlyDiamond {
        IERC20(token).safeTransfer(recipient, amount);
    }

    /**
     * @notice Deposits an ERC-721 NFT into this vault.
     * @dev Safe transfer from caller. Callable by owner.
     * @param nftContract The NFT contract address.
     * @param tokenId The token ID.
     */
    // forge-lint: disable-next-line(mixed-case-function)
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
     * @notice Withdraws an ERC-721 NFT from this vault to a recipient.
     * @dev Safe transfer. Callable by owner.
     * @param nftContract The NFT contract address.
     * @param tokenId The token ID.
     * @param recipient The recipient address.
     */
    // forge-lint: disable-next-line(mixed-case-function)
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
     * @notice Deposits ERC-1155 tokens into this vault.
     * @dev Safe transfer from caller. Callable by owner.
     * @param nftContract The NFT contract address.
     * @param tokenId The token ID.
     * @param amount The amount to deposit.
     */
    // forge-lint: disable-next-line(mixed-case-function)
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
     * @notice Withdraws ERC-1155 tokens from this vault to a recipient.
     * @dev Safe transfer. Callable by owner.
     * @param nftContract The NFT contract address.
     * @param tokenId The token ID.
     * @param amount The amount to withdraw.
     * @param recipient The recipient address.
     */
    // forge-lint: disable-next-line(mixed-case-function)
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
     * @notice Approves this vault as operator for an ERC-721 NFT (for rentals without holding).
     * @dev Calls IERC721.approve. Callable by owner (facets for lender offers).
     * @param nftContract The NFT contract address.
     * @param tokenId The token ID.
     */
    // forge-lint: disable-next-line(mixed-case-function)
    function approveERC721(
        address nftContract,
        uint256 tokenId
    ) external onlyDiamond {
        IERC721(nftContract).approve(address(this), tokenId);
    }

    // ─── T-086 step 7 — Seaport prepay-listing narrow entries ───────────

    /// @notice Emitted when the diamond toggles a Seaport conduit's
    ///         per-token approval on the vault's collateral NFT.
    ///         `conduit == address(0)` (or `approved == false`)
    ///         signals an approval revocation.
    event CollateralOperatorApprovalSet(
        address indexed nftContract,
        uint256 indexed tokenId,
        address indexed conduit,
        bool approved
    );

    /// @notice Emitted when the diamond pins a Seaport `orderHash`
    ///         to its recording executor for ERC-1271 delegation.
    event ListingOrderHashRegistered(bytes32 indexed orderHash, address indexed executor);

    /// @notice Emitted when the diamond clears an orderHash → executor
    ///         binding (cancel / cancelExpired / post-fill).
    event ListingOrderHashRevoked(bytes32 indexed orderHash);

    /// @notice #1566 S3e — this vault's ERC-20 allowance to `spender` was set to `amount` by the
    ///         Diamond (a swap-to-repay intent's lot, approved to the pinned 1inch LOP).
    event ERC20ApprovalSet(address indexed token, address indexed spender, uint256 amount);

    /// @dev Caller-passed zero `orderHash` to a register / revoke.
    ///      Seaport never produces a zero hash so it's an obvious
    ///      sentinel the vault rejects.
    error ZeroOrderHash();

    /// @dev Caller-passed zero `executor` to {registerListingOrderHash}.
    error ZeroExecutor();

    /**
     * @notice Set / unset a Seaport conduit's per-token approval
     *         on a collateral NFT held by this vault.
     * @dev    Diamond-gated; the diamond is responsible for
     *         pre-validating that `conduit` is in the executor's
     *         governance-managed allow-list at call time. The
     *         vault performs the raw `IERC721.approve` write
     *         (passing `address(0)` to revoke when `approved` is
     *         `false`).
     *
     *         The NFT must already live in this vault — the
     *         `IERC721.approve` call would revert if the vault
     *         isn't the current owner, which is the right
     *         invariant: the diamond should only authorise an
     *         approval against a vault that holds the collateral.
     *
     *         Seaport-side semantic: after a successful fill,
     *         `IERC721.transferFrom` clears the per-token approval
     *         atomically with the transfer (ERC-721 standard), so
     *         the post-fill state is approval = `address(0)`
     *         without an explicit revoke call. The diamond's
     *         cancel paths DO explicitly revoke; that's the only
     *         path that leaves the NFT in the vault while clearing
     *         the approval.
     */
    function setCollateralOperatorApproval(
        address nftContract,
        uint256 tokenId,
        address conduit,
        bool approved
    ) external onlyDiamond {
        address target = approved ? conduit : address(0);
        IERC721(nftContract).approve(target, tokenId);
        emit CollateralOperatorApprovalSet(nftContract, tokenId, conduit, approved);
    }

    /**
     * @notice ERC1155 sibling of {setCollateralOperatorApproval}.
     *         Grants (or revokes) operator-level approval on an
     *         ERC1155 collateral collection — ERC1155 has no
     *         per-token `approve`; the standard's only approval
     *         surface is `setApprovalForAll(operator, approved)`,
     *         which is operator-wide on the collection.
     * @dev    Diamond-gated. T-086 step 15 extension folded into
     *         #306's architectural fix.
     *
     *         The operator-wide approval's blast radius is bounded
     *         by:
     *           1. The Seaport order's `FULL_RESTRICTED` orderType
     *              — Seaport refuses partial fills; the executor
     *              content gate enforces the full vaulted balance.
     *           2. The diamond's #306 canonical-order construction —
     *              the orderHash registered on the vault's
     *              ERC-1271 mapping corresponds to a SPECIFIC
     *              `(collection, tokenId, fullAmount)` offer
     *              that the diamond verified; a malicious order
     *              with a different shape would have a different
     *              hash and the vault's ERC-1271 would return
     *              INVALID for it.
     *
     *         The conduit-allow-list discipline on the executor
     *         singleton is the trust anchor — only conduits the
     *         protocol has explicitly approved can be passed.
     */
    function setCollateralOperatorApprovalERC1155(
        address nftContract,
        address conduit,
        bool approved
    ) external onlyDiamond {
        IERC1155(nftContract).setApprovalForAll(conduit, approved);
        emit CollateralOperatorApprovalSet(
            nftContract,
            0, // tokenId placeholder — ERC1155 approval is operator-wide
            conduit,
            approved
        );
    }

    /**
     * @notice Pin a Seaport `orderHash → executor` binding so this
     *         vault's ERC-1271 {isValidSignature} can delegate to
     *         that executor's `isOrderValid` at sign-verification
     *         time.
     * @dev    Diamond-gated. Called by
     *         `NFTPrepayListingFacet.postPrepayListing` and
     *         `updatePrepayListing` immediately after the diamond
     *         records the listing on the executor itself, so the
     *         vault's mapping and the executor's `orderContext`
     *         stay in lock-step; and (#1566 S3e) by the swap-to-repay
     *         commit, with the Diamond itself as the validator.
     */
    function registerListingOrderHash(bytes32 orderHash, address executor)
        external
        onlyDiamond
    {
        if (orderHash == bytes32(0)) revert ZeroOrderHash();
        if (executor == address(0)) revert ZeroExecutor();
        _listingExecutor[orderHash] = executor;
        emit ListingOrderHashRegistered(orderHash, executor);
    }

    /**
     * @notice Clear the `orderHash → executor` binding so the
     *         vault's ERC-1271 stops returning the magic value
     *         for `orderHash` (sign-time verifications for any
     *         subsequent Seaport fill of this order will then
     *         fail). Idempotent: clearing an already-cleared hash
     *         is a no-op.
     * @dev    Diamond-gated. Called by every cancel path
     *         (borrower cancel + permissionless grace-expired)
     *         and by the executor-finalize callback after a
     *         successful Seaport fill; and (#1566 S3e) by every
     *         swap-to-repay teardown and by its fill's post-hook.
     */
    function revokeListingOrderHash(bytes32 orderHash) external onlyDiamond {
        if (orderHash == bytes32(0)) revert ZeroOrderHash();
        delete _listingExecutor[orderHash];
        emit ListingOrderHashRevoked(orderHash);
    }

    /**
     * @notice #1566 S3e — set this vault's ERC-20 allowance to `spender` to exactly `amount`.
     * @dev    Diamond-gated. A swap-to-repay intent's 1inch order names this vault as its maker
     *         (registered through {registerListingOrderHash} with the Diamond as validator), so the
     *         LOP takes the auction lot from here, on this allowance, inside the fill. The Diamond
     *         raises it by the lot at commit and lowers it by the lot at a teardown; a fill consumes
     *         it as the LOP's own transfer. Always an exact amount, never an unlimited approval.
     */
    function approveERC20(address token, address spender, uint256 amount) external onlyDiamond {
        IERC20(token).forceApprove(spender, amount);
        emit ERC20ApprovalSet(token, spender, amount);
    }

    /**
     * @notice ERC-1271 signature-verification callback used by
     *         Seaport for orders whose `offerer` is this vault, and
     *         (#1566 S3e) by the 1inch LOP for the swap-to-repay order
     *         whose maker is this vault.
     *         Delegates to the executor pinned at register time;
     *         returns the magic value iff that executor still
     *         considers the order valid (recorded, conduit in the
     *         allow-list, loan still Active).
     * @dev    The `signature` argument is intentionally ignored —
     *         the vault doesn't sign with a private key. The
     *         orderHash binding registered by the diamond is the
     *         authoritative "we authorised an order with this
     *         hash" record. Anything not in `_listingExecutor`
     *         is rejected.
     *
     *         Why this lives on the vault (per design doc §4.3):
     *         Seaport pulls offer items from the order's
     *         `offerer` address. The vault holds the collateral
     *         NFT, so the vault IS the offerer. Seaport calls
     *         `offerer.isValidSignature(...)` per ERC-1271, so
     *         the callback must live here, not on the executor.
     *         The executor is the order's `zone` (which handles
     *         the post-fill `validateOrder` content checks); the
     *         offerer-and-zone are distinct roles in Seaport's
     *         restricted-order model.
     */
    function isValidSignature(bytes32 hash, bytes calldata /* signature */)
        external
        view
        returns (bytes4)
    {
        address exec = _listingExecutor[hash];
        if (exec == address(0)) return 0xffffffff;
        return IListingExecutorValidator(exec).isOrderValid(hash)
            ? bytes4(0x1626ba7e)
            : bytes4(0xffffffff);
    }

    /// @notice Read-side view: which executor (if any) does this
    ///         vault delegate ERC-1271 verification to for
    ///         `orderHash`? Returns `address(0)` if no binding.
    function getListingExecutor(bytes32 orderHash) external view returns (address) {
        return _listingExecutor[orderHash];
    }

    /**
     * @notice Gets an offer amount from LibVaipakam via Diamond call.
     * @dev Example to read shared storage from vault context.
     * @param offerId The offer ID.
     * @return amount The offer amount.
     */
    function getOfferAmountFromDiamond(
        uint256 offerId
    ) external view returns (uint256 amount) {
        (bool success, bytes memory result) = diamond.staticcall(
            abi.encodeWithSelector(
                VaultFactoryFacet.getOfferAmount.selector,
                offerId
            )
        );
        if (!success) revert DiamondCallFailed();
        amount = abi.decode(result, (uint256));
    }

    // function getDiamond() public view returns (address) {
    //     return diamond;
    // }

    /**
     * @notice Sets the temporary user (renter) of a rented ERC-721.
     * @dev Single-slot: replaces the token's one row, or clears it when
     *      `user` is zero. Forwards to IERC4907.setUser when the NFT
     *      supports it. ERC-1155 rentals use {setRental1155} instead, whose
     *      rows are per rental (#902): this function wipes every row for the
     *      token, which is correct only for a token that can be rented once
     *      at a time.
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
                RentalEntry({user: user, expires: expires, quantity: 1, rentalId: 0})
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
     * @notice Records, updates or removes ONE ERC-1155 rental of
     *         (nftContract, tokenId) held in this vault, leaving every other
     *         concurrent rental of the same token as it is (#902).
     * @dev Rows are keyed by `rentalId` (the Diamond passes the loan id), not
     *      by renter: two rentals of the same token, even to the same renter,
     *      are two rows, and closing one removes only its own. Passing
     *      `quantity == 0` or `user == address(0)` removes the row for
     *      `rentalId` (a no-op when there is none). Expired rows of OTHER
     *      rentals met on the way are pruned to bound storage growth: an
     *      expired rental confers no rights, and its own later close finds no
     *      row to remove. Adding a row when the token already has
     *      {MAX_CONCURRENT_RENTALS_1155} active rows reverts
     *      {TooManyConcurrentRentals}; an update or a removal never does.
     *      IERC4907 forwarding is skipped: ERC-1155 has no
     *      standard per-quantity user interface, so this vault is the
     *      integration surface for ERC-1155 rental reads.
     * @param nftContract The ERC-1155 contract.
     * @param tokenId     The token id rented.
     * @param rentalId    The rental this row records (the Diamond's loan id).
     * @param user        The renter, or zero to remove the rental's row.
     * @param expires     When the renter's rights end.
     * @param quantity    Units rented, or zero to remove the rental's row.
     */
    function setRental1155(
        address nftContract,
        uint256 tokenId,
        uint256 rentalId,
        address user,
        uint64 expires,
        uint256 quantity
    ) external onlyDiamond {
        if (quantity > type(uint128).max) revert QuantityOverflow();
        uint128 key = SafeCast.toUint128(rentalId);
        RentalEntry[] storage list = _rentalEntries[nftContract][tokenId];

        // Compact expired rows of other rentals and locate this rental's row.
        uint256 write;
        uint256 existingIdx = type(uint256).max;
        uint256 listLen = list.length;
        for (uint256 read; read < listLen; ) {
            RentalEntry memory e = list[read];
            if (e.rentalId == key) {
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

        RentalEntry memory row = RentalEntry({
            user: user,
            expires: expires,
            quantity: SafeCast.toUint128(quantity),
            rentalId: key
        });
        if (existingIdx != type(uint256).max) {
            list[existingIdx] = row;
        } else {
            if (list.length >= MAX_CONCURRENT_RENTALS_1155) {
                revert TooManyConcurrentRentals(nftContract, tokenId);
            }
            list.push(row);
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
     *         active-renter quantities recorded via {setRental1155}.
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
    // forge-lint: disable-next-line(mixed-case-function)
    function onERC721Received(
        address operator,
        address,
        uint256,
        bytes calldata
    ) external view returns (bytes4) {
        if (operator != diamond && operator != address(this)) {
            revert UnauthorizedNFTSender();
        }
        return IERC721Receiver.onERC721Received.selector;
    }

    // forge-lint: disable-next-line(mixed-case-function)
    function onERC1155Received(
        address operator,
        address,
        uint256,
        uint256,
        bytes calldata
    ) external view returns (bytes4) {
        if (operator != diamond && operator != address(this)) {
            revert UnauthorizedNFTSender();
        }
        return IERC1155Receiver.onERC1155Received.selector;
    }

    // forge-lint: disable-next-line(mixed-case-function)
    function onERC1155BatchReceived(
        address operator,
        address,
        uint256[] calldata,
        uint256[] calldata,
        bytes calldata
    ) external view returns (bytes4) {
        if (operator != diamond && operator != address(this)) {
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
    ///      a Phase-2 feature that introduces new vault state would
    ///      collide with storage slots already in use on per-user
    ///      ERC1967 proxies deployed during Phase 1. 50 slots ≈ room
    ///      for ~50 uint256-sized fields (or proportionally fewer
    ///      mappings / arrays / larger structs); sized conservatively.
    // forge-lint: disable-next-line(mixed-case-variable)
    uint256[49] private __gap;
}
