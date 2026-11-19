// src/libraries/LibCloseoutFreeze.sol
// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {LibPositionNFT} from "./LibPositionNFT.sol";
import {LibVaipakam} from "./LibVaipakam.sol";
import {LibLenderSide} from "./LibLenderSide.sol";
import {LibVaultOutflow} from "./LibVaultOutflow.sol";
import {OutflowReason} from "../vault/VaultOutflowTypes.sol";
import {LibSanctionedLock} from "./LibSanctionedLock.sol";
import {LibDelivery} from "./LibDelivery.sol";
import {LibEncumbrance} from "./LibEncumbrance.sol";
import {LibInterestLedger} from "./LibInterestLedger.sol";
import {LibTierRecord} from "./LibTierRecord.sol";

/**
 * @title  LibCloseoutFreeze
 * @author Vaipakam Developer Team
 * @notice #954 (Codex #981/#986) — the shared Tier-2 close-out freeze logic for
 *         the swap-to-repay-FULL family (`SwapToRepayFacet.swapToRepayFull` and
 *         the Fusion intent settlement `LibSwapToRepayIntentSettlement`). Both
 *         terminals MUST complete regardless of either party's sanctions status
 *         (so the honest counterparty is made whole) while a flagged party's
 *         proceeds are FROZEN behind the claim-side sanctions gate rather than
 *         the tx reverting.
 *
 * @dev    Factoring the lender-leg freeze and the borrower-surplus freeze-or-pay
 *         into ONE place keeps the two terminals in lockstep, so neither can
 *         drift on the encumber-all-ERC20 (§1.1/§2.1) rule. The frozen-VPFI
 *         tier exclusion (§2.2) used to live here too; #2342 moved it to
 *         `LibTierExclusion`, which derives it from the reservations these
 *         helpers make, for every close-out. `internal` functions — they inline into
 *         each calling facet (no delegatecall), so the shared logic is a single
 *         source of truth without a runtime hop. `address(this)` inside these
 *         helpers is the Diamond (internal-lib calls run in the caller's
 *         context), so `LibPositionNFT.ownerOf(...)` reads the position
 *         NFT held on the Diamond.
 *
 *         See docs/DesignsAndPlans/SanctionsCloseoutSweepAndSaleVehicleFixes.md.
 */
library LibCloseoutFreeze {
    /**
     * @notice Deposit a full swap-to-repay's lender proceeds into the STORED
     *         `loan.lender`'s vault behind the receive-side sanctions exemption,
     *         write the lender claim row, reserve the proceeds against the
     *         stored lender's spend paths, and (VPFI only) exclude a
     *         transferred-and-sanctioned holder's proceeds from the stored
     *         lender's fee tier.
     *
     * @dev    §1.1 — a lender flagged AFTER init must not brick this
     *         must-complete close-out; `depositLocked` resolves their EXISTING
     *         vault behind the pinned exemption (never mints for a flagged
     *         wallet). The proceeds stay claimable via `claimAsLender` once the
     *         lender/holder delists.
     *
     *         §1.1 encumber-all — reserve for EVERY ERC20, not just VPFI:
     *         `freeBalance` (which the signed-offer materialisation path
     *         consults) subtracts `s.encumbered` for any asset, so a
     *         transferred-away stored lender could otherwise spend non-VPFI
     *         proceeds as offer/intent capital before the current holder claims.
     *
     *         §2.2 tier-exclude — #2342: no longer done here. The reservation
     *         below is what `LibTierExclusion` reads, so VPFI proceeds owed to
     *         a transferred holder leave loan.lender's tier through the same
     *         ledger-derived rule as every other close-out, once the loan's
     *         terminal transition runs. A SELF-holder keeps the VPFI in-tier
     *         (their own money).
     */
    function freezeLenderProceeds(
        LibVaipakam.Storage storage s,
        uint256 loanId,
        LibVaipakam.Loan storage loan,
        uint256 lenderDue
    ) internal {
        // #2440 — every caller is a VOLUNTARY close (the full swap-to-repay
        // route, a filled intent, and the collateral sale, #2876), so the
        // deposit is refused unless the lender's vault received all of
        // `lenderDue`: the loan closes on that figure, and the
        // claim and the reservation name it.
        LibSanctionedLock.depositLockedInFull(
            s, loan.lender, loanId, loan.principalAsset, lenderDue
        );
        // #998 S10 (#1006) — freeze the lender payout fail-closed if the CURRENT
        // position holder (the intended claimant) is flagged, so the confirmed
        // freeze can't lift during an oracle outage.
        LibSanctionedLock.recordFrozenClaimantForLoan(s, loan, true);
        // #3760 — the holder's part is what the row keeps once an open
        // advance has taken its own, and only that is reserved here.
        uint256 kept = LibLenderSide.setFinal(s, loanId, LibVaipakam.ClaimInfo({
            asset: loan.principalAsset,
            amount: lenderDue,
            assetType: LibVaipakam.AssetType.ERC20,
            tokenId: 0,
            quantity: 0,
            claimed: false
        }));
        LibEncumbrance.encumberLenderProceeds(
            loanId, loan.lender, loan.principalAsset, kept
        );
    }

    /**
     * @notice Hold a full swap-to-repay's borrower principal SURPLUS for the
     *         borrower position: into the stored `loan.borrower`'s vault, on
     *         the loan's surplus claim row, reserved against the stored
     *         borrower's spending, for `ClaimFacet.claimAsBorrower`.
     * @dev    #3629 (owner decision 2026-11-15) — no loan step pays a
     *         borrower's wallet; before it a clean holder was paid directly
     *         and only a sanctions-frozen one was held. The deposit is the
     *         sanctions-lock deposit (the holder may be a fresh transferee with
     *         no vault, and a flagged stored borrower must not block the
     *         close-out). Encumber-all (§2.1): reserved for every ERC-20.
     *         #2342: a surplus owed to a transferred holder leaves the stored
     *         borrower's fee tier through `LibTierExclusion`, derived from the
     *         reservation.
     */
    function holdBorrowerSurplus(
        LibVaipakam.Storage storage s,
        uint256 loanId,
        LibVaipakam.Loan storage loan,
        address currentHolder,
        uint256 surplus
    ) internal {
        if (surplus == 0) return;
        // #2440 — every caller is a VOLUNTARY swap-to-repay (the full route and
        // a filled intent), so the surplus is refused unless it all arrived:
        // the row and the reservation below name `surplus`.
        LibSanctionedLock.depositLockedInFull(
            s, loan.borrower, loanId, loan.principalAsset, surplus
        );
        // The row writer records `currentHolder` as the fail-closed claimant
        // when flagged, and does nothing for a clean holder.
        addBorrowerSurplus(s, loanId, currentHolder, loan.principalAsset, surplus);
        LibEncumbrance.encumberBorrowerProceeds(
            loanId, loan.borrower, loan.principalAsset, surplus
        );
    }

    /**
     * @notice Whether a loan in `status` is one the LENDER may claim on:
     *         Repaid, Defaulted, FallbackPending (the lender's claim runs the
     *         one-shot retry) or InternalMatched (#585).
     * @dev    #941 — the ONE status rule for a lender claim, read by
     *         `ClaimFacet.claimAsLender` (which refuses any other status) and by
     *         the dashboard's claimables view, so the view never lists a claim
     *         the claim call would refuse.
     */
    function lenderClaimableStatus(LibVaipakam.LoanStatus status) internal pure returns (bool) {
        return status == LibVaipakam.LoanStatus.Repaid ||
            status == LibVaipakam.LoanStatus.Defaulted ||
            status == LibVaipakam.LoanStatus.FallbackPending ||
            status == LibVaipakam.LoanStatus.InternalMatched;
    }

    /**
     * @notice Whether a loan in `status` is one the BORROWER may claim on:
     *         Repaid, Defaulted or InternalMatched (#577). FallbackPending is
     *         not: the lender's claim resolves the fallback first.
     * @dev    #941 — the ONE status rule for a borrower claim, read by
     *         `ClaimFacet.claimAsBorrower` and by the dashboard's claimables view.
     */
    function borrowerClaimableStatus(LibVaipakam.LoanStatus status) internal pure returns (bool) {
        return status == LibVaipakam.LoanStatus.Repaid ||
            status == LibVaipakam.LoanStatus.Defaulted ||
            status == LibVaipakam.LoanStatus.InternalMatched;
    }

    /**
     * @notice Whether the lender side of `loanId` still has a claim to run: a
     *         claim a close-out recorded (keyed on its asset, so a forced
     *         close-out that received nothing still leaves one), funds held for
     *         the lender, an NFT rental to return, or an NFT collateral claim.
     * @dev    #2440 — the lender's claim refuses with `NothingToClaim` when this
     *         is false, and the borrower's claim settles the loan only once it
     *         is false or the lender has claimed, so both sides read one rule
     *         and a lender whose close-out received nothing can still close the
     *         position. It does not look at `claimed` or at the loan's status:
     *         {lenderClaimPending} adds both. (Moved here from `ClaimFacet` in
     *         #941 so the dashboard reads the same rule.)
     */
    function lenderSideOpen(
        LibVaipakam.Storage storage s,
        uint256 loanId,
        LibVaipakam.Loan storage loan
    ) internal view returns (bool) {
        LibVaipakam.ClaimInfo storage claim = s.lenderClaims[loanId];
        return claim.asset != address(0) ||
            claim.amount > 0 ||
            s.heldForLender[loanId] > 0 ||
            loan.assetType != LibVaipakam.AssetType.ERC20 ||
            claim.assetType != LibVaipakam.AssetType.ERC20;
    }

    /**
     * @notice Whether `claimAsLender` would find something to pay on `loanId`
     *         right now: a lender-claimable status, an unclaimed row, and an
     *         open lender side.
     * @dev    #941 — what the dashboard's claimables view lists. It does not
     *         check who holds the lender position or any sanctions state; the
     *         claim call does.
     */
    function lenderClaimPending(
        LibVaipakam.Storage storage s,
        uint256 loanId
    ) internal view returns (bool) {
        LibVaipakam.Loan storage loan = s.loans[loanId];
        return lenderClaimableStatus(loan.status) &&
            !s.lenderClaims[loanId].claimed &&
            lenderSideOpen(s, loanId, loan);
    }

    /**
     * @notice Whether `claimAsBorrower` would find something to pay on `loanId`
     *         right now: a borrower-claimable status and an open borrower side
     *         (collateral row or surplus row).
     * @dev    #941 — what the dashboard's claimables view lists; an NFT
     *         collateral return counts although its row carries amount 0.
     */
    function borrowerClaimPending(
        LibVaipakam.Storage storage s,
        uint256 loanId
    ) internal view returns (bool) {
        return borrowerClaimableStatus(s.loans[loanId].status) &&
            borrowerSideOpen(s, loanId);
    }

    /**
     * @notice Whether the borrower side of `loanId` still has something to
     *         claim: an unclaimed collateral row that names an amount or an
     *         NFT, or an unclaimed surplus row with an amount. (A third lane,
     *         the borrower LIF rebate, was removed with the peg-custody path
     *         in #1980.)
     * @dev    #2795 — the ONE rule for "the borrower side is done", read by
     *         `ClaimFacet.claimAsBorrower` (which refuses only when it is
     *         false) and by every lender-side path that settles the loan once
     *         it is false (`claimAsLender`, the backstop absorb, the lender
     *         intent's auto-claim). Each lane counts on its OWN flag: a
     *         terminal that wrote the collateral row claimed (nothing left of
     *         the collateral) never hides a surplus row held earlier in the
     *         loan, such as a periodic forced sale's extra.
     */
    function borrowerSideOpen(
        LibVaipakam.Storage storage s,
        uint256 loanId
    ) internal view returns (bool) {
        if (collateralLaneOpen(s.borrowerClaims[loanId])) return true;
        LibVaipakam.ClaimInfo storage surplus = s.borrowerSurplusClaims[loanId];
        return !surplus.claimed && surplus.amount > 0;
    }

    /**
     * @notice Whether a borrower collateral row still has something to pay:
     *         unclaimed, and naming an amount or an NFT.
     * @dev    #2795 — an unwritten row (a close-out that wrote only the
     *         lender's claim) and a row written at zero are both empty: the
     *         claim pays nothing from them, so it never withdraws an unset
     *         asset while paying another lane.
     */
    function collateralLaneOpen(
        LibVaipakam.ClaimInfo storage claim
    ) internal view returns (bool) {
        return !claim.claimed &&
            (claim.amount > 0 || claim.assetType != LibVaipakam.AssetType.ERC20);
    }

    /**
     * @notice Add `amount` of `asset` to the loan's borrower surplus row — the
     *         ONE held row `ClaimFacet.claimAsBorrower` pays as its second lane.
     * @dev    #2795 — a running total, not a single write. A periodic forced
     *         sale on an open loan can hold an extra for the borrower several
     *         times over the loan's life (when the position holder is flagged
     *         or a wallet payment cannot complete), and a terminal surplus can
     *         follow on the same loan, so every writer ADDS. The row is always
     *         in the loan's principal asset, so it never mixes assets. Nothing
     *         writes it after the claim: the claim runs on a terminal loan and
     *         marks the row claimed in the same call.
     *
     *         The row's writer is also its sanctions register: every addition
     *         records `holder` (the current borrower-position holder it is
     *         owed to) through {LibSanctionedLock.recordFrozenClaimant}, which
     *         marks the claim fail-closed when `holder` is flagged (or was
     *         confirmed flagged and the oracle is down) and self-heals a stale
     *         marker when `holder` reads clean. So no caller can grow the row
     *         without the register.
     * @param holder The current borrower-position holder the addition is owed to.
     */
    function addBorrowerSurplus(
        LibVaipakam.Storage storage s,
        uint256 loanId,
        address holder,
        address asset,
        uint256 amount
    ) internal {
        if (amount == 0) return;
        LibSanctionedLock.recordFrozenClaimant(s, loanId, false, holder);
        LibVaipakam.ClaimInfo storage row = s.borrowerSurplusClaims[loanId];
        assert(!row.claimed);
        if (row.amount == 0) {
            row.asset = asset;
            row.assetType = LibVaipakam.AssetType.ERC20;
        } else {
            assert(row.asset == asset);
        }
        row.amount += amount;
    }

    /**
     * @notice #2795 / #2796 — hold a borrower's extra from a forced sale in
     *         the stored borrower's vault for the claim. The tokens are on the
     *         Diamond. #3629 — the only route for a borrower's extra: no loan
     *         step pays it to a wallet. Callers:
     *         - an OPEN loan (the periodic-interest forced sale), claimable
     *           while the loan is open (`ClaimFacet.claimHeldForBorrower`) or
     *           with the borrower claim at loan end;
     *         - a TERMINAL sale (Health-Factor liquidation, time-based default,
     *           the collateral sale's settlement in `PrepayListingFacet`),
     *           where the extra waits for `ClaimFacet.claimAsBorrower`.
     * @dev    Credited into the STORED borrower's vault (it always exists),
     *         added to the surplus row (whose writer records a flagged holder
     *         as the fail-closed claimant), and reserved against the stored
     *         borrower's spend paths. While the loan stays open the row follows
     *         the borrower position:
     *         consolidation moves it with the collateral
     *         ({LibConsolidation}), and an obligation handover pays it to the
     *         exiting holder (`PrecloseFacet.transferObligationViaOffer`).
     *         A forced flow acts on what arrived, so the row and the
     *         reservation name what the vault received.
     * @return credited What the stored borrower's vault received.
     */
    function holdBorrowerExtra(
        LibVaipakam.Storage storage s,
        uint256 loanId,
        LibVaipakam.Loan storage loan,
        address holder,
        address asset,
        uint256 amount
    ) internal returns (uint256 credited) {
        credited = LibSanctionedLock.depositLocked(s, loan.borrower, loanId, asset, amount);
        if (credited == 0) return 0;
        addBorrowerSurplus(s, loanId, holder, asset, credited);
        LibEncumbrance.encumberBorrowerProceeds(loanId, loan.borrower, asset, credited);
    }

    /// @notice #3629 — a payment on an open loan was held for the lender
    ///         position: `amount` (what arrived) now sits in `custody`'s vault
    ///         (the stored lender), reserved, for the position holder's claim.
    ///         The sellers' part of the same payment, if any, is stated by
    ///         `SellerInterestPaid`.
    /// @param loanId  The loan the payment was made on.
    /// @param custody The stored lender whose vault holds it.
    /// @param asset   The asset held.
    /// @param amount  What the vault received.
    /// @custom:event-category informational/settlement
    event LenderPaymentHeld(
        uint256 indexed loanId,
        address indexed custody,
        address asset,
        uint256 amount
    );

    /// @notice #2795 — a borrower extra held on an open loan was paid out
    ///         before the loan ended, because the borrower position was handed
    ///         over to a replacement borrower.
    /// @param loanId The loan whose held extra was paid.
    /// @param to The exiting borrower-position holder it was paid to.
    /// @param asset The asset paid (the loan's principal asset).
    /// @param amount What `to` received.
    /// @custom:event-category informational/settlement
    event BorrowerHeldExtraPaid(
        uint256 indexed loanId,
        address indexed to,
        address asset,
        uint256 amount
    );

    /**
     * @notice #2795 — pay the borrower extra held on an OPEN loan to the
     *         exiting borrower-position holder when the obligation is handed
     *         over (`PrecloseFacet.transferObligationViaOffer`). The extra came
     *         from that holder's collateral, so it leaves with them, like the
     *         collateral itself; the replacement borrower never sees it.
     * @dev    Runs while `loan.borrower` is still the stored exiting borrower,
     *         whose vault holds the extra. Clears the reservation first so the
     *         withdraw guard sees the tokens as free, zeroes the row (the loan
     *         stays open, so the row is NOT marked claimed: a later surplus on
     *         this loan adds to it as usual), and pays through the move-out
     *         exemption. A row held because the holder was flagged carries the
     *         fail-closed claimant marker; that party must read clean under
     *         the fail-closed screen first, exactly as at the claim. No-op when
     *         nothing is held.
     * @return paid What `to` received.
     */
    function payHeldBorrowerExtra(
        LibVaipakam.Storage storage s,
        uint256 loanId,
        LibVaipakam.Loan storage loan,
        address to
    ) internal returns (uint256 paid) {
        LibVaipakam.ClaimInfo storage row = s.borrowerSurplusClaims[loanId];
        uint256 amount = row.amount;
        if (amount == 0) return 0;
        assert(!row.claimed);
        address frozen = LibSanctionedLock.frozenClaimant(s, loanId, false);
        if (frozen != address(0)) {
            LibVaipakam.assertNotSanctionedFailClosed(frozen);
            LibSanctionedLock.clearConfirmedFlag(s, frozen);
            LibSanctionedLock.clearFrozenClaimant(s, loanId, false);
        }
        address asset = row.asset;
        LibEncumbrance.releaseBorrowerProceeds(loanId, loan.borrower);
        row.amount = 0;
        // #3205 part 2 — to the exiting borrower-position holder's VAULT (the
        // holder of the borrower token now, before the handover re-keys it).
        LibSanctionedLock.beginMoveOut(s, loan.borrower);
        paid = LibVaultOutflow.toPositionHolder(
            loan.borrower, LibVaultOutflow.ERC20, asset, 0, amount, loanId, loan.borrowerTokenId, OutflowReason.COLLATERAL_RELEASE
        );
        LibSanctionedLock.endMoveOut(s);
        emit BorrowerHeldExtraPaid(loanId, to, asset, paid);
    }

    // ─── #3629 — every open-loan lender payment is held for the position ───
    //
    // A payment made while the loan stays open (a partial repayment, a rental
    // day, a periodic forced sale, a partial liquidation) is never paid to a
    // wallet. Open seller claims are paid first, as before; the rest is
    // deposited into the STORED `loan.lender`'s always-existing vault (never the
    // current holder's, which a holder who is not the stored lender may not
    // have), credited to `heldForLender[loanId]`, and reserved against the
    // stored lender's spending. The position holder takes it with
    // `ClaimFacet.claimHeldForLender` while the loan is open, or with the final
    // lender claim, which folds what is still held. So every lender payout
    // leaves through the vault outflow policy, where a protected account's
    // delay applies (owner decision 2026-11-15, LenderPayoutsThroughClaimDesign.md).
    //
    // Before #3629 these helpers paid a clean holder's wallet directly and held
    // only a sanctions-frozen holder's share. The deposit is the sanctions-lock
    // deposit for every holder: it differs from an ordinary vault deposit only
    // by pinning the receive-side exemption while the stored lender's EXISTING
    // vault is resolved, so a flagged stored lender never blocks a borrower or
    // renter from servicing the loan, and it leaves the same balance and
    // tracked-holding record either way.

    /// @dev Shared post-deposit bookkeeping for a held open-loan lender share:
    ///      the funds already sit in `loan.lender`'s vault. Credits the held
    ///      ledger, records the fail-closed frozen-claimant marker for the
    ///      current position holder (a no-op for a clean holder, and a
    ///      self-heal of a stale marker), and reserves the amount through the
    ///      dedicated active-held ledger.
    /// @dev The active-held ledger, not the single-terminal
    ///      `encumberLenderProceeds` ledger: that one records ONE asset per
    ///      loan and asserts every later reservation matches it, so a held
    ///      payment in the payment asset would brick a later in-kind default
    ///      reserving the collateral asset (Codex #1122-rework). The dedicated
    ///      ledger migrates with the held balance on consolidation and sale.
    ///      No VPFI fee-tier exclusion while the loan is open (the position
    ///      can move before the claim); once the loan is terminal,
    ///      `LibTierExclusion` excludes this reservation like any other (#2342).
    function _holdActiveLenderShare(
        LibVaipakam.Storage storage s,
        uint256 loanId,
        LibVaipakam.Loan storage loan,
        address asset,
        uint256 amount
    ) private {
        if (amount == 0) return;
        // #3760 — the one order of payment: an open advance on the position
        // takes its part first (set aside under its own lien); the held store
        // and its reservation carry the holder's part.
        uint256 kept = LibLenderSide.addHeld(s, loanId, asset, amount);
        if (kept == 0) return;
        LibSanctionedLock.recordFrozenClaimant(s, loanId, true, LibPositionNFT.ownerOf(loan.lenderTokenId));
        LibEncumbrance.encumberActiveHeld(loanId, loan.lender, asset, kept);
        emit LenderPaymentHeld(loanId, loan.lender, asset, kept);
    }

    /// @notice #3629 — hold an open-loan lender share whose funds sit in the
    ///         DIAMOND (the periodic forced sale's proceeds, a partial
    ///         liquidation's proceeds) for the lender position: open seller
    ///         claims first, then the rest into the stored `loan.lender`'s vault
    ///         under the active-held reservation, for the position holder's claim.
    /// @dev    #1209 / #1808 — `amount` is the lender side's whole payout
    ///         (principal and net interest); `interestGross` / `interestNet`
    ///         name the interest in it. The sellers are paid out of the
    ///         interest ({LibInterestLedger.paySellersFirst}); the holder's
    ///         part of the interest is recorded as held
    ///         ({LibInterestLedger.holderParked}), and reported paid only when
    ///         the holder claims it.
    ///
    ///         #2440 — the stored lender's vault is custody, so this acts on
    ///         what arrived and returns it; the CALLER decides what a short
    ///         return means. The periodic forced sale credits the loan by the
    ///         returned figure, so the difference stays owed; a partial HF
    ///         liquidation refuses it, since it books the payout as received in
    ///         full on a loan that stays open.
    /// @return delivered The sellers' part plus what the stored lender's vault
    ///         received, never more than `amount`.
    function holdActiveLenderResident(
        LibVaipakam.Storage storage s,
        uint256 loanId,
        LibVaipakam.Loan storage loan,
        address asset,
        uint256 amount,
        uint256 interestGross,
        uint256 interestNet
    ) internal returns (uint256 delivered) {
        if (amount == 0) return 0;
        (uint256 sellersGross, uint256 sellersNet) =
            LibInterestLedger.paySellersFirst(s, loan, address(0), asset, interestGross, interestNet);
        uint256 holderAmount = amount - sellersNet;
        if (holderAmount == 0) return sellersNet;
        uint256 held = LibSanctionedLock.depositLocked(s, loan.lender, loanId, asset, holderAmount);
        _holdActiveLenderShare(s, loanId, loan, asset, held);
        LibInterestLedger.holderParked(
            s, loan, interestGross - sellersGross, interestNet - sellersNet, held, true
        );
        delivered = sellersNet + held;
    }

    /// @notice #3629 — hold an open-loan lender share a `payer` funds through
    ///         an approval (the ERC-20 partial repayment): open seller claims
    ///         first, straight from `payer` into each seller's vault, then the
    ///         rest from `payer` into the stored lender's vault, held for the
    ///         position holder's claim.
    /// @dev    A voluntary payment: the deposit is refused unless it arrived in
    ///         full (#1281-011), so the loan is credited with `amount`.
    function holdActiveLenderFromPayer(
        LibVaipakam.Storage storage s,
        uint256 loanId,
        LibVaipakam.Loan storage loan,
        address payer,
        address asset,
        uint256 amount,
        uint256 interestGross,
        uint256 interestNet
    ) internal {
        if (amount == 0) return;
        (uint256 sellersGross, uint256 sellersNet) =
            LibInterestLedger.paySellersFirst(s, loan, payer, asset, interestGross, interestNet);
        uint256 holderAmount = amount - sellersNet;
        if (holderAmount == 0) return;
        LibSanctionedLock.depositLockedFrom(s, payer, loan.lender, loanId, asset, holderAmount);
        _holdActiveLenderShare(s, loanId, loan, asset, holderAmount);
        LibInterestLedger.holderParked(
            s, loan, interestGross - sellersGross, interestNet - sellersNet, holderAmount, true
        );
    }

    /// @notice #3629 — hold an open-loan lender share funded from a loan
    ///         party's VAULT (the NFT rental's prepay pool): moved from
    ///         `fromUser`'s vault into the stored lender's vault, held for the
    ///         position holder's claim.
    /// @dev    The move arms the from-side move-out exemption, so a payer
    ///         flagged after the loan opened is still serviced. Every caller
    ///         books this share as paid in full (a rental day, the lender's
    ///         share of a rental repayment or preclose), so a short delivery is
    ///         refused ({LibDelivery.requireFull}); a rental whose prepay token
    ///         starts charging on transfer settles through the time-based
    ///         default instead.
    function holdActiveLenderFromVault(
        LibVaipakam.Storage storage s,
        uint256 loanId,
        LibVaipakam.Loan storage loan,
        address fromUser,
        address asset,
        uint256 amount
    ) internal {
        if (amount == 0) return;
        LibDelivery.requireFull(
            asset,
            amount,
            LibSanctionedLock.depositLockedFromVault(s, fromUser, loan.lender, loanId, asset, amount)
        );
        _holdActiveLenderShare(s, loanId, loan, asset, amount);
    }

    /**
     * @notice Release a LEGACY (pre-#2342) per-loan lender-leg frozen-VPFI tier
     *         exclusion when the lender claim is paid, decrementing the owner
     *         aggregate by EXACTLY what this loan bumped (§2.2). Idempotent
     *         no-op for loans that never bumped, and for every loan frozen
     *         after #2342 (nothing writes the legacy record any more;
     *         `LibTierExclusion.sync` folds any it finds).
     * @dev    Floored decrement guards the aggregate against any accounting
     *         drift — it can never underflow.
     */
    function releaseLenderFrozenVpfi(
        LibVaipakam.Storage storage s,
        uint256 loanId,
        address lender
    ) internal {
        uint256 bumped = s.frozenVpfiOwedLenderLeg[loanId];
        if (bumped == 0) return;
        uint256 cur = s.frozenVpfiOwedByVault[lender];
        s.frozenVpfiOwedByVault[lender] = cur > bumped ? cur - bumped : 0;
        s.frozenVpfiOwedLenderLeg[loanId] = 0;
        LibTierRecord.refresh(lender);
    }

    /**
     * @notice Release a LEGACY (pre-#2342) per-loan borrower-surplus
     *         frozen-VPFI tier exclusion when the surplus claim is paid (§2.2).
     *         Idempotent no-op for loans that never bumped, and for every loan
     *         frozen after #2342.
     */
    function releaseBorrowerFrozenVpfi(
        LibVaipakam.Storage storage s,
        uint256 loanId,
        address borrower
    ) internal {
        uint256 bumped = s.frozenVpfiOwedBorrowerSurplus[loanId];
        if (bumped == 0) return;
        uint256 cur = s.frozenVpfiOwedByVault[borrower];
        s.frozenVpfiOwedByVault[borrower] = cur > bumped ? cur - bumped : 0;
        s.frozenVpfiOwedBorrowerSurplus[loanId] = 0;
        LibTierRecord.refresh(borrower);
    }
}
