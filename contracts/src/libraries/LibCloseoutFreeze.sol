// src/libraries/LibCloseoutFreeze.sol
// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {LibVaipakam} from "./LibVaipakam.sol";
import {LibSanctionedLock} from "./LibSanctionedLock.sol";
import {LibDelivery} from "./LibDelivery.sol";
import {LibEncumbrance} from "./LibEncumbrance.sol";
import {LibEntitlement} from "./LibEntitlement.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";

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
 *         context), so `IERC721(address(this)).ownerOf(...)` reads the position
 *         NFT held on the Diamond.
 *
 *         See docs/DesignsAndPlans/SanctionsCloseoutSweepAndSaleVehicleFixes.md.
 */
library LibCloseoutFreeze {
    using SafeERC20 for IERC20;

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
        // #2440 — every caller is a VOLUNTARY swap-to-repay (the full route and
        // a filled intent), so the deposit is refused unless the lender's vault
        // received all of `lenderDue`: the loan closes on that figure, and the
        // claim and the reservation name it.
        LibSanctionedLock.depositLockedInFull(
            s, loan.lender, loanId, loan.principalAsset, lenderDue
        );
        // #998 S10 (#1006) — freeze the lender payout fail-closed if the CURRENT
        // position holder (the intended claimant) is flagged, so the confirmed
        // freeze can't lift during an oracle outage.
        LibSanctionedLock.recordFrozenClaimantForLoan(s, loan, true);
        s.lenderClaims[loanId] = LibVaipakam.ClaimInfo({
            asset: loan.principalAsset,
            amount: lenderDue,
            assetType: LibVaipakam.AssetType.ERC20,
            tokenId: 0,
            quantity: 0,
            claimed: false
        });
        LibEncumbrance.encumberLenderProceeds(
            loanId, loan.lender, loan.principalAsset, lenderDue
        );
    }

    /**
     * @notice Route a full swap-to-repay's borrower principal SURPLUS to the
     *         current borrower-position holder — paying a clean holder directly,
     *         or FREEZING a sanctioned holder's surplus into the stored
     *         `loan.borrower`'s vault behind the claim gate.
     *
     * @dev    Clean holder → direct EOA transfer (a vault deposit would be
     *         unclaimable: `claimAsBorrower` releases only the collateral asset
     *         recorded in `borrowerClaims`, and `vaultWithdrawERC20` is
     *         diamond-internal).
     *
     *         Sanctioned holder → `depositLocked` into `loan.borrower`'s
     *         always-existing vault (the holder may be a fresh transferee with
     *         no vault, and the receive exemption refuses to mint for a flagged
     *         wallet), plus a `borrowerSurplusClaims` row so the holder can
     *         withdraw it via `claimAsBorrower` once delisted.
     *
     *         §2.1 encumber-all — reserve for EVERY ERC20 against the stored
     *         borrower's signed-offer spend path. §2.2 tier-exclude — #2342:
     *         derived from that reservation by `LibTierExclusion` for a
     *         surplus owed to a TRANSFERRED holder; a self-holder's surplus
     *         stays in their tier.
     */
    function freezeOrPayBorrowerSurplus(
        LibVaipakam.Storage storage s,
        uint256 loanId,
        LibVaipakam.Loan storage loan,
        address currentHolder,
        uint256 surplus
    ) internal {
        if (surplus == 0) return;
        // Codex #1122-rework r1 P1 — FAIL-CLOSED freeze decision. The bare fail-open
        // `isSanctionedAddress` would take the direct-transfer branch for a
        // previously-confirmed-flagged `currentHolder` during an oracle outage,
        // paying the surplus straight to their EOA and bypassing the claim-side
        // fail-closed gate entirely. `mustFreezeParty` stays frozen on a prior
        // confirmation while the oracle is down.
        // #2440 — every caller is a VOLUNTARY swap-to-repay (the full route and
        // a filled intent), so the surplus is refused unless it all arrived, on
        // either branch: the claim and the reservation below name `surplus`.
        if (!LibSanctionedLock.mustFreezeParty(s, currentHolder)) {
            LibDelivery.pushExact(loan.principalAsset, currentHolder, surplus);
            return;
        }
        LibSanctionedLock.depositLockedInFull(
            s, loan.borrower, loanId, loan.principalAsset, surplus
        );
        // #998 S10 (#1006) — the surplus is frozen precisely because
        // `currentHolder` is flagged (we are past the clean-holder early return);
        // the row writer records that address as the frozen claimant for a
        // fail-closed release.
        addBorrowerSurplus(s, loanId, currentHolder, loan.principalAsset, surplus);
        LibEncumbrance.encumberBorrowerProceeds(
            loanId, loan.borrower, loan.principalAsset, surplus
        );
    }

    /**
     * @notice Whether the borrower side of `loanId` still has something to
     *         claim: an unclaimed collateral row that names an amount or an
     *         NFT, an unclaimed surplus row with an amount, or a pending LIF
     *         rebate.
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
        if (!surplus.claimed && surplus.amount > 0) return true;
        return s.borrowerLifRebate[loanId].rebateAmount > 0;
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
     * @notice #2795 — hold a borrower's extra from a forced sale on an OPEN
     *         loan (the periodic-interest settlement), when it cannot be paid
     *         to the holder's wallet: the holder is flagged
     *         ({LibSanctionedLock.mustFreezeParty}), or the wallet payment was
     *         refused. The tokens are on the Diamond.
     * @dev    Credited into the STORED borrower's vault (it always exists),
     *         added to the surplus row (whose writer records a flagged holder
     *         as the fail-closed claimant), and reserved against the stored
     *         borrower's spend paths. Paid with the claim at loan end. While the
     *         loan stays open the row follows the borrower position:
     *         consolidation moves it with the collateral
     *         ({LibConsolidation}), and an obligation handover pays it to the
     *         exiting holder (`PrecloseFacet.transferObligationViaOffer`).
     *         A forced flow acts on what arrived, so the row and the
     *         reservation name what the vault received.
     * @return credited What the stored borrower's vault received.
     */
    function parkActiveBorrowerExtra(
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
        paid = LibSanctionedLock.vaultWithdrawERC20MoveOut(s, loan.borrower, asset, to, amount);
        emit BorrowerHeldExtraPaid(loanId, to, asset, paid);
    }

    // ─── #998 S10 (#1006) Class B — ACTIVE-loan inline lender-share freeze ─────
    //
    // The servicing / interim close-out paths (periodic-interest auto-liquidate,
    // NFT-rental daily fee, ERC-20 partial repay) pay the CURRENT lender-position
    // holder INLINE while the loan is still Active, historically gated only by the
    // FAIL-OPEN `_assertNotSanctioned`. Per SanctionsTerminalizationRegister.md §1
    // (Class B) that is unsound: a previously-confirmed-flagged holder is paid
    // during an oracle outage because the fail-open screen waves them through, and
    // the deferred terminalization register can't help since the value has already
    // left. These helpers replace the fail-open decision with the registry-aware
    // `mustFreezeParty`: pay a clean/never-confirmed holder inline exactly as
    // before, or PARK a frozen holder's share into the STORED `loan.lender`'s
    // always-existing vault (never the current holder's, which a flagged
    // secondary-market transferee cannot have minted) + the mid-loan
    // `heldForLender[loanId]` accumulator (folded by the eventual `claimAsLender`)
    // + an encumbrance reservation (so the stored lender can't spend it as
    // offer/intent capital ahead of the frozen holder's claim) + the fail-closed
    // frozen-claimant marker. The loan stays Active — this is NOT a terminal, so
    // the park uses `heldForLender`, not a terminal `lenderClaims` row (§3.2).

    /// @dev Shared post-deposit bookkeeping for an Active-loan lender-share park:
    ///      the funds are ALREADY sitting in `loan.lender`'s vault (deposited by
    ///      the caller's funds-flow-specific step). Credits the mid-loan held
    ///      accumulator, records the fail-closed marker for `frozenHolder`,
    ///      reserves the amount against the stored lender's spend paths, and —
    ///      for a VPFI share owed to a TRANSFERRED (not self) holder — accumulates
    ///      the per-loan tier exclusion so the VPFI is kept out of `loan.lender`'s
    ///      fee tier until released at claim. Uses `+=` on the per-loan tier
    ///      record because an Active loan can freeze MULTIPLE inline shares over
    ///      its life (unlike the once-at-terminal `freezeLenderProceeds`).
    function _parkActiveLenderShare(
        LibVaipakam.Storage storage s,
        uint256 loanId,
        LibVaipakam.Loan storage loan,
        address frozenHolder,
        address asset,
        uint256 amount
    ) private {
        s.heldForLender[loanId] += amount;
        // #1801 — this share was FROZEN, not delivered, so the loan's
        // paid-through mark stops describing reality and can never be trusted
        // again for this lender: delivery on this position is now
        // non-contiguous, and one timestamp cannot say "paid for the later
        // period, not the earlier one". Voided here rather than at each caller
        // because every Active-loan park funnels through this helper, which makes
        // the coverage a property of the code shape instead of a checklist.
        LibEntitlement.voidInterestDeliveredMark(s, loanId);
        LibSanctionedLock.recordFrozenClaimant(s, loanId, true, frozenHolder);
        // #998 S10 Class B — reserve through the DEDICATED active-held ledger, NOT
        // the single-terminal `encumberLenderProceeds` ledger. That ledger records
        // ONE asset per loan and asserts every later reservation matches it, so an
        // active park in the payment asset would brick a subsequent in-kind default
        // reserving the collateral asset on the same loan (Codex #1122-rework
        // fresh-round P1). The dedicated ledger reserves against the same
        // asset-keyed aggregate under its own per-loan record and MIGRATES with the
        // held on consolidation/sale, so the reservation always follows the funds.
        //
        // No VPFI fee-tier exclusion while the loan is ACTIVE: an active park can
        // be consolidated/sold before claim, and a `frozenVpfiOwedByVault` charge
        // keyed to the stored lender would go STALE when those migrations
        // re-point the funds — stranding a permanent over-exclusion on the old
        // vault (fresh-round P2). The reservation below already blocks the stored
        // lender from spending the parked VPFI. #2342 — once the loan goes
        // terminal the stored party can no longer change (consolidation is a
        // no-op on terminal loans), so `LibTierExclusion` then excludes this
        // reservation, like every other one, while the position is held by
        // someone else.
        LibEncumbrance.encumberActiveHeld(loanId, loan.lender, asset, amount);
    }

    /// @notice Class B — pay-or-freeze an Active-loan lender share whose funds are
    ///         sitting in the DIAMOND (e.g. periodic-interest auto-liquidation
    ///         proceeds, freshly swapped into the Diamond). Clean/never-confirmed
    ///         holder → direct transfer. Frozen holder → `depositLocked` (Diamond
    ///         → stored lender vault) + the shared park.
    /// @dev    #2440 — the two branches read a delivery in different places,
    ///         and only one of them is a place a reading can be trusted
    ///         (LibDelivery, WHERE A READING CAN BE TRUSTED):
    ///         - CLEAN: the payout goes to the holder's WALLET, whose owner can
    ///           lower the reading while the transfer runs (a receiving hook
    ///           can forward the tokens on). Booking such a reading would leave
    ///           the rest owed to that owner, who could then be paid again. So
    ///           a short arrival is REFUSED here, in every flow (the periodic
    ///           auto-liquidation included), and a full payout returns
    ///           `amount` and moves the paid-through mark.
    ///         - FROZEN: the payout is credited to the stored lender's VAULT,
    ///           which is custody. That branch acts on what arrived and returns
    ///           it; the CALLER decides what a short return means. The periodic
    ///           auto-liquidation credits the loan by the returned figure, so
    ///           the difference stays owed on the loan; a partial HF
    ///           liquidation refuses it, since it books the payout as received
    ///           in full on a loan that stays open.
    /// @return delivered `amount` on the clean branch (anything less was
    ///         refused); what the stored lender's vault received on the frozen
    ///         branch, never more than `amount`.
    function freezeOrPayActiveLenderResident(
        LibVaipakam.Storage storage s,
        uint256 loanId,
        LibVaipakam.Loan storage loan,
        address asset,
        uint256 amount,
        uint256 deliveredThroughAt
    ) internal returns (uint256 delivered) {
        if (amount == 0) return 0;
        // Resolve the CURRENT lender-position holder here (the loan is Active, so
        // the lender NFT is live and `ownerOf` holds) — the intended payee AND the
        // party the fail-closed marker keys on. Resolving inside the helper keeps
        // the `ownerOf` + `IERC721` weight out of the EIP-170-tight caller facets.
        address lenderRecipient = IERC721(address(this)).ownerOf(loan.lenderTokenId);
        if (!LibSanctionedLock.mustFreezeParty(s, lenderRecipient)) {
            // #2440 — a wallet reading is trusted only to refuse (see @dev).
            LibDelivery.pushExact(asset, lenderRecipient, amount);
            // #1503 item 28 — the lender is now PAID THROUGH the boundary of the
            // period this payout settles, so a later sale must not forfeit that
            // stretch a second time. Advanced on THIS branch only: the freeze
            // branch below parks the tokens in `heldForLender`, which migrates to
            // the BUYER on a sale, so treating a frozen payout as delivered would
            // pay the seller for tokens they never held and do not keep.
            //
            // Monotone: a caller settling an older boundary after a newer one can
            // never walk the mark backwards and re-open a window already paid.
            if (deliveredThroughAt > s.lenderInterestDeliveredThroughAt[loanId]) {
                LibEntitlement.stampInterestDelivered(s, loanId, deliveredThroughAt);
            }
            return amount;
        }
        // #2440 — park what the vault received.
        delivered = LibSanctionedLock.depositLocked(s, loan.lender, loanId, asset, amount);
        _parkActiveLenderShare(s, loanId, loan, lenderRecipient, asset, delivered);
    }

    /// @notice Class B — pay-or-freeze an Active-loan lender share funded by a
    ///         `payer` via `approve` (the ERC-20 partial-repay case: the repaying
    ///         borrower pays principal+interest straight to the lender). Clean
    ///         holder → direct `safeTransferFrom(payer → holder)` (unchanged).
    ///         Frozen holder → `depositLockedFrom` (payer → stored lender vault) +
    ///         the shared park.
    function freezeOrPayActiveLenderFromPayer(
        LibVaipakam.Storage storage s,
        uint256 loanId,
        LibVaipakam.Loan storage loan,
        address payer,
        address asset,
        uint256 amount
    ) internal {
        if (amount == 0) return;
        address lenderRecipient = IERC721(address(this)).ownerOf(loan.lenderTokenId);
        if (!LibSanctionedLock.mustFreezeParty(s, lenderRecipient)) {
            // #1281-011 — the lender is recorded as paid through now, so the
            // payment must have arrived in full; a short arrival is refused.
            LibDelivery.pullExact(asset, payer, lenderRecipient, amount);
            // #1503 item 28 (Codex #1801 r4 P1) — DELIVERED, so the seller is
            // paid through NOW. Unlike the resident-payout helper this one needs
            // no boundary parameter: every caller pays interest accrued to the
            // present and resets the accrual clock in the same transaction, so
            // `block.timestamp` IS the correct mark.
            //
            // The freeze branch below deliberately does not stamp, and that is
            // the whole point of doing this here at all: a frozen partial
            // repayment parks the interest in `heldForLender` — which migrates
            // to the BUYER on a sale — while the caller still resets the accrual
            // clock. With the clock as the fallback the reset would act as the
            // credit and close the seller's window over interest they never
            // received. The mark stays put, so the window stays open.
            if (block.timestamp > s.lenderInterestDeliveredThroughAt[loanId]) {
                LibEntitlement.stampInterestDelivered(s, loanId, block.timestamp);
            }
            return;
        }
        LibSanctionedLock.depositLockedFrom(s, payer, loan.lender, loanId, asset, amount);
        _parkActiveLenderShare(s, loanId, loan, lenderRecipient, asset, amount);
    }

    /// @notice Class B — pay-or-freeze an Active-loan lender share funded from a
    ///         loan party's VAULT (the NFT-rental prepay pool). Clean holder →
    ///         withdraw `fromUser`'s vault → holder EOA (unchanged), arming the
    ///         move-out exemption so a flagged `fromUser` can still be serviced.
    ///         Frozen holder → `depositLockedFromVault` (fromUser vault → stored
    ///         lender vault) + the shared park.
    /// @dev    Both branches arm the move-out exemption around the withdraw (the
    ///         payer LOSES custody either way) — Tier-2 servicing must not brick a
    ///         `fromUser` flagged after init.
    ///         #2440 — every caller books this share as paid in full (a rental
    ///         day by `autoDeductDaily`, the lender's share of a rental repay or
    ///         preclose), so both branches refuse a delivery that fell short
    ///         ({LibDelivery.requireFull}). A rental whose prepay token starts
    ///         charging on transfer therefore stops being serviced and settles
    ///         through the time-based default, which acts on what arrives.
    function freezeOrPayActiveLenderFromVault(
        LibVaipakam.Storage storage s,
        uint256 loanId,
        LibVaipakam.Loan storage loan,
        address fromUser,
        address asset,
        uint256 amount
    ) internal {
        if (amount == 0) return;
        address lenderRecipient = IERC721(address(this)).ownerOf(loan.lenderTokenId);
        if (!LibSanctionedLock.mustFreezeParty(s, lenderRecipient)) {
            LibDelivery.requireFull(
                asset,
                amount,
                LibSanctionedLock.vaultWithdrawERC20MoveOut(
                    s, fromUser, asset, lenderRecipient, amount
                )
            );
            // #1503 item 28 — DELIVERED, paid through now. Same reasoning as the
            // from-payer helper above, including why the freeze branch below does
            // not stamp.
            if (block.timestamp > s.lenderInterestDeliveredThroughAt[loanId]) {
                LibEntitlement.stampInterestDelivered(s, loanId, block.timestamp);
            }
            return;
        }
        LibDelivery.requireFull(
            asset,
            amount,
            LibSanctionedLock.depositLockedFromVault(
                s, fromUser, loan.lender, loanId, asset, amount
            )
        );
        _parkActiveLenderShare(s, loanId, loan, lenderRecipient, asset, amount);
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
    }
}
