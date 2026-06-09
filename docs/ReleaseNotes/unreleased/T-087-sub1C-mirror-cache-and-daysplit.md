## Thread — T-087 Sub 1.C: mirror cache read path + `(dayMin, dayClose)` ring-buffer split (PR #<n>)

Third slice on the T-087 cross-chain reward redesign. Builds on Sub 1.B (PR #447 / issue #442) which landed the Base-side ring buffer + the `VPFIDiscountAccumulatorFacet` carve-out. Sub 1.C does two architecturally important things:

### `DaySnapshot` split — `(dayMin, dayClose)`

Sub 1.B's round-2 fix kept the day's minimum balance on a same-day rollup so a dust-then-bulk attacker couldn't erase their morning-dust by topping up before midnight. Round-3 P2 #3 then caught the symmetric problem: a LEGITIMATE user who staked 1 wei dust at 12:01am then topped up to a real tier at 12:02am stayed treated as 1 wei in every future read until they did another rollup on a later day — `_effectiveBalanceForDay` extended the historical minimum forward indefinitely.

The fix needs both views: a `dayMin` that captures "the lowest balance observed on that specific day" (for the min-tier-over-history clamp that closes round-10 P1 #5) AND a `dayClose` that captures "the balance the user actually held at the end of that day" (so gap-fill extends the user's live balance forward, not the historical low).

`DaySnapshot` now packs both into the same 256-bit slot — `(uint16 dayId, uint120 dayMin, uint120 dayClose)`. `uint120` covers the full 230M VPFI token cap (1.3e36) with room to spare. Two helpers replace the single `_effectiveBalanceForDay`:

- `_effectiveDayClose(s, user, d)` — for the TWA scan AND for gap-fill extension to days past `lastUpdateDayId`.
- `_effectiveDayMin(s, user, d)` — for the min-tier clamp. For gap-filled days where the user held a single unchanged balance throughout, `dayMin == dayClose` and the helper returns `dayClose`.

Same-day rollup semantics: `dayMin` accumulates the minimum across all writes for the day (`dayMin = min(prev, new)`); `dayClose` overwrites with the latest write. New-day or first-write writes both fields to the same value.

### Mirror cache read path

`LibVPFIDiscount.effectiveTierAndBps` now dispatches by `s.isCanonicalVpfiChain`. On Base the cross-facet staticcall into the accumulator facet stays — that's the heavy ring-buffer scan path. On mirrors the read goes against `s.userTierCache[user]` directly, applying all four freshness gates locally without a Base round-trip:

1. The cached effective tier must be non-zero.
2. The cached `tierTableVersion` must match the mirror's `currentTierTableVersion` — a governance tier-threshold change on Base invalidates every cached entry until a fresh push catches it up (design round-6 P1 #10 + round-10 P1 #1).
3. `block.timestamp < cache.tierExpirySec` — the projected decay expiry baked into the cached tier at push time (round-3 P1 #1 + the sentinel `type(uint40).max` per round-6 P1 #9). Sub 1.B / 1.C ship with the sentinel set on every write so this gate is effectively "never expires from decay alone" until Sub 2 wires the projected-trajectory scan.
4. `block.timestamp - cache.lastUpdateSec <= cfgMirrorTierMaxAgeSec` — the secondary backstop for the "stake then never return + no broadcast" worst case (round-2 P1 #3); default 60 days.

The cached `effectiveBps` is applied directly so a governance change to the per-tier BPS table on Base reaches mirrors atomically with the version bump (round-11 P1 #6); mirrors deliberately do NOT consult their own per-tier-BPS constants at fee-application time.

### Out of scope (still deferred)

- CCIP inbound handler that WRITES the mirror cache: Sub 2.
- Projected `tierExpirySec` trajectory scan: Sub 2 (mirror cache currently always written with the `type(uint40).max` sentinel by the test fixture; the gate is correct, the value just doesn't reflect anything actionable yet).
- `getVPFIDiscountTier` UI rewire (Sub 1.B round-3 P2 #2) + lender preview hook rewire (P2 #1): Sub 1.D.
- Generic vault VPFI flow rollup hook (Sub 1.B round-3 P2 #4): Sub 1.D or follow-up — needs careful coordination with the vault-layer chokepoint.
- New ring-buffer-targeted test file `VPFIDiscountTimeWeightedTest.t.sol`: Sub 1.E.
