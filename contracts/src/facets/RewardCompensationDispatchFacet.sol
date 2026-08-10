// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.29;

import {LibVaipakam} from "../libraries/LibVaipakam.sol";
import {LibRewardRemitDispatch} from "../libraries/LibRewardRemitDispatch.sol";
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
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
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
        address vpfi = s.vpfiToken;
        if (vpfi == address(0)) revert VPFITokenNotSet();
        address messenger = s.crossChainMessenger;
        if (messenger == address(0)) revert RewardBudgetMessengerNotSet();

        // #1634 r2 — a clockless day can never emit the V3 broadcast that
        // settles the mirror's classification: `_broadcastDayV3` falls back
        // to the V2 wire permanently for it, V2 installs neither the zeroed
        // marker nor the era, and the compensation hook never fires — so
        // the credit would sit provisional forever, outside the recovery
        // reservation. Fail closed HERE, where the operator can act: a
        // post-w1 day heals its clock first (permissionless
        // {RewardAggregatorFacet.broadcastGlobalTo}); a pre-w1 day belongs
        // to the w4 legacy-compensation migration.
        LibVaipakam.DayLapseClock storage clk = s.dayLapseClock[dayId];
        if (clk.finalizedAt == 0) {
            revert CompensationDayHasNoClock(dayId);
        }
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
            if (lenderAmount18 > q.lender18 || borrowerAmount18 > q.borrower18)
            {
                revert CompensationExceedsQuote(
                    lenderAmount18, borrowerAmount18, q.lender18, q.borrower18
                );
            }
        }

        // r6 — NET headroom; a manual send retires no commitment (the
        // zeroed chain's share was never committed at finalize).
        uint256 remaining = LibRewardRemitDispatch.freshHeadroomNet(s, 0);
        if (amount > remaining) {
            revert RewardPoolCapExceeded(amount, remaining);
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
        s.rewardBudgetRemittedGlobal += amount;
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
            borrowerAmount18
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
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
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
        // #1656 r1 — the per-side funded record is the bound's base term;
        // a pre-w4 P2 compensation predates the stamps (both zero), and
        // treating that as zero funding would admit a second full quote.
        // The ADMIN seed ({seedCompFunded}) backfills it first.
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
        // Same frozen-clock + R3 cutoff discipline as the manual path: a
        // supplement dispatched inside the cutoff window could arrive
        // past expiry and quarantine after the terminal.
        // #1656 r3 — clock PRESENCE only, no R3 cutoff: the cutoff's
        // premise (a past-expiry arrival is a GUARANTEED quarantine) does
        // not hold for supplements — the mirror admits a top-up on a
        // compensated-and-open day until its §2.5 remediation deadline,
        // which is mirror-local state Base cannot read. A supplement
        // racing the short-lapse terminal quarantines token-safely and
        // returns via w5; refusing here instead would strand every AGED
        // migrated day's re-opened headroom behind an expiry its
        // remediation window replaced. The MANUAL path (first
        // compensation) keeps the full cutoff.
        if (s.dayLapseClock[dayId].finalizedAt == 0) {
            revert CompensationDayHasNoClock(dayId);
        }
        // R6 — one in flight per chain.
        {
            uint256 outstanding = s.compensationOutstanding[dstChainId];
            if (outstanding != 0) {
                revert CompensationGateHeld(dstChainId, outstanding);
            }
        }
        // 69M headroom — a supplement retires no commitment, like the
        // manual send it tops up.
        uint256 remaining = LibRewardRemitDispatch.freshHeadroomNet(s, 0);
        if (amount > remaining) {
            revert RewardPoolCapExceeded(amount, remaining);
        }

        // Effects (CEI) — a NEW reservation with its own lifecycle; the
        // day markers stay untouched (the whole point: funding
        // accumulates against the same obligation).
        uint256 remitId = ++s.remitReservationNonce;
        s.rewardBudgetRemittedGlobal += amount;
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
        }

        messageId = _sendCompensationPayload(
            s,
            vpfi,
            messenger,
            dstChainId,
            dayId,
            remitId,
            lenderAmount18,
            borrowerAmount18
        );

        emit SupplementalRewardBudgetRemitted(
            dstChainId, dayId, amount, remitId
        );
    }

    /// @notice #1434 P2-w4 (#1656 r1) — the per-side funded record was
    ///         backfilled for a pre-w4 compensation day.
    /// @custom:event-category informational/reward-compensation
    event CompFundedSeeded(
        uint32 indexed dstChainId,
        uint256 indexed dayId,
        uint256 lender18,
        uint256 borrower18
    );

    /// @notice ADMIN — backfill the per-side funded cumulative for a day
    ///         whose P2 manual compensation predates the w4 stamps: the
    ///         supplemental bound and the legacy inventory both read it.
    /// @dev The split must reproduce the ORIGINAL dispatch exactly: it
    ///      must sum to the day's recorded scalar funding, fit the
    ///      standing quote per side, and the record must currently be
    ///      empty (one-shot). The operator reads the split from the
    ///      original dispatch's wire record — the same evidence class as
    ///      the legacy stamp's day binding.
    function seedCompFunded(
        uint32 dstChainId,
        uint256 dayId,
        uint256 lenderAmount18,
        uint256 borrowerAmount18
    ) external onlyCanonical onlyRole(LibAccessControl.ADMIN_ROLE) {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        if (s.dayClosedByRemitId[dstChainId][dayId] == 0) {
            revert SupplementalDayNotClosed(dayId, dstChainId);
        }
        // #1656 r2 — one-shot on the EXISTENCE flag, never the value
        // pair (a rounded-to-zero reconciliation is a real record).
        if (s.compFundedRecorded[dstChainId][dayId]) {
            revert CompFundedSeedInvalid(dayId, dstChainId);
        }
        LibVaipakam.CompQuote storage q = s.compQuote[dayId][dstChainId];
        // #1656 r2 — the seed records what was CREDITED mirror-side: at
        // most the declared scalar (an already-ACKed short delivery seeds
        // at the RECEIVED figure, re-opening exactly the supplemental
        // headroom the shortfall left), each side within the quote.
        if (
            lenderAmount18 + borrowerAmount18
                > s.rewardBudgetRemitted[dstChainId][dayId]
                || lenderAmount18 > q.lender18
                || borrowerAmount18 > q.borrower18
        ) {
            revert CompFundedSeedInvalid(dayId, dstChainId);
        }
        s.compFundedLender18[dstChainId][dayId] = lenderAmount18;
        s.compFundedBorrower18[dstChainId][dayId] = borrowerAmount18;
        s.compFundedRecorded[dstChainId][dayId] = true;
        emit CompFundedSeeded(
            dstChainId, dayId, lenderAmount18, borrowerAmount18
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
        uint256 borrowerAmount18
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
        messageId = LibRewardRemitDispatch.dispatchRemitTail(
            s,
            vpfi,
            messenger,
            dstChainId,
            payload,
            lenderAmount18 + borrowerAmount18,
            remitId
        );
    }
}
