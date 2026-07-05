## Thread — Spec-conformance Tranche 1: tier liquidation-threshold gradient + $50k tier probe (#999, #1007 / PR #<n>)

The first tranche of the #998 spec-conformance fixes corrects how a loan's
liquidation threshold is chosen from its collateral's liquidity tier.

Previously the per-tier liquidation thresholds ran the wrong way: the thinnest
tier got the *highest* threshold (90%) and the deepest tier the lowest (80%), so
thin-market collateral was only liquidatable once it reached 90% LTV — leaving
too little cushion to absorb swap slippage, the handling fee, and the liquidator
bonus without bad debt. Because the threshold is snapshotted onto every liquid
loan at origination regardless of whether the optional depth-tiered regime is
switched on, this affected essentially every liquid-collateral loan. The
gradient is now flipped to run the way the specification and whitepaper always
described it — deeper liquidity earns a higher tolerated pre-liquidation LTV —
with defaults of 80% for Tier 1 (thinnest), 85% for Tier 2, and 90% for Tier 3
(deepest). The governance setter that tunes these thresholds now enforces the
matching ascending order. Loans already open keep the threshold they were
originated under; the platform is pre-live, so no live loans carry the old
values.

A companion fix makes the Tier-1 depth probe actually count. Tier assignment
measures how much an asset can absorb at $5k, $50k, $500k, and $5M; the $50k
(Tier-1) probe was being computed but never consulted, so any asset that could
absorb just $5k was silently promoted to Tier 1. Now an asset must clear the
$50k probe to earn Tier 1; one that clears only the $5k floor is treated as
untierable (Tier 0). Untierable liquid collateral receives the most conservative
Tier-1 liquidation threshold and the most conservative initiation cap, never a
deeper tier's more permissive settings — closing the gap where the previously
inert `tier1SizePad` governance knob had no effect.

No external interfaces changed. Closes #999 and #1007 under the #998 umbrella.
