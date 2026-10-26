// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

/// @notice #1222 M3 B2-b — one destination's flattened V2 broadcast
///         fields, nested verbatim as the head of every kind-10
///         {RewardBroadcastV3} payload. All-static struct on purpose: the
///         nested encoding is the flat field list, so `abi.encode(kind,
///         v3)` / `abi.decode(payload[32:], (RewardBroadcastV3))` stay
///         symmetric with no hand-maintained word list.
struct RewardBroadcastV2 {
    uint256 dayId;
    uint256 globalLenderNumeraire18;
    uint256 globalBorrowerNumeraire18;
    uint8 capMode;
    uint256 capPayloadLender;
    uint256 capPayloadBorrower;
    uint256 armedFromDay;
    uint256 freshLenderHalf;
    uint256 freshBorrowerHalf;
    uint256 recycledLenderHalfEquiv;
    uint256 recycledBorrowerHalfEquiv;
    uint256 recycleConsume;
    uint256 keeperAllocate;
    uint256 destChainId;
}

/// @notice A mirror's closed-day REPORT to the canonical chain — the ONE
///         report shape (#2621). Encoded on the kind-1 wire as
///         `abi.encode(uint8 kind, ChainDayReport)` and delivered whole to
///         `RewardAggregatorFacet.onChainReportReceived`. All-static on purpose,
///         like {RewardBroadcastV2}: encode and decode stay symmetric with no
///         hand-maintained word list.
/// @dev Day figures (`lender`, `borrower`, `recycledForDay18`) describe the
///      reporter's day `dayId` and count toward Base's day `dayId` only when the
///      two chains run the same reward clock. The rest describe the chain, not
///      the day, and apply whenever the report is authenticated.
struct ChainDayReport {
    /// Interaction day being reported, on the reporter's clock.
    uint256 dayId;
    /// This chain's lender interest for `dayId`, Numeraire18.
    uint256 lenderNumeraire18;
    /// This chain's borrower interest for `dayId`, Numeraire18.
    uint256 borrowerNumeraire18;
    /// Monotonic cumulative recycle-bucket credits (Base's availability ledger).
    uint256 recycledCumulative18;
    /// The recycle credit this chain claims for `dayId` (`Ā` attribution).
    uint256 recycledForDay18;
    /// Σ of every decrement of this chain's outstanding recycled commitments.
    uint256 commitRetiredCumulative18;
    /// The release-only subset of `commitRetiredCumulative18`.
    uint256 commitReleasedCumulative18;
    /// This chain's live custody era (#1566 PR C).
    uint64 custodyEra;
    /// This chain's `interactionLaunchTimestamp` — the reward clock its day
    /// numbers count from (#2620). Base counts the day figures only when it
    /// equals its own.
    uint256 rewardLaunchTimestamp;
}

/// @notice Base-side Diamond ingress for an inbound {ChainDayReport}
///         (`RewardAggregatorFacet.onChainReportReceived`).
interface IRewardAggregatorIngress {
    function onChainReportReceived(uint32 sourceChainId, ChainDayReport calldata report) external;
}

/// @notice #1434 P2-w1 — one destination's V3 broadcast as encoded on the
///         kind-10 wire (after the `uint8` kind tag) — the ONE broadcast
///         shape (#1944; kinds 2 and 5 are retired and never reused).
/// @dev    Nests the V2 struct VERBATIM rather than flattening: the encoded
///         layout of a static nested struct is identical to the flat field
///         list, and the nesting lets the mirror ingress hand `v2` straight
///         to the shared V2 apply core — no hand-transcribed field mapping
///         to drift. The six appended fields are the P2 day-clock facts,
///         all FROZEN at Base finalization (never read live at send) so
///         every re-broadcast of a day is byte-identical by construction
///         (R2a).
struct RewardBroadcastV3 {
    RewardBroadcastV2 v2;
    // Base's block.timestamp at `_finalizeAndWrite` — the authenticated
    // clock every P2 lapse/pricing machine gates on. Never zero on the
    // wire: finalization freezes it in the same call that marks the day
    // finalized, and only a finalized day is broadcast.
    uint64 finalizedAt;
    // The lapse-schedule version the day's clocks are evaluated under
    // (0 = frozen before any schedule was set — not lapse-eligible).
    uint32 lapseScheduleVersion;
    // The versioned parameter pair, inline (design §1.2 implementer pick):
    // both domains derive the same expiry from the same frozen words.
    uint64 lapseWindowSeconds;
    uint64 dispatchCutoffGap;
    // The R1 zeroed marker for THIS destination, frozen at finalization
    // (the live `remitIneligible` flag is operator-clearable).
    bool zeroedForDest;
    // The sending deployment's identity (§2h constraint 20 era binding),
    // stamped by the messenger from its own Diamond binding.
    address baseDeployment;
    // #1636 r2 — the DAY-LEVEL funded pool halves frozen at finalization
    // (Base's `dayPoolStamp` figures). The Δq quote numerator: a zeroed
    // destination's own per-chain slice is deliberately zero, so the
    // day-level figure must travel.
    uint256 dayScheduleFloorHalf;
    uint256 dayRecycledBudgetHalf;
}

/// @notice #1434 P2-w3 — Base-side Diamond ingress for an inbound mirror
///         compensation QUOTE (`RewardCommitmentFacet.onCompQuoteReceived`):
///         the zeroed chain's authenticated per-side counterfactual fair
///         share — evidence the manual compensation dispatch is bounded by.
interface ICompQuoteIngress {
    function onCompQuoteReceived(
        uint32 sourceChainId,
        uint256 dayId,
        uint256 quotedLender18,
        uint256 quotedBorrower18,
        // #1636 r1 — the sending mirror Diamond, stamped by the messenger
        // from its own binding (the reciprocal of `baseDeployment` above):
        // Base binds the standing quote to it and rejects divergent
        // re-deliveries.
        address sourceEra
    ) external;
}

/// @notice #1434 P2-w1 — mirror-side Diamond ingress for an inbound V3
///         broadcast (`RewardReporterFacet.onRewardBroadcastV3Received`).
interface IRewardReporterIngressV3 {
    function onRewardBroadcastV3Received(
        RewardBroadcastV3 calldata b
    ) external;
}

/// @notice #1222 M3 B2-d1 — Base-side Diamond ingress for an inbound mirror→Base
///         commitment REPORT (`RewardAggregatorFacet.onCommitmentReportReceived`).
///         Delivers a mirror's day-`D` per-side claimable-liability aggregate,
///         which marks the chain-day report-complete
///         (`ChainDayCommitments.complete` — the B2-d2 remit gate).
interface IRewardCommitmentIngress {
    function onCommitmentReportReceived(
        uint32 sourceChainId,
        uint256 dayId,
        uint256 liabilityLender18,
        uint256 liabilityBorrower18
    ) external;
}

/// @notice #1222 M3 B2-d2 — Base-side Diamond ingress for an inbound
///         mirror→Base remit ACK
///         (`RewardRemittanceFacet.onRemitAckReceived`). Finalizes the
///         echoed `remitId`'s delivered-backing reservation exactly once
///         (idempotent on re-delivery; a Released reservation's late ack is
///         surfaced, never re-finalized).
interface IRewardRemitAckIngress {
    function onRemitAckReceived(
        uint32 sourceChainId,
        uint256 remitId,
        uint256 amountReceived,
        address remitter,
        uint8 classification
    ) external;
}

/**
 * @title IRewardMessenger
 * @author Vaipakam Developer Team
 * @notice Sender-side interface the Vaipakam Diamond calls on the
 *         dedicated cross-chain messenger (`VaipakamRewardMessenger`) to
 *         push reward-accounting messages between Base (canonical chain)
 *         and the mirror chains.
 *
 * @dev Post-T-068 the cross-chain transport is **Chainlink CCIP** — the
 *      messenger composes CCIP `EVM2AnyMessage`s and routes via the
 *      `CcipMessenger` channel registered for the reward flow. Pre-T-068
 *      this same interface fronted a LayerZero OApp; that's why the
 *      method names (`sendChainReport`, `broadcastGlobal`) read like a
 *      generic messenger surface rather than CCIP-specific. The
 *      implementation chose to keep the interface stable across the
 *      LayerZero → CCIP migration so the calling facets
 *      (`RewardReporterFacet`, `RewardAggregatorFacet`) didn't churn.
 *
 *      The interface used to be named `IRewardOApp` (LayerZero
 *      terminology). Renamed in #181 to remove the misleading
 *      transport-layer association; the implementation has been CCIP
 *      since T-068 (April 2026).
 *
 * @dev Two message kinds flow through this interface:
 *        1. **Mirror → Base** (daily chain report): each mirror chain's
 *           daily lender + borrower Numeraire18 totals for `dayId`.
 *           Emitted by `RewardReporterFacet.closeDay` on non-canonical
 *           chains.
 *        2. **Base → mirrors** (global denominator broadcast):
 *           finalized protocol-wide lender + borrower denominators for
 *           `dayId` so mirror-side claims can apply the §4 formula
 *           against the live aggregate. Emitted by
 *           `RewardBroadcastFacet.broadcastGlobal`.
 *
 *      Complementary ingress methods on the Diamond side
 *      (`RewardAggregatorFacet.onChainReportReceived` and
 *      `RewardReporterFacet.onRewardBroadcastV3Received`) are gated to
 *      the Diamond's registered messenger address — wire the two
 *      proxies (Diamond ↔ messenger) once, trust is pinned for the
 *      life of the deployment.
 *
 *      See `docs/DesignsAndPlans/LayerZeroToChainlinkCcipMigration.md`
 *      for the migration rationale.
 */
interface IRewardMessenger {
    /**
     * @notice Send a closed-day {ChainDayReport} to the canonical (Base)
     *         reward messenger — the one report shape (#2621).
     * @dev Callable only by the Diamond that owns this messenger. Reverts if
     *      `msg.value` doesn't cover the CCIP native fee (quote first via
     *      {quoteSendChainReport}); the remainder returns to `refundAddress`.
     *
     *      `destChainId` is the Base the CALLER means — the Diamond's own
     *      `baseChainId`. The messenger sends only if it equals its own
     *      `baseChainId`, so the two settings can never disagree silently: a
     *      mismatch, or a messenger rotated in between a caller's read and its
     *      send, reverts the whole close instead of stamping a day sent along
     *      a route that does not reach that Base.
     * @param destChainId   The chain the caller expects the report to reach.
     * @param report        The day's report, built by `closeDay`.
     * @param refundAddress Address that receives leftover CCIP fee.
     */
    function sendChainReport(
        uint256 destChainId,
        ChainDayReport calldata report,
        address payable refundAddress
    ) external payable;

    /// @notice Quote the native CCIP fee for {sendChainReport}. The payload is
    ///         fixed-width, so any figures price the bytes a real report
    ///         sends. Refuses a `destChainId` other than this messenger's
    ///         `baseChainId`, exactly as the send does.
    /// @return nativeFee Wei of native gas token required on msg.value.
    function quoteSendChainReport(
        uint256 destChainId,
        ChainDayReport calldata report
    ) external view returns (uint256 nativeFee);

    // ─── #1222 M3 B2-d1 — mirror → Base commitment report ───────────────────

    /// @notice Send a day-`D` commitment REPORT from a mirror to the canonical
    ///         (Base) reward messenger: this chain's per-side claimable-liability
    ///         aggregate, which lights the Base remit gate for this chain-day.
    /// @dev Callable only by the Diamond that owns this messenger, and only from
    ///      a mirror (the Diamond enforces the mirror-only precondition). Reverts
    ///      if `msg.value` doesn't cover the CCIP native fee — quote first via
    ///      {quoteSendCommitmentReport}.
    /// @param dayId               Elapsed interaction day being committed.
    /// @param liabilityLender18   This chain's lender-side day-`D` liability (1e18).
    /// @param liabilityBorrower18 This chain's borrower-side day-`D` liability (1e18).
    /// @param refundAddress       Address that receives leftover CCIP fee.
    function sendCommitmentReport(
        uint256 dayId,
        uint256 liabilityLender18,
        uint256 liabilityBorrower18,
        address payable refundAddress
    ) external payable returns (bytes32 messageId);

    /// @notice Quote the native CCIP fee for a mirror→Base commitment report.
    function quoteSendCommitmentReport(
        uint256 dayId,
        uint256 liabilityLender18,
        uint256 liabilityBorrower18
    ) external view returns (uint256 nativeFee);

    // ─── #1222 M3 B2-d2 — mirror → Base remit ack ───────────────────────────

    /// @notice Send a delivered-remittance ACK from a mirror to the canonical
    ///         (Base) reward messenger: echoes the `remitId` a delivered
    ///         reward-budget remittance carried, finalizing Base's
    ///         delivered-backing reservation.
    /// @dev Callable only by the Diamond that owns this messenger, and only
    ///      from a mirror (the Diamond enforces the mirror-only precondition
    ///      and computes the content from its own receipt record). Reverts if
    ///      `msg.value` doesn't cover the CCIP native fee — quote first via
    ///      {quoteSendRemitAck}. Deliberately re-sendable: a lost ack is
    ///      retried by re-calling; Base finalizes exactly once.
    /// @param remitId        The Base-generated reservation id being acked.
    /// @param amountReceived The VPFI the mirror Diamond actually received.
    /// @param refundAddress  Address that receives leftover CCIP fee.
    /// @param remitter The sending DEPLOYMENT's identity recorded on the
    ///                  mirror's receipt from the remit payload (Codex #1426
    ///                  r3/r4 — immutable message data, never delivery-time
    ///                  channel config): echoed on the wire so the canonical
    ///                  ingress accepts only acks that name ITSELF — remit
    ///                  ids are per-deployment and a stale-era receipt must
    ///                  never finalize a same-numbered reservation on a
    ///                  rotated deployment.
    function sendRemitAck(
        uint256 remitId,
        uint256 amountReceived,
        address remitter,
        uint8 classification,
        address payable refundAddress
    ) external payable returns (bytes32 messageId);

    /// @notice Quote the native CCIP fee for a mirror→Base remit ack.
    function quoteSendRemitAck(
        uint256 remitId,
        uint256 amountReceived,
        address remitter
    ) external view returns (uint256 nativeFee);

    // ─── #1222 M3 B2-b — the per-destination V2 fields kind 10 nests ────────

    /// @notice The day-shared V2 fields of a broadcast — identical for every
    ///         destination.
    /// @dev `capMode` mirrors `LibVaipakam.CapMode` (0 = LegacyEthRatio,
    ///      1 = ShareOfPool). Legacy mode: `capPayloadLender` carries the
    ///      §4 threshold, `capPayloadBorrower` is 0. ShareOfPool mode: the
    ///      two payloads are the day's per-SIDE D1 ceilings, computed on
    ///      Base from the GLOBAL figures and applied verbatim by mirrors
    ///      (never recomputed — config drift).
    struct BroadcastV2Shared {
        uint256 dayId;
        uint256 globalLenderNumeraire18;
        uint256 globalBorrowerNumeraire18;
        uint8 capMode;
        uint256 capPayloadLender;
        uint256 capPayloadBorrower;
        uint256 armedFromDay;
    }

    /// @notice One destination's funded V2 figures.
    /// @dev All value fields uint256 on purpose (plan §M3 storage-width
    ///      rule — the global-equivalent halves can legitimately dwarf the
    ///      daily pool on thin chains). `destChainId` is embedded in the
    ///      payload as the replay-stable binding: the mirror rejects any
    ///      packet whose `destChainId != block.chainid`, so positional
    ///      alignment to the mutable destination list is never relied on.
    struct BroadcastV2PerDest {
        uint256 destChainId;
        uint256 freshLenderHalf;
        uint256 freshBorrowerHalf;
        uint256 recycledLenderHalfEquiv;
        uint256 recycledBorrowerHalfEquiv;
        uint256 recycleConsume;
        uint256 keeperAllocate;
    }

    /// @notice The configured broadcast destination chain ids — read by the
    ///         broadcast facet to assemble the per-destination array.
    function getBroadcastDestinations()
        external
        view
        returns (uint256[] memory);

    // ─── #1434 P2-w1 — per-destination broadcast V3 (kind-10) ───────────────

    /// @notice The day-shared P2 clock facts of a V3 broadcast — identical
    ///         for every destination, all frozen at Base finalization.
    ///         `baseDeployment` is deliberately absent: the messenger stamps
    ///         it from its own Diamond binding so a caller bug can never
    ///         mislabel the sending era.
    struct BroadcastV3Extras {
        uint64 finalizedAt;
        uint32 lapseScheduleVersion;
        uint64 lapseWindowSeconds;
        uint64 dispatchCutoffGap;
        // #1636 r2 — day-level funded pool halves (the Δq numerator
        // transport; see {RewardBroadcastV3}).
        uint256 dayScheduleFloorHalf;
        uint256 dayRecycledBudgetHalf;
    }

    /// @notice One destination's V3 figures: the V2 per-destination fields
    ///         plus the destination's frozen R1 zeroed marker. The marker
    ///         rides INSIDE the per-destination struct (not a parallel
    ///         array) so it stays bound to `base.destChainId` under the
    ///         order-free destination matching.
    struct BroadcastV3PerDest {
        BroadcastV2PerDest base;
        bool zeroedForDest;
    }

    /// @notice Broadcast day `shared.dayId` as one kind-10 payload per
    ///         configured destination — the V2 fields plus the frozen P2
    ///         day-clock facts.
    /// @dev Diamond-only. `dests` must cover the messenger's configured
    ///      destination set exactly (matched by chain id, order-free).
    ///      `msg.value` must cover the SUM of per-lane quotes; the
    ///      remainder refunds.
    function broadcastDayV3(
        BroadcastV2Shared calldata shared,
        BroadcastV3Extras calldata extras,
        BroadcastV3PerDest[] calldata dests,
        address payable refundAddress
    ) external payable;

    /// @notice Quote the native CCIP fee SUM for a {broadcastDayV3}.
    function quoteBroadcastDayV3(
        BroadcastV2Shared calldata shared,
        BroadcastV3Extras calldata extras,
        BroadcastV3PerDest[] calldata dests
    ) external view returns (uint256 nativeFee);

    /// @notice Send day `shared.dayId` as ONE kind-10 payload to
    ///         `dest.base.destChainId` only — the single-destination heal
    ///         path (`RewardBroadcastFacet.broadcastGlobalTo`). Deliberately
    ///         exempt from the configured-set coverage rule: a mirror
    ///         removed from the destination list after a day finalized must
    ///         remain reachable for that day (design §1.1). The lane itself must still exist on the underlying
    ///         CCIP messenger — a torn-down lane reverts there.
    function broadcastDayV3Single(
        BroadcastV2Shared calldata shared,
        BroadcastV3Extras calldata extras,
        BroadcastV3PerDest calldata dest,
        address payable refundAddress
    ) external payable returns (bytes32 messageId);

    /// @notice Quote the native CCIP fee for a {broadcastDayV3Single}.
    function quoteBroadcastDayV3Single(
        BroadcastV2Shared calldata shared,
        BroadcastV3Extras calldata extras,
        BroadcastV3PerDest calldata dest
    ) external view returns (uint256 nativeFee);

    // ─── #1434 P2-w3 — mirror → Base compensation quote (kind 11) ───────────

    /// @notice Send a mirror's zeroed-day compensation QUOTE to Base
    ///         (§1.4): the authenticated per-side counterfactual fair
    ///         share — evidence bounding the manual compensation, never
    ///         funding. Diamond-only; re-sendable idempotently.
    function sendCompQuote(
        uint256 dayId,
        uint256 quotedLender18,
        uint256 quotedBorrower18,
        address payable refundAddress
    ) external payable returns (bytes32 messageId);

    /// @notice Quote the native CCIP fee for a {sendCompQuote}.
    function quoteSendCompQuote(
        uint256 dayId,
        uint256 quotedLender18,
        uint256 quotedBorrower18
    ) external view returns (uint256 nativeFee);
}
