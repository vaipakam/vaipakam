// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.29;

import {LibVaipakam} from "../libraries/LibVaipakam.sol";
import {LibVpfiRecycle} from "../libraries/LibVpfiRecycle.sol";
import {LibRewardCustody} from "../libraries/LibRewardCustody.sol";
import {DiamondReentrancyGuard} from "../libraries/LibReentrancyGuard.sol";
import {DiamondPausable} from "../libraries/LibPausable.sol";
import {IVaipakamErrors} from "../interfaces/IVaipakamErrors.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";

/**
 * @title  RewardIngressFacet
 * @notice The MIRROR-SIDE INGRESS of the reward transport: the budget
 *         delivery, the compensation delivery and the compensation-day
 *         broadcast hook, called by the configured remittance receiver (or,
 *         for the hook, by the Diamond itself) after the transport has
 *         authenticated the packet.
 * @dev    #1566 transport epochs PR 3a — split out of {RewardRemittanceFacet}
 *         verbatim. That facet had 285 bytes of EIP-170 headroom left, and
 *         the ingress is exactly where the transport epochs grow: the
 *         day-list commitment, the batch admission, PR C's intended-era
 *         validation. Same storage, same Diamond, same
 *         selectors for every caller (the receiver contracts and the reporter
 *         facet reach these through the Diamond's fallback by selector); only
 *         the runtime bytecode is separate. The two facets must be refreshed
 *         together — the full refresh carries both — and the receipt key both
 *         sides share is derived in ONE place, {LibRewardCustody.remitReceiptKey}.
 *         The canonical-side surface (the remittance itself, its quotes, the
 *         ack ingress, the reservation finalization) and the mirror's ack
 *         send stay on {RewardRemittanceFacet}.
 */
contract RewardIngressFacet is DiamondReentrancyGuard, DiamondPausable, IVaipakamErrors {
    /// @notice A budget or compensation ingress called by an address other
    ///         than the configured mirror-side receiver.
    error NotRewardRemittanceReceiver(address caller);
    /// @notice The credited token is not this Diamond's VPFI token.
    error RewardBudgetTokenMismatch(address expected, address delivered);

    /// @notice 3d-1 / #918 — a d7 (rooted) reward budget landed: what arrived,
    ///         the commitment and extent it arrived under, the split the wire
    ///         typed, the era it was dispatched in, and (#918, appended) the
    ///         part Base declared and the funded day's whole slice. Whether it
    ///         opened an epoch is {LibRewardCustody.TransportBatchAdmitted}'s
    ///         fact, as for every other delivery; when the part counts toward
    ///         its day is {LibRewardCustody.DayDeliveryPartLanded}'s.
    /// @custom:event-category informational/reward-transport
    event RewardBudgetRootReceived(
        uint256 indexed sourceChainId,
        address indexed token,
        uint256 amount,
        bytes32 dayListRoot,
        uint256 dayCount,
        uint256 chunkCount,
        uint256 remitId,
        uint256 recycledShare,
        uint256 freshShare,
        uint64 intendedEra,
        uint256 declaredFresh,
        uint256 declaredRecycled,
        uint256 dayWholeFresh,
        uint256 dayWholeRecycled
    );

    /// @notice A d7 delivery was stamped for era `intended`, AHEAD of this chain's
    ///         live era `live`, and was filed into the live era. A mirror's own
    ///         reports never put the canonical chain ahead of it, so this means
    ///         the Diamond that reported was REPLACED (a new one restarts at era
    ///         0) — worth an operator's look, never a reason to strand value.
    /// @custom:event-category informational/reward-transport
    event CustodyEraAheadFiledLive(bytes32 indexed packetHash, uint64 intended, uint64 live);

    /**
     * @notice Record a reward budget the {RewardRemittanceReceiver} forwarded
     *         on the d7 (ROOTED) wire — #1566 transport epochs 3d-1, #918.
     * @dev    The one accounting path for a rooted delivery on an activated
     *         custody: the WHOLE delivery becomes its own transport epoch.
     *         Nothing is credited to the live delivered ledger or the recycle
     *         bucket at ingress; the wire's split is recorded as the epoch's
     *         attested caps, the delivery's value sits in the unclassified
     *         custody row under the packet, and the days the root commits to
     *         draw it first — under the draw, staging and gate rules every
     *         other epoch obeys — with only the residual reaching the shared
     *         sources. The uncounted figures grow by the whole amount: this
     *         value is in no shared ledger, and the draws step them down as
     *         they type it.
     *
     *         A wire whose split does not account for the whole delivery is
     *         refused by name, on BOTH paths (#2910): on the epoch path a wei
     *         under no cap would be value no day could draw and no
     *         classification could reach; before activation it would be an
     *         untyped remainder in the uncounted aggregate that nothing could
     *         classify (the envelope import that once could, for a Diamond
     *         upgraded in place, is retired with it). The shipped receiver
     *         always sends a whole split (its fresh share is what arrived less
     *         the recycled share), so the refusal binds only a wire that
     *         departs from it.
     *
     *         Before custody activation the delivery's tokens rest with the
     *         Diamond and the activation is what assigns them, so a rooted
     *         delivery then takes the TYPED-LEDGER path — the fresh share
     *         counted, the recycled one credited to the bucket — and opens no
     *         epoch (giving it one would leave two records claiming the same
     *         money, §5c's one-accounting-path rule). Its commitment is still
     *         stamped, so its days land through
     *         {RewardEpochFacet.proveDeliveryDayChunk}: a packet's record says
     *         what it claimed whichever path its value took.
     *
     *         `intendedEra` is STORED, not validated — PR C's receive rules
     *         read it.
     *
     *         #918 — the delivery may be one PART of its day's slice. The
     *         part as Base DECLARED it (`declaredTotal`, `declaredRecycled`,
     *         before the receiver's short-delivery scaling) and the day's
     *         WHOLE slice are stamped on the packet here and summed per day
     *         when its chunk is indexed or proven — the moment the mirror
     *         learns which day the packet funds — so the #1944 delivery gate
     *         opens the day only once every part has landed. Nothing is
     *         written per day here: the day is behind the root.
     *
     *         `transportMessageId` is the transport's message id, as the
     *         adapter delivered it (#1566 closure 2 cutover PR 1): the Diamond
     *         records the packet under `keccak256(sourceChainId,
     *         transportMessageId)`, the ingress stamp the cutover's
     *         reconciliation entries verify against. Zero for a transport
     *         without one — the ingress then allocates a per-source sequence.
     *
     *         MIGRATION MODE (design §5c, "the freeze blocks consumers
     *         WITHOUT blocking the packets being drained"): this ingress is
     *         deliberately NOT `whenNotPaused`. Under the manual pause every
     *         reward CONSUMER — claim, expiry and forfeit sweeps, transports —
     *         is refused, while a packet in flight still lands and is
     *         protected at ingress. The receiver's own guardian pause remains
     *         the lever to stop inbound packets at the edge.
     */
    function onRewardBudgetReceivedD7(
        address token,
        uint256 amount,
        bytes32 dayListRoot,
        uint256 elementCount,
        uint256 chunkCount,
        uint256 sourceChainId,
        uint256 remitId,
        address remitter,
        uint256 recycledShare,
        uint256 freshShare,
        bytes32 transportMessageId,
        uint64 intendedEra,
        uint256 declaredTotal,
        uint256 declaredRecycled,
        uint256 dayWholeFresh,
        uint256 dayWholeRecycled
    ) external nonReentrant {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        if (msg.sender != s.rewardRemittanceReceiver) {
            revert NotRewardRemittanceReceiver(msg.sender);
        }
        if (token != s.vpfiToken) {
            revert RewardBudgetTokenMismatch(s.vpfiToken, token);
        }
        if (recycledShare > amount) {
            revert RecycledShareExceedsDelivery(recycledShare, amount);
        }
        uint256 freshLooking = amount - recycledShare;
        if (freshShare > freshLooking) {
            revert FreshShareExceedsDelivery(freshShare, freshLooking);
        }
        s.rewardBudgetReceivedTotal += amount;
        bool epoch = LibRewardCustody.active(s);
        // On the epoch path the packet's declared shares stay ZERO: they record
        // what the ingress credited to the shared ledgers, which is nothing.
        bytes32 h = LibRewardCustody.callRecordIngressPacket(
            sourceChainId,
            transportMessageId,
            LibRewardCustody.PACKET_KIND_BUDGET,
            amount,
            epoch ? 0 : freshShare,
            epoch ? 0 : recycledShare,
            remitter,
            remitId
        );
        LibRewardCustody.stampPacketDayListRoot(s, h, dayListRoot, elementCount, chunkCount, intendedEra);
        LibRewardCustody.stampPacketDayPart(s, h, declaredTotal, declaredRecycled, dayWholeFresh, dayWholeRecycled);
        // The INTENDED ERA — the destination's own, as it last reported it to
        // the canonical chain (#1566 PR C revision) — against the live one.
        // Ahead of us: impossible while this Diamond is the one that reported its
        // era — the canonical chain only learns an era from this chain's own
        // reports — so this Diamond REPLACED the reporter and restarted at era 0.
        // It never reaches the stamped era, so refusing would strand the delivery
        // in the transport for good: it files into the LIVE era, the only one
        // this Diamond has, and says so. The wire's word stays on the packet.
        // Otherwise the delivery belongs to the era it was sent for, a retired
        // one included: it is NOT held inert, its epoch is that era's separately
        // backed, consumable home, drawn by the obligations of the days it lists
        // as transport legs, so nothing it carries reaches the live baseline.
        if (intendedEra > s.custodyEraCurrent) emit CustodyEraAheadFiledLive(h, intendedEra, s.custodyEraCurrent);
        if (freshShare + recycledShare != amount) {
            revert TransportSplitNotWhole(h, freshShare, recycledShare, amount);
        }
        if (epoch) {
            LibRewardCustody.stampPacketEra(
                s, h, intendedEra > s.custodyEraCurrent ? s.custodyEraCurrent : intendedEra
            );
            LibRewardCustody.attestPacketFromWire(s, h, freshShare, recycledShare);
            s.rewardBudgetFreshUncounted += amount;
            LibRewardCustody.callUnclassifiedIngress(h, amount);
            LibRewardCustody.admitRootedTransportBatch(s, h, amount);
        } else {
            if (freshShare != 0) s.rewardBudgetArmedFreshReceived += freshShare;
            LibVpfiRecycle.creditCustodyRelocated(
                remitId,
                recycledShare,
                LibVpfiRecycle.RecycleSource.RemittedCustodyRelocation
            );
        }
        emit RewardBudgetRootReceived(
            sourceChainId,
            token,
            amount,
            dayListRoot,
            elementCount,
            chunkCount,
            remitId,
            recycledShare,
            freshShare,
            intendedEra,
            declaredTotal - declaredRecycled,
            declaredRecycled,
            dayWholeFresh,
            dayWholeRecycled
        );
    }

    // ─── #1434 P2-w2 — the classifying COMPENSATION ingress (§2.2) ────────

    /// @notice A P2 compensation was credited to a zeroed day's per-side
    ///         pools (payable at w3's repricing). `provisional` marks the
    ///         overtake case — the day's V3 broadcast had not landed, so
    ///         the payload's authenticated remitter stands as the assumed
    ///         era until the broadcast confirms or demotes it, and the
    ///         credit's value is HELD APART meanwhile, uncounted (#2459 r5).
    /// @custom:event-category informational/reward-compensation
    event CompensationCredited(
        uint256 indexed dayId,
        uint256 lenderShare18,
        uint256 borrowerShare18,
        bool provisional,
        address era
    );

    /// @notice A P2 compensation arrival was QUARANTINED into the
    ///         stranded-recovery reservation (§2.2's token-safe rejection —
    ///         tokens accepted, never payable here; the R4 return takes it
    ///         from the reservation). `reason`: 1 = day not deliberately
    ///         zeroed, 2 = era mismatch, 3 = past the day's expiry (lapse
    ///         flags or the frozen clock words, installed or wire-carried),
    ///         4 = a second arrival while a provisional credit is already
    ///         held (one provisional receipt binding per day), 5 = retired
    ///         (#1944: a day with figures but no recorded era cannot exist
    ///         once kinds 2 and 5 are gone; never reused), 6 = clockless
    ///         payload (zero finalizedAt — an honest
    ///         Base refuses such a dispatch, so this is stale or hostile
    ///         and could never settle).
    /// @custom:event-category informational/reward-compensation
    event CompensationQuarantined(
        uint256 indexed dayId,
        address indexed remitter,
        uint256 remitId,
        uint256 amount,
        uint8 reason
    );

    /// @notice A provisional compensation was CONFIRMED in place by the
    ///         day's V3 broadcast (matching era, day genuinely zeroed): its
    ///         held value is counted now and credited to the day's era.
    /// @custom:event-category informational/reward-compensation
    event CompensationConfirmed(uint256 indexed dayId, address era);

    /// @notice A provisional compensation was DEMOTED to the
    ///         stranded-recovery reservation by the day's V3 broadcast
    ///         (era mismatch, or the day turned out not to be zeroed): its
    ///         held value, never counted, became uncounted and moved untouched
    ///         to where the return draws it. `remitter` and `remitId` name
    ///         the receipt whose stranded-recovery record it now is
    ///         (`getStrandedRecovery`), as `CompensationQuarantined` names
    ///         its own, so the record can be found from the event alone.
    /// @custom:event-category informational/reward-compensation
    event CompensationDemoted(
        uint256 indexed dayId,
        address indexed remitter,
        uint256 remitId,
        uint256 amount,
        uint8 reason
    );

    /**
     * @notice #1434 P2-w2 — trusted ingress for a P2 MANUAL-COMPENSATION
     *         delivery (design §2.2): classify the arrival against the
     *         day's mirror-local state and either credit the per-side
     *         compensated pools or quarantine the value into the arrival
     *         reservation. NEVER reverts on a classification failure — a
     *         revert is re-executable into the same revert forever (§2h
     *         R6d), so the token-safe form accepts the tokens and records
     *         why they are not payable.
     * @dev    Receiver-gated (the receiver already moved the VPFI in and
     *         scaled both shares to what physically landed). Cases, era
     *         first:
     *
     *         KNOWN state (day applied AND era recorded): a remitter that
     *         does not match the day's era quarantines (reason 2 — §1.1's
     *         compensation-side era binding); a day not deliberately
     *         zeroed quarantines (reason 1 — there is nothing to
     *         compensate); a lapsed / short-lapsed day quarantines
     *         (reason 3 — the loss was already recorded at lapse;
     *         unreachable until the w4 terminals ship). Otherwise the
     *         pools credit CONFIRMED.
     *
     *         UNKNOWN state (day not applied, or applied without an era —
     *         the compensation OVERTOOK the V3 broadcast, §2.2 case b):
     *         credit PROVISIONALLY under the payload's authenticated
     *         remitter as the assumed era. The V3 arrival later confirms
     *         in place or demotes to the reservation
     *         ({RewardReporterFacet.onRewardBroadcastV3Received} calls
     *         {onCompensationDayBroadcastArrived}). Never waits: the
     *         expiry inputs rode the remit itself (R4b).
     *
     *         In EVERY case the receipt is recorded exactly like an
     *         ordinary delivery (delivered once — a second packet for the
     *         receipt refuses whole), so the ACK path is
     *         unchanged, and `rewardBudgetReceivedTotal` records the
     *         arrival. The armed-fresh counter advances only for CREDITED
     *         pools (quarantined value is recorded uncounted instead), and
     *         what was counted is stored so a demotion can move it —
     *         counted + uncounted always reconciles against what Base
     *         sent.
     * @param transportMessageId The transport's message id (#1566 closure 2
     *         cutover PR 1) — see {onRewardBudgetReceivedD7}; the packet is
     *         recorded under its ingress stamp, and a quarantine lands in
     *         the holder's `Unclassified` row on an activated deployment.
     *         Not `whenNotPaused`, for the migration-mode reason
     *         {onRewardBudgetReceivedD7} gives.
     */
    function onCompensationBudgetReceived(
        address token,
        uint256 amount,
        uint256 dayId,
        uint256 sourceChainId,
        uint256 remitId,
        address remitter,
        uint256 lenderShare18,
        uint256 borrowerShare18,
        uint64 finalizedAt,
        uint32 lapseScheduleVersion,
        uint64 lapseWindowSeconds,
        uint64 /* dispatchCutoffGap — Base-side input (the R3 refusal);
                  carried for symmetry + w4's gates, unused here */,
        bytes32 transportMessageId
    ) external nonReentrant {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        if (msg.sender != s.rewardRemittanceReceiver) {
            revert NotRewardRemittanceReceiver(msg.sender);
        }
        if (token != s.vpfiToken) {
            revert RewardBudgetTokenMismatch(s.vpfiToken, token);
        }
        if (lenderShare18 + borrowerShare18 > amount) {
            revert CompensationSharesExceedDelivery(
                lenderShare18, borrowerShare18, amount
            );
        }

        s.rewardBudgetReceivedTotal += amount;
        bytes32 h = LibRewardCustody.callRecordIngressPacket(
            sourceChainId,
            transportMessageId,
            LibRewardCustody.PACKET_KIND_COMPENSATION,
            amount,
            amount,
            0,
            remitter,
            remitId
        );
        // #1566 PR C revision — a compensation belongs to the era of its day.
        LibRewardCustody.stampPacketEra(s, h, LibRewardCustody.custodyEraOfDay(s, dayId));
        {
            // #1566 transport epochs PR 3a — a compensation names ONE day, and
            // its packet records that day's flat commitment as provenance.
            uint256[] memory one = new uint256[](1);
            one[0] = dayId;
            LibRewardCustody.stampPacketDayList(s, h, one);
        }
        // Receipt exactly as the ordinary ingress records it — written by
        // the packet record above, once per receipt (a second packet for a
        // delivered receipt refuses whole); the ACK path reads that record
        // and nothing else.

        address era = s.dayClockEra[dayId];
        bool stateKnown = s.broadcastV2Applied[dayId] && era != address(0);
        if (stateKnown) {
            uint8 reason = 0;
            if (remitter != era) reason = 2;
            else if (!s.dayDeliberatelyZeroed[dayId]) reason = 1;
            else if (
                s.dayLapsed[dayId] || s.dayShortLapsed[dayId]
                    // #1656 r3 — the raw-expiry test governs FIRST
                    // compensations only: a compensated-and-open day is
                    // inside its §2.5 REMEDIATION window (the short-lapse
                    // deadline supersedes the original expiry for
                    // supplements — §2.5: "a supplemental arriving after
                    // the state is set is quarantined", i.e. the terminal
                    // FLAGS govern, and they are tested above). Without
                    // this, an aged migrated day's re-opened supplemental
                    // headroom would be unreachable — every top-up would
                    // quarantine against a clock its remediation window
                    // replaced.
                    || (
                        !s.dayCompensation[dayId].compensated
                            && _pastExpiry(
                                s.dayLapseClock[dayId].finalizedAt,
                                s.dayLapseClock[dayId].scheduleVersion,
                                s.dayLapseClock[dayId].lapseWindowSeconds
                            )
                    )
            ) {
                // Codex #1634 r1 — the flags alone are the w4 TERMINALS'
                // record; the INSTALLED clock itself already decides "past
                // the applicable expiry" (§2.2's fourth case tests the
                // clock, not just the flags), so an arrival after the true
                // expiry quarantines even before any terminal has run.
                reason = 3;
            }
            if (reason != 0) {
                _quarantineCompensation(
                    s, h, dayId, remitter, remitId, amount, reason
                );
                return;
            }
            _creditCompensation(
                s,
                dayId,
                remitId,
                lenderShare18,
                borrowerShare18,
                amount,
                /* provisional */ false,
                era
            );
            return;
        }

        // Codex #1634 r1 — a SECOND compensation while one is already
        // provisional must NOT go provisional: the day holds one
        // provisional receipt binding (era + remitId), and overwriting it
        // would demote BOTH packets' pools under the last receipt key — the
        // receipt-bounded return could then recover at most that one
        // reservation's entitlement, stranding the earlier packet. One
        // provisional credit per day; conflicting arrivals hold their own
        // receipt-keyed reservation until the day's broadcast settles which
        // era governs. (Its sibling, reason 5, guarded a day with figures
        // but no recorded era; #1944 retired the wires that could make one.)
        LibVaipakam.DayCompensation storage dcPrior = s.dayCompensation[dayId];
        if (dcPrior.provisional) {
            _quarantineCompensation(s, h, dayId, remitter, remitId, amount, 4);
            return;
        }
        // A CLOCKLESS payload (zero finalizedAt) cannot settle either: an
        //     honest Base never sends one (it dispatches only a finalized
        //     day, and finalization freezes the clock), so one arriving
        //     here is stale or hostile, and a provisional credit for it
        //     would wait on a broadcast that can never carry a matching
        //     clock. It is quarantined token-safely (reason 6).
        if (finalizedAt == 0) {
            _quarantineCompensation(s, h, dayId, remitter, remitId, amount, 6);
            return;
        }
        // And the overtake case can still be PAST ITS TRUE EXPIRY: the wire
        //     carries the full frozen clock words (R4b), so the ingress
        //     evaluates them even with no broadcast state — a delivery
        //     arriving after the day's expiry must never be provisionally
        //     credited only to lapse at confirmation.
        if (_pastExpiry(finalizedAt, lapseScheduleVersion, lapseWindowSeconds))
        {
            _quarantineCompensation(s, h, dayId, remitter, remitId, amount, 3);
            return;
        }
        _creditCompensation(
            s,
            dayId,
            remitId,
            lenderShare18,
            borrowerShare18,
            amount,
            /* provisional */ true,
            remitter
        );
    }

    /// @dev §2.4 — expiry from FROZEN words only, both sourced from Base's
    ///      finalization-time freeze (the installed clock on a stamped day,
    ///      the wire's duplicated words on an unstamped one). Version 0 =
    ///      no schedule frozen ⇒ never expired (a zero window must not
    ///      read as "lapse immediately" — the w1 rule).
    function _pastExpiry(
        uint64 finalizedAt,
        uint32 scheduleVersion,
        uint64 lapseWindowSeconds
    ) private view returns (bool) {
        return finalizedAt != 0 && scheduleVersion != 0
            && block.timestamp > uint256(finalizedAt) + lapseWindowSeconds;
    }

    /// @dev Credit the per-side pools and COUNT the arrival's fresh value —
    ///      or, for a PROVISIONAL credit, hold that value apart uncounted until
    ///      the day's broadcast settles it (#2459 r5).
    function _creditCompensation(
        LibVaipakam.Storage storage s,
        uint256 dayId,
        uint256 remitId,
        uint256 lenderShare18,
        uint256 borrowerShare18,
        uint256 amount,
        bool provisional,
        address era
    ) private {
        LibVaipakam.DayCompensation storage dc = s.dayCompensation[dayId];
        // #1434 P2-w4 (§2.5) — the short-compensated deadline inputs,
        // stamped BEFORE the pools move so the qualifying test reads the
        // pre-credit shortfall. First credit starts the absolute 3×
        // clock; a later credit extends the rolling window ONLY if it is
        // QUALIFYING — cutting the remaining per-side shortfall by at
        // least one quarter on some short side — so dust top-ups cannot
        // park the day unclaimable forever (§2.5's bounded-deadline
        // rule). With no standing quote yet (accums zero) nothing is
        // "short", the qualifying test is vacuously false, and only the
        // first-credit stamp lands — the deadline then runs on the
        // absolute clock, which is the conservative direction.
        //
        // #1656 r11 — a PROVISIONAL credit stamps NO clocks: it awaits
        // its V3 confirmation, and until that lands Base holds the
        // compensation gate (a supplemental needs a consumed ACK's
        // round trip first), so no remediation interval exists yet. A
        // delayed broadcast would otherwise burn the whole window while
        // supplementing was impossible and let the short-lapse terminal
        // fire the moment `provisional` clears. The confirm hook stamps
        // the clocks at confirmation time instead; the demote path
        // deletes any stamped clocks with the credit (r1).
        if (!provisional) {
            if (s.firstCompReceiptAt[dayId] == 0) {
                s.firstCompReceiptAt[dayId] = uint64(block.timestamp);
                s.lastQualifyingCompReceiptAt[dayId] =
                    uint64(block.timestamp);
            } else if (
                _cutsShortfallByQuarter(
                    s, dayId, lenderShare18, borrowerShare18
                )
            ) {
                s.lastQualifyingCompReceiptAt[dayId] =
                    uint64(block.timestamp);
            }
        }
        dc.lenderPool18 += SafeCast.toUint128(lenderShare18);
        dc.borrowerPool18 += SafeCast.toUint128(borrowerShare18);
        dc.creditedAmount += SafeCast.toUint128(amount);
        dc.compensated = true;
        if (provisional) {
            dc.provisional = true;
            dc.provisionalEra = era;
        }
        dc.remitId = remitId;
        // #1656 r8 - receipt classification: era == the payload remitter
        // on both credit paths (the known-state ladder requires the
        // match; the provisional branch DEFINES era := remitter).
        s.receivedRemits[LibRewardCustody.remitReceiptKey(era, remitId)].classification =
            provisional ? 2 : 0;

        // #1566 closure 2 — a compensation frame carries no recycled share
        // (Base dispatches fresh budget for a zeroed day), so `amount` IS its
        // authenticated fresh component, counted whatever the day's vintage.
        // #2459 r5 — a PROVISIONAL credit is not counted yet: its value is HELD
        // APART ({LibRewardCustody.holdProvisional}) — counted by neither side of
        // the ledger, backing nothing, carried by no era move — until the day's
        // broadcast confirms it (counted then, by exactly this figure) or demotes
        // it (moved, untouched, to the return reservation). One provisional
        // credit per day: a second arrival quarantines (reason 4, above).
        if (provisional) {
            dc.provisionalHeld = SafeCast.toUint128(amount);
            s.rewardBudgetFreshProvisional += amount;
            if (LibRewardCustody.active(s)) {
                LibRewardCustody.callEraHoldProvisional(amount);
                dc.provisionalHeldInCustody = true;
            }
        } else {
            _countCompensation(s, dc, dayId, amount, false);
        }
        emit CompensationCredited(
            dayId, lenderShare18, borrowerShare18, provisional, era
        );
    }

    /// @dev COUNT `amount` of a compensation's fresh value: credited to the era
    ///      of the day it compensates by the routing rule (#1566 PR C revision:
    ///      the live baseline for a live day; a retired era's row, or once that
    ///      era is final pending surplus while Detached, else the live
    ///      baseline) — from the `Provisional` row when a held credit is
    ///      confirmed in custody, relocated (measured) from the Diamond on an
    ///      activated deployment otherwise, the received side alone before
    ///      activation — with `armedFreshCounted` recording what was counted.
    function _countCompensation(
        LibVaipakam.Storage storage s,
        LibVaipakam.DayCompensation storage dc,
        uint256 dayId,
        uint256 amount,
        bool heldInCustody
    ) private {
        uint64 era = LibRewardCustody.custodyEraOfDay(s, dayId);
        if (heldInCustody) {
            LibRewardCustody.callEraCreditFreshFromRow(LibVaipakam.RewardCustodyRow.Provisional, amount, era);
        } else if (LibRewardCustody.active(s)) {
            LibRewardCustody.callEraRelocateFreshIngress(amount, era);
        } else {
            s.rewardBudgetArmedFreshReceived += amount;
        }
        dc.armedFreshCounted += SafeCast.toUint128(amount);
    }

    /// @dev #1434 P2-w4 (§2.5) — does this credit cut the remaining
    ///      per-side shortfall (quoted − pool, on a side that IS short)
    ///      by at least one quarter? Reads the PRE-credit pools (the
    ///      caller stamps before crediting). A side with no shortfall
    ///      contributes nothing; with neither side short there is nothing
    ///      to qualify against.
    function _cutsShortfallByQuarter(
        LibVaipakam.Storage storage s,
        uint256 dayId,
        uint256 lenderShare18,
        uint256 borrowerShare18
    ) private view returns (bool) {
        LibVaipakam.DayCompensation storage dc = s.dayCompensation[dayId];
        uint256 shortL;
        uint256 shortB;
        {
            uint256 qL = s.compQuoteAccum18[
                dayId
            ][uint8(LibVaipakam.RewardSide.Lender)];
            uint256 qB = s.compQuoteAccum18[
                dayId
            ][uint8(LibVaipakam.RewardSide.Borrower)];
            uint256 pL = uint256(dc.lenderPool18);
            uint256 pB = uint256(dc.borrowerPool18);
            shortL = qL > pL ? qL - pL : 0;
            shortB = qB > pB ? qB - pB : 0;
        }
        if (shortL != 0 && lenderShare18 * 4 >= shortL) return true;
        if (shortB != 0 && borrowerShare18 * 4 >= shortB) return true;
        return false;
    }

    /// @dev The token-safe rejection: the whole arrival enters the
    ///      stranded-recovery reservation (backing excluded from ordinary
    ///      claims via {LibVpfiRecycle.backingPosition}), its fresh value
    ///      recorded UNCOUNTED, and the receipt-keyed record names it for
    ///      the R4 return (w5).
    function _quarantineCompensation(
        LibVaipakam.Storage storage s,
        bytes32 h,
        uint256 dayId,
        address remitter,
        uint256 remitId,
        uint256 amount,
        uint8 reason
    ) private {
        s.strandedRecoveryReserved += amount;
        s.rewardBudgetFreshUncounted += amount;
        // #1566 closure 2 cutover PR 1 — on an activated deployment the
        // quarantine is protected at ingress: relocated (measured) into the
        // holder's `Unclassified` row, the record and the reservation told
        // how much the holder backs; the R4 return draws it from there.
        if (LibRewardCustody.active(s)) {
            LibRewardCustody.callUnclassifiedQuarantine(h, LibRewardCustody.remitReceiptKey(remitter, remitId), amount, 0);
        }
        LibVaipakam.StrandedRecovery storage sr =
            s.strandedRecoveries[LibRewardCustody.remitReceiptKey(remitter, remitId)];
        sr.amount += amount;
        sr.dayId = dayId;
        if (sr.reservedAt == 0) sr.reservedAt = uint64(block.timestamp);
        sr.reason = reason;
        // #1656 r8 - the receipt carries the classification so the ACK
        // wire can say "not consumed" and hold the R6 gate.
        s.receivedRemits[LibRewardCustody.remitReceiptKey(remitter, remitId)].classification = 1;
        emit CompensationQuarantined(dayId, remitter, remitId, amount, reason);
    }

    /**
     * @notice #1434 P2-w2 — the V3-broadcast arrival hook for a day
     *         holding a PROVISIONAL compensation: CONFIRM it in place when
     *         the broadcast's deployment matches the assumed era AND the
     *         day is genuinely deliberately-zeroed; DEMOTE the whole
     *         credit to the stranded-recovery reservation otherwise (the
     *         confirmed era's state governs).
     * @dev    Diamond-internal: callable only through the Diamond itself
     *         ({RewardReporterFacet.onRewardBroadcastV3Received} invokes it
     *         via `address(this)` after installing/verifying the day's
     *         clock). No-op for a day with no provisional credit.
     */
    function onCompensationDayBroadcastArrived(
        uint256 dayId,
        address baseDeployment,
        bool zeroedForDest
    ) external {
        if (msg.sender != address(this)) {
            revert CompensationHookNotSelf(msg.sender);
        }
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        LibVaipakam.DayCompensation storage dc = s.dayCompensation[dayId];
        if (!dc.provisional) return;

        if (dc.provisionalEra == baseDeployment && zeroedForDest) {
            dc.provisional = false;
            // #1656 r11 — the remediation clock starts NOW, not at the
            // provisional receipt: only from confirmation can Base's
            // supplemental path ever run (gate → consumed ACK → gate
            // clear), so the bounded window must not have been burning
            // while the credit sat unconfirmed. First-stamp only: a
            // provisional can exist solely on a day with no known
            // broadcast state, and every credited (clock-stamping)
            // receipt flows through the known-state branch — a non-zero
            // clock here is an unreachable ordering left untouched
            // defensively (the absolute 3× cap governs regardless).
            if (s.firstCompReceiptAt[dayId] == 0) {
                s.firstCompReceiptAt[dayId] = uint64(block.timestamp);
                s.lastQualifyingCompReceiptAt[dayId] =
                    uint64(block.timestamp);
            }
            // #1656 r8 - the settled credit is CONSUMED: its receipt's
            // ack may now clear the R6 gate.
            s.receivedRemits[
                LibRewardCustody.remitReceiptKey(dc.provisionalEra, dc.remitId)
            ].classification = 0;
            // #2459 r5 — confirmation COUNTS the held value, once, by exactly
            // the figure held (fresh only: the frame carries no recycled
            // share), and credits it to the day's era by the routing rule as
            // an arrival now — the era's state at confirmation governs where.
            uint256 toCount = dc.provisionalHeld;
            bool inCustody = dc.provisionalHeldInCustody;
            dc.provisionalHeld = 0;
            dc.provisionalHeldInCustody = false;
            s.rewardBudgetFreshProvisional -= toCount;
            _countCompensation(s, dc, dayId, toCount, inCustody);
            emit CompensationConfirmed(dayId, baseDeployment);
            return;
        }
        // Demote: era mismatch (2) or the day was never zeroed (1). The
        // reservation takes the CREDITED amount, wholesale (#1634 r3) —
        // the pool sum can floor a wei below it on a scaled delivery, and
        // the design promises the demotion moves the arrival, not the sum.
        uint8 reason = dc.provisionalEra == baseDeployment ? 1 : 2;
        uint256 pools = dc.creditedAmount;
        s.strandedRecoveryReserved += pools;
        // #2459 r5 — the held value was never counted and never moved, so the
        // demotion unwinds nothing: it becomes UNCOUNTED, and the value goes,
        // untouched, where the R4 return draws it — in-holder from the
        // `Provisional` row into `Unclassified`; a hold made before custody
        // activation is relocated (measured) from the Diamond into the row,
        // as a quarantine landing is; before activation it stays at the
        // Diamond, as a pre-activation quarantine does.
        uint256 held = dc.provisionalHeld;
        if (held != 0) {
            s.rewardBudgetFreshProvisional -= held;
            s.rewardBudgetFreshUncounted += held;
            if (dc.provisionalHeldInCustody || LibRewardCustody.active(s)) {
                bytes32 rKey = LibRewardCustody.remitReceiptKey(dc.provisionalEra, dc.remitId);
                LibRewardCustody.callUnclassifiedQuarantine(
                    s.receivedRemits[rKey].packetHash,
                    rKey,
                    dc.provisionalHeldInCustody ? 0 : held,
                    dc.provisionalHeldInCustody ? held : 0
                );
            }
        }
        LibVaipakam.StrandedRecovery storage sr = s.strandedRecoveries[
            LibRewardCustody.remitReceiptKey(dc.provisionalEra, dc.remitId)
        ];
        sr.amount += pools;
        sr.dayId = dayId;
        if (sr.reservedAt == 0) sr.reservedAt = uint64(block.timestamp);
        sr.reason = reason;
        // #1656 r8 - demoted = stranded: the receipt's ack must not
        // clear the R6 gate any more.
        s.receivedRemits[
            LibRewardCustody.remitReceiptKey(dc.provisionalEra, dc.remitId)
        ].classification = 1;
        // Emitted before the day's record goes: it names the receipt the
        // stranded record is keyed by.
        emit CompensationDemoted(dayId, dc.provisionalEra, dc.remitId, pools, reason);
        delete s.dayCompensation[dayId];
        // #1656 r1 - the demoted credit's receipt clocks go with it: a
        // later CURRENT-era compensation must get its own full bounded
        // window, not inherit a rejected packet's aged firstCompReceiptAt
        // (three windows past which it could be short-lapsed on arrival).
        delete s.firstCompReceiptAt[dayId];
        delete s.lastQualifyingCompReceiptAt[dayId];
    }





    // #1566 closure 2 — `_armedAttributableDelivery` (#1434 P1-a) was
    // retired here: the received side no longer keys on whether every day a
    // delivery covers is at or after `D*`. Its conservative gap (a delivery
    // overtaking the arming broadcast counted as zero) no longer exists,
    // because vintage no longer decides what is counted.
}
