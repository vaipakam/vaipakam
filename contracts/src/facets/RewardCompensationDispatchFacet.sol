// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.29;

import {LibVaipakam} from "../libraries/LibVaipakam.sol";
import {LibRewardRemitDispatch} from "../libraries/LibRewardRemitDispatch.sol";
import {LibRewardCustody} from "../libraries/LibRewardCustody.sol";
import {LibVpfiRecycle} from "../libraries/LibVpfiRecycle.sol";
import {LibInteractionRewards} from "../libraries/LibInteractionRewards.sol";
import {LibRemitDayLedger} from "../libraries/LibRemitDayLedger.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {LibAccessControl, DiamondAccessControl} from "../libraries/LibAccessControl.sol";
import {DiamondReentrancyGuard} from "../libraries/LibReentrancyGuard.sol";
import {DiamondPausable} from "../libraries/LibPausable.sol";
import {IVaipakamErrors} from "../interfaces/IVaipakamErrors.sol";
import {RemitWire} from "../crosschain/RemitWire.sol";

/**
 * @title RewardCompensationDispatchFacet — the Base-side COMPENSATION
 *        dispatch surface (manual + supplemental).
 *
 * @notice #1434 P2-w4 — split off {RewardRemittanceFacet} for EIP-170
 *         headroom when the supplemental (§2.5 R1c) joined the manual
 *         path: the two compensation dispatchers share the P2 wire shape,
 *         the evidence/era/clock/cutoff gates, and the R6 one-in-flight
 *         gate, and they are the facet's natural seam (ordinary batch
 *         remittance stays behind). Shares LibVaipakam storage through
 *         the Diamond; the dispatch tail / headroom / gate primitives
 *         live in {LibRewardRemitDispatch} so the two facets cannot
 *         diverge on them.
 */
contract RewardCompensationDispatchFacet is
    DiamondAccessControl,
    DiamondReentrancyGuard,
    DiamondPausable,
    IVaipakamErrors
{
    /// @dev Facet-local error twins of {RewardRemittanceFacet}'s — same
    ///      signatures, same selectors, so consumers decode identically.
    error RewardBudgetMessengerNotSet();
    error RewardDayNotFinalized(uint256 dayId);
    error NothingToRemit();
    error RewardPoolCapExceeded(uint256 requested, uint256 remaining);

    /// @dev The pool lives on Base — compensation dispatch is Base-only.
    modifier onlyCanonical() {
        if (!LibVaipakam.storageSlot().isCanonicalRewardChain) {
            revert NotCanonicalRewardChain();
        }
        _;
    }

    /// @notice #1222 M3 B2-d2 — the evidenced manual-budget path funded a
    ///         `(chain, day)` a force-finalize had zeroed out of the
    ///         denominator (`remitIneligible` — the flag is the evidence and
    ///         must still be set). Fresh-funded under the 69M cap; reserves
    ///         and acks like any remit.
    /// @custom:event-category informational/reward-transport
    event ManualRewardBudgetRemitted(
        uint32 indexed dstChainId,
        uint256 indexed dayId,
        uint256 amount,
        uint256 remitId
    );

    /// @notice #1434 P2-w4 (§2.5 R1c) — a supplemental compensation was
    ///         dispatched against an already-closed day's standing
    ///         obligation.
    /// @custom:event-category informational/reward-compensation
    event SupplementalRewardBudgetRemitted(
        uint32 indexed dstChainId,
        uint256 indexed dayId,
        uint256 amount,
        uint256 remitId
    );

    /**
     * @notice ADMIN — the evidenced MANUAL-BUDGET path for a `(day, chain)` a
     *         force-finalize ZEROED out of the interest denominator: funds an
     *         operator-sized amount to the mirror through the full
     *         delivered-backing ledger (reservation → CCIP token send → ack).
     * @dev    Requires the day still marked `remitIneligible` — the un-cleared
     *         flag IS the on-chain evidence the day was zeroed; run this
     *         BEFORE any {RewardCommitmentFacet.reconcileCommitmentRemitEligibility}
     *         clear (for a zeroed day clearing restores nothing fundable —
     *         the automatic slice is 0 forever — and it removes this path's
     *         anchor). The amount is operator-sized from the mirror's locally
     *         readable state (day totals + entry set — design record §2b: the
     *         zeroed chain's own report prices at its deliberately-zero stamp
     *         and is NOT a sizing basis). FRESH-funded under the 69M
     *         `RewardPoolCapExceeded` guard (the zeroed day stamped no
     *         recycled funding for this chain, so a recycled draw has no
     *         backing figure); no armed-fresh commitment retires (the zeroed
     *         chain's share was never committed at finalize — its numerator
     *         was excluded from the globals). The flag stays set as
     *         historical evidence; the day is closed by the reservation
     *         marker, so no automatic path can double-fund it.
     */
    function remitManualBudget(
        uint32 dstChainId,
        uint256 dayId,
        uint256 lenderAmount18,
        uint256 borrowerAmount18
    )
        external
        payable
        nonReentrant
        whenNotPaused
        onlyCanonical
        onlyRole(LibAccessControl.ADMIN_ROLE)
        returns (bytes32 messageId)
    {
        return _remitManualBudget(
            dstChainId,
            dayId,
            lenderAmount18,
            borrowerAmount18,
            LibRewardCustody.TransportSource.Live,
            0
        );
    }

    /// @notice ADMIN — the manual-budget path funded from the RECOVERY
    ///         POSITION (#1434 P2-w5, §4.2): an UNCHARGED re-dispatch of
    ///         value a stranded return brought home. Identical evidence,
    ///         era, clock, quote and gate discipline; only the funding
    ///         source differs — the 69M cap is NOT charged (the parcel's
    ///         charge happened at its original dispatch) and the draw is
    ///         bounded by the position balance instead.
    /// @param sourceRemitId #1662 r2 — the receipt whose recovery credit
    ///        funds this dispatch. The position is a pooled balance, but
    ///        it is NOT anonymous: a contradicted receipt may only have
    ///        ITS OWN unspent credit clawed back, so every draw must be
    ///        attributable. Bounded by that receipt's own unspent credit.
    function remitManualBudgetFromRecovery(
        uint32 dstChainId,
        uint256 dayId,
        uint256 lenderAmount18,
        uint256 borrowerAmount18,
        uint256 sourceRemitId
    )
        external
        payable
        nonReentrant
        whenNotPaused
        onlyCanonical
        onlyRole(LibAccessControl.ADMIN_ROLE)
        returns (bytes32 messageId)
    {
        return _remitManualBudget(
            dstChainId,
            dayId,
            lenderAmount18,
            borrowerAmount18,
            LibRewardCustody.TransportSource.Recovery,
            sourceRemitId
        );
    }

    /// @dev ONE implementation of the manual dispatch — the external
    ///      wrappers differ only in the NAMED custody source (#1566 slice 4
    ///      PR B: the source rides through to the shared tail, which debits
    ///      that custody, so no dispatch can send from an unnamed one).
    function _remitManualBudget(
        uint32 dstChainId,
        uint256 dayId,
        uint256 lenderAmount18,
        uint256 borrowerAmount18,
        LibRewardCustody.TransportSource source,
        uint256 sourceRemitId
    ) private returns (bytes32 messageId) {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        bool fromRecovery = source == LibRewardCustody.TransportSource.Recovery;
        // #1434 P2-w2 (R1/R1b) — the compensation is sized PER SIDE on the
        // wire: payout is `localInterest × Δ` per side and Base does not
        // hold the mirror's day interest, so a single scalar would leave
        // the mirror solving for a side — the exact operator-solve trap
        // constraint 17 names. The declared total is their sum by
        // construction, so the R1b sum-vs-total validation cannot fail
        // between honest endpoints.
        uint256 amount = lenderAmount18 + borrowerAmount18;
        if (amount == 0) revert NothingToRemit();
        if (!s.dailyGlobalFinalized[dayId]) {
            revert RewardDayNotFinalized(dayId);
        }
        if (!s.chainDayCommitments[dayId][dstChainId].remitIneligible) {
            revert RemitDayNotManualEligible(dayId, dstChainId);
        }
        if (
            s.rewardBudgetRemitted[dstChainId][dayId] != 0
                || s.dayClosedByRemitId[dstChainId][dayId] != 0
        ) {
            revert RemitDayAlreadyClosed(dayId, dstChainId);
        }
        // #918 — a day the ordinary path has sent any part of is not a
        // compensation day (it was remit-eligible when that part went).
        if (LibRemitDayLedger.hasLedger(s, dstChainId, dayId)) {
            revert RemitDayPartlySent(dayId, dstChainId);
        }
        address vpfi = s.vpfiToken;
        if (vpfi == address(0)) revert VPFITokenNotSet();
        address messenger = s.crossChainMessenger;
        if (messenger == address(0)) revert RewardBudgetMessengerNotSet();

        // The day is finalized (checked above), and finalization freezes
        // its lapse clock in the same call, so the frozen words read here
        // always exist.
        LibVaipakam.DayLapseClock storage clk = s.dayLapseClock[dayId];
        // #1634 r3 — the R3 dispatch cutoff, enforced NOW rather than with
        // the w4 terminals: the mirror already evaluates expiry from these
        // same frozen words (the r1 fix), so a dispatch inside the cutoff
        // window could arrive quarantined (reason 3) after Base closed the
        // day and consumed headroom — no payable compensation, no return
        // until w5. Refusing here is the explicit CCIP delivery budget R3
        // ratified. Version 0 = not lapse-eligible = no cutoff, matching
        // the never-expired rule at the ingress.
        if (clk.scheduleVersion != 0) {
            uint256 expiry =
                uint256(clk.finalizedAt) + clk.lapseWindowSeconds;
            if (block.timestamp + clk.dispatchCutoffGap > expiry) {
                revert CompensationDispatchPastCutoff(
                    dayId, expiry, clk.dispatchCutoffGap
                );
            }
        }
        // #1434 P2-w3 — funding is EVIDENCE-BOUNDED (§1.4): a STANDING
        // mirror quote is required (the authenticated counterfactual fair
        // share — obtainable permissionlessly on the mirror via the
        // batched accumulator + dispatch, so requiring it blocks no honest
        // flow), and each side is bounded SEPARATELY (the §2.5 rule: an
        // aggregate bound admits overfunding one side while shorting the
        // other). A (0,0) quote bounds funding to zero, which composes
        // with the resolved-zero clearing — nothing to compensate.
        {
            LibVaipakam.CompQuote storage q = s.compQuote[dayId][dstChainId];
            if (q.receivedAt == 0) {
                revert CompensationNotQuoted(dayId, dstChainId);
            }
            // #1636 r5 — the funding path holds the SAME era ground truth
            // the ingress does: after a registry rotation, an unfunded
            // quote standing under the RETIRED mirror must not fund the
            // current one (its state did not produce the evidence) — the
            // operator clears it and the new era re-quotes. Also fails
            // closed while the registry is unset for this chain.
            {
                address expected = s.mirrorRewardDeployment[dstChainId];
                if (q.era != expected || expected == address(0)) {
                    revert CompQuoteEraMismatch(
                        dayId, dstChainId, expected, q.era
                    );
                }
            }
            // #1660 r5 — CUMULATIVE per side, exactly like the
            // supplemental bound: a day can be re-opened by a terminal
            // return while a successor supplement's funding is retained
            // in the cumulative, and a fresh-request-only bound would
            // let a full-quote dispatch stack on top of it and overfund
            // the mirror. For a virgin day the cumulative is zero and
            // the bound is unchanged.
            uint256 cumL0 =
                s.compFundedLender18[dstChainId][dayId] + lenderAmount18;
            uint256 cumB0 =
                s.compFundedBorrower18[dstChainId][dayId] + borrowerAmount18;
            if (cumL0 > q.lender18 || cumB0 > q.borrower18) {
                revert CompensationExceedsQuote(
                    cumL0, cumB0, q.lender18, q.borrower18
                );
            }
        }

        // r6 — NET headroom; a manual send retires no commitment (the
        // zeroed chain's share was never committed at finalize).
        // #1434 P2-w5 — a FROM-RECOVERY dispatch is bounded by the
        // recovery position instead of the 69M cap: the parcel's cap
        // charge happened at its ORIGINAL dispatch and never repeats
        // (#1586 ratified).
        if (fromRecovery) {
            _drawFromRecovery(s, sourceRemitId, amount);
        } else {
            uint256 remaining = LibRewardRemitDispatch.freshHeadroomNet(s, 0);
            if (amount > remaining) {
                revert RewardPoolCapExceeded(amount, remaining);
            }
        }

        // #1434 P2-w4 (§5.1 R6) — one compensation reservation in flight
        // per chain: the standing one must settle (consumption ACK,
        // return, or recovery) before another dispatches.
        {
            uint256 outstanding = s.compensationOutstanding[dstChainId];
            if (outstanding != 0) {
                revert CompensationGateHeld(dstChainId, outstanding);
            }
        }

        // Effects (CEI) — mark, count, reserve.
        uint256 remitId = ++s.remitReservationNonce;
        s.rewardBudgetRemitted[dstChainId][dayId] = amount;
        s.dayClosedByRemitId[dstChainId][dayId] = remitId;
        // #1434 P2-w4 — the per-side funded cumulative (the supplemental
        // bound's base term) + the R6 gate.
        s.compFundedLender18[dstChainId][dayId] += lenderAmount18;
        s.compFundedBorrower18[dstChainId][dayId] += borrowerAmount18;
        s.compFundedRecorded[dstChainId][dayId] = true;
        LibRewardRemitDispatch.setCompensationGate(s, dstChainId, remitId);
        // Physical-outflow ledgers accrue for BOTH sources; only the cap
        // charge is source-dependent (uncharged re-dispatch rides
        // `rewardBudgetRedispatched`, the third reconciliation term).
        if (fromRecovery) s.rewardBudgetRedispatched += amount;
        else s.rewardBudgetRemittedGlobal += amount;
        s.rewardBudgetRemittedTotal[dstChainId] += amount;
        s.remitPendingTotal[dstChainId] += amount;
        {
            LibVaipakam.RemitReservation storage r =
                s.remitReservations[remitId];
            r.dstChainId = dstChainId;
            r.status = 1;
            r.sentAt = uint64(block.timestamp);
            r.total = amount;
            r.fresh = amount;
            uint256[] memory one = new uint256[](1);
            one[0] = dayId;
            r.dayIds = one;
            // #1656 r1 — the declared per-side split, for the ACK-time
            // received-vs-declared reconciliation of `compFunded*`.
            r.declaredLender18 = lenderAmount18;
            r.declaredBorrower18 = borrowerAmount18;
            // #1434 P2-w5 - no headroom was charged, so no path may
            // ever restore headroom for this reservation.
            r.fundedFromRecovery = fromRecovery;
        }

        // #1434 P2-w2 — the manual-compensation path now dispatches the P2
        // wire shape (tag + single day + per-side amounts + the day's
        // frozen expiry inputs) so the mirror ingress can CLASSIFY the
        // arrival (§2.2) instead of booking it as an ordinary delivery.
        // Still fresh-only (see `r.fresh = amount` above). The R3 dispatch
        // cutoff is enforced above (#1634 r3) — the ingress evaluates
        // expiry from the same frozen words, so a late dispatch could
        // otherwise arrive quarantined after this day was closed.
        messageId = _sendCompensationPayload(
            s,
            vpfi,
            messenger,
            dstChainId,
            dayId,
            remitId,
            lenderAmount18,
            borrowerAmount18,
            source
        );

        emit ManualRewardBudgetRemitted(dstChainId, dayId, amount, remitId);
    }

    /**
     * @notice ADMIN — top up a CONSUMED short-delivered compensation
     *         (§2.5 R1c): the day is closed by an ACKED manual remit, yet
     *         the mirror's pool sits below quote (fee-on-transfer /
     *         partial burn). A supplement funds the SAME receipt-bound
     *         obligation — it deliberately does NOT touch the day
     *         markers; the mirror ingress ADDS to the compensated pools
     *         per side and the pricing ladder's deferral absorbs the
     *         top-up naturally.
     * @dev    Per-side cumulative bound: original + prior supplements +
     *         this ≤ that side's standing quote, EACH SIDE SEPARATELY
     *         (an aggregate bound admits overfunding one side while
     *         shorting the other; an unallocated scalar would leave the
     *         mirror nothing to add per side). The closing reservation
     *         must be ACKED — for a dead (never-executing) one, release
     *         is the tool. Same R6 one-in-flight gate, same wire tag,
     *         same clock/cutoff discipline as the manual path; a
     *         supplement landing after the mirror's short-lapse terminal
     *         quarantines there (§2.2) and returns via w5.
     */
    function remitSupplementalBudget(
        uint32 dstChainId,
        uint256 dayId,
        uint256 lenderAmount18,
        uint256 borrowerAmount18
    )
        external
        payable
        nonReentrant
        whenNotPaused
        onlyCanonical
        onlyRole(LibAccessControl.ADMIN_ROLE)
        returns (bytes32 messageId)
    {
        return _remitSupplementalBudget(
            dstChainId,
            dayId,
            lenderAmount18,
            borrowerAmount18,
            LibRewardCustody.TransportSource.Live,
            0
        );
    }

    /// @notice ADMIN — the supplemental top-up funded from the RECOVERY
    ///         POSITION (#1434 P2-w5, §4.2): the uncharged re-dispatch
    ///         of returned value into the same receipt-bound obligation.
    ///         Same bounds and gates as {remitSupplementalBudget}.
    /// @param sourceRemitId #1662 r2 — the receipt whose recovery credit
    ///        funds this top-up; see {remitManualBudgetFromRecovery}.
    function remitSupplementalBudgetFromRecovery(
        uint32 dstChainId,
        uint256 dayId,
        uint256 lenderAmount18,
        uint256 borrowerAmount18,
        uint256 sourceRemitId
    )
        external
        payable
        nonReentrant
        whenNotPaused
        onlyCanonical
        onlyRole(LibAccessControl.ADMIN_ROLE)
        returns (bytes32 messageId)
    {
        return _remitSupplementalBudget(
            dstChainId,
            dayId,
            lenderAmount18,
            borrowerAmount18,
            LibRewardCustody.TransportSource.Recovery,
            sourceRemitId
        );
    }

    /// @dev ONE implementation of the supplemental dispatch.
    function _remitSupplementalBudget(
        uint32 dstChainId,
        uint256 dayId,
        uint256 lenderAmount18,
        uint256 borrowerAmount18,
        LibRewardCustody.TransportSource source,
        uint256 sourceRemitId
    ) private returns (bytes32 messageId) {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        bool fromRecovery = source == LibRewardCustody.TransportSource.Recovery;
        uint256 amount = lenderAmount18 + borrowerAmount18;
        if (amount == 0) revert NothingToRemit();
        {
            uint256 closingId = s.dayClosedByRemitId[dstChainId][dayId];
            if (closingId == 0) {
                revert SupplementalDayNotClosed(dayId, dstChainId);
            }
            uint8 status = s.remitReservations[closingId].status;
            if (status != 2) {
                revert SupplementalReservationNotAcked(closingId, status);
            }
        }
        // #1656 r1 — the per-side funded record is the bound's base term.
        // Every manual compensation dispatch stamps it, so a day closed by
        // any other remit has none and is not a compensation to top up.
        if (!s.compFundedRecorded[dstChainId][dayId]) {
            revert SupplementalFundedRecordMissing(dayId, dstChainId);
        }
        // The day must be a QUOTED compensation day under the CURRENT
        // mirror era (the same evidence + era discipline as the manual
        // path — #1636 r5).
        {
            LibVaipakam.CompQuote storage q = s.compQuote[dayId][dstChainId];
            if (q.receivedAt == 0) {
                revert CompensationNotQuoted(dayId, dstChainId);
            }
            address expected = s.mirrorRewardDeployment[dstChainId];
            if (q.era != expected || expected == address(0)) {
                revert CompQuoteEraMismatch(dayId, dstChainId, expected, q.era);
            }
            // PER-SIDE cumulative bound against the standing quote.
            uint256 cumL = s.compFundedLender18[dstChainId][dayId]
                + lenderAmount18;
            uint256 cumB = s.compFundedBorrower18[dstChainId][dayId]
                + borrowerAmount18;
            if (cumL > q.lender18 || cumB > q.borrower18) {
                revert CompensationExceedsQuote(
                    cumL, cumB, q.lender18, q.borrower18
                );
            }
        }
        address vpfi = s.vpfiToken;
        if (vpfi == address(0)) revert VPFITokenNotSet();
        address messenger = s.crossChainMessenger;
        if (messenger == address(0)) revert RewardBudgetMessengerNotSet();
        // #1656 r3 — no R3 cutoff here, unlike the manual path: the
        // cutoff's premise (a past-expiry arrival is a GUARANTEED
        // quarantine) does not hold for supplements — the mirror admits a
        // top-up on a compensated-and-open day until its §2.5 remediation
        // deadline, which is mirror-local state Base cannot read. A
        // supplement racing the short-lapse terminal quarantines
        // token-safely and returns via w5. The MANUAL path (first
        // compensation) keeps the full cutoff.
        // R6 — one in flight per chain.
        {
            uint256 outstanding = s.compensationOutstanding[dstChainId];
            if (outstanding != 0) {
                revert CompensationGateHeld(dstChainId, outstanding);
            }
        }
        // 69M headroom — a supplement retires no commitment, like the
        // manual send it tops up. From-recovery: position-bounded,
        // uncharged (#1434 P2-w5).
        if (fromRecovery) {
            _drawFromRecovery(s, sourceRemitId, amount);
        } else {
            uint256 remaining = LibRewardRemitDispatch.freshHeadroomNet(s, 0);
            if (amount > remaining) {
                revert RewardPoolCapExceeded(amount, remaining);
            }
        }

        // Effects (CEI) — a NEW reservation with its own lifecycle; the
        // day markers stay untouched (the whole point: funding
        // accumulates against the same obligation).
        uint256 remitId = ++s.remitReservationNonce;
        if (fromRecovery) s.rewardBudgetRedispatched += amount;
        else s.rewardBudgetRemittedGlobal += amount;
        s.rewardBudgetRemittedTotal[dstChainId] += amount;
        s.remitPendingTotal[dstChainId] += amount;
        s.compFundedLender18[dstChainId][dayId] += lenderAmount18;
        s.compFundedBorrower18[dstChainId][dayId] += borrowerAmount18;
        s.compFundedRecorded[dstChainId][dayId] = true;
        LibRewardRemitDispatch.setCompensationGate(s, dstChainId, remitId);
        {
            LibVaipakam.RemitReservation storage r =
                s.remitReservations[remitId];
            r.dstChainId = dstChainId;
            r.status = 1;
            r.sentAt = uint64(block.timestamp);
            r.total = amount;
            r.fresh = amount;
            uint256[] memory one = new uint256[](1);
            one[0] = dayId;
            r.dayIds = one;
            // #1656 r1 — the declared per-side split, for the ACK-time
            // received-vs-declared reconciliation of `compFunded*`.
            r.declaredLender18 = lenderAmount18;
            r.declaredBorrower18 = borrowerAmount18;
            r.fundedFromRecovery = fromRecovery;
        }

        messageId = _sendCompensationPayload(
            s,
            vpfi,
            messenger,
            dstChainId,
            dayId,
            remitId,
            lenderAmount18,
            borrowerAmount18,
            source
        );

        emit SupplementalRewardBudgetRemitted(
            dstChainId, dayId, amount, remitId
        );
    }

    /// @notice #1434 P2-w5 — an authenticated stranded return settled on
    ///         Base: `credited` entered the recovery position, `overage`
    ///         (if any) was quarantined above the receipt's entitlement.
    /// @custom:event-category state-change/reward-compensation
    event StrandedReturnSettled(
        uint256 indexed remitId,
        uint32 indexed sourceChainId,
        uint256 dayId,
        uint256 credited,
        uint256 overage,
        // #1660 r10 - BOTH figures, explicitly: this chunk's transport
        // gap (declared minus received), and the receipt's recomputed
        // TOTAL loss record after this chunk (which folds in first-leg
        // deficits on the terminal and shrinks on out-of-order
        // recoveries) - event consumers must see what the lens sees.
        uint256 chunkShortfall,
        uint256 totalShortfall,
        bool gateCleared
    );

    /**
     * @notice #1434 P2-w5 (design §4.2) — Base ingress for a Mode-B
     *         STRANDED RETURN. Called ONLY by the configured return-channel
     *         receiver satellite, which has already forwarded the delivered
     *         VPFI to the Diamond and reports declared + actual amounts.
     * @dev    The credit is CHAIN-BOUND and ENTITLEMENT-BOUNDED (Codex
     *         #1600 r1 P1 ×2, baked into §4.2): the authenticated
     *         `sourceChainId` must equal the referenced reservation's
     *         `dstChainId` — otherwise another registered mirror could
     *         consume a chain's one-shot recovery, clear its gate, and
     *         strand the genuine return — and the position credit is
     *         `min(actual, entitlement − already recovered for this
     *         receipt)` with the excess quarantined token-safe in the
     *         operator-visible overage position (never credited — a
     *         compromised mirror could otherwise attach a small valid
     *         receipt to an arbitrarily large return and mint uncharged
     *         re-dispatch capacity, a 69M bypass; never reverted — the
     *         tokens are already home and refusing the message would
     *         strand the whole delivery behind the wire). The reservation's
     *         STATUS is deliberately untouched: the mirror's non-consumed
     *         ACK settles delivery evidence independently and remains
     *         permissionlessly re-presentable; the return settles VALUE
     *         and the R6 gate (§5.1's return-settlement arm), each exactly
     *         once.
     * @param transportMessageId The transport's message id (#1566 closure 2
     *         cutover PR 1): the return is recorded under its ingress stamp,
     *         and a return for a receipt that PREDATES recovery attribution
     *         lands in the holder's `Unclassified` row on an activated
     *         deployment instead of resting in the shared balance. Not
     *         `whenNotPaused` — a receive ingress stays executable under
     *         the migration pause (design §5c).
     */
    function onStrandedReturnReceived(
        address remitter,
        uint256 remitId,
        uint256 dayId,
        uint32 sourceChainId,
        address token,
        uint256 declaredAmount,
        uint256 actualReceived,
        uint256 remainingAfter,
        bytes32 transportMessageId
    ) external nonReentrant onlyCanonical {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        {
            address receiver = s.repatriationReceiver;
            if (receiver == address(0) || msg.sender != receiver) {
                revert OnlyStrandedReturnReceiver(msg.sender);
            }
        }
        // Era binding: the receipt identity names the ISSUING deployment.
        // A stale-era return (pre-rotation dispatch) fails closed and
        // re-executable — its reservation lives in the old deployment's
        // storage and settles through the R6e rotation runbook, never by
        // guessing here.
        if (remitter != address(this)) {
            revert StrandedReturnWrongEra(remitter);
        }
        LibVaipakam.RemitReservation storage r = s.remitReservations[remitId];
        if (r.total == 0) revert StrandedReturnUnknownReservation(remitId);
        // #1660 r1 — only a COMPENSATION reservation's total is a valid
        // entitlement basis: manual/supplemental dispatches are single-
        // day, fresh-only, with the per-side declared split stamped. An
        // ordinary batch reservation may carry a recycled component that
        // never charged `rewardBudgetRemittedGlobal` — crediting its
        // total would let a faulty mirror mint uncharged re-dispatch
        // capacity. Batch/stray value settles via release + the R6d
        // ceremony, never via B1.
        if (
            r.dayIds.length != 1 || r.recycled != 0
                || (r.declaredLender18 == 0 && r.declaredBorrower18 == 0)
        ) {
            revert StrandedReturnNotCompensation(remitId);
        }
        // #1660 r2 — bind the reported day to the reservation's own single
        // day: a faulty mirror must not attribute settlement or loss
        // evidence to a different obligation.
        if (dayId != r.dayIds[0]) {
            revert StrandedReturnWrongDay(dayId, r.dayIds[0]);
        }
        // #1660 r3 — a CONSUMED receipt is not recoverable: its consumed
        // ack (or the operator-forced equivalent) attests the delivered
        // value entered the mirror's compensated pools as claim backing,
        // so crediting a return against it would reuse the original
        // dispatch's cap lineage while that value still backs claims. An
        // honest mirror only ever B1-returns QUARANTINED receipts (whose
        // acks say non-consumed); a consumed-ack-then-return sequence is
        // a faulty or compromised mirror, refused fail-closed.
        if (r.consumedAcked) {
            revert StrandedReturnConsumedReceipt(remitId);
        }
        // #1660 r4/r5 — POSITIVE QUARANTINE evidence, not mere absence
        // of a consumed stamp and not Acked-non-consumed alone: the
        // transport executes out of order, and a non-consumed ack can
        // also describe a PROVISIONAL receipt that later confirms as
        // consumed — so the ack must have specifically attested
        // classification QUARANTINED (`quarantineAcked`, stamped for
        // Pending, Acked, and Released reservations alike; the ack is
        // permissionlessly re-presentable, so an honest quarantined
        // receipt always satisfies this first). A return arriving
        // before that attestation stays re-executable.
        if (!r.quarantineAcked) {
            revert StrandedReturnAwaitingAck(remitId, r.status);
        }
        if (sourceChainId != r.dstChainId) {
            revert StrandedReturnWrongSourceChain(
                sourceChainId, r.dstChainId
            );
        }
        if (
            token != s.vpfiToken || actualReceived == 0
                || actualReceived > declaredAmount
        ) {
            revert StrandedReturnDeliveryInvalid();
        }

        // Entitlement-bounded credit; the receipt's cumulative can never
        // pass the reservation's dispatched total.
        uint256 already = s.remitRecoveredForReceipt[remitId];
        // #1662 r6 — net GOVERNANCE-RECORDED LOSS as well as prior
        // recovery. A released receipt can have partial terminal loss
        // recorded while a quarantined return is still in flight; without
        // the loss term the late return credits against the gross total
        // and `recovered + terminalLoss` passes the dispatched parcel —
        // minting recovery lineage that never existed and clearing the
        // gate on it.
        uint256 entitlement = r.total;
        uint256 resolved = already + s.ceremonyTerminalLoss[remitId];
        uint256 headroom =
            entitlement > resolved ? entitlement - resolved : 0;
        uint256 credited =
            actualReceived < headroom ? actualReceived : headroom;
        uint256 overage = actualReceived - credited;

        s.remitRecoveredForReceipt[remitId] = already + credited;
        s.rewardBudgetRecovered += credited;
        if (overage != 0) s.strandedReturnOverage += overage;
        // #1566 closure 2 cutover PR 1 — the packet under its ingress stamp,
        // recorded ON EVERY DEPLOYMENT, activated or not (Codex #2198 r1):
        // the second PR's reconciliation reads the record and the replay
        // guard is the record's, so a return landing before the activation
        // is stamped like any other. Only the holder relocations below are
        // activation-gated.
        LibRewardCustody.callRecordIngressPacket(
            sourceChainId,
            transportMessageId,
            LibRewardCustody.PACKET_KIND_STRANDED_RETURN,
            actualReceived,
            0,
            0,
            remitter,
            remitId
        );
        // #1566 slice 4 PR B — the recovery custody switch (design §5d): on
        // an activated deployment the entitlement-bounded portion is
        // relocated from this balance into the holder's RECOVERY row and
        // any excess into the protected OVERAGE row, measured.
        if (LibRewardCustody.active(s)) {
            LibRewardCustody.callRelocateToHolder(LibVaipakam.RewardCustodyRow.Recovery, credited);
            LibRewardCustody.callRelocateToHolder(LibVaipakam.RewardCustodyRow.Overage, overage);
        }
        // #1660 r1 — a short actual is TRANSPORT LOSS, not recoverable
        // headroom: the mirror's one-shot record retired at the declared
        // amount, so the gap can never re-arrive. Recorded per receipt
        // for ledger reconciliation and as the loss ceremony's evidence.
        uint256 shortfall = declaredAmount - actualReceived;
        if (shortfall != 0) {
            s.strandedReturnShortfall[remitId] += shortfall;
        }
        // #1660 r3 — the FIRST terminal chunk unwinds the closure, exactly
        // once: the mirror's record is fully retired, so the compensation
        // definitively never funded the obligation — the day markers
        // re-open (ownership-guarded, the release mould: a supplemental's
        // return must not erase the original's closure) and the declared
        // per-side contribution leaves the funded cumulative (saturating),
        // so a replacement — manual from the recovery position, or
        // supplemental under the re-opened quote headroom — can fund the
        // SAME obligation. Reservation STATUS stays untouched (the ack
        // lifecycle remains independent and re-presentable).
        if (remainingAfter == 0 && !s.strandedReturnTerminalized[remitId]) {
            s.strandedReturnTerminalized[remitId] = true;
            if (s.dayClosedByRemitId[sourceChainId][dayId] == remitId) {
                delete s.rewardBudgetRemitted[sourceChainId][dayId];
                delete s.dayClosedByRemitId[sourceChainId][dayId];
            }
            // #1660 r4 — once, whichever unwind path ran first: a
            // RELEASED reservation's release already removed the declared
            // contribution, and subtracting again would erase funding a
            // replacement recorded in the meantime (a non-terminal chunk
            // clears the gate, so a replacement can dispatch while the
            // terminal chunk is still in flight).
            if (!r.declaredUnwound) {
                r.declaredUnwound = true;
                uint256 curL = s.compFundedLender18[sourceChainId][dayId];
                uint256 curB = s.compFundedBorrower18[sourceChainId][dayId];
                s.compFundedLender18[sourceChainId][dayId] = curL
                    > r.declaredLender18 ? curL - r.declaredLender18 : 0;
                s.compFundedBorrower18[sourceChainId][dayId] = curB
                    > r.declaredBorrower18 ? curB - r.declaredBorrower18 : 0;
            }
        }
        // #1660 r2/r3 — loss-evidence closure at the full residual:
        // entitlement minus everything that physically arrived, folding in
        // the FIRST-leg deficit (a compensation that arrived short
        // Base-to-mirror left the mirror quarantining less than the
        // reservation dispatched). Assignment, not increment — idempotent
        // under replays — and recomputed on EVERY chunk once a terminal
        // was observed (r3: the configured transport executes out of
        // order, so a partial chunk may land AFTER the terminal one and
        // must shrink the recorded loss it just recovered).
        if (remainingAfter == 0 || s.strandedReturnTerminalized[remitId]) {
            uint256 resolvedNow = s.remitRecoveredForReceipt[remitId]
                + s.ceremonyTerminalLoss[remitId];
            s.strandedReturnShortfall[remitId] =
                entitlement > resolvedNow ? entitlement - resolvedNow : 0;
        }

        // §5.1 return settlement: clear the R6 gate iff THIS receipt is
        // the one holding it (an older receipt's late return must not
        // clear a successor's gate).
        bool gateCleared;
        if (s.compensationOutstanding[sourceChainId] == remitId) {
            LibRewardRemitDispatch.clearCompensationGate(s, sourceChainId);
            gateCleared = true;
        }
        emit StrandedReturnSettled(
            remitId, sourceChainId, dayId, credited, overage, shortfall,
            s.strandedReturnShortfall[remitId], gateCleared
        );
    }

    /**
     * @dev #1434 P2-w2 — the MANUAL-COMPENSATION dispatch (design §1.3):
     *      one zeroed day, authenticated PER-SIDE amounts (R1/R1b), and the
     *      day's FROZEN expiry inputs (R4b) read back from the w1
     *      finalization-time freeze — never live state, so a re-send after
     *      a schedule bump carries identical classification facts. Leads
     *      with {RemitWire.REMIT_WIRE_TAG_P2}; the tag + single-day shape
     *      ARE the compensation marker the mirror ingress classifies on
     *      (§2.2). Zero clock words (a day finalized before the clock
     *      machinery) travel as zeros — such a day is not lapse-eligible,
     *      so they are honest, not a fallback.
     */
    function _sendCompensationPayload(
        LibVaipakam.Storage storage s,
        address vpfi,
        address messenger,
        uint32 dstChainId,
        uint256 dayId,
        uint256 remitId,
        uint256 lenderAmount18,
        uint256 borrowerAmount18,
        LibRewardCustody.TransportSource source
    ) private returns (bytes32 messageId) {
        LibVaipakam.DayLapseClock storage c = s.dayLapseClock[dayId];
        // Codex #1634 r1 — ALL FOUR frozen clock words ride the wire, not
        // just the timestamp + version number: w1 chose inline schedule
        // parameters over a mirror-side version table, so the version
        // number alone is underivable there, and the mirror's ingress-time
        // expiry classification (the R4b promise) needs the window itself.
        bytes memory payload = abi.encode(
            RemitWire.REMIT_WIRE_TAG_P2,
            dayId,
            lenderAmount18 + borrowerAmount18,
            remitId,
            address(this),
            lenderAmount18,
            borrowerAmount18,
            uint256(c.finalizedAt),
            uint256(c.scheduleVersion),
            uint256(c.lapseWindowSeconds),
            uint256(c.dispatchCutoffGap)
        );
        // #1566 slice 4 PR B — a compensation is fresh-only: a `Live` draw
        // leaves the live-fresh row (bounded and charged against the
        // delivered ledger in the tail); a `Recovery` draw leaves the
        // recovery row, uncharged.
        messageId = LibRewardRemitDispatch.dispatchRemitTail(
            s,
            vpfi,
            messenger,
            dstChainId,
            payload,
            remitId,
            LibRewardCustody.TransportDraw({
                source: source,
                fresh: lenderAmount18 + borrowerAmount18,
                recycled: 0
            })
        );
    }
    /// @notice #1222 M3 — a PENDING reservation was operator-RELEASED.
    ///         The VALUE counters stay reserved (the tokens sit in the
    ///         transport's custody): `recycledStranded` is what the
    ///         release recorded as stranded, not a re-credit.
    /// @custom:event-category state-change/reward-compensation
    event RemitReservationReleased(
        uint256 indexed remitId,
        uint32 indexed dstChainId,
        uint256 total,
        uint256 fresh,
        uint256 recycledStranded
    );

    // ── #1222 M3: the RELEASE valve ─────────────────────────────────
    // (#1662 r4 — relocated off the mutating remittance facet for EIP-170
    // headroom, exactly as `quoteRemitAckFee` was in w5. Base-only ADMIN
    // evidence, which is this facet's character.)

    /// @dev #1222 M3 — the reconciliation timeout a release must clear.
    uint256 internal constant REMIT_RELEASE_MIN_AGE = 7 days;

    /**
     * @notice ADMIN valve — release a PENDING reservation the operator has
     *         verified can NEVER execute: re-opens its days for funding and
     *         restores the outstanding commitments (the VALUE counters stay
     *         reserved — see the event doc).
     * @dev    LAST-RESORT + evidenced: CCIP failed messages stay manually
     *         re-executable indefinitely, so the normal recovery is
     *         re-execution → delivery → ack, with the reservation simply
     *         staying Pending meanwhile. Release is for a message with
     *         permanent-failure evidence (e.g. an unrecoverable receiver).
     *         The recycled share's TOKENS sit locked in the CCIP token pool —
     *         genuinely outside Diamond custody — so `recycleBucket` is
     *         deliberately NOT re-credited (see
     *         {LibVpfiRecycle.restoreReleasedRemit}); the release event
     *         records the stranded figure and physical recovery rides the
     *         B2-d5 custody-credit class. If the message executes AFTER a
     *         release, the late ack surfaces via {RemitAckAfterRelease}.
     */
    function releaseRemitReservation(
        uint256 remitId
    ) external onlyRole(LibAccessControl.ADMIN_ROLE) onlyCanonical {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        LibVaipakam.RemitReservation storage r = s.remitReservations[remitId];
        if (r.status != 1) revert RemitReservationNotPending(remitId);
        // r5 — §M3's reconciliation timeout, on-chain: a merely-delayed
        // message must age out before its days may re-open.
        uint256 earliest = uint256(r.sentAt) + REMIT_RELEASE_MIN_AGE;
        if (block.timestamp < earliest) {
            revert RemitReleaseTooEarly(remitId, earliest);
        }
        r.status = 3;
        uint32 dst = r.dstChainId;
        uint256[] storage closed = r.dayIds;
        uint256 n = closed.length;
        // #918 — an ordinary reservation is ONE PART of its funded day (and
        // a zero part of each close-only day that rode along). Its part
        // belongs to its single funded day: the send funds at most one.
        (bool funded, uint256 fundedAt) =
            LibRemitDayLedger.fundedDayIndex(remitId, n, r.fundedDayBits);
        for (uint256 i; i < n; ) {
            uint256 d = closed[i];
            if (LibRemitDayLedger.hasLedger(s, dst, d)) {
                // #918 — take exactly this part off the day's ledger; the
                // day's close markers go whenever it is no longer whole,
                // whichever part set them.
                bool own = funded && i == fundedAt;
                LibRemitDayLedger.releasePart(
                    s, dst, d, remitId, own ? r.fresh : 0, own ? r.recycled : 0
                );
            } else if (s.dayClosedByRemitId[dst][d] == remitId) {
                // #1656 r1 - a COMPENSATION day: delete the day markers ONLY
                // when this reservation OWNS the closure. A SUPPLEMENTAL
                // reservation names the same day for its record/ACK
                // lifecycle, but the closure belongs to the original
                // acknowledged manual remit - releasing a failed supplement
                // must not erase it (that would re-open funding on an
                // already-funded day and free its standing quote).
                delete s.rewardBudgetRemitted[dst][d];
                delete s.dayClosedByRemitId[dst][d];
            }
            unchecked {
                ++i;
            }
        }
        // #1656 r6 - a released COMPENSATION reservation takes its
        // DECLARED per-side contribution out of the funded cumulative:
        // the release means those tokens never funded the obligation
        // (the reservation can never execute), and leaving them counted
        // would make the recovery ceremony's re-dispatch impossible -
        // the per-side bound would reject the replacement as exceeding
        // the quote. Saturating; contributions from OTHER reservations
        // on the same day (the original under a released supplemental,
        // or vice versa) remain counted, correctly.
        if (
            n == 1
                && (r.declaredLender18 != 0 || r.declaredBorrower18 != 0)
                // #1660 r4 - once, whichever unwind path ran first.
                && !r.declaredUnwound
        ) {
            r.declaredUnwound = true;
            uint256 cd = closed[0];
            uint256 curL = s.compFundedLender18[dst][cd];
            uint256 curB = s.compFundedBorrower18[dst][cd];
            s.compFundedLender18[dst][cd] = curL > r.declaredLender18
                ? curL - r.declaredLender18
                : 0;
            s.compFundedBorrower18[dst][cd] = curB > r.declaredBorrower18
                ? curB - r.declaredBorrower18
                : 0;
        }
        // Codex #1426 r4 — the FRESH counters stay UN-restored, exactly
        // like the recycled bucket: the sent VPFI is physically outside
        // Diamond custody (locked in the CCIP pool), so re-opening 69M
        // headroom here would let the re-remit's transfer draw commingled
        // custody (bucket tokens, LIF holds) as "fresh". The re-remit
        // consumes NEW headroom (two real outflows happened); physical
        // recovery restores the counters through the same governance
        // ceremony that re-credits the bucket (B2-d5 class).
        uint256 pending = s.remitPendingTotal[dst];
        s.remitPendingTotal[dst] = pending > r.total ? pending - r.total : 0;
        LibInteractionRewards.restoreArmedFresh(r.armedFreshFull);
        r.strandedRecycled = LibVpfiRecycle.restoreReleasedRemit(r.recycledFull, r.recycled, remitId);
        emit RemitReservationReleased(
            remitId, dst, r.total, r.fresh, r.recycled
        );
    }

    // ── #1434 P2-w6: the recovery ceremony + R6e rotation (§5.3/§5.4) ──

    /// @dev #1662 r1 — the gate value an IMPORTED old-era outstanding
    ///      holds: no real reservation ever carries this id (nonces are
    ///      sequential from 1), so a new-era ack's own-gate clear
    ///      (`compensationOutstanding[chain] == remitId`) can never alias
    ///      an imported hold — only the imported-clear paths release it.
    uint256 internal constant IMPORTED_GATE_SENTINEL = type(uint256).max;

    /// @notice §5.3 — a governance recovery ceremony settled part of a
    ///         released reservation's stranded value back into Diamond
    ///         custody (fresh → the recovery position; recycled →
    ///         relocated bucket custody).
    /// @custom:event-category state-change/reward-compensation
    event RecoveryCeremonyRecorded(
        uint256 indexed remitId,
        uint256 freshInflow,
        uint256 recycledInflow,
        uint256 recoveredCumulative,
        bool gateCleared
    );

    /// @notice §5.3 — governance recorded TERMINAL LOSS for a released
    ///         reservation's residue (neither recovered nor in pool).
    /// @custom:event-category state-change/reward-compensation
    event RecoveryTerminalLossRecorded(
        uint256 indexed remitId,
        uint256 freshLoss,
        uint256 recycledLoss,
        uint256 lossCumulative,
        bool gateCleared
    );

    /// @notice §5.4 R6e — a rotated-in deployment imported an OLD-ERA
    ///         outstanding compensation marker for a chain.
    /// @custom:event-category state-change/reward-compensation
    event OutstandingCompensationImported(
        uint32 indexed dstChainId,
        address oldRemitter,
        uint256 oldRemitId
    );

    /// @notice §5.4 R6e — the ADMIN evidenced SETTLEMENT of an imported
    ///         old-era gate, and (since r7) its ONLY release: the
    ///         recovered inflow it booked, as relocated bucket custody,
    ///         zero for a pure-loss settlement.
    /// @custom:event-category state-change/reward-compensation
    /// @dev #1662 r6 — recycled ONLY: an imported settlement mints no
    ///      fresh recovery capacity (see {clearImportedOutstanding}).
    /// @dev #1662 r7 — there is no permissionless counterpart. The r1
    ///      shape let the mirror's re-presented consumed attestation
    ///      resolve the gate through {RewardRemittanceFacet}; that path
    ///      was removed once it was clear no reachable check can
    ///      authenticate an ADMIN-chosen predecessor address, so old-era
    ///      acks now fail the era check and this is the sole clear.
    event ImportedOutstandingCleared(
        uint32 indexed dstChainId,
        address oldRemitter,
        uint256 oldRemitId,
        uint256 recycledInflow
    );

    /// @dev #1662 r2 (self-review) — a TRUSTED consumption attestation:
    ///      consumed, with NO contradicting quarantine attestation
    ///      standing. Load-bearing that this is not merely `consumedAcked`:
    ///      a mirror that attested QUARANTINE and then CONSUMED contradicted
    ///      itself, and w5's rule is that such an ack earns no further trust
    ///      (its privileges are withheld). Closing the governance settlement
    ///      paths on it as well would leave the chain's R6 gate with NO
    ///      clear at all — a permanent brick. Under contradiction the
    ///      operator's evidenced settlement is the ONLY remaining source of
    ///      truth, so it must stay open; a CLEAN consumption still refuses
    ///      (that value backs mirror claims — it is neither lost nor
    ///      recoverable) and clears the gate on its own at the ack.
    function _consumptionTrusted(
        LibVaipakam.RemitReservation storage r
    ) private view returns (bool) {
        // #1461 — the one trust rule, shared with the late acknowledgement's
        // stranded-share settle, so the ceremony / loss record and the late
        // consumption can never both resolve one remittance.
        return LibVpfiRecycle.releasedConsumptionTrusted(r);
    }

    /**
     * @notice ADMIN — record one recovery-ceremony settlement (§5.3): the
     *         governance ceremony brought `freshInflow + recycledInflow`
     *         of a RELEASED reservation's stranded transport-custody value
     *         physically back to the Diamond, and this call books it.
     * @dev    The ratified §5.3 UNIFICATION: the fresh half credits the
     *         SAME recovery position the B1 return feeds (`recovered`
     *         cumulative — uncharged re-dispatch capacity via the
     *         `…FromRecovery` wrappers), NEVER emission headroom; the
     *         recycled half enters as relocated bucket custody under its
     *         own provenance class. Folded into the ONE per-receipt
     *         recovered cumulative, so B1 returns and ceremonies compose
     *         in a single custody-resolution identity:
     *         `recovered + terminalLoss == r.total` clears the R6 gate —
     *         partial recoveries HOLD it (§5.3), over-recording past the
     *         reservation's dispatched total is refused, and each
     *         component is bounded by the reservation's OWN dispatched
     *         provenance split (#1662 r1). Status-3
     *         (Released) reservations only — a live reservation's value
     *         settles through acks/returns, and a consumed receipt is
     *         not recoverable (its value backs mirror claims).
     */
    function recordRecoveryCeremony(
        uint256 remitId,
        uint256 freshInflow,
        uint256 recycledInflow
    ) external nonReentrant whenNotPaused onlyCanonical
        onlyRole(LibAccessControl.ADMIN_ROLE)
    {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        LibVaipakam.RemitReservation storage r = s.remitReservations[remitId];
        uint256 amount = freshInflow + recycledInflow;
        if (amount == 0) revert NothingToRemit();
        if (r.status != 3) revert CeremonyReservationNotReleased(remitId);
        if (_consumptionTrusted(r)) {
            revert StrandedReturnConsumedReceipt(remitId);
        }
        uint256 recovered = s.remitRecoveredForReceipt[remitId] + amount;
        uint256 loss = s.ceremonyTerminalLoss[remitId];
        if (recovered + loss > r.total) {
            revert CeremonyExceedsStranded(remitId, recovered + loss, r.total);
        }
        // #1662 r1 — component bounds against the reservation's OWN
        // dispatched provenance split: the total bound cannot see a
        // relabel (a fresh-only compensation "recovered as recycled"
        // would move uncharged value into the bucket's claimable
        // custody).
        // #1662 r3 — JOINT with prior loss, in BOTH directions. The
        // loss path already netted prior recovery; without the mirror
        // term here, ordering the calls loss-first-recovery-second spends
        // one component twice and still satisfies the aggregate identity
        // by borrowing the other component's slack — clearing the gate
        // over value that was only ever accounted once.
        uint256 cf = s.ceremonyFreshRecovered[remitId]
            + s.ceremonyFreshLoss[remitId] + freshInflow;
        if (cf > r.fresh) {
            revert CeremonyProvenanceExceeded(remitId, cf, r.fresh);
        }
        uint256 cr = s.ceremonyRecycledRecovered[remitId]
            + s.ceremonyRecycledLoss[remitId] + recycledInflow;
        if (cr > r.recycled) {
            revert CeremonyProvenanceExceeded(remitId, cr, r.recycled);
        }
        // #1662 r4 — `cf`/`cr` are JOINT bound values (they fold in
        // prior LOSS) and must not be persisted as recovered: doing so
        // records loss as recovery, and `_drawFromRecovery` then
        // subtracts a recycled figure that never entered the position —
        // publishing zero per-receipt capacity, or reverting outright
        // once the fictitious subtrahend exceeds the credit.
        s.ceremonyFreshRecovered[remitId] += freshInflow;
        s.ceremonyRecycledRecovered[remitId] += recycledInflow;
        s.remitRecoveredForReceipt[remitId] = recovered;
        _bookRecoveredInflow(s, remitId, freshInflow, recycledInflow, true);
        // The recovered value is no longer lost: the loss record shrinks
        // exactly like an out-of-order B1 chunk's recompute.
        uint256 sf = s.strandedReturnShortfall[remitId];
        if (sf != 0) {
            s.strandedReturnShortfall[remitId] =
                sf > amount ? sf - amount : 0;
        }
        bool gateCleared = _maybeClearResolvedGate(s, r, remitId, recovered);
        emit RecoveryCeremonyRecorded(
            remitId, freshInflow, recycledInflow, recovered, gateCleared
        );
    }

    /**
     * @notice ADMIN — record governance-evidenced TERMINAL LOSS (§5.3):
     *         the residue of a released reservation's stranded value that
     *         is neither recovered nor still in pool custody. The
     *         evidenced counterpart of the ceremony record; together they
     *         complete the custody-resolution identity that clears the
     *         R6 gate.
     * @dev    #1662 r2 — split BY PROVENANCE, exactly like the ceremony,
     *         and bounded per component against the reservation's own
     *         dispatched split net of what is already recorded. The
     *         recycled half is not bookkeeping detail: those tokens were
     *         locally stranded and are now GONE, so they must leave the
     *         coverage allowance. Leaving them in lets a dead balance
     *         back live reservations forever — the same phantom-headroom
     *         failure the recovered half closes, arrived at from the
     *         other end.
     */
    function recordRecoveryTerminalLoss(
        uint256 remitId,
        uint256 freshLoss,
        uint256 recycledLoss
    ) external nonReentrant whenNotPaused onlyCanonical
        onlyRole(LibAccessControl.ADMIN_ROLE)
    {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        LibVaipakam.RemitReservation storage r = s.remitReservations[remitId];
        uint256 amount = freshLoss + recycledLoss;
        if (amount == 0) revert NothingToRemit();
        if (r.status != 3) revert CeremonyReservationNotReleased(remitId);
        // #1662 r1 — a CONSUMED receipt's value backs mirror claims:
        // recording it as "terminal loss" would clear the gate over
        // value that is neither lost nor recoverable. #1662 r2 — only a
        // TRUSTED consumption closes this path; see {_consumptionTrusted}.
        if (_consumptionTrusted(r)) {
            revert StrandedReturnConsumedReceipt(remitId);
        }
        uint256 recovered = s.remitRecoveredForReceipt[remitId];
        uint256 loss = s.ceremonyTerminalLoss[remitId] + amount;
        if (recovered + loss > r.total) {
            revert CeremonyExceedsStranded(remitId, recovered + loss, r.total);
        }
        // Per-component provenance bounds — recovery and loss are both
        // draws on the SAME dispatched split, so they bound jointly.
        uint256 cf = s.ceremonyFreshRecovered[remitId]
            + s.ceremonyFreshLoss[remitId] + freshLoss;
        if (cf > r.fresh) {
            revert CeremonyProvenanceExceeded(remitId, cf, r.fresh);
        }
        uint256 cr = s.ceremonyRecycledRecovered[remitId]
            + s.ceremonyRecycledLoss[remitId] + recycledLoss;
        if (cr > r.recycled) {
            revert CeremonyProvenanceExceeded(remitId, cr, r.recycled);
        }
        s.ceremonyFreshLoss[remitId] += freshLoss;
        s.ceremonyRecycledLoss[remitId] += recycledLoss;
        s.ceremonyTerminalLoss[remitId] = loss;
        // The lost recycled tokens leave the coverage allowance.
        _resolveStrandedRecycled(s, remitId, recycledLoss);
        bool gateCleared = _maybeClearResolvedGate(s, r, remitId, recovered);
        emit RecoveryTerminalLossRecorded(
            remitId, freshLoss, recycledLoss, loss, gateCleared
        );
    }

    /// @dev #1662 r2 — record that `amount` of LOCALLY-stranded
    ///      recycled-provenance value is no longer in transit, saturating
    ///      at the stranded record. Fed by BOTH resolutions: a recovery
    ///      settlement (the tokens came home) and a terminal loss (they
    ///      are gone). Both must leave the coverage allowance — a dead 50
    ///      that still counts as in-transit backing masks a real shortfall
    ///      forever, which is the same phantom-headroom failure the
    ///      recovered half of this counter exists to close.
    function _resolveStrandedRecycled(
        LibVaipakam.Storage storage s,
        uint256 remitId,
        uint256 amount
    ) private {
        if (amount == 0) return;
        // #1461 — take this resolution off the remittance's own stranded record,
        // so a late delivery acknowledged afterwards resolves only what is left.
        LibVaipakam.RemitReservation storage r = s.remitReservations[remitId];
        uint256 rec = r.strandedRecycled;
        r.strandedRecycled = rec > amount ? rec - amount : 0;
        // #1662 r3 — accumulate UNCAPPED and cap where it is published
        // ({RewardAggregatorFacet.getRecycleCompositionPosition}), so this
        // counter stays the whole record of what was resolved.
        s.recycleReleasedRemitResolvedCumulative += amount;
    }

    /// @dev §5.3 — the FULL-custody-resolution gate clear: recovered plus
    ///      recorded terminal loss must equal the reservation's dispatched
    ///      total, and the gate must still name this receipt. Partial
    ///      recoveries hold (the B1 return path has its own §5.1
    ///      return-settlement clear; this identity governs the ceremony
    ///      path, where no wire remainder exists and operator evidence
    ///      defines completeness). An imported hold carries
    ///      {IMPORTED_GATE_SENTINEL} and can never match a real remitId
    ///      here.
    function _maybeClearResolvedGate(
        LibVaipakam.Storage storage s,
        LibVaipakam.RemitReservation storage r,
        uint256 remitId,
        uint256 recovered
    ) private returns (bool cleared) {
        if (
            recovered + s.ceremonyTerminalLoss[remitId] == r.total
                && s.compensationOutstanding[r.dstChainId] == remitId
        ) {
            LibRewardRemitDispatch.clearCompensationGate(s, r.dstChainId);
            cleared = true;
        }
    }

    /// @dev #1662 r2 — draw `amount` of uncharged re-dispatch capacity
    ///      against the NAMED source receipt's own recovery credit.
    ///
    ///      Per-receipt, not pooled, and that distinction is load-bearing.
    ///      The position balance is fungible, but the CLAW is not: when a
    ///      receipt's recovery is later contradicted by a consumed
    ///      attestation, only that receipt's own unspent credit may be
    ///      confiscated. Sizing draws (or claws) on the global balance
    ///      lets receipt A's contradiction consume receipt B's capacity,
    ///      which B can never re-credit because its own entitlement is
    ///      already exhausted. Naming the source at dispatch is what makes
    ///      "A's unspent" a computable quantity.
    ///
    ///      The RECYCLED half of a ceremony never enters the position (it
    ///      goes to bucket custody), so the credit is the fresh-provenance
    ///      part alone. The global balance is still asserted as a physical
    ///      backstop — the per-receipt sum can never exceed it, so a
    ///      failure there is an invariant breach, not a user error.
    function _drawFromRecovery(
        LibVaipakam.Storage storage s,
        uint256 sourceRemitId,
        uint256 amount
    ) private {
        uint256 credit = s.remitRecoveredForReceipt[sourceRemitId]
            - s.ceremonyRecycledRecovered[sourceRemitId];
        // #1662 r3 — CONFISCATED credit is not merely un-clawable, it is
        // unspendable: a contradiction voids the receipt's whole remaining
        // credit even where the pool could only absorb part of it, or the
        // next receipt's credit would silently become its backing.
        uint256 spent = s.recoveryRedispatchedForReceipt[sourceRemitId]
            + s.recoveryClawedForReceipt[sourceRemitId];
        uint256 unspent = credit > spent ? credit - spent : 0;
        if (amount > unspent) {
            revert RecoveryReceiptCreditInsufficient(
                sourceRemitId, amount, unspent
            );
        }
        uint256 position =
            s.rewardBudgetRecovered - s.rewardBudgetRedispatched;
        if (amount > position) {
            revert RecoveryPositionInsufficient(amount, position);
        }
        // #1662 r6 — only the REDISPATCHED term advances. `spent` folds
        // in clawed credit for the ADMISSION bound, but storing the
        // combined figure back would double-count the claw against any
        // recovery governance later records for the same receipt (which
        // is deliberately allowed — operator evidence stays the
        // resolution path), leaving that new capacity permanently
        // unreadable as available.
        s.recoveryRedispatchedForReceipt[sourceRemitId] =
            s.recoveryRedispatchedForReceipt[sourceRemitId] + amount;
    }

    /// @dev #1662 r1 — book a physically-recovered inflow: ONE combined
    ///      backing assertion over BOTH halves (fresh earmarks the
    ///      recovery position, recycled earmarks the bucket — asserted
    ///      together so neither half can lean on float the other is
    ///      about to claim), then the position credit and the
    ///      relocated-custody credit. A books-only "recovery" with no
    ///      tokens behind it rolls back here, not at claim time.
    /// @param localStranding #1662 r2 — whether the recycled component
    ///        retires stranding recorded in THIS deployment's cumulative.
    ///        False for an IMPORTED old-era settlement: that value was
    ///        stranded on the RETIRED deployment and never entered this
    ///        one's `recycleReleasedRemitStrandedCumulative`, so netting
    ///        it would under-recognise local backing and page a false
    ///        CRITICAL shortfall on legitimate commitments.
    function _bookRecoveredInflow(
        LibVaipakam.Storage storage s,
        uint256 refId,
        uint256 freshInflow,
        uint256 recycledInflow,
        bool localStranding
    ) private {
        uint256 bal = IERC20(s.vpfiToken).balanceOf(address(this));
        // #1566 slice 4 PR B — on an activated deployment the standing
        // earmarks are holder custody, not this balance; what must be here
        // is the inflow itself, which is then relocated (measured) below.
        bool holderCustody = LibRewardCustody.active(s);
        uint256 earmarks = holderCustody
            ? freshInflow + recycledInflow
            : s.recycleBucket + recycledInflow
                + (s.rewardBudgetRecovered - s.rewardBudgetRedispatched)
                + s.strandedReturnOverage + freshInflow;
        if (bal < earmarks) {
            revert CeremonyInflowNotBacked(refId, bal, earmarks);
        }
        s.rewardBudgetRecovered += freshInflow;
        if (holderCustody) {
            LibRewardCustody.callRelocateToHolder(LibVaipakam.RewardCustodyRow.Recovery, freshInflow);
        }
        if (recycledInflow != 0) {
            LibVpfiRecycle.creditCustodyRelocated(
                refId,
                recycledInflow,
                LibVpfiRecycle.RecycleSource.RecoveryCeremonyRelocation
            );
            // #1662 r2 — the release moved this value
            // `paidOutRecycled -> releasedRemitStranded`, and the credit
            // above just put it back in the bucket. The stranded record
            // deliberately STAYS (the composition bound needs it as the
            // un-netted destination term, and it is a monotone history),
            // so without this counter an external checker's coverage
            // allowance `bucket + stranded` would count the same VPFI
            // twice — permanently weakening a CRITICAL invariant.
            if (localStranding) _resolveStrandedRecycled(s, refId, recycledInflow);
        }
    }

    /**
     * @notice ADMIN — §5.4 R6e: seed a rotated-in deployment's R6 gate
     *         CLOSED for a chain whose compensation was outstanding on the
     *         RETIRED deployment, keyed by the old-era receipt tuple. No
     *         unresolved compensation may be silently forgotten by a
     *         redeploy: the imported marker holds new dispatches for that
     *         chain until the operator's evidenced
     *         {clearImportedOutstanding} settles it.
     * @dev    The import carries NOTHING about the parcel, and needs
     *         nothing: a settlement mints no re-dispatch capacity (r6), so
     *         there is no figure for a fabricated one to inflate, and
     *         there is no permissionless clear (r7), so a wrong tuple
     *         cannot be used to open the gate. Rounds 4 and 5 tried to
     *         bound the mint — first on operator-supplied figures, then by
     *         READING the retiring deployment — and neither authenticates
     *         against a compromised ADMIN, who supplies the predecessor
     *         address too. Removing the mint removed the question.
     *
     *         #1662 r10 — the `quarantineObserved` carry-over is likewise
     *         GONE. It existed to stop a second rotation laundering a
     *         mirror's self-contradiction into a clean consumption, which
     *         was a real hazard only while the permissionless clear
     *         existed. Since r7 deleted that clear, nothing read the flag:
     *         it was stored, emitted and published by the lens while no
     *         path enforced it, and the runbook was crediting it with a
     *         security effect it did not have.
     *
     *         What remains is a BLOCK. A mistaken import costs liveness on
     *         the one chain it names, recoverable by the evidenced
     *         settlement — never value.
     */
    function importOutstandingCompensation(
        uint32 dstChainId,
        address oldRemitter,
        uint256 oldRemitId
    ) external onlyCanonical onlyRole(LibAccessControl.ADMIN_ROLE) {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        if (oldRemitter == address(0) || oldRemitter == address(this)) {
            revert ImportedTupleInvalid(oldRemitter);
        }
        // #1662 r2 — the retiring deployment's VISIBLE gate reads the
        // sentinel when it was itself holding an imported gate. Copying
        // that across produces a tuple no old-era ack can ever match, so
        // refuse it and make the operator read the imported RECORD.
        if (oldRemitId == IMPORTED_GATE_SENTINEL) {
            revert ImportedTupleIsSentinel();
        }
        if (s.compensationOutstanding[dstChainId] != 0) {
            revert CompensationGateHeld(
                dstChainId, s.compensationOutstanding[dstChainId]
            );
        }
        // #1662 r5 — ONE import per tuple, ever. The gate returns to
        // zero when a settlement clears it, so without this the same
        // parcel could be imported repeatedly.
        bytes32 tupleKey =
            keccak256(abi.encode(dstChainId, oldRemitter, oldRemitId));
        if (s.importedTupleSeen[tupleKey]) {
            revert ImportedTupleAlreadySeen(dstChainId, oldRemitId);
        }
        s.importedTupleSeen[tupleKey] = true;
        s.importedOutstanding[dstChainId] = LibVaipakam.ImportedOutstanding({
            oldRemitter: oldRemitter,
            oldRemitId: oldRemitId
        });
        LibRewardRemitDispatch.setCompensationGate(
            s, dstChainId, IMPORTED_GATE_SENTINEL
        );
        emit OutstandingCompensationImported(
            dstChainId, oldRemitter, oldRemitId
        );
    }


    /**
     * @notice ADMIN — §5.4 R6e: the evidenced SETTLEMENT of an imported
     *         old-era gate (the forced-finalize mould), covering the
     *         quarantined old-era value a new-era B1 return cannot carry
     *         (its era check refuses old remitters by design).
     * @dev    #1662 r6 — this books NO fresh recovery capacity, and that
     *         is the point rather than a limitation.
     *
     *         Uncharged re-dispatch is justified by "this parcel's cap
     *         charge already happened at its ORIGINAL dispatch" — true
     *         within one deployment's counters, and FALSE across a
     *         rotation: `rewardBudgetRemittedGlobal` is never seeded, so a
     *         rotated deployment starts at zero and never charged for the
     *         old parcel. Minting uncharged capacity for it double-counts
     *         in the permissive direction on this deployment's own cap.
     *
     *         Removing the mint also removes the surface that rounds 4 and
     *         5 tried and failed to bound: the parcel's size cannot be
     *         authenticated from an ADMIN-supplied predecessor address (a
     *         compromised admin supplies the address too), so there is no
     *         check that contains it — only not minting does.
     *
     *         Old-era value that physically comes home is therefore
     *         handled by what it actually is: the RECYCLED half re-enters
     *         bucket custody, bounded by a real balance assertion, and the
     *         fresh half sits as ordinary custody that a replacement
     *         compensation spends through the CHARGED path — correctly
     *         charging a cap this deployment never charged.
     */
    function clearImportedOutstanding(
        uint32 dstChainId,
        uint256 recycledInflow
    ) external nonReentrant whenNotPaused onlyCanonical
        onlyRole(LibAccessControl.ADMIN_ROLE)
    {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        LibVaipakam.ImportedOutstanding memory im =
            s.importedOutstanding[dstChainId];
        if (im.oldRemitter == address(0)) {
            revert ImportedMarkerMissing(dstChainId);
        }
        if (recycledInflow != 0) {
            // localStranding FALSE (#1662 r2): stranded on the RETIRED
            // deployment, never in this one's cumulative, so it must not
            // net out of the local coverage allowance. The credit itself
            // asserts the tokens are physically present.
            _bookRecoveredInflow(s, im.oldRemitId, 0, recycledInflow, false);
        }
        delete s.importedOutstanding[dstChainId];
        LibRewardRemitDispatch.clearCompensationGate(s, dstChainId);
        emit ImportedOutstandingCleared(
            dstChainId, im.oldRemitter, im.oldRemitId, recycledInflow
        );
    }

}
