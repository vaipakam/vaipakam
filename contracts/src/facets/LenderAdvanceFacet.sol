// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {LibVaipakam} from "../libraries/LibVaipakam.sol";
import {LibPositionNFT} from "../libraries/LibPositionNFT.sol";
import {LibAdvance} from "../libraries/LibAdvance.sol";
import {LibAdvancePayAuth} from "../libraries/LibAdvancePayAuth.sol";
import {LibEncumbrance} from "../libraries/LibEncumbrance.sol";
import {LibFacet} from "../libraries/LibFacet.sol";
import {LibFeeFloor} from "../libraries/LibFeeFloor.sol";
import {LibInitiationFee} from "../libraries/LibInitiationFee.sol";
import {LibIntentFill} from "../libraries/LibIntentFill.sol";
import {LibLoanClock} from "../libraries/LibLoanClock.sol";
import {LibNewLoanRisk} from "../libraries/LibNewLoanRisk.sol";
import {LibProtectedAccount} from "../libraries/LibProtectedAccount.sol";
import {LibRiskAccess} from "../libraries/LibRiskAccess.sol";
import {LibTerms} from "../libraries/LibTerms.sol";
import {LibTiming} from "../libraries/LibTiming.sol";
import {LibVaultOutflow} from "../libraries/LibVaultOutflow.sol";
import {LibPausable, DiamondPausable} from "../libraries/LibPausable.sol";
import {LibAccessControl, DiamondAccessControl} from "../libraries/LibAccessControl.sol";
import {DiamondReentrancyGuard} from "../libraries/LibReentrancyGuard.sol";
import {IVaipakamErrors} from "../interfaces/IVaipakamErrors.sol";
import {SaleExitVerdictFacet} from "./SaleExitVerdictFacet.sol";
import {EarlyWithdrawalFacet} from "./EarlyWithdrawalFacet.sol";
import {VaipakamNFTFacet} from "./VaipakamNFTFacet.sol";
import {OfferPriceGuardFacet} from "./OfferPriceGuardFacet.sol";
import {MarketLedgerFacet} from "./MarketLedgerFacet.sol";
import {ConsolidationFacet} from "./ConsolidationFacet.sol";

/**
 * @title  LenderAdvanceFacet
 * @author Vaipakam Developer Team
 * @notice #3760 — "Borrow against it": an Auto-lend slot advances cash to the
 *         holder of a lender position, and the loan itself repays it
 *         (LenderCashOutDesign §5 – §6). The advance is owed by the POSITION,
 *         not by the person: everything the loan pays its lender side goes to
 *         the advance's interest, then the advance, then the holder
 *         (`LenderSideFacet`, reached through `LibLenderSide`). There is no
 *         date for the holder to meet, no health factor and no liquidation of
 *         the holder, and the token never leaves them. It is not a pledge:
 *         the position token is never collateral (#3667 Part A stands).
 *
 *         This facet holds the slot owner's consent ({setAdvanceSlot}), the
 *         feature's switch ({setAdvancesEnabled}, off at deploy), the one
 *         admission rule ({advanceRefusals}, {previewAdvance}), and the
 *         opening step ({takeAdvance}). Repayment by the holder, the order of
 *         payment and the payment to the slot owner are `LenderSideFacet`'s.
 *
 * @dev    One rule for the read and the entry: {takeAdvance} runs the same
 *         classifier {previewAdvance} reports, stopping at the first refusal
 *         and raising it as the error the read names.
 *
 *         Opening, in order: the lender position is consolidated into its
 *         holder's vault (so the money that will repay the advance arrives
 *         where the holder is), the slot's capital lien is drawn by the
 *         amount, the initiation fee of a loan of that amount for the time to
 *         the loan's due date goes from the slot owner's vault to the
 *         treasury, and the rest moves to the holder's vault as free balance
 *         under the `AdvanceToHolder` vault class. The amount the record names
 *         as owed is the whole amount, as a borrower owes the whole principal
 *         of a loan whose fee was taken from it.
 */
contract LenderAdvanceFacet is DiamondReentrancyGuard, DiamondPausable, DiamondAccessControl {
    /// @notice The largest share of a loan's outstanding principal any slot
    ///         may advance, interest to the grace end included (§6.1).
    uint16 public constant ADVANCE_MAX_SHARE_BPS = 8_500;
    /// @notice The share a slot advances when its owner names none.
    uint16 public constant ADVANCE_DEFAULT_SHARE_BPS = 7_000;

    uint256 private constant YEAR = 365 days;
    uint256 private constant MAX_REFUSALS = 32;

    /// @notice What an advance would be, for one slot and amount.
    /// @param refusals     Every refusal, in the order {takeAdvance} meets them.
    /// @param amount       The amount (the slot's largest when 0 was asked).
    /// @param rateBps      The slot's rate, fixed for the advance.
    /// @param fee          The initiation fee taken from the advance.
    /// @param received     What would reach the holder's vault.
    /// @param interestToGraceEnd Interest on the whole amount to the loan's
    ///                     grace end: the most the loan's lateness can cost.
    /// @param slotCeiling  The largest amount this slot advances on this loan
    ///                     now: its share of the outstanding principal, less
    ///                     interest to the grace end, within its room.
    struct AdvancePreview {
        SaleExitVerdictFacet.SaleRefusal[] refusals;
        uint256 amount;
        uint256 rateBps;
        uint256 fee;
        uint256 received;
        uint256 interestToGraceEnd;
        uint256 slotCeiling;
    }

    /// @dev A fixed-capacity refusal list built in memory, trimmed on return.
    struct Refusals {
        SaleExitVerdictFacet.SaleRefusal[] items;
        uint256 count;
        bool stopAtFirst;
    }

    /// @notice The slot owner set the slot's consent to advance on loans.
    event AdvanceSlotSet(
        address indexed owner,
        address indexed lendingAsset,
        address indexed collateralAsset,
        uint8 slot,
        bool consent,
        uint16 maxShareBps
    );
    /// @notice The advance feature's switch moved.
    event AdvancesEnabledSet(bool enabled);
    /// @notice An advance opened on `loanId`'s lender position.
    /// @param amount   What the position owes (the whole advance).
    /// @param fee      The initiation fee taken from it, to the treasury.
    /// @param received What reached the holder's vault, measured.
    event AdvanceTaken(
        uint256 indexed loanId,
        address indexed holder,
        address indexed slotOwner,
        uint8 slot,
        address asset,
        uint256 amount,
        uint256 rateBps,
        uint256 fee,
        uint256 received
    );

    /// @notice New advances are switched off on this deployment.
    error AdvancesDisabled();
    /// @notice Both assets must be ERC-20 and top tier, and differ.
    error AdvancePairNotEligible(address lendingAsset, address collateralAsset);
    /// @notice The loan's interest must be owed by time.
    error AdvanceNeedsInterestByTime(uint256 loanId);
    /// @notice The loan is past its due date.
    error AdvanceLoanPastDue(uint256 loanId, uint256 maturity);
    /// @notice Something is held unclaimed for the position: claim it first.
    error AdvanceHeldUnclaimed(uint256 loanId, uint256 held);
    /// @notice A seller claim of an earlier sale is open on the loan.
    error AdvanceSellerClaimOpen(uint256 loanId, uint256 claims);
    /// @notice The loan's due date is not firm: the lender's extension
    ///         consent is on. Switch it off first.
    error AdvanceNeedsFirmDueDate(uint256 loanId);
    /// @notice The amount is above what the rules allow.
    error AdvanceAboveCeiling(uint256 amount, uint256 ceiling);
    /// @notice No amount, or an amount below the slot's smallest fill.
    error AdvanceBelowSlotMinimum(uint256 amount, uint256 minimum);
    /// @notice The slot has not consented to advance on loans, or its consent
    ///         has not stood the minimum age.
    error AdvanceSlotNoConsent(address slotOwner, uint8 slot);
    /// @notice The loan's grace period ends after the slot's lend-until time.
    error AdvancePastLendUntil(uint256 graceEnd, uint256 lendUntil);
    /// @notice The slot's owner is the loan's borrower or the holder.
    error AdvanceSameParty(address slotOwner);
    /// @notice The slot's rate is above the holder's highest accepted rate.
    error AdvanceRateAboveMax(uint256 rateBps, uint256 maxRateBps);
    /// @notice The slot's rate cannot be carried by an advance.
    error AdvanceRateOutOfRange(uint256 rateBps);
    /// @notice The slot's exposure would be exceeded.
    error AdvanceExposureExceeded(uint256 livePrincipal, uint256 amount, uint256 maxExposure);
    /// @notice The slot's reserved capital is short of the amount.
    error AdvanceCapitalShort(uint256 capital, uint256 amount);
    /// @notice What reached the holder's vault is below their stated least.
    error AdvanceReceivedBelowLeast(uint256 received, uint256 least);
    /// @notice A consent share outside 1 – 8,500 bps.
    error AdvanceShareOutOfRange(uint16 shareBps);
    /// @notice The slot is not an active Auto-lend slot.
    error AdvanceSlotInactive();

    // ─── Settings ─────────────────────────────────────────────────────────

    /// @notice Switch new advances on or off. An open advance runs to its end
    ///         either way. Off at deploy.
    function setAdvancesEnabled(bool enabled) external onlyRole(LibAccessControl.ADMIN_ROLE) {
        LibVaipakam.storageSlot().advancesEnabled = enabled;
        emit AdvancesEnabledSet(enabled);
    }

    /// @notice Whether new advances are on.
    function advancesEnabled() external view returns (bool) {
        return LibVaipakam.storageSlot().advancesEnabled;
    }

    /**
     * @notice The caller's consent for one of their Auto-lend slots to
     *         advance on loans, with the largest share of a loan's
     *         outstanding principal it advances (0 = the default 70%; never
     *         above 85%). Setting the slot's terms again clears it.
     * @dev    The slot's other settings apply as they do to a loan: its
     *         lowest rate (the advance's rate), smallest fill, exposure and
     *         lend-until time. A consent stands the same minimum age as the
     *         slot's terms before an advance draws on it.
     */
    function setAdvanceSlot(
        address lendingAsset,
        address collateralAsset,
        uint8 slot,
        bool consent,
        uint16 maxShareBps
    ) external nonReentrant whenNotPaused {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        if (consent) {
            LibVaipakam._assertNotSanctioned(msg.sender);
            LibProtectedAccount.requireCanOpen(msg.sender);
            if (!s.lenderIntent[msg.sender][lendingAsset][collateralAsset][slot].active) {
                revert AdvanceSlotInactive();
            }
            if (maxShareBps == 0) maxShareBps = ADVANCE_DEFAULT_SHARE_BPS;
            if (maxShareBps > ADVANCE_MAX_SHARE_BPS) revert AdvanceShareOutOfRange(maxShareBps);
        } else {
            maxShareBps = 0;
        }
        s.advanceSlot[msg.sender][lendingAsset][collateralAsset][slot] =
            LibVaipakam.AdvanceSlot({consent: consent, maxShareBps: maxShareBps, setAt: uint64(block.timestamp)});
        emit AdvanceSlotSet(msg.sender, lendingAsset, collateralAsset, slot, consent, maxShareBps);
    }

    /// @notice A slot's consent to advance on loans.
    function getAdvanceSlot(address owner, address lendingAsset, address collateralAsset, uint8 slot)
        external
        view
        returns (LibVaipakam.AdvanceSlot memory)
    {
        return LibVaipakam.storageSlot().advanceSlot[owner][lendingAsset][collateralAsset][slot];
    }

    // ─── The one rule ─────────────────────────────────────────────────────

    /**
     * @notice Every refusal an advance on `loanId`'s lender position meets for
     *         `caller` before any slot is chosen: the loan, the position and
     *         the holder. `amount` 0 asks for "as much as the rules allow";
     *         otherwise it is held against the 85% ceiling. Read
     *         {previewAdvance} for a slot's own answer.
     */
    function advanceRefusals(uint256 loanId, address caller, uint256 amount)
        external
        view
        returns (SaleExitVerdictFacet.SaleRefusal[] memory)
    {
        Refusals memory r = _new(false);
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        _position(s, r, loanId, caller);
        if (amount != 0) {
            uint256 ceiling = (s.loans[loanId].principal * ADVANCE_MAX_SHARE_BPS) / 10_000;
            if (amount > ceiling) _add(r, abi.encodeWithSelector(AdvanceAboveCeiling.selector, amount, ceiling));
        }
        return _trim(r);
    }

    /**
     * @notice What an advance of `amount` from `slotOwner`'s slot `slot` on
     *         lender position `tokenId` would be for `caller` now, with every
     *         refusal. `amount` 0 previews the slot's largest.
     */
    function previewAdvance(uint256 tokenId, address caller, address slotOwner, uint8 slot, uint256 amount)
        external
        view
        returns (AdvancePreview memory p)
    {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        uint256 loanId = LibPositionNFT._storage().loanIds[tokenId];
        Refusals memory r = _new(false);
        p = _classify(s, r, loanId, tokenId, caller, slotOwner, slot, amount, type(uint256).max);
        p.refusals = _trim(r);
    }

    // ─── Opening ──────────────────────────────────────────────────────────

    /**
     * @notice Take an advance of `amount` against lender position `tokenId`
     *         from `slotOwner`'s Auto-lend slot `slot`.
     * @param  tokenId     The lender position token; the caller must hold it.
     * @param  slotOwner   The slot's owner.
     * @param  slot        The slot index (keyed by the loan's two assets).
     * @param  amount      What the position will owe (fee taken from it).
     * @param  maxRateBps  The highest rate the holder accepts.
     * @param  minReceived The least that must reach the holder's vault.
     * @param  validUntil  The transaction deadline.
     * @return received    What reached the holder's vault, measured.
     */
    function takeAdvance(
        uint256 tokenId,
        address slotOwner,
        uint8 slot,
        uint256 amount,
        uint256 maxRateBps,
        uint256 minReceived,
        uint64 validUntil
    ) external nonReentrant whenNotPaused returns (uint256 received) {
        LibTiming.requireDeadline(validUntil);
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        uint256 loanId = LibPositionNFT._storage().loanIds[tokenId];
        // The position's money must arrive where its holder is: move it there
        // first (a no-op when it already is).
        LibFacet.crossFacetCall(
            abi.encodeCall(ConsolidationFacet.eagerConsolidateToHolder, (loanId, true)),
            IVaipakamErrors.CrossFacetCallFailed.selector
        );
        AdvancePreview memory p;
        {
            Refusals memory r = _new(true);
            p = _classify(s, r, loanId, tokenId, msg.sender, slotOwner, slot, amount, maxRateBps);
            if (r.count != 0) {
                bytes memory reason = r.items[0].reason;
                assembly ("memory-safe") {
                    revert(add(reason, 0x20), mload(reason))
                }
            }
        }
        received = _open(s, loanId, slotOwner, slot, p);
        if (received < minReceived) revert AdvanceReceivedBelowLeast(received, minReceived);
    }

    // ─── Self-call checks (collected by the classifier) ───────────────────

    /// @notice The health test a new loan must pass, for `loanId` now.
    /// @dev    An external view so the classifier can collect its refusal.
    function requireAdvanceHealth(uint256 loanId) external view {
        LibVaipakam.Loan storage loan = LibVaipakam.storageSlot().loans[loanId];
        LibNewLoanRisk.requireAdmissible(loanId, loan.collateralAsset);
    }

    /// @notice A party to an advance may take on a new commitment: the Terms
    ///         in force accepted, and not locked or retired.
    function requireAdvanceParty(address who) external view {
        LibTerms.requireCurrent(LibProtectedAccount.manager(who));
        LibProtectedAccount.requireCanOpen(who);
    }

    /// @notice The slot is live (the fill switch, active, aged, its owner
    ///         may open) and its pair is calm.
    function requireAdvanceSlotLive(address owner, address lendingAsset, address collateralAsset, uint8 slot)
        external
        view
    {
        LibVaipakam.LenderIntent memory intent =
            LibVaipakam.storageSlot().lenderIntent[owner][lendingAsset][collateralAsset][slot];
        LibIntentFill.requireSlotLive(intent, owner);
        OfferPriceGuardFacet(address(this)).requireIntentPairCalm(owner, lendingAsset, collateralAsset, slot);
    }

    // ─── Internals ────────────────────────────────────────────────────────

    /// @dev The checks on the loan, the position and its holder, in the
    ///      order {takeAdvance} meets them.
    function _position(LibVaipakam.Storage storage s, Refusals memory r, uint256 loanId, address caller)
        private
        view
    {
        if (LibPausable.paused()) {
            _add(r, abi.encodeWithSelector(LibPausable.EnforcedPause.selector));
            if (_full(r)) return;
        }
        if (!s.advancesEnabled) {
            _add(r, abi.encodeWithSelector(AdvancesDisabled.selector));
            if (_full(r)) return;
        }
        if (LibVaipakam.isSanctionedAddress(caller)) {
            _add(r, abi.encodeWithSelector(LibVaipakam.SanctionedAddress.selector, caller));
            if (_full(r)) return;
        }
        LibVaipakam.Loan storage loan = s.loans[loanId];
        address holder = LibPositionNFT.holderOrZero(loan.lenderTokenId);
        if (loanId == 0 || loan.status != LibVaipakam.LoanStatus.Active || holder == address(0)) {
            _add(r, abi.encodeWithSelector(IVaipakamErrors.LoanNotActive.selector));
            return;
        }
        if (caller != holder) {
            _add(r, abi.encodeWithSelector(IVaipakamErrors.NotNFTOwner.selector));
            if (_full(r)) return;
        }
        // An emergency pause of either asset stops new exposure in it, as it
        // stops a takeover drawing the same kind of slot capital.
        if (LibFacet.isAssetPaused(loan.principalAsset)) {
            _add(r, abi.encodeWithSelector(IVaipakamErrors.AssetPaused.selector, loan.principalAsset));
            if (_full(r)) return;
        }
        if (LibFacet.isAssetPaused(loan.collateralAsset)) {
            _add(r, abi.encodeWithSelector(IVaipakamErrors.AssetPaused.selector, loan.collateralAsset));
            if (_full(r)) return;
        }
        if (LibVaipakam.positionMovePartyBlocked(holder) && holder != caller) {
            _add(r, abi.encodeWithSelector(LibVaipakam.SanctionedAddress.selector, holder));
            if (_full(r)) return;
        }
        _try(r, abi.encodeCall(this.requireAdvanceParty, (holder)));
        if (_full(r)) return;
        if (
            loan.assetType != LibVaipakam.AssetType.ERC20
                || loan.collateralAssetType != LibVaipakam.AssetType.ERC20
                || loan.principalAsset == loan.collateralAsset
                || !LibRiskAccess._isBlueChip(loan.principalAsset)
                || !LibRiskAccess._isBlueChip(loan.collateralAsset)
        ) {
            _add(
                r,
                abi.encodeWithSelector(AdvancePairNotEligible.selector, loan.principalAsset, loan.collateralAsset)
            );
            if (_full(r)) return;
        }
        if (loan.useFullTermInterest) {
            _add(r, abi.encodeWithSelector(AdvanceNeedsInterestByTime.selector, loanId));
            if (_full(r)) return;
        }
        {
            uint256 maturity = LibLoanClock.maturity(loan);
            if (block.timestamp >= maturity) {
                _add(r, abi.encodeWithSelector(AdvanceLoanPastDue.selector, loanId, maturity));
                if (_full(r)) return;
            }
        }
        if (s.heldForLender[loanId] != 0) {
            _add(r, abi.encodeWithSelector(AdvanceHeldUnclaimed.selector, loanId, s.heldForLender[loanId]));
            if (_full(r)) return;
        }
        {
            (, uint64 valueOutBlock, uint64 readyAt) = LibPositionNFT.stateOf(loan.lenderTokenId);
            if (valueOutBlock != 0 && (block.number <= valueOutBlock || block.timestamp < readyAt)) {
                _add(
                    r,
                    abi.encodeWithSelector(
                        VaipakamNFTFacet.PositionCoolingDown.selector, loan.lenderTokenId, valueOutBlock, readyAt
                    )
                );
                if (_full(r)) return;
            }
        }
        // One route per position: an advance (or money still set aside for
        // one), a listing, or a borrower's offset.
        if (LibAdvance.locked(s, loanId)) {
            _add(r, abi.encodeWithSelector(LibAdvance.AdvanceLocksPosition.selector, loanId));
            if (_full(r)) return;
        }
        if (s.loanToSaleOfferId[loanId] != 0) {
            _add(r, abi.encodeWithSelector(IVaipakamErrors.SaleOfferAlreadyExists.selector));
            if (_full(r)) return;
        }
        if (s.loanToOffsetOfferId[loanId] != 0) {
            _add(r, abi.encodeWithSelector(EarlyWithdrawalFacet.OffsetActiveOnLoan.selector));
            if (_full(r)) return;
        }
        if (s.sellerInterestClaims[loanId].length != 0) {
            _add(
                r,
                abi.encodeWithSelector(AdvanceSellerClaimOpen.selector, loanId, s.sellerInterestClaims[loanId].length)
            );
            if (_full(r)) return;
        }
        if (s.autoExtendLenderCaps[loanId].enabled) {
            _add(r, abi.encodeWithSelector(AdvanceNeedsFirmDueDate.selector, loanId));
            if (_full(r)) return;
        }
        _try(r, abi.encodeCall(this.requireAdvanceHealth, (loanId)));
    }

    /// @dev The whole rule for one slot and amount; fills the preview's
    ///      figures as it goes.
    function _classify(
        LibVaipakam.Storage storage s,
        Refusals memory r,
        uint256 loanId,
        uint256 tokenId,
        address caller,
        address slotOwner,
        uint8 slot,
        uint256 amount,
        uint256 maxRateBps
    ) private view returns (AdvancePreview memory p) {
        LibVaipakam.Loan storage loan = s.loans[loanId];
        if (loanId == 0 || loan.lenderTokenId != tokenId) {
            _add(r, abi.encodeWithSelector(IVaipakamErrors.LoanNotActive.selector));
            return p;
        }
        _position(s, r, loanId, caller);
        if (_full(r) || loan.status != LibVaipakam.LoanStatus.Active) return p;
        address lend = loan.principalAsset;
        address coll = loan.collateralAsset;
        LibVaipakam.LenderIntent memory intent = s.lenderIntent[slotOwner][lend][coll][slot];

        // The slot: consent (aged), live, its owner a fit party.
        {
            LibVaipakam.AdvanceSlot memory consent = s.advanceSlot[slotOwner][lend][coll][slot];
            if (!consent.consent || !LibTiming.termsAged(consent.setAt)) {
                _add(r, abi.encodeWithSelector(AdvanceSlotNoConsent.selector, slotOwner, slot));
                if (_full(r)) return p;
            }
            _try(r, abi.encodeCall(this.requireAdvanceSlotLive, (slotOwner, lend, coll, slot)));
            if (_full(r)) return p;
            if (
                slotOwner == LibPositionNFT.holderOrZero(loan.lenderTokenId)
                    || slotOwner == LibPositionNFT.holderOrZero(loan.borrowerTokenId)
            ) {
                _add(r, abi.encodeWithSelector(AdvanceSameParty.selector, slotOwner));
                if (_full(r)) return p;
            }
            if (LibVaipakam.isSanctionedAddress(slotOwner)) {
                _add(r, abi.encodeWithSelector(LibVaipakam.SanctionedAddress.selector, slotOwner));
                if (_full(r)) return p;
            }
            _try(r, abi.encodeCall(this.requireAdvanceParty, (slotOwner)));
            if (_full(r)) return p;
            uint256 graceEnd = LibLoanClock.graceEnd(loan);
            if (intent.lendUntil != 0 && graceEnd > intent.lendUntil) {
                _add(r, abi.encodeWithSelector(AdvancePastLendUntil.selector, graceEnd, uint256(intent.lendUntil)));
                if (_full(r)) return p;
            }
            p.rateBps = intent.minRateBps;
            if (p.rateBps > type(uint16).max) {
                _add(r, abi.encodeWithSelector(AdvanceRateOutOfRange.selector, p.rateBps));
                if (_full(r)) return p;
            }
            if (p.rateBps > maxRateBps) {
                _add(r, abi.encodeWithSelector(AdvanceRateAboveMax.selector, p.rateBps, maxRateBps));
                if (_full(r)) return p;
            }
            // The slot's ceiling: its share of the outstanding principal holds
            // the advance AND its interest to the grace end, so principal
            // alone repays it. A ≤ cap · Y / (Y + rate · t), Y = year · 10⁴.
            uint256 share = consent.maxShareBps == 0 ? ADVANCE_DEFAULT_SHARE_BPS : consent.maxShareBps;
            uint256 cap = (loan.principal * share) / 10_000;
            uint256 t = graceEnd > block.timestamp ? graceEnd - block.timestamp : 0;
            p.slotCeiling = Math.mulDiv(cap, YEAR * 10_000, YEAR * 10_000 + p.rateBps * t);
            {
                uint256 room = s.lenderIntentLivePrincipal[slotOwner][lend][coll][slot];
                room = room >= intent.maxExposure ? 0 : intent.maxExposure - room;
                uint256 capital = s.lenderIntentCapital[slotOwner][lend][coll][slot];
                if (room < p.slotCeiling) p.slotCeiling = room;
                if (capital < p.slotCeiling) p.slotCeiling = capital;
            }
            p.amount = amount == 0 ? p.slotCeiling : amount;
            p.interestToGraceEnd = _interest(p.amount, p.rateBps, t);
            if (p.amount == 0 || p.amount < intent.minFillAmount) {
                _add(r, abi.encodeWithSelector(AdvanceBelowSlotMinimum.selector, p.amount, intent.minFillAmount));
                if (_full(r)) return p;
            }
            if (p.amount + p.interestToGraceEnd > cap) {
                _add(r, abi.encodeWithSelector(AdvanceAboveCeiling.selector, p.amount, p.slotCeiling));
                if (_full(r)) return p;
            }
        }
        {
            uint256 live = s.lenderIntentLivePrincipal[slotOwner][lend][coll][slot];
            if (live + p.amount > intent.maxExposure) {
                _add(r, abi.encodeWithSelector(AdvanceExposureExceeded.selector, live, p.amount, intent.maxExposure));
                if (_full(r)) return p;
            }
            uint256 capital = s.lenderIntentCapital[slotOwner][lend][coll][slot];
            if (capital < p.amount) {
                _add(r, abi.encodeWithSelector(AdvanceCapitalShort.selector, capital, p.amount));
                if (_full(r)) return p;
            }
        }
        // The initiation fee of a loan of this amount for the time to the
        // loan's due date, taken from the advance.
        {
            uint256 maturity = LibLoanClock.maturity(loan);
            uint256 termDays = maturity > block.timestamp ? (maturity - block.timestamp + 1 days - 1) / 1 days : 0;
            p.fee = LibInitiationFee.feeOf(p.amount, termDays);
            if (p.fee > p.amount) p.fee = p.amount;
            p.received = p.amount - p.fee;
        }
    }

    /// @dev Open the advance: draw the slot's capital, pay the fee, move the
    ///      rest to the holder's vault, write the record, move the slot's
    ///      live principal.
    function _open(
        LibVaipakam.Storage storage s,
        uint256 loanId,
        address slotOwner,
        uint8 slot,
        AdvancePreview memory p
    ) private returns (uint256 received) {
        LibVaipakam.Loan storage loan = s.loans[loanId];
        address lend = loan.principalAsset;
        address coll = loan.collateralAsset;
        address holder = LibPositionNFT.ownerOf(loan.lenderTokenId);
        // The position's money arrives in `loan.lender`'s vault, so that is
        // where the advance is repaid from; consolidation above made it the
        // holder's.
        if (loan.lender != holder) revert IVaipakamErrors.NotNFTOwner();

        // The record first: the position is locked from here on.
        LibVaipakam.Advance storage a = s.advances[loanId];
        delete s.advances[loanId];
        a.slotOwner = slotOwner;
        a.collateralAsset = coll;
        a.slot = slot;
        a.open = true;
        a.rateBps = uint16(p.rateBps);
        a.treasuryFeeBps = uint16(LibVaipakam.cfgTreasuryFeeBps());
        a.openedAt = uint64(block.timestamp);
        a.accruedAt = uint64(block.timestamp);
        a.advanced = p.amount;
        a.principalOwed = p.amount;
        a.setAsideAsset = lend;
        a.custody = holder;

        // The slot's capital: the lien comes off by the whole amount, the fee
        // goes to the treasury from the owner's vault, the rest to the
        // holder's vault as free balance.
        LibEncumbrance.unlienIntentCapital(slotOwner, lend, coll, slot, p.amount);
        LibVaipakam.syncIntentRegistry(slotOwner, lend, coll, slot);
        uint256 feePaid = p.fee == 0 ? 0 : LibFacet.vaultFeeToTreasury(slotOwner, lend, p.fee, LibFeeFloor.initiation(p.amount));
        uint256 send = p.amount - p.fee;
        LibAdvancePayAuth.authorize(loanId, LibAdvancePayAuth.TO_HOLDER, send);
        received = LibVaultOutflow.toAdvanceHolder(slotOwner, lend, send, loanId, loan.lenderTokenId);
        LibAdvancePayAuth.clear(loanId, LibAdvancePayAuth.TO_HOLDER);

        // The advance counts toward the slot's exposure until repaid.
        LibFacet.crossFacetCall(
            abi.encodeCall(MarketLedgerFacet.onSlotAdvance, (slotOwner, lend, coll, slot, 0, p.amount)),
            IVaipakamErrors.CrossFacetCallFailed.selector
        );
        emit AdvanceTaken(loanId, holder, slotOwner, slot, lend, p.amount, p.rateBps, feePaid, received);
    }

    /// @dev Interest on `amount` at `rateBps` for `t` seconds, rounded up.
    function _interest(uint256 amount, uint256 rateBps, uint256 t) private pure returns (uint256) {
        if (amount == 0 || t == 0 || rateBps == 0) return 0;
        return Math.mulDiv(amount, rateBps * t, YEAR * 10_000, Math.Rounding.Ceil);
    }

    /// @dev Run a self-call check and collect its refusal.
    function _try(Refusals memory r, bytes memory data) private view {
        (bool ok, bytes memory ret) = address(this).staticcall(data);
        if (!ok) _add(r, ret);
    }

    function _new(bool stopAtFirst) private pure returns (Refusals memory) {
        return Refusals(new SaleExitVerdictFacet.SaleRefusal[](MAX_REFUSALS), 0, stopAtFirst);
    }

    function _add(Refusals memory r, bytes memory reason) private pure {
        if (r.count == MAX_REFUSALS) return;
        r.items[r.count++] = SaleExitVerdictFacet.SaleRefusal(reason, 0);
    }

    function _full(Refusals memory r) private pure returns (bool) {
        return r.stopAtFirst && r.count != 0;
    }

    function _trim(Refusals memory r) private pure returns (SaleExitVerdictFacet.SaleRefusal[] memory out) {
        out = r.items;
        uint256 n = r.count;
        assembly ("memory-safe") {
            mstore(out, n)
        }
    }
}
