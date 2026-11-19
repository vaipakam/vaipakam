// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {LibVaipakam} from "../libraries/LibVaipakam.sol";
import {LibEncumbrance} from "../libraries/LibEncumbrance.sol";
import {LibFacet} from "../libraries/LibFacet.sol";
import {LibFeeFloor} from "../libraries/LibFeeFloor.sol";
import {LibVaultOutflow} from "../libraries/LibVaultOutflow.sol";
import {LibSanctionedLock} from "../libraries/LibSanctionedLock.sol";
import {LibAdvancePayAuth} from "../libraries/LibAdvancePayAuth.sol";
import {LibAdvance} from "../libraries/LibAdvance.sol";
import {LibDelivery} from "../libraries/LibDelivery.sol";
import {LibDepositoryLedger} from "../libraries/LibDepositoryLedger.sol";
import {OutflowReason} from "../vault/VaultOutflowTypes.sol";
import {DiamondReentrancyGuard} from "../libraries/LibReentrancyGuard.sol";
import {DiamondPausable} from "../libraries/LibPausable.sol";
import {IVaipakamErrors} from "../interfaces/IVaipakamErrors.sol";
import {ILenderSideHost} from "../interfaces/ILenderSideHost.sol";
import {MarketLedgerFacet} from "./MarketLedgerFacet.sol";
import {ConsolidationFacet} from "./ConsolidationFacet.sol";
import {LibPositionNFT} from "../libraries/LibPositionNFT.sol";

/**
 * @title  LenderSideFacet
 * @author Vaipakam Developer Team
 * @notice #3760 — the one order of payment for a lender position that carries
 *         an advance (LenderCashOutDesign §6.4 – §6.6), and the step that pays
 *         what the advance was given to its slot owner.
 *
 *         While an advance is open on a loan, everything that arrives for the
 *         loan's lender side — interest, a part repayment, an early-close
 *         top-up, a matched liquidation's proceeds, the final repayment, a
 *         refinance payoff, a default or liquidation's proceeds, the
 *         backstop's buyout of the slice — pays, in this order:
 *           1. the advance's interest, by time on what is still owed;
 *           2. the advance;
 *           3. the holder (what the store keeps).
 *         Booking happens at ARRIVAL, in the step that adds to the store
 *         (`LibLenderSide`), so interest stops on each amount the moment it
 *         arrives: an on-time payment by the borrower costs the holder
 *         nothing more, whether or not anyone acts afterwards. What the
 *         advance took is SET ASIDE in the same vault under the advance's own
 *         lien, where neither the holder nor a roll can take it.
 *
 *         The loan's end closes the advance: what its lender side received
 *         pays the advance first, and anything still owed is stated as the
 *         advance's SHORTFALL (the slot owner's loss; nothing is owed by the
 *         holder). A fallback that ends in kind is split after its one retry:
 *         the advance takes collateral worth what it is owed at the rate the
 *         fallback itself used (all of the lender slice where it had no
 *         price); the holder is given no time to choose.
 *
 *         {payAdvance} moves what is set aside into the slot owner's vault,
 *         less the treasury's cut of the interest in it. Anyone may call it
 *         (a keeper pass backs it); the holder's own claims run it too. Its
 *         timing changes nothing for the holder. It is its own kind of vault
 *         movement (`AdvanceRepayment`), so the holder's protection delay
 *         does not hold it, and a flagged holder does not stop it; a flagged
 *         slot owner's money stays set aside for them.
 *
 * @dev    The booking entries are `address(this)`-gated and NEVER revert for a
 *         figure: they run inside the borrower's repayment, default and
 *         liquidation routes, and an advance must never stand in the way of a
 *         borrower repaying. Every subtraction saturates. They carry no
 *         `nonReentrant` of their own: every caller already holds the Diamond
 *         guard.
 *
 *         An open advance and an open seller claim never stand on one loan:
 *         the advance is refused while one is open, and the lock stops every
 *         sale that would open one. Should both ever meet, the seller-claim
 *         host has already paid its part of the interest before the store was
 *         credited, so the existing order (sellers, then the advance's
 *         interest, then the advance, then the holder) holds without a revert.
 */
contract LenderSideFacet is DiamondReentrancyGuard, DiamondPausable, ILenderSideHost {
    /// @notice Money that arrived for `loanId`'s lender position paid
    ///         `interestPart` of the advance's interest and `principalPart` of
    ///         the advance, and was set aside for the slot owner. What is still
    ///         owed after it is stated.
    event AdvancePaidFromPosition(
        uint256 indexed loanId,
        address indexed asset,
        uint256 interestPart,
        uint256 principalPart,
        uint256 principalStillOwed,
        uint256 interestStillOwed
    );

    /// @notice The advance on `loanId` closed. `shortfall` is what the loan's
    ///         end left unpaid (0 when paid in full): the slot owner's loss,
    ///         owed by no one.
    event AdvanceClosed(uint256 indexed loanId, address indexed slotOwner, uint256 shortfall);

    /// @notice A fallback's in-kind lender slice of `slice` collateral was
    ///         split after its one retry: `toAdvance` (`toAdvanceInterest` of
    ///         it standing for interest) set aside for the slot owner, the rest
    ///         the holder's claim. `priced` false: the fallback had no price,
    ///         so the advance took the whole slice.
    event AdvanceInKindSplit(
        uint256 indexed loanId,
        address indexed collateralAsset,
        uint256 slice,
        uint256 toAdvance,
        uint256 toAdvanceInterest,
        bool priced
    );

    /// @notice What was set aside for `loanId`'s advance moved into the slot
    ///         owner's vault: `delivered` arrived there, and `treasuryCut` of
    ///         the interest in it reached the treasury.
    event AdvancePaidOut(
        uint256 indexed loanId,
        address indexed slotOwner,
        address indexed asset,
        uint256 setAside,
        uint256 delivered,
        uint256 treasuryCut
    );

    /// @notice The holder repaid `paid` of `loanId`'s advance from their vault.
    event AdvanceRepaidByHolder(uint256 indexed loanId, address indexed holder, address asset, uint256 paid);

    /// @notice No advance is open on `loanId`.
    error AdvanceNotOpen(uint256 loanId);
    /// @notice The holder's free balance is short of the repayment.
    error AdvanceRepayShort(uint256 free, uint256 amount);

    /// @notice Nothing is set aside for `loanId`'s advance.
    error NothingSetAside(uint256 loanId);
    /// @notice The advance's slot owner is flagged: its money stays set aside
    ///         for it until the flag clears.
    error AdvancePayeeFlagged(uint256 loanId, address slotOwner);

    uint256 private constant YEAR = 365 days;

    // ─── Diamond-internal booking ────────────────────────────────────────

    /// @inheritdoc ILenderSideHost
    function bookArrival(uint256 loanId, address asset, uint256 amount) external returns (uint256 part) {
        _onlySelf();
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        return _book(s, loanId, s.loans[loanId], s.loans[loanId].lender, asset, amount);
    }

    /// @inheritdoc ILenderSideHost
    /// @dev The row's asset says what it is. A cash row in the principal
    ///      asset is booked (only its difference from what was booked before)
    ///      and ends the advance, short if need be, unless the money has not
    ///      reached the lender side's vault yet (a lender leg, cash or in
    ///      kind, parked in the payer's vault: booked when it is released). An in-kind row is
    ///      only recorded while the fallback still waits for its retry, and
    ///      split when `inKind` says the retry is over (or when no fallback
    ///      stands behind it).
    function bookFinal(uint256 loanId, uint256 amount, bool inKind) external returns (uint256 kept) {
        _onlySelf();
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        LibVaipakam.Loan storage loan = s.loans[loanId];
        LibVaipakam.Advance storage a = s.advances[loanId];
        LibVaipakam.ClaimInfo storage row = s.lenderClaims[loanId];

        if (s.parkedLenderLeg[loanId].payer != address(0)) {
            // Not arrived (a leg parked in the payer's vault, cash or in
            // kind): booked, or split, when the leg is released into the
            // lender side's vault.
            row.amount = amount;
            return amount;
        }
        if (row.asset != loan.principalAsset || row.assetType != LibVaipakam.AssetType.ERC20) {
            if (!inKind && s.fallbackSnapshot[loanId].active) {
                row.amount = amount; // the retry has not run yet
                return amount;
            }
            kept = amount - _splitInKind(s, loanId, loan, a, row.asset, amount);
            row.amount = kept;
            return kept;
        }
        uint256 booked = a.finalBooked;
        if (amount >= booked) {
            a.finalToAdvance += _book(s, loanId, loan, loan.lender, loan.principalAsset, amount - booked);
        } else {
            _unbook(loanId, a, booked - amount);
        }
        a.finalBooked = amount;
        kept = amount - a.finalToAdvance;
        row.amount = kept;
        // The final claim is the loan's last arrival for its lender side:
        // whatever the advance is still owed now is its shortfall.
        if (a.open) _close(s, loanId, a, true);
    }

    /// @inheritdoc ILenderSideHost
    function settleAtTake(uint256 loanId, bool loanEnded) external {
        _onlySelf();
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        LibVaipakam.Advance storage a = s.advances[loanId];
        if (loanEnded && a.open) _close(s, loanId, a, true);
        if (!LibAdvance.hasSetAside(s, loanId)) return;
        if (LibSanctionedLock.mustFreezeParty(s, a.slotOwner)) return;
        _payOut(loanId, a);
    }

    /// @inheritdoc ILenderSideHost
    /// @dev The backstop's cash buys the whole lender slice, so it is the
    ///      slice's arrival: the advance's part moves from the backstop's
    ///      vault into the stored lender's vault, where it is set aside like
    ///      any arrival. Then the advance is closed (the absorb is the loan's
    ///      end for its lender side).
    function absorbArrival(uint256 loanId, address fromOwner, uint256 amount) external returns (uint256 part) {
        _onlySelf();
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        LibVaipakam.Advance storage a = s.advances[loanId];
        if (!a.open || amount == 0) return 0;
        LibVaipakam.Loan storage loan = s.loans[loanId];
        address asset = loan.principalAsset;
        _accrue(a);
        uint256 owed = a.interestOwed + a.principalOwed;
        uint256 move = amount < owed ? amount : owed;
        if (move != 0) {
            // Into the stored lender's vault, the side's custody, under the
            // advance's own booking below.
            uint256 arrived = LibVaultOutflow.toClaimCustody(
                fromOwner, LibVaultOutflow.ERC20, asset, 0, move, loanId, loan.lenderTokenId, OutflowReason.BACKSTOP
            );
            LibDelivery.requireFull(asset, move, arrived);
            part = _book(s, loanId, loan, loan.lender, asset, move);
        }
        if (a.open) _close(s, loanId, a, true);
    }

    // ─── Anyone ───────────────────────────────────────────────────────────

    /**
     * @notice Move what is set aside for `loanId`'s advance into its slot
     *         owner's vault, less the treasury's cut of the interest in it.
     *         Anyone may call it, at any time; the amounts are the same
     *         whoever calls and whenever. A keeper pass backs it.
     * @dev    Reverts {NothingSetAside} when nothing waits and
     *         {AdvancePayeeFlagged} while the slot owner is flagged (its money
     *         stays set aside for it). Where the lender position moved to a
     *         new holder, the consolidation that moves its custody runs first
     *         in that holder's own step; this pays from wherever the record
     *         says the money is.
     * @param loanId The loan whose advance is paid.
     */
    function payAdvance(uint256 loanId) external nonReentrant whenNotPaused {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        LibVaipakam.Advance storage a = s.advances[loanId];
        if (!LibAdvance.hasSetAside(s, loanId)) revert NothingSetAside(loanId);
        // Fail-closed on a confirmed flag: a slot owner once seen flagged
        // stays unpaid through an oracle outage until it reads clean.
        if (LibSanctionedLock.mustFreezeParty(s, a.slotOwner)) revert AdvancePayeeFlagged(loanId, a.slotOwner);
        _payOut(loanId, a);
    }

    /**
     * @notice The holder repays `loanId`'s advance from their own vault: up to
     *         `amount` of the lending asset, interest first, capped at what is
     *         owed now. Any amount, at any time. Paid in full, the advance
     *         closes and the position is free again.
     * @dev    The money must be free in the holder's vault. It goes straight
     *         to the slot owner's vault (the treasury's cut of the interest in
     *         it first), under the advance's own vault class. Where the slot
     *         owner is flagged, it is set aside for them where it is, in the
     *         paying holder's vault, under the advance's lien, and interest
     *         stops on it: a willing holder is never left paying interest.
     * @return paid What the advance received.
     */
    function repayAdvance(uint256 loanId, uint256 amount) external nonReentrant whenNotPaused returns (uint256 paid) {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        LibVaipakam.Advance storage a = s.advances[loanId];
        if (!a.open) revert AdvanceNotOpen(loanId);
        LibVaipakam.Loan storage loan = s.loans[loanId];
        if (LibPositionNFT.ownerOf(loan.lenderTokenId) != msg.sender) revert IVaipakamErrors.NotNFTOwner();
        _accrue(a);
        uint256 owed = a.interestOwed + a.principalOwed;
        if (amount > owed) amount = owed;
        if (amount == 0) revert IVaipakamErrors.InvalidAmount();
        address asset = loan.principalAsset;
        {
            uint256 free = LibEncumbrance.freeBalance(
                msg.sender, asset, 0, LibVaipakam.trackedHolding(msg.sender, asset, 0)
            );
            if (free < amount) revert AdvanceRepayShort(free, amount);
        }
        // The holder spent free vault balance: it leaves their depository
        // holding first, as every other spend of free balance does.
        LibDepositoryLedger.spend(msg.sender, asset, 0, amount);
        if (LibSanctionedLock.mustFreezeParty(s, a.slotOwner)) {
            // Held for the flagged slot owner, as any flagged lender's are:
            // set aside in the paying holder's own vault, where it is, and
            // interest stops on it now.
            paid = _book(s, loanId, loan, msg.sender, asset, amount);
        } else {
            uint256 ip = amount < a.interestOwed ? amount : a.interestOwed;
            uint256 pp = amount - ip;
            a.interestOwed -= ip;
            a.principalOwed -= pp;
            a.interestPaid += ip;
            paid = amount;
            if (pp != 0) _slot(loan, a, pp, 0);
            _payOne(loanId, a, msg.sender, asset, amount, ip);
            if (a.principalOwed == 0 && a.interestOwed == 0) _close(s, loanId, a, false);
        }
        emit AdvanceRepaidByHolder(loanId, msg.sender, asset, paid);
    }

    // ─── Views ────────────────────────────────────────────────────────────

    /**
     * @notice The advance on `loanId` as it stands now: the record, with the
     *         interest brought up to this moment in `interestOwedNow`.
     * @return a               The advance record (all zero: none was taken).
     * @return interestOwedNow Interest owed now, by time on what is owed.
     */
    function getAdvance(uint256 loanId)
        external
        view
        returns (LibVaipakam.Advance memory a, uint256 interestOwedNow)
    {
        a = LibVaipakam.storageSlot().advances[loanId];
        interestOwedNow = a.interestOwed + _accrued(a);
    }

    // ─── Internals ────────────────────────────────────────────────────────

    function _onlySelf() private view {
        if (msg.sender != address(this)) revert IVaipakamErrors.UnauthorizedCrossFacetCall();
    }

    /// @dev Interest by time since the last accrual on the principal owed,
    ///      rounded up (a debt leg).
    function _accrued(LibVaipakam.Advance memory a) private view returns (uint256) {
        if (!a.open || a.principalOwed == 0 || block.timestamp <= a.accruedAt) return 0;
        return Math.mulDiv(
            a.principalOwed, uint256(a.rateBps) * (block.timestamp - a.accruedAt), YEAR * 10_000, Math.Rounding.Ceil
        );
    }

    function _accrue(LibVaipakam.Advance storage a) private {
        a.interestOwed += _accrued(a);
        a.accruedAt = uint64(block.timestamp);
    }

    /// @dev The order of payment, for `amount` of `asset` that has arrived in
    ///      the stored lender's vault: the advance's interest, then the
    ///      advance; returns what it took. Never reverts for a figure.
    function _book(
        LibVaipakam.Storage storage s,
        uint256 loanId,
        LibVaipakam.Loan storage loan,
        address vault,
        address asset,
        uint256 amount
    ) private returns (uint256 part) {
        LibVaipakam.Advance storage a = s.advances[loanId];
        if (!a.open || amount == 0 || asset != loan.principalAsset) return 0;
        _accrue(a);
        uint256 ip = amount < a.interestOwed ? amount : a.interestOwed;
        uint256 left = amount - ip;
        uint256 pp = left < a.principalOwed ? left : a.principalOwed;
        part = ip + pp;
        if (part == 0) return 0;
        a.interestOwed -= ip;
        a.principalOwed -= pp;
        a.interestPaid += ip;
        // Set aside where the money is. An arrival for the position is in the
        // stored lender's vault, which is the advance's custody for its whole
        // life (the stored lender cannot change while the position is locked:
        // no sale or takeover migrates it and consolidation leaves it); only
        // a holder's own repayment can sit elsewhere, listed by vault.
        if (vault == a.custody) {
            a.setAside += part;
            a.setAsideInterest += ip;
            a.setAsideAsset = asset;
        } else {
            _holdElsewhere(s, loanId, a, vault, part, ip);
        }
        LibEncumbrance.lienAdvanceSetAside(vault, asset, part);
        // Record a flag seen now, so the set-aside stays held for a flagged
        // slot owner through a later oracle outage (never reverts).
        LibSanctionedLock.mustFreezeParty(s, a.slotOwner);
        emit AdvancePaidFromPosition(loanId, asset, ip, pp, a.principalOwed, a.interestOwed);
        if (pp != 0) _slot(loan, a, pp, 0);
        if (a.principalOwed == 0 && a.interestOwed == 0) _close(s, loanId, a, false);
    }

    /// @dev Add `part` (of which `ip` interest) to `vault`'s entry in the
    ///      advance's list of set-asides held outside its custody.
    function _holdElsewhere(
        LibVaipakam.Storage storage s,
        uint256 loanId,
        LibVaipakam.Advance storage a,
        address vault,
        uint256 part,
        uint256 ip
    ) private {
        LibVaipakam.AdvanceHold[] storage holds = s.advanceHolds[loanId];
        a.heldElsewhere += part;
        for (uint256 i; i < holds.length; ++i) {
            if (holds[i].vault == vault) {
                holds[i].amount += part;
                holds[i].interest += ip;
                return;
            }
        }
        holds.push(LibVaipakam.AdvanceHold({vault: vault, amount: part, interest: ip}));
    }

    /// @dev The final claim fell by `drop` after it was booked (what was
    ///      expected did not all arrive). The holder's part bears it first,
    ///      since the advance is paid first; only what is left of the drop
    ///      comes off the set-aside, and the advance's shortfall grows by it.
    function _unbook(uint256 loanId, LibVaipakam.Advance storage a, uint256 drop) private {
        uint256 holderPart = a.finalBooked - a.finalToAdvance;
        if (drop <= holderPart) return;
        uint256 fromAdvance = drop - holderPart;
        if (fromAdvance > a.finalToAdvance) fromAdvance = a.finalToAdvance;
        if (fromAdvance > a.setAside) fromAdvance = a.setAside;
        a.finalToAdvance -= fromAdvance;
        a.setAside -= fromAdvance;
        if (a.setAsideInterest > a.setAside) a.setAsideInterest = a.setAside;
        LibEncumbrance.unlienAdvanceSetAside(a.custody, a.setAsideAsset, fromAdvance);
        a.shortfall += fromAdvance;
        emit AdvanceClosed(loanId, a.slotOwner, a.shortfall);
    }

    /// @dev Close the advance. `short`: whatever is still owed becomes the
    ///      stated shortfall (the loan has ended).
    function _close(LibVaipakam.Storage storage s, uint256 loanId, LibVaipakam.Advance storage a, bool short)
        private
    {
        if (short) {
            _accrue(a);
            uint256 principalLeft = a.principalOwed;
            a.shortfall += principalLeft + a.interestOwed;
            a.principalOwed = 0;
            a.interestOwed = 0;
            if (principalLeft != 0) _slot(s.loans[loanId], a, principalLeft, 0);
        }
        a.open = false;
        emit AdvanceClosed(loanId, a.slotOwner, a.shortfall);
    }

    /// @dev The fallback's in-kind split, after its one retry: the advance
    ///      takes collateral worth what it is owed at the fallback's own rate
    ///      (rounded up, lender first), capped at the slice; all of it where
    ///      the fallback had no price. Closes the advance.
    function _splitInKind(
        LibVaipakam.Storage storage s,
        uint256 loanId,
        LibVaipakam.Loan storage loan,
        LibVaipakam.Advance storage a,
        address asset,
        uint256 slice
    ) private returns (uint256 toAdvance) {
        if (!a.open || slice == 0) return 0;
        _accrue(a);
        bool priced;
        (toAdvance, priced) = _inKindPart(s.fallbackSnapshot[loanId], a, slice);
        _setAsideInKind(loan, a, asset, toAdvance);
        emit AdvanceInKindSplit(loanId, asset, slice, toAdvance, a.inKindInterest, priced);
        if (!priced) {
            // The whole slice went to the advance and its worth cannot be
            // stated: the advance is settled by it, no shortfall is stated,
            // and the event above says the split was unpriced.
            a.interestPaid += a.interestOwed;
            if (a.principalOwed != 0) _slot(loan, a, a.principalOwed, 0);
            a.interestOwed = 0;
            a.principalOwed = 0;
            _close(s, loanId, a, false);
            return toAdvance;
        }
        _settlePriced(s, loanId, loan, a, toAdvance);
    }

    /// @dev The advance's part of an in-kind slice: collateral worth what it
    ///      is owed at the fallback's own rate (rounded up), capped at the
    ///      slice; the whole slice where the fallback had no price.
    function _inKindPart(LibVaipakam.FallbackSnapshot storage snap, LibVaipakam.Advance storage a, uint256 slice)
        private
        view
        returns (uint256 toAdvance, bool priced)
    {
        priced = snap.rateDen != 0;
        toAdvance = priced
            ? Math.mulDiv(a.interestOwed + a.principalOwed, snap.rateNum, snap.rateDen, Math.Rounding.Ceil)
            : slice;
        if (toAdvance > slice) toAdvance = slice;
    }

    /// @dev Set `toAdvance` of the collateral aside for the slot owner, its
    ///      interest share in proportion to what is owed.
    function _setAsideInKind(
        LibVaipakam.Loan storage loan,
        LibVaipakam.Advance storage a,
        address asset,
        uint256 toAdvance
    ) private {
        uint256 owed = a.interestOwed + a.principalOwed;
        a.inKindInterest += owed == 0 ? 0 : Math.mulDiv(toAdvance, a.interestOwed, owed);
        a.inKindSetAside += toAdvance;
        if (a.setAside == 0 && a.inKindSetAside == toAdvance) a.custody = loan.lender;
        LibEncumbrance.lienAdvanceSetAside(loan.lender, asset, toAdvance);
        LibSanctionedLock.mustFreezeParty(LibVaipakam.storageSlot(), a.slotOwner);
    }

    /// @dev Priced: the collateral counts for what it is worth at the
    ///      fallback's rate; whatever it does not cover is the stated
    ///      shortfall.
    function _settlePriced(
        LibVaipakam.Storage storage s,
        uint256 loanId,
        LibVaipakam.Loan storage loan,
        LibVaipakam.Advance storage a,
        uint256 toAdvance
    ) private {
        LibVaipakam.FallbackSnapshot storage snap = s.fallbackSnapshot[loanId];
        uint256 owed = a.interestOwed + a.principalOwed;
        uint256 covered = Math.mulDiv(toAdvance, snap.rateDen, snap.rateNum);
        if (covered > owed) covered = owed;
        uint256 ic = covered < a.interestOwed ? covered : a.interestOwed;
        uint256 pc = covered - ic;
        if (pc > a.principalOwed) pc = a.principalOwed;
        a.interestPaid += ic;
        a.interestOwed -= ic;
        a.principalOwed -= pc;
        if (pc != 0) _slot(loan, a, pc, 0);
        _close(s, loanId, a, true);
    }

    /// @dev Pay both set-asides (cash, then in kind) to the slot owner, the
    ///      treasury's cut of the interest first. Records and liens are
    ///      cleared before any money moves.
    function _payOut(uint256 loanId, LibVaipakam.Advance storage a) private {
        address custody = a.custody;
        if (a.setAside != 0) {
            (uint256 amount, uint256 interest, address asset) = (a.setAside, a.setAsideInterest, a.setAsideAsset);
            a.setAside = 0;
            a.setAsideInterest = 0;
            LibEncumbrance.unlienAdvanceSetAside(custody, asset, amount);
            _payOne(loanId, a, custody, asset, amount, interest);
        }
        if (a.inKindSetAside != 0) {
            (uint256 amount, uint256 interest) = (a.inKindSetAside, a.inKindInterest);
            a.inKindSetAside = 0;
            a.inKindInterest = 0;
            LibEncumbrance.unlienAdvanceSetAside(custody, a.collateralAsset, amount);
            _payOne(loanId, a, custody, a.collateralAsset, amount, interest);
        }
        if (a.heldElsewhere != 0) {
            LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
            LibVaipakam.AdvanceHold[] memory holds = s.advanceHolds[loanId];
            delete s.advanceHolds[loanId];
            a.heldElsewhere = 0;
            address asset = s.loans[loanId].principalAsset;
            for (uint256 i; i < holds.length; ++i) {
                LibEncumbrance.unlienAdvanceSetAside(holds[i].vault, asset, holds[i].amount);
            }
            for (uint256 i; i < holds.length; ++i) {
                _payOne(loanId, a, holds[i].vault, asset, holds[i].amount, holds[i].interest);
            }
        }
    }

    /// @dev Move `amount` of `asset` from `payer`'s vault to the slot owner's,
    ///      less the treasury's cut of the `interest` in it.
    function _payOne(
        uint256 loanId,
        LibVaipakam.Advance storage a,
        address custody,
        address asset,
        uint256 amount,
        uint256 interest
    ) private {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        uint256 cut = Math.mulDiv(interest, a.treasuryFeeBps, 10_000);
        // A flagged holder does not stop the advance's own payment: the
        // custody vault is the paying side, not a recipient.
        LibSanctionedLock.beginMoveOut(s, custody);
        uint256 cutPaid = cut == 0
            ? 0
            : LibFacet.vaultFeeToTreasury(custody, asset, cut, LibFeeFloor.interest(interest, a.treasuryFeeBps));
        LibAdvancePayAuth.authorize(loanId, LibAdvancePayAuth.REPAYMENT, amount - cut);
        uint256 delivered = LibVaultOutflow.toAdvanceLender(custody, asset, amount - cut, loanId);
        LibAdvancePayAuth.clear(loanId, LibAdvancePayAuth.REPAYMENT);
        LibSanctionedLock.endMoveOut(s);
        emit AdvancePaidOut(loanId, a.slotOwner, asset, amount, delivered, cutPaid);
    }

    /// @dev The slot's live principal follows the advance principal it has
    ///      out (saturating; never reverts).
    function _slot(LibVaipakam.Loan storage loan, LibVaipakam.Advance storage a, uint256 from, uint256 to) private {
        LibFacet.crossFacetCall(
            abi.encodeCall(
                MarketLedgerFacet.onSlotAdvance,
                (a.slotOwner, loan.principalAsset, a.collateralAsset, a.slot, from, to)
            ),
            IVaipakamErrors.CrossFacetCallFailed.selector
        );
    }
}
