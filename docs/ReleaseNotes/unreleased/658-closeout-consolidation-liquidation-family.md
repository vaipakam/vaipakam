## Thread — Eager consolidation for the liquidation close-out family (PR #<n>)

This continues the #594 "eager consolidation" arc, which makes a
transferred loan position follow its current NFT holder. When a borrower
or lender transfers their position NFT, the underlying collateral /
principal must be re-anchored to the new holder before any close-out
event distributes funds — otherwise proceeds and surplus would still pay
the departed party. PR-1/PR-2/PR-3 wired this for the repay, default,
preclose and borrower-side paths; this PR extends it to the HF-based
liquidation family.

The architectural wrinkle is the EIP-170 facet-size limit. The
consolidation orchestrator (`LibConsolidation.consolidateToHolder`) is an
`internal` library function, so it INLINES its full body (~5 KB) into
every facet that calls it. `RiskFacet` sits only a few hundred bytes
under the 24,576-byte limit and cannot absorb that. The fix is a thin
internal-only entry point on `ConsolidationFacet`
(`eagerConsolidateBothSides`) that the orchestrator is inlined into ONCE;
size-constrained hosts reach it through a few-byte cross-facet call. The
new entry is gated to the Diamond's own internal calls
(`OnlyDiamondInternal`) and uses the Tier-2 "skip, never block a
close-out" sanctions semantics, so a sanctioned or excluded holder can
never brick a liquidation. `triggerLiquidation`,
`triggerPartialLiquidation`, `triggerLiquidationDiscounted` (RiskFacet)
and `triggerLiquidationSplit` (RiskSplitLiquidationFacet) now consolidate
both sides at the point they commit to liquidating — before the
internal-match dispatch and swap settlement.

Scope: this PR is PR-A of #658 — the cross-facet entry plus the
size-constrained liquidation family (the architecturally-motivated core).
The remaining close-out hosts (EarlyWithdrawal lender-side, Preclose,
periodic-interest, in-place extension, swap-to-repay-full, intent
settlement, refinance) and the multi-loan internal-match liquidation path
follow as PR-B. Part of #658; #658 stays open until PR-B lands.
