// src/facets/OfferParallelSaleFacet.sol
// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {LibVaipakam} from "../libraries/LibVaipakam.sol";
import {LibEntitlement} from "../libraries/LibEntitlement.sol";
import {LibPrepayOrder} from "../libraries/LibPrepayOrder.sol";
import {LibPrepayCleanup} from "../libraries/LibPrepayCleanup.sol";
import {DiamondReentrancyGuard} from "../libraries/LibReentrancyGuard.sol";
import {DiamondPausable} from "../libraries/LibPausable.sol";
import {IVaipakamErrors} from "../interfaces/IVaipakamErrors.sol";
import {IListingExecutorRecorder} from "../seaport/IListingExecutorRecorder.sol";
import {VaipakamVaultImplementation} from "../VaipakamVaultImplementation.sol";
import {
    FeeLeg,
    MAX_FEE_LEGS,
    OfferContext,
    PREPAY_MODE_PRE_LOAN_FIXED_PRICE,
    GTC_SEAPORT_END_TIME
} from "../seaport/PrepayTypes.sol";

/**
 * @title OfferParallelSaleFacet
 * @author Vaipakam Developer Team
 * @notice T-086 Round-8 (#358) — borrow-OR-sell parallel-sale entry
 *         points (§19.5 + §19.7f). Pulled into its own facet for two
 *         reasons:
 *           1. EIP-170 headroom — the alternative (mounting these on
 *              `OfferCreateFacet`) overflowed solc's viaIR optimizer's
 *              internal jump-table reservation (the "Tag too large for
 *              reserved space" ICE class).
 *           2. Topology consistency with the existing per-loan prepay
 *              facets (`NFTPrepayListingFacet` / `NFTPrepayAutoListFacet`
 *              / `NFTPrepayListingAtomicFacet`) — the parallel-sale
 *              surface is the offer-keyed mirror of those.
 * @dev   Part of the Diamond Standard (EIP-2535). Reentrancy-guarded,
 *        pausable. Selectors are added to `_getOfferParallelSaleSelectors`
 *        in `DeployDiamond.s.sol` + the matching helper getter in
 *        `HelperTest.sol`.
 */
contract OfferParallelSaleFacet is
    DiamondReentrancyGuard,
    DiamondPausable,
    IVaipakamErrors
{
    // ─── Events ────────────────────────────────────────────────────────

    /// @notice §19.5 — emitted when the borrower posts a parallel-sale
    ///         (pre-loan) Seaport listing for their open offer.
    ///         Indexer breadcrumb so the dapp can publish the order
    ///         JSON to OpenSea's `v2/orders` endpoint + render the
    ///         "this offer has a parallel OpenSea listing live at floor
    ///         $X" banner.
    /// @custom:event-category state-change/offer-mutation
    event PostParallelSaleListing(
        uint96 indexed offerId,
        address indexed borrower,
        bytes32 indexed orderHash,
        uint256 askPrice,
        address executor,
        address conduit,
        bytes32 conduitKey,
        uint256 salt,
        FeeLeg[] feeLegs
    );

    /// @notice §19.7f — emitted when the borrower non-destructively
    ///         releases the parallel-sale binding (offer stays alive;
    ///         only the executor + vault bindings are torn down).
    ///         Indexer breadcrumb so the dapp can re-render the offer
    ///         card without the parallel listing.
    /// @custom:event-category state-change/offer-mutation
    event ParallelSaleLockReleased(uint96 indexed offerId, address indexed borrower);

    // ─── Errors ────────────────────────────────────────────────────────
    //
    // `NotOfferCreator()` inherits from IVaipakamErrors (parameterless,
    // same shape OfferCreateFacet uses for its creator-only paths).

    error ParallelSaleNotEnabled(uint96 offerId);
    error ParallelSaleListingAlreadyPosted(uint96 offerId, bytes32 existingOrderHash);
    error OfferTerminal(uint96 offerId); // accepted / cancelled / consumed-by-sale
    error UnsupportedCollateralForParallelSale(LibVaipakam.AssetType collateralType);
    error UnsupportedPrincipalForParallelSale(LibVaipakam.AssetType principalType);
    error AskBelowPreLoanFloor(uint96 offerId, uint256 askPrice, uint256 minAsk);
    error PrepayListingBufferNotConfigured();
    error AutoListExecutorNotSet();
    error AutoListConduitNotConfigured();
    error FeeLegsExceedCap(uint256 supplied, uint256 cap);
    error VaultNotDeployed(address borrower);

    // ─── Internal stack-relief struct ──────────────────────────────────

    /// @dev Bundles intermediate locals into a single memory slot so
    ///      viaIR's stack scheduler can route them as one slot rather
    ///      than 5 separate ones.
    struct _PostLocals {
        address vaultAddr;
        address executor;
        address conduit;
        uint256 salt;
        uint64 endTime;
    }

    // ─── Public entry points ───────────────────────────────────────────

    /// @notice §19.3 + §19.5 — borrower-only opt-in to expose the
    ///         offer's collateral NFT for sale on OpenSea (or
    ///         Seaport-conformant) in parallel to the offer being open
    ///         for lender acceptance. Whichever path fires first
    ///         (lender-accept vs buyer-fill) wins; the other is
    ///         structurally blocked.
    /// @dev    Gated on `offer.creator == msg.sender`. The offer must
    ///         have been created with `allowsParallelSale == true` and
    ///         not be in a terminal state (`!accepted`, `!offerCancelled`,
    ///         `!offerConsumedBySale`) and not already have a live
    ///         parallel-sale binding.
    ///
    ///         Pre-loan floor (§19.3 round-3.3 + round-3.4):
    ///           `floor = (principal + projectedFirstPeriodInterest)
    ///                    × (10000 + cfgPrepayListingBufferBps) / 10000`
    ///         where `projectedFirstPeriodInterest =
    ///         LibEntitlement.proRataInterest(principal, rateBps,
    ///         min(1, durationDays))` — at-most-one day of interest as
    ///         the hedge against the loan being accepted between sale-
    ///         listing and sale-fill. No treasury fee addend.
    ///
    ///         Fee-aware: the per-leg fee schedule lifts the floor by
    ///         `sum(feeLegs.startAmount)`; comparison runs against the
    ///         fee-inclusive minimum.
    /// @param  offerId    Offer to attach the parallel-sale listing to.
    /// @param  askPrice   Borrower's listing ask (≥ pre-loan floor).
    /// @param  conduitKey Seaport conduit key the listing routes through.
    /// @param  feeLegs    Seller-baked OpenSea / creator fee schedule
    ///                    (hashed into the canonical order — round-3.2
    ///                    against Codex round-3.2 P2 #5 line 4759).
    /// @return orderHash  Canonical Seaport orderHash; the dapp uses
    ///                    this to publish the order JSON to OpenSea.
    function postParallelSaleListing(
        uint96 offerId,
        uint256 askPrice,
        bytes32 conduitKey,
        FeeLeg[] calldata feeLegs
    ) external nonReentrant whenNotPaused returns (bytes32 orderHash) {
        _validatePostParallelSale(offerId, askPrice, conduitKey, feeLegs);

        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        LibVaipakam.Offer storage offer = s.offers[uint256(offerId)];

        _PostLocals memory loc;
        loc.vaultAddr = s.userVaipakamVaults[offer.creator];
        loc.executor = s.collateralListingExecutor;
        loc.conduit = LibPrepayOrder.resolveConduit(
            IListingExecutorRecorder(loc.executor).seaport(),
            conduitKey
        );
        if (!IListingExecutorRecorder(loc.executor).approvedConduits(loc.conduit)) {
            revert AutoListConduitNotConfigured();
        }

        // Per-offer nonce-mixed salt defeats same-block sale + recreate
        // collisions (§19.10 Q3 — round-3.2 against Raja P3 #2).
        uint64 nonce = s.parallelSaleNonce[offerId];
        s.parallelSaleNonce[offerId] = nonce + 1;
        loc.salt = uint256(keccak256(
            abi.encode(offerId, block.timestamp, msg.sender, nonce)
        ));

        // GTC offer expiry handling per §19.6 round-3.2 + round-3.7:
        // `offer.expiresAt == 0` is the GTC sentinel on the diamond's
        // side; map to `block.timestamp + GTC_SEAPORT_END_TIME` so
        // Seaport's `endTime` is finite far-future-bound.
        loc.endTime = offer.expiresAt == 0
            ? uint64(block.timestamp) + GTC_SEAPORT_END_TIME
            : offer.expiresAt;

        orderHash = _recordAndWireOfferOrder(
            offer, offerId, askPrice, conduitKey, feeLegs, loc
        );

        emit PostParallelSaleListing(
            offerId,
            offer.creator,
            orderHash,
            askPrice,
            loc.executor,
            loc.conduit,
            conduitKey,
            loc.salt,
            feeLegs
        );
    }

    /// @notice §19.7f — borrower-only non-destructive unwind of the
    ///         parallel-sale listing. Clears the executor + vault
    ///         bindings + the 3 diamond mirror slots WITHOUT touching
    ///         `offerCancelled` / `accepted` / `offerConsumedBySale`
    ///         (the offer itself stays alive — only the parallel-sale
    ///         binding is unwound).
    /// @dev    Added round-3.4 against Codex round-3 P2 line 4892 — to
    ///         give the borrower a non-destructive option to repair a
    ///         stale floor input (e.g. when mutating one of the 5
    ///         load-bearing OfferMutateFacet-locked fields) without
    ///         abandoning the offer's accumulated discovery (age +
    ///         lender views + indexer state).
    ///
    ///         Idempotent: calling on an offer without a live parallel-
    ///         sale binding is a no-op (LibPrepayCleanup.clearOfferListing
    ///         early-returns when `s.offerPrepayListingOrderHash[offerId] == 0`).
    function releaseParallelSaleLock(uint96 offerId)
        external
        nonReentrant
        whenNotPaused
    {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        LibVaipakam.Offer storage offer = s.offers[uint256(offerId)];
        if (offer.creator != msg.sender) revert NotOfferCreator();
        LibPrepayCleanup.clearOfferListing(offerId);
        emit ParallelSaleLockReleased(offerId, msg.sender);
    }

    // ─── Private helpers ───────────────────────────────────────────────

    /// @dev All preconditions + the pre-loan floor computation. Reverts
    ///      on any gate failure. Pure validation — no state mutation.
    function _validatePostParallelSale(
        uint96 offerId,
        uint256 askPrice,
        bytes32 conduitKey,
        FeeLeg[] calldata feeLegs
    ) private view {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        LibVaipakam.Offer storage offer = s.offers[uint256(offerId)];

        // ── Caller-gate (creator-only) ────────────────────────────
        if (offer.creator != msg.sender) revert NotOfferCreator();

        // ── Offer-shape preconditions (§19.5 opt-in) ──────────────
        if (!offer.allowsParallelSale) revert ParallelSaleNotEnabled(offerId);

        // ── Terminal-state preconditions ──────────────────────────
        if (offer.accepted) revert OfferTerminal(offerId);
        if (s.offerCancelled[uint256(offerId)]) revert OfferTerminal(offerId);
        if (s.offerConsumedBySale[uint256(offerId)]) revert OfferTerminal(offerId);

        // ── Already-listed gate ───────────────────────────────────
        bytes32 existing = s.offerPrepayListingOrderHash[offerId];
        if (existing != bytes32(0)) {
            revert ParallelSaleListingAlreadyPosted(offerId, existing);
        }

        // ── Collateral / principal asset gates ────────────────────
        if (
            offer.collateralAssetType != LibVaipakam.AssetType.ERC721 &&
            offer.collateralAssetType != LibVaipakam.AssetType.ERC1155
        ) revert UnsupportedCollateralForParallelSale(offer.collateralAssetType);
        if (offer.assetType != LibVaipakam.AssetType.ERC20) {
            revert UnsupportedPrincipalForParallelSale(offer.assetType);
        }

        // ── Config-gate ───────────────────────────────────────────
        if (s.cfgPrepayListingBufferBps == 0) revert PrepayListingBufferNotConfigured();
        if (s.collateralListingExecutor == address(0)) revert AutoListExecutorNotSet();
        if (conduitKey == bytes32(0)) revert AutoListConduitNotConfigured();

        // ── Fee-leg cap ───────────────────────────────────────────
        if (feeLegs.length > MAX_FEE_LEGS) {
            revert FeeLegsExceedCap(feeLegs.length, MAX_FEE_LEGS);
        }

        // ── Vault must be deployed ────────────────────────────────
        if (s.userVaipakamVaults[offer.creator] == address(0)) {
            revert VaultNotDeployed(offer.creator);
        }

        // ── Pre-loan floor computation (§19.3 round-3.4 — reuses
        //    LibEntitlement.proRataInterest per the
        //    feedback_check_existing_primitives_before_coding rule)
        uint256 hedgeDays = offer.durationDays >= 1 ? 1 : offer.durationDays;
        uint256 floor = (
            (offer.amount + LibEntitlement.proRataInterest(
                offer.amount, offer.interestRateBps, hedgeDays
            )) * (10_000 + s.cfgPrepayListingBufferBps)
        ) / 10_000;
        uint256 feeSum = 0;
        for (uint256 i = 0; i < feeLegs.length; ) {
            feeSum += uint256(feeLegs[i].startAmount);
            unchecked { ++i; }
        }
        uint256 minAsk = floor + feeSum;
        if (askPrice < minAsk) revert AskBelowPreLoanFloor(offerId, askPrice, minAsk);
    }

    /// @dev Build the canonical OfferContext + hash, write the 3
    ///      mirror slots, call the executor's `recordOfferOrder`, and
    ///      bind the orderHash on the vault. Returns the canonical
    ///      orderHash.
    function _recordAndWireOfferOrder(
        LibVaipakam.Offer storage offer,
        uint96 offerId,
        uint256 askPrice,
        bytes32 conduitKey,
        FeeLeg[] calldata feeLegs,
        _PostLocals memory loc
    ) private returns (bytes32 orderHash) {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();

        OfferContext memory ctx = OfferContext({
            offerId: offerId,
            conduit: loc.conduit,
            conduitKey: conduitKey,
            salt: loc.salt,
            startTime: uint64(block.timestamp),
            askPrice: uint192(askPrice),
            endTime: loc.endTime,
            principalAsset: offer.lendingAsset,
            mode: PREPAY_MODE_PRE_LOAN_FIXED_PRICE,
            borrowerVault: loc.vaultAddr,
            borrowerWallet: offer.creator
        });

        orderHash = LibPrepayOrder.buildAndHashOfferMem(
            ctx,
            offer.collateralAsset,
            offer.collateralAssetType,
            offer.quantity,
            offer.collateralTokenId,
            address(this),
            loc.executor,
            IListingExecutorRecorder(loc.executor).seaport(),
            feeLegs
        );

        // ── Effects (3 mirror-slot writes per §19.5 + §19.7d) ─────
        offer.parallelSaleOrderHash = orderHash;
        s.offerPrepayListingOrderHash[offerId] = orderHash;
        s.offerPrepayListingExecutor[offerId] = loc.executor;

        // ── Interactions (executor + vault) ───────────────────────
        IListingExecutorRecorder(loc.executor).recordOfferOrder(orderHash, ctx, feeLegs);
        VaipakamVaultImplementation(loc.vaultAddr).registerListingOrderHash(
            orderHash,
            loc.executor
        );
    }
}
