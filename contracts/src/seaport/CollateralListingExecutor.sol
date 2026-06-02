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
    ///         Storage packing (4 × 32 bytes = 4 slots):
    ///           slot 0: uint96 loanId | address conduit
    ///           slot 1: bytes32 conduitKey
    ///           slot 2: uint256 salt
    ///           slot 3: uint64 startTime | uint192 askPrice
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
    ///             narrowing pattern.
    struct OrderContext {
        uint96 loanId;
        address conduit;
        bytes32 conduitKey;
        uint256 salt;
        uint64 startTime;
        uint192 askPrice;
    }
    mapping(bytes32 orderHash => OrderContext) public orderContext;

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
        uint256 askPrice
    ) external {
        if (msg.sender != vaipakamDiamond) revert NotDiamond();
        if (!approvedConduits[conduit]) revert ConduitNotApproved(conduit);
        if (orderContext[orderHash].loanId != 0) revert AlreadyRecorded(orderHash);
        // Explicit bounds checks before the narrowing casts. Silent
        // narrowing would let a value exceeding the recorded width
        // wrap into a different valid context entry at fill / cleanup
        // time, causing mis-settlement (loanId), mis-pctx
        // reconstruction (startTime), or mis-floor reconstruction
        // (askPrice). With 2^96 / 2^64 / 2^192 all vastly exceeding
        // any realistic value, these reverts are unreachable today —
        // but explicit > silent.
        if (loanId > type(uint96).max) revert LoanIdOverflow(loanId);
        if (startTime > type(uint64).max) revert StartTimeOverflow(startTime);
        if (askPrice > type(uint192).max) revert AskPriceOverflow(askPrice);
        orderContext[orderHash] = OrderContext({
            loanId: uint96(loanId),
            conduit: conduit,
            conduitKey: conduitKey,
            salt: salt,
            startTime: uint64(startTime),
            askPrice: uint192(askPrice)
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
        // Sign-time pctx — getPrepayContext(loanId, ctx.startTime)
        // re-derives the floor legs evaluated at the ORIGINAL post
        // timestamp, so the lender / treasury / borrower
        // consideration amounts match what was signed. The reads
        // (loan.principal, durationDays, lenderTokenId,
        // borrowerTokenId, etc.) are status-agnostic — the diamond's
        // {getPrepayContext} is a pure view and the loan record
        // persists past the status flip to Settled / Defaulted /
        // Refinanced, so calling this from terminal cleanup is safe.
        IVaipakamPrepayContext.PrepayContext memory pctx =
            IVaipakamPrepayContext(vaipakamDiamond).getPrepayContext(
                uint256(ctx.loanId),
                uint256(ctx.startTime)
            );

        // Defensive floor-coverage check. `LibPrepayOrder._componentsAt`
        // computes `borrowerLeg = askPrice - lenderLeg - treasuryLeg`;
        // if the cancel-time floor reads HIGHER than the recorded
        // sign-time `askPrice`, the unchecked subtraction would panic
        // with arithmetic underflow and revert the entire cleanup
        // path. Two realistic ways for this to happen:
        //   (a) Governance bumped `treasuryFeeBps` between sign and
        //       cancel → `pctx.treasuryLeg` is now higher than the
        //       value the facet validated against at post time.
        //   (b) Governance flipped a related fee curve.
        // In any such case the original order is functionally already
        // "stale" — it could never have been filled at the new floor —
        // so the right behaviour is to fall back to the no-op skip
        // branch (the proper cleanup still completes; we just don't
        // get the OpenSea catalog refresh acceleration).
        if (uint256(ctx.askPrice) < pctx.lenderLeg + pctx.treasuryLeg) {
            emit SeaportCancelSkipped(orderHash, uint256(ctx.loanId));
            return;
        }

        OrderComponents memory components = LibPrepayOrder.componentsForCancel(
            pctx,
            address(this),
            uint256(ctx.askPrice),
            ctx.conduitKey,
            uint256(ctx.salt),
            uint256(ctx.startTime),
            ISeaportOrderHash(seaport).getCounter(pctx.borrowerVault)
        );

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
        // Three legs in fixed order: [lender, treasury, borrower] per
        // design doc §5.5. Each must be in the loan's lending asset
        // (ERC20 only for v1 — NFT-rental loans don't fit the prepay
        // sale flow). Without these checks, a fill could route the
        // right amounts in the WRONG token (Codex / Grok blocker on
        // Round 1).
        if (params.consideration.length != 3) {
            revert WrongConsiderationCount(3, params.consideration.length);
        }
        if (pctx.assetType != LibVaipakam.AssetType.ERC20) {
            revert UnsupportedLendingAssetType();
        }
        _assertConsiderationItem(params.consideration[0], 0, pctx.principalAsset, params.orderHash);
        _assertConsiderationItem(params.consideration[1], 1, pctx.principalAsset, params.orderHash);
        _assertConsiderationItem(params.consideration[2], 2, pctx.principalAsset, params.orderHash);

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
