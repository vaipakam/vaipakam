## Thread — T-087 Sub 1.E: ring-buffer TWA + tier-resolution test coverage (PR #<n>)

Fifth and final slice of T-087 Sub 1 — adds focused unit-test coverage for the architectural surface that landed across Sub 1.A–D (PRs #446 / #447 / #448 / #449).

### New file: `contracts/test/VPFIDiscountTimeWeightedTest.t.sol`

Probes the `VPFIDiscountFacet.getEffectiveDiscount` surface — the single read entry point every consumer (Solidity fee paths + frontend hooks) hits for the post-gate tier+BPS values. 19 tests across 8 thematic groups:

- **Min-history gate** (3 tests) — fresh-stake returns 0; the gate is on elapsed SECONDS not day buckets (a stake at second 0 of day N does NOT clear a 3-day gate after `(N+3 days) - 1 second`); tier 1 earned exactly when the gate elapses.
- **Dust-then-bulk attack defence** (2 tests) — same-day top-up after dust stays clamped to 0 (dayMin preserved via Sub 1.B round-2 P1 / Sub 1.C `(dayMin, dayClose)` split); next-day top-up still clamped via gap-filled history.
- **Legitimate consistent stake** (1 test) — tier 1 earned after the gate.
- **Full unstake → immediate tier 0 + tenure reset** (2 tests) — positive→0 transition drops EFFECTIVE_TIER instantly; restake then needs a fresh `cfgTwaMinStakedDays` elapse before tier comes back.
- **Tier upgrades** (2 tests) — consistent high-tier stake earns the higher tier; recent upgrade-via-top-up stays clamped by old lower-tier history until either the 30-day ring rolls out OR the user fully unstakes + restakes (Sub 1.C round-3 P2 #1 documented trade-off).
- **Consent gate** (2 tests) — `getEffectiveDiscount` returns (0, 0) when consent is disabled, matches settlement-path gate (Sub 1.D round-1 P2).
- **Tier-table version invalidation** (2 tests) — `setVpfiTierThresholds` and `setVpfiTierDiscountBps` emit `TierTableVersionBumped(newVersion)` (Sub 1.C round-1 P2 #2 + round-2 P1 hook for Sub 2's eager mirror broadcast).
- **ConfigFacet bounds** (4 tests) — `cfgTwaMinStakedDays` rejects `1` (Sub 1.B round-1 P2 #6 lower bound raised) and `15`; `cfgTwaWindowDays` rejects `31` (capped at the ring-buffer's 30 slots); `cfgMirrorTierMaxAgeSec` rejects below 30 days.
- **Multi-user isolation** (1 test) — two stakers' gates and tier evolutions are independent.

### Out of scope for Sub 1.E

- Mirror cache READ path tests — Sub 1.C wired the read but the cache writer ships in Sub 2; without a writer the test would only confirm that an empty cache reads as (0, 0). Will land in Sub 2 alongside the CCIP inbound handler tests.
- Projected `tierExpirySec` trajectory math tests — the projection itself ships in Sub 2 (Sub 1.B / 1.C use the `type(uint40).max` "no expiry" sentinel as a placeholder).
- Generic vault VPFI rollup hook tests — the hook itself was deferred (Sub 1.B round-3 P2 #4); tests will land alongside the hook.

### Verification

63 VPFIDiscount-suite tests passing (44 original + 19 new). Deploy-sanity 12/12 green.
