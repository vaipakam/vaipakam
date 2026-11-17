// src/libraries/LibOfferCreate.sol
// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {LibVaipakam} from "./LibVaipakam.sol";
import {LibPositionNFT} from "./LibPositionNFT.sol";
import {LibTiming} from "./LibTiming.sol";
import {LibProtectedAccount} from "./LibProtectedAccount.sol";
import {LibLoanClock} from "./LibLoanClock.sol";
import {LibFacet} from "./LibFacet.sol";
import {LibOfferBounds} from "./LibOfferBounds.sol";
import {LibOfferShape} from "./LibOfferShape.sol";
import {LibCadenceAdmission} from "./LibCadenceAdmission.sol";
import {LibOfferAdmission} from "./LibOfferAdmission.sol";
import {LibUserVault} from "./LibUserVault.sol";
import {LibAutoRefinanceCheck} from "./LibAutoRefinanceCheck.sol";
import {LibRiskAccess} from "./LibRiskAccess.sol";
import {LibRefinanceRequest} from "./LibRefinanceRequest.sol";
import {IVaipakamErrors} from "../interfaces/IVaipakamErrors.sol";
import {OfferBookFacet} from "../facets/OfferBookFacet.sol";
import {OfferPreviewFacet} from "../facets/OfferPreviewFacet.sol";
import {VaipakamNFTFacet} from "../facets/VaipakamNFTFacet.sol";
import {EncumbranceMutateFacet} from "../facets/EncumbranceMutateFacet.sol";
import {ProfileFacet} from "../facets/ProfileFacet.sol";
import {OfferCreateFacet} from "../facets/OfferCreateFacet.sol";

/**
 * @title  LibOfferCreate
 * @author Vaipakam Developer Team
 * @notice The one offer-creation core (#3328): validation, id allocation,
 *         the offer record, the position token and the book entry. Every
 *         path that puts an offer on the book runs it: the classic and
 *         Permit2 creates in `OfferCreateFacet`, and the signed-offer and
 *         standing-intent materialization in `OfferMaterializeFacet`.
 * @dev    Inlined into both facets. It was one facet until #3328 needed
 *         room for collection-offer slices; the seam is "how the creator's
 *         assets arrive", which each facet owns, while what an offer IS
 *         stays here once. Errors keep their `OfferCreateFacet` /
 *         `IVaipakamErrors` declarations, so selectors are unchanged.
 */
library LibOfferCreate {
    /// @dev Shared pre-pull setup. Runs every validation + allocates
    ///      the offer id + writes offer fields + stores liquidity.
    ///      Returns the new offer id and the caller's vault address
    ///      so the caller can do the actual asset pull via whichever
    ///      path (safeTransferFrom vs Permit2) fits.
    function setup(
        address creator,
        LibVaipakam.CreateOfferParams calldata params
    ) internal returns (uint256 offerId, address vault) {
        if (params.durationDays == 0) revert OfferCreateFacet.InvalidOfferType();
        // Findings 00025 — ProjectDetailsREADME §2 mandates
        // 1 ≤ durationDays ≤ 365 with on-chain enforcement so external
        // callers can't bypass the frontend validation and create a
        // 1000-day loan whose interest formula over-charges (interest
        // = principal × rate × days / 365). The lower bound is the
        // previous `== 0` check (caught by `InvalidOfferType`); this
        // is the on-chain upper bound. Cap is governance-tunable via
        // `ConfigFacet.setMaxOfferDurationDays` within bounded floor
        // / ceiling — defaults to 365 on a fresh deploy.
        uint256 maxDuration = LibVaipakam.cfgMaxOfferDurationDays();
        if (params.durationDays > maxDuration) {
            revert OfferCreateFacet.OfferDurationExceedsCap(params.durationDays, maxDuration);
        }
        if (params.amount <= 0) revert IVaipakamErrors.InvalidAmount();

        // Phase 4.3 — address-level sanctions screening at the "entering
        // a new business relationship" boundary. No-op on chains where
        // governance has not configured the oracle address. Use the
        // resolved `creator` (= msg.sender on classic paths, but the
        // on-behalf-of address on `createOfferInternal`).
        if (LibVaipakam.isSanctionedAddress(creator)) {
            revert ProfileFacet.SanctionedAddress(creator);
        }

        // Self-lending guard: principal and collateral must reference
        // distinct asset contracts.
        if (
            params.lendingAsset != address(0) &&
            params.lendingAsset == params.collateralAsset
        ) revert IVaipakamErrors.SelfCollateralizedOffer();

        // A platform position token is neither lent nor pledged here. A
        // pledged token would sit in a vault, and a position held by a vault
        // has no wallet to claim it: its payouts would be stranded. Whether
        // positions may ever be pledged inside the platform is an open owner
        // decision, so the safe state is a refusal.
        {
            address positionCore = LibPositionNFT._storage().core;
            if (
                positionCore != address(0) &&
                (params.collateralAsset == positionCore || params.lendingAsset == positionCore)
            ) revert IVaipakamErrors.PositionTokenNotAccepted();
        }

        // Per-asset pause (governance-controlled reserve pause).
        LibFacet.requireAssetNotPaused(params.lendingAsset);
        LibFacet.requireAssetNotPaused(params.collateralAsset);

        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();

        // #569 decision D-2 (2026-06-13) — an NFT-rental offer (the lent
        // asset is an NFT) may not use VPFI as its prepay asset. The
        // rental prepay pool is intentionally un-liened (D-1), so VPFI
        // prepay would be drainable through `withdrawVPFIFromVault`
        // with no protection. Gate it at the single shared offer-create
        // chokepoint (covers classic + Permit2 + on-behalf paths).
        if (
            params.assetType != LibVaipakam.AssetType.ERC20 &&
            s.vpfiToken != address(0) &&
            params.prepayAsset == s.vpfiToken
        ) {
            revert IVaipakamErrors.VpfiNotAllowedAsRentalPrepay();
        }
        unchecked {
            offerId = ++s.nextOfferId;
        }
        s.userOfferIds[creator].push(offerId);

        // #576 — a refinance-tagged offer is SINGLE-PURPOSE: consumable only by
        // the direct accept-and-refinance path. It may not also opt into the
        // pre-loan parallel sale (#358 borrow-OR-sell): on a carry-over offer
        // the listed collateral is the target loan's already-encumbered NFT, so
        // a sale fill before the refinance accept would transfer it out while
        // the old loan stays Active. Reject the combination up front — BEFORE
        // `_writeOfferFields`' parallel-sale collateral-shape validation — so
        // the verdict is the clear "this is an invalid refinance offer"
        // regardless of collateral type.
        if (params.refinanceTargetLoanId != 0 && params.allowsParallelSale) {
            revert OfferCreateFacet.InvalidRefinanceTarget();
        }

        LibVaipakam.Offer storage offer = s.offers[offerId];
        _writeOfferFields(offer, creator, offerId, params);

        // T-092 Phase 2b (#506) — refinance-tagged offer must be a
        // Borrower offer + creator must be the current borrower-NFT
        // owner of the targeted loan + the proposed terms must fit
        // within the borrower's `autoRefinanceCaps[loanId]`.
        // Validation re-runs at accept time too (caps may be
        // tightened or NFT may transfer between create + accept).
        if (params.refinanceTargetLoanId != 0) {
            if (params.offerType != LibVaipakam.OfferType.Borrower) {
                revert OfferCreateFacet.InvalidRefinanceTarget();
            }
            // Codex round-2 P2 — partial-fill on a refinance-tagged
            // offer would let it bind to multiple replacement loans
            // (each match rewrites `offerIdToLoanId[offerId]`), so
            // `RefinanceFacet`'s payoff sees only the last
            // match — earlier replacement loans get stranded. Force
            // AON fill so the offer binds exactly once.
            if (params.fillMode != LibVaipakam.FillMode.Aon) {
                revert OfferCreateFacet.InvalidRefinanceTarget();
            }
            // (refinance-tagged + allowsParallelSale already rejected up front,
            // before _writeOfferFields — see the guard above.)
            uint256 maxRateEffective =
                params.interestRateBpsMax == 0
                    ? params.interestRateBps
                    : params.interestRateBpsMax;
            uint256 maxAmountEffective =
                params.amountMax == 0 ? params.amount : params.amountMax;
            LibAutoRefinanceCheck.validate(
                s,
                params.refinanceTargetLoanId,
                creator,
                maxRateEffective,
                params.durationDays,
                params.lendingAsset,
                params.collateralAsset,
                params.assetType,
                params.collateralAssetType,
                params.prepayAsset,
                params.amount,
                maxAmountEffective
            );
            // #2407 — one standing request per loan, indexed so the borrower
            // actions that would change the loan can refuse while it is live.
            LibRefinanceRequest.record(params.refinanceTargetLoanId, offerId);
            // #576 — compute + PERSIST the carry-over decision ONCE, here, at
            // create (after validate has confirmed the asset/type identity +
            // caps). isCarryOver folds in the live-lien + exact
            // collateral-identity checks, so a no-lien or mismatched-collateral
            // target resolves to `false` and takes the legacy fresh-pledge
            // path. Every later site reads this stored flag instead of
            // re-deriving the predicate from the target loan's (mutable)
            // borrower + lien — see Offer.refinanceCarryOver.
            offer.refinanceCarryOver = LibAutoRefinanceCheck.isCarryOver(
                s,
                params.refinanceTargetLoanId,
                creator,
                params.collateralAmount,
                params.collateralAmountMax,
                params.collateralTokenId,
                params.collateralQuantity
            );
            // Pass-2 A1/D5 (#1189, Codex #1233 r2 P2) — a refinance-tagged offer
            // is moot once its target passes the grace deadline: `validate` /
            // RefinanceFacet reject a post-grace refinance, so an offer that
            // outlives that deadline just lingers unfillable and (for a
            // non-carry-over pledge) locks the borrower's fresh collateral until
            // a manual cancel, while wasting lender accept gas. CLAMP the offer's
            // expiry to the target's grace deadline (stamping one when it was
            // open-ended) so it auto-expires there instead. `validate` above has
            // already rejected a past-grace target, so `graceEnd > block.timestamp`
            // and the stamped expiry is a valid future deadline.
            {
                LibVaipakam.Loan storage tgt =
                    s.loans[params.refinanceTargetLoanId];
                uint256 tgtGraceEnd = LibLoanClock.graceEnd(tgt);
                // Deadline is EXCLUSIVE: `LibVaipakam.isOfferExpired` treats
                // `now >= expiresAt` as expired, while the grace boundary itself
                // (`now == graceEnd`) is still fillable (validate rejects only
                // `now > graceEnd`). Stamp `graceEnd + 1` so an offer created at
                // the boundary stays fillable THROUGH graceEnd instead of being
                // instantly expired (Codex #1233 r3 P3).
                uint256 deadline = tgtGraceEnd + 1;
                if (
                    offer.expiresAt == 0 ||
                    uint256(offer.expiresAt) > deadline
                ) {
                    offer.expiresAt = uint64(deadline);
                }
            }
        }

        // #2949 — a rental carries no collateral leg ({LibOfferShape.
        // assertCollateral} holds every collateral field at zero), so there
        // is no asset to price; it records Illiquid, the class an NFT-lend
        // offer is already in, and nothing reads a price for it. #3009 — the
        // derivation is the cadence rule's, so its preview classifies the
        // legs exactly as this create does.
        (LibVaipakam.LiquidityStatus principalLiq, LibVaipakam.LiquidityStatus collateralLiq) =
            LibCadenceAdmission.legLiquidity(params.lendingAsset, params.assetType, params.collateralAsset);
        offer.principalLiquidity = principalLiq;
        offer.collateralLiquidity = collateralLiq;

        if (!params.creatorRiskAndTermsConsent) revert IVaipakamErrors.RiskAndTermsConsentRequired();

        // #671 — progressive risk-access gate at the create chokepoint (shared by
        // every create path). No-op unless the kill-switch is on; protocol-
        // authored lender-sale-vehicle creates are exempt via the `saleVehicleCreate`
        // transient (their risk is the EXITING lender's, already gated at the
        // original loan). The riskier of the two legs governs and NFT rentals
        // tier off the value-bearing prepay token — see `LibRiskAccess`.
        if (LibVaipakam.cfgRiskAccessGateEnabled() && !s.saleVehicleCreate) {
            LibRiskAccess.assertActorMayTransact(
                s,
                creator,
                LibRiskAccess.PairId({
                    lendAsset: params.lendingAsset,
                    lendType: params.assetType,
                    lendTokenId: params.tokenId,
                    collAsset: params.collateralAsset,
                    collType: params.collateralAssetType,
                    collTokenId: params.collateralTokenId,
                    prepayAsset: params.prepayAsset
                })
            );
        }

        // ── System-derived floor/ceiling admission bound (#998 S15 / #900) ──
        // Formerly gated behind the `rangeAmountEnabled` flag (retired, #2812); the
        // bound is now enforced whenever the offer is actually liquid-both-legs
        // ERC-20 (matching the runtime HF gate's scope), via the shared
        // {LibOfferBounds} so create / mutate / internal-match slice cannot
        // drift. The keying (ERC-20 + liquid on both legs) lives in the helper.
        //
        // NOTE: read `params.amountMax` (calldata), NOT `offer.amountMax` — the
        // offer struct's `amountMax` is stamped later in `finish`
        // (`offer.amountMax = params.amountMax`), so it is still 0 here. The
        // old inline block read `offer.amountMax` and was therefore a DEAD
        // check (a 0 amountMax yields floor 0 / ceiling comparison against 0);
        // this fix makes the create-time bound effective for the first time.
        //
        // The lender-sale vehicle stays exempt from the ceiling
        // (`saleVehicleCreate`): it mimics a Borrower offer with
        // `collateralAmount == 0` (real collateral is on the linked live loan).
        LibOfferBounds.assertOfferBounds(
            params.offerType == LibVaipakam.OfferType.Lender,
            params.assetType,
            params.collateralAssetType,
            params.amountMax,
            params.collateralAmount,
            params.collateralAmountMax == 0
                ? params.collateralAmount
                : params.collateralAmountMax,
            params.lendingAsset,
            params.collateralAsset,
            s.saleVehicleCreate
        );

        // ── T-034 — Periodic Interest Payment cadence validation ──────────
        // See docs/DesignsAndPlans/PeriodicInterestPaymentDesign.md §3.
        // Three filters in order:
        //   - Master kill-switch: feature disabled → cadence must be None.
        //   - Filter 0: both sides liquid → otherwise cadence forced to None.
        //   - Filter 1: cadence interval strictly less than duration.
        //   - Filter 2: duration / threshold matrix (mandatory Annual on
        //     >365d loans; finer cadences require principal ≥ threshold).
        _validatePeriodicCadence(params, offer, principalLiq, collateralLiq);

        vault = LibUserVault.getOrCreate(creator);
    }

    /// @dev T-034 — extracted to keep `setup` readable. Reverts
    ///      with the shared admission rule's refusal ({LibCadenceAdmission},
    ///      #3009) and snapshots the lender's chosen cadence onto the Offer
    ///      struct on success.
    function _validatePeriodicCadence(
        LibVaipakam.CreateOfferParams calldata params,
        LibVaipakam.Offer storage offer,
        LibVaipakam.LiquidityStatus principalLiq,
        LibVaipakam.LiquidityStatus collateralLiq
    ) internal {
        LibVaipakam.PeriodicInterestCadence cadence =
            params.periodicInterestCadence;

        // #1503 (design item 23) — a lender-sale VEHICLE stores the live
        // position's cadence verbatim and skips every filter below.
        //
        // The filters are ADMISSION rules: they decide whether a cadence may be
        // ORIGINATED on these terms. A sale originates nothing — it hands an
        // existing position to a new lender, and that position's cadence was
        // already admitted when the loan was taken. Re-asking the origination
        // question at listing time asks whether the position could be created
        // TODAY, which is a different question with a different answer, because
        // the vehicle is built from the position's *current* state:
        // `durationDays` is the days REMAINING (not the original term) and
        // `amount` is the CURRENT principal (a partial repay shrinks it).
        //
        // So without this exemption, mirroring the cadence (in
        // `EarlyWithdrawalFacet._buildSaleParams`) would silently make ordinary
        // periodic positions unlistable:
        //   - Filter 1 rejects `intervalDays(cadence) >= durationDays`, so an
        //     Annual 366-day loan becomes unlistable one day after origination,
        //     and a Quarterly loan for its whole last quarter.
        //   - Filter 2 rejects a non-None cadence below the finer-cadence
        //     principal threshold, so a partial repay that drops the principal
        //     under it strands the lender; and it demands `Annual` on the
        //     multi-year row, which a multi-year loan stops satisfying as soon
        //     as its remaining term falls under 365 days.
        //   - Filter 0 and the kill-switch would strand a live position whose
        //     collateral was re-classified illiquid, or every periodic position
        //     at once if governance ever turned the feature off.
        // In each case the lender's exit disappears for a position that is
        // running normally — a worse outcome than the stale-default bug the
        // mirroring fixes.
        //
        // Storing the cadence is still REQUIRED (not merely allowed): the
        // accept-time binding compares the buyer's signature against this
        // stored value, so a vehicle that dropped it back to `None` would put
        // the buyer's signed terms back out of step with the position they are
        // buying. Exempt from admission, faithful in content.
        if (LibVaipakam.storageSlot().saleVehicleCreate) {
            offer.periodicInterestCadence = cadence;
            return;
        }

        // #3009 — every admission refusal is the one shared rule's
        // ({LibCadenceAdmission}): the kill-switch, Filter 0, the multi-year
        // `Annual` floor (which binds only while the feature is on and both
        // legs are liquid ERC-20), the principal-threshold matrix and the
        // interval-shorter-than-duration filter. Offer mutation and the
        // cadence preview read the same rule. It runs through a self-call to
        // its one copy on OfferPreviewFacet, so its refusal reverts this
        // create unchanged and this facet (near EIP-170) carries only the call.
        OfferPreviewFacet(address(this)).requireCadenceAdmitted(
            LibCadenceAdmission.Terms({
                lendingAsset: params.lendingAsset,
                amount: params.amount,
                durationDays: params.durationDays,
                cadence: cadence,
                assetType: params.assetType,
                collateralAssetType: params.collateralAssetType,
                principalLiquidity: principalLiq,
                collateralLiquidity: collateralLiq
            })
        );

        offer.periodicInterestCadence = cadence;
    }

    /// @dev Computes the ERC-20 amount the Permit2 path needs to pull
    ///      for an offer created via {createOfferWithPermit}. Mirrors
    ///      the classic path's asset selection: lender-side ERC-20
    ///      loan = principal, borrower-side ERC-20 loan = collateral,
    ///      borrower-side NFT rental = prepay+buffer.
    function creatorPullAmount(
        uint256 offerId,
        LibVaipakam.CreateOfferParams calldata params
    ) internal view returns (uint256) {
        if (params.offerType == LibVaipakam.OfferType.Lender) {
            // Range Orders Phase 1: pre-vault `amountMax` so partial
            // fills draw from custody. Auto-collapse for legacy callers.
            return params.amountMax == 0 ? params.amount : params.amountMax;
        }
        if (params.assetType == LibVaipakam.AssetType.ERC20) {
            // Issue #164 — Permit2 pulls the upper bound so the
            // borrower-range path matches the classic-path pre-vault.
            // Auto-collapse for legacy single-value callers.
            return params.collateralAmountMax == 0
                ? params.collateralAmount
                : params.collateralAmountMax;
        }
        // NFT rental borrower offer — Permit2 pulls the prepay.
        LibVaipakam.Offer storage offer = LibVaipakam.storageSlot().offers[offerId];
        // #1193 — fund the buffer from the offer's create-time snapshot.
        return nftRentalPrepayTotal(
            offer.amount,
            offer.durationDays,
            LibVaipakam.effectiveRentalBufferBps(offer)
        );
    }

    /// @dev Rental prepay total = amount × days + (amount × days ×
    ///      rentalBufferBps / BASIS_POINTS). Isolated from the pull
    ///      helper so the Permit2 path can call the same formula.
    /// @dev Takes the two fields it actually needs (`amount` and
    ///      `durationDays`) instead of the full `CreateOfferParams`
    ///      struct — passing the whole struct in memory used to push
    ///      the calling helper over Yul's stack-depth ceiling once
    ///      the struct grew (16-field via `allowsPartialRepay`).
    function nftRentalPrepayTotal(
        uint256 amount,
        uint256 durationDays,
        uint256 bufferBps
    ) internal pure returns (uint256) {
        uint256 prepayAmount = amount * durationDays;
        uint256 buffer = (prepayAmount * bufferBps) / LibVaipakam.BASIS_POINTS;
        return prepayAmount + buffer;
    }

    /// @dev Shared post-pull finish. Mints the Vaipakam position NFT,
    ///      runs MetricsFacet analytics hook, emits OfferCreated.
    function finish(
        address creator,
        uint256 offerId,
        LibVaipakam.CreateOfferParams calldata params,
        LibOfferAdmission.Route route
    ) internal {
        // Protected account mode — a locked or retired account posts no offer.
        LibProtectedAccount.requireCanOpen(creator);
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        LibVaipakam.Offer storage offer = s.offers[offerId];

        // #3443 — the terms are set now, so the offer can be filled only once
        // they have stood the minimum age. A signed offer materialized for its
        // own fill carries no age: its terms were set off-chain, and it is
        // bound by its signature and the taker's signed terms instead.
        if (route != LibOfferAdmission.Route.SignedMaterialize) {
            LibTiming.stampOfferTerms(offer);
        }

        unchecked {
            offer.positionTokenId = ++s.nextTokenId;
        }
        // Reverse map: tokenId → offerId. Mirrors the loan-side
        // `loanIdByPositionTokenId` populated by LibMetricsHooks at
        // LoanInitiated. Lets MetricsFacet's `getUserPositionOffers`
        // view enumerate offers whose creator-NFT a given user holds
        // (including secondary-market recipients). Cleared at offer
        // cancel and at accept (when the tokenId transitions to a
        // loan and `loanIdByPositionTokenId` takes over).
        s.offerIdByPositionTokenId[offer.positionTokenId] = offerId;
        (bool success, ) = address(VaipakamNFTFacet(address(this))).call(
            abi.encodeWithSelector(
                VaipakamNFTFacet.mintNFT.selector,
                creator,
                offer.positionTokenId,
                offerId,
                0,
                params.offerType == LibVaipakam.OfferType.Lender,
                LibVaipakam.LoanPositionStatus.OfferCreated
            )
        );
        if (!success) revert IVaipakamErrors.NFTMintFailed();

        // Offer-creator escrow lock. An offer pre-vaults the creator's
        // ERC20 stake into their own vault at create-time (the pull ran
        // before this finish step). Mark it encumbered in the same
        // `encumbered[user][asset][0]` aggregate the vault-withdraw
        // chokepoint reads, so the creator cannot withdraw the locked
        // stake out from under a still-open offer. An offer has exactly
        // ONE creator-side escrow, so the single `offerPrincipalLien`
        // primitive serves both legs (asset-agnostic):
        //   - T-407-C (#566): ERC20 Lender offer → its `amountMax`
        //     principal in `lendingAsset`.
        //   - #573 (security): ERC20-borrow Borrower offer with ERC20
        //     collateral → its `collateralAmountMax` in `collateralAsset`.
        //     Closes the pre-acceptance drain (e.g. `withdrawVPFIFromVault`
        //     unstaking VPFI pledged as collateral before a lender accepts,
        //     which would mint an under-collateralized loan).
        // Released on cancel / single-fill accept / dust-close /
        // lazy-expiry, decremented per partial fill, and (borrower leg)
        // handed off to the loan-collateral lien at acceptance. NFT
        // legs hold the token itself in custody (no fungible aggregate,
        // no ERC20 drain door) so they're out of scope. `creatorPullAmount`
        // returns the exact pre-vaulted amount for each shape — reused so
        // the lien can never drift from what was actually pulled.
        if (
            params.offerType == LibVaipakam.OfferType.Lender &&
            params.assetType == LibVaipakam.AssetType.ERC20
        ) {
            LibFacet.crossFacetCall(
                abi.encodeWithSelector(
                    EncumbranceMutateFacet.createOfferPrincipalLien.selector,
                    offerId,
                    creator,
                    params.lendingAsset,
                    creatorPullAmount(offerId, params)
                ),
                bytes4(0)
            );
        } else if (
            params.offerType == LibVaipakam.OfferType.Borrower &&
            params.assetType == LibVaipakam.AssetType.ERC20 &&
            params.collateralAssetType == LibVaipakam.AssetType.ERC20 &&
            !LibVaipakam.storageSlot().offers[offerId].refinanceCarryOver
        ) {
            // #576 — a CARRY-OVER refinance offer pledged NO fresh collateral
            // (the carry-over skip in `_pullCreatorAssetsClassic`), so there is
            // nothing to escrow-lock here. Locking would encumber
            // `collateralAmountMax` of collateral that was never deposited — a
            // phantom lien double-counting the carried collateral (already
            // liened under the OLD loan, retagged at refinance). The
            // `!isCarryOver` guard keeps the #573 escrow lock for every ordinary
            // Borrower offer (incl. transferred / ranged / untagged refinances,
            // which DO pledge fresh collateral).
            LibFacet.crossFacetCall(
                abi.encodeWithSelector(
                    EncumbranceMutateFacet.createOfferPrincipalLien.selector,
                    offerId,
                    creator,
                    params.collateralAsset,
                    creatorPullAmount(offerId, params)
                ),
                bytes4(0)
            );
        }

        // #3242 — the offer enters the book through one host,
        // {OfferBookFacet.openOfferOnBook}: it applies the two book bounds
        // (the value floor and the per-wallet open-offer cap, both read from
        // the row just written), records the offer in the active index and
        // announces it ({OfferCreated} then {OfferCreatedDetails}, unchanged).
        // A refusal reverts this whole create.
        OfferBookFacet(address(this)).openOfferOnBook(offerId, route);
    }

    /**
     * @dev Writes the ~18 offer fields in two frames so `forge coverage
     *      --ir-minimum` (no optimizer) doesn't pile every calldata load
     *      onto a single stack frame in {createOffer}.
     */
    function _writeOfferFields(
        LibVaipakam.Offer storage offer,
        address creator,
        uint256 offerId,
        LibVaipakam.CreateOfferParams calldata params
    ) internal {
        _writeOfferPrincipalFields(offer, creator, offerId, params);
        _writeOfferCollateralFields(offer, params);
    }

    function _writeOfferPrincipalFields(
        LibVaipakam.Offer storage offer,
        address creator,
        uint256 offerId,
        LibVaipakam.CreateOfferParams calldata params
    ) internal {
        offer.id = offerId;
        offer.creator = creator;
        offer.offerType = params.offerType;
        offer.lendingAsset = params.lendingAsset;
        offer.amount = params.amount;
        offer.interestRateBps = params.interestRateBps;
        offer.durationDays = params.durationDays;
        offer.assetType = params.assetType;
        offer.tokenId = params.tokenId;
        offer.quantity = params.quantity;
        offer.prepayAsset = params.prepayAsset;
        // #1193 (Pass-2 D3) — snapshot the live rental buffer BPS at create so
        // every later economic site (accept pull, cancel refund, modify delta,
        // loan-init `bufferAmount`, Option-2 transfer reset) funds/refunds the
        // SAME buffer this offer vaulted, immune to a `cfgRentalBufferBps()`
        // governance retune. Stamped for every offer (harmless for non-rental
        // ones — only the rental paths read it via `effectiveRentalBufferBps`);
        // `cfgRentalBufferBps()` is bounded ≤ MAX_RENTAL_BUFFER_BPS (2000), so
        // the uint16 cast never truncates.
        offer.rentalBufferBpsAtCreate = uint16(LibVaipakam.cfgRentalBufferBps());
        // ── Canonical Limit-Order Phase 2 (#183, see
        //    docs/DesignsAndPlans/CanonicalLimitOrderPhase2Design.md):
        //    the Phase 1 auto-collapse (`amountMax == 0 → amount`) is
        //    dropped. Callers MUST ship explicit non-zero values for
        //    `amount`, `amountMax`, `interestRateBpsMax`. The canonical
        //    frontend always does so per the role-aware mapping
        //    (lender ships `amount = minPartialFillAmount`, `amountMax
        //    = lendingAmount`; borrower ships `amount = lendingAmount`
        //    min, `amountMax = derived from collateral × tier-LTV`).
        //
        //    The Phase 1 kill-switches that blocked range offers at
        //    create time (`rangeAmountEnabled`, `rangeRateEnabled`,
        //    `rangeCollateralEnabled`) are removed — every Phase 2
        //    offer is canonically a range (lender amount differs from
        //    amountMax via the minPartialFill rule), so the OFF state
        //    would block every legitimate offer. #2812 retired the flags
        //    themselves: no setter or getter remains, and their storage
        //    slots are marked retired. `partialFillEnabled` keeps its runtime role
        //    in `OfferMatchFacet.matchOffers` (matching is the gated
        //    operation, not create).
        // #2749 — the principal-range rules (positive floor and ceiling,
        // ordering, a rental's single-value daily fee, and an all-or-nothing
        // offer's single value) live in {LibOfferShape}, the one definition
        // `OfferMutateFacet` applies to every edit too.
        LibOfferShape.assertAmount(
            params.assetType, params.fillMode, params.amount, params.amountMax
        );
        if (
            params.assetType == LibVaipakam.AssetType.ERC1155 &&
            params.quantity > type(uint128).max
        ) revert OfferCreateFacet.RentalQuantityAboveVaultRange();
        // #183 — the rate invariant deliberately ALLOWS zero on both
        // ends (`interestRateBps = interestRateBpsMax = 0`). This is a
        // legitimate shape: NFT rental offers don't carry an APR (the
        // economic payment flows through `amount × durationDays` prepay
        // + buffer, not interest accrual), and no-interest ERC20 loans
        // are also valid. The `> 0` strictness we apply to amount +
        // collateral catches silent-zero bugs there because a zero
        // principal or collateral is structurally meaningless, whereas
        // a zero rate is structurally meaningful. The only rate
        // checks that stay load-bearing are the range ordering and the
        // upper-sanity ceiling (`<= MAX_INTEREST_BPS`).
        LibOfferShape.assertRate(params.interestRateBps, params.interestRateBpsMax);
        offer.amountMax = params.amountMax;
        offer.interestRateBpsMax = params.interestRateBpsMax;
        // #400 — NOTE: the rate a human creator types is BINDING and is NOT
        // transformed by any rate model. Vaipakam's market rate is set by the
        // human-driven P2P order book (price discovery), not a protocol curve —
        // overwriting a creator's rate here would erase that differentiation.
        // The pluggable {IRateModel} is exposed as a QUOTE
        // (`RateModelFacet.quoteOfferRateBps`) for (a) dApp rate *guidance* a
        // human may take or ignore, and
        // (b) automated/delegated pricing (#393 auto-lend / auto-roll /
        // keeper-posted intents, #394 risk premiums) where the user opted into
        // having their liquidity priced for them. Those callers pass the quote
        // result as the offer rate themselves; this manual create path never
        // calls the model.
        offer.amountFilled = 0;
        offer.createdAt = uint64(block.timestamp);

        // ── #195 — GTT / offer-expiry validation + stamp ──────────────
        // `expiresAt == 0` is the GTC sentinel (preserves pre-#195
        // behaviour). Any non-zero value must lie strictly after now
        // and within the protocol's horizon cap, both bounds enforced
        // at create time so the storage row is always either GTC or
        // within a bounded grief window. The non-strict lower bound
        // (`<=`) catches "set expiresAt to now" — that would create an
        // offer that's expired on creation, which is at-best useless
        // and at-worst a UX foot-gun. `isOfferExpired` uses `>=` so
        // the boundary is consistent on both write and read.
        if (params.expiresAt != 0) {
            if (uint256(params.expiresAt) <= block.timestamp) {
                revert OfferCreateFacet.OfferExpiryInPast();
            }
            if (
                uint256(params.expiresAt) >
                block.timestamp + LibVaipakam.MAX_OFFER_EXPIRY_HORIZON
            ) {
                revert OfferCreateFacet.OfferExpiryAboveCap(
                    params.expiresAt,
                    block.timestamp + LibVaipakam.MAX_OFFER_EXPIRY_HORIZON
                );
            }
            offer.expiresAt = params.expiresAt;
        }
        // `expiresAt == 0` path: leave the storage slot at its default
        // zero. Skipping the SSTORE on the GTC path keeps `createOffer`
        // gas identical to pre-#195 for every existing test / script
        // that doesn't set the field.

        // ── #125 — Fill-mode validation + stamp ─────────────────────────
        // `Partial` (0) is the backward-compat default — every legacy
        // CreateOfferParams construction that doesn't set the field
        // gets today's Range-Orders Phase-1 behaviour.
        //
        // `Aon` requires `amount == amountMax`. A non-trivial range
        // under AON is structurally meaningless: the only fill that
        // ever lands is the full one, so any min/max gap would never
        // be observable. Forcing single-value at create keeps the
        // match-time AON gate (revert on any matchAmount < offer
        // total) unambiguous + cheap (no need to thread "the AON
        // amount" through the matcher midpoint logic).
        //
        // `Ioc` requires `expiresAt > 0`. IOC's defining knob IS the
        // window — "match what's available within N seconds, cancel
        // the rest"; an IOC without a window is just `Partial` with
        // extra metadata. The actual time-window enforcement is
        // shared with #195's GTT lazy-expiry gate (`isOfferExpired`
        // fires at every accept / match read), so we don't add a
        // separate runtime path here.
        // (The AON single-value rule is checked with the rest of the
        // principal range in {LibOfferShape.assertAmount} above.)
        if (params.fillMode == LibVaipakam.FillMode.Ioc) {
            if (params.expiresAt == 0) revert OfferCreateFacet.IocRequiresExpiry();
        }
        if (params.fillMode != LibVaipakam.FillMode.Partial) {
            // Skip the SSTORE on the Partial default for the same gas-
            // identity reason as `expiresAt == 0` above.
            offer.fillMode = params.fillMode;
        }
    }

    function _writeOfferCollateralFields(
        LibVaipakam.Offer storage offer,
        LibVaipakam.CreateOfferParams calldata params
    ) internal {
        offer.collateralAsset = params.collateralAsset;
        offer.collateralAmount = params.collateralAmount;
        offer.creatorRiskAndTermsConsent = params.creatorRiskAndTermsConsent;
        offer.collateralAssetType = params.collateralAssetType;
        offer.collateralTokenId = params.collateralTokenId;
        offer.collateralQuantity = params.collateralQuantity;
        // Lender-controlled gate for borrower-initiated partial repay.
        // See {CreateOfferParams.allowsPartialRepay} for full semantics.
        offer.allowsPartialRepay = params.allowsPartialRepay;
        // T-086 step 4 — lender consent to allow a borrower-initiated
        // Seaport prepay listing on the loan's collateral NFT. See
        // {CreateOfferParams.allowsPrepayListing} for full semantics.
        // Snapshotted to {Loan.allowsPrepayListing} at loan-init.
        offer.allowsPrepayListing = params.allowsPrepayListing;
        // T-086 Round-8 (#358) §19.5 — borrower opt-in for parallel-sale
        // listing. Only valid on Borrower offers with NFT collateral;
        // the call to OfferParallelSaleFacet.postParallelSaleListing
        // re-validates these constraints at post time, but we enforce
        // the structurally-impossible cases at create time so the flag
        // can't be stamped on an offer it'll never be usable on.
        // Codex P1 round-1 #4 fix — the missing wiring made every
        // production offer keep allowsParallelSale == false.
        if (params.allowsParallelSale) {
            if (offer.offerType != LibVaipakam.OfferType.Borrower) {
                revert OfferCreateFacet.ParallelSaleRequiresBorrowerOffer();
            }
            if (
                offer.collateralAssetType != LibVaipakam.AssetType.ERC721 &&
                offer.collateralAssetType != LibVaipakam.AssetType.ERC1155
            ) {
                revert OfferCreateFacet.ParallelSaleRequiresNFTCollateral();
            }
            // Codex round-8 P2 #4 — mirror the post-time
            // `ParallelSaleRequiresSingleFill` check at create time
            // (`fillMode != Aon` is incompatible with parallel-sale's
            // single-loan assumption). Without this gate, a borrower
            // can stamp an offer as parallel-sale-enabled with
            // `Partial` or `IOC` fillMode + finds out only at
            // `postParallelSaleListing` time that the listing can never
            // post — misleading UX, looks like a borrow-OR-sell
            // option in the offer's terms but is unusable.
            if (offer.fillMode != LibVaipakam.FillMode.Aon) {
                revert OfferCreateFacet.ParallelSaleRequiresAonFillMode();
            }
        }
        offer.allowsParallelSale = params.allowsParallelSale;
        // T-092 Phase 2b (#506) — refinance target.
        offer.refinanceTargetLoanId = params.refinanceTargetLoanId;
        // #408 / #410 / #413 (2026-06-12) — floor-model election.
        // Carries through to `Loan.useFullTermInterest` at loan-init
        // (`LoanFacet.initiateLoan:792`), which `LibEntitlement.
        // settlementInterest` reads to apply the full-term FLOOR
        // (when `true`) or pure pro-rata-elapsed (when `false`).
        offer.useFullTermInterest = params.useFullTermInterest;
        // #3621 — the lender's "either" marks; `OfferBookFacet.openOfferOnBook`
        // refuses them on an offer that cannot carry them.
        offer.lifecycleFlex = params.lifecycleFlex;
        // #1347 — the creator's Full VPFI tariff opt-in (`Offer.creatorFull` /
        // `creatorMaxCStar` / `creatorAllowFullDowngrade`) is NOT a
        // `CreateOfferParams` field: it is authorized post-create by the creator
        // via `ProfileFacet.setOfferCreatorFullTariff` (the same per-offer
        // creator-gated pattern as `setOfferKeeperEnabled`), so the 60-plus
        // existing `CreateOfferParams` construction sites stay untouched. Absent
        // that opt-in the fields stay zero ⇒ non-Full.
        //
        // SIGNED OFFERS (materialized + accepted atomically) have no post-create
        // / pre-accept moment to call the setter, so since #1949 the signed
        // artifact itself carries the maker's Full opt-in
        // (`LibSignedOffer.SignedOffer.creatorFull` / `creatorMaxCStar` /
        // `creatorAllowFullDowngrade`) and `_materializeSignedOffer` applies it
        // through `_applyMakerFull` — the same three fields and the same event
        // as the setter; a slice takes its pro-rata share of the ceiling. Before
        // #1949 a signed-offer maker always resolved as non-Full (safe: no wrong
        // charge, but the Full channel was unreachable from a signed offer).
        //
        // NOT #1369, which this comment used to name and which CLOSED on
        // 2026-07-30 having covered the OTHER half — the matched-fill lender
        // Full gap (Codex #1366 r3 P2). That half is DONE: a matched fill
        // reads the lender's authorization off their own offer via
        // `matchLenderAuthOfferId` (see `OfferMatchFacet`, `OfferAcceptFacet`
        // and `FeeEntitlementFacet`, all of which cite #1369 as shipped
        // behaviour). So the old text was wrong twice over — it pointed at a
        // closed card, and it described the matched-fill case as an open gap
        // alongside this one. A reader following either claim concluded the
        // signed-offer gap was fixed. It is not.
        // Phase 6: keeper access is per-keeper via
        // `offerKeeperEnabled[offerId][keeper]`. Creator enables specific
        // keepers post-create via `ProfileFacet.setOfferKeeperEnabled`.

        // ── Canonical Limit-Order Phase 2 (#183) — same shape as the
        //    amount/rate block above. Auto-collapse dropped; explicit
        //    non-zero `collateralAmountMax` required from every caller.
        //    Lender offers stay single-value on collateral
        //    (`collateralAmount == collateralAmountMax`) per #164's
        //    framing — the lender's collateralAmount IS their derived
        //    requirement; a separate max wouldn't add meaning. Borrower
        //    offers are RANGED on collateral (their `collateralAmount`
        //    is the derived floor matching their `amount` floor; their
        //    `collateralAmountMax` is the user's posted max commit).
        //    The `rangeCollateralEnabled` create-time kill-switch is
        //    removed (every Phase 2 borrower offer would be blocked
        //    under OFF since collateral is canonically ranged).
        // #183 / #164 / #2729 — the collateral-range rules live in
        // {LibOfferShape.assertCollateral}, shared with every mutation. An
        // ERC-20 loan against ERC-20 collateral must post a positive floor and
        // ceiling; the ONLY exception is the protocol's own lender-sale vehicle
        // (`saleVehicleCreate`, set by `EarlyWithdrawalFacet` around its
        // internal create), whose collateral lives on the linked live loan.
        // Keyed on who is creating, not on the offer's shape: a shape-keyed
        // exception let any creator post zero collateral, and against illiquid
        // collateral nothing else refused it. NFT collateral (locked by token
        // id / quantity) carries no amount rule, and an NFT rental (committed
        // by the prepaid fee) carries no collateral at all (#2949).
        LibOfferShape.assertCollateral(
            params.offerType,
            params.assetType,
            params.collateralAsset,
            params.collateralAssetType,
            params.collateralAmount,
            params.collateralAmountMax,
            params.collateralTokenId,
            params.collateralQuantity,
            LibVaipakam.storageSlot().saleVehicleCreate
        );
        // Canonical Limit-Order Phase 2 (#183) — the Phase 1 #169
        // SSTORE-skip optimisation is retired. Under the strict
        // invariant `collateralAmountMax >= collateralAmount > 0`,
        // storage always holds an explicit non-zero value (the
        // canonical frontend ships the user's max collateral commit;
        // lender single-value offers ship it equal to
        // `collateralAmount`). The read-side `collateralAmountMax == 0
        //  ⇒ collateralAmount` fallbacks elsewhere in this facet are
        // dead code under the new invariant; they stay as defensive
        // no-ops and will get swept in a follow-up.
        offer.collateralAmountMax = params.collateralAmountMax;
        // `collateralAmountFilled` defaults to 0 from struct
        // initialization; it stays 0 across Phase 1 borrower matches
        // (single-fill rule). #102 lifts the single-fill rule and
        // starts writing this field.
    }
}
