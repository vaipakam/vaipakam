// src/seaport/CollateralListingExecutor.sol
// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import {OwnableUpgradeable} from "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import {IERC1271} from "@openzeppelin/contracts/interfaces/IERC1271.sol";

import {ISeaportZone, ZoneParameters, ReceivedItem, ItemType} from "./ISeaportZone.sol";
import {IVaipakamPrepayCallbacks} from "./IVaipakamPrepayCallbacks.sol";
import {IVaipakamPrepayContext} from "./IVaipakamPrepayContext.sol";
import {ISeaportOrderHash, ISeaportCancel, OrderComponents} from "./ISeaportOrderHash.sol";
import {
    FeeLeg,
    MAX_FEE_LEGS,
    PREPAY_MODE_FIXED_PRICE,
    PREPAY_MODE_DUTCH,
    PREPAY_MODE_ATOMIC_MATCH
} from "./PrepayTypes.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import {LibVaipakam} from "../libraries/LibVaipakam.sol";
import {LibPrepayOrder} from "../libraries/LibPrepayOrder.sol";

/**
 * @title CollateralListingExecutor
 * @author Vaipakam Developer Team
 * @notice T-086 step 5: singleton that brokers Seaport-mediated prepay
 *         collateral sales. The Vaipakam diamond hosts the borrower-facing
 *         entry points (`postPrepayListing` etc in step 6); this executor
 *         is the trust boundary between Seaport's order-matching engine
 *         and the diamond's loan state. Implements:
 *
 *           1. **ERC-1271 sign-time delegate** — Seaport calls
 *              `isValidSignature(orderHash, signature)` before recording
 *              a fill. The executor re-derives the live floor at the
 *              queried `orderHash`'s associated loan + asserts the
 *              consideration items are ≥ floor and routed to the
 *              current lender / borrower NFT holders.
 *
 *           2. **Seaport zone `validateOrder` callback** — Seaport calls
 *              this at fill time on `FULL_RESTRICTED` orders. Asserts
 *              `msg.sender == seaport` (the canonical-router gate
 *              defending against direct external `validateOrder` calls
 *              that would otherwise force-close a loan). Re-runs every
 *              check the sign-time path did (defense against
 *              `Seaport.validate()` pre-registration per design doc
 *              §5.7), then calls back into the diamond via
 *              {IVaipakamPrepayCallbacks.executorFinalizePrepaySale}
 *              for the load-bearing state mutations (status flip,
 *              `_unlock` of the borrower NFT, LIF settlement).
 *
 *           3. **Governance-managed conduit allow-list** — only orders
 *              whose conduits are in this map can fill. Conduit
 *              membership is mutable post-launch via `addApprovedConduit`
 *              / `removeApprovedConduit` (admin-gated, → timelock +
 *              multisig post-handover); the zone callback re-checks
 *              this at fill time, so a conduit removed AFTER an order
 *              was signed cannot fill the order.
 *
 * @dev   **What this contract DOES NOT do:**
 *          - Build Seaport orders. The step-6 `NFTPrepayListingFacet`
 *            constructs orders from the borrower's listing params + calls
 *            `recordOrder` on this executor to pin the loanId↔orderHash
 *            map before Seaport sees the signature.
 *          - Hold the collateral NFT. The diamond holds the NFT during
 *            the listing window; Seaport pulls it via the conduit at
 *            fill time using the diamond's pre-granted operator approval
 *            (granted in step 6's `postPrepayListing` after the
 *            `_lock(LockReason.PrepayCollateralListing)` flag flip).
 *          - Manage cancel paths. Step 6's `cancelPrepayListing` clears
 *            both the diamond's lock + this executor's `orderContext`
 *            entry; the zone callback rejects unknown orderHashes so
 *            stale signatures can never fill post-cancel.
 *
 *        **UUPS upgradability**: governance can deploy a new
 *        implementation behind the same proxy (e.g. to extend the
 *        check stack for a new Seaport version's interface). The
 *        `OwnableUpgradeable` owner is the admin multisig at deploy,
 *        rotated to the governance timelock post-handover (mirrors
 *        every other upgradeable in the protocol per CLAUDE.md's
 *        Cross-Chain Security Policy).
 *
 *        **What's NOT auditable yet**: this executor doesn't include
 *        the *order construction helpers* (build Seaport order from
 *        loanId + askPrice + deadline). Those land alongside step 6's
 *        `NFTPrepayListingFacet` since the helpers are call-site of
 *        the borrower-facing flow, not core to the executor's
 *        verification contract.
 */
contract CollateralListingExecutor is
    Initializable,
    OwnableUpgradeable,
    UUPSUpgradeable,
    ISeaportZone,
    IERC1271
{
    // ─── Storage (UUPS ERC-7201 namespaced via inherited OZ pattern) ───

    /// @notice Canonical Seaport router this executor binds to. Set in
    ///         {initialize}; upgrades to a future Seaport version go
    ///         through governance + a separate `setSeaport` admin call
    ///         (NOT exposed in this v1; would be added in the next
    ///         major).
    address public seaport;

    /// @notice The Vaipakam diamond proxy. Callbacks at fill time hit
    ///         {IVaipakamPrepayCallbacks.executorFinalizePrepaySale}
    ///         on this address; the diamond's privileged facet method
    ///         asserts `msg.sender == address(this)` before touching
    ///         loan state.
    address public vaipakamDiamond;

    /// @notice Governance-managed conduit allow-list. Conduits are
    ///         Seaport's per-operator approval routers — each is a
    ///         `Conduit.sol` instance authorised to move ERC20/721/1155
    ///         on behalf of `address(this)` via Seaport's protocol-
    ///         level approval chain. Only conduits in this map are
    ///         accepted at order-sign + order-fill time.
    mapping(address conduit => bool approved) public approvedConduits;

    /// @notice Per-order context, stamped by the diamond's step-6
    ///         `postPrepayListing` via {recordOrder} BEFORE the Seaport
    ///         signature lands. The zone callback at fill time looks
    ///         up the loanId + sign-time conduit and re-validates them
    ///         against the order's content; an `orderHash` not present
    ///         in this map is rejected (defends against forged
    ///         off-chain signatures that don't correspond to a
    ///         legitimate Vaipakam listing).
    /// @dev    T-086 #316 extended the recorded shape from
    ///         `(loanId, conduit)` (1 slot) to the full sign-time
    ///         input set (4 slots). The extra three slots let
    ///         {clearOrder} REBUILD the canonical `OrderComponents` at
    ///         cleanup time and forward `Seaport.cancel` for the same
    ///         orderHash — OpenSea's marketplace catalog refreshes
    ///         within ~30s of the on-chain event instead of waiting
    ///         hours for OpenSea's lazy stale-listing detection.
    ///
    ///         Storage packing (5 × 32 bytes = 5 slots):
    ///           slot 0: uint96 loanId | address conduit
    ///           slot 1: bytes32 conduitKey
    ///           slot 2: uint256 salt
    ///           slot 3: uint64 startTime | uint192 askPrice
    ///           slot 4: uint128 endAskPrice | uint64 auctionEndTime |
    ///                   uint8 mode | 56-bit pad
    ///
    ///         Width choices:
    ///           - `loanId` uint96 (2^96 ≈ 7.9 × 10^28, vs ~10^9
    ///             realistic): lossless round-trip from the
    ///             diamond's `uint256` loanId key.
    ///           - `startTime` uint64: block.timestamp pinned at
    ///             post-time. uint32 would overflow in 2106; uint64
    ///             buys ~580 billion years. The explicit bounds
    ///             check in {recordOrder} guards against an oddly-
    ///             large value silently narrowing.
    ///           - `askPrice` uint192 (2^192 ≈ 6.3 × 10^57 wei, vs
    ///             realistic max ~10^28 wei for any conceivable
    ///             NFT-collateral floor): same bounds-checked
    ///             narrowing pattern. For Dutch listings this is the
    ///             `startAskPrice`; for fixed-price it's the
    ///             constant ask.
    ///           - `endAskPrice` uint128 (2^128 ≈ 3.4 × 10^38 wei):
    ///             well above any realistic askPrice. uint128 leaves
    ///             room for the remaining auctionEndTime + mode in
    ///             the same slot. Fixed-price stamps this with the
    ///             same value as `askPrice` so cancel-time
    ///             reconstruction is mode-agnostic on the consideration
    ///             builder side.
    ///           - `auctionEndTime` uint64: matches `startTime`. For
    ///             fixed-price the executor stamps 0 as a sentinel and
    ///             the cancel-time dispatch reads `pctx.graceEnd`
    ///             instead.
    ///           - `mode` uint8: `PREPAY_MODE_FIXED_PRICE (0)` or
    ///             `PREPAY_MODE_DUTCH (1)`. The executor's
    ///             cancel-time dispatch and the canonical-shape
    ///             reconstruction in `LibPrepayOrder` use this to
    ///             pick the right component builder.
    ///
    ///         **What is NOT in `OrderContext` (Round-5 Block B):**
    ///         The projected lender + treasury legs the facet
    ///         signed against at post time are NOT pinned here.
    ///         For Dutch mode, the executor re-derives them at
    ///         cancel time via `getPrepayContext(loanId,
    ///         auctionEndTime)` — same lookup the facet did at
    ///         sign time. Under stable governance config the
    ///         re-read matches; under drift the existing
    ///         `SeaportCancelSkipped` fallback fires. See
    ///         {LibPrepayOrder.componentsForCancelDutch} natspec
    ///         for the per-input-source breakdown and the design
    ///         rationale (§15.2 "Alternative considered + rejected"
    ///         box — pinning the projected legs creates a worse
    ///         problem on fee-curve DECREASES).
    struct OrderContext {
        uint96 loanId;
        address conduit;
        bytes32 conduitKey;
        uint256 salt;
        uint64 startTime;
        uint192 askPrice;
        // Round-5 Block B (#309) — Dutch fields. See per-field
        // commentary above.
        uint128 endAskPrice;
        uint64 auctionEndTime;
        uint8 mode;
    }
    mapping(bytes32 orderHash => OrderContext) public orderContext;

    /// @notice T-086 Round-5 Block A (#313) — full `FeeLeg[]` per
    ///         recorded orderHash. Kept as a separate mapping (rather
    ///         than packed into `OrderContext`) so the fixed-size
    ///         OrderContext slot layout stays clean while the variable-
    ///         length leg array lives where dynamic-array storage is
    ///         natural. Reconstruction at cancel time
    ///         (`_tryCancelOnSeaport`) reads the legs back out into
    ///         memory before invoking `LibPrepayOrder.componentsForCancel`.
    /// @dev    Per §14.5 of the design doc, storage cost = 2 slots per
    ///         leg (`address recipient | uint96 startAmount` packed in
    ///         slot 0; `uint96 endAmount` in slot 1 with 20 B padding).
    ///         With `MAX_FEE_LEGS = 4` the worst-case storage cost is
    ///         +1 length slot + 8 leg slots = +9 slots beyond the
    ///         #316 baseline 4 slots = 13 slots per recorded listing.
    mapping(bytes32 orderHash => FeeLeg[]) internal _orderFeeLegs;

    /// @notice Read accessor for `_orderFeeLegs[orderHash]` — Solidity
    ///         doesn't auto-generate array-returning getters for nested
    ///         dynamic-type mappings, so this is the canonical entry
    ///         point for tests + indexer-side reconstruction. Returns
    ///         the empty array for an unknown or fee-free orderHash.
    function orderFeeLegs(bytes32 orderHash) external view returns (FeeLeg[] memory) {
        return _orderFeeLegs[orderHash];
    }

    /// @notice T-086 Round-5 Block A (#313) — fee-leg overflow guard,
    ///         mirroring the existing `LoanIdOverflow` pattern. Triggers
    ///         on `feeLegs.length > MAX_FEE_LEGS` at record time before
    ///         any storage write.
    error FeeLegsTooMany(uint256 supplied, uint256 max);

    /// @notice T-086 Round-5 Block A (#313) — fee-leg recipient
    ///         validation: the recipient cannot be the zero address
    ///         (would route the leg's tokens into oblivion at fill
    ///         time, contradicting OpenSea's fee-enforcement model
    ///         this surface exists to support).
    error FeeLegZeroRecipient(uint256 idx);

    /// @notice T-086 Round-5 Block A (#313) — both `startAmount` and
    ///         `endAmount` MUST be > 0 per leg. A zero leg is
    ///         indistinguishable from "no leg" + clutters the order
    ///         shape unnecessarily; if the dapp wants to omit a leg
    ///         it should pass a shorter `FeeLeg[]`, not a zero-amount
    ///         entry.
    error FeeLegZeroAmount(uint256 idx);

    // ─── Events ─────────────────────────────────────────────────────────

    event ConduitApproved(address indexed conduit);
    event ConduitRevoked(address indexed conduit);
    event OrderRecorded(bytes32 indexed orderHash, uint256 indexed loanId, address conduit);
    event OrderFilled(bytes32 indexed orderHash, uint256 indexed loanId);
    event OrderCanceled(bytes32 indexed orderHash, uint256 indexed loanId);
    /// @notice T-086 #316: emitted when {clearOrder} successfully
    ///         forwarded `Seaport.cancel` for the matching orderHash.
    ///         OpenSea's marketplace indexer watches Seaport's own
    ///         `OrderCancelled` event — this Vaipakam-side event is
    ///         the operator-side breadcrumb that the fast-cancel
    ///         path actually fired (vs. fell back to the no-op
    ///         drift branch).
    event SeaportCancelEmitted(bytes32 indexed orderHash, uint256 indexed loanId);
    /// @notice T-086 #316: emitted when {clearOrder} skipped the
    ///         `Seaport.cancel` emit because the cancel-time
    ///         reconstructed `OrderComponents` hashed to something
    ///         other than the originally-recorded `orderHash`. Real-
    ///         world causes: position-NFT holder transferred between
    ///         sign and cleanup; Seaport `incrementCounter(vault)`
    ///         was called; treasury address rotated. The cleanup is
    ///         still safe — the executor's binding + vault
    ///         `revokeListingOrderHash` already invalidate fills —
    ///         we just can't accelerate OpenSea's catalog refresh
    ///         in those edge cases.
    event SeaportCancelSkipped(bytes32 indexed orderHash, uint256 indexed loanId);

    // ─── Errors ─────────────────────────────────────────────────────────

    error NotSeaport();
    error NotDiamond();
    error UnknownOrder(bytes32 orderHash);
    error ConduitNotApproved(address conduit);
    error LoanNotActive(uint256 loanId);
    error GraceExpired(uint256 loanId);
    error LenderShortPaid(bytes32 orderHash);
    error TreasuryShortPaid(bytes32 orderHash);
    error WrongConsiderationCount(uint256 expected, uint256 actual);
    error WrongOfferCount(uint256 expected, uint256 actual);
    error WrongLenderRecipient(bytes32 orderHash);
    error WrongBorrowerRecipient(bytes32 orderHash);
    error WrongTreasuryRecipient(bytes32 orderHash);
    error WrongConsiderationItemType(uint256 idx, ItemType expected, ItemType actual);
    error WrongConsiderationToken(uint256 idx, address expected, address actual);
    error WrongConsiderationIdentifier(uint256 idx);
    error WrongOfferItemType(ItemType expected, ItemType actual);
    error WrongOfferToken(address expected, address actual);
    error WrongOfferIdentifier(uint256 expected, uint256 actual);
    error WrongOfferAmount(uint256 expected, uint256 actual);
    error UnsupportedLendingAssetType();
    error UnsupportedCollateralAssetType();
    /// @notice #306 defense-in-depth — `params.offerer` doesn't
    ///         match the borrower's per-user vault address.
    ///         Structurally redundant with the canonical-hash
    ///         construction in `LibPrepayOrder`, but catches a
    ///         future invariant break.
    error WrongOfferer(address expected, address actual);
    error ZeroAddress();
    error AlreadyRecorded(bytes32 orderHash);
    error LoanIdOverflow(uint256 loanId);
    /// @notice T-086 #316 width checks on the extended OrderContext —
    ///         see the `struct OrderContext` natspec for the chosen
    ///         widths and why each overflow is unreachable today.
    ///         Made explicit so a future caller passing a malformed
    ///         value reverts loudly instead of silently corrupting
    ///         the record.
    error StartTimeOverflow(uint256 startTime);
    error AskPriceOverflow(uint256 askPrice);
    /// @notice Round-5 Block B (#309) — width-check parity for the
    ///         Dutch-mode fields. `endAskPrice` uses uint128 (vs
    ///         askPrice's uint192) because the storage layout
    ///         shares a slot with `auctionEndTime` + `mode`; the
    ///         narrower width still covers >10^38 wei.
    error EndAskPriceOverflow(uint256 endAskPrice);
    error AuctionEndTimeOverflow(uint256 auctionEndTime);
    /// @notice Round-5 Block B (#309) — caller passed a `mode`
    ///         outside the `{PREPAY_MODE_FIXED_PRICE,
    ///         PREPAY_MODE_DUTCH}` allow-set. Mode tags are
    ///         enum-like uint8 constants in {PrepayTypes}; a
    ///         future v2 mode (e.g. English-via-zone) would extend
    ///         this set + the dispatch in `_tryCancelOnSeaport`.
    error UnknownPrepayMode(uint8 mode);
    /// @notice Round-5 Block B (#309) — fixed-price mode's invariant
    ///         (`endAskPrice == askPrice` AND `auctionEndTime == 0`)
    ///         was violated. The facet enforces this at the entry
    ///         point; the executor re-asserts so a malformed
    ///         diamond-side caller can't seed a hybrid record.
    error FixedPriceModeShapeViolation();
    /// @notice Round-5 Block B (#309) — Dutch mode's invariants
    ///         (`endAskPrice > 0`, `endAskPrice ≤ askPrice`,
    ///         `auctionEndTime > startTime`, `auctionEndTime` non-
    ///         zero) were violated at the executor boundary.
    error DutchModeShapeViolation();

    // ─── Initializer / UUPS ─────────────────────────────────────────────

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    /// @notice One-time initializer. Wires Seaport + diamond addresses
    ///         and seeds the admin owner.
    /// @dev    The conduit allow-list is intentionally left empty at
    ///         initialize time — governance MUST `addApprovedConduit`
    ///         for at least one Seaport conduit before any borrower can
    ///         post a listing. This is the operational gate that
    ///         prevents accidental open-to-all listings on first
    ///         deploy.
    function initialize(
        address _seaport,
        address _vaipakamDiamond,
        address _owner
    ) external initializer {
        if (_seaport == address(0)) revert ZeroAddress();
        if (_vaipakamDiamond == address(0)) revert ZeroAddress();
        if (_owner == address(0)) revert ZeroAddress();
        __Ownable_init(_owner);
        // OZ v5 UUPSUpgradeable has no `__UUPSUpgradeable_init()` —
        // storage is ERC-7201 namespaced, so no per-instance init slot
        // to write. The mixin still works correctly through the
        // inheritance + `_authorizeUpgrade` override.
        seaport = _seaport;
        vaipakamDiamond = _vaipakamDiamond;
    }

    /// @inheritdoc UUPSUpgradeable
    function _authorizeUpgrade(address) internal override onlyOwner {}

    // ─── Admin: conduit allow-list ──────────────────────────────────────

    /// @notice Add a conduit to the governance allow-list. Listings can
    ///         use any approved conduit; the zone callback re-checks
    ///         this at fill time, so a conduit removed AFTER an order
    ///         was signed cannot fill that order.
    function addApprovedConduit(address conduit) external onlyOwner {
        if (conduit == address(0)) revert ZeroAddress();
        approvedConduits[conduit] = true;
        emit ConduitApproved(conduit);
    }

    /// @notice Remove a conduit from the allow-list. Existing
    ///         orderContext entries pinned to this conduit will FAIL
    ///         the conduit re-check at fill time → orders can't fill.
    function removeApprovedConduit(address conduit) external onlyOwner {
        approvedConduits[conduit] = false;
        emit ConduitRevoked(conduit);
    }

    // ─── Stray-token recovery (T-086 Round-6 / Block D #345) ─────────────

    /// @notice Emitted on every successful stray-token sweep — gives
    ///         operators an on-chain trail of recovery events so a
    ///         post-mortem can correlate the sweep against the
    ///         specific match-tx that produced the leakage.
    event StrayTokensSwept(address indexed token, address indexed to, uint256 amount);

    /// @notice Emitted on every successful stray ERC721 sweep.
    event StrayERC721Swept(address indexed token, uint256 indexed tokenId, address indexed to);

    /**
     * @notice Sweep stray ERC20 tokens accidentally deposited on the
     *         executor. **Recovery surface, not a happy-path tool**:
     *         the §17.9.bis recipient-redirection in
     *         `NFTPrepayListingAtomicFacet.matchOpenSeaOffer` sets
     *         `matchAdvancedOrders(recipient = executor)` so any
     *         unspent ERC20 offer-item amount from a hypothetical
     *         §17.5-bis shape-check bypass lands at the executor
     *         instead of the borrower's EOA. This helper lets
     *         governance recover the stranded tokens after the
     *         operator post-mortem identifies what produced the
     *         leakage.
     *
     * @dev    `onlyOwner` — the deploy multisig at deploy time, rotated
     *         to the governance timelock post-handover. NO public
     *         entry point.
     *
     *         The ERC20 transfer goes through SafeERC20.safeTransfer
     *         (defends against tokens that don't return bool on
     *         transfer, e.g. USDT).
     */
    function sweepStrayTokens(address token, address to, uint256 amount) external onlyOwner {
        if (token == address(0)) revert ZeroAddress();
        if (to == address(0)) revert ZeroAddress();
        SafeERC20.safeTransfer(IERC20(token), to, amount);
        emit StrayTokensSwept(token, to, amount);
    }

    /**
     * @notice Sweep a stray ERC721 NFT accidentally lodged on the
     *         executor. Per Round-6 design doc §17.9.bis, Seaport's
     *         ERC721 execution path uses ordinary `transferFrom` (NOT
     *         `safeTransferFrom`), so `onERC721Received` is NOT
     *         called and an ERC721 can land on the executor even
     *         though it isn't an `ERC721Holder`. Governance
     *         recovery surface for that case.
     *
     * @dev    `onlyOwner` — same trust boundary as `sweepStrayTokens`.
     *         No equivalent ERC1155 sweep exists: Seaport's ERC1155
     *         transfer path uses `safeTransferFrom` which calls
     *         `onERC1155Received`; the executor doesn't implement
     *         that hook so any ERC1155 transfer attempt to the
     *         executor reverts atomically → ERC1155 leakage is
     *         fail-closed by construction (§17.9.bis three-tier
     *         outcome).
     */
    function sweepStrayERC721(address token, uint256 tokenId, address to) external onlyOwner {
        if (token == address(0)) revert ZeroAddress();
        if (to == address(0)) revert ZeroAddress();
        IERC721(token).transferFrom(address(this), to, tokenId);
        emit StrayERC721Swept(token, tokenId, to);
    }

    // ─── Order context recording (diamond-only entry) ───────────────────

    /// @notice Stamp the `orderHash → (loanId, conduit, conduitKey,
    ///         salt, startTime, askPrice)` binding before Seaport
    ///         processes the signed order. Called exclusively by the
    ///         diamond's step-6 `NFTPrepayListingFacet.postPrepayListing`
    ///         / `updatePrepayListing`.
    /// @dev    Access-gated to the diamond — an arbitrary EOA can't
    ///         seed phantom orderContext entries to forge a future
    ///         sign. Also asserts the conduit is currently approved;
    ///         a conduit removed between record + sign would still
    ///         have a valid context but the zone callback's conduit
    ///         re-check catches it.
    ///
    ///         T-086 #316 — the four extra args (`conduitKey`, `salt`,
    ///         `startTime`, `askPrice`) capture the borrower-controlled
    ///         + sign-time inputs that are NOT recoverable from the
    ///         loan record alone. The executor uses them in
    ///         {clearOrder} to rebuild the canonical `OrderComponents`
    ///         and forward `Seaport.cancel` for fast OpenSea catalog
    ///         refresh. All four bound-check before the narrowing
    ///         casts to fail-loud on a malformed input rather than
    ///         silently truncate.
    function recordOrder(
        bytes32 orderHash,
        uint256 loanId,
        address conduit,
        bytes32 conduitKey,
        uint256 salt,
        uint256 startTime,
        uint256 askPrice,
        uint256 endAskPrice,
        uint256 auctionEndTime,
        uint8 mode,
        FeeLeg[] calldata feeLegs
    ) external {
        if (msg.sender != vaipakamDiamond) revert NotDiamond();
        if (!approvedConduits[conduit]) revert ConduitNotApproved(conduit);
        if (orderContext[orderHash].loanId != 0) revert AlreadyRecorded(orderHash);
        // Explicit bounds checks before the narrowing casts. Silent
        // narrowing would let a value exceeding the recorded width
        // wrap into a different valid context entry at fill / cleanup
        // time, causing mis-settlement (loanId), mis-pctx
        // reconstruction (startTime), or mis-floor reconstruction
        // (askPrice). With 2^96 / 2^64 / 2^192 / 2^128 all vastly
        // exceeding any realistic value, these reverts are unreachable
        // today — but explicit > silent.
        if (loanId > type(uint96).max) revert LoanIdOverflow(loanId);
        if (startTime > type(uint64).max) revert StartTimeOverflow(startTime);
        if (askPrice > type(uint192).max) revert AskPriceOverflow(askPrice);
        if (endAskPrice > type(uint128).max) revert EndAskPriceOverflow(endAskPrice);
        if (auctionEndTime > type(uint64).max) revert AuctionEndTimeOverflow(auctionEndTime);

        // Round-5 Block B (#309) — mode-tag dispatch + per-mode shape
        // assertion. The diamond facet has already enforced the
        // borrower-leg monotonicity + `MIN_AUCTION_WINDOW` + grace-
        // window checks against the live pctx (which the executor
        // doesn't see directly); here we re-assert the storage-shape
        // invariants the executor depends on for cancel-time
        // reconstruction.
        if (mode == PREPAY_MODE_FIXED_PRICE || mode == PREPAY_MODE_ATOMIC_MATCH) {
            // Fixed-price + atomic-match share the SAME storage-shape
            // invariants: `endAskPrice` MUST equal `askPrice` (no
            // decay); `auctionEndTime` MUST be 0 (cancel-time
            // dispatch reads `pctx.graceEnd` instead). For atomic-
            // match the recorded `askPrice` is the EFFECTIVE ask
            // (= bidder.offer[0].startAmount - bidderFeeTotal) per
            // Round-6 design doc §17.11 step 4 — the Vaipakam
            // counter-order's three consideration legs sum to this
            // value; recording the gross bidder offer would make the
            // cancel-reconstruction branch build a 3-leg order
            // mismatched against the actual orderHash.
            if (endAskPrice != askPrice || auctionEndTime != 0) {
                revert FixedPriceModeShapeViolation();
            }
        } else if (mode == PREPAY_MODE_DUTCH) {
            // Dutch: `endAskPrice` MUST be non-zero AND ≤ `askPrice`
            // (where `askPrice` is the start ask). `auctionEndTime`
            // MUST be > `startTime` (a Dutch window of zero duration
            // would have no valid fill price band).
            if (
                endAskPrice == 0 ||
                endAskPrice > askPrice ||
                auctionEndTime <= startTime
            ) {
                revert DutchModeShapeViolation();
            }
        } else {
            revert UnknownPrepayMode(mode);
        }

        // T-086 Round-5 Block A (#313) — fee-leg validation. The
        // facet's `_assertOrderContent` re-checks shape at fill time;
        // here we only enforce sign-time invariants that protect the
        // storage layout (`MAX_FEE_LEGS` cap) + canonical-shape
        // construction in `LibPrepayOrder` (non-zero recipient + non-
        // zero start / end amounts). The borrower-supplied `bps` and
        // OpenSea's submission-time enforcement of the right schedule
        // are the dapp's concern, not the executor's.
        if (feeLegs.length > MAX_FEE_LEGS) {
            revert FeeLegsTooMany(feeLegs.length, MAX_FEE_LEGS);
        }
        for (uint256 i = 0; i < feeLegs.length; ) {
            if (feeLegs[i].recipient == address(0)) {
                revert FeeLegZeroRecipient(i);
            }
            if (feeLegs[i].startAmount == 0 || feeLegs[i].endAmount == 0) {
                revert FeeLegZeroAmount(i);
            }
            // Persist the leg into the per-orderHash dynamic array.
            _orderFeeLegs[orderHash].push(feeLegs[i]);
            unchecked { ++i; }
        }
        orderContext[orderHash] = OrderContext({
            loanId: uint96(loanId),
            conduit: conduit,
            conduitKey: conduitKey,
            salt: salt,
            startTime: uint64(startTime),
            askPrice: uint192(askPrice),
            endAskPrice: uint128(endAskPrice),
            auctionEndTime: uint64(auctionEndTime),
            mode: mode
        });
        emit OrderRecorded(orderHash, loanId, conduit);
    }

    /// @notice Clear an orderHash binding. Called by the diamond's
    ///         `cancelPrepayListing` (step 6), the update flow's
    ///         old-hash retire, and `LibPrepayCleanup.clearActiveListing`
    ///         (step 10 terminal sweep) so a previously-signed order
    ///         can no longer fill. Idempotent: clearing an already-
    ///         cleared orderHash is a no-op.
    /// @dev    T-086 #316 — while the binding is still live, the
    ///         executor REBUILDS the canonical `OrderComponents` from
    ///         the recorded sign-time inputs + the current vault
    ///         counter, hashes them through Seaport, and forwards
    ///         `Seaport.cancel` for the matching orderHash. Seaport's
    ///         own `OrderCancelled(orderHash, offerer, zone)` event
    ///         is what OpenSea's marketplace indexer watches; the
    ///         cancel-on-Seaport accelerates OpenSea's catalog
    ///         refresh from ~hours (lazy stale-listing detection) to
    ///         ~30s (event-driven).
    ///
    ///         The cancel emit is **best-effort**, NEVER load-bearing
    ///         for safety. The cleanup proper (binding delete +
    ///         vault-side `revokeListingOrderHash` in the diamond)
    ///         is what actually prevents fills. The cancel emit
    ///         gracefully falls back to no-op in three cases:
    ///           (a) the recorded loanId is zero (binding never
    ///               existed; this branch isn't taken),
    ///           (b) the cancel-time reconstructed hash mismatches
    ///               the recorded hash (sign-time data drift —
    ///               position-NFT holder transferred, treasury
    ///               rotated, Seaport `incrementCounter` was called),
    ///               or
    ///           (c) the `ISeaportCancel.cancel` call itself reverts
    ///               (defensive — Seaport's `cancel` should not
    ///               revert in any reachable path today, but a
    ///               future Seaport upgrade is wrapped in try/catch
    ///               so cleanup isn't blocked).
    ///         Cases (b) and (c) emit `SeaportCancelSkipped` so
    ///         operators have a per-cleanup breadcrumb.
    function clearOrder(bytes32 orderHash) external {
        if (msg.sender != vaipakamDiamond) revert NotDiamond();
        OrderContext memory ctx = orderContext[orderHash];

        // T-086 #316: try to emit Seaport.cancel while ctx still has
        // the data needed to rebuild the canonical OrderComponents.
        // No-op (silent) if the binding never existed; the existing
        // idempotent contract of {clearOrder} is preserved.
        if (ctx.loanId != 0) {
            _tryCancelOnSeaport(orderHash, ctx);
        }

        uint256 loanId = uint256(ctx.loanId);
        delete orderContext[orderHash];
        // T-086 Round-5 Block A (#313) — also clear the fee-legs
        // entry. `delete` on a dynamic array clears length and ALL
        // elements (Solidity's standard semantics); the cost scales
        // with `feeLegs.length` (≤ MAX_FEE_LEGS = 4) so it stays
        // bounded.
        delete _orderFeeLegs[orderHash];
        emit OrderCanceled(orderHash, loanId);
    }

    /// @dev T-086 #316 — best-effort Seaport.cancel emit. Reconstructs
    ///      the canonical `OrderComponents` from the recorded
    ///      sign-time inputs + a fresh vault-counter read, verifies
    ///      Seaport hashes them to the same `orderHash` we have on
    ///      file, and only then forwards `Seaport.cancel`. The hash
    ///      re-check is the safety lever: a mismatch means the
    ///      cancel-time view of the loan / NFT-holder / vault state
    ///      has drifted from sign-time. We can't re-derive what
    ///      Seaport would consider the original orderHash without
    ///      that match, so we no-op instead of canceling a different
    ///      orderHash (which would be wrong — would leave the real
    ///      orderHash live on Seaport AND register a phantom cancel
    ///      for an unrelated hash).
    function _tryCancelOnSeaport(bytes32 orderHash, OrderContext memory ctx) private {
        // T-086 Round-5 Block A (#313) — read fee legs back from
        // storage for the canonical-shape reconstruction.
        FeeLeg[] memory feeLegs = _orderFeeLegs[orderHash];

        // Round-5 Block B (#309) — mode-aware dispatch. The
        // fixed-price path keeps the existing sign-time-pctx
        // reconstruction. The Dutch path reads pctx at
        // `auctionEndTime` (so `pctx.lenderLeg` / `pctx.treasuryLeg`
        // resolve to the projected-max values that were signed at
        // post time, under sign-time governance config — assuming
        // governance hasn't drifted; if it has, the hash recompute
        // mismatches and we emit `SeaportCancelSkipped`).
        OrderComponents memory components;
        if (
            ctx.mode == PREPAY_MODE_FIXED_PRICE ||
            ctx.mode == PREPAY_MODE_ATOMIC_MATCH
        ) {
            // T-086 Round-6 / Block D (#345) — atomic-match orders
            // share the fixed-price cancel-reconstruction path. The
            // Vaipakam counter-order's storage shape is identical to
            // fixed-price (endAskPrice == askPrice, auctionEndTime ==
            // 0, empty feeLegs); the recorded `askPrice` is the
            // EFFECTIVE ask = offer_value - bidderFeeTotal (§17.11
            // step 4 + §17.7 of the Round-6 design doc) so the
            // reconstruction summing to that ask is the correct
            // 3-leg consideration that was signed at match-time.
            components = _buildFixedPriceCancelComponents(orderHash, ctx, feeLegs);
            if (components.offerer == address(0)) {
                // Skip-fallback sentinel: helper returned an empty
                // shell because the cancel-time solvency check
                // tripped (governance drift). Breadcrumb already
                // emitted inside the helper.
                return;
            }
        } else if (ctx.mode == PREPAY_MODE_DUTCH) {
            components = _buildDutchCancelComponents(orderHash, ctx, feeLegs);
            if (components.offerer == address(0)) {
                return;
            }
        } else {
            // Unknown mode — should be unreachable (recordOrder
            // rejects this), but defense-in-depth: skip + breadcrumb.
            emit SeaportCancelSkipped(orderHash, uint256(ctx.loanId));
            return;
        }

        bytes32 reconstructed = ISeaportOrderHash(seaport).getOrderHash(components);
        if (reconstructed != orderHash) {
            // Drift — emit skip breadcrumb and let the proper cleanup
            // (binding delete + vault revoke) carry the safety
            // invariant alone.
            emit SeaportCancelSkipped(orderHash, uint256(ctx.loanId));
            return;
        }

        OrderComponents[] memory orders = new OrderComponents[](1);
        orders[0] = components;
        // Defensive try/catch around Seaport. The canonical Seaport 1.6
        // {cancel} path doesn't revert when (caller == zone) AND the
        // order is already filled / cancelled (it's effectively a
        // boolean-returning no-op there), so this is purely a
        // future-proof guard against a Seaport version change.
        try ISeaportCancel(seaport).cancel(orders) returns (bool /* cancelled */) {
            emit SeaportCancelEmitted(orderHash, uint256(ctx.loanId));
        } catch {
            emit SeaportCancelSkipped(orderHash, uint256(ctx.loanId));
        }
    }

    /// @dev Round-5 Block B (#309) — fixed-price cancel-time
    ///      reconstruction. Returns `(components, offerer != 0)`;
    ///      the caller treats `offerer == address(0)` as the
    ///      "skip + breadcrumb already emitted" signal so the
    ///      reconstruction helpers don't need a separate boolean
    ///      return shape.
    function _buildFixedPriceCancelComponents(
        bytes32 orderHash,
        OrderContext memory ctx,
        FeeLeg[] memory feeLegs
    ) private returns (OrderComponents memory components) {
        // Sign-time pctx — getPrepayContext(loanId, ctx.startTime)
        // re-derives the floor legs evaluated at the ORIGINAL post
        // timestamp.
        IVaipakamPrepayContext.PrepayContext memory pctx =
            IVaipakamPrepayContext(vaipakamDiamond).getPrepayContext(
                uint256(ctx.loanId),
                uint256(ctx.startTime)
            );

        // Defensive floor-coverage check. `LibPrepayOrder._componentsAtMemory`
        // computes `borrowerLeg = askPrice - lenderLeg - treasuryLeg`;
        // if the cancel-time floor reads HIGHER than the recorded
        // sign-time `askPrice`, the unchecked subtraction would panic
        // with arithmetic underflow and revert the entire cleanup
        // path. Realistic causes:
        //   (a) Governance bumped `treasuryFeeBps` between sign and
        //       cancel → `pctx.treasuryLeg` is now higher than the
        //       value the facet validated against at post time.
        //   (b) Governance flipped a related fee curve.
        // In any such case the original order is functionally already
        // "stale" — it could never have been filled at the new floor —
        // so the right behaviour is to fall back to the no-op skip
        // branch (the proper cleanup still completes; we just don't
        // get the OpenSea catalog refresh acceleration).
        uint256 feeSumStart = 0;
        for (uint256 i = 0; i < feeLegs.length; ) {
            feeSumStart += uint256(feeLegs[i].startAmount);
            unchecked { ++i; }
        }
        if (uint256(ctx.askPrice) < pctx.lenderLeg + pctx.treasuryLeg + feeSumStart) {
            emit SeaportCancelSkipped(orderHash, uint256(ctx.loanId));
            // Sentinel: `offerer == address(0)` indicates caller-side
            // skip — the empty OrderComponents struct is returned
            // unmodified from its zero-value default.
            return components;
        }

        components = LibPrepayOrder.componentsForCancel(
            pctx,
            address(this),
            uint256(ctx.askPrice),
            ctx.conduitKey,
            uint256(ctx.salt),
            uint256(ctx.startTime),
            ISeaportOrderHash(seaport).getCounter(pctx.borrowerVault),
            feeLegs
        );
    }

    /// @dev Round-5 Block B (#309) — Dutch cancel-time
    ///      reconstruction. Reads pctx at `auctionEndTime` so the
    ///      lender + treasury legs resolve to the projected-max
    ///      values that were signed at post-time (under sign-time
    ///      governance config). If governance has bumped between
    ///      sign + cancel, the projected values shift and the hash
    ///      recompute mismatches → `_tryCancelOnSeaport` emits
    ///      `SeaportCancelSkipped` and the cleanup proper (binding
    ///      delete + vault revoke) carries the safety invariant.
    function _buildDutchCancelComponents(
        bytes32 orderHash,
        OrderContext memory ctx,
        FeeLeg[] memory feeLegs
    ) private returns (OrderComponents memory components) {
        IVaipakamPrepayContext.PrepayContext memory pctx =
            IVaipakamPrepayContext(vaipakamDiamond).getPrepayContext(
                uint256(ctx.loanId),
                uint256(ctx.auctionEndTime)
            );

        // Same defensive coverage check as the fixed-price path,
        // but using `endAskPrice` (the floor must be coverable at
        // the END of the auction window for the order to have been
        // signable; if cancel-time projected legs + fee endAmounts
        // exceed `endAskPrice`, the canonical-shape rebuild would
        // underflow on the borrower-end leg).
        uint256 feeSumEnd = 0;
        for (uint256 i = 0; i < feeLegs.length; ) {
            feeSumEnd += uint256(feeLegs[i].endAmount);
            unchecked { ++i; }
        }
        if (uint256(ctx.endAskPrice) < pctx.lenderLeg + pctx.treasuryLeg + feeSumEnd) {
            emit SeaportCancelSkipped(orderHash, uint256(ctx.loanId));
            return components;
        }

        components = LibPrepayOrder.componentsForCancelDutch(
            pctx,
            address(this),
            uint256(ctx.askPrice),         // startAskPrice
            uint256(ctx.endAskPrice),
            pctx.lenderLeg,                // projectedLenderLeg
            pctx.treasuryLeg,              // projectedTreasuryLeg
            ctx.conduitKey,
            uint256(ctx.salt),
            uint256(ctx.startTime),
            uint256(ctx.auctionEndTime),
            ISeaportOrderHash(seaport).getCounter(pctx.borrowerVault),
            feeLegs
        );
    }

    // ─── ERC-1271 sign-time signature delegate ──────────────────────────

    /// @notice Seaport calls this on a signed order before recording a
    ///         fill — `address(this)` is the order's `offerer`, and
    ///         this contract returns the ERC-1271 magic value when the
    ///         order's content (consideration, recipients, expiry)
    ///         still satisfies Vaipakam's invariants at the queried
    ///         block.
    /// @dev    The `signature` argument is IGNORED here because the
    ///         executor doesn't sign with a private key — it relies on
    ///         the orderContext map (populated by the diamond at
    ///         postPrepayListing time) as the source of truth for
    ///         "we authorised an order with this hash". Anything not
    ///         in orderContext is rejected.
    ///
    ///         The richer recipient / floor / grace re-checks live in
    ///         {validateOrder} (the zone callback) which Seaport fires
    ///         AT FILL TIME. The 1271 callback runs at SIGNATURE
    ///         VERIFICATION TIME and only knows the orderHash + an
    ///         opaque signature blob — Seaport doesn't pass the order
    ///         content here. So the rigorous content checks (which
    ///         need to see consideration items + recipients) MUST live
    ///         in the zone callback regardless. This 1271 path is the
    ///         coarser membership gate; the zone callback is the
    ///         fine-grained content gate.
    ///
    ///         Per design doc §5.7: the zone callback duplicates every
    ///         check so the Seaport.validate() pre-registration path
    ///         (which SKIPS this 1271 callback) is still safe.
    function isValidSignature(bytes32 hash, bytes calldata /* signature */)
        external
        view
        override
        returns (bytes4)
    {
        return isOrderValid(hash)
            ? IERC1271.isValidSignature.selector
            : bytes4(0xffffffff);
    }

    /// @notice ERC-1271 logic factored into a boolean view so the
    ///         vault's `isValidSignature` (step 7 vault delegate)
    ///         can consult the executor without re-deriving the
    ///         magic-value-encoded `bytes4` return shape.
    /// @dev    Same checks as the local {isValidSignature}: order
    ///         context populated, conduit still approved, loan
    ///         still Active. The richer recipient / floor / grace
    ///         re-checks happen at fill time in the zone callbacks
    ///         (`authorizeOrder` + `validateOrder`); this 1271-side
    ///         view is the coarser membership gate.
    function isOrderValid(bytes32 hash) public view returns (bool) {
        OrderContext memory ctx = orderContext[hash];
        if (ctx.loanId == 0) return false;
        if (!approvedConduits[ctx.conduit]) return false;
        // Conservative liveness gate at 1271 time: refuse to sign
        // if the loan isn't Active. Fill-time re-checks in
        // `authorizeOrder` + `validateOrder` will catch the race
        // window between this view and the actual fill. The 1271
        // path can't do the rigorous content checks (Seaport
        // doesn't pass order content here), so the heavy lifting
        // lives in the zone hooks.
        IVaipakamPrepayContext.PrepayContext memory pctx =
            IVaipakamPrepayContext(vaipakamDiamond).getPrepayContext(
                uint256(ctx.loanId), block.timestamp
            );
        if (pctx.status != LibVaipakam.LoanStatus.Active) return false;
        return true;
    }

    // ─── Seaport zone callback (fill-time content gate) ─────────────────

    /// @notice Seaport calls this on every fill of a restricted order
    ///         whose zone is `address(this)`. This is the LOAD-BEARING
    ///         check stack — Seaport's `validate()` pre-registration
    ///         path SKIPS the {isValidSignature} delegate but ALWAYS
    ///         routes restricted-order fills through here (per design
    ///         doc §5.7). Every invariant the order must satisfy is
    ///         re-checked at fill time, defending against:
    ///
    ///           - Sign-time → fill-time drift (interest accrued
    ///             pushed the floor up; consideration is now short).
    ///           - Lender / borrower position-NFT transfers between
    ///             sign + fill (recipients must match THE CURRENT
    ///             holder, not the sign-time holder).
    ///           - Grace expiry between sign + fill (the loan
    ///             defaulted; the prepay-sale path is no longer valid).
    ///           - Conduit removal between record + fill (the conduit
    ///             was governance-revoked after the order was signed).
    ///           - Direct external calls to `validateOrder` from a
    ///             non-Seaport caller (force-close attack — caught by
    ///             the canonical-router gate).
    ///
    /// @dev    Returns `ISeaportZone.validateOrder.selector` on
    ///         acceptance; reverts (via specific errors) on every
    ///         failure mode. Seaport aborts the fill on revert or
    ///         wrong selector.
    /// @notice Pre-transfer Seaport hook (Seaport 1.6). Runs the FULL
    ///         precondition stack before any transfers occur, so a
    ///         rejection here aborts the fill at the cheapest point.
    /// @dev    Reverts on every failure mode; returns the
    ///         `authorizeOrder` magic selector on acceptance. The check
    ///         stack is implemented in {_checkOrderPreconditions} and
    ///         re-run from {validateOrder} verbatim per design doc §5.7
    ///         (defends against `Seaport.validate()` pre-registration
    ///         path which SKIPS this hook).
    function authorizeOrder(ZoneParameters calldata params)
        external
        override
        returns (bytes4)
    {
        if (msg.sender != seaport) revert NotSeaport();
        _checkOrderPreconditions(params);
        return ISeaportZone.authorizeOrder.selector;
    }

    function validateOrder(ZoneParameters calldata params)
        external
        override
        returns (bytes4)
    {
        if (msg.sender != seaport) revert NotSeaport();

        // Re-run the full precondition stack — `Seaport.validate()`
        // pre-registration path SKIPS {authorizeOrder}, so the same
        // checks MUST run here too (design doc §5.7).
        uint256 loanId = _checkOrderPreconditions(params);

        // ── Atomic settlement: callback to the diamond ──────────────────
        // The diamond's privileged facet method asserts
        // `msg.sender == address(this)` + Active status, then atomically:
        //   - loan.status = Settled (via LibLifecycle).
        //   - LibERC721._unlock(loan.borrowerTokenId).
        //   - LibVPFIDiscount.settleBorrowerLifProper(loan).
        // After this returns we clear the orderContext so an already-
        // filled hash can't double-fill (Seaport itself blocks re-fills
        // on the same order, but defense-in-depth).
        IVaipakamPrepayCallbacks(vaipakamDiamond).executorFinalizePrepaySale(loanId);
        delete orderContext[params.orderHash];
        // T-086 Round-5 Block A (#313) — Codex P2 round-1 cleanup
        // (PR #324 Raja review): also clear the per-order fee-leg
        // storage. The successful-fill path was leaking
        // _orderFeeLegs entries while clearOrder + the explicit
        // cancel paths cleared them; this brings validateOrder in
        // line. `delete` on a dynamic-array mapping value clears
        // length + every element (Solidity standard semantics).
        delete _orderFeeLegs[params.orderHash];

        emit OrderFilled(params.orderHash, loanId);
        return ISeaportZone.validateOrder.selector;
    }

    /// @notice The full precondition check stack shared by both
    ///         {authorizeOrder} and {validateOrder}. Reverts on every
    ///         failure mode; returns the resolved loanId on success.
    /// @dev    Reads loan state, live floor, grace expiry, NFT
    ///         holders, and treasury via ONE call to the diamond's
    ///         {IVaipakamPrepayContext.getPrepayContext} — running
    ///         in the DIAMOND'S storage context, not the executor's.
    ///         Round 1 incorrectly called `LibCollateralSettlement`
    ///         and `LibVaipakam.gracePeriod` directly from the executor;
    ///         those libraries read `LibVaipakam.storageSlot()` against
    ///         the caller's storage, which on the executor singleton
    ///         is empty → all values evaluated to 0 → unsafe. Codex
    ///         L450 P0 on Round 1 caught this.
    function _checkOrderPreconditions(ZoneParameters calldata params)
        internal
        view
        returns (uint256 loanId)
    {
        OrderContext memory ctx = orderContext[params.orderHash];
        if (ctx.loanId == 0) revert UnknownOrder(params.orderHash);
        if (!approvedConduits[ctx.conduit]) revert ConduitNotApproved(ctx.conduit);

        loanId = uint256(ctx.loanId);
        IVaipakamPrepayContext.PrepayContext memory pctx =
            IVaipakamPrepayContext(vaipakamDiamond).getPrepayContext(loanId, block.timestamp);

        if (pctx.status != LibVaipakam.LoanStatus.Active) revert LoanNotActive(loanId);

        // #306 architectural-fix defense-in-depth: the order's
        // `offerer` MUST be the borrower's per-user vault. The
        // diamond's `postPrepayListing` already binds the
        // orderHash to a vault-offerer order shape (the
        // canonical-hash construction in `LibPrepayOrder`), so
        // a hash registered for a different-offerer order
        // structurally can't exist in `orderContext`. This
        // explicit check is redundant in the happy path but
        // catches any future migration or upgrade that loosens
        // the canonical-hash invariant.
        if (params.offerer != pctx.borrowerVault) {
            revert WrongOfferer(pctx.borrowerVault, params.offerer);
        }
        // Grace boundary uses strict `>` to mirror the rest of the
        // loan lifecycle. The grace window CLOSES the instant after
        // `graceEnd`, not at the tick itself:
        //   - `DefaultedFacet:217` reverts `NotDefaultedYet` when
        //     `block.timestamp <= graceEnd`, so `markDefaulted` is
        //     NOT callable AT the boundary tick — only after it.
        //   - `RepayFacet:283` / `RepayFacet:616` revert
        //     `RepaymentPastGracePeriod` only when
        //     `block.timestamp > graceEnd`, so a regular repay is
        //     allowed AT the boundary tick.
        // Rejecting a prepay sale at the same tick a repay is still
        // allowed (and a default is still NOT) would be an arbitrary
        // last-second mismatch. Codex P2 on Round 2 (PR #288 thread
        // PRRT_kwDOSP_93M6ExkLz) called this out; an earlier in-code
        // comment defended `>=` on the assumption that `markDefaulted`
        // was already callable at the tick, which the
        // `DefaultedFacet:217` check above shows is wrong.
        if (block.timestamp > pctx.graceEnd) revert GraceExpired(loanId);

        // ── Offer-side schema check ─────────────────────────────────────
        // The order MUST be selling EXACTLY the loan's collateral NFT.
        // Without this binding, a malicious caller could submit an order
        // that satisfies all the consideration amounts but offers some
        // OTHER NFT — the diamond would settle the loan + unlock the
        // borrower NFT without the collateral being delivered (Codex /
        // Grok blocker on Round 1).
        if (params.offer.length != 1) {
            revert WrongOfferCount(1, params.offer.length);
        }
        ItemType expectedOfferType;
        if (pctx.collateralAssetType == LibVaipakam.AssetType.ERC721) {
            expectedOfferType = ItemType.ERC721;
        } else if (pctx.collateralAssetType == LibVaipakam.AssetType.ERC1155) {
            expectedOfferType = ItemType.ERC1155;
        } else {
            // ERC20 collateral is not eligible for T-086 prepay listings
            // (no NFT to sell). The borrower-facing
            // `NFTPrepayListingFacet.postPrepayListing` (step 6)
            // rejects upstream too; this revert is defense-in-depth at
            // the fill boundary.
            revert UnsupportedCollateralAssetType();
        }
        if (params.offer[0].itemType != expectedOfferType) {
            revert WrongOfferItemType(expectedOfferType, params.offer[0].itemType);
        }
        if (params.offer[0].token != pctx.collateralAsset) {
            revert WrongOfferToken(pctx.collateralAsset, params.offer[0].token);
        }
        if (params.offer[0].identifier != pctx.collateralTokenId) {
            revert WrongOfferIdentifier(pctx.collateralTokenId, params.offer[0].identifier);
        }
        // ERC721 sells a quantity of 1; ERC1155 sells the loan's full
        // collateralQuantity. Per design doc §5.6 + §7, T-086 v1 sells
        // the FULL ERC1155 balance (no partial fills); FULL_RESTRICTED
        // order type enforces single-fill but the explicit amount check
        // here also pins the right magnitude.
        uint256 expectedOfferAmount =
            pctx.collateralAssetType == LibVaipakam.AssetType.ERC721
                ? 1
                : pctx.collateralQuantity;
        if (params.offer[0].amount != expectedOfferAmount) {
            revert WrongOfferAmount(expectedOfferAmount, params.offer[0].amount);
        }

        // ── Consideration shape check ───────────────────────────────────
        // Three protocol legs in fixed order: [lender, treasury, borrower]
        // per design doc §5.5. T-086 Round-5 Block A (#313) allows
        // additional fee legs at indices 3 … (3 + feeLegsCount - 1) up
        // to `MAX_FEE_LEGS = 4` total. Each leg (protocol or fee) must
        // be in the loan's lending asset (ERC20 only for v1 — NFT-rental
        // loans don't fit the prepay sale flow). Without these checks,
        // a fill could route the right amounts in the WRONG token
        // (Codex / Grok blocker on Round 1).
        if (
            params.consideration.length < 3 ||
            params.consideration.length > 3 + MAX_FEE_LEGS
        ) {
            revert WrongConsiderationCount(3 + MAX_FEE_LEGS, params.consideration.length);
        }
        if (pctx.assetType != LibVaipakam.AssetType.ERC20) {
            revert UnsupportedLendingAssetType();
        }
        // Protocol legs — itemType + token + identifier shape, plus
        // amount + recipient checks below.
        _assertConsiderationItem(params.consideration[0], 0, pctx.principalAsset, params.orderHash);
        _assertConsiderationItem(params.consideration[1], 1, pctx.principalAsset, params.orderHash);
        _assertConsiderationItem(params.consideration[2], 2, pctx.principalAsset, params.orderHash);
        // T-086 Round-5 Block A (#313) — per-fee-leg shape loop. Same
        // ERC20 + principalAsset + zero-identifier checks the protocol
        // legs get. Recipient is NOT validated against an on-chain
        // allowlist (per §14.4: economically neutral for the borrower
        // to lie since the fees come out of their own remainder; OpenSea
        // submission-time enforcement is the forcing function for
        // correctness). Amount > 0 IS validated here so a fill can't
        // record a zero-amount fee leg that clutters the indexer's
        // record without economic effect.
        for (uint256 i = 3; i < params.consideration.length; ) {
            _assertConsiderationItem(params.consideration[i], i, pctx.principalAsset, params.orderHash);
            if (params.consideration[i].amount == 0) {
                revert FeeLegZeroAmount(i);
            }
            unchecked { ++i; }
        }

        // ── Live-floor leg checks (read from the diamond view) ─────────
        // Lender + treasury legs compared against the live floor as
        // resolved by the diamond at THIS block. The diamond invokes
        // `LibCollateralSettlement` in its own storage context, so the
        // floor is correctly derived from loan state (Round 1 was
        // calling the library from the executor, which read empty
        // storage — Codex L450 P0).
        if (params.consideration[0].amount < pctx.lenderLeg) {
            revert LenderShortPaid(params.orderHash);
        }
        if (params.consideration[1].amount < pctx.treasuryLeg) {
            revert TreasuryShortPaid(params.orderHash);
        }

        // ── Recipient checks (bind to CURRENT NFT holders + treasury) ──
        // The diamond resolved the lender + borrower position-NFT
        // current holders + the configured treasury address. Recipient
        // mismatches reject the fill atomically.
        if (params.consideration[0].recipient != pctx.lenderNftOwner) {
            revert WrongLenderRecipient(params.orderHash);
        }
        if (params.consideration[1].recipient != pctx.treasury) {
            revert WrongTreasuryRecipient(params.orderHash);
        }
        if (params.consideration[2].recipient != pctx.borrowerNftOwner) {
            revert WrongBorrowerRecipient(params.orderHash);
        }
    }

    // ─── Internal helpers ──────────────────────────────────────────────

    /// @notice Verify a consideration leg matches the loan's lending-asset
    ///         schema: ERC20 itemType, token == `loan.principalAsset`,
    ///         identifier == 0. Amount + recipient are checked separately
    ///         per-leg in the main validateOrder body (since they differ
    ///         by leg).
    function _assertConsiderationItem(
        ReceivedItem calldata item,
        uint256 idx,
        address principalAsset,
        bytes32 orderHash
    ) internal pure {
        if (item.itemType != ItemType.ERC20) {
            revert WrongConsiderationItemType(idx, ItemType.ERC20, item.itemType);
        }
        if (item.token != principalAsset) {
            revert WrongConsiderationToken(idx, principalAsset, item.token);
        }
        // ERC20 considerations have no token identifier; Seaport's
        // shape requires the field but it MUST be 0 to disambiguate
        // from a criteria-based item.
        if (item.identifier != 0) {
            revert WrongConsiderationIdentifier(idx);
        }
        // Silence unused-param hint — `orderHash` is plumbed through
        // so future enhancements (per-orderHash error decoration in
        // the indexer) don't need a function signature change.
        orderHash; // solhint-disable-line no-unused-vars
    }

}
