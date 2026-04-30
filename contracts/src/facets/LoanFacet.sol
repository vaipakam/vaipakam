// src/facets/LoanFacet.sol
// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {LibVaipakam} from "../libraries/LibVaipakam.sol";
import {LibLifecycle} from "../libraries/LibLifecycle.sol";
import {LibMetricsHooks} from "../libraries/LibMetricsHooks.sol";
import {LibFacet} from "../libraries/LibFacet.sol";
import {LibInteractionRewards} from "../libraries/LibInteractionRewards.sol";
import {LibVPFIDiscount} from "../libraries/LibVPFIDiscount.sol";
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
 *        3. Enforce LTV ≤ assetRiskParams.maxLtvBps and HF ≥ 1.5e18 for
 *           fully-liquid loans; skipped when the combined fallback consent is
 *           latched, since illiquid collateral is valued at $0 per README.
 *        4. For NFT-asset loans, compute prepaid rental amount and
 *           RENTAL_BUFFER_BPS buffer.
 *        5. Flip the offer creator's existing position NFT to LoanInitiated
 *           and mint the counterparty's NFT.
 *      Pausable (whenNotPaused).
 */
contract LoanFacet is DiamondPausable, IVaipakamErrors {
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
    /// @dev Indexers can render a full loan card from this event alone — no
    ///      follow-up `getLoanDetails` read needed. Non-indexed to keep the
    ///      topic budget for the 3 address-like identifiers (loanId, offerId,
    ///      lender) that filters key off.
    event LoanInitiated(
        uint256 indexed loanId,
        uint256 indexed offerId,
        address indexed lender,
        address borrower,
        uint256 principal,
        uint256 collateralAmount
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
     *        - LTVExceeded — LTV above assetRiskParams.maxLtvBps.
     *        - HealthFactorTooLow — HF < 1.5e18.
     *        - LTVCalculationFailed / HealthFactorCalculationFailed — risk
     *          staticcall reverted.
     *        - NFTStatusUpdateFailed / NFTMintFailed — NFT cross-facet call
     *          failed.
     * @param offerId The accepted offer ID.
     * @param acceptor The acceptor address (borrower or lender depending on offerType).
     * @param acceptorFallbackConsent Acceptor's mandatory consent to the
     *        combined abnormal-market + illiquid-assets fallback terms
     *        (docs/WebsiteReadme.md §"Offer and acceptance risk warnings",
     *        README.md §"Liquidity & Asset Classification"). Required on
     *        every accept regardless of leg liquidity; AND-combined with
     *        offer.creatorFallbackConsent and latched into the resulting
     *        loan as {Loan.fallbackConsentFromBoth}, which gates the
     *        illiquid-path and the default fallback behavior.
     * @return loanId The new loan ID.
     */
    function initiateLoan(
        uint256 offerId,
        address acceptor,
        bool acceptorFallbackConsent
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
        // funds to Liam for a loan that is already repaid/defaulted, and
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
            if (!(offer.creatorFallbackConsent && acceptorFallbackConsent)) {
                revert FallbackConsentRequired();
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
            acceptorFallbackConsent: acceptorFallbackConsent,
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
    }

    struct InitCtx {
        uint256 loanId;
        uint256 offerId;
        address acceptor;
        bool acceptorFallbackConsent;
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
            ctx.acceptorFallbackConsent,
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

        _applyRentalPrepayIfNFT(ctx.loanId, ctx.offerId);
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
    function _applyRentalPrepayIfNFT(uint256 loanId, uint256 offerId) private {
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
        bool mutualIlliquidConsent = ctx.acceptorFallbackConsent &&
            offer.creatorFallbackConsent;
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
        uint256 maxLtvBps = LibVaipakam
            .storageSlot()
            .assetRiskParams[collateralAsset]
            .maxLtvBps;
        if (ltv > maxLtvBps) revert LTVExceeded();

        bytes memory hfResult = LibFacet.crossFacetStaticCall(
            abi.encodeWithSelector(
                RiskFacet.calculateHealthFactor.selector,
                loanId
            ),
            HealthFactorCalculationFailed.selector
        );
        uint256 hf = abi.decode(hfResult, (uint256));
        if (hf < 150 * 1e16) revert HealthFactorTooLow();
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
        bool acceptorFallbackConsent,
        LibVaipakam.LiquidityStatus lendingAssetLiquidity,
        LibVaipakam.LiquidityStatus collateralLiquidity
    ) private {
        // Split across three frames so `--ir-minimum` (no optimizer) doesn't
        // pile every offer SLOAD onto a single stack frame.
        _copyFinancialFields(loan, offer, loanId, offerId);
        _copyAssetFields(
            loan,
            offer,
            acceptorFallbackConsent,
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
    ///      rollup their accumulator at the current escrow balance, then
    ///      freeze the post-rollup counter value onto the Loan — every
    ///      subsequent yield-fee settlement subtracts this anchor to get
    ///      the average discount over just this loan's lifetime.
    ///      Docs §5.2a.
    function _snapshotLenderDiscount(LibVaipakam.Loan storage loan) private {
        address lender = loan.lender;
        uint256 lenderBal = LibVPFIDiscount.escrowVPFIBalance(lender);
        LibVPFIDiscount.rollupUserDiscount(lender, lenderBal);
        loan.lenderDiscountAccAtInit = LibVaipakam
            .storageSlot()
            .userVpfiDiscountState[lender]
            .cumulativeDiscountBpsSeconds;
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
        address borrower = loan.borrower;
        uint256 borrowerBal = LibVPFIDiscount.escrowVPFIBalance(borrower);
        LibVPFIDiscount.rollupUserDiscount(borrower, borrowerBal);
        loan.borrowerDiscountAccAtInit = LibVaipakam
            .storageSlot()
            .userVpfiDiscountState[borrower]
            .cumulativeDiscountBpsSeconds;
    }

    function _copyFinancialFields(
        LibVaipakam.Loan storage loan,
        LibVaipakam.Offer storage offer,
        uint256 loanId,
        uint256 offerId
    ) private {
        loan.id = loanId;
        loan.offerId = offerId;
        loan.startTime = block.timestamp;
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
            loan.interestRateBps = offer.interestRateBps;
            loan.principal = offer.amount;
            loan.collateralAmount = offer.collateralAmount;
            // matcher stamped by the legacy `_acceptOffer` post-init
            // hook (already in PR3-A).
        }
    }

    function _copyAssetFields(
        LibVaipakam.Loan storage loan,
        LibVaipakam.Offer storage offer,
        bool acceptorFallbackConsent,
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
        _copyCollateralAssetFields(loan, offer, acceptorFallbackConsent);
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
        // Snapshot the effective fallback-path split right now so any future
        // governance change via `ConfigFacet.setFallbackSplit` applies
        // prospectively — dual-consent at offer creation guarantees both
        // parties agreed to these specific splits.
        loan.fallbackLenderBonusBpsAtInit = uint16(LibVaipakam.cfgFallbackLenderBonusBps());
        loan.fallbackTreasuryBpsAtInit = uint16(LibVaipakam.cfgFallbackTreasuryBps());
    }

    function _copyCollateralAssetFields(
        LibVaipakam.Loan storage loan,
        LibVaipakam.Offer storage offer,
        bool acceptorFallbackConsent
    ) private {
        loan.fallbackConsentFromBoth =
            acceptorFallbackConsent && offer.creatorFallbackConsent;
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
     *      `offer.creatorFallbackConsent && acceptorFallbackConsent`; see
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
        return s.loans[loanId].fallbackConsentFromBoth;
    }
}
