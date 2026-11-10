// src/VaipakamVaultImplementation.sol
// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {OwnableUpgradeable} from "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import {ERC165Upgradeable} from "@openzeppelin/contracts-upgradeable/utils/introspection/ERC165Upgradeable.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {IERC721Receiver} from "@openzeppelin/contracts/token/ERC721/IERC721Receiver.sol";
import {IERC1155} from "@openzeppelin/contracts/token/ERC1155/IERC1155.sol";
import {IERC1155Receiver} from "@openzeppelin/contracts/token/ERC1155/IERC1155Receiver.sol";
import {IERC165} from "@openzeppelin/contracts/utils/introspection/IERC165.sol";
import {ERC1967Utils} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Utils.sol";
import {LibVaultProtectionStorage} from "./vault/LibVaultProtectionStorage.sol";

/// @dev The one Diamond read a vault makes: whether an address is a Vaipakam
///      vault (`VaultDepositoryFacet.getVaultOwner`, zero if not).
interface IVaultRegistryView {
    function getVaultOwner(address vault) external view returns (address user);
}
import {IERC4907} from "./interfaces/IERC4907.sol";
import {VaultFactoryFacet} from "./facets/VaultFactoryFacet.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import {VaultOutflowTypes} from "./vault/VaultOutflowTypes.sol";
import {ListingEscrow} from "./vault/ListingEscrow.sol";
import {ISwapAdapter} from "./interfaces/ISwapAdapter.sol";
import {OrderComponents, ISeaportOrderHash} from "./seaport/ISeaportOrderHash.sol";
import {IOrderMixin} from "@1inch/limit-order-protocol/contracts/interfaces/IOrderMixin.sol";
import {AddressLib, Address as LopAddress} from "@1inch/solidity-utils/contracts/libraries/AddressLib.sol";

/// @dev The one PositionNFT read a vault makes: who holds a position now.
interface IPositionHolderView {
    function holderOf(uint256 tokenId) external view returns (address);
}

/// @dev The one read a vault makes of another vault: its recorded owner.
interface IVaultOwnerView {
    function vaultOwner() external view returns (address);
    function vaultCreationOwner() external view returns (address);
}

/// @dev #3393 — the init-code hash every vault proxy of a beacon shares.
interface IVaultBeaconInitHash {
    function PROXY_INIT_CODE_HASH() external view returns (bytes32);
}

/**
 * @title VaipakamVaultImplementation
 * @author Vaipakam Developer Team
 * @notice The code every per-user vault runs, resolved through the VaultBeacon (#3204).
 * @dev Each vault is a `BeaconProxy`; the code it runs changes only through the
 *      beacon's timelocked registration and the owner's own pin, never through
 *      an upgrade entry on the vault. Ownable (owned by the Diamond) gates the
 *      deposit entry.
 *      It handles ERC20 deposits and NFT (ERC721/1155) deposits. Every movement
 *      OUT passes {transferOut} or {grantAllowance}, which check the
 *      destination themselves (#3205 part 2, `VaultOutflowPolicyDesign.md` §3).
 *      Supports ERC-4907 for rentable NFTs: setUser, userOf, userExpires (calls on external NFT contracts).
 *      Implements IERC721Receiver and IERC1155Receiver for safe transfers.
 *      For ERC721 rentals: Vault calls setUser without necessarily holding the NFT (assumes operator approval).
 *      For ERC1155: Holds tokens, calls setUser if the contract supports IERC4907 (try-catch to handle non-support).
 *      Custom errors for gas efficiency. No reentrancy as asset ops are atomic.
 *      A proxy's initialize sets its owner to the Diamond; the implementation itself
 *      is never initialized (its constructor disables that, #905).
 *      Expand for Phase 2 (e.g., multi-asset batches).
 */
contract VaipakamVaultImplementation is
    OwnableUpgradeable,
    ERC165Upgradeable,
    IERC721Receiver,
    IERC1155Receiver
{
    using SafeERC20 for IERC20;
    address private diamond;
    /// @dev The vault's owner wallet, recorded once at creation (#3204). The
    ///      VaultBeacon verifies every pin, unpin, pin-delay and cancel
    ///      signature against it, so which code a vault runs never depends on
    ///      the Diamond's word about who owns it. Replacing it on a protected
    ///      primary replacement arrives with #3205.
    address private ownerWallet;

    /// @notice The PositionNFT core (#3205): who holds each position. A holder
    ///         payout is checked against it, never against the Diamond's word.
    address public immutable POSITION_NFT;
    /// @notice #3431 — the endpoints this vault code may pay or approve,
    ///         fixed in the CODE (no registry, no Diamond write can move them).
    ///         Changing one is new vault code through the VaultBeacon. A zero
    ///         endpoint leaves its class closed.
    /// @dev    TREASURY: the only treasury-class payee. BACKSTOP: the backstop
    ///         vault contract (a backstop-class payee is the genuine vault
    ///         whose owner record is it). SEAPORT / ORDER_PROTOCOL: the only
    ///         callers this vault's ERC-1271 answers, each for the orders it
    ///         hashed. CONDUIT / CONDUIT_KEY: the one listing conduit a vault
    ///         or its escrow approves, and the key a listing must name.
    ///         PRICE_GUARD: the standalone price guard (#3447), read from
    ///         #3268 on.
    address public immutable TREASURY;
    address public immutable BACKSTOP;
    address public immutable SEAPORT;
    address public immutable ORDER_PROTOCOL;
    address public immutable CONDUIT;
    bytes32 public immutable CONDUIT_KEY;
    address public immutable PRICE_GUARD;
    /// @notice #3379 B2 — the protected-mode code this vault delegatecalls.
    address public immutable PROTECTION;

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

    /// @dev RETIRED by #3431 (Stage B1): no longer written or read; the
    ///      slot is kept so the layout stays append-only. Order hashes now
    ///      live in {_orderVerifier}, keyed to the protocol that may ask.
    ///      Former role: T-086 step 7 — Seaport prepay-collateral-listing support,
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
    ///      executor's `isOrderValid`.
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
     * @notice Locks the implementation contract itself (#905).
     * @dev Only a proxy is ever initialized. The implementation's own
     *      storage is never used, so its initializer is disabled at
     *      construction: nobody can call `initialize` on it to become its
     *      owner, whatever path deployed it, and with no owner nobody can
     *      reach `_authorizeUpgrade` on it either. This used to depend on
     *      every deployer remembering to initialize the template in the
     *      same transaction; `upgradeVaultImplementation` checks only that
     *      the new implementation has code, so a template deployed without
     *      that step was open to whoever called first.
     *      #3205 part 2 / #3431 — `positionNft` and every endpoint are
     *      immutables of the CODE, so every vault running this version reads
     *      the same contracts, and no Diamond write can redirect them.
     * @custom:oz-upgrades-unsafe-allow constructor
     */
    constructor(address positionNft, VaultOutflowTypes.VaultEndpoints memory e) {
        _disableInitializers();
        POSITION_NFT = positionNft;
        TREASURY = e.treasury;
        BACKSTOP = e.backstop;
        SEAPORT = e.seaport;
        ORDER_PROTOCOL = e.orderProtocol;
        CONDUIT = e.conduit;
        CONDUIT_KEY = e.conduitKey;
        PRICE_GUARD = e.priceGuard;
        PROTECTION = e.protection;
    }

    /// @notice #3431 — the endpoints fixed in this vault code, as one record.
    function vaultEndpoints() external view returns (VaultOutflowTypes.VaultEndpoints memory) {
        return VaultOutflowTypes.VaultEndpoints({
            treasury: TREASURY,
            backstop: BACKSTOP,
            seaport: SEAPORT,
            orderProtocol: ORDER_PROTOCOL,
            conduit: CONDUIT,
            conduitKey: CONDUIT_KEY,
            priceGuard: PRICE_GUARD,
            protection: PROTECTION
        });
    }

    /**
     * @notice Initializes one user's vault proxy.
     * @dev Sets the owner to the Diamond. Called once, by the factory, in
     *      the proxy's construction ({VaultFactoryFacet.getOrCreateUserVault}).
     *      Never callable on the implementation itself (see the constructor).
     */
    function initialize(
        address diamondAddress,
        address vaultOwnerWallet
    ) external initializer {
        __Ownable_init(diamondAddress); // Diamond as owner
        __ERC165_init();
        diamond = diamondAddress;
        ownerWallet = vaultOwnerWallet;
        creationOwner = vaultOwnerWallet;
    }

    /// @notice The storage-layout identity of the vault family. The
    ///         VaultBeacon registers only implementations that report it, so
    ///         a contract that is not a vault cannot be registered by mistake.
    ///         Every version keeps the vault's storage append-only.
    function vaultLayoutId() external pure returns (bytes32) {
        return keccak256("vaipakam.vault.layout.v1");
    }

    /// @notice The owner wallet this vault recorded at creation (#3204).
    function vaultOwner() external view returns (address) {
        return ownerWallet;
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



    // ─── T-086 step 7 — Seaport prepay-listing narrow entries ───────────


    /// @notice #3431 — this vault hashed an order it makes and will answer
    ///         ERC-1271 for it, to `verifier` only (Seaport or the 1inch
    ///         order protocol).
    event OrderHashRegistered(bytes32 indexed orderHash, address indexed verifier);

    /// @notice Emitted when the diamond clears an order hash (cancel /
    ///         cancelExpired / post-fill / teardown).
    event ListingOrderHashRevoked(bytes32 indexed orderHash);

    /// @dev #3431 — an order's terms name another maker or offerer than this
    ///      vault (or one of its own listing escrows).
    error OrderNotThisVaults(address maker);
    /// @dev #3431 — a listing names another conduit key than the constant's.
    error OrderConduitRefused(bytes32 conduitKey);
    /// @dev #3431 — the protocol this order needs is not set in this code.
    error OrderProtocolUnset();
    /// @dev #3431 — {swapOut}'s adapter took more than offered, or delivered
    ///      less than the floor; or the adapter is refused.
    error SwapOutcomeRefused();


    /// @dev Caller-passed zero `orderHash` to a register / revoke.
    ///      Seaport never produces a zero hash so it's an obvious
    ///      sentinel the vault rejects.
    error ZeroOrderHash();



    /**
     * @notice #3431 — register a Seaport listing this vault (or one of its
     *         listing escrows) offers, from its TERMS. The vault checks the
     *         offerer and the conduit key and asks Seaport for the hash
     *         itself, so it can only ever answer for an order of that shape.
     * @dev    Diamond-gated. Stage B1 checks the offerer and the conduit;
     *         the payment legs are checked against the owner's signed terms
     *         from Stage B3 (the listing-hash rule). Until then the Diamond
     *         builds them and the listing's zone checks them at fill.
     * @param  c          The order components, `counter` included.
     * @param  escrowKey  0 for an order this vault offers; the listing key
     *                    when its offerer is this vault's escrow for it.
     * @return orderHash  Seaport's hash of `c`.
     */
    function registerSeaportOrder(OrderComponents calldata c, bytes32 escrowKey)
        external
        onlyDiamond
        returns (bytes32 orderHash)
    {
        address seaport = SEAPORT;
        if (seaport == address(0)) revert OrderProtocolUnset();
        address offerer = c.offerer;
        if (escrowKey == bytes32(0) ? offerer != address(this) : offerer != listingEscrowAddress(escrowKey)) {
            revert OrderNotThisVaults(offerer);
        }
        if (c.conduitKey != CONDUIT_KEY) revert OrderConduitRefused(c.conduitKey);
        orderHash = ISeaportOrderHash(seaport).getOrderHash(c);
        _recordOrder(orderHash, seaport);
    }

    /**
     * @notice #3431 — register a 1inch limit order this vault makes (the
     *         swap-to-repay order), from its TERMS: the vault checks it is the
     *         maker and asks the order protocol for the hash itself.
     * @dev    Diamond-gated. The receiver is the Diamond, which repays the
     *         loan inside the fill's post-hook (stated in the design, B1 §7).
     */
    function registerLimitOrder(IOrderMixin.Order calldata o)
        external
        onlyDiamond
        returns (bytes32 orderHash)
    {
        address lop = ORDER_PROTOCOL;
        if (lop == address(0)) revert OrderProtocolUnset();
        address maker = AddressLib.get(o.maker);
        if (maker != address(this)) revert OrderNotThisVaults(maker);
        orderHash = IOrderMixin(lop).hashOrder(o);
        _recordOrder(orderHash, lop);
    }

    function _recordOrder(bytes32 orderHash, address verifier) private {
        if (orderHash == bytes32(0)) revert ZeroOrderHash();
        _orderVerifier[orderHash] = verifier;
        emit OrderHashRegistered(orderHash, verifier);
    }

    /**
     * @notice Clear an order hash so the
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
        delete _orderVerifier[orderHash];
        emit ListingOrderHashRevoked(orderHash);
    }


    // ─── #3205 part 2 — the one door out ───────────────────────────────

    /// @notice A movement out of this vault, as the vault checked and made it.
    event VaultTransferOut(
        VaultOutflowTypes.OutflowClass indexed class_,
        address indexed asset,
        address indexed to,
        uint256 tokenId,
        uint256 amount,
        uint256 ref
    );
    /// @notice A just-in-time allowance opened.
    event VaultGrantOpened(address indexed asset, address indexed spender, uint256 tokenId, uint256 amount, uint256 ref);
    /// @notice A just-in-time allowance closed; `consumed` is what the spender
    ///         took (ERC-20 units, or 1 for an ERC-721 that left).
    event VaultGrantClosed(address indexed asset, address indexed spender, uint256 tokenId, uint256 consumed, uint256 ref);

    /// @dev The destination is not one `class_` may reach.
    error OutflowDestinationRefused(VaultOutflowTypes.OutflowClass class_, address to);
    /// @dev A grant names a spender other than its class's constant, or an asset kind
    ///      the vault never grants (ERC-1155).
    error GrantRefused(VaultOutflowTypes.GrantClass class_, address spender);
    /// @dev A just-in-time allowance is open: nothing else leaves until it closes.
    error GrantOpen(uint256 ref);
    error ZeroOutflow();

    /// @dev The one open just-in-time allowance (§3.5 rule 2). `spender` 0 =
    ///      none. While it is open the vault refuses every other outflow and
    ///      grant, so an allowance can never be combined with a second door.
    struct OpenGrant {
        VaultOutflowTypes.AssetKind kind;
        address asset;
        uint256 tokenId;
        uint256 amount;
        address spender;
        uint256 ref;
    }
    OpenGrant private _openGrant;

    /// @dev Set by {grantAllowance} for the rest of its transaction: within
    ///      the transaction that opened a grant only the Diamond may close it,
    ///      so a party reentering during the fill (a Seaport order's own
    ///      recipient, say) cannot close it first and leave the Diamond's
    ///      close nothing to book. Transient: no storage slot, gone at the end
    ///      of the transaction, after which anyone may close a leftover grant.
    bool private transient _grantOpenedThisTx;

    /// @dev #3205 part 2 — the listing escrows this vault created, by address:
    ///      the listing key each one serves (0 = not one of this vault's).
    mapping(address => bytes32) private _escrowKey;

    /// @dev #3431 — the order hashes this vault computed from terms it was
    ///      given, each with the one protocol whose ERC-1271 query it answers
    ///      (Seaport or the 1inch order protocol). 0 = not one of its orders.
    mapping(bytes32 => address) private _orderVerifier;

    /// @dev #3393 — the wallet this vault was created for; its CREATE2 salt.
    ///      Written once, at initialize.
    address private creationOwner;

    event ListingEscrowOpened(bytes32 indexed key, address indexed escrow, address asset, address conduit);
    event ListingEscrowClosed(bytes32 indexed key, address indexed escrow, uint256 returned);

    /**
     * @notice The address of this vault's escrow for listing `key` (deployed
     *         or not). A listing order names it as offerer before it exists.
     */
    function listingEscrowAddress(bytes32 key) public view returns (address) {
        return address(
            uint160(
                uint256(
                    keccak256(
                        abi.encodePacked(bytes1(0xff), address(this), key, keccak256(type(ListingEscrow).creationCode))
                    )
                )
            )
        );
    }

    /**
     * @notice Create (once per key) the escrow for listing `key` and approve
     *         `conduit` on it for `asset`. The lot moves in afterwards through
     *         {transferOut} (class ListingEscrow).
     */
    function openListingEscrow(bytes32 key, address asset, address conduit)
        external
        onlyDiamond
        returns (address escrow)
    {
        if (key == bytes32(0)) revert ZeroOutflow();
        // The escrow's conduit approval is a spender right the vault causes,
        // so it passes the same spender rule as every grant.
        _requireSpender(VaultOutflowTypes.GrantClass.Conduit, conduit);
        escrow = listingEscrowAddress(key);
        if (escrow.code.length == 0) {
            escrow = address(new ListingEscrow{salt: key}());
        }
        _escrowKey[escrow] = key;
        ListingEscrow(escrow).approve(asset, conduit);
        emit ListingEscrowOpened(key, escrow, asset, conduit);
    }

    /// @notice Bring back whatever escrow `key` still holds of `asset` /
    ///         `tokenId` and revoke its approval (a cancel, an expiry, a
    ///         teardown; after a fill it returns nothing).
    function closeListingEscrow(bytes32 key, address asset, uint256 tokenId)
        external
        onlyDiamond
        returns (uint256 returned)
    {
        address escrow = listingEscrowAddress(key);
        if (_escrowKey[escrow] != key) return 0;
        returned = ListingEscrow(escrow).close(asset, tokenId);
        emit ListingEscrowClosed(key, escrow, returned);
    }

    /**
     * @notice Move one asset out of this vault (#3205 part 2, §3.1). The ONLY
     *         way value leaves a vault at the Diamond's call.
     * @dev    Diamond-gated, and then checked here on the vault's own
     *         knowledge (layer 2, §3.3): the Diamond's policy host has
     *         already checked intent against loan state (layer 1). Stage A
     *         checks the destination; Stage B (#3379) adds the owner-signed
     *         lien bound on the amount. Refused while a grant is open.
     */
    function transferOut(VaultOutflowTypes.Outflow calldata o) external onlyDiamond {
        if (_openGrant.spender != address(0)) revert GrantOpen(_openGrant.ref);
        if (_swapping) revert SwapOutcomeRefused();
        if (o.amount == 0 || o.to == address(0)) revert ZeroOutflow();
        if (!_destinationAllowed(o)) revert OutflowDestinationRefused(o.class_, o.to);
        if (o.kind == VaultOutflowTypes.AssetKind.ERC20) {
            IERC20(o.asset).safeTransfer(o.to, o.amount);
        } else if (o.kind == VaultOutflowTypes.AssetKind.ERC721) {
            IERC721(o.asset).safeTransferFrom(address(this), o.to, o.tokenId);
        } else {
            IERC1155(o.asset).safeTransferFrom(address(this), o.to, o.tokenId, o.amount, "");
        }
        emit VaultTransferOut(o.class_, o.asset, o.to, o.tokenId, o.amount, o.ref);
    }

    /**
     * @notice Open a just-in-time allowance for the transaction that uses it
     *         (§3.5). One at a time; the Diamond closes it in the same
     *         transaction ({closeGrant}), and anyone may close a leftover one.
     * @dev    The spender must belong to the registry set its class names.
     *         ERC-20 and ERC-721 only: the vault never grants an operator-wide
     *         approval (rule 3); an ERC-1155 listing goes through an escrow.
     */
    function grantAllowance(VaultOutflowTypes.Grant calldata g) external onlyDiamond {
        if (_openGrant.spender != address(0)) revert GrantOpen(_openGrant.ref);
        if (_swapping) revert SwapOutcomeRefused();
        if (g.kind == VaultOutflowTypes.AssetKind.ERC1155) revert GrantRefused(g.class_, g.spender);
        _requireSpender(g.class_, g.spender);
        _openGrant = OpenGrant({kind: g.kind, asset: g.asset, tokenId: g.tokenId, amount: g.amount, spender: g.spender, ref: g.ref});
        _grantOpenedThisTx = true;
        if (g.kind == VaultOutflowTypes.AssetKind.ERC20) {
            IERC20(g.asset).forceApprove(g.spender, g.amount);
        } else {
            IERC721(g.asset).approve(g.spender, g.tokenId);
        }
        emit VaultGrantOpened(g.asset, g.spender, g.tokenId, g.amount, g.ref);
    }

    /**
     * @notice Close the open allowance, if any, and report what the spender
     *         took. Within the transaction that opened it only the Diamond
     *         may (it books what was taken); afterwards anyone may, since a
     *         leftover grant can only be reduced (§3.5 rule 2).
     * @dev    Consumption is measured from the approval itself, never from the
     *         vault's balance, so a donation in the meantime cannot mask a
     *         spend. ERC-721: if the vault no longer owns the token the token
     *         contract already cleared the approval, so nothing is called (an
     *         `approve` would revert and roll back a good fill).
     * @return consumed ERC-20 units taken, or 1 for an ERC-721 that left; 0
     *         when nothing was open.
     */
    function closeGrant() external returns (uint256 consumed) {
        OpenGrant memory g = _openGrant;
        if (g.spender == address(0)) return 0;
        if (_grantOpenedThisTx && msg.sender != diamond) revert NotAuthorized();
        delete _openGrant;
        if (g.kind == VaultOutflowTypes.AssetKind.ERC20) {
            uint256 left = IERC20(g.asset).allowance(address(this), g.spender);
            consumed = left >= g.amount ? 0 : g.amount - left;
            if (left != 0) IERC20(g.asset).forceApprove(g.spender, 0);
        } else if (IERC721(g.asset).ownerOf(g.tokenId) == address(this)) {
            IERC721(g.asset).approve(address(0), g.tokenId);
        } else {
            consumed = 1;
        }
        emit VaultGrantClosed(g.asset, g.spender, g.tokenId, consumed, g.ref);
    }

    /// @notice #3431 — a swap out of this vault, as the vault measured it.
    event VaultSwapOut(
        address indexed assetIn,
        address indexed assetOut,
        address indexed to,
        address adapter,
        uint256 spent,
        uint256 received,
        uint256 ref
    );

    /// @dev #3431 — set for the length of a {swapOut}: no other outflow,
    ///      grant or swap may run while the adapter holds an allowance.
    bool private transient _swapping;

    /**
     * @notice #3431 — sell at most `w.maxIn` of one ERC-20 through an adapter
     *         on the fixed swap interface, in one call, judged by its result.
     * @dev    Diamond-gated. Refuses an adapter that is not a contract, this
     *         vault, the Diamond or either asset. Measures this vault's input
     *         balance and the recipient's output balance around the call, so
     *         the adapter can take no more than `maxIn` and must deliver at
     *         least `minOut`; the allowance is opened and closed inside the
     *         call. Refused while a grant is open or another swap runs.
     * @return spent    What the adapter took of `assetIn`.
     * @return received What the recipient's `assetOut` balance rose by.
     */
    function swapOut(VaultOutflowTypes.SwapOut calldata w)
        external
        onlyDiamond
        returns (uint256 spent, uint256 received)
    {
        if (_openGrant.spender != address(0)) revert GrantOpen(_openGrant.ref);
        if (_swapping) revert SwapOutcomeRefused();
        address adapter = w.adapter;
        if (
            w.maxIn == 0 || w.assetIn == w.assetOut || adapter.code.length == 0 || adapter == address(this)
                || adapter == diamond || adapter == w.assetIn || adapter == w.assetOut
        ) revert SwapOutcomeRefused();
        address to = w.to;
        if (to != address(this) && (to != ownerWallet || _protectedLocked()) && !_isHolderVault(to, w.positionToken)) {
            revert OutflowDestinationRefused(VaultOutflowTypes.OutflowClass.SwapAdapter, to);
        }
        IERC20 tokenIn = IERC20(w.assetIn);
        uint256 inBefore = tokenIn.balanceOf(address(this));
        uint256 outBefore = IERC20(w.assetOut).balanceOf(to);
        _swapping = true;
        tokenIn.forceApprove(adapter, w.maxIn);
        ISwapAdapter(adapter).execute(w.assetIn, w.assetOut, w.maxIn, w.minOut, to, w.adapterData);
        tokenIn.forceApprove(adapter, 0);
        _swapping = false;
        uint256 inAfter = tokenIn.balanceOf(address(this));
        uint256 outAfter = IERC20(w.assetOut).balanceOf(to);
        if (inAfter > inBefore || outAfter < outBefore) revert SwapOutcomeRefused();
        spent = inBefore - inAfter;
        received = outAfter - outBefore;
        if (spent == 0 || spent > w.maxIn || received < w.minOut) revert SwapOutcomeRefused();
        emit VaultSwapOut(w.assetIn, w.assetOut, to, adapter, spent, received, w.ref);
    }

    /// @notice The open allowance, if any (`spender` 0 = none).
    function openGrant()
        external
        view
        returns (address asset, address spender, uint256 tokenId, uint256 amount, uint256 ref)
    {
        OpenGrant storage g = _openGrant;
        return (g.asset, g.spender, g.tokenId, g.amount, g.ref);
    }

    /// @dev Layer 2 (§3.3): whether `o.to` is a destination `o.class_` may
    ///      reach, on what this vault can establish without the Diamond.
    function _destinationAllowed(VaultOutflowTypes.Outflow calldata o) private view returns (bool) {
        VaultOutflowTypes.OutflowClass c = o.class_;
        if (c == VaultOutflowTypes.OutflowClass.Owner) return o.to == ownerWallet && !_protectedLocked();
        // #3379 B2 — an allowlisted destination is one on this vault's OWN
        // protected record, finalized after its delay, while not locked.
        if (c == VaultOutflowTypes.OutflowClass.OwnerAllowlisted) {
            LibVaultProtectionStorage.Layout storage pl = LibVaultProtectionStorage.layout();
            if (!pl.enabled || pl.locked) return false;
            if (pl.allow[o.to].active) return true;
            // Codex #3489 r1 — a destination that has protected mode on is
            // paid into ITS vault (the outflow policy redirects it there): the
            // vault created for an allowlisted wallet, which this vault proves
            // from the address its creation owner derives.
            if (!_isGenuineVault(o.to) || o.to == address(this)) return false;
            return pl.allow[IVaultOwnerView(o.to).vaultCreationOwner()].active;
        }
        if (
            c == VaultOutflowTypes.OutflowClass.PositionHolder || c == VaultOutflowTypes.OutflowClass.Counterparty
                || c == VaultOutflowTypes.OutflowClass.Consolidation
        ) {
            return _isHolderVault(o.to, o.positionToken);
        }
        if (c == VaultOutflowTypes.OutflowClass.Treasury) return TREASURY != address(0) && o.to == TREASURY;
        if (c == VaultOutflowTypes.OutflowClass.Backstop) {
            address backstop = BACKSTOP;
            return backstop != address(0) && _isGenuineVault(o.to) && IVaultOwnerView(o.to).vaultCreationOwner() == backstop;
        }
        // #3431 — a swap leaves only through {swapOut}, judged by its result;
        // a plain transfer to an adapter is never a destination.
        if (c == VaultOutflowTypes.OutflowClass.SwapAdapter) return false;
        if (c == VaultOutflowTypes.OutflowClass.DiamondTransient) return o.to == diamond;
        // An escrow this vault created for the listing the outflow names
        // (`positionToken` carries the listing key for this class).
        if (c == VaultOutflowTypes.OutflowClass.ListingEscrow) {
            return o.positionToken != 0 && _escrowKey[o.to] == bytes32(o.positionToken);
        }
        if (
            c == VaultOutflowTypes.OutflowClass.ClaimCustody || c == VaultOutflowTypes.OutflowClass.PrincipalToBorrower
                || c == VaultOutflowTypes.OutflowClass.MatchedCounterparty
        ) {
            return _isGenuineVault(o.to);
        }
        // Stage A residuals, checked by the Diamond only until Stage B3
        // (#3379): the incentive and liquidation-buyer actors (bounded by the
        // lien's budgets) and a recorded seller (the signed sale terms). None
        // may name this vault or the Diamond.
        return o.to != address(this) && o.to != diamond;
    }

    /// @dev Whether `to` is the vault of whoever holds `positionToken` now:
    ///      a genuine vault (the same BeaconProxy code as this one, §3.4) whose
    ///      own owner record is that holder, read from the PositionNFT core.
    ///      This vault itself qualifies when its own owner is the holder (two
    ///      positions of one holder).
    function _isHolderVault(address to, uint256 positionToken) private view returns (bool) {
        if (POSITION_NFT == address(0)) return false;
        address holder = IPositionHolderView(POSITION_NFT).holderOf(positionToken);
        if (holder == address(0)) return false;
        // #3379 B2 — a holder's vault is the one created for them: its
        // creation owner is the holder. A verified primary replacement moves
        // the owner record, not the vault, so positions held by the replaced
        // wallet keep paying the vault its new owner now controls.
        if (to == address(this)) return creationOwner == holder;
        if (!_isGenuineVault(to)) return false;
        return IVaultOwnerView(to).vaultCreationOwner() == holder;
    }

    /// @dev Whether `to` runs the same BeaconProxy code as this vault (§3.4):
    ///      every genuine vault has one code hash, set by the immutable beacon.
    function _isGenuineVault(address to) private view returns (bool) {
        if (to == address(this)) return true;
        if (to.code.length == 0 || to.codehash != address(this).codehash) return false;
        // #3393 — and its address is the one its own creation owner derives
        // (CREATE2 by the Diamond, salted by that owner, under this vault's
        // beacon): a BeaconProxy anyone else deployed, whatever owner record
        // it carries, sits at another address.
        try IVaultOwnerView(to).vaultCreationOwner() returns (address creator) {
            return creator != address(0) && to == vaultAddressOf(creator);
        } catch {
            return false;
        }
    }

    // ─── #3379 B2 — protected mode, held by the vault ─────────────────

    /// @dev The protection code is not set in this vault code.
    error ProtectionUnset();
    /// @dev Only the protection code, running in this vault, may write the owner.
    error NotProtection();

    /// @notice The owner record moved to `newOwner` on a verified primary
    ///         replacement.
    event VaultOwnerReplaced(address indexed previousOwner, address indexed newOwner);

    /**
     * @notice Run one protected-mode write: this vault delegatecalls its
     *         fixed `VaultProtection` code with `data`. Open to anyone: the
     *         protection code authorizes every write itself (a direct call
     *         from the key, or the key's signature), and it writes only this
     *         vault's protected record and, on a replacement, its owner.
     */
    function protect(bytes calldata data) external returns (bytes memory result) {
        address code = PROTECTION;
        if (code == address(0)) revert ProtectionUnset();
        bool ok;
        (ok, result) = code.delegatecall(data);
        if (!ok) {
            assembly ("memory-safe") {
                revert(add(result, 0x20), mload(result))
            }
        }
    }

    /// @notice The owner record follows a replacement the protection code
    ///         verified. Callable only by this vault itself (the protection
    ///         code, running here, calls it).
    function setOwnerFromProtection(address newOwner) external {
        if (msg.sender != address(this)) revert NotProtection();
        address previous = ownerWallet;
        ownerWallet = newOwner;
        emit VaultOwnerReplaced(previous, newOwner);
    }

    /// @notice The protected record's state, as the Diamond and the app read it.
    function protectionState()
        external
        view
        returns (
            bool enabled,
            bool locked,
            uint32 delay,
            uint64 cooldownUntil,
            address lockedBy,
            address[] memory signers,
            address[] memory allowlist
        )
    {
        LibVaultProtectionStorage.Layout storage l = LibVaultProtectionStorage.layout();
        return (l.enabled, l.locked, l.delay, l.cooldownUntil, l.lockedBy, l.signers, l.allowlist);
    }

    /// @notice The Diamond this vault serves.
    function vaultDiamond() external view returns (address) {
        return diamond;
    }

    /// @notice The four facts every Diamond read of protected mode needs, in
    ///         one call: on, locked, the delay, and the owner record.
    function protectionCore() external view returns (bool enabled, bool locked, uint32 delay, address owner) {
        LibVaultProtectionStorage.Layout storage l = LibVaultProtectionStorage.layout();
        return (l.enabled, l.locked, l.delay, ownerWallet);
    }

    /// @notice One allowlist entry (#3415 `verified` included).
    function allowEntry(address destination) external view returns (LibVaultProtectionStorage.Entry memory) {
        return LibVaultProtectionStorage.layout().allow[destination];
    }

    /// @notice One signer's record.
    function signerEntry(address who) external view returns (LibVaultProtectionStorage.Signer memory) {
        return LibVaultProtectionStorage.layout().signer[who];
    }

    /// @notice The open replacement proposal.
    function replacementProposal()
        external
        view
        returns (address nominee, address proposedBy, uint64 readyAt, uint32 round)
    {
        LibVaultProtectionStorage.Layout storage l = LibVaultProtectionStorage.layout();
        return (l.nominee, l.proposedBy, l.readyAt, l.round);
    }

    /// @notice The allowlist and signer additions pending now (the current
    ///         epoch; one voided by a lock, a replacement or a switch-off is
    ///         not listed). Each entry's timing is in {allowEntry} /
    ///         {signerEntry}.
    function pendingAdditions() external view returns (address[] memory allowlist, address[] memory signers) {
        LibVaultProtectionStorage.Layout storage l = LibVaultProtectionStorage.layout();
        return (l.pendingAllow[l.epoch], l.pendingSigners[l.epoch]);
    }

    /// @notice The pending setting changes and when the lock began (0 = none).
    function protectionPending()
        external
        view
        returns (uint32 pendingDelay, uint64 pendingDelayAt, uint64 pendingUnlockAt, uint64 pendingDisableAt, uint64 lockedAt)
    {
        LibVaultProtectionStorage.Layout storage l = LibVaultProtectionStorage.layout();
        return (l.pendingDelay, l.pendingDelayAt, l.pendingUnlockAt, l.pendingDisableAt, l.lockedAt);
    }

    /// @notice The open replacement's approvals by active signers now, and
    ///         the majority it needs.
    function replacementTally() external view returns (uint256 approvals, uint256 threshold) {
        LibVaultProtectionStorage.Layout storage l = LibVaultProtectionStorage.layout();
        uint256 n = l.signers.length;
        for (uint256 i; i < n; ++i) {
            if (l.approved[l.round][l.signers[i]]) ++approvals;
        }
        threshold = n / 2 + 1;
    }

    /// @notice `key`'s next signature nonce for `purpose`.
    function protectionNonce(address key, uint8 purpose) external view returns (uint256) {
        return LibVaultProtectionStorage.layout().nonces[key][purpose];
    }

    /// @dev Whether the protected record locks owner-class outflows now.
    function _protectedLocked() private view returns (bool) {
        LibVaultProtectionStorage.Layout storage l = LibVaultProtectionStorage.layout();
        return l.enabled && l.locked;
    }

    /// @notice #3393 — the address of `owner`'s vault: CREATE2 by the
    ///         Diamond, salted by `owner`, of a BeaconProxy for this vault's
    ///         own beacon. Every genuine vault sits at the address its
    ///         creation owner derives.
    function vaultAddressOf(address owner) public view returns (address) {
        address beacon = ERC1967Utils.getBeacon();
        bytes32 initCodeHash = IVaultBeaconInitHash(beacon).PROXY_INIT_CODE_HASH();
        return address(
            uint160(
                uint256(
                    keccak256(abi.encodePacked(bytes1(0xff), diamond, bytes32(uint256(uint160(owner))), initCodeHash))
                )
            )
        );
    }

    /// @notice #3393 — the wallet this vault was created for. Fixed: it is
    ///         what the vault's address is derived from. The owner record
    ///         ({vaultOwner}) follows a verified primary replacement; this
    ///         does not.
    function vaultCreationOwner() external view returns (address) {
        return creationOwner;
    }

    /// @dev THE rule for every spender right this vault grants or causes (a
    ///      just-in-time allowance, a listing escrow's conduit approval): the
    ///      spender must be the constant its class names (#3431): CONDUIT for
    ///      a marketplace conduit, ORDER_PROTOCOL for an order taker. No
    ///      approval path may skip it.
    function _requireSpender(VaultOutflowTypes.GrantClass c, address spender) private view {
        address allowed = c == VaultOutflowTypes.GrantClass.Conduit ? CONDUIT : ORDER_PROTOCOL;
        if (spender == address(0) || spender != allowed) revert GrantRefused(c, spender);
    }

    /**
     * @notice ERC-1271 signature-verification callback for the orders this
     *         vault makes: a Seaport listing whose offerer is this vault or
     *         one of its listing escrows, and (#1566 S3e) the 1inch
     *         swap-to-repay order whose maker is this vault.
     * @dev    #3431 — valid only for a hash this vault computed itself from
     *         the order's terms ({registerSeaportOrder} /
     *         {registerLimitOrder}), and only when the protocol it was hashed
     *         for is the one asking: Seaport directly, or one of this vault's
     *         own listing escrows on Seaport's behalf (the escrow answers
     *         only Seaport), or the 1inch order protocol. Any other caller,
     *         any other hash, and any revoked hash gets the invalid value.
     *         The `signature` argument is ignored: the vault holds no key.
     */
    function isValidSignature(bytes32 hash, bytes calldata /* signature */)
        external
        view
        returns (bytes4)
    {
        address verifier = _orderVerifier[hash];
        if (verifier == address(0)) return 0xffffffff;
        if (msg.sender == verifier || (verifier == SEAPORT && _escrowKey[msg.sender] != bytes32(0))) {
            return 0x1626ba7e;
        }
        return 0xffffffff;
    }

    /// @notice The protocol whose ERC-1271 query this vault answers for
    ///         `orderHash` (Seaport or the 1inch order protocol); 0 if none.
    function orderVerifier(bytes32 orderHash) external view returns (address) {
        return _orderVerifier[orderHash];
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
    // is the Diamond, a self-call, or another Vaipakam vault. A vault moves
    // nothing except at the Diamond's call, so a delivery from another
    // vault is always a protocol move between two users' vaults (a default
    // to the lender, a payment credited to a protected account's vault);
    // the Diamond's vault registry says which addresses are vaults. Any
    // other operator means the NFT was pushed in directly by a user /
    // third-party; we revert so the transfer fails atomically (no orphan
    // asset, no off-ledger balance). ERC-20 cannot be gated this way (no
    // callback) — frontend warning + operational sweep are the controls
    // there.

    /// @dev Whether `operator` may deliver an NFT into this vault.
    function _acceptsNftFrom(address operator) private view returns (bool) {
        if (operator == diamond || operator == address(this)) return true;
        // #3205 part 2 — one of this vault's own listing escrows returning a lot.
        if (_escrowKey[operator] != bytes32(0)) return true;
        // Fail closed: a Diamond that cannot answer (no registry route)
        // accepts nothing beyond its own and the vault's own deliveries.
        try IVaultRegistryView(diamond).getVaultOwner(operator) returns (address user) {
            return user != address(0);
        } catch {
            return false;
        }
    }
    // forge-lint: disable-next-line(mixed-case-function)
    function onERC721Received(
        address operator,
        address,
        uint256,
        bytes calldata
    ) external view returns (bytes4) {
        if (!_acceptsNftFrom(operator)) revert UnauthorizedNFTSender();
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
        if (!_acceptsNftFrom(operator)) revert UnauthorizedNFTSender();
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
        if (!_acceptsNftFrom(operator)) revert UnauthorizedNFTSender();
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
    uint256[41] private __gap;
}
