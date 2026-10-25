// src/facets/AddCollateralFacet.sol
// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {LibVaipakam} from "../libraries/LibVaipakam.sol";
import {LibLifecycle} from "../libraries/LibLifecycle.sol";
import {LibAuth} from "../libraries/LibAuth.sol";
import {LibConsolidation} from "../libraries/LibConsolidation.sol";
import {LibFacet} from "../libraries/LibFacet.sol";
import {DiamondReentrancyGuard} from "../libraries/LibReentrancyGuard.sol";
import {IVaipakamErrors} from "../interfaces/IVaipakamErrors.sol";
import {OracleFacet} from "./OracleFacet.sol";
import {RiskFacet} from "./RiskFacet.sol";
import {VaipakamNFTFacet} from "./VaipakamNFTFacet.sol";
import {VaultFactoryFacet} from "./VaultFactoryFacet.sol";
import {EncumbranceMutateFacet} from "./EncumbranceMutateFacet.sol";
import {LibSanctionedLock} from "../libraries/LibSanctionedLock.sol";
import {LibFallbackCustody} from "../libraries/LibFallbackCustody.sol";

/**
 * @title AddCollateralFacet
 * @author Vaipakam Developer Team
 * @notice This facet allows borrowers to add more ERC-20 collateral to active loans in the Vaipakam P2P lending platform.
 * @dev Part of the Diamond Standard (EIP-2535). Uses shared LibVaipakam storage.
 *      Enables borrowers with liquid collateral loans to proactively reduce LTV and avoid liquidation
 *      when their collateral value is declining (Phase 1 Addition per README Section "Allow Borrower to Add Collateral").
 *      Only supports ERC-20 liquid collateral (same type as the existing loan collateral).
 *      Adding collateral always improves Health Factor and reduces LTV, so no minimum threshold is enforced.
 *      Transfers additional collateral directly into borrower's vault proxy and updates loan.collateralAmount.
 *      Custom errors, events, ReentrancyGuard, Pausable. Cross-facet calls for vault and risk calculations.
 *      Callable only by the borrower of the loan. Expand for Phase 2 (e.g., multi-collateral types).
 *
 *      FallbackPending cure (#1566 slice 2): the fallback custody already rests in
 *      `loan.borrower`'s vault under the collateral lien (the `fallbackVaultCustody`
 *      row), so a cure moves no tokens; see {_cureFallback}.
 *      REFRESH TOGETHER: {FallbackCustodyFacet, RiskFacet, DefaultedFacet, ClaimFacet,
 *      AddCollateralFacet, RepayFacet, RiskMatchLiquidationFacet} share that one custody
 *      rule. Pre-slice-2 code here would pay a cured row out of the Diamond's own balance
 *      although slice-2 producers left it in the vault; this code refuses a Diamond-held
 *      row by name (`FallbackCustodyNotVaultHeld`).
 */
contract AddCollateralFacet is DiamondReentrancyGuard, IVaipakamErrors {
    // ─── Events ───────────────────────────────────────────────────────────────

    /// @notice Emitted when a FallbackPending loan is cured by a collateral
    ///         top-up that restores HF above MIN_HEALTH_FACTOR. The fallback
    ///         custody, which stayed in the borrower's vault under the lien
    ///         (#1566 slice 2), has returned to the ordinary pledge (the
    ///         `FallbackCustodyMoved` `ReturnedToPledge` row move) and the
    ///         snapshot is cleared; the loan is Active.
    /// @dev    `restoredCollateralAmount` is the loan's whole collateral after
    ///         the cure (`loan.collateralAmount`, every top-up included), not
    ///         the custody row alone; the row amount is on the
    ///         `FallbackCustodyMoved` event.
    /// @custom:event-category state-change/loan-mutation
    event LoanCuredFromFallback(
        uint256 indexed loanId,
        address indexed borrower,
        uint256 restoredCollateralAmount,
        uint256 newHf
    );

    /// @notice Emitted when a borrower adds collateral to an active loan.
    /// @param loanId The active loan ID.
    /// @param borrower The borrower's address.
    /// @param amountAdded The additional collateral deposited.
    /// @param newCollateralAmount The total collateral after the addition.
    /// @param newHf The updated Health Factor (scaled to 1e18) after adding collateral.
    /// @param newLtv The updated LTV (in basis points) after adding collateral.
    /// @custom:event-category state-change/loan-mutation
    event CollateralAdded(
        uint256 indexed loanId,
        address indexed borrower,
        uint256 amountAdded,
        uint256 newCollateralAmount,
        uint256 newHf,
        uint256 newLtv
    );

    // Shared errors inherited from IVaipakamErrors

    // ─── External Functions ───────────────────────────────────────────────────

    /**
     * @notice Adds additional ERC-20 collateral to an active loan.
     * @dev Only the current borrower-side position NFT owner can call this.
     *      With native transfer locking during strategic flows (Preclose
     *      Option 3 offset, EarlyWithdrawal sale) the NFT never leaves its
     *      owner, so a plain ownerOf check is sufficient.
     *      Only liquid collateral loans are supported.
     *      Transfers `amount` of the existing collateral asset from the caller into the borrower's vault.
     *      Updates loan.collateralAmount. Emits CollateralAdded with new HF and LTV.
     *      Does not enforce a minimum HF check (adding collateral always improves position).
     *      Reverts if loan is not active, caller is not the borrower-NFT owner,
     *      amount is zero, or collateral is illiquid.
     *      Open during a global pause (#668 / #935, owner decision D2): a
     *      borrower can always lower their risk, so this route carries no
     *      `whenNotPaused`. Per-asset pause rules, the reentrancy guard and
     *      the sanctions rule still apply.
     * @param loanId The ID of the active loan to top up.
     * @param amount The additional collateral amount (in the collateral asset's native decimals).
     */
    function addCollateral(
        uint256 loanId,
        uint256 amount
    ) external nonReentrant {
        // T-090 v1.1 (#389) §5.8 — top-ups mutate
        // `loan.collateralAmount` mid-auction; the v1.1 commit's
        // `custodialCollateral` / makerAmount would drift from the
        // loan struct + `postInteraction`'s
        // `actualCollateralConsumed = loan.collateralAmount`
        // accounting would double-count the top-up.
        LibVaipakam.assertNoLiveIntentCommit(loanId);
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        LibVaipakam.Loan storage loan = s.loans[loanId];

        LibAuth.requireBorrowerNftOwner(loan);
        // #820 Tier-1 sanctions on the payer / current borrower-NFT holder.
        // `requireBorrowerNftOwner` makes `msg.sender` the current holder, and
        // the top-up is pulled from `msg.sender` below; but the only vault
        // screen otherwise is on the STORED `loan.borrower` (the `Tier2CloseOut`
        // consolidation context deliberately skips screening the current
        // holder). Without this a sanctioned current holder could still
        // interact with the protocol by topping up. Intent-decision note: this
        // blocks a flagged holder from curing/strengthening their own position,
        // which can let the loan proceed to liquidation — consistent with the
        // Tier-1 "no protocol interaction by a flagged wallet" posture.
        LibVaipakam._assertNotSanctioned(msg.sender);
        // FallbackPending is accepted: README allows the borrower to cure a
        // failed liquidation by topping up collateral until the lender claims.
        if (
            loan.status != LibVaipakam.LoanStatus.Active &&
            loan.status != LibVaipakam.LoanStatus.FallbackPending
        ) revert LoanNotActive();
        if (amount == 0) revert InvalidAmount();

        // Per-asset pause: topping up new collateral into a paused asset
        // is a creation path (it increases diamond-held exposure).
        // Blocking here still lets the borrower exit via repay / default
        // paths which do NOT call requireAssetNotPaused.
        LibFacet.requireAssetNotPaused(loan.collateralAsset);

        // Only liquid collateral can be topped up (illiquid assets have $0 platform value)
        // Check the collateral asset's liquidity directly via oracle
        LibVaipakam.LiquidityStatus collateralLiquidity = OracleFacet(address(this))
            .checkLiquidity(loan.collateralAsset);
        if (collateralLiquidity != LibVaipakam.LiquidityStatus.Liquid)
            revert IlliquidAsset();

        // #594 Codex #657 round-3 — consolidate the borrower side FIRST (when
        // the loan is Active and the position has transferred). This re-anchors
        // `loan.borrower` to the current holder and moves the existing
        // collateral into the holder's vault — the primitive's own from-side
        // move handles a stale anchor that was sanctions-flagged after transfer
        // (its scoped exemption), so the deposit below then targets the holder's
        // clean vault. Idempotent with the end-of-fn hook (AlreadyConsolidated /
        // NoOp for a non-transferred or just-resolved loan).
        //
        // While FallbackPending the primitive is excluded (the episode's custody
        // row and lien stay keyed to the stored `loan.borrower` until it ends;
        // #1566 slice 2 keeps that custody in this same vault), so this is a
        // no-op and the deposit below still targets the stored `loan.borrower`;
        // if that anchor is flagged the deposit correctly REVERTS rather than
        // crediting a sanctioned vault (a non-curing FallbackPending top-up
        // would otherwise strand funds there — Codex #657 round-3). The
        // end-of-fn hook then consolidates a just-cured loan. The narrow
        // FallbackPending + flagged-stale-anchor top-up is a safe revert; the
        // liveness gap is tracked in #658.
        LibConsolidation.consolidateToHolder(
            loanId, false, LibConsolidation.Ctx.Tier2CloseOut
        );

        // #569 Codex #572 round-2 P2 — the canonical collateral vault is
        // the STORED `loan.borrower`'s, NOT `msg.sender`'s. The
        // borrower-position NFT may have transferred, so the current
        // holder (`requireBorrowerNftOwner` authorizes them) can call
        // this — but the collateral lien is keyed to `loan.borrower`,
        // the original collateral (and, while FallbackPending, the
        // fallback custody row) sits in `loan.borrower`'s vault, and the
        // close / claim paths expect the enlarged `collateralAmount`
        // there. The deposit and the lien increment must both target the
        // same vault as the lien. The cure moves nothing (#1566 slice 2,
        // see {_cureFallback}), so it needs no vault of its own; the
        // separate vault pre-resolution it used to need is gone.
        //
        // Pull the top-up from the CALLER (`msg.sender`, the funding
        // party / current NFT holder) into `loan.borrower`'s vault via
        // the cross-payer chokepoint, which resolves (and sanctions-
        // screens) that vault itself, so the protocolTrackedVaultBalance
        // counter ticks up under `loan.borrower` (where the lien lives).
        // For the common case (`msg.sender == loan.borrower`) this is
        // identical to the prior `vaultDepositERC20` self-deposit.
        LibFacet.crossFacetCall(
            abi.encodeWithSelector(
                VaultFactoryFacet.vaultDepositERC20From.selector,
                msg.sender,        // payer
                loan.borrower,     // vault owner (= lien.user)
                loan.collateralAsset,
                amount
            ),
            VaultDepositFailed.selector
        );

        // Update loan collateral amount
        loan.collateralAmount += amount;

        // #407 PR 4 round-1 Codex P2 #6 (2026-06-12) — keep the
        // collateral lien in parity with the collateral now sitting in
        // the borrower's vault. #569 Codex #572 round-4 P1 — increment
        // for BOTH Active and FallbackPending. The top-up lands in the
        // vault immediately, so it must be liened immediately, even on a
        // FallbackPending loan that this call doesn't cure (else the
        // top-up is drainable before a later cure). On a FallbackPending
        // loan the lien already covers the fallback custody row (#1566
        // slice 2: `FallbackCustodyFacet.enterFallback` installs both), so
        // the increment grows it to `row + top-ups == collateralAmount`
        // and the cure adds nothing. `incrementCollateralLien` is
        // create-if-absent, which seeds the lien when an episode entered
        // with nothing to hold. No-op on NFT rentals (D-1).
        LibFacet.crossFacetCall(
            abi.encodeWithSelector(
                EncumbranceMutateFacet.incrementCollateralLien.selector,
                loanId,
                amount
            ),
            bytes4(0)
        );

        // Calculate new HF and LTV for event emission (best-effort; failures don't revert)
        uint256 newHf;
        uint256 newLtv;
        (bool success, bytes memory result) = address(this).staticcall(
            abi.encodeWithSelector(RiskFacet.calculateHealthFactor.selector, loanId)
        );
        if (success && result.length > 0) {
            newHf = abi.decode(result, (uint256));
        }

        (success, result) = address(this).staticcall(
            abi.encodeWithSelector(RiskFacet.calculateLTV.selector, loanId)
        );
        if (success && result.length > 0) {
            newLtv = abi.decode(result, (uint256));
        }

        emit CollateralAdded(
            loanId,
            msg.sender,
            amount,
            loan.collateralAmount,
            newHf,
            newLtv
        );

        // Cure path: a FallbackPending loan reactivates only when both HF and
        // LTV are back within the same caps enforced at initiation
        // (MIN_HEALTH_FACTOR and assetRiskParams[collateral].loanInitMaxLtvBps).
        // Anything looser leaves the loan in FallbackPending and the lender
        // can still claim at any time.
        if (
            loan.status == LibVaipakam.LoanStatus.FallbackPending &&
            // #394 Lever A (Codex #647 P1 + round-3 P1) — cure to THIS loan's
            // snapshotted admission terms (HF floor + init-LTV cap incl. the
            // tier buffer), not the live knob / per-asset cap, so a cure can't
            // re-activate a depth-tiered loan looser than it was admitted.
            newHf >= LibVaipakam.effectiveLoanMinHealthFactor(loan.minHealthFactorAtInit) &&
            newLtv <= LibVaipakam.effectiveLoanInitLtvCapBps(
                loan.initLtvCapBpsAtInit,
                s.assetRiskParams[loan.collateralAsset].loanInitMaxLtvBps
            )
        ) {
            _cureFallback(loanId, loan);
            emit LoanCuredFromFallback(loanId, msg.sender, loan.collateralAmount, newHf);
        }

        // #594 — consolidate a transferred borrower position into the current
        // holder's vault AFTER the cure (zP8): while FallbackPending
        // consolidation is excluded (returns Skipped) — the episode's custody
        // row and lien stay keyed to the stored `loan.borrower` until it ends;
        // only once the loan is back to Active (just-cured, or already Active
        // above) does the lien move with the position. Placing the hook here —
        // not at the top — means a just-cured loan still consolidates.
        // Skip-not-block.
        LibConsolidation.consolidateToHolder(
            loanId, false, LibConsolidation.Ctx.Tier2CloseOut
        );

        // #594 Codex #657 round-5 — the top-of-fn consolidation checkpointed the
        // holder's VPFI tier/staking at the PRE-top-up balance, then the deposit
        // INCREASED it (a FallbackPending cure moves no tokens; dropping its
        // fallback-custody tier exclusion restamps through `returnToPledge`'s
        // notify); the hook just above is `AlreadyConsolidated` for an Active
        // transferred loan and doesn't restamp. Re-stamp explicitly at the
        // final balance so the holder's tier reflects the larger post-top-up
        // VPFI immediately.
        // Idempotent with the hook's own restamp on the just-cured path. No-op
        // for non-VPFI collateral.
        if (loan.collateralAsset == s.vpfiToken) {
            LibConsolidation.restampUserVpfi(loan.borrower);
        }
    }

    /// @dev Restores a FallbackPending loan to Active.
    ///
    ///      #1566 slice 2 — nothing moves. `FallbackCustodyFacet.enterFallback`
    ///      deposited the fallback collateral into `loan.borrower`'s vault,
    ///      recorded it as the `fallbackVaultCustody` row and liened it, and
    ///      every top-up since was liened on arrival, so the vault already
    ///      holds `collateralAmount` under a lien of exactly that size and the
    ///      tracked balance already counts it. The former Diamond-to-vault
    ///      transfer, its `recordVaultDeposit` and the re-lien by `held` are
    ///      gone: here they would pay the custody a second time out of the
    ///      Diamond's own (other loans') balance and double the lien.
    ///
    ///      Order:
    ///        1. `requireVaultHeld` FIRST, while the snapshot still exists: a
    ///           legacy Diamond-held row (written by pre-slice-2 code) fails
    ///           closed by name (`FallbackCustodyNotVaultHeld`). Owner decision
    ///           O1 = A: every chain running this code is a fresh deploy, so
    ///           there is no migration branch.
    ///        2. Clear the snapshot and both claim records, so neither side
    ///           can pull against a stale split, plus the backstop opt-in and
    ///           the entry freeze markers.
    ///        3. Take the FallbackPending -> Active edge.
    ///        4. Only THEN `returnToPledge`: the row goes to 0 with a
    ///           `ReturnedToPledge` row move, and its tier notify re-derives the
    ///           VPFI exclusion against the Active status (none) and restamps
    ///           once. Returned before the edge, it would re-derive against
    ///           FallbackPending and leave the record charged (at zero) to the
    ///           borrower on an Active loan.
    ///        5. Relabel both NFTs "Loan Initiated".
    function _cureFallback(uint256 loanId, LibVaipakam.Loan storage loan) internal {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        LibFallbackCustody.requireVaultHeld(loanId);

        delete s.fallbackSnapshot[loanId];
        delete s.lenderClaims[loanId];
        delete s.borrowerClaims[loanId];
        // #630 — drop any Role-B cash-exit opt-in: this fallback episode is over,
        // so a later, distinct fallback must be re-authorized by the then-owner.
        delete s.lenderBackstopOptIn[loanId];

        // #998 S10 (#1006) — this fallback episode is abandoned; clear the
        // frozen-claimant markers recorded at fallback ENTRY so a stale flagged
        // marker can't fail-close a later, unrelated terminal's claim during an
        // oracle outage (mirrors the RepayFacet cure clear). Codex r2 P1 —
        // PRESERVE a LENDER marker still backing partial-internal-match proceeds
        // (`heldForLender > 0`); that freeze is from a different, non-abandoned
        // episode. The borrower side has no such accumulator, so it always clears.
        if (s.heldForLender[loanId] == 0) {
            LibSanctionedLock.clearFrozenClaimant(s, loanId, true);
        }
        LibSanctionedLock.clearFrozenClaimant(s, loanId, false);

        // Cure path: FallbackPending -> Active.
        LibLifecycle.transition(
            loan,
            LibVaipakam.LoanStatus.FallbackPending,
            LibVaipakam.LoanStatus.Active
        );

        // #1566 slice 2 — the lien already equals `collateralAmount` (the
        // custody row plus every top-up; see the natspec), so the row only
        // returns to the ordinary pledge. AFTER the edge, so the tier
        // re-derivation sees the Active status.
        LibFallbackCustody.returnToPledge(loanId);

        LibFacet.crossFacetCall(
            abi.encodeWithSelector(
                VaipakamNFTFacet.updateNFTStatus.selector,
                loan.lenderTokenId,
                loanId,
                LibVaipakam.LoanPositionStatus.LoanInitiated
            ),
            NFTStatusUpdateFailed.selector
        );
        LibFacet.crossFacetCall(
            abi.encodeWithSelector(
                VaipakamNFTFacet.updateNFTStatus.selector,
                loan.borrowerTokenId,
                loanId,
                LibVaipakam.LoanPositionStatus.LoanInitiated
            ),
            NFTStatusUpdateFailed.selector
        );
    }
}
