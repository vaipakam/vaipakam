// src/facets/RefinanceFacet.sol
// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {LibVaipakam} from "../libraries/LibVaipakam.sol";
import {LibEncumbrance} from "../libraries/LibEncumbrance.sol";
import {LibAutoRefinanceCheck} from "../libraries/LibAutoRefinanceCheck.sol";
import {LibLifecycle} from "../libraries/LibLifecycle.sol";
import {LibInteractionRewards} from "../libraries/LibInteractionRewards.sol";
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
import {ConsolidationFacet} from "./ConsolidationFacet.sol";
import {LibERC721} from "../libraries/LibERC721.sol";
import {LibSanctionedLock} from "../libraries/LibSanctionedLock.sol";

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

        // #658 PR-B (#594 arc) — eagerly consolidate the LENDER side of the
        // exiting old loan to its current lender-NFT holder while the old loan
        // is still Active (the primitive no-ops once terminal). The old lender
        // EXITS at refinance regardless of branch (`s.lenderClaims[oldLoanId]`
        // is set and the old loan closes below), so its accrued reward entry +
        // VPFI checkpoint must follow the current holder before the close.
        // Funds are already current-holder-safe (the exit payout routes via
        // `lenderClaims` → `ClaimFacet`, `ownerOf`-gated). The BORROWER side is
        // consolidated separately, gated to the NON-carry-over branch below
        // (Codex #690 round-2 P2): on carry-over the borrower stays and its
        // collateral is re-tagged into the new loan (no close-out), but on the
        // legacy path the old collateral is returned and the old loan closes
        // for the borrower too — so the borrower's position effects must follow
        // the current holder there. Size-tight facet → few-byte cross-facet
        // entry (Tier2 skip-not-block).
        LibFacet.crossFacetCall(
            abi.encodeWithSelector(
                ConsolidationFacet.eagerConsolidateToHolder.selector,
                oldLoanId,
                /* isLenderSide */ true
            ),
            bytes4(0)
        );

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
        // #1003 (S7) — settle the exiting lender's interest MODE-AWARE, through
        // the SAME `settlementInterestNet` the preclose path uses, instead of an
        // unconditional full-term charge. The two "early close" doors
        // (preclose / refinance) must agree:
        //   • useFullTermInterest == true  → full-term (the floor is the
        //     remaining committed term, so the exiting lender receives their
        //     maximum and is strictly whole — the historical behaviour), on the
        //     #641 interest-clock remaining term, not the immutable durationDays.
        //   • useFullTermInterest == false → accrued-only (pro-rata): a borrower
        //     who OPTED INTO pro-rata must not be punished with full-term just
        //     because they refinance rather than repay directly.
        // `...Net` also credits any periodic `interestSettled` (paid once).
        uint256 oldInterest = LibEntitlement.settlementInterestNet(
            oldLoan,
            block.timestamp
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
            oldLoan,
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
        //
        // #998 S10 (#1006) F2 — the old lender is being CLOSED OUT (their loan is
        // repaid by the refinance); their proceeds must be PARKED, never brick the
        // (clean) borrower's refinance, even when the old lender-of-record is a
        // sanctions-flagged current holder (#831 freeze-not-seize). Pin the
        // receive-side vault exemption to `oldLoan.lender` so the deposit resolves
        // that party's EXISTING vault instead of reverting the whole refinance
        // under `getOrCreateUserVault`'s Tier-1 gate. Without this a flagged old
        // lender-holder would brick every refinance of their loan — and the
        // frozen-claimant marker below (which keys the fail-closed release) would
        // be unreachable. `end` clears the pin and emits the parked-proceeds audit
        // event when that vault owner is flagged; the lock itself is enforced by
        // the claim-side stored-owner screen + the marker.
        LibSanctionedLock.begin(s, oldLoan.lender);
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
        LibSanctionedLock.end(
            s, oldLoan.lender, oldLoanId, oldLoan.principalAsset, lenderDue
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
        // #592 — refinance is a terminal close of the OLD loan: the old
        // lender's proceeds land in their (possibly transferred-away) vault and
        // are owed to the current old-position holder via the claim above.
        // Reserve VPFI proceeds against the unstake path until that holder
        // claims (released path-agnostically in ClaimFacet). `oldLoan.lender`
        // is fixed for the now-terminal old loan. No-op for non-VPFI principal.
        if (oldLoan.principalAsset == s.vpfiToken) {
            LibEncumbrance.encumberLenderProceeds(
                oldLoanId, oldLoan.lender, oldLoan.principalAsset, lenderDue
            );
        }
        // #998 S10 (#1006) F2 — refinance terminally closes the OLD loan and parks
        // the old lender's proceeds into `oldLoan.lender`'s vault, owed to the
        // CURRENT lender-position holder via the claim recorded above. Unlike the
        // borrower side (whose returned collateral goes to the caller, already
        // Tier-1-screened at the refinance entry), the old lender is NOT the caller
        // and its position may have been transferred to a flagged wallet. Record
        // the fail-closed frozen-claimant marker (keyed to the current holder, iff
        // affirmatively flagged) so that holder's later claim can't release during
        // an oracle outage. Inlined (RefinanceFacet has ample EIP-170 headroom, per
        // the inline-where-possible policy); no-op for a clean/absent holder. The
        // old lender NFT is only status-updated (not burned) further below, so
        // `ownerOf(lenderTokenId)` still resolves here.
        LibSanctionedLock.recordFrozenClaimantForLoan(s, oldLoan, true);

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

        // ── Collateral handling — carry-over vs legacy ──
        // #576 — a CARRY-OVER refinance (tagged + NON-transferred +
        // single-value, per `LibAutoRefinanceCheck.isCarryOver`) reuses the OLD
        // loan's collateral IN PLACE: OfferCreateFacet skipped the fresh deposit
        // + escrow and LoanFacet skipped the fresh lien (all keyed off the same
        // predicate), so the collateral is already in the borrower's vault and
        // we just RETAG the lien old→new (`sameKey` — no aggregate change, no
        // 2x lock). Because carry-over is NON-transferred, `newLoan.borrower`
        // (= offer.creator) already equals `oldLoan.borrower`, so the loan was
        // born correct — no post-init pin, no event/index/reward divergence.
        //
        // Everything else — untagged (legacy direct), TRANSFERRED tagged, or
        // RANGED tagged — pledged a fresh collateral batch at create and carries
        // its own fresh lien, so it takes the legacy path: release the old lien
        // and return the old collateral to the current borrower-position holder.
        // Reads the PERSISTED create-time decision on the offer — the same
        // flag the deposit/lien skips keyed off, so retag-vs-legacy can't
        // disagree with whether a fresh batch was actually deposited.
        LibVaipakam.Offer storage bOffer = s.offers[borrowerOfferId];
        if (bOffer.refinanceCarryOver) {
            // Validate the FULL collateral identity matches the old loan (Codex
            // round-1 P2). The tag check only proved asset + type, so without
            // this a borrower could advertise a different amount / tokenId /
            // quantity that a lender accepts, then end up backed by the OLD
            // collateral instead (no LTV gate catches NFT/illiquid mismatch).
            // Reverting unwinds the whole atomic accept-and-refinance.
            if (
                newLoan.collateralAsset != oldLoan.collateralAsset ||
                newLoan.collateralAssetType != oldLoan.collateralAssetType ||
                newLoan.collateralAmount != oldLoan.collateralAmount ||
                newLoan.collateralTokenId != oldLoan.collateralTokenId ||
                newLoan.collateralQuantity != oldLoan.collateralQuantity
            ) revert InvalidRefinanceOffer();
            // Require the OLD loan's lien to be LIVE (Codex round-1 P2):
            // `rekeyCollateralLienOnRefinance` silently no-ops on a missing /
            // released lien, which would leave the carried collateral
            // UNENCUMBERED under the new loan (withdrawable before close). Every
            // ERC-20 loan post-#565 carries a lien, so this only fires on a
            // genuinely un-encumbered position — fail closed.
            LibVaipakam.Encumbrance storage oldLien = s.loanCollateralLien[oldLoanId];
            if (oldLien.released || oldLien.user == address(0)) {
                revert InvalidRefinanceOffer();
            }
            // #576 Codex round-7 P1 — the retag is STRICT: it only succeeds when
            // the old lien's key matches the new loan EXACTLY (same user, asset,
            // tokenId, amount, kind). If the target obligation migrated to a
            // different borrower since this carry-over offer was created (the
            // old lien is now keyed to the migrated-in borrower, the new loan's
            // borrower is the original creator after the borrower NFT returns to
            // them), the keys diverge; falling back to release+create would
            // back the replacement loan with an accounting-only lien against an
            // empty vault (the carry-over offer pledged no fresh collateral).
            // Reject the stale carry-over instead — fail closed.
            if (
                !LibEncumbrance.rekeyCollateralLienOnRefinance(
                    oldLoanId, newLoanId, newLoan
                )
            ) {
                revert InvalidRefinanceOffer();
            }
        } else {
            // #658 PR-B (#594 arc, Codex #690 round-2 P2) — NON-carry-over is a
            // real borrower close-out: the old collateral is returned and the
            // old loan goes Repaid. Consolidate the BORROWER side to its current
            // holder FIRST (while still Active), so the collateral lien, reward
            // entry, and VPFI checkpoint follow the holder and
            // `settleBorrowerLifProper(oldLoan)` later prices the LIF rebate from
            // the current holder, not the departed stored borrower. After the
            // re-anchor `oldLoan.borrower` IS the current holder, so the
            // release+withdraw below sources from the right vault. (Done only on
            // this branch — carry-over keeps the borrower + re-tags the
            // collateral, so a borrower consolidation there would be a no-op at
            // best and fight the re-tag at worst.)
            LibFacet.crossFacetCall(
                abi.encodeWithSelector(
                    ConsolidationFacet.eagerConsolidateToHolder.selector,
                    oldLoanId,
                    /* isLenderSide */ false
                ),
                bytes4(0)
            );
            // Legacy: release the old lien BEFORE the withdraw (the chokepoint
            // guard would otherwise block the legitimate refinance return).
            // The old collateral lives in `oldLoan.borrower`'s vault (the
            // custody key — now the consolidated current holder); deliver it to
            // `currentBorrowerNftOwner` (the rightful current holder).
            _releaseOldLienAtRefinance(oldLoanId);
            if (oldLoan.collateralAssetType == LibVaipakam.AssetType.ERC20) {
                uint256 oldCol = oldLoan.collateralAmount;
                if (oldCol > 0) {
                    LibFacet.crossFacetCall(
                        abi.encodeWithSelector(
                            VaultFactoryFacet.vaultWithdrawERC20.selector,
                            oldLoan.borrower,
                            oldLoan.collateralAsset,
                            currentBorrowerNftOwner,
                            oldCol
                        ),
                        VaultWithdrawFailed.selector
                    );
                    // #658 PR-B — the borrower-side consolidation above
                    // checkpointed the current holder's VPFI at the FULL
                    // pre-return balance; this withdraw just removed the VPFI
                    // collateral from their vault, so a post-withdraw re-stamp is
                    // owed. It is DEFERRED to after `settleBorrowerLifProper`
                    // below (Codex #690 round-6 P2): re-stamping here would roll
                    // the discount accumulator down to the post-return balance
                    // before the LIF rebate is priced, underpaying a borrower who
                    // held the VPFI for the whole old-loan term.
                }
            } else if (oldLoan.collateralAssetType == LibVaipakam.AssetType.ERC721) {
                LibFacet.crossFacetCall(
                    abi.encodeWithSelector(
                        VaultFactoryFacet.vaultWithdrawERC721.selector,
                        oldLoan.borrower,
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
                        oldLoan.borrower,
                        oldLoan.collateralAsset,
                        oldLoan.collateralTokenId,
                        oldLoan.collateralQuantity,
                        currentBorrowerNftOwner
                    ),
                    VaultWithdrawFailed.selector
                );
            }
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
        // #394 Lever A (Codex #647 round-4) — compare against the replacement
        // loan's SNAPSHOTTED admission init-LTV cap (acceptOffer stored it when
        // it admitted `newLoan`; the snapshot already encodes the tiered
        // `min(assetCap, tierCap)` vs non-tiered `assetCap` branch), NOT a
        // freshly-recomputed live asset/tier cap. Re-deriving live would make a
        // governance / tier-cache tightening between accept and `refinanceLoan`
        // retroactive, stranding an accepted replacement loan the borrower can't
        // close into — exactly the race the HF gate below also closes.
        uint256 cap = LibVaipakam.effectiveLoanInitLtvCapBps(
            newLoan.initLtvCapBpsAtInit,
            s.assetRiskParams[oldLoan.collateralAsset].loanInitMaxLtvBps
        );
        if (newLtv > cap) {
            // Preserve the regime-specific error (cosmetic; the cap value is the
            // load-bearing part and comes from the snapshot either way).
            if (LibVaipakam.cfgDepthTieredLtvEnabled()) {
                revert IVaipakamErrors.InitLtvAboveTier(newLtv, cap);
            }
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
        // #394 Lever A (Codex #647 round-2 P2) — `acceptOffer` already created
        // and ADMITTED `newLoan`, snapshotting the (branch-aware) floor it was
        // gated at onto `newLoan.minHealthFactorAtInit`. Compare against THAT
        // snapshot, not the live `minHealthFactor()` knob: re-reading the live
        // knob here would make a governance retune between accept and
        // `refinanceLoan` retroactive — a replacement loan accepted at HF ≥ 1.5
        // could revert if the floor were raised to 1.8 first, stranding the
        // borrower with an accepted replacement they cannot close into. The
        // snapshot already encodes the tiered (1e18) vs non-tiered branch.
        uint256 hfFloor =
            LibVaipakam.effectiveLoanMinHealthFactor(newLoan.minHealthFactorAtInit);
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
        // #969 / S5 (#998 Tranche 2) — close the OLD loan's reward entries. The
        // new refinanced loan (`newLoanId`) already registered its own fresh
        // entries at initiation, so leaving the old entries open double-counted
        // the same principal in both the numerator AND the denominator. The
        // exiting old lender is paid in full and never forfeits. The borrower
        // rolls into the new loan — CLEAN only when the refinance happens IN
        // GRACE; a late refinance (past grace, before default was triggered) is a
        // non-clean close and forfeits the old borrower reward, matching the
        // preclose/repay convention (Codex #1061 P2).
        uint256 oldGraceEnd = oldLoan.startTime
            + oldLoan.durationDays * LibVaipakam.ONE_DAY
            + LibVaipakam.gracePeriod(oldLoan.durationDays);
        LibInteractionRewards.closeLoan(
            oldLoanId,
            /* borrowerClean */ block.timestamp <= oldGraceEnd,
            /* lenderForfeit */ false
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

        // #658 PR-B (Codex #690 round-6 P2) — NOW re-stamp the borrower's VPFI,
        // AFTER the LIF rebate is priced above. On the non-carry-over path with
        // VPFI collateral, the borrower-side consolidation checkpointed the
        // holder at the full balance and the legacy return (above) withdrew that
        // VPFI out of the vault; re-stamping here keeps the holder from retaining
        // fee-tier / staking credit on VPFI that has left, without skewing the
        // just-settled rebate. Gated to the non-carry-over VPFI-collateral case
        // (carry-over keeps the collateral in place, so nothing left the vault).
        if (
            !bOffer.refinanceCarryOver &&
            oldLoan.collateralAsset == s.vpfiToken
        ) {
            LibFacet.crossFacetCall(
                abi.encodeWithSelector(
                    ConsolidationFacet.restampUserVpfiInternal.selector,
                    oldLoan.borrower
                ),
                bytes4(0)
            );
        }

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

    /// @dev #407 PR 4 (T-407-B) — release the OLD loan's collateral lien
    ///      before the legacy refinance return-withdraw of the same
    ///      collateral (the chokepoint guard would otherwise block it).
    ///      Used only on the UNTAGGED (legacy) refinance path; the tagged
    ///      carry-over path retags the lien instead (#576). Extracted to
    ///      keep the cross-facet call's transient locals in their own stack
    ///      frame.
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
