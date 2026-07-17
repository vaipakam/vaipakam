# Governor PR-3c — implementation map (scouted 2026-07-17)

Working notes for the PR-3c build (dual accumulators + consume-at-claim +
source-split + composition broadcast + fail-closed arming). Spec anchors:
`VpfiRecyclingBalanceGovernorDesign.md` §3.1 :149-164 (dual accumulator),
§4 :303-320 (forfeit source split), §6 :467-474 + §8 :536-548 (composition
broadcast SHIPS IN A′; only mirror bucket custody/netting is B′-deferred),
§3.2 :212-219 (bucket debited pro-rata at claim, not at finalize).
Cutover pattern: `VpfiAbsorptionDistributionFormulaRedesign.md` :1071-1081
(`postCutover(d) := armed != 0 && d >= armed`, NEVER `>=` alone; fail-closed
`DayCapModeUnsetPostCutover`; mixed windows day-slice across D*).

## Build list

1. **Storage (append)**: `cumFreshLenderRpn18` / `cumRecycledLenderRpn18`
   (+ borrower pair) per day; `paidOutFresh` / `paidOutRecycled`;
   (arming day `governorCommitArmedFromDay` exists from PR-3b).
2. **Accumulator build** `LibInteractionRewards.advanceCumLenderThrough`
   :624-660 / `advanceCumBorrowerThrough` :663-695: replace
   `half = halfPoolForDay(d)` (:640, :678) with the stamped halves
   (`dayPoolStamp[d].scheduleFloor/2` + `recycledBudget/2` per side) for
   armed days; **#1008 cap on COMBINED freshΔ+recycledΔ first** (:650-652
   pattern), trim apportioned pro-rata (spec :155-157).
3. **Claim split** `_processEntry` :1042-1064 + `_previewEntryReward`
   :1072-1094: reward = freshReward + recycledReward from the two capped
   accumulator deltas.
4. **Consume-at-claim** `InteractionRewardsFacet` :266 (claim) + :372
   (sweep): increment paidOutFresh/Recycled; decrement
   outstandingCommitFresh/Recycled; recycled payout also debits bucket via
   new `LibVpfiRecycle.debit` (ledger decrement paralleling the existing
   Diamond-balance transfer in `_deliverReward` :310-337).
5. **Forfeit source split** before the blanket credit at
   `InteractionRewardsFacet.sol:271` / `:374`: fresh share →
   `LibVpfiRecycle.credit(ForfeitedReward, …)` (real absorption, stays in
   paidOutFresh); recycled share → commitment RELEASE
   (outstandingCommitRecycled -= x, emit `RewardCommitmentReleased`,
   NEVER credit — LibVpfiRecycle header :39-44 reserves this).
6. **Composition broadcast**: `IRewardMessenger.broadcastGlobal` gains
   `scheduleFloorHalf` + `recycledHalf`; `VaipakamRewardMessenger`
   `BROADCAST_PAYLOAD_SIZE` 5→7 words (:116-122; REPORT stays 4);
   encode :400-406, quote :619-623, decode/forward :699-703;
   `RewardReporterFacet.onRewardBroadcastReceived` :235-272 writes the
   halves for mirror accumulators. Update `MockRewardMessenger`
   (:87-99, :143-151) + every caller test (RewardRemittanceFacetTest,
   CrossChainRewardPlumbing, CcipDeploymentRehearsal, VaipakamRewardFlow,
   GovernorDayPool, HelperTest).
7. **Remittance** `LibInteractionRewards.chainRewardBudgetForDay`
   :145-182 (reads halfPoolForDay at :150 — the doc-flagged underfunding
   site :544-546): armed days read the stamped halves.
8. **Fail-closed arming**: post-cutover claim/finalize/sweep REQUIRE armed
   data else revert; pre-cutover days keep legacy math; mixed windows
   day-slice across the arming day (redesign :1078 — the forfeit sweep
   must not run whole-entry legacy `_processEntry` when any unpaid day is
   post-cutover).
9. **Arming setter**: admin `setGovernorCommitArmedFromDay(dayId)` (future
   day only, one-shot or bounded), ConfigFacet or RewardAggregatorFacet.

NOTE: entry-path accumulators are built at FINALIZE (advanceCum* runs
where?) — verify the call site ordering vs `_stampGovernorDayPool` so the
stamped halves exist before the accumulators consume them (same
`_finalizeAndWrite`, stamp must run first).
