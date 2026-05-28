// src/facets/NFTPrepayListingFacet.sol
// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {LibVaipakam} from "../libraries/LibVaipakam.sol";
import {LibCollateralSettlement} from "../libraries/LibCollateralSettlement.sol";
import {LibERC721} from "../libraries/LibERC721.sol";
import {DiamondAccessControl} from "../libraries/LibAccessControl.sol";
import {DiamondPausable} from "../libraries/LibPausable.sol";
import {IVaipakamErrors} from "../interfaces/IVaipakamErrors.sol";
import {IListingExecutorRecorder} from "../seaport/IListingExecutorRecorder.sol";
import {VaipakamNFTFacet} from "./VaipakamNFTFacet.sol";
import {VaipakamVaultImplementation} from "../VaipakamVaultImplementation.sol";
import {IVaipakamPrepayContext} from "../seaport/IVaipakamPrepayContext.sol";
import {LibPrepayOrder} from "../libraries/LibPrepayOrder.sol";
import {CollateralListingExecutor} from "../seaport/CollateralListingExecutor.sol";
import {PrepayListingFacet} from "./PrepayListingFacet.sol";

/**
 * @title NFTPrepayListingFacet
 * @author Vaipakam Developer Team
 * @notice T-086 step 6: the borrower-facing diamond surface for the
 *         prepay-collateral-listing flow. The four entry points let
 *         the current borrower-position-NFT holder propose / update /
 *         cancel a Seaport sale of the collateral NFT, and a fifth
 *         (permissionless) entry lets anyone clean up an expired
 *         listing post-grace.
 *
 *         How the pieces fit (full flow, end to end):
 *
 *           1. Borrower (= current `borrowerNftHolder`) chooses an
 *              `askPrice` covering at least `liveFloor × (1 +
 *              bufferBps)`. Off-chain, the frontend constructs a
 *              `FULL_RESTRICTED` Seaport order with the vault as
 *              `offerer`, the {CollateralListingExecutor} singleton
 *              as both ERC-1271 signer and zone, the three
 *              consideration legs (lender / treasury / borrower) as
 *              §5.5 of the design doc spells out, and computes the
 *              order's hash.
 *
 *           2. Borrower calls {postPrepayListing}(loanId, askPrice,
 *              orderHash, conduit). The facet validates authority +
 *              opt-in + ask vs floor + grace window, **locks** the
 *              borrower-position NFT via
 *              `LibERC721._lock(LockReason.PrepayCollateralListing)`,
 *              **records** the orderHash on the executor (so the
 *              executor's ERC-1271 path returns the magic value at
 *              fill time), and **bookkeeps** the active orderHash on
 *              `s.prepayListingOrderHash[loanId]` so cancel paths
 *              can find it without the caller passing it back in.
 *
 *           3. Frontend posts the signed order to OpenSea / a
 *              compatible Seaport book.
 *
 *           4. A buyer fills the order on Seaport. Seaport (a)
 *              consults the vault's ERC-1271 (which delegates to the
 *              executor's `isValidSignature`), (b) pulls the NFT
 *              from the vault, (c) routes the three consideration
 *              legs, (d) fires the executor's `validateOrder` zone
 *              callback. The executor's zone callback then
 *              call-backs into the diamond's
 *              {PrepayListingFacet.executorFinalizePrepaySale} —
 *              that's the path that flips Active → Settled,
 *              unlocks the borrower NFT, settles the borrower's
 *              VPFI LIF rebate.
 *
 *           5. If the buyer never shows: the borrower can
 *              {cancelPrepayListing} pre-grace, or anyone can
 *              {cancelExpiredPrepayListing} post-grace as the
 *              permissionless safety net. Both clear the orderHash
 *              on the executor + the diamond's bookkeeping +
 *              release the lock.
 *
 * @dev   Pausable. Mirrors the existing facet conventions
 *        (`DiamondPausable` for the `whenNotPaused` gate;
 *        `DiamondAccessControl` for role storage even though this
 *        facet has no role-gated entries — keeps the inheritance
 *        chain symmetric with sister facets so future selector
 *        sweeps don't have to special-case this one). The
 *        permissionless cancel path INTENTIONALLY does not carry
 *        `whenNotPaused` — see {cancelExpiredPrepayListing} for why.
 *
 *        The executor address is read from
 *        `s.collateralListingExecutor` (set via the admin entry on
 *        the step-5 `PrepayListingFacet`). If unset the facet
 *        reverts {ExecutorNotSet} — every post/update/cancel path
 *        must talk to the executor, so an unconfigured singleton is
 *        a hard error rather than silent fallthrough.
 */
contract NFTPrepayListingFacet is
    DiamondPausable,
    DiamondAccessControl,
    IVaipakamErrors
{
    // ─── Events ─────────────────────────────────────────────────────────

    /// @notice Emitted when the borrower posts a new prepay listing.
    /// @custom:event-category state-change/loan-mutation
    event PrepayListingPosted(
        uint256 indexed loanId,
        address indexed lister,
        bytes32 indexed orderHash,
        uint256 askPrice,
        address conduit
    );

    /// @notice Emitted when the borrower updates an existing
    ///         listing's ask price + orderHash (a re-sign with the
    ///         live floor, typically a few hours into the listing
    ///         once interest has eaten through the buffer).
    /// @custom:event-category state-change/loan-mutation
    event PrepayListingUpdated(
        uint256 indexed loanId,
        address indexed lister,
        bytes32 oldOrderHash,
        bytes32 indexed newOrderHash,
        uint256 newAskPrice,
        address conduit
    );

    /// @notice Emitted on every listing cancel — by the borrower
    ///         pre-grace, by anyone post-grace.
    /// @custom:event-category state-change/loan-mutation
    event PrepayListingCanceled(
        uint256 indexed loanId,
        address indexed caller,
        bytes32 indexed orderHash,
        CancelReason reason
    );

    // ─── Errors ─────────────────────────────────────────────────────────

    /// @notice `msg.sender` does not currently hold the loan's
    ///         borrower-position NFT (someone bought/transferred it
    ///         after the loan opened — only the current holder may
    ///         post / update / cancel).
    error NotPositionHolder(uint256 loanId, address caller, address expected);

    /// @notice The loan's lender consent flag is `false`. Set at
    ///         loan-init from the offer; cannot be flipped on a
    ///         live loan.
    error PrepayListingNotAllowed(uint256 loanId);

    /// @notice Loan is not `Active` (already Settled / Repaid /
    ///         Defaulted / Liquidated).
    error PrepayLoanNotActive(uint256 loanId, LibVaipakam.LoanStatus actual);

    /// @notice Trying to post on a loan that already has a live
    ///         listing — use {updatePrepayListing} instead.
    error PrepayListingAlreadyExists(uint256 loanId, bytes32 existingOrderHash);

    /// @notice No active listing for `loanId`. Either none ever
    ///         posted, or a prior cancel cleared it.
    error PrepayListingNotFound(uint256 loanId);

    /// @notice `askPrice` is below `liveFloor × (1 + bufferBps)`
    ///         at sign time.
    error AskBelowFloor(uint256 loanId, uint256 askPrice, uint256 minAsk);

    /// @notice Trying to act inside the grace window when the
    ///         action is only valid after grace expiry
    ///         ({cancelExpiredPrepayListing}).
    error GraceNotExpired(uint256 loanId, uint256 nowTime, uint256 gracePeriodEnd);

    /// @notice Trying to post / update at or after grace expiry.
    ///         Borrower must close via {DefaultedFacet} from here
    ///         on; pre-grace borrower listings are no longer
    ///         meaningful.
    error PrepayGraceWindowClosed(uint256 loanId, uint256 nowTime, uint256 gracePeriodEnd);

    /// @notice Conduit not in the executor's governance allow-list.
    error ConduitNotApproved(address conduit);

    /// @notice Executor singleton not configured. Governance must
    ///         call `PrepayListingFacet.setCollateralListingExecutor`
    ///         first.
    error ExecutorNotSet();

    /// @notice The loan's collateral isn't an ERC721 in v1. ERC1155
    ///         lands in step 9 (the design doc §7 + §13 step 15
    ///         deferral).
    error UnsupportedCollateralForV1(LibVaipakam.AssetType collateralType);

    /// @notice Buffer-bps not configured yet. The first ADMIN call
    ///         to `ConfigFacet.setPrepayListingBufferBps` enables
    ///         the path; the storage default 0 is the
    ///         intentional pre-config block.
    error PrepayListingBufferNotConfigured();

    /// @notice Caller-supplied zero `orderHash` — Seaport never
    ///         produces a zero hash so it's an obvious sentinel
    ///         the facet uses for "no listing".
    error ZeroOrderHash();

    /// @notice The borrower-position NFT is already locked under a
    ///         different reason (e.g. Preclose offset, EarlyWithdrawal
    ///         sale). Posting a prepay listing would overwrite that
    ///         reason and `_unlock` at cancel/fill time would clear
    ///         the older flow's lock state. Concurrent strategic
    ///         flows are not supported in v1; the borrower must
    ///         resolve the existing flow first.
    error BorrowerNFTAlreadyLocked(uint256 tokenId, LibERC721.LockReason currentReason);

    /// @notice Master kill-switch is off. ADMIN flips it on once
    ///         steps 7 (vault approval) + 10 (default-flow lock-
    ///         bypass) are wired end-to-end.
    error PrepayListingDisabled();

    // ─── Cancel-reason enum ─────────────────────────────────────────────

    /// @dev `Borrower` — current borrower-position holder cancelled
    ///      pre-grace; `GraceExpired` — permissionless cleanup
    ///      post-grace. Future reasons (e.g. lender-driven cancel
    ///      under default-flow lock-bypass — see design doc §5.4)
    ///      can append more enum values without renumbering.
    enum CancelReason {
        Borrower,
        GraceExpired
    }

    // ─── Borrower entry: postPrepayListing ──────────────────────────────

    /// @notice Open a Seaport prepay-listing for a live loan's
    ///         collateral NFT.
    /// @dev    See contract-level natspec for the end-to-end flow
    ///         + the listing-time validation rules. Preconditions
    ///         (each reverting with the named error):
    ///           • `loan.status == Active`             → {PrepayLoanNotActive}
    ///           • `loan.allowsPrepayListing == true`  → {PrepayListingNotAllowed}
    ///           • `loan.collateralAssetType == ERC721` → {UnsupportedCollateralForV1}
    ///           • `block.timestamp < gracePeriodEnd`  → {PrepayGraceWindowClosed}
    ///           • caller owns borrower-position NFT   → {NotPositionHolder}
    ///           • no active listing on `loanId`        → {PrepayListingAlreadyExists}
    ///           • `conduit` ∈ executor allow-list      → {ConduitNotApproved}
    ///           • `askPrice ≥ floor × (1 + bufferBps)` → {AskBelowFloor}
    ///           • `cfgPrepayListingBufferBps > 0`      → {PrepayListingBufferNotConfigured}
    /// @param loanId      Loan being listed against.
    /// @param askPrice    Total sale price in the order's payment
    ///                    token. The off-chain order constructor
    ///                    derives the three consideration leg
    ///                    amounts from this; on-chain we only
    ///                    enforce the total floor.
    /// @param orderHash   Seaport's computed order hash for the
    ///                    listing's full struct (computed by the
    ///                    frontend using Seaport's standard
    ///                    `getOrderHash` derivation against the
    ///                    canonical Seaport contract).
    /// @param conduit     The Seaport conduit the order will pull
    ///                    the NFT through. MUST be in the
    ///                    executor's `approvedConduits` allow-list.
    function postPrepayListing(
        uint256 loanId,
        uint256 askPrice,
        uint256 salt,
        bytes32 conduitKey
    ) external whenNotPaused returns (bytes32 orderHash) {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        LibVaipakam.Loan storage loan = s.loans[loanId];

        if (!s.cfgPrepayListingEnabled) revert PrepayListingDisabled();
        if (loan.status != LibVaipakam.LoanStatus.Active) {
            revert PrepayLoanNotActive(loanId, loan.status);
        }
        if (!loan.allowsPrepayListing) {
            revert PrepayListingNotAllowed(loanId);
        }
        // ERC721 + ERC1155 supported (step 15 + #306 fix). ERC20
        // collateral isn't listable on Seaport (no NFT identifier).
        if (
            loan.collateralAssetType != LibVaipakam.AssetType.ERC721 &&
            loan.collateralAssetType != LibVaipakam.AssetType.ERC1155
        ) {
            revert UnsupportedCollateralForV1(loan.collateralAssetType);
        }

        // Listing-already-exists check fires BEFORE the lock check
        // so a same-facet double-post gets the more specific error;
        // the lock check then catches cross-flow collisions
        // (Preclose offset / EarlyWithdrawal sale).
        bytes32 existing = s.prepayListingOrderHash[loanId];
        if (existing != bytes32(0)) {
            revert PrepayListingAlreadyExists(loanId, existing);
        }
        LibERC721.LockReason currentLock = LibERC721.lockOf(loan.borrowerTokenId);
        if (currentLock != LibERC721.LockReason.None) {
            revert BorrowerNFTAlreadyLocked(loan.borrowerTokenId, currentLock);
        }

        // Grace-window upper bound.
        uint256 gracePeriodEnd = _gracePeriodEnd(loan);
        if (block.timestamp >= gracePeriodEnd) {
            revert PrepayGraceWindowClosed(loanId, block.timestamp, gracePeriodEnd);
        }

        // Authority — must currently hold the borrower-position NFT.
        address holder = VaipakamNFTFacet(address(this)).ownerOf(loan.borrowerTokenId);
        if (holder != msg.sender) {
            revert NotPositionHolder(loanId, msg.sender, holder);
        }

        // Live-floor + buffer check.
        IListingExecutorRecorder executor = _requireExecutor(s);
        _requireAskCoversFloor(loanId, askPrice, s.cfgPrepayListingBufferBps);

        // #306 architectural fix — diamond CONSTRUCTS the Seaport
        // order from verified loan parameters + derives the
        // orderHash via Seaport's own `getOrderHash` view. The
        // borrower-controlled inputs (`askPrice`, `salt`,
        // `conduitKey`) are bound to a known canonical order
        // shape; the vault's ERC-1271 can never authorise a
        // different shape.
        orderHash = _buildAndRecord(s, loan, loanId, askPrice, salt, conduitKey, executor);

        emit PrepayListingPosted(loanId, msg.sender, orderHash, askPrice, _resolveConduit(executor, conduitKey));
    }

    /// @dev Heavy-lifting helper extracted so `postPrepayListing`
    ///      stays under stack-depth + the diamond facet under
    ///      EIP-170. Resolves the conduit address from the
    ///      borrower-supplied `conduitKey`, verifies allow-list
    ///      membership, builds the canonical order shape via
    ///      `LibPrepayOrder.buildAndHash`, locks the borrower
    ///      NFT, records on the executor, and wires the vault.
    function _buildAndRecord(
        LibVaipakam.Storage storage s,
        LibVaipakam.Loan storage loan,
        uint256 loanId,
        uint256 askPrice,
        uint256 salt,
        bytes32 conduitKey,
        IListingExecutorRecorder executor
    ) private returns (bytes32 orderHash) {
        // Resolve conduit address from key via Seaport's
        // ConduitController; bind (key, address) on-chain so a
        // borrower can't supply a mismatched pair.
        address conduit = _resolveConduit(executor, conduitKey);
        if (!executor.approvedConduits(conduit)) {
            revert ConduitNotApproved(conduit);
        }

        // Build the canonical Seaport order + derive its hash.
        IVaipakamPrepayContext.PrepayContext memory pctx =
            IVaipakamPrepayContext(address(this)).getPrepayContext(loanId, block.timestamp);
        address vaultAddr = s.userVaipakamVaults[loan.borrower];
        if (vaultAddr == address(0)) revert ExecutorNotSet();
        orderHash = LibPrepayOrder.buildAndHash(
            pctx,
            vaultAddr,
            address(executor),
            CollateralListingExecutor(address(executor)).seaport(),
            askPrice,
            pctx.lenderLeg,
            pctx.treasuryLeg,
            salt,
            conduitKey
        );

        // Atomic state mutations — lock → bookkeep → record →
        // wire vault. Effects-before-interactions: storage writes
        // BEFORE the external calls to executor + vault, even
        // though both are trusted singletons.
        LibERC721._lock(loan.borrowerTokenId, LibERC721.LockReason.PrepayCollateralListing);
        s.prepayListingOrderHash[loanId] = orderHash;
        s.prepayListingExecutor[loanId] = address(executor);
        executor.recordOrder(orderHash, loanId, conduit);
        _wireVaultForListing(s, loan, orderHash, conduit, address(executor));
    }

    /// @dev Resolve a `conduitKey` to its deployed conduit address
    ///      via Seaport's ConduitController. Shared by
    ///      `postPrepayListing` (record + emit) and
    ///      `updatePrepayListing` (record + emit).
    function _resolveConduit(
        IListingExecutorRecorder executor,
        bytes32 conduitKey
    ) private view returns (address) {
        return LibPrepayOrder.resolveConduit(
            CollateralListingExecutor(address(executor)).seaport(),
            conduitKey
        );
    }

    // ─── Borrower entry: updatePrepayListing ────────────────────────────

    /// @notice Replace the live listing with a fresh ask + orderHash.
    /// @dev    Same preconditions as {postPrepayListing} EXCEPT a
    ///         live listing MUST already exist (otherwise call
    ///         `post`). The implementation clears the old orderHash
    ///         on the executor + diamond bookkeeping, then records
    ///         the new one — the lock stays on throughout (an
    ///         update is a re-sign, not a cancel + re-post race
    ///         window).
    function updatePrepayListing(
        uint256 loanId,
        uint256 newAskPrice,
        bytes32 newOrderHash,
        address conduit
    ) external whenNotPaused {
        if (newOrderHash == bytes32(0)) revert ZeroOrderHash();

        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        LibVaipakam.Loan storage loan = s.loans[loanId];

        // Same master-kill-switch gate as `post`: governance can
        // disable BOTH post AND update without disabling cancels.
        if (!s.cfgPrepayListingEnabled) revert PrepayListingDisabled();

        if (loan.status != LibVaipakam.LoanStatus.Active) {
            revert PrepayLoanNotActive(loanId, loan.status);
        }
        if (!loan.allowsPrepayListing) {
            revert PrepayListingNotAllowed(loanId);
        }

        uint256 gracePeriodEnd = _gracePeriodEnd(loan);
        if (block.timestamp >= gracePeriodEnd) {
            revert PrepayGraceWindowClosed(loanId, block.timestamp, gracePeriodEnd);
        }

        address holder = VaipakamNFTFacet(address(this)).ownerOf(loan.borrowerTokenId);
        if (holder != msg.sender) {
            revert NotPositionHolder(loanId, msg.sender, holder);
        }

        bytes32 oldOrderHash = s.prepayListingOrderHash[loanId];
        if (oldOrderHash == bytes32(0)) {
            revert PrepayListingNotFound(loanId);
        }

        IListingExecutorRecorder currentExecutor = _requireExecutor(s);
        _requireAskCoversFloor(loanId, newAskPrice, s.cfgPrepayListingBufferBps);

        if (!currentExecutor.approvedConduits(conduit)) {
            revert ConduitNotApproved(conduit);
        }

        // Clear the old order on the executor that ORIGINALLY
        // recorded it — survives a governance rotation between
        // post and update (Codex P2 round-2 fix). If the pinned
        // executor is the same as the current one, this is a
        // no-op duplicate clear; otherwise we're clearing the old
        // executor's orderContext while recording on the new one.
        address pinnedExecutor = s.prepayListingExecutor[loanId];
        if (pinnedExecutor != address(0)) {
            IListingExecutorRecorder(pinnedExecutor).clearOrder(oldOrderHash);
        }

        s.prepayListingOrderHash[loanId] = newOrderHash;
        s.prepayListingExecutor[loanId] = address(currentExecutor);
        currentExecutor.recordOrder(newOrderHash, loanId, conduit);

        // T-086 step 7 — vault-side rotation. Revoke the old
        // orderHash → executor binding, register the new one;
        // re-grant the conduit approval (idempotent if conduit
        // unchanged; updates the per-token approval target if
        // the borrower picked a different conduit on the new
        // signing).
        VaipakamVaultImplementation vault = _userVault(s, loan.borrower);
        vault.revokeListingOrderHash(oldOrderHash);
        vault.registerListingOrderHash(newOrderHash, address(currentExecutor));
        vault.setCollateralOperatorApproval(
            loan.collateralAsset, loan.collateralTokenId, conduit, true
        );

        emit PrepayListingUpdated(loanId, msg.sender, oldOrderHash, newOrderHash, newAskPrice, conduit);
    }

    // ─── Borrower entry: cancelPrepayListing ────────────────────────────

    /// @notice Borrower-side cancel of a live listing.
    /// @dev    Authority gated on current borrower-position holder
    ///         (same gate as `post` / `update`). Permits cancel
    ///         pre- AND post-grace; this is the borrower's
    ///         explicit cancel, distinct from the permissionless
    ///         {cancelExpiredPrepayListing}. We release the lock
    ///         + clear the diamond bookkeeping + tell the executor
    ///         to clear the orderHash.
    function cancelPrepayListing(uint256 loanId) external whenNotPaused {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        LibVaipakam.Loan storage loan = s.loans[loanId];

        // INTENTIONALLY no loan-status gate (Codex P2 round-2 fix).
        // If a live prepay-listed loan gets repaid via
        // `RepayFacet.repayLoan` (or precloseped via PrecloseFacet,
        // refinanced via RefinanceFacet), those terminals currently
        // don't clear the prepay-listing bookkeeping — so the
        // borrower's only escape from a stale listing without this
        // would be the post-grace permissionless path. Letting the
        // current position-NFT holder always cancel keeps the
        // cleanup immediate; the operation is no-fund-movement
        // (lock release + bookkeeping clear), safe across every
        // terminal state.
        //
        // Follow-up: the Repay / Preclose / Refinance terminals
        // SHOULD eventually call into a shared `_clearPrepayListing`
        // helper themselves so the bookkeeping clears atomically
        // with the close. That cross-facet wiring is tracked
        // alongside the design-doc §13 step-10 default-flow
        // integration; until that lands, this borrower escape
        // hatch is the safety net.

        address holder = VaipakamNFTFacet(address(this)).ownerOf(loan.borrowerTokenId);
        if (holder != msg.sender) {
            revert NotPositionHolder(loanId, msg.sender, holder);
        }

        bytes32 orderHash = s.prepayListingOrderHash[loanId];
        if (orderHash == bytes32(0)) {
            revert PrepayListingNotFound(loanId);
        }

        _cancel(s, loan, loanId, orderHash, CancelReason.Borrower);
    }

    // ─── Permissionless entry: cancelExpiredPrepayListing ───────────────

    /// @notice Permissionless cleanup of a listing whose grace
    ///         window has expired without a fill.
    /// @dev    Three rationale points worth keeping in mind:
    ///
    ///         1. **Lock liveness.** The borrower-position NFT
    ///            stays locked until either a fill (zone callback
    ///            unlocks) or a cancel (this path / borrower
    ///            cancel). If neither runs, the borrower can't
    ///            transfer / re-list. Permissionless cleanup
    ///            removes the dependency on the borrower being
    ///            alive at grace expiry.
    ///
    ///         2. **Default-flow interplay.** Per design doc §5.4,
    ///            `DefaultedFacet.markDefaulted` and
    ///            `RiskFacet.triggerLiquidation` ALSO unlock the
    ///            borrower NFT as their first step if the lock
    ///            reason is `PrepayCollateralListing`. So
    ///            `cancelExpiredPrepayListing` is a *parallel*
    ///            safety net, not a strict prerequisite — either
    ///            this OR the default trigger can run; whichever
    ///            wins first leaves the loan in the right state.
    ///
    ///         3. **No `whenNotPaused`.** The cleanup path
    ///            INTENTIONALLY does NOT gate on pause — if the
    ///            diamond is paused, locked NFTs would otherwise
    ///            stay locked indefinitely while users wait for
    ///            unpause. The cancel is a no-fund-movement
    ///            operation (just releases a lock + clears a
    ///            mapping); it's safe to run while paused.
    function cancelExpiredPrepayListing(uint256 loanId) external {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        LibVaipakam.Loan storage loan = s.loans[loanId];

        // INTENTIONALLY no loan-status gate here. After grace
        // expiry, `DefaultedFacet.markDefaulted` / RiskFacet
        // liquidation might flip the loan to `Defaulted` /
        // `Liquidated` BEFORE this cleanup runs. The design-doc
        // §5.4 plan has those default-flow facets unlock the
        // borrower NFT themselves as their first step (step 10),
        // but until that wires up the borrower NFT would sit
        // locked with no escape if we gated this cleanup on
        // `Active`. So: any loan-status is acceptable here. The
        // operation is no-fund-movement (just lock release +
        // bookkeeping clear); safe across every terminal state.

        // Permissionless gate — strict `>` matches the step-5
        // executor's reject condition (`block.timestamp >
        // pctx.graceEnd → GraceExpired`). At exactly
        // `block.timestamp == gracePeriodEnd` the executor still
        // permits a fill, so we MUST NOT race that path with a
        // cancel here. Cleanup is only valid at strict
        // `block.timestamp > gracePeriodEnd`.
        uint256 gracePeriodEnd = _gracePeriodEnd(loan);
        if (block.timestamp <= gracePeriodEnd) {
            revert GraceNotExpired(loanId, block.timestamp, gracePeriodEnd);
        }

        bytes32 orderHash = s.prepayListingOrderHash[loanId];
        if (orderHash == bytes32(0)) {
            revert PrepayListingNotFound(loanId);
        }

        _cancel(s, loan, loanId, orderHash, CancelReason.GraceExpired);
    }

    // ─── View: getPrepayListingOrderHash (read-side for frontends) ──────

    /// @notice Active orderHash for `loanId`, or `bytes32(0)` if
    ///         none. Indexer + frontend read this to render the
    ///         "your loan has a live listing" UI.
    function getPrepayListingOrderHash(uint256 loanId) external view returns (bytes32) {
        return LibVaipakam.storageSlot().prepayListingOrderHash[loanId];
    }

    /// @notice Current configured prepay-listing buffer in BPS.
    ///         Frontend reads this to compute "minimum ask" in the
    ///         post-listing UI without an extra cross-facet call.
    function getPrepayListingBufferBps() external view returns (uint256) {
        return LibVaipakam.storageSlot().cfgPrepayListingBufferBps;
    }

    // ─── Internal helpers ───────────────────────────────────────────────

    /// @dev Computes `startTime + durationDays + grace(durationDays)`.
    ///      Same shape the step-5 `PrepayListingFacet.getPrepayContext`
    ///      uses — kept inlined here (not factored into a library)
    ///      so step 6 has no extra library coupling beyond the
    ///      step-3 settlement math. If a future step factors this
    ///      into a `LibLoanTime.gracePeriodEnd(loan)` helper,
    ///      every facet should switch in lockstep.
    function _gracePeriodEnd(LibVaipakam.Loan storage loan) private view returns (uint256) {
        uint256 endTime = uint256(loan.startTime) + (uint256(loan.durationDays) * 1 days);
        return endTime + LibVaipakam.gracePeriod(loan.durationDays);
    }

    /// @dev Loads the executor address, reverting {ExecutorNotSet}
    ///      if zero. Returns the typed interface handle so the
    ///      caller can immediately use `recordOrder` / `clearOrder`
    ///      / `approvedConduits` without re-casting.
    function _requireExecutor(LibVaipakam.Storage storage s)
        private
        view
        returns (IListingExecutorRecorder)
    {
        address executor = s.collateralListingExecutor;
        if (executor == address(0)) revert ExecutorNotSet();
        return IListingExecutorRecorder(executor);
    }

    /// @dev Validates `askPrice ≥ liveFloor × (10000 + bufferBps) / 10000`.
    ///      `liveFloor` is the step-3 closed-form pre-default floor
    ///      consumed by every prepay-listing path. The buffer is
    ///      the fillability headroom — without it the listing
    ///      becomes unfillable seconds after sign as interest
    ///      accrues.
    function _requireAskCoversFloor(
        uint256 loanId,
        uint256 askPrice,
        uint256 bufferBps
    ) private view {
        // Buffer must be configured; storage default 0 is the
        // intentional pre-config block (see ConfigFacet natspec).
        if (bufferBps == 0) revert PrepayListingBufferNotConfigured();

        uint256 floor = LibCollateralSettlement.liveFloor(loanId, block.timestamp);
        // `(10000 + bufferBps)` capped at 11000 by ConfigFacet
        // bounds; `floor × 11000` for any realistic loan is
        // well below 2^256, so no overflow guard needed.
        uint256 minAsk = (floor * (10_000 + bufferBps)) / 10_000;
        if (askPrice < minAsk) revert AskBelowFloor(loanId, askPrice, minAsk);
    }

    /// @dev Shared finalization for {cancelPrepayListing} +
    ///      {cancelExpiredPrepayListing}. Sequence:
    ///        1. unlock borrower-position NFT
    ///        2. clear diamond's per-loan orderHash slot
    ///        3. tell the executor to clear its `orderContext`
    ///           binding (idempotent on the executor side)
    ///        4. emit the standard event with the right reason.
    function _cancel(
        LibVaipakam.Storage storage s,
        LibVaipakam.Loan storage loan,
        uint256 loanId,
        bytes32 orderHash,
        CancelReason reason
    ) private {
        // Resolve the executor to clear on: the address pinned at
        // post/update time (Codex P2 round-2 fix). Survives a
        // governance rotation while the listing was live — the
        // current `s.collateralListingExecutor` might already
        // point at a successor.
        address pinnedExecutor = s.prepayListingExecutor[loanId];
        // The post/update paths always set both `orderHash` AND
        // `executor` atomically, so a non-zero orderHash invariably
        // pairs with a non-zero executor address. We still guard
        // defensively here in case a future migration introduces
        // an unset-executor state mid-rollout.
        if (pinnedExecutor == address(0)) revert ExecutorNotSet();

        LibERC721._unlock(loan.borrowerTokenId);
        delete s.prepayListingOrderHash[loanId];
        delete s.prepayListingExecutor[loanId];
        IListingExecutorRecorder(pinnedExecutor).clearOrder(orderHash);

        // T-086 step 7 — vault-side cleanup. Revoke the conduit's
        // per-token approval AND the orderHash → executor binding
        // so a previously-signed Seaport order can no longer fill
        // even if it's already posted to the conduit's order book.
        // The vault must exist for the loan to have made it
        // through `postPrepayListing` in the first place; we still
        // guard defensively against a future migration window
        // where the mapping could be out of sync.
        address vaultAddr = s.userVaipakamVaults[loan.borrower];
        if (vaultAddr != address(0)) {
            VaipakamVaultImplementation vault = VaipakamVaultImplementation(vaultAddr);
            vault.setCollateralOperatorApproval(
                loan.collateralAsset, loan.collateralTokenId, address(0), false
            );
            vault.revokeListingOrderHash(orderHash);
        }

        emit PrepayListingCanceled(loanId, msg.sender, orderHash, reason);
    }

    /// @dev Shared helper for `postPrepayListing`'s vault wiring.
    ///      Looks up the borrower's vault, grants the Seaport
    ///      conduit a per-token approval on the collateral NFT,
    ///      and pins the orderHash → executor binding on the
    ///      vault's ERC-1271 mapping. Factored out so the post
    ///      path body stays focused on the diamond-side state
    ///      mutations.
    function _wireVaultForListing(
        LibVaipakam.Storage storage s,
        LibVaipakam.Loan storage loan,
        bytes32 orderHash,
        address conduit,
        address executor,
        bool /* approve */
    ) private {
        address vaultAddr = s.userVaipakamVaults[loan.borrower];
        if (vaultAddr == address(0)) revert ExecutorNotSet();
        VaipakamVaultImplementation vault = VaipakamVaultImplementation(vaultAddr);
        vault.setCollateralOperatorApproval(
            loan.collateralAsset, loan.collateralTokenId, conduit, true
        );
        vault.registerListingOrderHash(orderHash, executor);
    }

    /// @dev Read-only borrower-vault lookup. Reverts via
    ///      {ExecutorNotSet} for the unset case to match the
    ///      sister error already raised when the executor address
    ///      isn't configured — both signal "the prepay path
    ///      isn't fully wired for this loan", and surfacing a
    ///      single error keeps the borrower's UX simple.
    function _userVault(
        LibVaipakam.Storage storage s,
        address user
    ) private view returns (VaipakamVaultImplementation) {
        address vaultAddr = s.userVaipakamVaults[user];
        if (vaultAddr == address(0)) revert ExecutorNotSet();
        return VaipakamVaultImplementation(vaultAddr);
    }
}
