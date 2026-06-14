// src/facets/LoanFacet.sol
// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {LibVaipakam} from "../libraries/LibVaipakam.sol";
import {LibEncumbrance} from "../libraries/LibEncumbrance.sol";
import {LibLifecycle} from "../libraries/LibLifecycle.sol";
import {LibMetricsHooks} from "../libraries/LibMetricsHooks.sol";
import {LibFacet} from "../libraries/LibFacet.sol";
import {LibInteractionRewards} from "../libraries/LibInteractionRewards.sol";
import {LibVPFIDiscount} from "../libraries/LibVPFIDiscount.sol";
import {LibNotificationFee} from "../libraries/LibNotificationFee.sol";
import {LibAccessControl, DiamondAccessControl} from "../libraries/LibAccessControl.sol";
import {DiamondPausable} from "../libraries/LibPausable.sol";
import {IVaipakamErrors} from "../interfaces/IVaipakamErrors.sol";
import {RiskFacet} from "./RiskFacet.sol";
import {VaipakamNFTFacet} from "./VaipakamNFTFacet.sol";
import {OracleFacet} from "./OracleFacet.sol";


/**
 * @title LoanFacet
 * @author Vaipakam Developer Team
 * @notice Loan initiation and read-side queries for the Vaipakam P2P lending
 *         platform.
 * @dev Part of the Diamond Standard (EIP-2535). Reached only as a cross-facet
 *      call from {OfferFacet.acceptOffer} (enforced via
 *      msg.sender == address(this); direct calls revert
 *      UnauthorizedCrossFacetCall).
 *
 *      Responsibilities on initiation:
 *        1. Re-verify liquidity of both lending and collateral assets on-chain
 *           (offer-stored values are not trusted).
 *        2. Require the combined abnormal-market + illiquid-assets
 *           fallback consent from both counterparties (creator-side latched on
 *           the offer, acceptor-side passed in at accept time); when either
 *           leg is illiquid and the combined consent is missing, revert
 *           NonLiquidAsset. Lender-sale vehicle offers bypass this and the
 *           LTV/HF gates below (they carry no real collateral).
 *        3. Enforce LTV ≤ assetRiskParams.loanInitMaxLtvBps and HF ≥ 1.5e18 for
 *           fully-liquid loans; skipped when the combined fallback consent is
 *           latched, since illiquid collateral is valued at $0 per README.
 *        4. For NFT-asset loans, compute prepaid rental amount and
 *           RENTAL_BUFFER_BPS buffer.
 *        5. Flip the offer creator's existing position NFT to LoanInitiated
 *           and mint the counterparty's NFT.
 *      Pausable (whenNotPaused).
 */
contract LoanFacet is DiamondPausable, DiamondAccessControl, IVaipakamErrors {
    /// @notice Emitted when a new loan is initiated.
    /// @param loanId           The unique ID of the loan.
    /// @param offerId          The associated offer ID.
    /// @param lender           The lender's address.
    /// @param borrower         The borrower's address.
    /// @param principal        Principal amount transferred in loan.principalAsset
    ///                         (wei of the ERC-20, or tokenId count for NFT rentals).
    /// @param collateralAmount Collateral locked in loan.collateralAsset. For
    ///                         NFT collateral this is 1 (ERC-721) or the ERC-1155
    ///                         quantity. Zero only for lender-sale vehicles.
    /// @dev Indexers needing a full row build off the {LoanInitiatedDetails}
    ///      companion (same tx) — no follow-up `getLoanDetails` read needed.
    ///      The bare event keeps its narrow shape for legacy filter
    ///      consumers (etherscan / blockscout / partner subgraphs that
    ///      indexed the original 6-field topic-0 hash).
    /// @custom:event-category state-change/loan-mutation
    event LoanInitiated(
        uint256 indexed loanId,
        uint256 indexed offerId,
        address indexed lender,
        address borrower,
        uint256 principal,
        uint256 collateralAmount
    );

    /// @notice Companion-event payload struct for {LoanInitiatedDetails}.
    /// @dev    Wrapped as a single tuple to dodge the viaIR
    ///         stack-too-deep that triggers when ~20 inline event args
    ///         expand at the emit site. ABI consumers see this as a
    ///         flat tuple after the three indexed topics.
    struct LoanInitDetails {
        address principalAsset;
        uint256 interestRateBps;
        uint256 durationDays;
        uint64 dueTimestamp;
        LibVaipakam.AssetType assetType;
        LibVaipakam.AssetType collateralAssetType;
        uint256 tokenId;
        uint256 quantity;
        address collateralAsset;
        uint256 collateralAmount;
        uint256 collateralTokenId;
        uint256 collateralQuantity;
        address prepayAsset;
        uint256 prepayAmount;
        uint256 bufferAmount;
        bool riskAndTermsConsentFromBoth;
        bool allowsPartialRepay;
        // T-086 step 4 — companion-event surface for the lender's
        // prepay-listing consent (snapshotted from Offer at loan-init).
        // See `Loan.allowsPrepayListing`.
        bool allowsPrepayListing;
        LibVaipakam.PeriodicInterestCadence periodicInterestCadence;
        address matcher;
        uint256 healthFactorAtInit;
        // Position-NFT ids minted at loan creation — the lender NFT and
        // the borrower NFT. Carried here so cache-merge consumers can
        // build the loanId → (lender NFT, borrower NFT) mapping straight
        // from the event, without a `getLoanDetails` read-back. The
        // current NFT holder is then tracked via ERC-721 Transfer.
        uint256 lenderTokenId;
        uint256 borrowerTokenId;
    }

    /// @notice Companion to {LoanInitiated} — full self-sufficient
    ///         payload of the new loan. Cache-merge consumers (frontend
    ///         IndexedDB, watcher D1, subgraph) construct the entire
    ///         loan row from this event without a follow-up
    ///         `getLoanDetails` view-call.
    /// @dev    EventSourcingAudit §3.6 — `startTimestamp` is DROPPED
    ///         per §1.4 (block.timestamp lives in the log envelope).
    ///         Indexed `loanId` / `lender` / `borrower` per the audit's
    ///         per-counterparty filter recommendation.
    /// @param details See {LoanInitDetails} for field-by-field semantics.
    /// @custom:event-category state-change/loan-mutation
    event LoanInitiatedDetails(
        uint256 indexed loanId,
        address indexed lender,
        address indexed borrower,
        LoanInitDetails details
    );

    // Facet-specific errors (shared errors inherited from IVaipakamErrors)
    error InvalidOffer();
    error MixedCollateralNotAllowed();

    /**
     * @notice Initiates a loan after offer acceptance.
     * @dev Reachable only via the Diamond's own fallback
     *      (msg.sender == address(this)); a direct call from any external
     *      actor reverts UnauthorizedCrossFacetCall. Writes the full Loan
     *      struct, transitions lifecycle state to Active via LibLifecycle,
     *      runs LTV/HF gates when applicable, flips the offer creator's
     *      position NFT to LoanInitiated, mints a second NFT for the
     *      acceptor, and emits LoanInitiated.
     *
     *      Reverts (non-exhaustive):
     *        - InvalidOffer — offer already accepted, missing, or
     *          lender-sale vehicle whose underlying loan is no longer Active.
     *        - NonLiquidAsset — either leg illiquid without the combined
     *          abnormal-market + illiquid-assets fallback consent from
     *          both counterparties.
     *        - LTVExceeded — LTV above assetRiskParams.loanInitMaxLtvBps.
     *        - HealthFactorTooLow — HF < 1.5e18.
     *        - LTVCalculationFailed / HealthFactorCalculationFailed — risk
     *          staticcall reverted.
     *        - NFTStatusUpdateFailed / NFTMintFailed — NFT cross-facet call
     *          failed.
     * @param offerId The accepted offer ID.
     * @param acceptor The acceptor address (borrower or lender depending on offerType).
     * @param acceptorRiskAndTermsConsent Acceptor's mandatory consent to the
     *        combined abnormal-market + illiquid-assets fallback terms
     *        (docs/WebsiteReadme.md §"Offer and acceptance risk warnings",
     *        README.md §"Liquidity & Asset Classification"). Required on
     *        every accept regardless of leg liquidity; AND-combined with
     *        offer.creatorRiskAndTermsConsent and latched into the resulting
     *        loan as {Loan.riskAndTermsConsentFromBoth}, which gates the
     *        illiquid-path and the default fallback behavior.
     * @return loanId The new loan ID.
     */
    function initiateLoan(
        uint256 offerId,
        address acceptor,
        bool acceptorRiskAndTermsConsent
    ) external whenNotPaused returns (uint256 loanId) {
        if (msg.sender != address(this))
            revert UnauthorizedCrossFacetCall(); // Only via Diamond

        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        LibVaipakam.Offer storage offer = s.offers[offerId];
        if (offer.id == 0 || offer.accepted) revert InvalidOffer();

        // Detect if this offer is a lender-sale vehicle (created by
        // createLoanSaleOffer).  The temporary loan it creates is not a real
        // borrower position — it has zero collateral and exists only to
        // transfer the lender relationship.  Skip liquidity, mixed-collateral,
        // and LTV/HF checks for these.
        bool isLenderSaleVehicle = s.saleOfferToLoanId[offerId] != 0;

        // If this is a lender-sale vehicle, the underlying live loan must still
        // be Active.  Otherwise the principal transfer in acceptOffer would send
        // funds to liam for a loan that is already repaid/defaulted, and
        // completeLoanSale would revert — leaving Noah with no lender rights.
        if (isLenderSaleVehicle) {
            uint256 linkedLoanId = s.saleOfferToLoanId[offerId];
            if (s.loans[linkedLoanId].status != LibVaipakam.LoanStatus.Active) {
                revert InvalidOffer();
            }
        }

        LibVaipakam.LiquidityStatus lendingAssetLiquidity = OracleFacet(
            address(this)
        ).checkLiquidity(offer.lendingAsset);
        LibVaipakam.LiquidityStatus collateralLiquidity = OracleFacet(
            address(this)
        ).checkLiquidity(offer.collateralAsset);

        if (!isLenderSaleVehicle) {
            // Liquidation-fallback terms consent is mandatory on every loan
            // (liquid and illiquid). Required from both parties; OfferFacet
            // also enforces this at create + accept time, re-checked here as
            // a defensive latch before the loan struct is written.
            if (!(offer.creatorRiskAndTermsConsent && acceptorRiskAndTermsConsent)) {
                revert RiskAndTermsConsentRequired();
            }
        }

        unchecked {
            loanId = ++s.nextLoanId;
        }
        s.offerIdToLoanId[offerId] = loanId;

        // Pack call-site parameters into a struct so the downstream helper
        // takes one arg instead of six — keeps stack pressure manageable
        // under `forge coverage --ir-minimum` (optimizer off).
        _finalizeLoanCreation(InitCtx({
            loanId: loanId,
            offerId: offerId,
            acceptor: acceptor,
            acceptorRiskAndTermsConsent: acceptorRiskAndTermsConsent,
            lendingAssetLiquidity: lendingAssetLiquidity,
            collateralLiquidity: collateralLiquidity,
            isLenderSaleVehicle: isLenderSaleVehicle
        }));

        // Phase-2 reward accrual hook (docs/TokenomicsTechSpec.md §4).
        // Skip for lender-sale vehicles — they are bookkeeping loans
        // forged by the early-withdrawal flow to transfer a lender
        // position, not real interest-bearing exposure. The real loan's
        // existing reward entries (registered at its original init) are
        // updated by EarlyWithdrawalFacet via {transferLenderEntry}.
        if (!isLenderSaleVehicle) {
            LibVaipakam.Loan storage loanRef = s.loans[loanId];
            LibInteractionRewards.registerLoan(
                loanId,
                loanRef.lender,
                loanRef.borrower,
                loanRef.principalAsset,
                loanRef.principal,
                loanRef.interestRateBps,
                loanRef.durationDays
            );
        }

        emit LoanInitiated(
            loanId,
            offerId,
            s.loans[loanId].lender,
            s.loans[loanId].borrower,
            s.loans[loanId].principal,
            s.loans[loanId].collateralAmount
        );

        // §3.6 — companion event with the full loan row. Best-effort HF
        // computation via staticcall (mirrors AddCollateralFacet's
        // pattern); reverts cleanly to 0 for illiquid loans without
        // failing the init.
        _emitLoanInitiatedDetails(loanId);

        // #407 (2026-06-12) — Vault encumbrance sub-ledger. Create
        // the collateral lien now that `loan.collateralAsset` /
        // `Amount` / `TokenId` / `Quantity` / `AssetType` are final.
        // The lien is the on-chain proof that "this exact collateral
        // backs this exact loan"; the aggregate
        // `s.encumbered[user][asset][tokenId]` it ticks under is
        // what the vault-withdraw guard reads to enforce
        // `freeBalance = balance − Σ liens`. Every loan-lifecycle
        // terminal (`RepayFacet.repayLoan`, `PrecloseFacet.precloseDirect`,
        // `DefaultedFacet.triggerDefault`, `RefinanceFacet._refinanceLoanLogic`,
        // `SwapToRepayFacet`, the internal-match settlement) releases,
        // decrements, or re-keys this lien so the aggregate stays
        // consistent across the loan's life. `ClaimFacet` does NOT touch
        // the lien — by the time a claim is paid the terminal upstream
        // has already released it, so the claim withdraw runs against a
        // freed aggregate (see EncumbranceLifecycleMap.md §4.5).
        // #569 D-1 — only ERC-20 LOANS are liened here; NFT rentals are
        // not (the gate lives in `LibEncumbrance.createCollateralLien`).
        //
        // See `docs/DesignsAndPlans/EncumbranceLifecycleMap.md` +
        // `PerLoanCollateralLien.md` §§2-6.
        //
        // #576 — a refinance-originated loan carries the OLD loan's
        // collateral in place (it was never deposited fresh — see
        // OfferCreateFacet's refinance skip). `RefinanceFacet` retags the
        // old lien to this loan via `rekeyCollateralLienOnRefinance`, so
        // creating a fresh lien here would double-lien the single carried
        // collateral (and tick the aggregate under the refinancer, whose
        // vault holds nothing). Skip it; the retag keys the lien.
        if (offer.refinanceTargetLoanId == 0) {
            LibEncumbrance.createCollateralLien(loanId, s.loans[loanId]);
        }

        // T-092 — auto-opt-in convenience: if the borrower has the
        // per-user flag set, populate this loan's refinance caps from
        // their stored defaults so they don't need to set per-loan
        // caps explicitly on every new loan. See AutoLifecycleFacet
        // for the consent surface + Phase 2 keeper-driven refinance
        // wiring.
        //
        // T-092-B (#531) — GATE on liquid collateral. The auto-opt-in
        // is silently SKIPPED when the loan's collateral is illiquid
        // (`collateralLiquidity != Liquid`) — i.e., NFT collateral
        // (no oracle), illiquid ERC20 (no Chainlink feed / no AMM
        // depth), or temporary outage (sequencer down). Reason: the
        // default-path outcome on those loans is asymmetric. Liquid
        // collateral → DefaultedFacet swaps, borrower keeps surplus.
        // Illiquid / NFT collateral → DefaultedFacet transfers the
        // whole asset to the lender, borrower loses 100%. A novice
        // borrower who toggles `setAutoOptInOnNewLoan(true)` for
        // their everyday liquid loans must NOT be silently enrolled
        // on this 100%-loss tail risk. Sophisticated borrowers can
        // still call `setAutoRefinanceCaps(loanId, ...)` explicitly
        // — that path is unchanged.
        LibVaipakam.Loan storage initiatedLoan = s.loans[loanId];
        if (
            s.autoOptInOnNewLoan[initiatedLoan.borrower] &&
            collateralLiquidity == LibVaipakam.LiquidityStatus.Liquid
        ) {
            LibVaipakam.AutoRefinanceCaps memory defs =
                s.defaultAutoRefinanceCaps[initiatedLoan.borrower];
            // Codex round-2 P3 — skip copying when the default-template
            // expiry is already in the past. Otherwise an old enabled
            // default with a stale expiry would land on every new loan
            // as enabled, and the Phase 2 keeper enforcement could
            // ignore it only after a separate freshness check. Filter
            // at copy time so the per-loan slot stays meaningful.
            if (defs.enabled && defs.maxNewExpiry > block.timestamp) {
                // Stamp setter to the borrower so the per-loan
                // staleness fence works even when these caps land via
                // the convenience-flag copy (rather than a direct
                // setAutoRefinanceCaps call).
                defs.setter = initiatedLoan.borrower;
                s.autoRefinanceCaps[loanId] = defs;
            }
        }
    }

    /// @dev Emits the {LoanInitiatedDetails} companion. Factored out of
    ///      `initiateLoan` to keep the calling frame's stack-depth
    ///      manageable. The 22-field payload travels as a single
    ///      memory-allocated struct, populated field-by-field — the
    ///      `LoanInitDetails({...})` constructor form pushes every
    ///      field onto the stack simultaneously and trips viaIR's
    ///      stack-too-deep at this depth.
    function _emitLoanInitiatedDetails(uint256 loanId) internal {
        LibVaipakam.Loan storage loan = LibVaipakam.storageSlot().loans[loanId];

        LoanInitDetails memory d;
        d.principalAsset = loan.principalAsset;
        d.interestRateBps = loan.interestRateBps;
        d.durationDays = loan.durationDays;
        d.dueTimestamp = uint64(loan.startTime + loan.durationDays * 1 days);
        d.assetType = loan.assetType;
        d.collateralAssetType = loan.collateralAssetType;
        d.tokenId = loan.tokenId;
        d.quantity = loan.quantity;
        d.collateralAsset = loan.collateralAsset;
        d.collateralAmount = loan.collateralAmount;
        d.collateralTokenId = loan.collateralTokenId;
        d.collateralQuantity = loan.collateralQuantity;
        d.prepayAsset = loan.prepayAsset;
        d.prepayAmount = loan.prepayAmount;
        d.bufferAmount = loan.bufferAmount;
        d.riskAndTermsConsentFromBoth = loan.riskAndTermsConsentFromBoth;
        d.allowsPartialRepay = loan.allowsPartialRepay;
        // T-086 step 4 — surface the lender's prepay-listing consent
        // (snapshotted from Offer) on the companion event so cache-merge
        // consumers don't need a follow-up `getLoanDetails` view-call.
        d.allowsPrepayListing = loan.allowsPrepayListing;
        d.periodicInterestCadence = loan.periodicInterestCadence;
        d.matcher = loan.matcher;
        // Position-NFT ids — set by `_finalizeLoanCreation` (which runs
        // before this emit): the creator's NFT was flipped to
        // LoanInitiated, the acceptor's NFT freshly minted, both ids
        // written onto the loan struct.
        d.lenderTokenId = loan.lenderTokenId;
        d.borrowerTokenId = loan.borrowerTokenId;

        // Best-effort HF — staticcall returns 0 on illiquid (no oracle).
        (bool ok, bytes memory ret) = address(this).staticcall(
            abi.encodeWithSelector(RiskFacet.calculateHealthFactor.selector, loanId)
        );
        if (ok && ret.length > 0) {
            d.healthFactorAtInit = abi.decode(ret, (uint256));
        }

        emit LoanInitiatedDetails(loanId, loan.lender, loan.borrower, d);
    }

    struct InitCtx {
        uint256 loanId;
        uint256 offerId;
        address acceptor;
        bool acceptorRiskAndTermsConsent;
        LibVaipakam.LiquidityStatus lendingAssetLiquidity;
        LibVaipakam.LiquidityStatus collateralLiquidity;
        bool isLenderSaleVehicle;
    }

    /**
     * @dev Writes the loan struct, runs LTV/HF gates, updates the creator's
     *      position NFT, mints the acceptor's NFT, and stores both token IDs.
     *      Extracted from `initiateLoan` to split local-variable stack usage
     *      across two frames — required for `forge coverage --ir-minimum`.
     */
    function _finalizeLoanCreation(InitCtx memory ctx) private {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        _copyOfferIntoLoan(
            s.loans[ctx.loanId],
            s.offers[ctx.offerId],
            ctx.loanId,
            ctx.offerId,
            ctx.acceptor,
            ctx.acceptorRiskAndTermsConsent,
            ctx.lendingAssetLiquidity,
            ctx.collateralLiquidity
        );

        // Reverse-index the loan for both counterparties. Indexers and
        // frontends rely on these arrays to enumerate a user's loans
        // without scanning events (Alchemy free-tier caps scans at 10
        // blocks; reverse indexes remove any RPC-side dependency).
        LibVaipakam.Loan storage loan = s.loans[ctx.loanId];
        s.userLoanIds[loan.lender].push(ctx.loanId);
        s.userLoanIds[loan.borrower].push(ctx.loanId);

        _applyRentalPrepayIfNft(ctx.loanId, ctx.offerId);
        _maybeRunInitialRiskGates(ctx);
        _mintCounterpartyPosition(ctx);

        // Register the fully-populated loan in the MetricsFacet O(1)
        // analytics layer — bumps active/total/rate counters, pushes to
        // activeLoanIdsList, marks unique users, and records per-
        // collection NFT-leg counts + position-NFT reverse mapping. Must
        // run after _mintCounterpartyPosition so both lender and
        // borrower position tokenIds are already stamped on the loan.
        LibMetricsHooks.onLoanInitialized(loan);
    }

    /**
     * @dev NFT-rental prepayment accounting. Split out of
     *      `_finalizeLoanCreation` to keep that frame small enough for
     *      --ir-minimum (optimizer off during `forge coverage`).
     */
    function _applyRentalPrepayIfNft(uint256 loanId, uint256 offerId) private {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        LibVaipakam.Offer storage offer = s.offers[offerId];
        if (offer.assetType == LibVaipakam.AssetType.ERC20) return;
        LibVaipakam.Loan storage loan = s.loans[loanId];
        uint256 prepayAmount = offer.amount * offer.durationDays;
        uint256 buffer = (prepayAmount * LibVaipakam.cfgRentalBufferBps()) /
            LibVaipakam.BASIS_POINTS;
        loan.prepayAmount = prepayAmount;
        loan.bufferAmount = buffer;
        loan.lastDeductTime = block.timestamp;
    }

    /**
     * @dev LTV/HF gating skipped for lender-sale vehicles and for loans where
     *      both parties consented to illiquid collateral terms. Split out so
     *      the caller's stack frame doesn't carry these locals.
     */
    function _maybeRunInitialRiskGates(InitCtx memory ctx) private view {
        if (ctx.isLenderSaleVehicle) return;
        LibVaipakam.Offer storage offer = LibVaipakam.storageSlot().offers[ctx.offerId];
        bool bothLiquid = ctx.lendingAssetLiquidity == LibVaipakam.LiquidityStatus.Liquid &&
            ctx.collateralLiquidity == LibVaipakam.LiquidityStatus.Liquid;
        bool mutualIlliquidConsent = ctx.acceptorRiskAndTermsConsent &&
            offer.creatorRiskAndTermsConsent;
        if (!bothLiquid && mutualIlliquidConsent) return;
        address collateralAsset = LibVaipakam
            .storageSlot()
            .loans[ctx.loanId]
            .collateralAsset;
        _checkInitialLtvAndHf(ctx.loanId, collateralAsset);
    }

    /**
     * @dev Flips the offer creator's position NFT to `LoanInitiated`, mints
     *      the acceptor's NFT, and records both token IDs on the loan.
     */
    function _mintCounterpartyPosition(InitCtx memory ctx) private {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        uint256 creatorTokenId = s.offers[ctx.offerId].positionTokenId;
        bool creatorIsLender = s.offers[ctx.offerId].offerType ==
            LibVaipakam.OfferType.Lender;

        LibFacet.crossFacetCall(
            abi.encodeWithSelector(
                VaipakamNFTFacet.updateNFTStatus.selector,
                creatorTokenId,
                ctx.loanId,
                LibVaipakam.LoanPositionStatus.LoanInitiated
            ),
            NFTStatusUpdateFailed.selector
        );

        uint256 acceptorTokenId;
        unchecked {
            acceptorTokenId = ++s.nextTokenId;
        }

        LibFacet.crossFacetCall(
            abi.encodeWithSelector(
                VaipakamNFTFacet.mintNFT.selector,
                ctx.acceptor,
                acceptorTokenId,
                ctx.offerId,
                ctx.loanId,
                !creatorIsLender,
                LibVaipakam.LoanPositionStatus.LoanInitiated
            ),
            NFTMintFailed.selector
        );

        LibVaipakam.Loan storage loan = s.loans[ctx.loanId];
        if (creatorIsLender) {
            loan.lenderTokenId = creatorTokenId;
            loan.borrowerTokenId = acceptorTokenId;
        } else {
            loan.lenderTokenId = acceptorTokenId;
            loan.borrowerTokenId = creatorTokenId;
        }
    }

    /**
     * @dev Runs the initial LTV and HF gates via cross-facet staticcalls.
     *      Kept as a dedicated frame to isolate ltv/maxLtv/hf locals.
     *
     *      Two regimes, switched by `depthTieredLtvEnabled` (Piece B —
     *      docs/DesignsAndPlans/MarketRateWidgetAndDepthTieredLTV.md §4.2):
     *
     *        • OFF (the default — and the state during the testnet bake):
     *          today's gate, unchanged — `LTV ≤ assetRiskParams.loanInitMaxLtvBps`
     *          and `HF ≥ 1.5e18`. Effectively ~53% LTV on an ~82%
     *          liq-threshold.
     *
     *        • ON: cap the init-LTV at `min(assetRiskParams.loanInitMaxLtvBps,
     *          tierMaxInitLtvBps[effectiveTier(collateral)])` — the
     *          depth-graded ceiling (50% / 60% / 65% for Tier 1/2/3;
     *          `0` for a Tier-0 / untierable collateral, which makes any
     *          positive LTV revert). The `HF ≥ 1.5e18` floor is relaxed
     *          to `HF ≥ 1e18` (not-born-already-liquidatable) because the
     *          tier cap is the binding safety constraint and — given the
     *          protocol invariant `loanInitMaxLtvBps ≤ liqThresholdBps` — it
     *          already implies a positive init buffer (`HF_init =
     *          liqThreshold / cap ≥ 1`). Per-asset `liqThresholdBps` (the
     *          liquidation trigger) is untouched in either regime.
     *
     *      `effectiveTier` = `OracleFacet.getEffectiveLiquidityTier`
     *      = `min(on-chain slippage tier, keeperTier)` — so a brand-new
     *      asset stays at today's `HF ≥ 1.5` baseline (Tier 1) until the
     *      off-chain confidence relay promotes it; a compromised keeper
     *      can only lower a tier, never raise it above the on-chain
     *      ceiling. The view never reverts (fail-closed to `0`).
     */
    function _checkInitialLtvAndHf(
        uint256 loanId,
        address collateralAsset
    ) private view {
        (bool ltvSuccess, bytes memory ltvResult) = address(this).staticcall(
            abi.encodeWithSelector(RiskFacet.calculateLTV.selector, loanId)
        );
        if (!ltvSuccess) revert LTVCalculationFailed();
        uint256 ltv = abi.decode(ltvResult, (uint256));
        uint256 loanInitMaxLtvBps = LibVaipakam
            .storageSlot()
            .assetRiskParams[collateralAsset]
            .loanInitMaxLtvBps;
        bool tieredOn = LibVaipakam.cfgDepthTieredLtvEnabled();

        if (tieredOn) {
            // Depth-graded ceiling: min(per-asset maxLtv, the tier cap for
            // the collateral's effective liquidity tier). effTier ∈ 0..3;
            // tier 0 ⇒ cap 0 ⇒ any positive LTV reverts (no borrow).
            uint8 effTier = abi.decode(
                LibFacet.crossFacetStaticCall(
                    abi.encodeWithSelector(
                        OracleFacet.getEffectiveLiquidityTier.selector,
                        collateralAsset
                    ),
                    LTVCalculationFailed.selector
                ),
                (uint8)
            );
            // Phase 5 of AutonomousLtvAndOracleFallback.md — read the
            // autonomous tier-LTV cache (peer-protocol-derived, bounded
            // per-tier, refreshable permissionlessly via
            // `OracleFacet.refreshTierLtvCache`) instead of the
            // governance-set `cfgTierMaxInitLtvBps`. When the cache is
            // hard-stale (> 14d since last refresh) or has never been
            // refreshed on this chain, `effectiveTierMaxInitLtvBps` falls
            // back to the per-tier library defaults — so the gate stays
            // operational even when nobody has called the refresh yet.
            //
            // The legacy `cfgTier1/2/3MaxInitLtvBps` governance setters
            // are intentionally still wired (their selectors stay on
            // the diamond + ConfigFacet); they're soft-deprecated and
            // can be removed in a follow-up sweep once the cache has
            // baked in production. Today they have no effect because
            // this read no longer consults them.
            uint256 tierCap = uint256(
                LibVaipakam.effectiveTierMaxInitLtvBps(effTier)
            );
            uint256 cap = loanInitMaxLtvBps < tierCap ? loanInitMaxLtvBps : tierCap;
            if (ltv > cap) revert InitLtvAboveTier(ltv, cap);
        } else if (ltv > loanInitMaxLtvBps) {
            revert LTVExceeded();
        }

        bytes memory hfResult = LibFacet.crossFacetStaticCall(
            abi.encodeWithSelector(
                RiskFacet.calculateHealthFactor.selector,
                loanId
            ),
            HealthFactorCalculationFailed.selector
        );
        uint256 hf = abi.decode(hfResult, (uint256));
        // Switch ON ⇒ HF ≥ 1.0 (not born already-liquidatable; the tier
        // cap is the binding buffer). Switch OFF ⇒ today's HF ≥ 1.5.
        uint256 hfFloor = tieredOn ? LibVaipakam.HF_LIQUIDATION_THRESHOLD : 150 * 1e16;
        if (hf < hfFloor) revert HealthFactorTooLow();
    }

    /**
     * @dev Copies the full set of offer fields into a new loan. Extracted
     *      from `initiateLoan` to contain local-variable stack pressure —
     *      `forge coverage --ir-minimum` runs without the optimizer, and the
     *      in-place copy overflowed available stack slots otherwise. Logic
     *      is identical to the prior inline sequence.
     */
    function _copyOfferIntoLoan(
        LibVaipakam.Loan storage loan,
        LibVaipakam.Offer storage offer,
        uint256 loanId,
        uint256 offerId,
        address acceptor,
        bool acceptorRiskAndTermsConsent,
        LibVaipakam.LiquidityStatus lendingAssetLiquidity,
        LibVaipakam.LiquidityStatus collateralLiquidity
    ) private {
        // Split across three frames so `--ir-minimum` (no optimizer) doesn't
        // pile every offer SLOAD onto a single stack frame.
        _copyFinancialFields(loan, offer, loanId, offerId);
        _copyAssetFields(
            loan,
            offer,
            acceptorRiskAndTermsConsent,
            lendingAssetLiquidity,
            collateralLiquidity
        );
        _copyPartyFields(loan, offer, acceptor);
        _snapshotLenderDiscount(loan);
        _snapshotBorrowerDiscount(loan);
        _latchOfferKeepersToLoan(loan.id, offerId, offer.creator);
    }

    /// @dev Copy the offer's per-keeper enable flags onto the new loan
    ///      (Phase 6). Iterates the offer creator's bounded approved-keepers
    ///      list (cap `MAX_APPROVED_KEEPERS` = 5) and latches any keeper
    ///      that was marked enabled on the offer into the loan's
    ///      `loanKeeperEnabled` mapping. Post-acceptance, each NFT holder
    ///      can edit their own loan-level enables via
    ///      `ProfileFacet.setLoanKeeperEnabled`. No-op for offers with no
    ///      keepers enabled — the whole function early-exits on an empty
    ///      creator whitelist.
    function _latchOfferKeepersToLoan(
        uint256 loanId,
        uint256 offerId,
        address creator
    ) private {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        address[] storage keepers = s.approvedKeepersList[creator];
        uint256 len = keepers.length;
        for (uint256 i; i < len; ) {
            address k = keepers[i];
            if (s.offerKeeperEnabled[offerId][k]) {
                s.loanKeeperEnabled[loanId][k] = true;
            }
            unchecked { ++i; }
        }
    }

    /// @dev Anchor the lender's time-weighted VPFI-discount window. Force-
    ///      rollup their accumulator at the current vault balance, then
    ///      freeze the post-rollup counter value onto the Loan — every
    ///      subsequent yield-fee settlement subtracts this anchor to get
    ///      the average discount over just this loan's lifetime.
    ///      Docs §5.2a.
    function _snapshotLenderDiscount(LibVaipakam.Loan storage loan) private {
        // T-087 Sub 1.B — rollup against the protocol-tracked stake
        // (NOT raw vault balance), per design §3 reuse row +
        // Codex round-7 P1 #7. The `lenderDiscountAccAtInit` slot
        // stays in place but is vestigial under the new design
        // (loan-window averaging replaced by instant EFFECTIVE_BPS
        // lookup at fee time — see {LibVPFIDiscount.lenderTimeWeightedDiscountBps}
        // for the rewire). Left at 0; deferring removal until storage-
        // layout cleanup in a later sub-card so loupe-readable layout
        // stays byte-identical for now.
        address lender = loan.lender;
        uint256 lenderBal = LibVPFIDiscount.trackedVpfiBalance(lender);
        LibVPFIDiscount.rollupUserDiscount(lender, lenderBal);
    }

    /// @dev Borrower mirror of {_snapshotLenderDiscount} (Phase 5 / §5.2b).
    ///      Anchors the time-weighted borrower LIF-discount window so the
    ///      proper-settlement helper in LibVPFIDiscount can compute the
    ///      average discount BPS over the loan's lifetime — defeating the
    ///      top-up-then-unstake gaming vector on the borrower side. Also
    ///      captures any pre-init accumulator state the borrower already
    ///      carries from prior loans (as lender or borrower), so the
    ///      window measured here is purely "from now on".
    function _snapshotBorrowerDiscount(LibVaipakam.Loan storage loan) private {
        // T-087 Sub 1.B — borrower mirror of {_snapshotLenderDiscount}.
        // Rollup against protocol-tracked stake, no loan-window anchor.
        address borrower = loan.borrower;
        uint256 borrowerBal = LibVPFIDiscount.trackedVpfiBalance(borrower);
        LibVPFIDiscount.rollupUserDiscount(borrower, borrowerBal);
    }

    function _copyFinancialFields(
        LibVaipakam.Loan storage loan,
        LibVaipakam.Offer storage offer,
        uint256 loanId,
        uint256 offerId
    ) private {
        loan.id = loanId;
        loan.offerId = offerId;
        // T-034 — startTime downsized from uint256 to uint64; explicit cast.
        // Safe through year 2554; every reader implicitly widens.
        loan.startTime = uint64(block.timestamp);
        loan.durationDays = offer.durationDays;
        // Range Orders Phase 1 — when matchOffers (PR3-B) is in flight,
        // the per-tx `matchOverride` slot carries the midpoint match
        // terms (amount / rate / collateral) and the matcher address.
        // Read from override; fall back to offer fields on the legacy
        // single-value path that doesn't set the override. matcher
        // also stamped here when active so the VPFI-path 1% LIF
        // kickback (deferred to terminal in
        // `LibVPFIDiscount.settleBorrowerLifProper` / `forfeitBorrowerLif`)
        // knows where to route on a matched-via-bot loan.
        LibVaipakam.MatchOverride storage mo =
            LibVaipakam.storageSlot().matchOverride;
        if (mo.active) {
            loan.principal = mo.amount;
            loan.interestRateBps = mo.rateBps;
            loan.collateralAmount = mo.collateralAmount;
            loan.matcher = mo.matcher;
        } else {
            // #183 (Canonical Limit-Order Phase 2) — role-aware reads
            // for direct-accept on ERC-20 lending offers. Lender offers
            // post their headline in `amountMax` (max provide) and
            // `interestRateBps` (their floor / DEX limit); borrower
            // offers post in `amount` (min need) and
            // `interestRateBpsMax` (their ceiling / DEX limit).
            // Direct-accept locks the loan at those values.
            //
            // **NFT rental exception** (PR #187 Codex P1) — NFT lender
            // offers (`assetType == ERC721/ERC1155`) carry `amount` as
            // the DAILY RENTAL FEE, not a principal headline. The
            // `_pullRentalPrepay` helper and `_applyRentalPrepayIfNft`
            // both compute `amount × durationDays` from `offer.amount`,
            // and rental accrual / deduction in RepayFacet runs off
            // `loan.principal`. Using `offer.amountMax` here would
            // corrupt rental accounting if a future create-offer path
            // ever set `amountMax != amount` for an NFT offer. NFT
            // rentals stay structurally single-value, so reading
            // `amount` for both fields keeps the role-aware mapping
            // safe for the ERC-20 case while preserving NFT semantics.
            // See docs/DesignsAndPlans/CanonicalLimitOrderPhase2Design.md
            // §3 for the ERC-20 convention.
            bool isERC20 = offer.assetType == LibVaipakam.AssetType.ERC20;
            bool isLender = offer.offerType == LibVaipakam.OfferType.Lender;
            loan.principal = isERC20
                ? (isLender ? offer.amountMax : offer.amount)
                : offer.amount;
            loan.interestRateBps = isERC20
                ? (isLender ? offer.interestRateBps : offer.interestRateBpsMax)
                : offer.interestRateBps;
            loan.collateralAmount = offer.collateralAmount;
            // matcher stamped by the legacy `_acceptOffer` post-init
            // hook (already in PR3-A).
        }
    }

    function _copyAssetFields(
        LibVaipakam.Loan storage loan,
        LibVaipakam.Offer storage offer,
        bool acceptorRiskAndTermsConsent,
        LibVaipakam.LiquidityStatus lendingAssetLiquidity,
        LibVaipakam.LiquidityStatus collateralLiquidity
    ) private {
        // Split further: each half stays below --ir-minimum's stack budget.
        _copyPrincipalAssetFields(
            loan,
            offer,
            lendingAssetLiquidity,
            collateralLiquidity
        );
        _copyCollateralAssetFields(loan, offer, acceptorRiskAndTermsConsent);
    }

    function _copyPrincipalAssetFields(
        LibVaipakam.Loan storage loan,
        LibVaipakam.Offer storage offer,
        LibVaipakam.LiquidityStatus lendingAssetLiquidity,
        LibVaipakam.LiquidityStatus collateralLiquidity
    ) private {
        loan.principalAsset = offer.lendingAsset;
        loan.collateralAsset = offer.collateralAsset;
        loan.tokenId = offer.tokenId;
        loan.quantity = offer.quantity;
        loan.assetType = offer.assetType;
        LibLifecycle.initialize(loan);
        loan.principalLiquidity = lendingAssetLiquidity;
        loan.collateralLiquidity = collateralLiquidity;
        loan.useFullTermInterest = offer.useFullTermInterest;
        loan.prepayAsset = offer.prepayAsset;
        // Snapshot the lender-opt-in flag for borrower-initiated partial
        // repayment. Carried verbatim from the offer; immutable for the
        // loan's lifetime regardless of any later offer-level change
        // (offers can't be edited post-create, but this matches the
        // snapshot-and-lock pattern used for fallback consent / split
        // bps elsewhere on this struct). Read by
        // {RepayFacet.repayPartial} as the sole gate on partial repay
        // authorisation; default false reverts the call with
        // {PartialRepayNotAllowed}.
        loan.allowsPartialRepay = offer.allowsPartialRepay;
        // T-086 step 4 — snapshot the lender's prepay-listing consent
        // onto the loan. Borrower's step-6 `postPrepayListing` reads
        // THIS field; offer-level changes can't affect a loan once
        // initialized. Default `false` = (step-6) facet hard-reverts
        // on `postPrepayListing` for the loan.
        loan.allowsPrepayListing = offer.allowsPrepayListing;
        // T-034 — snapshot the lender's chosen Periodic Interest Payment
        // cadence onto the loan. Offer-level validation in
        // `OfferFacet._validatePeriodicCadence` already gated illegal
        // values (Filters 0/1/2 + master kill-switch); we inherit
        // verbatim so the loan's terms are immutable for its lifetime.
        // `lastPeriodicInterestSettledAt` initialised to the loan's
        // start time so the first checkpoint lands exactly
        // `intervalDays(cadence)` later.
        loan.periodicInterestCadence = offer.periodicInterestCadence;
        loan.lastPeriodicInterestSettledAt = uint64(block.timestamp);
        // `interestPaidSinceLastPeriod` defaults to zero — Solidity
        // zero-initialises the field at struct-write time. Spelled out
        // here as a readable invariant.
        loan.interestPaidSinceLastPeriod = 0;
        // Snapshot the effective fallback-path split right now so any future
        // governance change via `ConfigFacet.setFallbackSplit` applies
        // prospectively — dual-consent at offer creation guarantees both
        // parties agreed to these specific splits.
        loan.fallbackLenderBonusBpsAtInit = uint16(LibVaipakam.cfgFallbackLenderBonusBps());
        loan.fallbackTreasuryBpsAtInit = uint16(LibVaipakam.cfgFallbackTreasuryBps());
        // Snapshot the effective per-tier LIQUIDATION threshold (PR2 of
        // internal-match work, 2026-05-14). Replaces the retired
        // per-asset `RiskParams.liqThresholdBps`. Read by
        // `RiskFacet.calculateHealthFactor` /
        // `isCollateralValueCollapsed` / `PartialWithdrawalFacet` for
        // the loan's entire lifetime. Snapshot semantics mirror the
        // fallback split above — any subsequent admin tune via
        // `ConfigFacet.setTierLiquidationLtvBps` applies prospectively
        // only. Illiquid collateral leaves the field at 0 (the HF
        // consumers revert `IlliquidLoanNoRiskMath` upstream so the
        // zero never reaches math). When the asset IS liquid but the
        // depth-tier classifier returns 0 (e.g. test envs where pool
        // depth isn't simulated), `cfgTierLiquidationLtvBps(0)`
        // already returns the conservative Tier-3 default — no
        // further fallback needed here.
        if (collateralLiquidity == LibVaipakam.LiquidityStatus.Liquid) {
            // Low-level staticcall + fallback so the snapshot stays
            // operational on test diamonds that don't cut
            // `getEffectiveLiquidityTier` into their oracle surface.
            // Failure ⇒ treat as tier 0 (unclassified); the
            // `cfgTierLiquidationLtvBps(0)` helper returns the
            // conservative Tier-3 default anyway.
            (bool ok, bytes memory ret) = address(this).staticcall(
                abi.encodeWithSelector(
                    OracleFacet.getEffectiveLiquidityTier.selector,
                    loan.collateralAsset
                )
            );
            uint8 effTier = ok ? abi.decode(ret, (uint8)) : 0;
            loan.liquidationLtvBpsAtInit = uint16(LibVaipakam.cfgTierLiquidationLtvBps(effTier));
        }
    }

    function _copyCollateralAssetFields(
        LibVaipakam.Loan storage loan,
        LibVaipakam.Offer storage offer,
        bool acceptorRiskAndTermsConsent
    ) private {
        loan.riskAndTermsConsentFromBoth =
            acceptorRiskAndTermsConsent && offer.creatorRiskAndTermsConsent;
        loan.collateralAssetType = offer.collateralAssetType;
        loan.collateralTokenId = offer.collateralTokenId;
        loan.collateralQuantity = offer.collateralQuantity;
        // Phase 6: no per-side keeper bool to mirror anymore. Offer-level
        // keeper enables latch into loan-level via _latchOfferKeepersToLoan
        // inside the full _copyOfferIntoLoan pipeline below.
    }

    function _copyPartyFields(
        LibVaipakam.Loan storage loan,
        LibVaipakam.Offer storage offer,
        address acceptor
    ) private {
        if (offer.offerType == LibVaipakam.OfferType.Lender) {
            loan.lender = offer.creator;
            loan.borrower = acceptor;
        } else {
            loan.lender = acceptor;
            loan.borrower = offer.creator;
        }
    }

    /**
     * @notice Gets details of a loan.
     * @dev View function for off-chain queries.
     * @param loanId The loan ID.
     * @return loan The Loan struct.
     */
    function getLoanDetails(
        uint256 loanId
    ) external view returns (LibVaipakam.Loan memory loan) {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        return s.loans[loanId];
    }

    /**
     * @notice T-032 — record the FIRST PaidPush-tier notification for a
     *         loan-side and immediately bill the corresponding party
     *         `cfgNotificationFee()`-equivalent in VPFI from their
     *         vault → treasury (one transfer, no Diamond custody).
     * @dev    Idempotent: subsequent calls on an already-billed side
     *         no-op. Reverts on:
     *           - caller missing `NOTIF_BILLER_ROLE`
     *           - loanId past `nextLoanId` or never-initialized
     *             (InvalidLoanStatus)
     *           - oracle stale / WETH unset / VPFI not configured
     *           - payer's vault has insufficient VPFI (the watcher's
     *             expected behaviour is to LOG this revert and skip
     *             the notification — the user's billed flag stays
     *             false until they top up VPFI)
     *
     *         The watcher fires this at notification-send time
     *         **only on PaidPush tier** subscribers — FreeTelegram
     *         subscribers are notified for free and never trigger
     *         this call. The on-chain billed flag is the source of
     *         truth that "this loan-side has paid for the notification
     *         service this lifetime."
     *
     * @param  loanId        Loan being billed.
     * @param  isLenderSide  true ⇒ bill `loan.lender`; false ⇒ bill
     *                       `loan.borrower`.
     */
    function markNotifBilled(uint256 loanId, bool isLenderSide)
        external
        whenNotPaused
        onlyRole(LibAccessControl.NOTIF_BILLER_ROLE)
    {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        // Loan-existence guard. `nextLoanId` is the highest id ever
        // assigned (pre-increment in `_initiateLoanFinalize` line 158);
        // valid range is [1, nextLoanId] inclusive. Loans are never
        // deleted from `s.loans`, so an in-range id always resolves to
        // a real Loan record. Out-of-range or never-initialized ids
        // return a zeroed Loan struct (lender == address(0)) — that's
        // the case we reject here.
        if (loanId == 0 || loanId > s.nextLoanId) {
            revert InvalidLoanStatus();
        }
        LibVaipakam.Loan storage loan = s.loans[loanId];
        address payer = isLenderSide ? loan.lender : loan.borrower;
        LibNotificationFee.bill(loanId, isLenderSide, payer);
    }

    /**
     * @notice Returns whether both counterparties latched the combined
     *         abnormal-market + illiquid-assets fallback consent for
     *         this loan. The docs mandate this consent on every offer
     *         create/accept, so for any successfully-initiated loan this
     *         flag is effectively always true and is informational — it
     *         records what both parties acknowledged, not the default
     *         settlement route. Liquid-collateral loans still DEX-
     *         liquidate when live liquidity is healthy; the full-
     *         collateral-transfer fallback only fires from swap revert or
     *         from the illiquid-asset branch. What this flag does
     *         gate at initiation is acceptance of illiquid legs (and the
     *         paired LTV/HF skip for those legs).
     * @dev Latched at initiation time from
     *      `offer.creatorRiskAndTermsConsent && acceptorRiskAndTermsConsent`; see
     *      docs/WebsiteReadme.md §"Offer and acceptance risk warnings"
     *      and README.md §"Liquidity & Asset Classification".
     * @param loanId The loan ID.
     * @return bothPartyConsent True iff the combined fallback consent was
     *         latched from both counterparties.
     */
    function getLoanConsents(
        uint256 loanId
    ) external view returns (bool bothPartyConsent) {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        return s.loans[loanId].riskAndTermsConsentFromBoth;
    }
}
