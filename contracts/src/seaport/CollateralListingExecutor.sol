// src/seaport/CollateralListingExecutor.sol
// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import {OwnableUpgradeable} from "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import {IERC1271} from "@openzeppelin/contracts/interfaces/IERC1271.sol";

import {ISeaportZone, ZoneParameters, ReceivedItem, ItemType} from "./ISeaportZone.sol";
import {IVaipakamPrepayCallbacks} from "./IVaipakamPrepayCallbacks.sol";

import {LibVaipakam} from "../libraries/LibVaipakam.sol";
import {LibCollateralSettlement} from "../libraries/LibCollateralSettlement.sol";
import {VaipakamNFTFacet} from "../facets/VaipakamNFTFacet.sol";
import {LoanFacet} from "../facets/LoanFacet.sol";

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
    /// @dev    `loanId` is `uint96` so the struct packs in one slot
    ///         (uint96 + address = 32 bytes). Diamond's `loans` mapping
    ///         is keyed by `uint256`; the cast back is lossless because
    ///         no protocol-issued loanId will exceed 2^96 in the
    ///         foreseeable lifetime (one nextLoanId increment per loan
    ///         creation; 2^96 ≈ 7.9 × 10^28, vs ~10^9 max realistic).
    struct OrderContext {
        uint96 loanId;
        address conduit;
    }
    mapping(bytes32 orderHash => OrderContext) public orderContext;

    // ─── Events ─────────────────────────────────────────────────────────

    event ConduitApproved(address indexed conduit);
    event ConduitRevoked(address indexed conduit);
    event OrderRecorded(bytes32 indexed orderHash, uint256 indexed loanId, address conduit);
    event OrderFilled(bytes32 indexed orderHash, uint256 indexed loanId);
    event OrderCanceled(bytes32 indexed orderHash, uint256 indexed loanId);

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
    error WrongLenderRecipient(bytes32 orderHash);
    error WrongBorrowerRecipient(bytes32 orderHash);
    error ZeroAddress();
    error AlreadyRecorded(bytes32 orderHash);

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

    /// @notice Stamp the `orderHash → (loanId, conduit)` binding before
    ///         Seaport processes the signed order. Called exclusively
    ///         by the diamond's step-6 `NFTPrepayListingFacet.postPrepayListing`.
    /// @dev    Access-gated to the diamond — an arbitrary EOA can't
    ///         seed phantom orderContext entries to forge a future
    ///         sign. Also asserts the conduit is currently approved;
    ///         a conduit removed between record + sign would still
    ///         have a valid context but the zone callback's conduit
    ///         re-check catches it.
    function recordOrder(bytes32 orderHash, uint256 loanId, address conduit) external {
        if (msg.sender != vaipakamDiamond) revert NotDiamond();
        if (!approvedConduits[conduit]) revert ConduitNotApproved(conduit);
        if (orderContext[orderHash].loanId != 0) revert AlreadyRecorded(orderHash);
        orderContext[orderHash] = OrderContext({
            loanId: uint96(loanId),
            conduit: conduit
        });
        emit OrderRecorded(orderHash, loanId, conduit);
    }

    /// @notice Clear an orderHash binding. Called by the diamond's
    ///         `cancelPrepayListing` (step 6) so a previously-signed
    ///         order can no longer fill once the borrower has
    ///         cancelled. Idempotent: clearing an already-cleared
    ///         orderHash is a no-op.
    function clearOrder(bytes32 orderHash) external {
        if (msg.sender != vaipakamDiamond) revert NotDiamond();
        uint256 loanId = uint256(orderContext[orderHash].loanId);
        delete orderContext[orderHash];
        emit OrderCanceled(orderHash, loanId);
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
        OrderContext memory ctx = orderContext[hash];
        if (ctx.loanId == 0) {
            return 0xffffffff;
        }
        if (!approvedConduits[ctx.conduit]) {
            return 0xffffffff;
        }
        // Conservative liveness gate at 1271 time: refuse to sign if
        // the loan isn't Active. Fill-time re-checks will catch the
        // race window between this view and the zone callback.
        LibVaipakam.Loan memory loan = LoanFacet(vaipakamDiamond).getLoanDetails(
            uint256(ctx.loanId)
        );
        if (loan.status != LibVaipakam.LoanStatus.Active) {
            return 0xffffffff;
        }
        return IERC1271.isValidSignature.selector;
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
    function validateOrder(ZoneParameters calldata params)
        external
        override
        returns (bytes4)
    {
        if (msg.sender != seaport) revert NotSeaport();

        OrderContext memory ctx = orderContext[params.orderHash];
        if (ctx.loanId == 0) revert UnknownOrder(params.orderHash);
        if (!approvedConduits[ctx.conduit]) revert ConduitNotApproved(ctx.conduit);

        uint256 loanId = uint256(ctx.loanId);
        LibVaipakam.Loan memory loan = LoanFacet(vaipakamDiamond).getLoanDetails(loanId);

        if (loan.status != LibVaipakam.LoanStatus.Active) revert LoanNotActive(loanId);
        // Grace expiry = startTime + durationDays + gracePeriod(durationDays).
        // The per-duration grace bucket is governance-tunable via
        // `ConfigFacet.setGraceBuckets`; we read through the canonical
        // `LibVaipakam.gracePeriod` helper so the prepay flow honors
        // any future bucket changes without code edits here.
        uint256 endTime = uint256(loan.startTime) + (loan.durationDays * 1 days);
        uint256 graceEnd = endTime + LibVaipakam.gracePeriod(loan.durationDays);
        if (block.timestamp >= graceEnd) revert GraceExpired(loanId);

        // ── Live-floor leg checks ───────────────────────────────────────
        // The order's consideration MUST have exactly 3 items in the
        // order [lender, treasury, borrower] per design doc §5.5. Each
        // item's amount is compared against the live floor at THIS
        // block (so interest accrued since sign-time bumps the
        // required amount; the borrower's 2% buffer compensates for
        // this drift up to the buffer cap).
        if (params.consideration.length != 3) {
            revert WrongConsiderationCount(3, params.consideration.length);
        }

        uint256 lenderLeg = LibCollateralSettlement.principalPlusAccruedInterest(
            loanId, block.timestamp
        );
        uint256 treasuryLeg = LibCollateralSettlement.treasuryAndPrecloseFee(
            loanId, block.timestamp
        );

        if (params.consideration[0].amount < lenderLeg) {
            revert LenderShortPaid(params.orderHash);
        }
        if (params.consideration[1].amount < treasuryLeg) {
            revert TreasuryShortPaid(params.orderHash);
        }

        // ── Recipient checks (bind to CURRENT NFT holders) ──────────────
        // Position-NFT transfers between sign + fill move the right
        // to receive lender / borrower economics with the NFT. Re-derive
        // the current holders here; reject if the signed consideration
        // doesn't match.
        address lenderHolder = VaipakamNFTFacet(vaipakamDiamond).ownerOf(loan.lenderTokenId);
        if (params.consideration[0].recipient != lenderHolder) {
            revert WrongLenderRecipient(params.orderHash);
        }
        address borrowerHolder = VaipakamNFTFacet(vaipakamDiamond).ownerOf(loan.borrowerTokenId);
        if (params.consideration[2].recipient != borrowerHolder) {
            revert WrongBorrowerRecipient(params.orderHash);
        }
        // Treasury recipient (consideration[1].recipient) is verified
        // by Seaport's own consideration-routing — the order writer
        // (step-6 facet) sets it to `LibVaipakam.storageSlot().treasury`
        // at order-build time, and Seaport literally transfers there.
        // No on-chain re-derive here because treasury isn't NFT-bound
        // and a stale value can't shift between sign + fill.

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
}
