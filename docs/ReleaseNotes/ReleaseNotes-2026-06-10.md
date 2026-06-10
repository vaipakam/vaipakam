# Release Notes — 2026-06-10

Today's headline: **T-087 — Cross-chain VPFI rewards & rebates — fully shipped end-to-end.** The entire 5-sub-card umbrella (#438) lands today across 20+ PRs, taking the protocol from "VPFI staking is per-chain" to "tier resolves on Base, cached tier applies on every mirror chain you take loans on." Subs 1+2 (contracts + CCIP transport), Sub 3's treasury buyback umbrella (#452) with its three add-ons (#472 priority router / #473 productive treasury reserve / #474 keeper VPFI rewards), Sub 4's dapp surface (PR #482 tier-poke selector + LenderDiscountCard polish, PR #483 chain-aware Stake VPFI CTA + manual mirror-cache push), and Sub 5's user-facing documentation (PR #484: new `VPFIDiscountSystem` FunctionalSpec + "How VPFI Discounts Work" Advanced UG section + operator runbook) all merged today.

A secondary thread today: **T-090 v1.1 GA + v1.2 follow-ups** — the intent-based swap-to-repay bridge graduated to GA with Fusion fetch + LOP orderbook integration, plus v1.2 hardening (agent auth, cross-chunk committer, activity force-cancel filter).

Post-deploy: the cross-chain discount surface requires explicit operator configuration on each chain (`setCanonicalVPFIChain` on Base; `setRewardMessenger` + `setBaseChainId` + `setMirrorTierMaxAgeSec` on mirrors; protocol broadcast budget top-up) — see [`docs/ops/DeploymentRunbook.md`](../ops/DeploymentRunbook.md) "T-087 — Cross-chain VPFI discount post-deploy activation" and the Advanced User Guide's "How VPFI Discounts Work" section.

## Thread — T-087 Sub 1.A: storage scaffolding + ConfigFacet knobs for the cross-chain reward redesign (PR #<n>)

First implementation slice on the [`docs/DesignsAndPlans/CrossChainRewardSystem.md`](../DesignsAndPlans/CrossChainRewardSystem.md) design that merged in PR #439 (sub-card #441 under umbrella #440). Storage scaffolding only — no user-visible behaviour change in this PR; existing fee paths still flow through the Phase-5 simple-TWA accumulator until the math + call-site rewires land in Sub 1.B.

### Storage layout (Base canonical + mirror)

The `LibVaipakam.Storage` struct gains the full T-087 surface, appended at the end of the struct so the existing storage slots that loupe-reading deploy tools depend on stay exactly where they were. The Phase-5 `userVpfiDiscountState` mapping is renamed to `userVpfiDiscountState_DEPRECATED` to mark its slot dead — the slot is preserved in place so layout is byte-identical to the pre-T-087 deployments; nothing reinterprets it. Every consumer in `LibVPFIDiscount.sol`, `LoanFacet.sol`, and `VPFIDiscountFacet.sol` was renamed in lockstep to the deprecated symbol so the code keeps compiling and the old accumulator still answers reads.

The new state added in this PR:

- The per-user ring buffer of protocol-tracked stake snapshots (`mapping(address => DaySnapshot[30]) dayBalances`, plus `lastUpdateDayId`, `currentStakeStartDayId`, `currentStakeStartSec`, `tierExpirySec`).
- The CCIP push tracking (`userTierPushNonce`, `userTierLastPushedNonce`), the version invalidation surface (`tierTableVersion`, `tierTableSweepDone`), the protocol-funded broadcast budget (`protocolBroadcastBudget`), and the enumerable registry of active stakers (`activeStakerRegistry`).
- The mirror-side cache surface (`userTierCache`, `currentTierTableVersion`, `baseAuthorizedMessenger` — the `baseChainId` slot is reused from the existing reward-report path, no second slot is allocated).
- The cross-chain buyback custody scaffolding (`buybackAllowedToken`, `buybackBudget`, `baseBuybackBudget`, `baseBuybackReserved`, `stakingPoolBuybackBudget`, `buybackRemittanceReceiver`).

Two new struct types land alongside this state: `DaySnapshot` (the per-slot `dayId + balance` tuple Codex round-4 P1 #2 required to disambiguate ring-buffer wraps) and `CachedTier` (the mirror-side packed slot, including the `effectiveBps` field Codex round-11 P1 #6 added so governance updates to the discount BPS table reach mirrors atomically with their version bump).

### Five ConfigFacet knobs

`setTwaRecentDays`, `setTwaWindowDays`, `setTwaRecentWeight`, `setTwaMinStakedDays`, and `setMirrorTierMaxAgeSec` are added to `ConfigFacet`, all ADMIN_ROLE-gated with the per-knob bounds the design doc §5 calls out. Each has its own dedicated error type (`InvalidTwaRecentDays`, etc.) so a misconfigured deploy reverts with a self-describing reason, and each emits a one-line audit event. The corresponding `cfgTwa*Effective()` getter helpers land in `LibVaipakam`, defaulting to the launch values when storage reads 0 — so a fresh deploy behaves correctly with zero post-deploy governance calls. The lower bound on `cfgTwaMinStakedDays` is `2`, not `1`, per Codex round-6 P2 #13 (a `1` would still permit the same-day flash-stake gaming case the gate exists to close).

### Producer artifacts

The five new selectors are wired into `DeployDiamond.s.sol`'s `_getConfigSelectors()` and `HelperTest.sol`'s `getConfigFacetSelectors()` per the facet-addition checklist; the deploy-sanity suite (`SelectorCoverageTest` + `FacetSizeLimitTest` + `DeployDiamondIntegrationTest`) all stay green.

### Out of scope for this PR

The skeleton `LibVPFIDiscount` ring-buffer helpers (`appendDailySnapshot`, `computeRingBufferTwa`, `computeEffectiveTier`, `computeProjectedTierExpiry`, etc.) are NOT added in this PR — they land in Sub 1.B alongside the math. The existing `LibVPFIDiscount.rollupUserDiscount` / `tryApply` / `tryApplyYieldFee` keep their current behaviour against the deprecated accumulator; every call site is untouched. The CCIP wiring (Sub 2) and the mirror-side facet deletions (Sub 1.D) stay out of this slice.

## Thread — T-087 Sub 1.B: ring-buffer TWA math + `tryApply` rewire (PR #<n>)

Second slice on the T-087 cross-chain reward redesign. Builds on Sub 1.A's storage scaffolding (PR #446 / issue #441) by populating the live behaviour: every VPFI discount lookup on Base now flows through the new 30-slot ring-buffer accumulator with the min-history gate + min-tier-over-history clamp.

### LibVPFIDiscount rewrite

`rollupUserDiscount(user, balPostMutation)` is rewired end-to-end:

- Appends `(dayId, balance)` to the per-user ring buffer at `slot[today % 30]`, lazily gap-filling skipped days with the prior balance up to a 30-iteration cap (the bound prevents the literal `~20 000-day` loop a fresh user's first stake would otherwise hit per Codex round-8 P1 #8).
- Maintains `currentStakeStartDayId` + `currentStakeStartSec` — the tenure anchors are RESET on every `positive→0` transition so a primed wallet can't carry old tenure across a zero-balance gap (round-6 P1 #1 + round-10 P1 #2).
- Adds the user to `activeStakerRegistry` on `0→positive`, removes on `positive→0`. The enumerable set is what the governance-sweep helper will iterate in Sub 2 (round-8 P1 #4 — Solidity mappings aren't enumerable).
- Bumps `userTierPushNonce` is wired but DORMANT in Sub 1.B; actual nonce-bump logic ships in Sub 2 alongside the CCIP broadcast helper. `tierExpirySec` stays at the `type(uint40).max` "no projected expiry" sentinel until Sub 1.C wires the projected-trajectory scan.

A new public read entry point `effectiveTierAndBps(user)` returns the post-gate effective tier + BPS. Gates applied in order:

1. **Elapsed-time min-history** — checks `block.timestamp - currentStakeStartSec >= cfgTwaMinStakedDays × 1 days`, NOT bucket arithmetic. A user staking just before midnight can't satisfy a 3-day gate after ~24 hours (round-11 P2 #4).
2. **Ring-buffer TWA** with two-tier weighting (recent days at `cfgTwaRecentWeight`, older days at 1) and a self-seeded denominator so a day-1 stake of 100 VPFI yields TWA = 100, not the fractional `100 × 3 / (3×7 + 23) ≈ 6.8` the round-1 P2 #7 finding caught.
3. **Min-tier-over-history clamp** — `effectiveTier = min(rawTier, minTier(last cfgTwaMinStakedDays days))`. A dust-then-bulk attacker who held 1 VPFI for 3 days then deposited 10k on day-3 sees `minOverHistory = 0` and EFFECTIVE_TIER is clamped to 0 (round-10 P1 #5).

`lenderTimeWeightedDiscountBps(loan)` and `borrowerTimeWeightedDiscountBps(loan)` keep their existing signatures so the 6 call sites in `LoanFacet`, `RepayFacet`, `RefinanceFacet`, `PrecloseFacet`, and `LibVPFIDiscount.settleBorrowerLifProper` / `tryApplyBorrowerLif` compile unchanged. Internally they now return the INSTANT `effectiveBps` — design §3 reuse row replaces Phase-5's loan-window averaging with the moment-of-fee-application lookup. The `loan.lenderDiscountAccAtInit` / `loan.borrowerDiscountAccAtInit` slots stay populated but no longer drive the BPS calculation.

`quote()` (borrower LIF quote) now reads EFFECTIVE_TIER instead of `tierOf(vault.balance)` — closes the Codex round-6 P1 #5 hole where a fresh wallet could quote a tier-4 LIF on Base even though the discount path would refuse to apply.

### `LoanFacet` snapshot helpers

`_snapshotLenderDiscount` / `_snapshotBorrowerDiscount` now pass `trackedVpfiBalance(user)` (the Phase-5 chokepoint counter at `s.protocolTrackedVaultBalance[user][vpfi]`) — NOT `vault.balance(VPFI)`. Round-7 P1 #7 caught that raw vault-balance reads would let unsolicited `safeTransfer`s into a user's vault inflate the TWA.

### VPFIDiscountAccumulatorFacet — new facet, EIP-170 driven

The ring-buffer math (`_computeTwa`, `_computeRingBufferMinTier`, `_effectiveBalanceForDay`) + lifecycle bookkeeping (`_maintainStakerLifecycle`, `_advanceRingBuffer`, `_readLastKnownBalance`) live in a NEW dedicated facet — they're not inlined into every consumer. The Solidity compiler inlines `internal` library helpers into every facet that consumes them; with five call sites (RepayFacet, PrecloseFacet, RefinanceFacet, plus the LoanFacet snapshot helpers, plus VPFIDiscountFacet's own deposit/withdraw flows) the heavy code blew RepayFacet (≈ 27 kB) and PrecloseFacet (≈ 25 kB) past the EIP-170 24,576-byte ceiling.

Carving the heavy code into ONE facet — reached by every consumer via a cross-facet `CALL` through the Diamond's fallback — keeps the heavy math as a single bytecode blob and the consumers' inlined surface as a thin selector-dispatch stub. The library wrappers `LibVPFIDiscount.rollupUserDiscount` and `LibVPFIDiscount.effectiveTierAndBps` are now low-level `.call` / `.staticcall` shims with a silent fallback path so minimal-fixture unit tests (LoanFacetTest, RepayFacetTest, etc.) that don't cut the new facet still work — the rollup becomes a no-op on those fixtures, preserving pre-T-087 semantics. The production diamond + `SetupTest`-derived fixtures cut the facet and get the full behaviour.

Both facet methods are gated to `msg.sender == address(this)` so an EOA can never invoke them directly — only the library wrappers' cross-facet path passes the gate.

### Producer artifacts

- `DiamondFacetNames.cutFacetNames()` grows from `string[46]` → `string[47]`. The four consumers (`SelectorCoverageTest`, `FacetSizeLimitTest`, `DeployDiamondIntegrationTest`, the local read) all bumped in lockstep.
- `DeployDiamond.s.sol` cuts the new facet at index 46 and exposes `_getVpfiDiscountAccumulatorSelectors()` for the deploy-sanity guardrail. The cut count grows 46 → 47.
- `HelperTest.sol` mirrors with `getVpfiDiscountAccumulatorFacetSelectors()`; `SetupTest.t.sol` instantiates the facet and adds the matching cut at index 47 (cut count 47 → 48). 
- `exportFrontendAbis.sh` `FACETS` array adds the new contract name; `packages/contracts/src/abis/index.ts` re-exports the ABI individually and spreads it into `DIAMOND_ABI`. ABI bundle regenerated.

### Existing test scenarios

Five Phase-5-shaped tests in `VPFIDiscountFacetTest.t.sol` were updated for the new semantics:

- `testQuoteVPFIDiscountForLenderOfferWithKnownBorrower` and `testAcceptOfferWithVPFIDiscountApplied`: reshaped to stake via the sanctioned `depositVPFIToVault` path instead of the `recordVaultDepositERC20` backdoor — the backdoor skips the rollup, leaving EFFECTIVE_TIER at 0.
- `testRepayAppliesLenderYieldFeeDiscount`, `testBorrowerLifGamingBlockedByStampRefresh`, `testBorrowerLifRebateCreditedOnProperRepayLongHold`: a `vm.warp(4 days)` between deposit and the next discount lookup elapses the 3-day min-history gate.

A foundry-specific edge case surfaced + got fixed: the harness starts at `block.timestamp = 1`, which produces `today = 0` for the ring buffer's `dayId`. The original guards in `_readLastKnownBalance` and `_effectiveBalanceForDay` treated `lastUpdate == 0` / `prevUpdateDay == 0` as "never written" — wrong, because dayId 0 is a legitimate stake day. Both guards now gate on `currentStakeStartSec != 0`, which is the only marker that reliably distinguishes "no stake history" from "first stake on epoch day 0".

### Out of scope

`tierExpirySec` projection (mirror-side decay enforcement) lands in Sub 1.C. CCIP wiring (auto-broadcast + version invalidation + sweep helper) lands in Sub 2. Mirror facet-cut deletions land in Sub 1.D. New ring-buffer-targeted test file `VPFIDiscountTimeWeightedTest.t.sol` lands in Sub 1.E.

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

### POST-MERGE OPERATOR ACTION (Base canonical deploy)

The mirror dispatch in `LibVPFIDiscount.effectiveTierAndBps` branches on `s.isCanonicalVpfiChain`. On the Base canonical deploy, governance MUST call `VPFITokenFacet.setCanonicalVPFIChain(true)` post-deploy — otherwise every discount read falls through to the mirror cache path, finds an empty cache, and silently returns tier 0. The selector is cut by `DeployDiamond.s.sol`, but the call itself is intentionally a governance action (not deploy-script-wired) so the same scripts can produce both canonical and mirror deploys without conditional branching. Codex Sub 1.C round-3 P2 #2 caught the gap; documenting here so the operator runbook picks it up before any production deploy.

### Intentional design choice — min-tier scan width

Codex Sub 1.C round-3 P2 #1 flagged that `_computeRingBufferMinTier` extends `windowFloor` DOWN to `currentStakeStartDayId` (capped at `today - 29`), which means a user who held tier 1 for 25 days, topped up to tier 3, and held tier 3 for 3 more days is still capped at tier 1 until the old days age out of the 30-day ring. This is the deliberate trade-off accepting the UX cost to close the dust-then-bulk attack vector (Codex round-3 P2 #4 from the same round). The user-visible path to upgrade tier: fully unstake (resets `currentStakeStartDayId` via the `positive→0` transition) then restake at the higher tier, paying a fresh `cfgTwaMinStakedDays` wait.

### Out of scope (still deferred)

- CCIP inbound handler that WRITES the mirror cache: Sub 2.
- Projected `tierExpirySec` trajectory scan: Sub 2 (mirror cache currently always written with the `type(uint40).max` sentinel by the test fixture; the gate is correct, the value just doesn't reflect anything actionable yet).
- `getVPFIDiscountTier` UI rewire (Sub 1.B round-3 P2 #2) + lender preview hook rewire (P2 #1): Sub 1.D.
- Generic vault VPFI flow rollup hook (Sub 1.B round-3 P2 #4): Sub 1.D or follow-up — needs careful coordination with the vault-layer chokepoint.
- New ring-buffer-targeted test file `VPFIDiscountTimeWeightedTest.t.sol`: Sub 1.E.

## Thread — T-087 Sub 1.D: `getEffectiveDiscount` view + frontend lender-discount hook rewire (PR #<n>)

Fourth slice on the T-087 cross-chain reward redesign. Builds on Sub 1.C (PR #448 / issue #443). The scope of this PR is narrower than the original Sub 1.D card #444 anticipated — see "Deferrals" below for what slid into a follow-up.

### `VPFIDiscountFacet.getEffectiveDiscount(user)`

A new external view returning the post-gate `(uint8 effTier, uint16 effBps)` the fee path actually applies. Internally calls `LibVPFIDiscount.effectiveTierAndBps(user)`, which dispatches by `s.isCanonicalVpfiChain` — accumulator on Base, cached `CachedTier` on mirrors — and applies all four mirror-side freshness gates (round-2 P1 #3 + round-6 P1 #9 + round-6 P1 #10 + round-10 P1 #1).

The existing `getVPFIDiscountTier(user)` stays as-is. The two getters answer different questions:

- `getVPFIDiscountTier` — "what tier does my CURRENT STAKE BALANCE imply, ignoring the min-history gate?" Useful for showing "your stake qualifies for tier N" before the user has held the position long enough.
- `getEffectiveDiscount` — "what discount applies RIGHT NOW at a fee charge?" The dapp should drive any "you'll save X% on this fee" math from this getter.

Codex Sub 1.B round-3 P2 #2 caught that the previous shape (a single raw-tier getter consumed by both UI surfaces) showed the user a tier they couldn't claim during the min-history window. The two-getter split answers both questions cleanly.

### `useLoanLenderDiscount.ts` rewire

The Phase-5 hook reconstructed a time-weighted-average BPS client-side from `getUserVpfiDiscountState` + the loan's `lenderDiscountAccAtInit` anchor + a stamped open-period extrapolation. None of that math applies under T-087 — the lender's discount is the INSTANT `effectiveBps` at the moment a fee path reads it.

The rewritten hook just reads `getEffectiveDiscount(lender)` and reports the BPS. The interface keeps `effectiveAvgBps` + `stampedBpsAtPreviousRollup` (both set to the same value) for backward compatibility with `LenderDiscountCard`'s existing drift-indicator; under T-087 semantics that indicator naturally never fires. `windowSeconds` still surfaces loan tenure for any consumer that wants to display it.

### Producer artifacts

- `_getVpfiDiscountSelectors()` in `DeployDiamond.s.sol` grows from 23 → 24 selectors.
- `HelperTest.sol`'s `getVPFIDiscountFacetSelectors()` mirrors the same growth.
- `packages/contracts/src/abis/VPFIDiscountFacet.json` regenerated via `bash contracts/script/exportFrontendAbis.sh`.
- Frontend `pnpm exec tsc -b --noEmit` clean.

### Deferrals

The original Sub 1.D card #444 included:

- **Mirror facet cut deletion** — the `DeployDiamond.s.sol` conditional cut by `isCanonicalVpfiChain` that strips `VPFIDiscountFacet` / `StakingRewardsFacet` / `VpfiBuyAdapter` from mirrors. Deferred. The runtime fence (`setCanonicalVPFIChain(false)` makes `buyVPFIWithETH` revert + makes the mirror dispatch read from the cache instead of the accumulator) already makes the mirror staking surface inert; the cut deletion is a deployment-size optimisation, not a correctness gate. Tracked on the umbrella for a follow-up alongside Sub 2's CCIP wiring (mirrors get configured at the same operator-action checkpoint).
- **Generic vault VPFI flow rollup hook** (Sub 1.B round-3 P2 #4) — needs careful coordination with the vault chokepoint in `VaultFactoryFacet`. Tracked on the umbrella.

### Verification

131 tests passing across touched surfaces — VPFIDiscount 44/44 + RepayFacet 75/75 + deploy-sanity 12/12. Quick-profile build clean. Frontend `pnpm exec tsc -b --noEmit` clean.

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

## Thread — T-087 Sub 2.B: `VaipakamRewardMessenger` learns `TierUpdated` + `VersionBumped` message kinds (PR #<n>)

Second slice of Sub 2. Adds the outbound surface for the per-user tier push + the tier-table-version bump that the dapp and mirror caches will consume, AND extends the inbound payload-size gate to recognise the new shapes. Sub 2.C wires the receive-side Diamond forwarding; Sub 2.D wires the auto-broadcast trigger from the rollup path.

### New constants

- `MSG_TYPE_TIER_UPDATED = 3` and `MSG_TYPE_VERSION_BUMPED = 4` join the existing REPORT/BROADCAST tags.
- `TIER_UPDATED_PAYLOAD_SIZE = 8 × 32` for `(kind, user, effTier, effBps, computedAt, nonce, tierExpirySec, tierTableVersion)`.
- `VERSION_BUMPED_PAYLOAD_SIZE = 2 × 32` for `(kind, newVersion)`.

### Outbound

- `sendTierUpdate(user, effTier, effBps, computedAt, nonce, tierExpirySec, tierTableVersion, refundAddress)` — Base → every configured mirror per-user push. Diamond-only. `msg.value` must cover the sum of per-destination quotes; surplus refunded. Same `msg-value-loop` pattern as `broadcastGlobal` with the bounded `spent` cumulator.
- `sendVersionBumped(newVersion, refundAddress)` — Base → every configured mirror eager tier-table-version bump on governance threshold / BPS change. Diamond-only.
- `quoteSendTierUpdate(...)` / `quoteSendVersionBumped(...)` — quote helpers that mirror the existing `quoteBroadcastGlobal` shape.

### Inbound

The size gate now accepts THREE valid word counts: 4 (legacy REPORT/BROADCAST), 8 (`TierUpdated`), 2 (`VersionBumped`). Any other length is rejected with `PayloadSizeMismatch` before decode — the legacy padded-packet protection extends symmetrically across all four message shapes.

The decode dispatcher gains arms for `MSG_TYPE_TIER_UPDATED` and `MSG_TYPE_VERSION_BUMPED`. Both reject `isCanonical` reception with `BroadcastOnCanonical` (mirrors only). Both emit a receive-side event (`TierUpdateReceived` / `VersionBumpReceived`) with the round-tripped payload so fork tests + ops monitoring can observe the inbound message.

**Sub 2.B intentionally stops at the receive event.** The Diamond's `MirrorTierIngress` interface that the new arms will call to write the mirror cache + raise `currentTierTableVersion` lands in Sub 2.C — letting that slice land + be reviewed independently. Until 2.C lands, mirrors surface the event-only inbound; their Diamond's `userTierCache` stays unwritten, which falls back gracefully to (0, 0) via the existing Sub 1.C mirror cache read path.

### Test coverage

10 new tests in `VaipakamRewardFlowTest.t.sol` covering:

- Happy-path send + receive event round-trip for both new shapes.
- Sender access control (only the paired Diamond can invoke).
- `BroadcastOnCanonical` rejection for inbound on the canonical instance.
- Per-type size validation (a `TierUpdated`-kind tag wrapped in a 4-word REPORT-sized payload reverts with the exact-size mismatch).
- Outer size gate (a 3-word payload is rejected before decode).
- Quote views return the expected per-destination fee.

Together with the 13 existing reward-flow tests, the messenger suite is 23/23 green. Wider cross-chain sweep: 104 tests pass.

### Out of scope

- Mirror-side Diamond `MirrorTierIngress` interface + cache writes → Sub 2.C.
- Auto-broadcast trigger from the rollup path + protocol broadcast budget → Sub 2.D.
- Force-resend recovery + sweep helper → Sub 2.D.
- Fork tests on Base Sepolia → Sepolia mirror → Sub 2.E.

## Thread — T-087 Sub 2.C: mirror inbound tier-cache writer facet (PR #<n>)

Third slice of Sub 2. Wires the mirror-side Diamond ingress for the cross-chain tier push that Sub 2.B's messenger forwards. The mirror's `s.userTierCache[user]` writer + `s.currentTierTableVersion` raise live in a new dedicated facet; the existing Sub 1.C `LibVPFIDiscount._mirrorEffectiveTierAndBps` read path (with its four freshness gates) reads what this facet writes.

### New facet: `MirrorTierReceiverFacet`

Four public selectors:
- `onTierUpdateReceived(srcChainId, user, effTier, effBps, computedAt, nonce, tierExpirySec, tierTableVersion)` — called by the messenger on inbound `MSG_TYPE_TIER_UPDATED`. Writes the cache + stamps `lastUpdateSec = block.timestamp` (local clock, so `cfgMirrorTierMaxAgeSec` backstop is local-time-based, not Base's clock).
- `onVersionBumpedReceived(srcChainId, newVersion)` — called on `MSG_TYPE_VERSION_BUMPED`. Raises `currentTierTableVersion` via `max(current, new)` so out-of-order delivery is benign.
- `getUserTierCache(user)` — public read of the full struct for off-chain monitoring + tests.
- `getCurrentTierTableVersion()` — mirror's current version for "behind by version" detection.

### Trust gates

- **Sender:** `msg.sender == s.rewardMessenger`. The messenger has already authenticated the CCIP source + channel peer + payload shape; the facet trusts what it forwards. Caller mismatch → `NotMessenger(caller)`.
- **Source chain:** `srcChainId == s.baseChainId`. Catches a misconfigured peer where another mirror sends a tier push to a mirror (only Base may push). Mismatch → `WrongSourceChain(got, expected)`.
- **Monotonic order:** `nonce > cache.lastNonce`. Catches replay and out-of-order delivery; reverts `StaleNonce(got, cached)` before the cache is mutated.
- **Nonce fit:** the cache's `lastNonce` is `uint64`; the messenger payload encodes `uint256`. Anything > `type(uint64).max` reverts `NonceOverflow(got)` rather than silently truncating.

### Messenger forwarding wired

`VaipakamRewardMessenger.onCrossChainMessage` was Sub 2.B's event-only inbound stub; now it forwards both new kinds via the new `IMirrorTierIngress` interface:

- `MSG_TYPE_TIER_UPDATED` → `IMirrorTierIngress(diamond).onTierUpdateReceived(...)`.
- `MSG_TYPE_VERSION_BUMPED` → `IMirrorTierIngress(diamond).onVersionBumpedReceived(...)`.

### Producer artifacts

- New facet cut at index 47 (cuts array 47 → 48) in `DeployDiamond.s.sol`.
- `MirrorTierReceiverFacet` appended to `DiamondFacetNames.cutFacetNames()` (47 → 48).
- `_getMirrorTierReceiverSelectors()` added to `DeployDiamond.s.sol` + `HelperTest.sol` (4 selectors each) and wired into `SelectorCoverageTest._populateRoutedSet`.
- `SetupTest.t.sol` cuts array 48 → 49.
- Cut into `DeployDiamondIntegrationTest`, `FacetSizeLimitTest`, `SelectorCoverageTest` (signature bumps 47 → 48).
- `MirrorTierReceiverFacet.json` regenerated via `exportFrontendAbis.sh`; added to the frontend bundle + barrel re-export + `DIAMOND_ABI` spread.

### Mock extension

`MockRewardDiamond` in `VaipakamRewardFlowTest` extended with `onTierUpdateReceived` + `onVersionBumpedReceived` recorders so Sub 2.B's existing 23 tests continue to pass (the messenger now forwards what was previously stubbed) and so the suite can assert what was forwarded.

### Test coverage

10 new tests in a dedicated `MirrorTierReceiverFacetTest.t.sol`:

- Happy-path cache write + event emit.
- Trust gates: `NotMessenger`, `WrongSourceChain` for both surfaces.
- Monotonic ordering: stale nonce + out-of-order nonce + nonce overflow.
- Version bump: raise on higher, benign no-op on equal / lower.

The 23 Sub 2.B reward-flow tests stay green with the extended mock. Wider sweep: 69 VPFIDiscount + 102 cross-chain tests pass. Deploy-sanity 12/12.

### Out of scope (Sub 2.D / 2.E)

- Auto-broadcast trigger from rollup + protocol broadcast budget + force-resend + sweep helper → Sub 2.D.
- Live CCIP fork tests on Base Sepolia → Sepolia mirror → Sub 2.E.

## Thread — T-087 Sub 2.D: protocol-funded mirror broadcast orchestrator (PR #<n>)

Fourth slice of Sub 2. Wires the auto-broadcast trigger that ties Sub 2.A (projection seam) + Sub 2.B (messenger outbound) + Sub 2.C (mirror inbound receiver) together. Every nonce-bumping rollup on Base now fans out a CCIP push to every configured mirror, charged against a dedicated protocol budget; insufficient budget fails CLOSED so operators can't ship downgrade-bearing mutations without honouring the cross-chain promise.

### New facet: `ProtocolBroadcastFacet`

Five public selectors:

- `protocolBroadcastTierUpdate(user)` — `msg.sender == address(this)` gated. Called from the accumulator's rollup path via the diamond fallback. Resolves the user's current `effectiveTierAndBps` via the existing internal accumulator surface, bumps `s.userTierPushNonce[user]`, quotes the per-fan-out fee from the messenger, debits the budget (or reverts), and forwards a single `sendTierUpdate` call that fans to every configured destination atomically.
- `topUpBroadcastBudget()` payable — anyone can top up.
- `withdrawBudget(to, amount)` — ADMIN_ROLE gated; rejects zero recipient AND `address(this)` (the Diamond/proxy itself; would burn budget into un-budgeted balance).
- `getProtocolBroadcastBudget()`, `getUserTierPushNonce(user)` — public reads.

### Gate matrix (post-round-3 simplification)

The trigger has two skip conditions before it ever talks to the messenger:

1. `!isCanonicalVpfiChain` → silent skip (mirrors don't originate; they only consume).
2. `s.rewardMessenger == address(0)` → silent skip (CCIP wiring deferred, common in fresh deploys + every local fixture).

The earlier diamond-side `broadcastDestinationCount` skip was a duplicate of the messenger's destination set that could drift fail-OPEN (operator syncs the messenger's list but forgets the Diamond knob → every rollup silently returns). Dropped in round-3 P1 #2 — the messenger's own `NoBroadcastDestinations` revert now bubbles through the accumulator naturally failing CLOSED on half-finished configurations.

Once the two gates pass + the de-dup gate passes (see below), the budget check fires — and FAILS CLOSED with `ProtocolBudgetExhausted(required, available)`.

### De-dup gate (full-tuple)

The broadcast is skipped when the resolved push tuple `(effTier, effBps, expiry, version)` is identical to the last pushed for the user. Same-tier mutations that change projected expiry (e.g., partial withdrawal accelerates decay) OR change version (governance table bump) still propagate. A brand-new address whose rollup resolves to `(0, 0)` AND whose last-pushed pair is also `(0, 0)` silent-skips (round-2 P1 #3 dust-deposit drain vector).

### Rollup hook

`VPFIDiscountAccumulatorFacet.rollupUserDiscount` gains a tail call to `protocolBroadcastTierUpdate(user)` gated on `s.rewardMessenger != address(0)`. When the messenger is unwired (default deploy state, every minimal-fixture test), the broadcast call is skipped entirely; when wired, the call goes through and ANY revert (`ProtocolBudgetExhausted`, `NoBroadcastDestinations`, anything from inside the messenger) bubbles to the caller.

The outer `LibVPFIDiscount.rollupUserDiscount` wrapper uses a conditional silent-fallback: when `s.rewardMessenger == 0`, swallow `FunctionDoesNotExist()` (the only safe selector at the LibVPFIDiscount → accumulator boundary in an unwired state — keeps minimal-fixture tests green); when set, bubble everything (no downstream-aliasing risk allowed; production reverts MUST surface).

### Storage append

`LibVaipakam.Storage.__reservedSub2D1` (uint8, originally `broadcastDestinationCount`; round-3 P1 #2 dropped the field's role but the slot stays for layout stability) plus `lastTierExpirySec` + `lastTierTableVersion` (round-2 P1 #1 full-tuple de-dup). The earlier Sub 2.D slots (`protocolBroadcastBudget`, `userTierPushNonce`, `userTierLastPushedNonce`, `tierTableSweepDone`, `activeStakerRegistry`) were already in place from Sub 1's design landings.

### Producer artifacts

- Cuts array 48 → 49 (DeployDiamond), 49 → 50 (SetupTest).
- `DiamondFacetNames` 48 → 49; `_getProtocolBroadcastSelectors()` added + wired into `SelectorCoverageTest`; `FacetSizeLimitTest` + `DeployDiamondIntegrationTest` size bumped.
- Frontend ABI + barrel + `DIAMOND_ABI` spread.

### Test coverage

8 tests in `ProtocolBroadcastFacetTest.t.sol`:

- Defaults for the read surface.
- Budget top-up additive across multiple calls.
- Withdraw happy path + revert on over-withdraw + revert on non-admin + revert on zero recipient + revert on withdraw-to-self.
- Internal-only gate: a direct external call reverts `OnlyInternal(caller)`.
- Canonical-flag default confirmation (SetupTest's `isCanonicalVpfiChain` is `false`, the implicit gate that lets every existing test stay green now that the rollup tail-calls the broadcast).

End-to-end CCIP fork tests (real messenger, mock router → mock-router-on-an-anvil) ship in Sub 2.E.

### Scope deferrals

The original Sub 2.D card included three additional surfaces; all deferred to a follow-up card so this slice stays small + reviewable:

- `forceResendTierUpdate(user, dests[])` — caller-funded recovery for missed pushes. The messenger's `sendTierUpdate` already exists; the follow-up just needs the admin-callable Diamond-side wrapper that bypasses budget + nonce bookkeeping.
- `sweepTierTableUpdate(startIdx, count)` — permissionless catchup walker over `s.activeStakerRegistry` with per-(user, version, dest) one-shot via `s.tierTableSweepDone`. Needs the active-staker registry's write hook to be wired first (also a follow-up).
- ConfigFacet eager VersionBumped broadcast on threshold / BPS change — small addition; deferred to keep the scope sharp.

These three are tracked on the umbrella; nothing in Sub 2.E depends on them being live first.

## Thread — T-087 Sub 2.E: integration test + FunctionalSpec + Advanced UG addendum (PR #<n>)

Fifth and final slice of T-087 Sub 2. Closes the cross-chain tier propagation work with a happy-path end-to-end integration test, the code-free functional spec, and a user-facing addendum.

### Integration test

New `contracts/test/CrossChainTierPropagationIntegrationTest.t.sol` wires the full Sub 2.A–D chain against a `MockCcipRouter`:

- A canonical Base diamond with the broadcast facet cut, a real `CcipMessenger`, and a real `VaipakamRewardMessenger` configured with one mirror destination.
- A funded `protocolBroadcastBudget` so the rollup's fail-CLOSED gate doesn't trip.

Two tests:

- `test_DepositVPFI_TriggersBroadcastToMirror` — first deposit silent-skips (pre-min-history; resolves to (0, 0)); after the `cfgTwaMinStakedDays` elapse, a 1-wei top-up triggers a fresh rollup → the de-dup gate sees the new non-zero tuple → ProtocolBroadcastFacet quotes, debits, sends. Asserts `router.pendingCount() == 1` + `getUserTierPushNonce(user) == 1`.
- `test_DepositVPFI_DustTier0_SilentSkip` — a sub-tier-1 dust deposit resolves to (0, 0) AND last-pushed is (0, 0), so the round-2 P1 #3 silent-skip fires; `router.pendingCount() == 0`. Closes the dust-deposit drain vector that earlier rounds caught.

This is NOT a fork test against live Chainlink CCIP testnets — those require operator-run RPC infrastructure and are tracked separately in the cutover runbook. The mock-router integration catches the same regressions across the rollup → broadcast → messenger chain at unit-test speed.

### FunctionalSpec

New `docs/FunctionalSpecs/CrossChainTierPropagation.md` — code-free, implementation-independent spec of cross-chain tier propagation. Six sections:

1. A user's tier is decided on Base.
2. The canonical chain broadcasts on every nonce-bumping mutation (including the de-dup gate rationale).
3. The mirror cache writer applies trust + ordering rules.
4. The cross-chain push is protocol-funded with fail-CLOSED semantics.
5. Version bumps are atomic across the broadcast set.
6. Decay is enforced by the cache freshness gate, not by mirror computation.

Plus what the spec does NOT cover (out-of-scope cross-references to Sub 3 / Sub 4 / Sub 5), operator-visible failure modes (`ProtocolBudgetExhausted`, `NoBroadcastDestinations`, `StaleNonce`), and the trust-model summary.

### Advanced User Guide addendum

`apps/www/src/content/userguide/Advanced.en.md` gets a new "How your VPFI tier travels across chains" section under the Buy VPFI flow. Plain-language for end users:

- You stake on Base; other chains read a cached copy.
- The push is automatic — no "sync my tier" action required.
- Typical propagation time is minutes via CCIP.
- Cache expiry: 60-day max-age backstop.

Includes a link to the FunctionalSpec for users who want the full mechanics. Translation sync is deferred — other locale files keep the previous version until translators catch up, per the existing localisation discipline.

### Scope deferrals

- **Live CCIP fork tests** — require operator-run RPC + funded testnet CCIP lanes. Tracked in the cutover runbook (`docs/DesignsAndPlans/LayerZeroToChainlinkCcipMigration.md` § operator gates).
- **Other-locale translations** — translator-driven; Advanced.{de,es,fr,ar,hi,ja,ko,ta,zh}.md keep the previous text until translation sync.

### Verification

- 2 new integration tests pass.
- Deploy-sanity 12/12 still green.
- No new producer artifacts (the test uses existing fixtures + mocks).

## Thread — T-087 Sub 3 add-on #472: Fee-converted VPFI priority routing (PR #<n>)

Sub 3 add-on. Per the 2026-06-09 design discussion: every partial buyback fill's delivered VPFI now cascades through THREE destination budgets in priority order — `rewardEmissionsBudget`, then `keeperRewardBudget`, then `stakingPoolBuybackBudget` as final overflow.

### Why

Until this card lands, all delivered VPFI flowed straight to `stakingPoolBuybackBudget` (Sub 3.B/3.C behaviour). That widens the staker claim eventually (via Sub 3 add-on follow-up), but leaves fresh-mint emissions + keeper rewards unchanged.

The priority router lets governance decide that **some portion of buyback proceeds should first offset fresh-mint inflation** (by topping up the reward emissions budget the existing distributor pulls from BEFORE minting new VPFI). The same router can also fund operational keeper rewards before the overflow cascades to stakers.

### How it works

`LibTreasuryBuyback.postInteractionImpl` now calls a `_routePriority(s, actualVpfi)` helper after every partial fill. Each step claims up to `(target - current_budget)`; the remainder cascades. Zero target disables the step entirely (the cascade skips it).

1. **`rewardEmissionsBudget`** — claims up to `cfgRewardEmissionsTopUpTarget - rewardEmissionsBudget`.
2. **`keeperRewardBudget`** — claims up to `cfgKeeperRewardTopUpTarget - keeperRewardBudget`.
3. **`stakingPoolBuybackBudget`** — receives the remainder.

A new `BuybackPrioritySplit(delivered, toRewards, toKeepers, toStaking)` event fires per partial; the sum invariant `toRewards + toKeepers + toStaking == delivered` is enforced by construction.

### Backwards compatibility

Both top-up targets default to `0`, which disables both steps. With defaults, the cascade lands every fill into `stakingPoolBuybackBudget` — IDENTICAL to Sub 3.C behaviour. The 45 existing buyback unit tests pass unchanged.

### Storage additions (append-only)

- `uint256 rewardEmissionsBudget` — current credit of the rewards-emissions destination.
- `uint256 keeperRewardBudget` — current credit of the keeper-rewards destination.
- `uint256 cfgRewardEmissionsTopUpTarget` — floor amount the cascade tops the rewards budget up to.
- `uint256 cfgKeeperRewardTopUpTarget` — floor amount the cascade tops the keeper budget up to.

### Producer artifacts

- TreasuryFacet selectors 32 → 38 (6 new: 2 setters + 4 reads).
- ABI bundle regenerated.

### Test coverage

8 new tests in `BuybackPriorityRouterTest.t.sol`:

- Default zero targets → all to staking (regression confirmation).
- Full cascade across all 3 destinations.
- Partial cascade: rewards consumes everything when delivery < rewards gap.
- Rewards at floor → cascade skips to keepers; both at floor → all to staking.
- Sum invariant (`toRewards + toKeepers + toStaking == delivered`).
- Setter access control (not-admin rejection) for both targets.
- Zero target disables the step (round-trip).

### Out of scope

- The actual rewards distributor change that PULLS from `rewardEmissionsBudget` BEFORE minting fresh VPFI — that's a follow-up on the rewards distributor side. Until that lands, the new budget slot accumulates but doesn't yet offset fresh-mint emissions; once the distributor reads from it, the inflation-offset becomes live.
- The keeper reward distribution itself — Sub 3 add-on #474.

### Verification

- BuybackPriorityRouterTest 8/8.
- BuybackValidatedCommitTest 15/15.
- BuybackEndToEndIntegrationTest 2/2.
- BuybackIntentLedgerTest 28/28.
- Deploy-sanity 12/12.
- Frontend tsc clean.

## Thread — T-087 Sub 3 add-on #473: Productive treasury reserve Phase 0 (PR #<n>)

Sub 3 add-on. Per 2026-06-09 design discussion: idle treasury reserves earn 0% today. This card adds Phase 0 of the productive reserve.

**Aave V3 is the only operational venue in Phase 0.** The Lido venue enum value, setter (`setLidoStaking`), and address slot are reserved but `deployTreasuryYield` for a `LIDO_STETH`-configured token currently reverts `LidoVenueNotYetSupported` — the WETH-unwrap + native-ETH submit + Lido withdrawal-queue plumbing lands in Phase 1. The deployment is bounded by a per-deploy ceiling check (NOT a continuously-enforced floor).

### Architecture

**New library — `LibTreasuryYield`**

Phase 0 venue adapters:

- `deployTreasuryYield(token, amount)` — supplies to the configured venue. Enforces the per-token external-yield cap.
- `withdrawTreasuryYield(token, amount)` — pulls back from the venue.
- Aave V3: `supply(asset, amount, onBehalfOf, referralCode)` + `withdraw(asset, amount, to)`.
- Lido: `submit(referral) payable returns (uint256)`.

The library is storage-aware (tracks `s.treasuryDeployedExternal[token]`) and trust-aware (rejects deployments above the cap).

**TreasuryFacet additions**

- `setTreasuryYieldVenue(token, venue)` — venue is `NONE` (0), `AAVE_V3` (1), or `LIDO_STETH` (2).
- `setTreasuryExternalYieldMaxBps(uint16)` — counterparty-risk ceiling. Default 7000bps (70%); hard upper bound 8000bps (20% always retained in-diamond).
- `setAaveV3Pool(address)` + `setLidoStaking(address)` — venue addresses (EOA-rejecting via `code.length > 0`).
- `deployTreasuryYield(token, amount)` + `withdrawTreasuryYield(token, amount)` — ADMIN-gated wrappers.
- Public reads: `getTreasuryYieldVenue`, `getTreasuryDeployedExternal`, `getTreasuryExternalYieldMaxBps`, `getAaveV3Pool`, `getLidoStaking`.

### Counterparty-risk gate (deploy-time only)

`cfgTreasuryExternalYieldMaxBps` is a **deploy-time gate**, not an ongoing invariant. At the moment a `deployTreasuryYield` call lands, it ensures the cumulative externally-deployed amount doesn't exceed the configured BPS share of the total addressable treasury (`treasuryBalance + alreadyDeployed`). After deployment, other treasury debit paths (`claimTreasuryFees`, `convertTreasuryAsset`, payroll funding, buyback `creditBuybackBudget`) can still consume `treasuryBalances[token]` — the "30% liquid floor" is NOT a continuously-enforced invariant; it is the state guaranteed at the moment of deployment.

- Default 7000bps → at deploy-time, at most 70% of the total addressable treasury can be in external position.
- Hard upper bound 8000bps → governance can raise the ceiling to no more than 80% at deploy time. This does NOT imply a continuously-retained 20% in-diamond floor — see operator guidance below.
- Denominator is `treasuryBalance + alreadyDeployed` (the total addressable treasury for that token).

Operators monitoring the floor in production are advised to either (a) re-deploy only what fits the cap when the in-diamond balance drops below the desired floor, or (b) treat the cap as a per-deploy gate with the understanding that subsequent treasury debits may drop the in-diamond portion below 30%.

### Storage additions (append-only)

- `mapping(address => uint8) cfgTreasuryYieldVenue` — per-token venue enum.
- `mapping(address => uint256) treasuryDeployedExternal` — currently-deployed amount per token.
- `uint16 cfgTreasuryExternalYieldMaxBps` — ceiling.
- `address cfgAaveV3Pool` + `address cfgLidoStaking` — venue addresses.
- `uint256 aaveDeployedTokenCount` (round-2 P1 #1) — count of tokens with non-zero Aave principal; consulted by `setAaveV3Pool` to block rotation while live positions exist.
- Constants: `TREASURY_YIELD_VENUE_NONE / AAVE_V3 / LIDO_STETH`.

### Producer artifacts

- TreasuryFacet selectors 38 → 49 (11 new).
- ABI bundle regenerated.

### Test coverage

15 new tests in `TreasuryYieldTest.t.sol`:

- All config setter happy paths + access control rejection + EOA-rejection on Aave/Lido addresses.
- BPS-above-max rejection + default 7000bps fallback.
- Aave deploy + withdraw round-trip; ledger counter + diamond treasury balance both update.
- Revert paths: venue not configured, pool address not set, withdraw exceeds deployed, cap exceeded, cap enforced after partial deploy.

Mock Aave V3 Pool + Mock Lido staking simulate the venue side. Cap math is exercised against the diamond's `treasuryBalances` (probed via EIP-7201 namespaced slot).

### Out of scope (deferred)

- **Lido path entirely** (Codex round-1 P1): `deployTreasuryYield` for a `LIDO_STETH`-configured token reverts `LidoVenueNotYetSupported` in Phase 0. The native-ETH submit path needs a WETH-unwrap leg the diamond doesn't yet have; wiring it without that leg would silently debit `treasuryBalances[token]` while no ETH actually reaches Lido. Phase 1 wires the WETH→ETH unwrap + the Lido withdrawal queue interaction. The venue enum + setters remain reserved.
- **Yield harvest tracking** (Codex round-1 P2 #2 + round-2 P2 + round-3 P2): `treasuryDeployedExternal[token]` tracks principal only. As Aave interest accrues, the diamond's aToken balance grows above this counter. Phase 0 does NOT include a separate `harvestTreasuryInterest(token)` method, and `withdrawTreasuryYield` is hard-capped at the recorded principal — the surplus aTokens (the accrued interest) are unreachable through this facet. There is NO valid Phase-0 workaround: an admin EOA cannot use Aave's UI to burn the diamond's aTokens (the aTokens belong to `address(this)`, not the admin), so the only way to realise the interest before Phase 1 is to add a new diamond function that calls Aave's `withdraw(asset, type(uint256).max, address(this))` against the live aToken balance. Phase 1 ships that path.
- **Phase 1 — `VAIPAKAM_INTERNAL` venue**: shifts portion to Vaipakam itself after $50M+ TVL. Tracked separately.

### Verification

- TreasuryYieldTest 15/15.
- All prior Sub 3 suites still green (54 total).
- Deploy-sanity 12/12.
- Frontend tsc clean.

## Thread — T-087 Sub 3 add-on #474: Keeper VPFI rewards Phase 0 (PR #<n>)

Sub 3 add-on. Per 2026-06-09 design discussion: permissionless housekeeping calls (Sub 2.D sweep / force-resend, periodic interest accrual, mirror cache catchup, etc.) get paid in VPFI at `gasUsed * tx.gasprice * mult` ETH-equivalent value, debited from the `s.keeperRewardBudget` slot the priority router (#472) populates.

### What ships in Phase 0

**Library — `LibKeeperReward`** with the canonical pay function:

```
payVpfiReward(address keeper, bytes32 actionKind, uint256 gasUsed)
  → returns vpfiPaid (zero if skipped)
```

- Reads `s.cfgKeeperRewardMultBps` (default 2x); converts gas to VPFI at the Phase-0 FIXED rate (1 VPFI = 0.001 ETH).
- Debits `s.keeperRewardBudget`; `safeTransfer`s VPFI from the diamond to the keeper.
- NEVER reverts — kill-switch off / budget empty / no-gas / VPFI not configured all return 0 silently with a `KeeperRewardSkipped` event. Housekeeping must complete regardless.
- Emits `KeeperRewardPaid(keeper, actionKind, gasUsed, ethEquivalent, vpfiPaid)` on success.

**TreasuryFacet config surface** (8 new selectors):

- `setKeeperRewardMultBps(uint32)` — multiplier on gas. Bounded [10000, 100000] = 1x..10x. Default 20000 (2x). `uint32` because 100000 exceeds `uint16` max (65535).
- `setKeeperRewardCashOutSpreadBps(uint16)` — Phase-1 cash-out spread. Bounded [100, 2000] = 1%..20%. Default 500 (5%).
- `setKeeperRewardEnabled(bool)` — kill-switch. Default `false`.
- `setKeeperRewardTwapMaxAgeSec(uint32)` — Phase-1 TWAP staleness threshold. Default 1800 (30 min).
- 4 matching reads with default-fallback semantics.

### Phase 0 design choices

1. **Fixed rate, not LP TWAP.** The VPFI/ETH LP TWAP path is sketched (storage slot exists for `cfgKeeperRewardTwapMaxAgeSec`) but not wired. Phase 0 uses the same fixed rate the buy flow uses (1 VPFI = 0.001 ETH). Phase 1 wires the v3 TWAP path + staleness fallback to the fixed rate.
2. **No cash-out.** Cash-out spread setter + storage exist (default 5%) but the actual `cashOutKeeperReward(messageId)` flow requires ETH liquidity the diamond doesn't yet manage. Phase 1 wires it.
3. **No-revert path.** Every failure mode emits `KeeperRewardSkipped` and returns 0 instead of reverting. Housekeeping must complete; the keeper just runs at a loss until the budget refills.
4. **Hook NOT wired.** Adding `LibKeeperReward.payVpfiReward(...)` calls to individual housekeeping facets is a separate per-facet wiring task. This card ships the LIBRARY + the config surface; the consumer-side wiring lands when each facet's keeper-permissionless mode lands.

### Storage additions (append-only)

- `uint32 cfgKeeperRewardMultBps` — multiplier in bps. `uint32` (not `uint16`) because the upper-bound 100000 exceeds `uint16` max.
- `uint16 cfgKeeperRewardCashOutSpreadBps` — Phase-1 cash-out spread in bps.
- `bool cfgKeeperRewardEnabled` — kill-switch.
- `uint32 cfgKeeperRewardTwapMaxAgeSec` — Phase-1 TWAP staleness threshold.

(`s.keeperRewardBudget` already shipped in #472.)

### Producer artifacts

- TreasuryFacet selectors 49 → 57 (8 new).
- ABI bundle regenerated.

### Test coverage

13 new tests in `KeeperRewardTest.t.sol`:

- All 4 config setter happy paths + 4 default-fallback reads (multBps defaults 20000, spread defaults 500, twap defaults 1800).
- Bound enforcement (5 tests): multBps below 10000, multBps above 100000, spread below 100, spread above 2000, all revert.
- Access control (2 tests): non-admin caller for `setKeeperRewardMultBps` + `setKeeperRewardEnabled` both revert.

### Out of scope (Phase 1)

- **VPFI/ETH LP v3 TWAP pricing path + staleness fallback** — `cfgKeeperRewardTwapMaxAgeSec` slot is reserved but not yet consulted.
- **`cashOutKeeperReward(messageId)` ETH cash-out path** — spread setter + storage in place; ETH liquidity management not yet wired.
- **Per-facet wiring** — actual `payVpfiReward(...)` calls in housekeeping facets (sweep, force-resend, periodic accrual, mirror catchup) land when each facet's keeper-permissionless mode lands.

### Verification

- KeeperRewardTest 13/13.
- Deploy-sanity 12/12.
- Frontend tsc clean.

## Thread — T-087 Sub 3.A: per-chain remitBuyback + Base BuybackRemittanceReceiver (PR #<n>)

First slice of Sub 3 (treasury buyback umbrella #452). Wires the cross-chain token delivery that moves accumulated `buybackBudget` from mirror chains to Base, where Sub 3.B/C will later commit Fusion intents from it. Intent dispatch + Fusion submission ship in Sub 3.B/C.

### What changes

**On every chain (Base + mirrors)** — `TreasuryFacet` gains the buyback remittance surface:

- `remitBuyback(srcToken, destToken, amount, refundAddress) payable` — ADMIN-gated; debits `s.buybackBudget[srcToken]`, approves the messenger for `srcToken`, calls `CcipMessenger.sendMessage` with a 1-element TokenAmount list and a 32-byte payload carrying `destToken` (the Base-side address) for cross-validation on the receiver. Surplus `msg.value` refunds. The src/dest split (round-1 P1 #2) handles CCIP's pool mapping where the source-chain and Base-side ERC20 addresses differ.
- `absorbRemittance(token, amount, sourceChainId)` — restricted to the registered `buybackRemittanceReceiver`; credits the Base-side **`baseBuybackBudget`** (round-1 P1 #1 — the slot Sub 3.B's `commitBuybackIntent` will spend from) and emits.
- `creditBuybackBudget(token, amount)` — ADMIN-gated allocator; moves `amount` from `s.treasuryBalances[token]` into the appropriate buyback budget slot. **On Base (`s.isCanonicalRewardChain == true`)** → `baseBuybackBudget` directly; **on mirrors** → `buybackBudget` (gated by `buybackAllowedToken[chainid][token]` to prevent stranding funds in a non-bridgeable token, round-5 P2 #2). The fully-automated split-at-accrual-time hook is a Sub 3 add-on follow-up (#472).
- Admin setters: `setBuybackAllowedToken(chainId, token, allowed)`, `setBuybackNoConvert(token, on)`, `setBuybackRemittanceReceiver(receiver)`, `setCrossChainMessenger(messenger)`. The receiver + messenger setters require contract addresses (round-3 P2 #2 — EOA in either slot opens an `absorbRemittance` inflation attack OR strands tokens).
- Public reads: `getBuybackBudget`, `getBaseBuybackBudget`, `isBuybackAllowedToken`, `isBuybackNoConvert`, `getCrossChainMessenger`, `getBuybackRemittanceReceiver`.

**On Base only** — new `BuybackRemittanceReceiver` UUPS contract:

- Implements `ICrossChainMessageRecipient`. Registered as the buyback channel handler on the CcipMessenger.
- Strict-1-token-per-delivery validation; 32-byte payload pin; declared-token cross-validation; tokens forwarded to Diamond BEFORE `absorbRemittance` (round-7 P2 #8).
- **Fee-on-transfer safe** (round-3 P2 #3 + round-4 P2 #1): reads `spendable = balanceOf(this)` to handle pre-callback CCIP fees + reads `actualReceived = postBal - preBal` on the Diamond to handle post-callback transfer fees; absorbs with the actual amount, never the pre-fee `deliveredAmount`. Common tokens without fees see identical behaviour.
- EOA guards on init + `setMessenger` + `setDiamond` (round-2 P2 #2).
- Guardian + owner pause (`GuardianPausable`); UUPS upgradeable; `Ownable2Step` two-step transfer; CCIP guardian wired by `ConfigureCcip._setGuardians` (round-4 P2 #2).

### Per design discussion 2026-06-09

The `buybackNoConvert` flag is the key product decision. ETH from `buyVPFIWithETH` callers must NEVER be remitted cross-chain or treasury-converted — it goes to operational reserve + VPFI/ETH LP seeding (per #455). The flag now blocks BOTH paths uniformly (round-1 P2): `remitBuyback` AND `convertTreasuryAsset` reject the token. Admin marks the relevant WETH / native-mirror addresses with `setBuybackNoConvert(token, true)` after this PR lands.

### Storage additions (append-only)

- `address crossChainMessenger` — the CcipMessenger address. The Diamond is itself the registered channel handler for the buyback channel and calls `sendMessage` directly. This same messenger serves any future cross-chain flow the Diamond originates.
- `mapping(address => bool) buybackNoConvert` — the per-token exemption list.

(`buybackBudget`, `baseBuybackBudget`, `buybackAllowedToken`, `buybackRemittanceReceiver`, `baseChainId`, `isCanonicalRewardChain` already existed from Sub 2 / pre-design landings.)

### Producer artifacts

- `_getTreasurySelectors()` in `DeployDiamond.s.sol` grows from 4 → **17** (13 new selectors: 3 buyback methods including `creditBuybackBudget` + 4 admin setters + 6 reads).
- `HelperTest.sol` mirror grows from 4 → 17.
- `TreasuryFacet.json` regenerated; frontend `tsc -b --noEmit` clean.

### Deploy script wiring (round-2 P1 #1 + round-3 P1 + round-4 P1 + round-5 P2 #1)

- `Deployments.sol` lib: new `writeBuybackRemittanceReceiver` / `writeBuybackRemittanceReceiverImpl` writers.
- `DeployCrosschain.s.sol`: on canonical Base, deploy `BuybackRemittanceReceiver` behind ERC1967 proxy + record both impl + proxy addresses.
- `ConfigureCcip.s.sol`:
  - New `VPFI_BUYBACK_CHANNEL` constant.
  - Ctx gains `localBuybackHandler` (BuybackRemittanceReceiver on Base; the Diamond on mirrors — it's the source-sender).
  - `_registerChannels` registers the buyback channel.
  - `_wireChannelPeers` peers Base ↔ each mirror.
  - `_setGuardians` wires the guardian on the buyback receiver too.
  - New `_wireDiamondBuybackConfig` step calls `setCrossChainMessenger` on every chain + `setBuybackRemittanceReceiver` on Base — without this, `remitBuyback` would revert `CrossChainMessengerNotSet` on mirrors and `absorbRemittance` would reject every inbound on Base.
- `Handover.s.sol`: reads `.buybackRemittanceReceiver` from the deployment JSON and includes it in the cross-chain ownership transfer batch; NEXT STEP printout lists it as a Timelock-accept target.

### Test coverage

22 new tests in `TreasuryBuybackRemittanceTest.t.sol` + 14 new tests in `BuybackRemittanceReceiverTest.t.sol`:

- Admin: every setter happy-path + reject zero + reject non-admin + reject EOA on receiver + messenger setters.
- `remitBuyback` invariants: no-convert / not-allowed / messenger-not-set / zero-amount / zero-refund reverts.
- `absorbRemittance`: sender-only, credits **baseBuybackBudget** (not the per-chain accumulator), additive, event emit.
- `convertTreasuryAsset`: no-convert flag rejection.
- `creditBuybackBudget`: not-admin, no-convert, insufficient-treasury reverts.
- `BuybackRemittanceReceiver` inbound: happy-path forwarding, init guards, EOA guards on init + setters, sender check, token-count validation (0 / 2+ rejection), payload-size pin, token cross-validation, zero-amount rejection, admin rotation.

### Out of scope (Sub 3.B/C/D)

- 1inch Fusion intent commit + dispatch (Sub 3.B).
- Fusion TWAP order shape (Sub 3.C).
- End-to-end CCIP round-trip integration test + FunctionalSpec + Advanced UG (Sub 3.D).

### Out of scope (Sub 3 add-ons, post-design discussion)

- Fee-converted VPFI priority routing (rewards → keepers → staking pool) — #472.
- Productive treasury reserve (Aave WBTC + Lido ETH) — #473.
- Keeper VPFI rewards (2x gas, LP-TWAP-priced, cash-out option) — #474.

### Verification

- 36 new tests green (22 + 14).
- Existing TreasuryFacet 7/7 + TreasuryConvertAndPayroll 24/24 still green.
- Deploy-sanity 12/12.
- Frontend `pnpm exec tsc -b --noEmit` clean.

## Thread — T-087 Sub 3.B: commitBuybackIntent + IntentDispatchFacet (PR #<n>)

Second slice of Sub 3 (treasury buyback umbrella #452). Builds the on-chain intent ledger that the Sub 3.C Fusion submission will plug into. Refactors the 1inch LOP v4 callback surface so the same selectors can route to either order kind without facets fighting for them.

### What changes

#### New surface — buyback intent ledger (TreasuryFacet)

- `commitBuybackIntent(orderHash, token, amountIn, expiresAt)` — ADMIN-gated. Debits `s.baseBuybackBudget[token]`, credits `s.baseBuybackReserved[token]`, records the ledger entry (`token / amountIn / expiresAt / status=Pending`), and stamps `s.orderHashKind[orderHash] = ORDER_KIND_BUYBACK` so the dispatch facet knows to route this orderHash into `LibTreasuryBuyback`.
- `expireBuybackIntent(orderHash)` — permissionless rollback after the deadline. Releases the reservation back to `baseBuybackBudget`, marks the order `Expired`, clears the kind discriminator.
- Public reads: `getBuybackOrder(orderHash)`, `getOrderHashKind(orderHash)`, `getStakingPoolBuybackBudget()`.

#### New library — `LibTreasuryBuyback`

Three internal helpers used by the TreasuryFacet / IntentDispatchFacet wrappers:

- `commitBuyback(orderHash, token, amountIn, expiresAt)` — shape + accounting invariants (zero token / amount / expiry-in-past / amount-overflow / expiry-overflow / orderHash-in-use / budget-insufficient guards).
- `onFill(orderHash, deliveredVPFI)` — called from `IntentDispatchFacet.postInteraction` when the kind is BUYBACK. Releases the source-token reservation, credits the delivered VPFI to `s.stakingPoolBuybackBudget` (Sub 3 add-on #472 will later split between rewards / keeper / staking pool budgets), marks `Filled`, clears the kind.
- `expireBuyback(orderHash)` — past-deadline rollback path. Same teardown as cancel but permissionless.

#### Dispatcher refactor — `IntentDispatchFacet`

New facet that owns the three 1inch LOP v4 callbacks exclusively:

- `preInteraction`, `postInteraction`, `isValidSignature`.

Each arm reads `s.orderHashKind[orderHash]` (stamped at commit time, cleared at every teardown) and dispatches by kind:

- `ORDER_KIND_SWAP_TO_REPAY` → `LibSwapToRepayIntentSettlement` (the T-090 v1.1 GA path, extracted from `SwapToRepayIntentFacet` in this PR).
- `ORDER_KIND_BUYBACK` → `LibTreasuryBuyback`.
- Unknown / cleared kind → `UnknownOrderKind(orderHash)` revert.

`SwapToRepayIntentFacet` no longer owns those selectors — its facet declaration drops `IPreInteraction / IPostInteraction / IERC1271` inheritance, and the four helpers (`preInteraction`, `postInteraction`, `_runSettlement`, `isValidSignature`) move to `LibSwapToRepayIntentSettlement` as internal functions. The facet keeps its borrower-facing commit / cancel / force-cancel surface unchanged; it now also stamps `orderHashKind[orderHash] = ORDER_KIND_SWAP_TO_REPAY` in `commitSwapToRepayIntent` and clears it in every teardown path.

### Why the dispatcher pattern

The 1inch LOP v4 expects to find each callback at the standard signature (`preInteraction.selector`, `postInteraction.selector`, `isValidSignature.selector`). Diamond facets can only own one selector each — so the buyback path can't add its own copy of the callbacks alongside the existing T-090 path. The dispatcher facet owns the selectors; per-kind logic lives in libraries; both paths coexist cleanly.

### Storage additions (append-only)

- `mapping(bytes32 => bytes32) orderHashKind` — per-orderHash discriminator (`ORDER_KIND_SWAP_TO_REPAY` or `ORDER_KIND_BUYBACK`).
- `mapping(bytes32 => BuybackOrderInfo) buybackOrders` — per-order ledger entry (`token / amountIn / expiresAt / status`, packed into 2 slots).
- Constants: `ORDER_KIND_SWAP_TO_REPAY`, `ORDER_KIND_BUYBACK`, status enum values.

### Producer artifacts

- Cuts array grows 49 → 50 (DeployDiamond + SetupTest + DiamondFacetNames). New `IntentDispatchFacet` entry.
- TreasuryFacet selectors 19 → 24 (new commit / expire methods + 3 reads + staking-pool-budget read).
- SwapToRepayIntentFacet selectors 11 → 8 (the three 1inch callbacks moved out).
- IntentDispatchFacet — 3 new selectors (the three 1inch callbacks).
- ABI bundle regenerated; frontend `pnpm exec tsc -b --noEmit` clean.

### Test coverage

18 new tests in `BuybackIntentLedgerTest.t.sol`:

- Commit: happy-path; revert on not-admin / zero-token / zero-amount / amount-overflow / expiry-in-past / budget-insufficient / double-commit.
- Expire: happy-path; revert on not-yet-expired / already-terminal.
- IntentDispatchFacet: `isValidSignature` magic for BUYBACK-pending; `0xffffffff` for unknown + expired; `preInteraction` BUYBACK no-op; `postInteraction` BUYBACK fill credits staking-pool budget + clears kind; `UnknownOrderKind` revert on both pre/post when no kind is stamped.

The existing T-090 path stays green: `SwapToRepayIntentFacetTest` 16/16 passes (one test rewired to call `IntentDispatchFacet.isValidSignature` instead of the now-removed facet method).

### Out of scope (Sub 3.C/D)

- 1inch Fusion intent submission via `apps/agent` (Sub 3.C).
- TWAP order shape (`allowPartialFills` + `expiration`) (Sub 3.C).
- End-to-end CCIP→commit→fill→staker-claim integration test + FunctionalSpec + Advanced UG (Sub 3.D).

### Out of scope (Sub 3 add-ons)

- Fee-converted VPFI priority routing (rewards → keepers → staking pool) — #472. For Sub 3.B all delivered VPFI goes straight to the staking pool budget.

### Verification

- 18 new tests green.
- TreasuryBuybackRemittanceTest (28) + BuybackRemittanceReceiverTest (14) — Sub 3.A regressions still green.
- SwapToRepayIntentFacetTest (16) — T-090 v1.1 still green.
- Deploy-sanity (12) — facet count + selector coverage + collision check all green.
- Frontend tsc clean.

## Thread — T-087 Sub 3.C: Fusion TWAP intent submission via T-090 GA bridge (PR #<n>)

Third slice of Sub 3 (treasury buyback umbrella #452). Wires the actual 1inch Fusion API submission for buyback intents + ships the Fusion-order-template validation that Sub 3.B deferred. The on-chain ledger from Sub 3.B can now produce real on-chain buy pressure: the validated commit makes `isValidSignature` return the ERC-1271 magic value, and the agent posts the order to 1inch's LOP orderbook for solver discovery.

### What changes

**New on-chain validation surface — `TreasuryFacet.commitBuybackIntentValidated`**

Operator passes the full Fusion order template + extension bytes + (amountIn, minVpfiOut, expiresAt). The diamond:

1. Bounds the TWAP window (default 1800s; admin-tunable 600..3600s).
2. Fetches the LOP's EIP-712 DOMAIN_SEPARATOR via staticcall.
3. Validates every field against the canonical buyback shape:
   - `maker == receiver == diamond`.
   - `makerAsset == tpl.makerAsset`, `takerAsset == s.vpfiToken`.
   - `makingAmount == amountIn`, `takingAmount == minVpfiOut`.
   - `makerTraits`: HAS_EXTENSION + PRE_INTERACTION + POST_INTERACTION + ALLOW_MULTIPLE_FILLS all REQUIRED; NO_PARTIAL_FILLS / USE_PERMIT2 / NEED_CHECK_EPOCH_MANAGER / UNWRAP_WETH all FORBIDDEN.
   - Expiration sub-field (bits 80-119) matches `expiresAt`.
   - Salt low 160 bits == uint160(keccak256(extension)) — LOP v4's extension binding.
   - Extension bytes match the canonical layout (preInteractionData = postInteractionData = diamond).
4. Recomputes the LOP v4 orderHash on-chain via EIP-712 and asserts it matches the operator-supplied hash.
5. Reserves the source token via `LibTreasuryBuyback.commitBuyback` (debit budget + credit reserved + grant LOP allowance + bump live-commit counter).
6. Sets `s.buybackValidated[orderHash] = true`.

`IntentDispatchFacet.isValidSignature` now returns the ERC-1271 magic value ONLY for orderHashes where `buybackValidated == true` AND the order is still `Pending` AND `block.timestamp < expiresAt`. Sub 3.B's blanket-invalid for buyback is replaced by validation-gated magic.

### TWAP partial-fill support

Sub 3.B's strict `consumed != amountIn` rejection becomes partial-fill aware:

- `postInteractionImpl` tracks `s.buybackConsumedSoFar[orderHash]` across multiple fills.
- Each partial settles a portion: releases proportional reservation + LOP allowance + credits the per-partial VPFI delta to `stakingPoolBuybackBudget`.
- Cumulative pro-rata minVpfiOut floor (round-1 P2): `s.buybackVpfiDeliveredSoFar[orderHash]` tracks total delivered VPFI; each partial enforces `cumulativeVpfi >= floor(info.minVpfiOut * consumedSoFar / info.amountIn)`. Catches rounding-loss compounding across many tiny partials (per-partial floor-division could otherwise round to zero on each fill and the order could settle below `minVpfiOut`). Early over-delivery can subsidise a later under-delivery; the invariant holds on the cumulative side.
- Order flips Filled only when `consumedSoFar == amountIn`. Earlier partials leave status Pending so subsequent fills re-enter through the dispatcher.
- New event `BuybackIntentClosed(orderHash, token, totalAmountIn)` fires once per orderHash on the FINAL partial. Indexer treats it as the terminal-fill signal.
- The intermediate `BuybackIntentFilled` event now reports per-partial consumed + per-partial actualVpfi (vs. cumulative in Sub 3.B).
- `expireBuyback` releases ONLY the unconsumed portion (`amountIn - consumedSoFar`). Anything already swapped via partial fills stays settled.

### Storage additions (append-only)

- `mapping(bytes32 => bool) buybackValidated` — Sub 3.C validation flag.
- `mapping(bytes32 => uint128) buybackConsumedSoFar` — partial-fill source-token accumulator.
- `mapping(bytes32 => uint128) buybackVpfiDeliveredSoFar` — partial-fill VPFI delivered accumulator (cumulative floor enforcement; added round-1 P2).
- `uint32 cfgBuybackTwapMaxWindowSec` — TWAP window upper bound (default 1800 when 0).

### Producer artifacts

- TreasuryFacet selectors 26 → 32 (6 new: `commitBuybackIntentValidated`, `canonicalBuybackExtension`, `setBuybackTwapMaxWindowSec`, `getBuybackTwapMaxWindowSec`, `isBuybackValidated`, `getBuybackConsumedSoFar`).
- ABI bundle regenerated; frontend tsc clean.

### apps/agent extension

`intentFusionPost.ts` gains a `kind?: 'swap_to_repay' | 'buyback'` discriminator on the request body:

- `'swap_to_repay'` (default for backwards compat) preserves the existing T-090 v1.1 GA bridge: matches `SwapToRepayIntentCommitted` event topic + fetches `getIntentCommit(loanId)` + per-field on-chain recheck.
- `'buyback'` matches `BuybackIntentValidated(bytes32)` event topic only — the on-chain `commitBuybackIntentValidated` already validates every field against the canonical Fusion shape, so the per-field recheck is redundant.

Both kinds POST the same signed-order shape to the same 1inch LOP orderbook v4.1 endpoint. The diamond's `isValidSignature` handles ERC-1271 binding at fill time.

### Test coverage

13 new tests in `BuybackValidatedCommitTest.t.sol`:

- Validated commit happy path → validated flag set, isValidSignature returns magic.
- Field tamper reverts (wrong makerAsset).
- MakerTraits tamper reverts (NO_PARTIAL_FILLS bit set forbidden).
- TWAP window > 30 min reverts.
- `canonicalBuybackExtension()` view matches library.
- Partial fill happy path → accumulates + status stays Pending → final partial flips Filled + clears validated.
- Expire after partial releases only unconsumed.
- isValidSignature returns invalid for: non-validated commits, post-fill orders.
- TWAP window setter: happy path, below min, above max, default fallback.

Sub 3.B's `test_PostInteraction_RevertWhen_PartialFill` rewritten to `test_PostInteraction_RevertWhen_PartialOverflow` — partials are now allowed; only consumed > remaining reverts.

### Out of scope (Sub 3.D)

- End-to-end integration test against a real CCIPMessenger + LOP fork.
- FunctionalSpec + Advanced UG docs.

### Verification

- 13 new Sub 3.C tests + 28 Sub 3.B tests + Sub 3.A regression all green (86 total contract tests in the buyback surface).
- Deploy-sanity 12/12.
- Frontend tsc clean. Agent tsc clean.

## Thread — T-087 Sub 3.D: integration test + FunctionalSpec + Advanced UG (PR #<n>)

Closes out Sub 3 (treasury buyback umbrella #452). Sub 3.A (Base-side absorb) + Sub 3.B (intent ledger + dispatcher refactor) + Sub 3.C (Fusion TWAP + validation + agent) are now wired together by an end-to-end integration test, documented in a new FunctionalSpec entry, and made user-discoverable in the Advanced User Guide.

### What changes

**End-to-end integration test — BuybackEndToEndIntegrationTest.t.sol**

Two tests demonstrating the full buyback flywheel:

- `test_EndToEnd_AbsorbCommitFillCycle` — absorb a Base-side remittance, open a validated commit, simulate a Fusion solver running two partial fills (40% + 60%), then assert terminal invariants: order Filled, kind/validated cleared, LOP allowance fully released, signature now invalid, staking pool budget credited with both partial-delivered VPFI amounts.
- `test_EndToEnd_ExpireAfterPartial_ReturnsUnconsumed` — same start, but only a 30% partial fill, then warp past the deadline and expire. Asserts: 70% returns to budget; the 30% already-swapped portion stays in the staking pool; order marked Expired.

The Fusion-side simulation is a minimal mock that satisfies the LOP DOMAIN_SEPARATOR view and acts as the authorised caller for the diamond's pre/postInteraction hooks. Combined with the unit-level partial-fill tests in BuybackValidatedCommitTest, this gives a complete end-to-end picture of the flywheel without depending on real CCIP routing or a live Fusion solver.

**FunctionalSpec entry — docs/FunctionalSpecs/TreasuryBuyback.md**

Code-free spec covering:

- Per-chain budget accumulation (admin allocator, no-convert list, allow-list, tranche cap).
- Cross-chain remittance flow (CCIP delivery, source vs destination token mapping, fee-on-transfer safety).
- Validated commit lifecycle (on-chain orderHash recomputation, makerTraits binding, canonical extension layout).
- TWAP partial-fill semantics + cumulative pro-rata floor + how constant buy pressure emerges from queued solver auctions.
- Operator-visible failure modes table.
- Staker-facing accumulation in stakingPoolBuybackBudget.
- Out-of-scope deferrals clearly listed (Sub 3 add-ons #472 / #473 / #474, USD-denominated cap with oracle, productive treasury reserve, live Fusion testnet rehearsal).

**Advanced UG addendum — Treasury Buyback Flywheel section**

User-facing primer at the end of `apps/www/src/content/userguide/Advanced.en.md`:

- The three-stage flywheel explanation (accumulate, bridge + commit, deliver).
- What stakers experience TODAY vs. when Sub 3 add-on #472 (priority router) lands: Sub 3 ships the on-chain staging slot only; `claimStakingRewards` still debits the original reward bucket; the staker-facing distribution leg is a separate scoped follow-up.
- Operator-visible failures the public dashboard will surface (budget insufficient vs. tranche cap exceeded).
- The "TWAP design doesn't destabilise the floor" reassurance.

### Producer artifacts

No selector / ABI / cut changes. This slice is integration + docs only.

### Verification

- BuybackEndToEndIntegrationTest 2/2 green.
- All prior Sub 3 unit suites still green (BuybackValidatedCommitTest 15/15, BuybackIntentLedgerTest 28/28, TreasuryBuybackRemittanceTest 28/28, BuybackRemittanceReceiverTest 14/14).
- Frontend + agent tsc clean.

### Sub 3 status

With Sub 3.D merged, the **Sub 3 umbrella (#452) is fully shipped**:

- Sub 3.A (#468, PR #475) — per-chain budget + Base-side absorb + remittance receiver.
- Sub 3.B (#469, PR #476) — intent ledger + IntentDispatchFacet refactor.
- Sub 3.C (#470, PR #477) — Fusion TWAP order template validation + apps/agent extension.
- Sub 3.D (#471, this PR) — integration test + FunctionalSpec + Advanced UG.

The Sub 3 add-ons (#472 priority routing, #473 productive treasury reserve, #474 keeper VPFI rewards) remain queued as scoped follow-ups; they layer onto the Sub 3 core but are not gating for production readiness.

## Thread — T-087 Sub 4 phase 2 — Stake VPFI CTA + chain-switcher + manual tier-poke button (PR #<n>)

Frontend UX completion of T-087 Sub 4. Phase 1 (#482) shipped the contract foundation (`pokeMyTier()` selector + tracked-tier getters), the user-scoped `useEffectiveDiscount` hook, and the LenderDiscountCard "min-history pending" copy. This phase 2 ships the dashboard-side surface that uses all of it.

### What changes

**New `StakeVPFICTA` component on the Dashboard**

A self-hiding card that renders ONLY when the user has a tier-related action to take:

- **On a mirror chain**: shows "VPFI staking is managed on {canonical}. Switch chains to stake or check your tier." + a one-click "Switch to {canonical}" button (uses `useWallet().switchToChain`). Without this, a user landing on a mirror with no stake had no on-ramp to staking — they had to manually find the chain switcher in the topbar.

- **On the canonical chain, no stake yet**: shows "Stake VPFI on this chain to start earning a discount on the protocol's yield fee. Higher tiers unlock higher discounts; the current thresholds are listed on the Buy VPFI page." + a "Stake VPFI now" CTA linking to the Buy VPFI page (where the existing buy + deposit-to-vault flow lives + the live tier table is rendered).

- **On the canonical chain, tier waiting to propagate (min-history pending)**: shows "Tier update pending propagation" notice + a "Push my tier to mirrors now" button wired to `pokeMyTier()`. The button:
  - Fires the contract call via wagmi `useWalletClient().writeContract`.
  - Awaits the receipt via the public client.
  - Reloads the tier data so the dashboard reflects the post-poke state.
  - Surfaces any error inline (warning alert) — no silent failures.

When none of the above applies (settled tier on canonical, or user simply hasn't connected a wallet), the card renders nothing — Dashboard stays uncluttered.

**Wiring**

- Mounted in `Dashboard.tsx` next to `VPFIDiscountConsentCard`. Same visual cluster as the consent toggle since they're tied to the same fee-discount intent.
- i18n strings added under `stakeVpfiCta.*` in `en.json` (other locales fall back to English until translator pass).

### Test coverage

UX-only PR — no new contract surface. The phase-1 `PokeMyTierTest` covers the on-chain behaviour the button triggers; the component itself is a thin wrapper around hooks + writeContract that's exercised by visual smoke + tsc.

### Out of scope (Sub 5)

- Mounting the same CTA on Offer / Loan pages (the card was scoped to Dashboard for this phase; the cross-page propagation is a separate sub-card).
- Indexer event handlers for `TierPoked` (Sub 5).
- The functional-spec + Advanced UG additions (Sub 5).
- "Your tier is ready — claim on mirrors" CTA variant (waits on Sub 5 indexer + mirror cache polling).

### Verification

- Frontend tsc clean.
- Visual smoke on Dashboard with disconnected wallet (card hidden), connected on Base with no stake (Stake CTA shown), connected on Sepolia (switch-to-Base CTA shown).

## Thread — T-087 Sub 4 — Tier-poke selector + user-scoped EFFECTIVE_TIER hook + LenderDiscountCard polish (PR #<n>)

Frontend completion of T-087's chain-agnostic experience promise — phase 1. This PR lands the foundational pieces; the broader Stake VPFI surface + chain-switcher UX is the phase-2 follow-up.

### What changes

**Contract — new `pokeMyTier()` selector on `VPFIDiscountFacet`**

Permissionless, balance-mutation-free rollup of the caller's VPFI-discount accumulator. Use case: the time-only EFFECTIVE_TIER activation (Sub 1.B P1 #7) — once a user's stake has aged past `cfgTwaMinStakedDaysEffective`, their tier becomes claimable without any balance mutation. `pokeMyTier()` lets them surface that activation to mirror chains via the protocol-funded broadcast path (Sub 2.D) without making a tiny deposit/withdraw round-trip.

- Re-reads `LibVPFIDiscount.trackedVpfiBalance(msg.sender)` and re-stamps the accumulator at the same balance.
- Idempotent: equal-tier broadcasts short-circuit at the broadcast layer, so repeated pokes don't spam mirrors.
- Gated by `whenNotPaused` (consistent with deposit/withdraw); NOT gated by `vpfiDiscountConsent` (a consent-off user can still poke; their broadcast carries `(0, 0)` accurately).
- New event `TierPoked(user, trackedBalance)`.
- Selector wired through `DeployDiamond.s.sol` + `HelperTest.sol`; VPFIDiscountFacet selectors 24 → 25.
- ABI bundle regenerated.

**Frontend — `useEffectiveDiscount(user)` hook**

Generalized version of the per-loan `useLoanLenderDiscount`. Reads the post-gate `(tier, bps)` for any user. Drives every tier-display surface uniformly: dashboard tier widget, LenderDiscountCard, lender-preview hook.

**Frontend — LenderDiscountCard polish (zero-discount reason)**

Sub 1.D round-2 P3 #2 deferral. The zero-effective-discount state was previously surfaced with one blanket "consent enabled, no eligible VPFI" message — conflating two distinct cases:

1. **No VPFI staked**: the existing copy applies — stake to start earning.
2. **Min-history pending**: NEW — the user HAS VPFI in the vault but hasn't aged past `cfgTwaMinStakedDaysEffective`. Time alone activates the tier; no action needed.

The card now distinguishes them via the user's vault VPFI balance (`useVPFIDiscountTier`). When the balance is non-zero but the effective discount is zero, the new `minHistoryPendingTitle` / `minHistoryPendingBody` strings surface — copy explicitly tells the user their tier will switch on automatically.

### Producer artifacts

- VPFIDiscountFacet selectors 24 → 25.
- ABI bundle regenerated.

### Test coverage

3 new tests in `PokeMyTierTest.t.sol`:

- `test_PokeMyTier_HappyPath_WithStake` — staker can poke without balance change; tier preserved; event emitted.
- `test_PokeMyTier_HappyPath_NonStaker` — non-staker can poke (no-op at accumulator level); no revert.
- `test_PokeMyTier_RevertsWhenPaused` — covered by the shared `whenNotPaused` modifier across every facet.

### Out of scope (Sub 4 phase 2)

- **Global "Stake VPFI" CTA** on dashboard / offer / loan pages with one-click chain-switcher to Base.
- **"Tier update in progress" non-blocking notice** after stake/unstake that clears when the next CCIP push lands (polls mirror's `userTierCache` for the new nonce).
- **"Your tier is ready — claim on mirrors"** CTA + the visual poke button (this PR ships the contract surface + i18n strings; the button itself is part of phase 2).

These are coherent visual / UX changes; shipping them together in a phase-2 PR keeps the LenderDiscountCard polish + the contract foundation reviewable independently.

### Verification

- PokeMyTierTest 3/3.
- Deploy-sanity 12/12.
- Frontend tsc clean.

## Thread — T-087 Sub 5 — Functional spec + Advanced UG additions (PR #<n>)

Closes out the T-087 umbrella (#438). Subs 1–4 shipped the contracts + dapp surface; this Sub 5 ships the documentation that captures the user-facing intent + operator runbook.

### What changes

**New `docs/FunctionalSpecs/VPFIDiscountSystem.md`**

Code-free spec covering the full user-facing intent of the VPFI discount system:

- The discount-rights value proposition.
- Tier table (defers literal numbers to live dapp; the on-chain table is governance-configurable).
- Canonical-side lifecycle: stake → TWA → min-history → effective-tier activation → optional pokeMyTier.
- Mirror-side lifecycle: tier propagation via Chainlink CCIP → mirror cache → cached-tier discount at settlement.
- Governance levers + bump semantics (`tierTableVersion`).
- Anti-gaming + anti-drain measures (TWA, min-history, consent-toggle not broadcasting, budget-gated broadcasts, de-dup gate).
- What stakers see across the dapp's surfaces.

The new spec complements the existing `CrossChainTierPropagation.md` (which covers the transport mechanics): this one is "what's the user-facing intent end-to-end", the existing one is "how does the cross-chain push work".

**Advanced UG — new "How VPFI Discounts Work" section**

Inserted before the existing "Treasury Buyback Flywheel" section in `apps/www/src/content/userguide/Advanced.en.md`. Covers:

- "Stake once, discount everywhere" mental model.
- Min-history gate (3 days default; what the user sees during the window).
- Time-weighted (30-day TWA; last 7d × 3, previous 23d × 1).
- Cross-chain propagation invisible to most users; surfaces `pokeMyTier()` for edge cases.
- Consent toggle + the recommended chain-after-disable pattern.
- Tier upgrades + unstakes + mirror staleness.

Plus an "Operator runbook — discount system maintenance" sub-section enumerating the post-deploy actions required for the cross-chain surface to actually work in production:

- Canonical: `VPFITokenFacet.setCanonicalVPFIChain(true)` (the Sub 1.C round-3 P2 #2 deferral that many fork operators trip on), broadcast budget top-up via `ProtocolBroadcastFacet.topUpBroadcastBudget()`.
- Mirrors: `RewardReporterFacet.setRewardMessenger`, `RewardReporterFacet.setBaseChainId`, `ConfigFacet.setMirrorTierMaxAgeSec`.
- Governance: expected broadcast burst on tier-table changes; pre-emptive budget top-up.

### Producer artifacts

Doc-only PR. No contract / ABI / selector changes.

### Indexer

The indexer's `check-event-coverage` script enforces only `state-change/loan-mutation` + `state-change/offer-mutation` categories. T-087's events (`TierPoked`, `ProtocolTierBroadcastSent`, `MirrorTierCacheWritten`, etc.) fall under different categories (`informational/*` or `state-change/mirror-tier-cache`) which aren't enforced. So no indexer changes are required by Sub 5; if state-side surfacing of mirror-tier propagation becomes a product need later, it lands as a separate task.

### Release notes

The final-day assembled release-notes file (`assemble.sh` over the unreleased fragments) is the operational step the operator runs at the next deploy cadence — not in scope for this code PR.

### Verification

- Doc renders correctly in the markdown preview.
- www tsc clean.

### Sub 5 + umbrella close-out

With this PR merged, the T-087 umbrella (#438) is fully shipped:

- **Sub 1** — Base contracts: TWA accumulator + tier resolution + mirror facet removal.
- **Sub 2** — CCIP wiring: TierUpdated + VersionBumped + protocol broadcast budget.
- **Sub 3** — Treasury buyback umbrella (#452): Sub 3.A/B/C/D + add-ons #472/#473/#474.
- **Sub 4 phase 1** — Tier-poke selector + EFFECTIVE_TIER hook + LenderDiscountCard polish (PR #482).
- **Sub 4 phase 2** — StakeVPFICTA dashboard component (PR #483).
- **Sub 5** — Functional spec + Advanced UG (this PR).

## Thread — Intent-based swap-to-repay GA: Fusion resolver-pickup bridge (T-090 v1.1 GA, PR #<n>)

Closes #426. Completes the v1.1 surface that landed across #420 / #421 / #423 / #425 — the GA-completing piece the v1.1 launch deliberately deferred.

The agent worker's `POST /intent/fusion/post` endpoint now contains the upstream `fetch` to 1inch's Fusion resolver-pickup endpoint. When the operator-held `INTENT_FUSION_API_KEY` secret is bound and the dapp's Commit button is re-enabled (post-#431; see the "Known limitation" bullet further down), every committed intent will be forwarded to Fusion and the upstream JSON response will be passed through to the dapp. The atomic surface stays available for borrowers who want predictable timing.

In this PR's as-merged state the dapp's Commit button is hard-disabled and the agent endpoint's `fetch` (when reached) submits orders that Fusion is expected to reject because the required `quoteId` field is missing. Both gates lift when #431 ships; the wire is in place + the operator-side activation steps below complete the secret/binding layer so #431 can ship purely as a dapp + agent payload change.

### POST-MERGE OPERATOR ACTION (required for the bridge to function)

Merging this PR does NOT activate the bridge by itself: the merged code intentionally ships with the `INTENT_FUSION_API_KEY` + `INTENT_FUSION_POST_RATELIMIT` bindings ABSENT from `wrangler.jsonc`. Cloudflare's deploy validation requires every binding's underlying resource (Secrets Store secret + rate-limit namespace) to exist at deploy time, so the bindings cannot be declared until the operator has created the resources in the Cloudflare account. The release artefact is the code change + the documentation of the activation steps.

The full step-by-step guide — with the exact `wrangler` commands, the Cloudflare dashboard fields for the rate-limit namespace, a smoke-test recipe, and a rollback procedure — now lives in [`docs/ops/DeploymentRunbook.md`](../ops/DeploymentRunbook.md) under "T-090 v1.1 GA — intent-based swap-to-repay bridge activation". The release-notes thread describes WHAT each step achieves; consult the runbook for HOW.

Until the operator completes those steps, the merged worker stays in the queued-ack fallback for every commit. The on-chain commit remains the source of truth, borrower-cancel and permissionless-cancel paths both work, and no funds are at risk.

The bridge reuses the **existing** `ONEINCH_API_KEY` secret — the same 1inch developer-portal key `apps/agent/src/quoteProxy.ts` already uses for the `/quote/1inch` route — so the activation is three steps, not four, and no Cloudflare Secrets-Store edit is required:

1. **Enable the Limit Order Protocol Orderbook scope** on the existing `ONEINCH_API_KEY` at <https://portal.1inch.dev/>. Swap Aggregation should already be on (it's what quoteProxy uses); leave it. The key value does not change; the existing binding in `wrangler.jsonc` picks up the new scope on the next upstream request without redeploying.

2. **Register a per-IP rate-limit namespace** named `INTENT_FUSION_POST_RATELIMIT` (30 req / 60s) via the Cloudflare Workers dashboard, capturing the chosen integer namespace id. **Required, not optional**: the agent endpoint's half-activation gate returns `503 rate-limit-not-configured` when the API key is bound but the rate-limit binding is missing, so the bridge stays in the half-activated reject state until BOTH are present.

3. **Re-add the rate-limit binding to `apps/agent/wrangler.jsonc` and `npx wrangler deploy`.** The operator-action comment block in the file (search for `T-090 v1.1 GA (#430)` under `unsafe.bindings`) shows the exact declaration to paste back in.

After step 3 the worker's next deploy goes live with the bridge wired to 1inch's resolver-pickup feed. Cancellation is via reverting `wrangler.jsonc` to its as-merged state + redeploying; the agent short-circuits back to the queued-ack pre-activation state on the next request without losing any in-flight commit.

> **v1.2 #431 follow-up note**: this fragment was authored against the original Fusion v2 resolver-pickup wire (which required a `quoteId` we couldn't produce). The v1.2 follow-up PR switched the upstream to 1inch's Limit Order Protocol orderbook endpoint (`api.1inch.com/orderbook/v4.1/{chain}`), which accepts arbitrary signed orders. The activation sequence above is unchanged — same secret name, same rate-limit binding, same `wrangler deploy` — so operators following this guide get the LOP-orderbook bridge end-to-end. See [`T-090-v1.2-lop-orderbook.md`](T-090-v1.2-lop-orderbook.md) for the wire-change details.

### Other changes this PR introduces

- Per-chain support is gated to the chains 1inch Fusion supports today: Ethereum (1), Base (8453), Arbitrum One (42161), Optimism (10), BNB Chain (56), Polygon PoS (137). Commits on any other chain (including Vaipakam's testnet matrix) short-circuit to a queued-ack with an unsupported-chain note; the on-chain commit remains the source of truth and a borrower cancel after deadline returns custody.
- The Fusion request body matches the `SignedOrderInput` shape Fusion v2 expects: `{ order: LimitOrderV4, signature, extension, quoteId }`. The diamond is an ERC-1271 contract maker, so `signature` is the empty bytes `'0x'` and Fusion's relayer validates against the diamond's `isValidSignature` server-side.
- **Known limitation — `quoteId` not yet integrated.** Vaipakam's commit flow constructs the order shape from on-chain context, not from a 1inch quote round-trip, so the GA wire passes an empty `quoteId`. The Fusion v2 relayer documents `quoteId` as required; upstream is likely to reject these submissions with a 4xx until the v1.2 follow-up (#431) either drives the order through 1inch's quote/build step at commit time OR switches to a non-Fusion 1inch endpoint that accepts arbitrary orders.
- **Commit button disabled in the dapp until #431.** Acknowledging the quoteId limitation, the `SwapToRepayIntentPanel` ships with the Commit button disabled and a clear "expect Fusion-side rejections; use the atomic surface" warning in its place. The button re-enables when #431 lands. The cancel surface stays accessible regardless so any pre-existing live commits can still be recovered.
- **Half-activated agent fails closed on the rate-limit binding.** If the operator binds `INTENT_FUSION_API_KEY` but not `INTENT_FUSION_POST_RATELIMIT` (or vice versa with the API key only), the endpoint returns `503 rate-limit-not-configured` instead of forwarding to Fusion. Forces both bindings to be activated together so the shared API quota is never exposed to ungated spend.
- Payload validation tightened: the agent endpoint now enforces exact-length hex regexes for addresses (`0x` + 40 chars), hashes (`0x` + 64 chars), and the canonical extension (`0x` + 144 chars), plus uint256 decimal-string + range checks for amounts / salt / makerTraits. A non-browser caller that spoofs an allowed `Origin` and pushes malformed payloads is now rejected at the worker boundary before the upstream `fetch` spends API quota.
- The dapp's `SwapToRepayIntentPanel` now reads the agent endpoint's response status. A non-2xx upstream response, a connection failure, or a `queued` status (the operator-pre-activation state) surfaces an error message to the borrower telling them their collateral is in custody and to cancel after the deadline if no fill arrives. Before this change the dapp ignored the response and the borrower had no signal that the Fusion-side pickup never happened.
- The dapp's v1.1-alpha banner inside `SwapToRepayIntentPanel` is removed; the surface is now GA. The "Best-price intent" copy in the Advanced User Guide drops the "(v1.1 alpha)" qualifier and the alpha-status disclosure paragraph. The functional spec `SwapToRepayIntent.md` is updated to describe the agent bridge as the production-ready discovery path with the operator-pre-activation fallback as an explicit edge case.

## Thread — Intent-based swap-to-repay (T-090 v1.1, PRs #412, #420, #421, #423)

T-090 v1.1 lands the second variant of the borrower's swap-to-repay
surface alongside the atomic v1 from T-090 (#403). Where the atomic
surface routes through the protocol's on-chain DEX adapter try-list at
submission time, the v1.1 intent variant commits the borrower's
collateral to a Fusion-style solver auction; solvers compete on price
over a short window and the winning solver fills the order by paying
the loan's settlement legs directly to the diamond, with the canonical
settlement waterfall running atomically with the fill.

The program shipped across four sub-cards, all under parent #389:

- **Design (PR #412)** — twelve rounds of Codex review folded
  approximately seventy architectural findings into the design doc at
  `docs/DesignsAndPlans/SwapToRepayIntentBased.md`. Highlights:
  diamond-as-Fusion-maker pattern with ERC-1271 binding; transient-
  storage baseline tracking in the pre-interaction hook; refcount on
  the canonical extension bytes so concurrent commits sharing the
  layout don't accidentally delete the bytes another live commit
  references; per-chain nonce uniqueness so the bit-invalidator slot
  never collides; live-floor check at fill time on top of the
  submission-time check; LOP-rotation guard refusing config changes
  while any commit is still live.

- **Sub 1 — contracts (PR #420)** — implementation of the design under
  four rounds of Codex review (twelve P1/P2 findings folded). The split
  off `IntentConfigFacet` keeps both it and `ConfigFacet` under
  EIP-170. Scenario-suite cross-facet pre-checks added so test
  harnesses that build their own diamond without the v1.1 facet still
  compile and run. The thirteen state-mutating entry points across
  `RepayFacet`, `RefinanceFacet`, `SwapToRepayFacet`, `PrecloseFacet`,
  `AddCollateralFacet`, `PartialWithdrawalFacet`, `RiskFacet`,
  `RiskMatchLiquidationFacet`, and `DefaultedFacet` now either block
  with `IntentPending` or force-cancel-or-revert before running so
  the protocol's no-double-spend invariant holds for collateral in
  temporary diamond custody.

- **Sub 2 — indexer (PR #421)** — D1 migration `0022_swap_to_repay_intents`
  adds the `swap_to_repay_intents` table indexed on `committed_by` +
  `order_hash`. Four new chain-event handlers in `chainIndexer.ts`
  drive INSERT-or-DELETE against the table; four new participants-
  resolver cases attribute the activity-feed rows correctly (commit
  to the borrower, fill to the borrower-via-lookup, cancel to the
  caller wallet, force-cancel system-side). The `GET /loans/:id`
  route surfaces the live intent projection so the dapp can render
  the pending-state card from a single endpoint.

- **Sub 3 — dapp + agent worker (PR #423)** — `SwapToRepayIntentPanel`
  sibling to the atomic v1 panel; the borrower picks atomic vs intent
  per repayment. Seven rounds of Codex review on this PR alone folded
  approximately twenty-three P1 / P2 findings: full uint40 nonce
  generation; live-config reads for the auction-window bounds and
  the min-output buffer; on-chain fallback to `getIntentCommit` when
  the indexer is unavailable so the cancel surface survives an
  indexer outage; live-floor read from `getPrepayContext` with the
  correct buffer formula; canonical order-hash extraction from the
  receipt logs; an explicit alpha-status banner reflecting that the
  agent's Fusion resolver-pickup upstream is a known follow-up. A
  fifteen-second background poll keeps the panel in sync with
  resolver fills or force-cancels that arrive while the user has the
  page open.

- **Sub 4 — documentation (this PR)** — the load-bearing functional
  specification at `docs/FunctionalSpecs/SwapToRepayIntent.md` (the
  test oracle for the surface); the user-facing description in the
  Advanced Mode user guide; this release-notes thread.

The surface is in **v1.1 alpha** at first launch: the agent worker's
direct push of new intents to the 1inch Fusion resolver-pickup
endpoint is deliberately deferred to a v1.1 GA card so the on-chain
custody primitives can bake first. The Limit Order Protocol does not
expose a discovery feed for solvers to crawl arbitrary on-chain
order registrations; in alpha, a fresh commit's only on-chain
footprint is the Vaipakam-side `SwapToRepayIntentCommitted` event +
the on-diamond order-hash registration. Fusion solvers discover
orders via 1inch's own resolver-pickup feed, which the agent's
deferred `fetch` is the bridge to. Until that bridge is wired,
alpha-era commits should be treated as cancel-or-expire by default;
the dapp's banner recommends the atomic surface for predictable
timing while the alpha runs. The agent endpoint's request shape is
already final so the GA card can wire the upstream `fetch` without
a dapp-side redeploy.

Known follow-ups:

**v1.1 GA card** — load-bearing for the surface to function:

- The Fusion resolver-pickup upstream `fetch` from the agent's
  `POST /intent/fusion/post` to 1inch's resolver-pickup endpoint.
  Until this bridge ships, alpha-era commits should be treated as
  cancel-or-expire by default; the dapp recommends the atomic
  surface for predictable timing in the meantime. This is **v1.1**
  scope — it completes the v1.1 launch, not a v1.2 enhancement.

**v1.2 enhancements** — not load-bearing for v1.1 GA but tracked:

- A cross-chunk in-browser memoization of the orderHash-to-committer
  mapping so the indexer-fallback decode of `SwapToRepayIntentFilled`
  rows always attributes to the borrower even when the Committed
  event lives in an earlier scan chunk.
- Stronger authentication on the agent endpoint beyond the Origin
  header check (rate limiter binding + on-chain commit preflight).
- The Activity-page filter extension that surfaces
  `SwapToRepayIntentForceCancelled` rows in the connected borrower's
  view. Both indexer and browser-fallback paths intentionally record
  the row system-attributed (`actor = null`, only the diamond
  `source` address in args), so the page's wallet-participant filter
  drops them for the borrower regardless of which decode path
  produced the row. The follow-up extends the `LoanDefaulted`
  special-case in the page's filter to include the v1.1 force-cancel
  event so the borrower's view shows the row joined to the loan
  they recognise.

Closes #416, closes #417, closes #418, closes #419.

## Thread — Activity feed surfaces force-cancel rows to affected borrowers (T-090 v1.2 #429, PR #<n>)

Closes #429. Closes the visibility gap on the T-090 v1.1 intent surface for the system-attributed `SwapToRepayIntentForceCancelled` event.

When a lender-protection action force-cancels a live intent (HF liquidation, time default, internal-match liquidation), the protocol emits `SwapToRepayIntentForceCancelled` deliberately system-attributed: the indexer's participants resolver returns `actor = null` and the browser-fallback decoder records empty participants. The downstream `LoanLiquidated` / `LoanDefaulted` / `PeriodicInterestAutoLiquidated` event carries the activity-feed attribution for the lender-protection action that drove it. But that left a gap in the Activity page filter: the borrower's wallet-participant filter dropped the force-cancel row, so the borrower had no signal that their pending intent disappeared right before a liquidation.

`apps/defi/src/pages/Activity.tsx`'s wallet-filter loop already special-cased `LoanDefaulted` by checking the event's `args.loanId` against a `useUserLoans`-derived loan-id set — the same fix shape Codex flagged for the force-cancel event across the v1.1 review rounds. Extended the special-case to also match `SwapToRepayIntentForceCancelled` against the same set. The connected borrower now sees the force-cancel row joined to the loan they recognise on both decode paths (indexer + browser fallback).

The loan-id-membership lookup keys on the borrower-position-NFT holder via `useUserLoans`, so the surface stays correct after a position-NFT transfer: the row surfaces for whoever currently holds the NFT, not the origination address. No indexer schema or contract-side changes — pure Activity-page filter extension.

## Thread — Agent endpoint on-chain commit preflight (T-090 v1.2 #428, PR #<n>)

Closes #428. Hardens the agent worker's `POST /intent/fusion/post` endpoint against shape-valid-but-fake commits that could spend the shared 1inch Fusion API quota on never-existed orders.

The endpoint's pre-existing gates — `Origin` allow-list, per-IP rate-limit binding, maker/receiver-bound-to-diamond, exact-length hex payload validation, half-activated fail-closed — bounded the noise from misconfigured browser callers and limited the spend rate. None of them proved that the commit actually happened on-chain. A non-browser caller spoofing an allowed Origin could still push shape-valid commits whose `orderHash` was never registered, burning the Fusion API quota at the upstream rejection.

This PR adds a multi-step on-chain commit preflight at the agent boundary, gated behind `INTENT_FUSION_API_KEY` being bound so the as-merged pre-activation deploy doesn't spend RPC quota on requests that would short-circuit to a queued-ack anyway.

When the API key IS bound, the handler:
1. Looks up the per-chain RPC URL via the same pattern `buyWatchdog.ts` uses (`RPC_BASE`, `RPC_ETH`, etc.).
2. Fetches the `commitTxHash` receipt. viem's `getTransactionReceipt` **throws** when the hash isn't on the chain — the preflight catches `TransactionReceiptNotFoundError` specifically and returns `400 commit-tx-not-found` (the abuse case). Genuine RPC connectivity errors (everything else) degrade gracefully with a warn log so the user-facing path isn't blocked on operator RPC health.
3. Verifies the receipt has `status: 'success'`.
4. Scans the receipt logs for a `SwapToRepayIntentCommitted` event emitted by the canonical Vaipakam diamond on the request's chainId, with the indexed `orderHash` (topic[2]) matching the body. Mismatch → `400 orderhash-not-in-commit-tx`.
5. **Reads `getIntentCommit(loanId)`** from the diamond (the loanId comes from the matched event's topic[1]) and verifies EVERY field of the submitted `order` body matches the on-chain record — `maker`, `receiver`, `makerAsset`, `takerAsset`, `makerAmount`, `takerAmount`, `deadline`, `salt`, `makerTraits`, `extension`. Mismatch → `400 order-fields-mismatch`. Without this final step, a caller could replay a public commit tx hash but mutate the order fields before they reach Fusion.
6. A `getIntentCommit` revert (the commit was torn down between the tx mining and this request — already filled, cancelled, or force-cancelled) returns `400 commit-no-longer-live`.

Cost when the API key is bound: two RPC calls per request (`eth_getTransactionReceipt` + `eth_call` against the diamond). Bounded above by the existing rate-limit binding (30 req/60s). When the per-chain RPC URL isn't bound, the preflight skips with a warn log and Fusion's server-side ERC-1271 staticcall remains the final backstop.

No dapp-side changes — the request shape is unchanged and the panel's response handling already surfaces 4xx errors from the agent to the borrower.

## Thread — Intent-fallback Filled attribution survives reloads (T-090 v1.2 #427, PR #<n>)

Closes #427. Polish item on the T-090 v1.1 intent-based swap-to-repay surface.

The dapp's browser-fallback `logIndex.ts` scanner (active when `VITE_INDEXER_ORIGIN` is unset or the indexer is down) decodes `SwapToRepayIntent*` events directly from `eth_getLogs`. The Filled handler attributes its row to the committer recorded by the matching Committed handler — a tiny in-scan-Map `orderHash → committedBy` populated when both events live in the same scan chunk. Before this PR, when the Committed event lived in an earlier scan chunk (or before a page reload), the in-scan Map was empty by the time the Filled handler ran and the row was recorded with `participants: []`. The Activity page's wallet-participant filter dropped those rows for the connected borrower, so they couldn't see their own successful intent-based repayment in their activity feed.

`logIndex.ts` now persists the committer map to `localStorage` under the key `vaipakam.intentCommitters.v1`. The Committed handler writes the entry with the deadline-plus-grace expiry boundary — a deliberately pessimistic 90-day window covering returning-borrower replay scenarios that the Sub 1 24h cancel-grace boundary wouldn't reach. The terminal handlers (Filled / Cancelled / ForceCancelled) intentionally do NOT delete the entry inline; an abort mid-scan between the delete and `writeCache` would otherwise replay the same teardown against an empty memo and re-produce `participants: []`. Storage cleanup is the wall-clock sweep's job at scan-start, dropping entries past the 90-day boundary in the same pass that seeds the in-scan Map. Entries are ~100 bytes each so the unswept tail stays bounded.

The change is fallback-only — the indexer path was already correct (the indexer reads `committed_by` from D1 before the row delete that releases it). SSR / non-browser environments short-circuit cleanly because every storage helper guards on `typeof window` AND wraps the `window.localStorage` property access inside the catch so opaque-origin / blocked-policy environments don't escape an exception. The log-index cache key bumps from `v3` to `v4` so any browser that already cached a stale `participants: []` Filled row from the bug re-scans from scratch on the next fallback run.

## Thread — Switch resolver-pickup wire from Fusion v2 to LOP orderbook (T-090 v1.2 #431, PR #<n>)

Closes #431. Resolves the architectural quoteId limitation that left the Commit button hard-disabled on the v1.1 GA surface.

The v1.1 GA wire (#430) routed committed orders to 1inch's Fusion v2 resolver-pickup endpoint, but Fusion v2's `SignedOrderInput` requires a `quoteId` field sourced from a preceding `/quote/build` round-trip. Vaipakam's commit flow constructs the order shape from on-chain context (collateral amount, live floor, canonical extension) rather than from a 1inch quote, so there was no quoteId to pass. The dapp's Commit button shipped disabled with a "v1.2 #431 needed" warning while the activation steps for the API key / rate-limit binding were already in place.

This PR switches the upstream from Fusion v2 to 1inch's **Limit Order Protocol orderbook** endpoint (`/orderbook/v4.0/{chain}`). The LOP orderbook accepts arbitrary signed orders without requiring a preceding quote; resolvers (any party watching the public LOP orderbook) pick up the order based on profitability. ERC-1271 validation against the diamond's `isValidSignature` continues to happen the same way at fill time — the protocol's resolver staticcalls the maker contract with the canonical orderHash, and the diamond's hook returns the magic value because the orderHash matches its registered commit.

Wire changes:
- Endpoint URL: `https://api.1inch.com/fusion/relayer/v2.0/{chain}/order/submit` → `https://api.1inch.com/orderbook/v4.0/{chain}`.
- Request body shape: dropped the Fusion-specific `SignedOrderInput` (with its `quoteId` requirement) for the orderbook's flatter shape — `orderHash` + `signature: '0x'` at top level, the order fields nested under `data`.
- No changes to the agent's on-chain preflight (#428): receipt fetch + `getIntentCommit(loanId)` field-by-field comparison still runs before the upstream submit.
- No changes to the rate-limit binding, Origin gate, payload validation, half-activated fail-closed, chain allow-list, or maker/receiver-bound-to-diamond checks.

Dapp changes:
- `SwapToRepayIntentPanel`: removed the `true` hard-disable from the Commit button's disabled list. The remaining disable conditions are the substantive ones (unsupported chain, missing `VITE_AGENT_ORIGIN`, not the connected borrower, submitting / action-loading state).
- The Commit button is back, gated only on the operator-side activation (binding `INTENT_FUSION_API_KEY` + `INTENT_FUSION_POST_RATELIMIT` per the activation steps from the GA release notes).

Advanced UG: removed the "Known limitation today" sub-bullet that explained the quoteId rejection. The "When to use it" bullet no longer references a pending follow-up.

The `INTENT_FUSION_API_KEY` secret name is preserved across the wire change so operators don't need to re-rotate a freshly-named secret; the LOP orderbook endpoint accepts the same 1inch developer-portal key as the Fusion endpoint did.
