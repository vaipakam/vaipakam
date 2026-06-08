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
