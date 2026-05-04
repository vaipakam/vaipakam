// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

/**
 * @title IRewardOApp
 * @author Vaipakam Developer Team
 * @notice Sender-side interface that the Vaipakam Diamond calls on the
 *         dedicated LayerZero OApp (VaipakamRewardOApp) to push cross-chain
 *         reward messages (spec §4a).
 *
 * @dev Two message kinds flow through this interface:
 *        1. Mirror → Base: daily chain interest report carrying the mirror's
 *           local lender + borrower Numeraire18 totals for day `dayId`. Emitted
 *           by `RewardReporterFacet.closeDay` on non-canonical chains.
 *        2. Base → mirrors: finalized global denominator broadcast so
 *           mirror-side claims can use the protocol-wide denominator in
 *           the §4 formula. Emitted by `RewardAggregatorFacet.broadcastGlobal`.
 *
 *      The complementary ingress methods on the Diamond side
 *      (`RewardAggregatorFacet.onChainReportReceived` and
 *      `RewardReporterFacet.onRewardBroadcastReceived`) are gated to the
 *      Diamond's registered `rewardOApp` address — wire the two proxies
 *      (Diamond ↔ OApp) once, trust is pinned for the life of the
 *      deployment.
 */
interface IRewardOApp {
    /**
     * @notice Send a day-close chain report to the canonical (Base)
     *         VaipakamRewardOApp.
     * @dev Callable only by the Diamond that owns this OApp. The OApp
     *      composes a LayerZero packet with `(dayId, lenderNumeraire18,
     *      borrowerNumeraire18)` and the source eid derived from its own
     *      `endpoint.eid()` on delivery. Reverts if not enough ETH was
     *      forwarded for the LayerZero native fee; the caller should
     *      quote first via {quoteSendChainReport}.
     * @param dayId            Elapsed interaction day being reported.
     * @param lenderNumeraire18      This-chain lender USD-18 interest on `dayId`.
     * @param borrowerNumeraire18    This-chain borrower USD-18 interest on `dayId`.
     * @param refundAddress    Address that receives leftover LZ fee.
     */
    function sendChainReport(
        uint256 dayId,
        uint256 lenderNumeraire18,
        uint256 borrowerNumeraire18,
        address payable refundAddress
    ) external payable;

    /**
     * @notice Broadcast the finalized global lender+borrower Numeraire18
     *         denominator for `dayId` to every mirror chain.
     * @dev Callable only by the Diamond. The OApp iterates its
     *      peer-registered mirror eids and composes one LayerZero packet
     *      per destination. `msg.value` must cover the SUM of all
     *      per-destination native fees — the caller should quote first
     *      via {quoteBroadcastGlobal}.
     * @param dayId                     Day being broadcast.
     * @param globalLenderNumeraire18         Finalized global lender denominator.
     * @param globalBorrowerNumeraire18       Finalized global borrower denominator.
     * @param refundAddress             Address that receives leftover LZ fee.
     */
    function broadcastGlobal(
        uint256 dayId,
        uint256 globalLenderNumeraire18,
        uint256 globalBorrowerNumeraire18,
        address payable refundAddress
    ) external payable;

    /// @notice Quote the native LZ fee for a single mirror→Base chain report.
    /// @param dayId         Day id the report is for (kept to forward-proof
    ///                      enforced-options keyed on dayId ranges, even if
    ///                      today's implementation ignores it).
    /// @param lenderNumeraire18   Lender USD-18 total that will be sent.
    /// @param borrowerNumeraire18 Borrower USD-18 total that will be sent.
    /// @return nativeFee    Wei of native gas token required on msg.value.
    function quoteSendChainReport(
        uint256 dayId,
        uint256 lenderNumeraire18,
        uint256 borrowerNumeraire18
    ) external view returns (uint256 nativeFee);

    /// @notice Quote the native LZ fee SUM for a Base→mirrors broadcast.
    /// @param dayId               Day being broadcast.
    /// @param globalLenderNumeraire18   Finalized global lender denominator.
    /// @param globalBorrowerNumeraire18 Finalized global borrower denominator.
    /// @return nativeFee          Total wei required on msg.value.
    function quoteBroadcastGlobal(
        uint256 dayId,
        uint256 globalLenderNumeraire18,
        uint256 globalBorrowerNumeraire18
    ) external view returns (uint256 nativeFee);
}
