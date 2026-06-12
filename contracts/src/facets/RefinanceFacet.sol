// src/facets/RefinanceFacet.sol
// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {LibVaipakam} from "../libraries/LibVaipakam.sol";
import {LibLifecycle} from "../libraries/LibLifecycle.sol";
import {LibAuth} from "../libraries/LibAuth.sol";
import {LibEntitlement} from "../libraries/LibEntitlement.sol";
import {LibFacet} from "../libraries/LibFacet.sol";
import {EncumbranceMutateFacet} from "./EncumbranceMutateFacet.sol";
import {LibVPFIDiscount} from "../libraries/LibVPFIDiscount.sol";
import {LibOfferMatch} from "../libraries/LibOfferMatch.sol";
import {LibPeriodicInterest} from "../libraries/LibPeriodicInterest.sol";
import {LibPrepayCleanup} from "../libraries/LibPrepayCleanup.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {DiamondReentrancyGuard} from "../libraries/LibReentrancyGuard.sol";
import {DiamondPausable} from "../libraries/LibPausable.sol";
import {IVaipakamErrors} from "../interfaces/IVaipakamErrors.sol";
import {VaipakamNFTFacet} from "./VaipakamNFTFacet.sol";
import {VaultFactoryFacet} from "./VaultFactoryFacet.sol";
import {RiskFacet} from "./RiskFacet.sol";
import {OracleFacet} from "./OracleFacet.sol";
import {VPFIDiscountFacet} from "./VPFIDiscountFacet.sol";
import {LibERC721} from "../libraries/LibERC721.sol";

/**
 * @title RefinanceFacet
 * @author Vaipakam Developer Team
 * @notice Borrower refinancing — close an existing loan and switch to a new
 *         lender with better terms.
 * @dev Part of the Diamond Standard (EIP-2535). Reentrancy-guarded, pausable.
 *      ERC-20 loans only (NFT rental refinance not supported — would require
 *      NFT custody transfer between vaults).
 *
 *      Two-step flow:
 *        1. Borrower creates a Borrower Offer; a new lender accepts it
 *           (creating a new loan). Principal from the new lender flows to
 *           the borrower.
 *        2. Borrower calls {refinanceLoan}: repays the old lender
 *           (principal + full-term interest — early repayment
 *           economics per README; #411 fix 2026-06-12 dropped the
 *           rate-shortfall top-up that over-compensated the exiting
 *           lender), releases old collateral,
 *           verifies post-refinance HF ≥ 1.5 and LTV ≤ loanInitMaxLtvBps on the new
 *           loan, and transitions the old loan to Repaid.
 */
contract RefinanceFacet is DiamondReentrancyGuard, DiamondPausable, IVaipakamErrors {
    using SafeERC20 for IERC20;

    /// @notice Emitted when a loan is refinanced to a new lender.
    /// @param oldLoanId The ID of the original loan.
    /// @param newLoanId The ID of the new refinanced loan.
    /// @param borrower The borrower's address.
    /// @param oldLender The original lender's address.
    /// @param newLender The new lender's address.
    /// @param shortfallPaid Always 0 post-#411 fix (2026-06-12); previously
    ///                      held the rate-shortfall top-up paid to the
    ///                      exiting old lender. Retained at 0 to keep the
    ///                      event signature byte-identical for indexers.
    /// @param oldLoanNewStatus The original loan's `LoanStatus` after the
    ///        refinance — always `Repaid` (1). Carried explicitly so an
    ///        indexer flips status from the payload rather than inferring
    ///        it from the event name (uniform with `LoanRepaid.newStatus`).
    /// @custom:event-category state-change/loan-mutation
    event LoanRefinanced(
        uint256 indexed oldLoanId,
        uint256 indexed newLoanId,
        address indexed borrower,
        address oldLender,
        address newLender,
        uint256 shortfallPaid,
        uint8 oldLoanNewStatus
    );

    // Facet-specific errors (shared errors inherited from IVaipakamErrors)
    error InvalidRefinanceOffer();
    error OfferNotAccepted();
    /// @notice T-092 #508 — admin kill switch for the keeper-driven
    ///         refinance path. Borrower-direct refinance ignores this.
    error AutoRefinanceDisabled();

    /**
     * @notice Completes refinancing after alice's Borrower Offer has been accepted by Lender B.
     * @dev Per README Section "Allow Borrower to Choose New Lender with Better Offer":
     *      1. alice creates a Borrower Offer (separate tx via OfferFacet.createOffer).
     *      2. Lender B accepts alice's offer (separate tx via OfferFacet.acceptOffer),
     *         creating a new loan. Principal from Lender B is sent to alice.
     *      3. alice calls this function to close the old loan:
     *         - Verifies the Borrower Offer was accepted and a new loan exists.
     *         - Repays old lender (principal + full-term interest;
     *           see LibEntitlement.fullTermInterest — matches README early
     *           repayment economics). #411 fix (2026-06-12) — the
     *           previous code also added a rate-shortfall top-up, but
     *           full-term IS the lender's maximum entitlement on this
     *           loan, so paying additional shortfall over-compensated
     *           the exiting lender at borrower expense (see
     *           docs/DesignsAndPlans/RefinanceOldLenderOverpayFix.md).
     *         - Releases old collateral back to alice.
     *         - Checks post-refinance HF and LTV on new loan.
     *         - Updates old loan NFTs and marks old loan Repaid.
     * @param oldLoanId The current loan ID to refinance.
     * @param borrowerOfferId The Borrower Offer ID that alice created and Lender B accepted.
     */
    /// @notice T-092-H (#549) — `msg.sender == address(this)` gate.
    ///         Used by {refinanceLoanFromAccept} so the atomic chain
    ///         from `OfferAcceptFacet` + `OfferMatchFacet` is the
    ///         ONLY way to reach the internal entry; an external EOA
    ///         cannot call it directly.
    error OnlyDiamondInternal();
    /// @dev Extracted modifier body — same shape as VaultFactoryFacet's
    ///      `_checkDiamondInternal`. Keeps the modifier a thin wrapper
    ///      so each call site inlines one function call.
    function _checkDiamondInternal() private view {
        if (msg.sender != address(this)) revert OnlyDiamondInternal();
    }
    modifier onlyDiamondInternal() {
        _checkDiamondInternal();
        _;
    }

    /// @notice External entry — preserves the existing public API +
    ///         reentrancy guard for external callers (keeper EOAs,
    ///         borrower-direct path). Delegates to the shared private
    ///         logic.
    function refinanceLoan(
        uint256 oldLoanId,
        uint256 borrowerOfferId
    ) external nonReentrant whenNotPaused {
        _refinanceLoanLogic(oldLoanId, borrowerOfferId);
    }

    /// @notice T-092-H (#549) — atomic accept-and-refinance entry.
    ///         Callable only via `LibFacet.crossFacetCall` from
    ///         `OfferAcceptFacet._acceptOffer` + `OfferMatchFacet`'s
    ///         dust-close branch, AFTER `offer.accepted = true` is
    ///         set. No `nonReentrant` here — the outer `acceptOffer`
    ///         / `matchOffers` `nonReentrant` lock covers the whole
    ///         tx (see design doc §3.2 "Reentrancy analysis").
    ///         `whenNotPaused` retained — pause should freeze the
    ///         chain as well as the direct external path.
    function refinanceLoanFromAccept(
        uint256 oldLoanId,
        uint256 borrowerOfferId
    ) external onlyDiamondInternal whenNotPaused {
        _refinanceLoanLogic(oldLoanId, borrowerOfferId);
    }

    /// @dev Shared body for both external entries. Was the body of
    ///      `refinanceLoan` pre-T-092-H; extracted into a private so
    ///      both `refinanceLoan` (external nonReentrant) and
    ///      `refinanceLoanFromAccept` (external onlyDiamondInternal,
    ///      no nonReentrant) can share it.
    function _refinanceLoanLogic(
        uint256 oldLoanId,
        uint256 borrowerOfferId
    ) private {
        // T-090 v1.1 (#389) §5.8 — refinance withdraws old
        // collateral from `loan.borrower`'s vault before flipping
        // the old loan to Repaid; block while a v1.1 commit is live.
        LibVaipakam.assertNoLiveIntentCommit(oldLoanId);
        // Tier-1 sanctions gate — refinance routes funds + creates
        // new loan state for msg.sender; sanctioned wallet blocked.
        LibVaipakam._assertNotSanctioned(msg.sender);
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        LibVaipakam.Loan storage oldLoan = s.loans[oldLoanId];
        // Phase 6: borrower-entitled strategic flow. Authority binds to the
        // current borrower-NFT owner OR a keeper with the Refinance action
        // bit.
        LibAuth.requireKeeperFor(
            LibVaipakam.KEEPER_ACTION_REFINANCE,
            oldLoan,
            /* lenderSide */ false
        );
        if (oldLoan.status != LibVaipakam.LoanStatus.Active)
            revert LoanNotActive();
        // T-092 Phase 2a (#505) — resolve the current borrower-NFT
        // owner once at the top + Tier-1 sanctions check it. A
        // keeper-driven path admitted by requireKeeperFor uses
        // currentBorrowerNftOwner as the actual fund source, so
        // their sanctions status must be screened too. Without this
        // gate, a sanctioned borrower could use an unsanctioned
        // keeper to complete refinance — bypassing OFAC screening
        // on the fund-receiving wallet.
        address currentBorrowerNftOwner =
            LibERC721.ownerOf(oldLoan.borrowerTokenId);
        if (currentBorrowerNftOwner != msg.sender) {
            LibVaipakam._assertNotSanctioned(currentBorrowerNftOwner);
            // T-092 #508 — admin kill switch only fires on the
            // KEEPER-DRIVEN path. The borrower-NFT owner calling
            // directly is acting in their own interest; the kill
            // switch exists to protect against keeper-path bugs.
            if (!s.protocolCfg.cfgAutoRefinanceEnabled) {
                revert AutoRefinanceDisabled();
            }
        }
        // NFT rental refinance not supported in Phase 1 (requires NFT custody transfer)
        if (oldLoan.assetType != LibVaipakam.AssetType.ERC20)
            revert InvalidRefinanceOffer();

        // T-034 §4.6 — settle-first guard. If the old loan has a
        // Periodic Interest Payment cadence AND the current period is
        // overdue past its grace window, the original lender is owed
        // interest right now. Refinance must NOT overwrite the loan's
        // state until that obligation is settled — otherwise the new
        // lender's terms (different rate / cadence / start time)
        // would silently extinguish the original lender's claim.
        // Caller resolves by running `settlePeriodicInterest` on the
        // old loan first; that path either just-stamps (no shortfall)
        // or auto-liquidates (covers the shortfall to the lender),
        // and refinance can then proceed cleanly.
        if (
            oldLoan.periodicInterestCadence !=
            LibVaipakam.PeriodicInterestCadence.None
        ) {
            uint256 graceEndsAt = LibPeriodicInterest.settleAllowedFromAt(oldLoan);
            if (block.timestamp >= graceEndsAt) {
                revert IVaipakamErrors.RefinanceRequiresPeriodSettle(
                    oldLoanId,
                    graceEndsAt
                );
            }
        }

        // Validate: must be a Borrower offer created by the current
        // borrower-NFT owner, already accepted. T-092 Phase 2a — the
        // creator check binds to the current NFT holder, not
        // msg.sender, so a keeper-driven invocation succeeds when
        // the borrower (NFT owner) created the offer.
        LibVaipakam.Offer storage offer = s.offers[borrowerOfferId];
        if (
            offer.offerType != LibVaipakam.OfferType.Borrower ||
            offer.creator != currentBorrowerNftOwner
        ) revert InvalidRefinanceOffer();
        // T-092 Phase 2b (Codex round-1 P1) — when the offer was
        // created with a refinance target, that target MUST match
        // the `oldLoanId` being refinanced. Otherwise a keeper could
        // accept an offer tagged for loan A and then call
        // `refinanceLoan(B, offerA)`, bypassing the cap-check that
        // was tied to loan A at accept time. Untagged offers
        // (`refinanceTargetLoanId == 0`) still work — those are the
        // legacy / borrower-direct path where caps don't apply.
        if (
            offer.refinanceTargetLoanId != 0 &&
            offer.refinanceTargetLoanId != oldLoanId
        ) revert InvalidRefinanceOffer();
        // T-092 Phase 2b round-3 P2 — when the keeper-driven path is
        // taken, the offer MUST be refinance-tagged. Otherwise a
        // keeper could pick any compatible borrower offer (e.g. a
        // standard one the borrower posted for a fresh loan) and
        // refinance through it — bypassing every cap-check in
        // `LibAutoRefinanceCheck` because they only fire on tagged
        // offers. The borrower-NFT owner direct path can use any
        // offer (caps don't apply to them; they're acting in their
        // own interest).
        if (
            msg.sender != currentBorrowerNftOwner &&
            offer.refinanceTargetLoanId == 0
        ) revert InvalidRefinanceOffer();
        if (!offer.accepted) revert OfferNotAccepted();
        // Range-aware amount check: legacy single-value offers satisfy
        // `amount == amountMax`; range offers satisfy
        // `amount <= oldLoan.principal <= amountMax` (the borrower's
        // range must accommodate the existing loan's principal). With
        // auto-collapse (`amountMax == 0` → treated as `amount`),
        // legacy single-value offers fall through to the original
        // `offer.amount >= oldLoan.principal` check unchanged.
        uint256 effAmountMax = offer.amountMax == 0
            ? offer.amount
            : offer.amountMax;
        if (offer.amount > oldLoan.principal || oldLoan.principal > effAmountMax)
            revert InvalidRefinanceOffer();
        // Range Orders Phase 1 — single source of truth for the per-
        // asset invariants (lendingAsset / collateralAsset /
        // collateralAssetType / prepayAsset). README: same lending,
        // collateral, and prepay asset types as original loan.
        if (!LibOfferMatch.assertAssetContinuity(oldLoan, offer))
            revert InvalidRefinanceOffer();

        // Find the new loan created when Lender B accepted alice's offer
        uint256 newLoanId = s.offerIdToLoanId[borrowerOfferId];
        if (newLoanId == 0) revert InvalidRefinanceOffer();
        LibVaipakam.Loan storage newLoan = s.loans[newLoanId];
        address newLender = newLoan.lender;

        // ── Repay old lender ──────────────────────────────────────────────
        // alice already received new principal from Lender B (via acceptOffer).
        // README: repay old lender with principal + full-term interest.
        // (Early-repayment rules — the exiting lender receives full-term
        // interest, which is the maximum they could have earned on this
        // loan, so they are strictly whole.)
        uint256 oldInterest = LibEntitlement.fullTermInterest(
            oldLoan.principal,
            oldLoan.interestRateBps,
            oldLoan.durationDays
        );

        // #411 fix (2026-06-12) — DROPPED the rate-shortfall addend
        // that previously over-compensated the exiting old lender at
        // borrower expense. Spec §2127 / §2138 (the "Original Lender
        // Protection Rule") historically required a shortfall =
        // `oldFullTerm - newFullTerm` top-up on top of full-term
        // interest. But full-term IS the lender's maximum possible
        // earnings on this loan; paying ANY additional shortfall
        // pushes them BEYOND their ceiling, funded by the borrower
        // (`oldInterest + shortfall = P + 2·oldFullTerm − newFullTerm`).
        //
        // The Protection Rule is structurally satisfied by paying
        // `principal + full-term interest` to an exiting lender —
        // they are strictly whole at their maximum entitlement.
        //
        // The shortfall is still NECESSARY on the obligation-transfer
        // / offset paths (`PrecloseFacet.transferObligationViaOffer`)
        // where the lender STAYS on the loan and earns the NEW rate
        // going forward — there the shortfall genuinely bridges back
        // up to the original full-term. Refinance differs because the
        // old lender exits (`s.lenderClaims[oldLoanId]` is set and the
        // old loan closes). Refinance-path only fix; transfer/offset
        // shortfall unchanged.
        //
        // Design doc:
        // `docs/DesignsAndPlans/RefinanceOldLenderOverpayFix.md`
        // (Option 1 selected 2026-06-07).
        //
        // The `shortfall` local is retained at 0 to keep the
        // `LoanRefinanced` event signature byte-identical — indexers
        // continue to decode the field, just always read 0 post-fix.

        // Treasury fee on interest portion (1% of interest).
        // Lender Yield Fee discount (Tokenomics §6): when the old lender has
        // platform-level VPFI-discount consent AND holds >= the required VPFI
        // in vault, the treasury cut is paid in VPFI from the old lender's
        // vault and the old lender keeps 100% of interestPortion in the
        // lending asset. tryApplyYieldFee silently falls back on any
        // precondition failure.
        uint256 shortfall = 0; // #411 fix — see comment above.
        uint256 interestPortion = oldInterest;
        (uint256 treasuryFee, uint256 lenderInterest) = LibEntitlement.splitTreasury(
            interestPortion
        );
        uint256 yieldVpfiDeducted;
        if (s.vpfiDiscountConsent[oldLoan.lender] && treasuryFee > 0) {
            bool yieldApplied;
            (yieldApplied, yieldVpfiDeducted) = LibVPFIDiscount.tryApplyYieldFee(
                oldLoan,
                interestPortion
            );
            if (yieldApplied) {
                lenderInterest = interestPortion;
                treasuryFee = 0;
            }
        }
        uint256 lenderDue = oldLoan.principal + lenderInterest;

        // T-037 — pay each party directly from the borrower without
        // the Diamond holding the asset between transfers. The
        // borrower's prior `approve()` to the Diamond covers the
        // total; two `safeTransferFrom` calls (one to treasury, one
        // to the old lender's vault) replace the prior pull-and-
        // split pattern. Treasury share skipped entirely if the
        // VPFI-discount path satisfied it.
        // T-092 Phase 2a — fund-source is the CURRENT borrower-NFT
        // owner (not msg.sender) so a keeper-driven invocation
        // doesn't debit the keeper's wallet for the borrower's
        // old-payoff. Requires the borrower (NFT holder) to have
        // approved the diamond for `oldLoan.principalAsset` —
        // standard prerequisite for a refinance, surfaced by the
        // dapp as part of the consent flow.
        //
        // T-092-A (#530) — operational loan netting is preserved
        // via the existing wallet-pull path: `OfferAcceptFacet`
        // routes the new lender's principal to the borrower's
        // WALLET on accept (line 840 in OfferAcceptFacet), and the
        // refinance immediately pulls from the same wallet to pay
        // the old loan. The standing approval set at consent time
        // means no Metamask popup at refinance time — the keeper-
        // driven path works fully automatically. A vault-first
        // optimisation was attempted in this PR but reverted (PR
        // #538 round-1 Codex P2): `protocolTrackedVaultBalance` is
        // an aggregate counter that includes funds locked in active
        // lender offers (deposited via `OfferCreateFacet.
        // _pullCreatorAssetsClassic`), so a vault-first netting
        // could double-spend committed funds. True vault-first
        // requires an invariant-preserving locked-balance tracking
        // shape that's out of scope here.
        if (treasuryFee > 0) {
            IERC20(oldLoan.principalAsset).safeTransferFrom(
                currentBorrowerNftOwner,
                LibFacet.getTreasury(),
                treasuryFee
            );
            LibFacet.recordTreasuryAccrual(oldLoan.principalAsset, treasuryFee);
        }

        // Route lender's share to old lender's vault via the cross-
        // payer chokepoint so the protocolTrackedVaultBalance
        // counter ticks under the old lender (the vault owner)
        // while the current borrower-NFT owner remains the payer.
        LibFacet.crossFacetCall(
            abi.encodeWithSelector(
                VaultFactoryFacet.vaultDepositERC20From.selector,
                currentBorrowerNftOwner, // payer — current borrower NFT holder
                oldLoan.lender,          // user — old lender's vault
                oldLoan.principalAsset,
                lenderDue
            ),
            VaultDepositFailed.selector
        );

        // Record lender's claimable. heldForLender handled by ClaimFacet.
        s.lenderClaims[oldLoanId] = LibVaipakam.ClaimInfo({
            asset: oldLoan.principalAsset,
            amount: lenderDue,
            assetType: LibVaipakam.AssetType.ERC20,
            tokenId: 0,
            quantity: 0,
            claimed: false
        });

        // T-086 follow-up to step 14 — clear any active prepay listing on
        // the OLD loan BEFORE the collateral withdrawal below. Placement
        // matters here: `LibPrepayCleanup.clearActiveListing` calls
        // `vault.setCollateralOperatorApproval(..., approved=false)` on
        // ERC721 collateral, which performs `IERC721.approve(address(0),
        // tokenId)` from the vault. After the collateral has been
        // withdrawn out of the vault (lines below), the vault is no
        // longer the token owner and standard ERC721s revert that approve
        // call — leaving refinance permanently broken for ERC721
        // collateral loans that carry a live listing.
        //
        // Refinance is gated on `oldLoan.assetType == ERC20` upstream
        // (line ~109) so rental loans never reach here; for the
        // ERC20-principal + NFT-collateral case this is the right
        // moment: principal-asset payments to the old lender have
        // already committed (so we know the borrower paid), no
        // collateral has been touched yet, and the listing's
        // bookkeeping can be cleared while the vault still owns the
        // NFT. Idempotent no-op when no listing is live.
        // Codex round-1 P1 fix on PR #317.
        LibPrepayCleanup.clearActiveListing(oldLoan, oldLoanId);

        // ── Release old collateral ────────────────────────────────────────
        // T-092 Phase 2a — old collateral lives in the current
        // borrower-NFT owner's vault (auto-provisioned if absent via
        // `getOrCreateUserVault` inside `vaultWithdrawERC20`) and is
        // released back to the same owner. Using msg.sender here
        // (the pre-Phase-2a behaviour) would mis-route on the
        // keeper-driven path — the keeper's vault doesn't hold the
        // collateral, and the keeper isn't the rightful recipient.

        // #407 PR 4 (T-407-B, 2026-06-12) — release the OLD loan's
        // collateral lien BEFORE the actual vault withdraw of the same
        // collateral. The chokepoint guard in
        // {VaultFactoryFacet.vaultWithdrawERC20} would otherwise block
        // this legitimate refinance-driven collateral return. Safe
        // under revert: any downstream revert in this function rolls
        // back the lien-release storage write. Wrapped in a private
        // helper to keep the `abi.encodeWithSelector` locals in their
        // own stack frame — `_refinanceLoanLogic` already carries the
        // HF/LTV scaffolding + settlement math, so inlining could trip
        // viaIR's "Variable size 1 too deep".
        _releaseOldLienAtRefinance(oldLoanId);
        if (oldLoan.collateralAssetType == LibVaipakam.AssetType.ERC20) {
            uint256 oldCol = oldLoan.collateralAmount;
            if (oldCol > 0) {
                LibFacet.crossFacetCall(
                    abi.encodeWithSelector(
                        VaultFactoryFacet.vaultWithdrawERC20.selector,
                        currentBorrowerNftOwner,
                        oldLoan.collateralAsset,
                        currentBorrowerNftOwner,
                        oldCol
                    ),
                    VaultWithdrawFailed.selector
                );
            }
        } else if (oldLoan.collateralAssetType == LibVaipakam.AssetType.ERC721) {
            LibFacet.crossFacetCall(
                abi.encodeWithSelector(
                    VaultFactoryFacet.vaultWithdrawERC721.selector,
                    currentBorrowerNftOwner,
                    oldLoan.collateralAsset,
                    oldLoan.collateralTokenId,
                    currentBorrowerNftOwner
                ),
                VaultWithdrawFailed.selector
            );
        } else if (oldLoan.collateralAssetType == LibVaipakam.AssetType.ERC1155) {
            LibFacet.crossFacetCall(
                abi.encodeWithSelector(
                    VaultFactoryFacet.vaultWithdrawERC1155.selector,
                    currentBorrowerNftOwner,
                    oldLoan.collateralAsset,
                    oldLoan.collateralTokenId,
                    oldLoan.collateralQuantity,
                    currentBorrowerNftOwner
                ),
                VaultWithdrawFailed.selector
            );
        }

        // Post-refinance LTV + HF gates. Mirrors
        // `LoanFacet._checkInitialLtvAndHf` exactly so refinance can't
        // admit a position that would have been rejected at init —
        // both regimes (depth-tiered ON / OFF) must agree.
        //
        // Regime OFF (default / pre-flip): today's gate — `LTV ≤
        // assetRiskParams.loanInitMaxLtvBps` and `HF ≥ 1.5e18`.
        //
        // Regime ON (post-flip per chain): cap LTV at
        // `min(loanInitMaxLtvBps, effectiveTierMaxInitLtvBps[effectiveTier(
        // collateral)])` and relax HF floor to `≥ 1e18` (tier cap is
        // the binding buffer; see LoanFacet for full rationale).
        bytes memory ltvResult = LibFacet.crossFacetStaticCall(
            abi.encodeWithSelector(RiskFacet.calculateLTV.selector, newLoanId),
            LTVCalculationFailed.selector
        );
        uint256 newLtv = abi.decode(ltvResult, (uint256));
        uint256 loanInitMaxLtvBps = s
            .assetRiskParams[oldLoan.collateralAsset]
            .loanInitMaxLtvBps;
        bool tieredOn = LibVaipakam.cfgDepthTieredLtvEnabled();
        if (tieredOn) {
            uint8 effTier = OracleFacet(address(this))
                .getEffectiveLiquidityTier(oldLoan.collateralAsset);
            uint256 tierCap = uint256(
                LibVaipakam.effectiveTierMaxInitLtvBps(effTier)
            );
            uint256 cap = loanInitMaxLtvBps < tierCap ? loanInitMaxLtvBps : tierCap;
            if (newLtv > cap) {
                revert IVaipakamErrors.InitLtvAboveTier(newLtv, cap);
            }
        } else if (newLtv > loanInitMaxLtvBps) {
            revert LTVExceeded();
        }

        bytes memory hfResult = LibFacet.crossFacetStaticCall(
            abi.encodeWithSelector(
                RiskFacet.calculateHealthFactor.selector,
                newLoanId
            ),
            HealthFactorCalculationFailed.selector
        );
        uint256 newHf = abi.decode(hfResult, (uint256));
        // Tier-ON ⇒ HF ≥ 1.0 (not born already-liquidatable; the tier
        // cap is the binding buffer). Tier-OFF ⇒ legacy HF ≥ 1.5.
        uint256 hfFloor = tieredOn
            ? LibVaipakam.HF_LIQUIDATION_THRESHOLD
            : LibVaipakam.MIN_HEALTH_FACTOR;
        if (newHf < hfFloor) revert HealthFactorTooLow();

        // Update old loan NFTs: mark lender NFT as Loan Repaid
        LibFacet.crossFacetCall(
            abi.encodeWithSelector(
                VaipakamNFTFacet.updateNFTStatus.selector,
                oldLoan.lenderTokenId,
                oldLoanId,
                LibVaipakam.LoanPositionStatus.LoanRepaid
            ),
            NFTStatusUpdateFailed.selector
        );
        // Preserve old borrower NFT as a LoanRepaid-status receipt so the
        // borrower retains a redeemable claim on the original position even
        // after refinancing into a new loan.
        LibFacet.crossFacetCall(
            abi.encodeWithSelector(
                VaipakamNFTFacet.updateNFTStatus.selector,
                oldLoan.borrowerTokenId,
                oldLoanId,
                LibVaipakam.LoanPositionStatus.LoanRepaid
            ),
            NFTStatusUpdateFailed.selector
        );

        // Mark old loan closed — refinance only operates on Active loans.
        LibLifecycle.transition(
            oldLoan,
            LibVaipakam.LoanStatus.Active,
            LibVaipakam.LoanStatus.Repaid
        );
        // #407 PR 4 (T-407-B, 2026-06-12) — collateral lien release
        // moved to BEFORE the old-collateral withdraw above so the
        // {VaultFactoryFacet.vaultWithdrawERC20} guard clears. See the
        // explanatory comment at the new call site.

        // Phase 5 / §5.2b — proper-close settlement for the OLD loan's
        // borrower LIF VPFI path. The borrower earned the rebate over
        // the old loan's live period; the new loan gets a fresh anchor
        // via _snapshotBorrowerDiscount inside its own initiateLoan path
        // (and, if the new loan also takes the VPFI fee path, that will
        // register its own vpfiHeld against the new loan id).
        LibVPFIDiscount.settleBorrowerLifProper(oldLoan);

        // T-092 Phase 2a (Codex round-1 P2) — emit the current
        // borrower-NFT owner as the borrower (not msg.sender) so
        // keeper-driven refinances attribute the row to the actual
        // borrower in indexers / activity feeds, matching the fund-
        // flow change above.
        emit LoanRefinanced(
            oldLoanId,
            newLoanId,
            currentBorrowerNftOwner,
            oldLoan.lender,
            newLender,
            shortfall,
            uint8(oldLoan.status)
        );

        // Passthrough event for lender yield-fee VPFI discount so indexers
        // subscribe to a single facet for all VPFI-discount analytics.
        if (yieldVpfiDeducted > 0) {
            LibFacet.crossFacetCall(
                abi.encodeWithSelector(
                    VPFIDiscountFacet.emitYieldFeeDiscountApplied.selector,
                    oldLoanId,
                    oldLoan.lender,
                    oldLoan.principalAsset,
                    yieldVpfiDeducted
                ),
                TreasuryTransferFailed.selector
            );
        }
    }

    /// @dev #407 PR 4 (T-407-B, 2026-06-12) — see the comment at the
    ///      call site in `_refinanceLoanLogic`. Extracted into a
    ///      private function to keep the cross-facet release-call's
    ///      transient locals in their own stack frame.
    function _releaseOldLienAtRefinance(uint256 oldLoanId) private {
        LibFacet.crossFacetCall(
            abi.encodeWithSelector(
                EncumbranceMutateFacet.releaseCollateralLien.selector,
                oldLoanId
            ),
            bytes4(0)
        );
    }
}
