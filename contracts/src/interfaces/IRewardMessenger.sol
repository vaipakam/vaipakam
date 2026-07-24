// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

/// @notice #1222 M3 B2-b — one destination's flattened V2 broadcast, as
///         encoded on the kind-5 wire (after the `uint8` kind tag) and as
///         delivered to the mirror Diamond ingress. All-static struct on
///         purpose: `abi.encode(kind, struct)` / `abi.decode(payload[32:],
///         (RewardBroadcastV2))` keep the encode/decode symmetric with no
///         hand-maintained word list.
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

/// @notice #1222 M3 B2-b — mirror-side Diamond ingress for an inbound V2
///         broadcast (`RewardReporterFacet.onRewardBroadcastV2Received`).
interface IRewardReporterIngressV2 {
    function onRewardBroadcastV2Received(
        RewardBroadcastV2 calldata b
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
 *           `RewardAggregatorFacet.broadcastGlobal`.
 *
 *      Complementary ingress methods on the Diamond side
 *      (`RewardAggregatorFacet.onChainReportReceived` and
 *      `RewardReporterFacet.onRewardBroadcastReceived`) are gated to
 *      the Diamond's registered messenger address — wire the two
 *      proxies (Diamond ↔ messenger) once, trust is pinned for the
 *      life of the deployment.
 *
 *      See `docs/DesignsAndPlans/LayerZeroToChainlinkCcipMigration.md`
 *      for the migration rationale.
 */
interface IRewardMessenger {
    /**
     * @notice Send a day-close chain report to the canonical (Base)
     *         reward messenger.
     * @dev Callable only by the Diamond that owns this messenger. The
     *      messenger composes a CCIP `EVM2AnyMessage` carrying
     *      `(dayId, lenderNumeraire18, borrowerNumeraire18)` plus the
     *      source chain selector derived from its own
     *      `getCurrentChainSelector()`. Reverts if `msg.value` doesn't
     *      cover the CCIP native fee; the caller should quote first
     *      via {quoteSendChainReport}.
     * @param dayId            Elapsed interaction day being reported.
     * @param lenderNumeraire18      This-chain lender USD-18 interest on `dayId`.
     * @param borrowerNumeraire18    This-chain borrower USD-18 interest on `dayId`.
     * @param refundAddress    Address that receives leftover CCIP fee.
     */
    function sendChainReport(
        uint256 dayId,
        uint256 lenderNumeraire18,
        uint256 borrowerNumeraire18,
        uint256 recycledCumulative18,
        uint256 recycledForDay18,
        address payable refundAddress
    ) external payable;

    /**
     * @notice Broadcast the finalized global lender+borrower Numeraire18
     *         denominator for `dayId` to every mirror chain.
     * @dev Callable only by the Diamond. The messenger iterates its
     *      configured broadcast destinations and composes one CCIP
     *      message per destination chain. `msg.value` must cover the
     *      SUM of all per-destination native fees — the caller should
     *      quote first via {quoteBroadcastGlobal}.
     * @param dayId                     Day being broadcast.
     * @param globalLenderNumeraire18         Finalized global lender denominator.
     * @param globalBorrowerNumeraire18       Finalized global borrower denominator.
     * @param capThreshold18            #1008 (S13) canonical §4 cap threshold `T_d`
     *                                  snapshotted on Base at finalization, so
     *                                  every mirror caps identically.
     * @param refundAddress             Address that receives leftover CCIP fee.
     */
    function broadcastGlobal(
        uint256 dayId,
        uint256 globalLenderNumeraire18,
        uint256 globalBorrowerNumeraire18,
        uint256 capThreshold18,
        uint256 scheduleFloorHalf,
        uint256 recycledHalf,
        uint256 armedFromDay,
        address payable refundAddress
    ) external payable;

    /// @notice Quote the native CCIP fee for a single mirror→Base chain report.
    /// @param dayId         Day id the report is for (kept to forward-proof
    ///                      enforced-options keyed on dayId ranges, even if
    ///                      today's implementation ignores it).
    /// @param lenderNumeraire18   Lender USD-18 total that will be sent.
    /// @param borrowerNumeraire18 Borrower USD-18 total that will be sent.
    /// @return nativeFee    Wei of native gas token required on msg.value.
    function quoteSendChainReport(
        uint256 dayId,
        uint256 lenderNumeraire18,
        uint256 borrowerNumeraire18,
        uint256 recycledCumulative18,
        uint256 recycledForDay18
    ) external view returns (uint256 nativeFee);

    /// @notice Quote the native CCIP fee SUM for a Base→mirrors broadcast.
    /// @param dayId               Day being broadcast.
    /// @param globalLenderNumeraire18   Finalized global lender denominator.
    /// @param globalBorrowerNumeraire18 Finalized global borrower denominator.
    /// @return nativeFee          Total wei required on msg.value.
    function quoteBroadcastGlobal(
        uint256 dayId,
        uint256 globalLenderNumeraire18,
        uint256 globalBorrowerNumeraire18
    ) external view returns (uint256 nativeFee);

    // ─── #1222 M3 B2-b — per-destination broadcast V2 ───────────────────────

    /// @notice The day-shared half of a V2 broadcast — identical for every
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

    /// @notice One destination's funded figures for a V2 broadcast.
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

    /// @notice Broadcast day `shared.dayId` with PER-DESTINATION funded
    ///         figures — one kind-5 CCIP payload per configured mirror,
    ///         each carrying that chain's own values (a shared payload
    ///         would have every mirror accruing against the same halves
    ///         even when a chain's slice was trimmed).
    /// @dev Diamond-only. `dests` must cover the messenger's configured
    ///      destination set exactly (matched by chain id, order-free).
    ///      `msg.value` must cover the SUM of per-lane quotes; the
    ///      remainder refunds.
    function broadcastDayV2(
        BroadcastV2Shared calldata shared,
        BroadcastV2PerDest[] calldata dests,
        address payable refundAddress
    ) external payable;

    /// @notice Quote the native CCIP fee SUM for a {broadcastDayV2}.
    function quoteBroadcastDayV2(
        BroadcastV2Shared calldata shared,
        BroadcastV2PerDest[] calldata dests
    ) external view returns (uint256 nativeFee);

    /// @notice The configured broadcast destination chain ids — read by the
    ///         aggregator facet to assemble the per-destination array (and
    ///         used as the V2-capability probe: missing on a pre-B2-b
    ///         messenger proxy, so the facet falls back to the legacy
    ///         kind-2 send on the resulting empty revert).
    function getBroadcastDestinations()
        external
        view
        returns (uint256[] memory);
}
