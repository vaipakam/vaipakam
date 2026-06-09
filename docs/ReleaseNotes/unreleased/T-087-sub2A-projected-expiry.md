## Thread — T-087 Sub 2.A: `tierExpirySec` write seam + inert projection acknowledgement (PR #<n>)

First slice of Sub 2 (CCIP wiring umbrella #451). Base-side change only — no CCIP plumbing yet (that lands in Sub 2.B / 2.C / 2.D).

### What changes

`VPFIDiscountAccumulatorFacet.rollupUserDiscount` now writes to `s.tierExpirySec[user]` on every rollup pass. The first attempt at this PR computed a 30-day forward projection of the TWA trajectory; Codex's round-1 P1 review then established that the projection is INERT under the integrated design and the write is therefore the `type(uint40).max` "no projected expiry" sentinel.

**Why the projection is inert.** The Sub 1.C `(dayMin, dayClose)` split plus the min-tier-over-history clamp added later (Codex round-10 P1 #5) already catch every decay scenario on Base — a partial unstake's `dayMin` enters the min-history window the same day the unstake lands, dropping the user's effective tier immediately. Once the clamp has dropped the effective tier, the projection under "constant balance held forever" can never produce a tier strictly BELOW that value, because future days' projected `dayMin = currentBalance` and the projected min-tier-over-history equals the current min-tier-over-history. Rather than burn ~900 SLOADs per rollup computing what would always be `type(uint40).max`, the helper writes the sentinel directly.

The helper signature stays as an extension point if a future design change reintroduces a scenario the projection could meaningfully forecast.

### Why this still matters for Sub 2.B / 2.C

The mirror cache's freshness is fully enforced by the OTHER three gates Sub 1.C wired in `_mirrorEffectiveTierAndBps`:
- effective tier non-zero (push wrote a real value)
- `tierTableVersion` match (governance hasn't moved the table)
- `cfgMirrorTierMaxAgeSec` backstop (60-day default)

These three are load-bearing. The `tierExpirySec` field remains in storage and in the Sub 2.B CCIP payload shape — it just carries the sentinel value on every push, which mirrors honour as "never expires from decay alone".

### New facet surface

`getTierExpirySec(address user) external view returns (uint40)` — public read on `VPFIDiscountAccumulatorFacet` (NOT `onlyInternal`; reading a public timestamp has no security posture). Used by:
- Sub 2.B's CCIP `TierUpdated` payload builder.
- Off-chain monitoring + indexer.
- Test inspection.

### Producer artifacts

- `_getVpfiDiscountAccumulatorSelectors()` in `DeployDiamond.s.sol` grows from 2 → 3.
- `HelperTest.sol`'s mirror grows from 2 → 3.
- ABI bundle regenerated.

### Test coverage

Four new tests in `VPFIDiscountTimeWeightedTest.t.sol` confirming the sentinel write across stake / hold / unstake / restake lifecycle:

- `test_ProjectedExpiry_FreshStakeReturnsSentinel` — fresh user pre-gate gets sentinel.
- `test_ProjectedExpiry_ConstantBalanceNeverDecays` — held-forever tier-1 stake stays at sentinel.
- `test_ProjectedExpiry_UnstakeProducesFiniteDay` — partial unstake to tier-1 floor stays at sentinel.
- `test_ProjectedExpiry_RestakeClearsExpiry` — full-unstake-then-restake cycles produce sentinel at each step.

24 ring-buffer-TWA tests pass (20 original + 4 new). Deploy-sanity 12/12 green.
