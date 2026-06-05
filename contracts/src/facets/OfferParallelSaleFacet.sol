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
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
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
    /// @notice T-086 Round-8 (#358) Codex round-2 P1 #3 — raised when
    ///         `s.cfgPrepayListingEnabled` is false at post time.
    ///         Mirrors `NFTPrepayListingFacet.PrepayListingDisabled`.
    error PrepayListingDisabled();
    /// @notice T-086 Round-8 (#358) Codex round-3 P2 #3 — raised when
    ///         `askPrice > type(uint192).max`. Mirrors the loan-keyed
    ///         executor's `AskPriceOverflow` guard.
    error AskPriceOverflow(uint256 askPrice);
    /// @notice T-086 Round-8 (#358) Codex round-4 P1 #2 — raised when
    ///         `postParallelSaleListing` is called against an offer
    ///         that already had at least one partial fill via
    ///         `OfferMatchFacet.matchOffers`. The partial-fill model
    ///         creates multiple loans against a single offer's
    ///         collateral, which the `s.offerIdToLoanId[offerId]`
    ///         single-loan lookup my split-on-fill path uses cannot
    ///         disambiguate. Catastrophic if allowed; explicitly
    ///         rejected here.
    error ParallelSalePartialFillConflict(uint96 offerId);
    /// @notice T-086 Round-8 (#358) Codex round-4 P1 #2 — raised when
    ///         `postParallelSaleListing` is called against an offer
    ///         whose `fillMode` is `Partial`. Same root cause as
    ///         {ParallelSalePartialFillConflict} but caught BEFORE
    ///         any partial fill has happened so the borrower can
    ///         switch to `Aon` (all-or-nothing) or `Ioc` (immediate-
    ///         or-cancel) on a fresh offer if they want parallel-sale.
    error ParallelSaleRequiresSingleFill(uint96 offerId);
    /// @notice Codex round-6 P2 #3 — raised when a fee leg's
    ///         recipient is address(0). Would route fees to the burn
    ///         address otherwise.
    error FeeLegZeroRecipient(uint256 index);
    /// @notice Codex round-6 P2 #3 — raised when a fee leg's
    ///         startAmount is zero. Mirrors the loan-keyed
    ///         FeeLegZeroAmount enforcement (which fires at fill time;
    ///         this fires at create time so the borrower fails fast).
    error FeeLegZeroAmountAtCreate(uint256 index);
    /// @notice Codex round-6 P2 #3 — raised when a fee leg's
    ///         startAmount != endAmount. v1 is fixed-price only per
    ///         §19.11; Dutch decay is §19.11 out-of-scope.
    error FeeLegNotFixedPrice(uint256 index);
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

        // Codex round-9 P2 #2 + round-10 P2 — authorize EXACTLY ONE
        // party based on the offer's state:
        //   - Pre-acceptance: only the offer's original creator. No
        //     loan exists yet; creator is the only party with standing.
        //   - Post-acceptance: ONLY the CURRENT borrower-position NFT
        //     holder. The original creator no longer owns the economic
        //     position (transferable NFT); leaving them authorized
        //     would let them clear a listing the current holder
        //     cannot recreate.
        // Mirrors the loan-keyed prepay-listing's cancel-authority
        // posture exactly (no dual-auth window).
        bool callerAuthorized;
        if (!offer.accepted) {
            callerAuthorized = (offer.creator == msg.sender);
        } else {
            uint256 loanId = s.offerIdToLoanId[uint256(offerId)];
            if (loanId != 0) {
                uint256 borrowerTokenId = s.loans[loanId].borrowerTokenId;
                if (borrowerTokenId != 0) {
                    try
                        IERC721(address(this)).ownerOf(borrowerTokenId)
                    returns (address currentHolder) {
                        callerAuthorized = (currentHolder == msg.sender);
                    } catch {
                        // NFT burned at a prior terminal — fall through
                        // to the revert below.
                    }
                }
            }
        }
        if (!callerAuthorized) revert NotOfferCreator();

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

        // ── Partial-fill incompatibility gate (Codex round-4 P1 #2) ──
        //
        // When `partialFillEnabled` is on at the protocol level,
        // borrower offers can have multiple lender-side fills landing
        // sequentially via `OfferMatchFacet.matchOffers`. Each
        // partial fill creates a SEPARATE loan against a SLICE of the
        // offer's collateral; my `s.offerIdToLoanId[offerId]` lookup
        // can only track one loanId. A later parallel-sale fill on
        // such a partially-filled offer would either:
        //   (a) hit the `Scenario A` branch (accepted == false) and
        //       credit the FULL proceeds to the borrower, leaving the
        //       partial loans completely unsettled while the
        //       collateral leaves the vault to the Seaport buyer, OR
        //   (b) hit the `Scenario B` branch picking up the FIRST loan
        //       only and silently abandoning the subsequent ones.
        // Both outcomes are catastrophic (lender funds stranded,
        // collateral stolen). Reject parallel-sale entirely for any
        // offer that already had a partial fill OR is marked as a
        // partial-fill-mode offer (so future fills don't trigger the
        // bug). Borrower can `releaseParallelSaleLock` + post a fresh
        // single-fill-mode offer if they want both features.
        if (offer.amountFilled > 0) {
            revert ParallelSalePartialFillConflict(offerId);
        }
        // Codex round-5 P1 #1 — IOC offers also leave `accepted == false`
        // after OfferMatchFacet.matchOffers increments fill counters
        // (only Aon gives clean single-fill semantics through the
        // matcher). Reject IOC too — only `Aon` is compatible with
        // parallel-sale's single-loan assumption.
        if (offer.fillMode != LibVaipakam.FillMode.Aon) {
            revert ParallelSaleRequiresSingleFill(offerId);
        }

        // ── Config-gate ───────────────────────────────────────────
        // Codex round-2 P1 #3 — honor the master kill-switch that
        // governance flips during incidents / on chains where the
        // prepay-listing feature isn't open. Every loan-keyed post
        // path (NFTPrepayListingFacet / Dutch / Atomic / AutoList)
        // already gates on this; the no-loan branch must too.
        if (!s.cfgPrepayListingEnabled) revert PrepayListingDisabled();
        if (s.cfgPrepayListingBufferBps == 0) revert PrepayListingBufferNotConfigured();
        if (s.collateralListingExecutor == address(0)) revert AutoListExecutorNotSet();
        if (conduitKey == bytes32(0)) revert AutoListConduitNotConfigured();

        // ── Fee-leg cap + per-leg shape (Codex round-6 P2 #3) ─────
        //
        // Mirrors the loan-keyed fixed-price listing path's per-leg
        // checks. Without this, a borrower could record an order with
        // a zero-recipient or zero-amount fee leg — Seaport / the
        // executor's content gate would later reject the fill, OR a
        // zero-recipient leg would route fees to address(0). v1 is
        // fixed-price-only (§19.11), so startAmount must equal
        // endAmount.
        if (feeLegs.length > MAX_FEE_LEGS) {
            revert FeeLegsExceedCap(feeLegs.length, MAX_FEE_LEGS);
        }
        for (uint256 i = 0; i < feeLegs.length; ) {
            if (feeLegs[i].recipient == address(0)) {
                revert FeeLegZeroRecipient(i);
            }
            if (feeLegs[i].startAmount == 0) {
                revert FeeLegZeroAmountAtCreate(i);
            }
            if (feeLegs[i].startAmount != feeLegs[i].endAmount) {
                revert FeeLegNotFixedPrice(i);
            }
            unchecked { ++i; }
        }

        // ── Ask-price bounds check (Codex round-3 P2 #3) ──────────
        // `askPrice` is recorded in OfferContext as uint192 (3-slot
        // packing); any value above `type(uint192).max` would silently
        // truncate on the explicit downcast and let the order sign
        // for far less than the displayed value. Mirrors the loan-
        // keyed executor's `AskPriceOverflow` guard.
        if (askPrice > type(uint192).max) {
            revert AskPriceOverflow(askPrice);
        }

        // ── Vault must be deployed ────────────────────────────────
        if (s.userVaipakamVaults[offer.creator] == address(0)) {
            revert VaultNotDeployed(offer.creator);
        }

        // ── Pre-loan floor computation (§19.3, Codex round-3 + 4 +
        //    user-direction) ────────────────────────────────────────
        //
        // The pre-loan floor hedges the FULL DURATION's interest +
        // explicit treasury fee. This makes the pre-loan and active-
        // loan floors converge: a buyer fill post-acceptance always
        // covers the lender's settlement entitlement (which routes
        // through `LibEntitlement.settlementInterest` — full coupon
        // for `useFullTermInterest=true` loans, pro-rata max for
        // `useFullTermInterest=false` loans, both bounded by
        // `proRataInterest(amount, rateBps, durationDays)`).
        //
        // **Why 365-day cap is the structural reality**: existing
        // T-034 validation in `_validateCadence` rejects any loan with
        // an illiquid leg (NFT collateral, NFT principal, illiquid
        // ERC20 either side) AND `durationDays > 365` — because Filter
        // 0 forces `cadence == None` for illiquid AND Filter 2 forces
        // `cadence != None` for multi-year. The protocol structurally
        // caps NFT-collateral loans (the parallel-sale collateral
        // class) at 365 days. The 365-day cap here matches that
        // ceiling exactly. Defensive guard for the structurally-
        // impossible case rather than load-bearing.
        //
        // **Why explicit treasury addend (Codex round-4 P2 #2)**: the
        // protocol's `cfgTreasuryFeeBps` is governance-configurable
        // beyond the typical 1% default; relying on `buffer` to absorb
        // it would let a high-fee governance config push the floor
        // below `lenderLeg + treasuryLeg` at fill time. Compute the
        // treasury share explicitly on the hedged interest so the
        // floor always covers it.
        // Codex round-6 P2 #1 — keep-listing-live + the post-grace
        // block (round-5 P1 #2) means fills can still happen up to
        // `graceEnd = startTime + durationDays*1d + gracePeriod(durationDays)`.
        // For pro-rata loans, `accruedInterestToTime` at graceEnd
        // equals proRataInterest over `(durationDays + graceDays)`,
        // which exceeds my prior `durationDays`-only hedge. Hedge the
        // worst-case grace-window interest too. Cap at the same
        // structural max (NFT loans are 365 days max via T-034 cadence
        // rules; grace adds typically a few weeks; total stays well
        // bounded).
        uint256 graceDays = LibVaipakam.gracePeriod(offer.durationDays) / 1 days;
        uint256 hedgeDays = offer.durationDays + graceDays;
        // Codex round-5 P2 #2 — borrower offers can be accepted (and
        // matched) at a rate up to `offer.interestRateBpsMax`, NOT
        // just `offer.interestRateBps`. The pre-loan floor MUST hedge
        // for the WORST-case rate the lender could lock in, so a
        // borrower can't list at a price valid only for the minimum
        // rate and have a higher-rate accept then settle the loan
        // under-collateralized. `interestRateBpsMax == 0` falls back
        // to `interestRateBps` (the offer didn't set a range — single-
        // rate offer; floor formula unchanged from the pre-fix
        // single-rate case).
        uint256 worstCaseRateBps = offer.interestRateBpsMax == 0
            ? offer.interestRateBps
            : offer.interestRateBpsMax;
        uint256 interest = LibEntitlement.proRataInterest(
            offer.amount, worstCaseRateBps, hedgeDays
        );
        uint256 treasuryCutOnInterest =
            (interest * LibVaipakam.cfgTreasuryFeeBps()) / 10_000;
        uint256 floor = (
            (offer.amount + interest + treasuryCutOnInterest)
                * (10_000 + s.cfgPrepayListingBufferBps)
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
            borrowerWallet: offer.creator,
            // T-086 Round-8 Step 7 — collateral content pinned at
            // post-time. The parallel-sale lock guarantees these
            // fields can't drift while the order is live, so the
            // executor's fill-time content check reads them directly
            // from the recorded OfferContext.
            //
            // Codex round-2 P1 #2 — for borrower offers with ERC1155
            // collateral the stake count lives in
            // `offer.collateralQuantity`, NOT `offer.quantity`
            // (`offer.quantity` is the PRINCIPAL-side quantity, normally
            // zero for ERC20-principal/NFT-collateral offers). The
            // round-1 fix corrected the argument-order swap but left
            // `offer.quantity` in place; this round-2 fix routes
            // through `offer.collateralQuantity` for both the
            // OfferContext pin AND the `buildAndHashOfferMem` call
            // below. For ERC721 the field's default of 1 still works
            // because `LibPrepayOrder._componentsOfferAtMemory`
            // ignores quantity in the ERC721 branch (hard-coded to 1).
            collateralAsset: offer.collateralAsset,
            collateralAssetType: uint8(offer.collateralAssetType),
            collateralTokenId: offer.collateralTokenId,
            collateralQuantity: offer.collateralQuantity
        });

        // Codex P1 round-1 #1 + Codex round-2 P1 #2 — argument order
        // MUST be (collateralTokenId, collateralQuantity), AND the
        // quantity field MUST be `offer.collateralQuantity` (NOT
        // `offer.quantity` — that's the principal-side qty).
        orderHash = LibPrepayOrder.buildAndHashOfferMem(
            ctx,
            offer.collateralAsset,
            offer.collateralAssetType,
            offer.collateralTokenId,
            offer.collateralQuantity,
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

        // Codex P1 round-1 #2 — grant the Seaport conduit permission
        // to move the collateral NFT on fill. Without this approval,
        // Seaport's fulfill reverts even after the executor's content
        // checks + ERC-1271 signature check pass. ERC721 takes a
        // per-token approval; ERC1155 has no per-token approval surface
        // so an operator-wide setApprovalForAll is used (same pattern
        // the loan-keyed `LibPrepayListingWiring.wire` path applies).
        // The teardown paths (`LibPrepayCleanup.clearOfferListing` +
        // `releaseParallelSaleLock`) DON'T need to revoke for ERC1155
        // because the orderHash invalidation via `revokeListingOrderHash`
        // is the authoritative safety primitive (see
        // VaipakamVaultImplementation.setCollateralOperatorApprovalERC1155
        // natspec). For ERC721 we leave the per-token approval in place
        // until cancel — the orderHash invalidation makes a stale fill
        // impossible regardless of approval state.
        if (offer.collateralAssetType == LibVaipakam.AssetType.ERC721) {
            VaipakamVaultImplementation(loc.vaultAddr).setCollateralOperatorApproval(
                offer.collateralAsset,
                offer.collateralTokenId,
                loc.conduit,
                true
            );
        } else {
            VaipakamVaultImplementation(loc.vaultAddr).setCollateralOperatorApprovalERC1155(
                offer.collateralAsset,
                loc.conduit,
                true
            );
        }
    }
}
