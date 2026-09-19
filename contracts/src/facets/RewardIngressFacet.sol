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
 *         the ingress is exactly where the transport epochs grow: 3a's
 *         day-list commitment on every pre-d6 arrival, 3b's batch admission,
 *         PR C's intended-era validation. Same storage, same Diamond, same
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
    /// @notice Emitted (mirror side) when a reward budget is received + credited.
    /// @param sourceChainId Base chain id the budget came from.
    /// @param token         Local VPFI token credited.
    /// @param amount        VPFI credited to this Diamond.
    /// @param dayIds        The exact day ids the batch funded — the mirror
    ///                      keeps only `rewardBudgetReceivedTotal`, so this is
    ///                      the sole per-day reconciliation record (the design
    ///                      dropped a per-day map in favour of this event).
    /// @param remitId       B2-d2 delivered-backing reservation id this
    ///                      delivery fulfils (0 = legacy pre-d2 message — no
    ///                      receipt record, no ack).
    /// @param recycledShare #1434 P1-a — the delivery's declared RECYCLED
    ///                      component, post-scaling.
    /// @param freshShare    #1434 P1-a — its declared FRESH component,
    ///                      post-scaling. Zero on a wire generation that
    ///                      carried no split, which is NOT the same as
    ///                      "nothing was fresh".
    /// @dev    The two shares are the RAW INPUTS to the delivered-fresh
    ///         attribution, deliberately not its outcome. Whether a delivery
    ///         was counted is a function of these plus `dayIds` and the
    ///         chain's `D*`, all of which a reader already has — so emitting
    ///         the verdict as well would be a second source of the same
    ///         truth, free to drift from the counters. What a reader could
    ///         NOT previously reconstruct is `freshShare`: it depends on the
    ///         wire generation, and the generation itself still never reaches
    ///         this Diamond. Without it, a refused delivery is
    ///         indistinguishable from a delivery that genuinely carried no
    ///         fresh funding.
    ///
    ///         #1566 transport epochs PR 3b — ONE fact about the generation
    ///         now travels, `splitTyped`, and it is not emitted here: whether
    ///         the delivery opened a transport epoch is exactly that fact, and
    ///         {LibRewardCustody.TransportBatchAdmitted} already says so for
    ///         every delivery that did. Emitting it twice would be a second
    ///         source of one truth, free to drift — the same reason the
    ///         counted/uncounted verdict is absent above.
    /// @custom:event-category informational/reward-transport
    event RewardBudgetReceived(
        uint256 indexed sourceChainId,
        address indexed token,
        uint256 amount,
        uint256[] dayIds,
        uint256 remitId,
        uint256 recycledShare,
        uint256 freshShare
    );

    /// @notice `onRewardBudgetReceived` called by an address other than the
    ///         configured mirror-side receiver.
    error NotRewardRemittanceReceiver(address caller);
    /// @notice The credited token is not this Diamond's VPFI token.
    error RewardBudgetTokenMismatch(address expected, address delivered);

    /**
     * @notice Record a reward budget the {RewardRemittanceReceiver} has already
     *         forwarded (as VPFI) into this mirror Diamond.
     * @dev    Monitoring-only: the VPFI is already in the Diamond's balance
     *         (the receiver transferred it before this call), and
     *         `claimInteractionRewards` pays from that balance. This just
     *         records the funded total + emits an event for reconciliation.
     *         Trust chain: gated to the registered receiver, whose own
     *         `onCrossChainMessage` is gated to the CCIP messenger.
     * @param token         Token credited — must be this Diamond's VPFI.
     * @param amount        VPFI amount credited.
     * @param dayIds        Days the batch covered (for the event log).
     * @param sourceChainId Base chain id the budget came from.
     * @param remitId       #1222 M3 B2-d2 — the Base-side delivered-backing
     *                      reservation id this delivery fulfils (0 for a
     *                      legacy pre-d2 message: no receipt record is
     *                      written and no ack ever flows — Base holds no
     *                      reservation for those). First delivery wins the
     *                      receipt slot; the ack content is later computed
     *                      from this record, never caller-supplied.
     * @param recycledShare RECYCLED component of `amount`, already scaled to
     *                      what physically landed. Zero on a legacy/d2
     *                      payload, whose wire never carried the split.
     * @param freshShare    #1434 P1-a — FRESH component of `amount`, likewise
     *                      pre-scaled. The receiver derives it from the WIRE
     *                      GENERATION it decoded and passes ZERO whenever the
     *                      composition was not transmitted, so this ingress
     *                      never has to infer a split from a payload that
     *                      does not carry one. `freshShare + recycledShare`
     *                      may be LESS than `amount` (both are floored) and
     *                      may never exceed it.
     * @param splitTyped    #1566 transport epochs PR 3b — whether the WIRE
     *                      carried the fresh/recycled split, which is not the
     *                      same as whether the split it carried was non-zero:
     *                      a d5 remittance that was wholly recycled and a
     *                      legacy one that transmitted nothing both arrive
     *                      here as two zero components. Supplied by the
     *                      receiver rather than inferred here because the
     *                      receiver is the only party that saw the wire
     *                      generation. It decides the delivery's ACCOUNTING
     *                      PATH: a typed delivery's components are credited to
     *                      the shared ledgers below and it takes no transport
     *                      epoch, while an untyped delivery's value is in no
     *                      shared ledger and its epoch is what makes it
     *                      spendable by the obligations it names.
     * @param transportMessageId The transport's message id, as the adapter
     *                      delivered it (#1566 closure 2 cutover PR 1): the
     *                      Diamond records the packet under
     *                      `keccak256(sourceChainId, transportMessageId)`,
     *                      the ingress stamp the cutover's reconciliation
     *                      entries verify against. Zero for a transport
     *                      without one — the ingress then allocates a
     *                      per-source sequence itself.
     *
     *         MIGRATION MODE (design §5c, "the freeze blocks consumers
     *         WITHOUT blocking the packets being drained"): this receive
     *         ingress is deliberately NOT `whenNotPaused`. Under the
     *         manual pause every reward CONSUMER — claim, expiry and
     *         forfeit sweeps, transports — is refused, while a packet in
     *         flight still lands and is protected at ingress; the pause
     *         boundary the expiry predicates already stamp keeps the
     *         frozen interval uncredited. The receiver's own guardian
     *         pause remains the lever to stop inbound packets at the edge.
     */
    function onRewardBudgetReceived(
        address token,
        uint256 amount,
        uint256[] calldata dayIds,
        uint256 sourceChainId,
        uint256 remitId,
        address remitter,
        uint256 recycledShare,
        uint256 freshShare,
        bytes32 transportMessageId,
        bool splitTyped
    ) external nonReentrant {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        if (msg.sender != s.rewardRemittanceReceiver) {
            revert NotRewardRemittanceReceiver(msg.sender);
        }
        if (token != s.vpfiToken) {
            revert RewardBudgetTokenMismatch(s.vpfiToken, token);
        }
        // Both component bounds are enforced BEFORE either is used. The
        // recycled bound was always here (it gates the custody credit
        // below); the fresh bound is its twin, and checking it against the
        // recycled REMAINDER rather than against `amount` is what makes the
        // pair jointly sound — two individually-valid shares can still sum
        // past the delivery.
        if (recycledShare > amount) {
            revert RecycledShareExceedsDelivery(recycledShare, amount);
        }
        uint256 freshLooking = amount - recycledShare;
        if (freshShare > freshLooking) {
            revert FreshShareExceedsDelivery(freshShare, freshLooking);
        }
        s.rewardBudgetReceivedTotal += amount;
        // #1434 P1-a — record the ARMED-ATTRIBUTABLE fresh component.
        //
        // Two independent tests, and a delivery must pass BOTH:
        //
        //   1. COMPOSITION KNOWN — decided by the receiver, which is the only
        //      party that saw the wire generation. A legacy/d2 payload never
        //      carried the fresh/recycled split, so the receiver sends
        //      `freshShare = 0` and the delivery contributes nothing. The
        //      earlier shape of this code inferred `amount - recycledShare`
        //      here, which recorded such a delivery as ENTIRELY fresh even
        //      where the original remit was partly recycled — over-stating
        //      exactly on the deliveries whose composition is unknown
        //      (Codex #1556 r1 P1).
        //   2. ARMED-ATTRIBUTABLE — every day this delivery covers is at or
        //      after this chain's `D*`. A pre-arming delivery funds legacy
        //      schedule days, which the delivered-fresh bound does not
        //      govern; counting it would hand the chain headroom for payouts
        //      that bound never owed.
        //
        // Whatever is not counted is recorded, not discarded — see
        // `rewardBudgetFreshUncounted`. The two always sum to `freshLooking`,
        // so an operator can reconcile a chain's counted funding against what
        // Base actually sent without re-deriving anything.
        // #1566 closure 2 — the received side is VINTAGE-BLIND and
        // FRESH-ONLY: the authenticated fresh component of a delivery is
        // credited whatever days it funds, because the paid side now charges
        // legacy and armed outflows alike at the chokepoints, and a ledger
        // whose two sides count different nouns is the defect closure 2
        // exists to remove. Test 2 (armed-attributable days) is retired; test
        // 1 (composition known) is unchanged — an old-wire packet still
        // arrives with `freshShare = 0` and lands whole in `uncounted`, which
        // the cutover epoch (closure 2, second PR) reconciles.
        // #1566 closure 2 cutover PR 1 — the packet under its ingress stamp,
        // recorded BEFORE any share moves so the record describes the
        // whole landing (a replayed stamp, or a second packet for a receipt
        // already delivered, refuses whole).
        bytes32 h = LibRewardCustody.callRecordIngressPacket(
            sourceChainId,
            transportMessageId,
            LibRewardCustody.PACKET_KIND_BUDGET,
            amount,
            freshShare,
            recycledShare,
            remitter,
            remitId
        );
        // #1566 transport epochs PR 3a — the day-list commitment, in the same
        // transaction as the record: the transport epochs' compact admission
        // materializes this batch's membership against it, never against an
        // event, so a packet landing before that ledger exists is still
        // admissible on the strength of the chain's own record.
        LibRewardCustody.stampPacketDayList(s, h, dayIds);
        // #1566 transport epochs PR 3b — the UNTYPED delivery opens its
        // transport epoch here, in the same transaction as the record and the
        // commitment, so the obligations it names can reach it and nothing
        // else can. A typed delivery opens none: its components are credited
        // to the shared ledgers immediately below, and a batch as well would
        // make one delivery spendable twice (§5c's one-accounting-path rule).
        //
        // Deliberately BEFORE the credits rather than after: the admission is
        // the only step that can refuse for a reason the credits would not
        // (an unknown packet), and a refusal must leave no half-credited
        // delivery behind.
        uint256 counted = freshShare;
        // #1566 slice 4 PR B — on an activated deployment the counted fresh
        // share is RELOCATED from this balance into the holder and credited
        // under the §5c deficit split (live-fresh, or restitution for the
        // part that only closes a deficit). The uncounted remainder is
        // recorded as before and, since closure 2's cutover PR 1, protected
        // into the holder's `Unclassified` row below.
        if (counted != 0) {
            if (LibRewardCustody.active(s)) LibRewardCustody.callRelocateFreshIngress(counted);
            else s.rewardBudgetArmedFreshReceived += counted;
        }
        if (freshLooking > counted) {
            uint256 remainder = freshLooking - counted;
            s.rewardBudgetFreshUncounted += remainder;
            // #1566 closure 2 cutover PR 1 — PROTECTED AT INGRESS on an
            // activated deployment: the untyped remainder is relocated
            // (measured) into the holder's `Unclassified` row the moment it
            // lands, instead of resting in the shared balance where a later
            // relocation could move another owner's tokens (design §5c).
            if (LibRewardCustody.active(s)) {
                LibRewardCustody.callUnclassifiedIngress(h, remainder);
                // #1566 transport epochs PR 3b — the TRANSPORT EPOCH is opened
                // HERE, under the same condition and from the same amount as
                // the protection above, and only for an untyped wire (Codex
                // #2232 r1).
                //
                // One condition, because the epoch and the protection are two
                // views of ONE value: what the delivery's own days may draw,
                // and what a reconciliation may later classify. An earlier
                // revision admitted the epoch unconditionally, so a delivery
                // landing on a configured-but-not-yet-ACTIVATED mirror got an
                // epoch reporting the full balance while the packet's
                // `unclassified` figure stayed zero — its tokens are
                // Diamond-side until activation, and the activation envelope
                // can move them into shared recycled backing. That is two
                // claims on one amount, and no arithmetic downstream could
                // have reconciled them.
                //
                // A pre-activation delivery therefore keeps `batchId == 0` and
                // behaves exactly as every pre-3b arrival does: its value is
                // Diamond-side, the epoch gate does not concern it, and the
                // activation envelope is what attributes it. `freshShare` is
                // bounded by `freshLooking` above, so the subtraction cannot
                // underflow, and this branch is only reached when the
                // remainder is non-zero.
                if (!splitTyped) {
                    LibRewardCustody.admitTransportBatch(s, h, dayIds, remainder);
                }
            }
        }
        // #1222 M3 B2-d5 — the RECYCLED component of this delivery is
        // RELOCATED CUSTODY: the tokens are physically here and the claim
        // path will debit the bucket for the WHOLE recycled payout
        // (`RewardClaimFacet` → `consume(paidRecycled)`, no funding-source
        // split), so without this credit a Base-funded top-up would be
        // consumed against a bucket that never held it — flooring the ledger
        // at zero and over-counting `paidOutRecycled`, which inflates the
        // DERIVED `creditedCumulative` and reports Base's own tokens back as
        // this chain's absorption (Codex #1430 r3 F2).
        //
        // It is NOT absorption: {creditCustodyRelocated} keeps it out of the
        // Ā day-bucket AND out of the cumulative this chain reports to Base.
        // The guard against a malformed/hostile payload claiming more
        // recycled backing than actually arrived now runs at the TOP of this
        // function, alongside its fresh-share twin.
        LibVpfiRecycle.creditCustodyRelocated(
            remitId,
            recycledShare,
            LibVpfiRecycle.RecycleSource.RemittedCustodyRelocation
        );
        // r4 — receipts key by (remitter, remitId): `remitter` comes from
        // the remit PAYLOAD (immutable, messenger-authenticated message
        // data — never delivery-time channel config), so different
        // canonical deployments' same-numbered receipts CO-EXIST under
        // distinct keys — no collision, no supersession ordering. The
        // receipt itself is written by the packet record above
        // (`LibRewardCustody.recordIngressPacket`), ONCE per key: a second
        // packet for a delivered receipt refuses whole there (Codex #2198
        // r1 — the ingress used to keep the first receipt silently, on the
        // reasoning that CCIP executes a message once; the stamp guard
        // covers that case, the receipt guard covers a faulty remitter).
        emit RewardBudgetReceived(
            sourceChainId, token, amount, dayIds, remitId, recycledShare,
            freshShare
        );
    }

    // ─── #1434 P2-w2 — the classifying COMPENSATION ingress (§2.2) ────────

    /// @notice A P2 compensation was credited to a zeroed day's per-side
    ///         pools (payable at w3's repricing). `provisional` marks the
    ///         overtake case — the day's V3 broadcast had not landed, so
    ///         the payload's authenticated remitter stands as the assumed
    ///         era until the broadcast confirms or demotes it.
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
    ///         held (one provisional receipt binding per day), 5 = the day
    ///         is permanently V3-unhealable on this rotated mirror (prior
    ///         state, no recorded era — the confirm/demote hook could never
    ///         run), 6 = clockless payload (zero finalizedAt — an honest
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
    ///         day's V3 broadcast (matching era, day genuinely zeroed).
    /// @custom:event-category informational/reward-compensation
    event CompensationConfirmed(uint256 indexed dayId, address era);

    /// @notice A provisional compensation was DEMOTED to the
    ///         stranded-recovery reservation by the day's V3 broadcast
    ///         (era mismatch, or the day turned out not to be zeroed).
    /// @custom:event-category informational/reward-compensation
    event CompensationDemoted(
        uint256 indexed dayId, uint256 amount, uint8 reason
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
     *         cutover PR 1) — see {onRewardBudgetReceived}; the packet is
     *         recorded under its ingress stamp, and a quarantine lands in
     *         the holder's `Unclassified` row on an activated deployment.
     *         Not `whenNotPaused`, for the same migration-mode reason.
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
        {
            // #1566 transport epochs PR 3a — a compensation names ONE day; its
            // commitment is recorded exactly as a budget delivery's list is,
            // so no pre-d6 arrival is left without one.
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

        // Codex #1634 r1 — two arrivals that must NOT go provisional:
        //
        // (a) A day the w1 rotation gate has made permanently V3-unhealable
        //     (rotated mirror + prior state + no recorded era): its
        //     provisional credit could never reach the confirm/demote hook,
        //     leaving the value outside the reservation forever. Quarantine
        //     at ingress instead — the same three conjuncts the V3 ingress
        //     refuses on, threaded verbatim.
        if (
            s.rewardEraRotated && era == address(0)
                && (s.broadcastV2Applied[dayId] || s.knownGlobalSet[dayId])
        ) {
            _quarantineCompensation(s, h, dayId, remitter, remitId, amount, 5);
            return;
        }
        // (b) A SECOND compensation while one is already provisional: the
        //     day holds one provisional receipt binding (era + remitId),
        //     and overwriting it would demote BOTH packets' pools under the
        //     last receipt key — the receipt-bounded return could then
        //     recover at most that one reservation's entitlement, stranding
        //     the earlier packet. One provisional credit per day;
        //     conflicting arrivals hold their own receipt-keyed reservation
        //     until the day's broadcast settles which era governs.
        LibVaipakam.DayCompensation storage dcPrior = s.dayCompensation[dayId];
        if (dcPrior.provisional) {
            _quarantineCompensation(s, h, dayId, remitter, remitId, amount, 4);
            return;
        }
        // (c) A CLOCKLESS payload (zero finalizedAt) cannot settle: an
        //     honest Base refuses such a dispatch outright (#1634 r2 —
        //     {CompensationDayHasNoClock}), so one arriving here is stale
        //     or hostile, and a provisional credit for it would wait on a
        //     V3 broadcast that can never carry a matching clock. The
        //     token-safe mirror of the Base-side refusal (reason 6).
        if (finalizedAt == 0) {
            _quarantineCompensation(s, h, dayId, remitter, remitId, amount, 6);
            return;
        }
        // (d) The overtake case can still be PAST ITS TRUE EXPIRY: the wire
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

    /// @dev Credit the per-side pools (+ the armed-fresh counter when the
    ///      day is armed-attributable), recording what was counted so a
    ///      later demotion can move exactly that.
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
        // authenticated fresh component, and it is credited whatever the
        // day's vintage. `armedFreshCounted` records exactly what this credit
        // added, which is exactly what a later demotion removes: the two are
        // inverses by construction rather than by a matching day test.
        // #1566 slice 4 PR B — see {onRewardBudgetReceived}: relocated into
        // the holder under the deficit split on an activated deployment.
        if (LibRewardCustody.active(s)) LibRewardCustody.callRelocateFreshIngress(amount);
        else s.rewardBudgetArmedFreshReceived += amount;
        dc.armedFreshCounted += SafeCast.toUint128(amount);
        emit CompensationCredited(
            dayId, lenderShare18, borrowerShare18, provisional, era
        );
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
            // #1566 closure 2 — confirmation PROMOTES NOTHING. The #1634 r3
            // reclassification that stood here moved a credit from
            // `uncounted` into `received` when the day turned out to be
            // armed; under the vintage-blind rule the provisional credit was
            // counted in full at ingress, so there is nothing left to
            // promote, and a promotion that re-added it would manufacture
            // headroom no delivery backs. Confirmation clears the
            // provisional flag and its receipt; demotion alone reverses the
            // original credit, by exactly `armedFreshCounted`.
            emit CompensationConfirmed(dayId, baseDeployment);
            return;
        }
        // Demote: era mismatch (2) or the day was never zeroed (1). The
        // reservation takes the CREDITED amount, wholesale (#1634 r3) —
        // the pool sum can floor a wei below it on a scaled delivery, and
        // the design promises the demotion moves the arrival, not the sum.
        uint8 reason = dc.provisionalEra == baseDeployment ? 1 : 2;
        uint256 pools = dc.creditedAmount;
        uint256 counted = dc.armedFreshCounted;
        s.strandedRecoveryReserved += pools;
        // Move the counted portion back to uncounted so the
        // counted + uncounted reconciliation identity holds.
        if (counted != 0) {
            // #1566 slice 4 PR B — on an activated deployment the credit is
            // reversed through the custody seam: the received side unwinds
            // (saturating, as before) and what the live-fresh and
            // restitution rows still hold of it is re-attributed IN-HOLDER
            // into `Unclassified`, where the R4 return draws it (closure 2
            // cutover PR 1; an earlier revision released it to this balance).
            if (LibRewardCustody.active(s)) {
                // #1566 closure 2 cutover PR 1 — the credit's remainder is
                // re-attributed IN-HOLDER (live first, then restitution)
                // into `Unclassified`, where the R4 return draws it; an
                // earlier revision released it to the Diamond's balance.
                bytes32 rKey = LibRewardCustody.remitReceiptKey(dc.provisionalEra, dc.remitId);
                LibRewardCustody.callUnclassifiedQuarantine(s.receivedRemits[rKey].packetHash, rKey, 0, counted);
            } else {
                uint256 af = s.rewardBudgetArmedFreshReceived;
                s.rewardBudgetArmedFreshReceived = af > counted ? af - counted : 0;
            }
            s.rewardBudgetFreshUncounted += counted;
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
        delete s.dayCompensation[dayId];
        // #1656 r1 - the demoted credit's receipt clocks go with it: a
        // later CURRENT-era compensation must get its own full bounded
        // window, not inherit a rejected packet's aged firstCompReceiptAt
        // (three windows past which it could be short-lapsed on arrival).
        delete s.firstCompReceiptAt[dayId];
        delete s.lastQualifyingCompReceiptAt[dayId];
        emit CompensationDemoted(dayId, pools, reason);
    }





    // #1566 closure 2 — `_armedAttributableDelivery` (#1434 P1-a) was
    // retired here: the received side no longer keys on whether every day a
    // delivery covers is at or after `D*`. Its conservative gap (a delivery
    // overtaking the arming broadcast counted as zero) no longer exists,
    // because vintage no longer decides what is counted.

    // ─── #1566 transport epochs PR 3a — the split attestation ingress ───────

    /**
     * @notice The SPLIT ATTESTATION ingress (called by the reward messenger
     *         after peer authentication): the canonical chain's recorded split
     *         of a d2 remittance this mirror received untyped, persisted once
     *         as the packet's two attested caps, each scaled to what landed.
     * @dev    Mirror-only, and gated on the messenger exactly as the ack
     *         ingress is. It lifts no classification bound by itself — the
     *         bound is derived from the caps at use time and the gate that
     *         admits them is the transport epochs' batch lifecycle (3b), so
     *         until that lands an attested packet classifies exactly as it did
     *         before. Every refusal is re-executable (the transport keeps the
     *         message failed) and the mirror accepts exactly one attestation
     *         per packet, so a repeat send is a retry lever, not a grief.
     */
    function onRemitSplitAttested(
        uint32 sourceChainId,
        address remitter,
        uint256 remitId,
        uint256 fresh,
        uint256 recycled
    ) external nonReentrant {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        if (msg.sender != s.rewardMessenger || s.rewardMessenger == address(0)) {
            revert NotAuthorizedRewardMessenger();
        }
        if (!LibVaipakam.isMirrorRewardChain(s)) revert OnlyMirrorRewardChain();
        LibRewardCustody.attestPacketSplit(s, sourceChainId, remitter, remitId, fresh, recycled);
    }

}
