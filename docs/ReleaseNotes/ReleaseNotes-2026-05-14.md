# Release notes — 2026-05-14

Five threads landed today across the branch
`feat/market-rate-widget-and-tiered-ltv`, all reinforcing the same
strategic story: **Vaipakam's higher-LTV regime is autonomous on
the calibration side AND hardened on the liquidator side, AND the
audit-prerequisite follow-up list is fully closed on the code side**.
Headline tally:

| # | Thread | Commits | Tests added |
|---|---|---|---|
| 1 | Autonomous tier-LTV layer (7 phases) | through `656c502` | +18 LibPeerLTV + 9 ConfigFacet |
| 2 | Pre-deploy audit-package census on 6 chains | `520cc47` | (operational) |
| 3 | Liquidator-buys-at-discount path + flash-loan keeper bot extension | `a63d5ef`, `ee8a773`, `43e5b8f` | +23 + 17 |
| 4 | Operator surfaces: runbooks + protocol-console docs subdomain move | `3882989`, `835cd2a` | (docs only) |
| 5 | Market-rate-widget / depth-tiered-LTV follow-up list closed (items a/b/c/d/e/f) | `d9de20a`, `c80eb7e`, `f73646b`, `7e7a11d`, `230c3f0` | +7 |

Forge regression: **1897 pass / 0 fail / 5 skip** across 90 suites
(the 5 skipped are pre-existing time-locked ratification tests).
All four downstream consumer typechecks (defi frontend, keeper +
indexer + agent workers) green throughout.

**Thread 1** — the missing piece in Vaipakam's "no continuous
governance tuning" positioning. Yesterday's depth-tiered-LTV work
made the per-asset *tier* autonomous (on-chain slippage simulation
decides whether an asset is Tier 1, 2, or 3); today's work makes
the *mapping from tier to LTV* autonomous too, by reading peer
lending protocols' on-chain configs as the calibration signal.
Seven phases landed end-to-end: design, oracle-quorum failed-swap
fallback, the peer-read library, the on-chain cache +
permissionless refresh, the loan-init integration, the pre-deploy
mainnet-fork audit tool, and a governance-configurable safety-box
layer that retains an emergency adjustment lever without
re-introducing per-asset governance.

**Thread 2** — the audit-package pre-deploy census ran against
all 6 target chains (Ethereum, Base, Arbitrum, Optimism, BNB
Chain, Polygon PoS) using the new `SlippageCensusPreDeploy.s.sol`
mainnet-fork tool. Output landed in
[`docs/AuditPackage/pre-deploy-census-2026-05-14/`](AuditPackage/pre-deploy-census-2026-05-14/)
as one CSV per chain plus a README. Ethereum produced a real
peer-consensus Tier 3 = 73.37% (close to the 73% library
default); the L2s mostly fell back to library defaults during
this census window — see the README for the **April 18 2026
Kelp/LayerZero OFT exploit aftermath** context and the
**Aave V4 mainnet-only launch** (2026-03-30) note. Crucially,
the consensus algorithm correctly REJECTED Aave's exploit-
response zero LTVs as "asset deprecated by this peer" and fell
back to library defaults — Vaipakam's autonomy layer passed its
first live stress test essentially without us realising at
census time.

**Thread 3** — flash-loan / liquidator-buys-at-discount path.
Three follow-up sections below: the design + contracts in commit
`a63d5ef`, the Phase-3 keeper-bot extension in `ee8a773`, and the
late-day closure (`43e5b8f`) that lands the per-chain deploy
script + DEX-direct quote service + activates real tx submission
in `apps/keeper`.

**Thread 4** — operator surfaces. Two artifacts so the audit team
and the deploy operator have a coherent paper trail:
[`docs/ops/FlashLoanLiquidatorRollout.md`](../ops/FlashLoanLiquidatorRollout.md)
codifies the 6-step per-chain rollout for the discount path with
a multi-chain address table, troubleshooting matrix, and a 3-tier
snap-off procedure cross-referenced from the incident runbook.
The protocol-console docs were also moved from
`defi.vaipakam.com/protocol-console/docs` to the marketing apex
`vaipakam.com/protocol-console/docs` so public-read explainer
content lives alongside the rest of the indexable copy (the
interactive `/protocol-console` dashboard stays on the
connected-app surface).

**Thread 5** — the
[`MarketRateWidgetAndDepthTieredLTV.md`](../DesignsAndPlans/MarketRateWidgetAndDepthTieredLTV.md)
"NOT done" follow-up list (six items labelled a–f) was the gating
work for flipping `depthTieredLtvEnabled` on any chain. All six
items closed today, mostly by *verifying* that prior work was
already in place but unreflected in the memory + doc — the actual
remaining contract work was tighter than the list suggested.
What did land for real: the `RefinanceFacet` post-rollover gate
catches up to the tier-aware regime (was the last unaligned
init-gate site), the frontend's min-collateral + HF-preview
surfaces consume the new bundle, and a per-chain
`ConfigureV2Factories.s.sol` script ships canonical V2-fork
factory addresses so operators can flip the V2 leg of the
depth-tier route search on without hand-typing each address.

## Why this matters

Every major lending protocol today (Aave, Compound, Maker / Sky)
keeps per-asset LTV under continuous governance review — risk teams
model parameters, DAOs vote on every change, listings happen one at
a time. That's the "governance is load-bearing" model. The
alternative model (Liquity's original design) sets one immutable
collateralization ratio at deploy and never changes it. Vaipakam
positions between the two: parameters are *data-derived* from the
universe of peer protocols, refreshed *permissionlessly* on-chain,
*bounded* per tier so peer governance attacks can't push our values
into unsafe territory. The autonomy is genuine — anyone can call the
refresh; nobody can manually override the per-asset assignment — and
the safety net is constitution-level (per-tier floor and ceiling
governance can adjust but only within reason).

The story the protocol tells now:

> "Vaipakam's risk parameters are real-time-data-derived. Depth-tier
> from on-chain pool liquidity. Tier→LTV mapping from peer-protocol
> consensus, refreshed permissionlessly on-chain. Failed-swap
> fallback from the multi-oracle quorum. Three layers of autonomous
> machinery, three layers of sanity-bound safety. The emergency
> multisig retains a kill-switch for the unforeseeable; it never
> sets a parameter."

## The design

The canonical design document is
[`docs/DesignsAndPlans/AutonomousLtvAndOracleFallback.md`](../DesignsAndPlans/AutonomousLtvAndOracleFallback.md).
It compares Vaipakam's approach against Aave, Compound, Morpho-Blue,
MakerDAO, and Liquity; lays out the per-tier safety boxes; specifies
the consensus algorithm across peers and assets; and documents the
two adjacent borrower-protection upgrades that ship alongside the
autonomy core.

The headline rules:

- **Per-tier safety boxes (the constitutional layer).** Each tier's
  LTV must fall in a (floor, ceiling) band: Tier 1 in [37%, 55%],
  Tier 2 in [55%, 69%], Tier 3 in [69%, 82%]. A peer-consensus
  reading outside its tier's band is **rejected**, not silently
  clipped — out-of-band data is treated as signal something's wrong
  with peer state, not a value to use. The boxes are now
  governance-configurable (see "Configurable bounds" below) but
  bounded by validation rules that preserve tier ordering and
  internal consistency.
- **Multi-peer consensus per reference asset.** For each reference
  asset (e.g. WBTC, USDC, LINK), the refresh reads LTVs from each
  configured peer (currently Aave V3 + Compound V3; Morpho-Blue is a
  planned follow-up). The reading contributes to a tier's median
  only if at least two peers agree within 15 percentage points. A
  divergent asset drops out — peer disagreement is the signal.
- **Multi-asset consensus per tier.** Within a tier, at least two
  reference assets must contribute before the refresh accepts a
  new tier-median. A lone outlier asset can't shift a tier's whole
  cap.
- **Per-tier haircut.** After computing the consensus median, the
  refresh subtracts a per-tier haircut: Tier 1 and Tier 2 take no
  haircut (we match peer median), Tier 3 takes 5 percentage points
  (the highest-absolute-dollar exposure justifies the conservative
  margin). The haircut is also governance-configurable, bounded at
  10 percentage points so a misfire can't render the gate vacuous.
- **Cache TTL.** A refresh stamps the cache with the current
  timestamp. Loan init reads the cache value if it's at most 14
  days old; beyond that, it falls back to per-tier library defaults
  (50% / 62% / 73%, sitting at the midpoints of the safety boxes).
  An informational event fires when the cache is between 7 and 14
  days old, so monitors can prompt a refresh.
- **Permissionless refresh.** Anyone can call
  `OracleFacet.refreshTierLtvCache()` at any time. The function
  reads each peer's on-chain config, walks the consensus pipeline,
  and writes the result (or emits a rejection event with a reason).
  There's no admin role; gas cost is the natural rate-limit.

## Oracle-quorum failed-swap fallback (the adjacent borrower-protection upgrade)

This is the smaller of the two shipped pieces but a meaningful
borrower-friendliness improvement. Pre-Phase-2 behaviour: when a
liquidation swap exceeded the 6% slippage ceiling or every adapter
in the keeper's try-list reverted, the protocol fell back to an
oracle-priced fair-value split (lender gets collateral worth the
debt + a 3% bonus, treasury gets 2%, borrower keeps the rest) — and
that path REVERTED the whole liquidation if oracle prices weren't
fresh. Stale oracle → stuck-distressed loan.

The new behaviour catches oracle failure gracefully. If at least one
of the two assets (collateral or principal) has no fresh oracle
reading from the multi-source quorum (Chainlink primary + Tellor +
API3 + DIA secondary), the fallback degenerates to full collateral
to the lender (the existing illiquid-asset behaviour) and emits a
dedicated `LiquidationFallbackOracleUnavailable` event so the audit
package can distinguish "fair-value split worked" from "stale-oracle
fallback ran". The loan settles in either case; it doesn't pin
distressed in Active state.

A new `tryGetAssetPrice` view on the Oracle facet wraps the existing
quorum-priced reader with a no-revert semantic — `LibFallback` uses
it to detect oracle availability before deciding which branch to
run.

## The autonomous tier-LTV machinery

### Peer-read library

The new `LibPeerLTV` library reads each peer protocol's on-chain
config and returns a normalised LTV in basis points. Today it
handles:

- **Aave V3** — via `IPoolDataProvider.getReserveConfigurationData`.
  Returns LTV and liquidation threshold directly in BPS.
- **Compound V3** — via `Comet.getAssetInfoByAddress`. Returns
  1e18-scaled collateral factors; the library normalises to BPS.

The reads use low-level `staticcall` rather than direct interface
calls so the protocol-specific "asset not listed" cases (Aave
returns zeros; Compound reverts) surface as clean `ok = false`
flags without bubbling a revert. Each peer-specific read also
applies plausibility bounds (LTV in [1, 99%]) and protocol-specific
sanity gates (Aave: reserve must be `isActive` and not `isFrozen`;
Compound: returned struct's asset field must match the queried
address) before contributing to consensus.

Morpho-Blue is documented as a Phase-3.5 follow-up — the read pattern
is in place (peer-address storage slot exists), but the asset-list
enumeration story (Morpho is per-market rather than per-asset, so
the aggregator needs a market-id list per chain) is deferred.

### Per-chain peer-protocol addresses

A new owner-only setter (`OracleAdminFacet.setPeerProtocolAddresses`)
configures the three peer addresses on each chain. Set per-chain at
deploy time from each peer protocol's official deployment registry.
Zero addresses skip that peer on that chain (peer not deployed).

The two operator-facing scripts have new homes for this data:

- [`contracts/script/SlippageCensus.chains.json`](../../contracts/script/SlippageCensus.chains.json)
  carries per-chain peer addresses and per-tier reference asset
  lists (Ethereum / Base / Arbitrum / Optimism seeded). README inside
  the JSON flags address-provenance verification as a precondition.

### The on-chain cache + permissionless refresh

The core of the autonomy. New storage per tier: a small struct with
the cached LTV and a last-refreshed timestamp. New function
`OracleFacet.refreshTierLtvCache()` is permissionless — anyone calls
it, the function reads each configured peer + each tier's reference
asset list, runs the consensus pipeline per tier, applies the
haircut, bound-checks against the tier's safety box, and either
persists the new value (emitting `TierLtvCacheUpdated`) or rejects
the attempt (emitting `TierLtvCacheRefreshRejected` with a reason
code: `no-reference-assets` / `insufficient-readings` /
`out-of-band-low` / `out-of-band-high`).

A bad reading on one tier doesn't block clean refreshes of the
other two — each tier is processed independently.

### Loan-init integration

Both gates that consult the tier-LTV cap — `LoanFacet`'s
`_checkInitialLtvAndHf` (called from every `initiateLoan` /
`acceptOffer` / `matchOffers` flow) and `LibOfferMatch`'s synthetic
HF check (the off-chain matcher bot's preview path) — now read
`effectiveTierMaxInitLtvBps`. That reader returns the cached value
when fresh (within 14 days), and falls back to the per-tier library
default when not.

The library defaults shifted as part of this work (they sit at the
midpoints of the new safety boxes):

| Tier | Pre-Phase-5 default | New default | Effect |
|---|---|---|---|
| Tier 1 | 50% | 50% | Unchanged |
| Tier 2 | 60% | 62% | +2 percentage points |
| Tier 3 | 65% | 73% | +8 percentage points |

The shift is intentional — the Phase-4 defaults are peer-derived
medians minus the appropriate haircut, not arbitrary conservative
numbers. The change only takes effect on chains where
`depthTieredLtvEnabled` is `true`; the master kill-switch is OFF by
default on fresh deploys, and remains the emergency lever.

## Mainnet-fork census variant — the pre-deploy audit tool

The new `SlippageCensusPreDeploy.s.sol` script is the audit-prep
counterpart to yesterday's `SlippageCensus.s.sol` (which targets an
already-deployed Diamond). The pre-deploy variant forks a target
chain via Foundry's `--fork-url`, deploys a minimal Diamond into
the fork (just DiamondCut + Oracle + OracleAdmin), wires the chain's
real peer-protocol addresses and reference asset lists from the
JSON config, calls the refresh against the LIVE peer state at the
fork block, and reports per-tier cache values as CSV-friendly log
lines (`CENSUS_PRE`-prefixed).

It answers the question the audit team most cares about: "What
would the autonomous tier-LTV cache settle to on this chain RIGHT
NOW, if we deployed our contracts today?". The output goes into the
audit package alongside the per-asset depth census, the per-chain
peer-address verification, and the relay-bake snapshot. The script
deliberately does not `--broadcast` — pure fork-simulation only.

The operator guide at
[`docs/ops/SlippageCensusGuide.md`](../ops/SlippageCensusGuide.md) now
documents both variants, with the three-checkpoint audit flow
(post-deploy, post-bake, pre-flip rehearsal) intact.

## Configurable safety boxes

The seventh and final phase, added in response to a feedback round:
the per-tier safety boxes (floor / ceiling / haircut per tier) were
hardcoded library constants in phases 3 and 4. Phase 7 makes them
governance-configurable. `ConfigFacet.setTierLtvParams` atomically
updates all three tiers' triples in one call, with three layers of
validation:

- **Per-tier internal consistency**: each tier's floor must be
  strictly below its ceiling, the ceiling must not exceed 100%, and
  the haircut must not exceed 10 percentage points (beyond that
  the gate becomes effectively vacuous).
- **Cross-tier monotonicity**: Tier 1's ceiling must be at most
  Tier 2's floor, and Tier 2's ceiling must be at most Tier 3's
  floor. The boxes don't overlap; tier ordering is preserved.
- **Atomicity**: all three tiers' triples are set in one transaction.
  Governance can't leave the protocol in a partially-updated state
  where the cross-tier invariant is temporarily broken.

The setter is ADMIN_ROLE-gated, which post-handover is the
TimelockController — so every change is 48-hour-delayed. Library
constants serve as the zero-fallback default: a fresh deploy never
touches the storage, the constants drive everything until governance
explicitly overrides.

The intent: the bounds aren't load-bearing on a normal day (peer data
is the source of truth, the cache is the working store), but the
risk committee retains a lever to tighten them if market conditions
move and the original tuning starts looking too permissive. The
emergency kill-switches (`pauseAsset` for per-asset removal,
`setDepthTieredLtvEnabled(false)` for the master flip,
`autoPause(seconds)` for anomaly response) remain untouched.

## What this enables for the audit package

Per the design doc §9, the audit-package for the depth-tiered-LTV
rollout now expands to cover:

1. **Per-chain peer-protocol address verification.** Every
   `(chainId, peer, address)` triple gets verified against the
   peer's official documentation before the pre-deploy census runs.
2. **Bound-enforcement test coverage.** Every refresh-rejection
   reason path is exercised in tests — out-of-band, insufficient
   readings, no reference assets — plus the per-tier safety-box
   bound-check at the setter.
3. **Oracle-quorum-fallback decision tree.** Failed-swap with fresh
   oracle quorum (fair-value path) versus stale quorum (full
   collateral path), both exercised.
4. **Economic analysis of the safety boxes.** Under what peer-state
   conditions does the cache produce a candidate outside its tier's
   box? Answer: only under a peer governance attack or peer
   parameter typo. Both are bounded by the box.
5. **Pre-launch state.** On v1 launch, the cache is empty; the
   loan-init gate reads library defaults. Behaviour is identical to
   "manual governance set the defaults at 50 / 62 / 73 percent",
   minus the manual setter call. Operators run the permissionless
   refresh once peer addresses are wired, and the cache picks up
   real values.

## Verification

- `forge build` clean throughout.
- `forge test --no-match-path "test/invariants/*"`: 1826 passing, 0
  failed, 5 skipped across 89 suites. The 5 skipped are pre-existing
  time-locked ratification tests, unrelated to this work.
- ABI re-export ran cleanly after each phase that touched a public
  surface.
- All four downstream consumer type-checks (defi frontend, keeper
  worker, indexer worker, agent worker) green throughout.

## Liquidator-buys-at-discount path — design + contracts

Later in the same day the risk-committee question on flash-loan
liquidation got unblocked: keep the existing atomic-swap path AND
add a parallel, optional, **liquidator-buys-at-discount** path
following Aave V3 / Compound V3 / Morpho-Blue's industry-standard
model. Both paths stay live; the keeper bot picks per-loan based
on expected profitability, with `triggerLiquidationDiscounted`
reserved for the cases where atomic-swap struggles (deeper
liquidations bumping against the 6% slippage ceiling, illiquid
order books, MEV-style competition by external liquidators that
bring their own buyers).

What shipped today on the contracts side:

1. **Design doc** —
   [`docs/DesignsAndPlans/FlashLoanLiquidationPath.md`](../DesignsAndPlans/FlashLoanLiquidationPath.md)
   captures the full 12-section spec: goal, comparison vs the
   existing atomic-swap path, industry benchmark (Aave / Compound /
   Morpho), per-tier discount safety bounds, the entry-point
   signature + pre-checks + settlement math, the master kill-switch
   shape, the keeper-bot extension strategy, the open-market story,
   failure modes, the 3-phase implementation plan, out-of-scope
   items, and the audit-package additions.

2. **Per-tier discount config** — three new library constants per
   tier (`TIER{1,2,3}_LIQ_DISCOUNT_FLOOR_BPS`, `_CEIL_BPS`,
   `_DEFAULT_BPS`) wired into `ProtocolConfig` and exposed through
   the `effectiveTierLiqDiscountBps(tier)` accessor. Library
   defaults are 7.7% / 6.0% / 5.0% — higher discount for thinner
   tiers (wider liquidator slippage risk → more incentive needed
   to attract competing liquidators). Each tier is admin-
   configurable within its per-tier safety box (Tier 1 ∈ [3%, 15%],
   Tier 2 ∈ [3%, 10%], Tier 3 ∈ [2%, 8%]) via
   `ConfigFacet.setTierLiqDiscountBps(t1, t2, t3)` — atomic for
   all three tiers, cross-tier monotonic invariant enforced
   (`T1 ≥ T2 ≥ T3`).

3. **Master kill-switch** — `ProtocolConfig.discountPathEnabled`,
   default `false`. While off, the new entry-point reverts
   `DiscountPathDisabled` immediately. Independent of
   `depthTieredLtvEnabled` so governance can flip each one per
   chain as audits land. Setter is
   `ConfigFacet.setDiscountPathEnabled(bool)` — ADMIN_ROLE
   pre-handover, TimelockController-gated 48h post-handover.

4. **`RiskFacet.triggerLiquidationDiscounted(loanId, recipient, extraData)`**
   — the new entry-point. The liquidator pays `totalDebt` in the
   principal asset (typically funded via a same-tx flash-loan
   from Aave V3 `flashLoanSimple` or Balancer V2 `flashLoan`); the
   protocol seizes the borrower's collateral at oracle-priced
   debt-plus-discount value and delivers it to `recipient`. The
   borrower's residual collateral stays in their escrow as a
   regular balance — no claim ceremony, just standard escrow
   withdrawal. Loan transitions Active → Defaulted. Same NFT-flip
   to `LoanLiquidated` and VPFI-LIF forfeit-to-treasury as the
   atomic path.

5. **Gates** — identical to the atomic-swap path on the borrower-
   protection axis (Tier-1 sanctions on `msg.sender`, sequencer
   circuit-breaker, HF < 1.0, oracle quorum required on both
   legs). Plus three discount-specific gates: master kill-switch,
   non-zero recipient, tier-classified collateral. Tier 0
   (unclassified) reverts `UntierableCollateral` — the discount
   math is per-tier and undefined for unclassified assets; route
   falls back to the atomic-swap path (Liquid but unclassified)
   or to the time-based default path (Illiquid).

6. **Tests** — 8 RiskFacet discount-path tests covering every gate
   (kill-switch off, zero recipient, loan inactive, sequencer
   unhealthy, HF ≥ 1, untierable collateral, oracle quorum stale)
   plus the happy-path Tier-3 settlement (loan transitions to
   Defaulted, `LiquidationDiscounted` emitted with the precise
   `(totalDebt, collateralSeized, borrowerSurplus)` triple). And
   15 ConfigFacet tests exercising the atomic per-tier setter's
   bound checks (per-tier floors / ceilings, tier-specific revert
   selectors), the cross-tier monotonic invariant including the
   subtle zero-fallback path where a tier-2 zero falls through to
   the library default and is checked against the OTHER two tiers'
   effective values, the kill-switch toggle, role gating, and
   event emission. All 23 new tests pass.

7. **ABIs re-exported** — `ConfigFacet.json` (+144 lines) and
   `RiskFacet.json` (+115 lines) regenerated for the four
   downstream monorepo consumers (`apps/{defi, keeper, indexer,
   agent}`) and the sibling public reference keeper bot
   (`vaipakam-keeper-bot`). All five typechecks pass cleanly.

## What stays open

Two items remain on this branch:

- **Keeper-bot flash-loan branch (design-doc Phase 3)**: wiring
  Aave V3 `flashLoanSimple` + Balancer V2 `flashLoan` into a
  custom receiver contract whose `executeOperation` callback
  calls `triggerLiquidationDiscounted` on the diamond, so the
  keeper EOA needs zero working capital. The contract surface is
  ready and permissionless; the bot integration is a separate
  work item — external MEV-style liquidators can already plug in
  via the public ABI without us shipping the bot first.

- **Per-chain operator workflow**: the pre-deploy census script
  (already run today for all 6 target chains — see
  `docs/AuditPackage/pre-deploy-census-2026-05-14/`) feeds into
  the audit-package per chain; auditor engagement now covers
  BOTH the autonomous tier-LTV layer AND the new discount path;
  risk-committee sign-off; per-chain
  `setDepthTieredLtvEnabled(true)` + `setDiscountPathEnabled(true)`
  rollout (each independent — governance can stage them
  separately). None of that is code; it's the human workflow the
  autonomy + discount-path layers feed into.

The protocol's autonomy story plus the higher-LTV liquidator
hardening are now both end-to-end on the code side. The audit
package + the keeper-bot flash-loan branch are the next two
gates.

## Phase 3 — keeper-bot flash-loan branch (in-flight)

The third item from the
[FlashLoanLiquidationPath.md](../DesignsAndPlans/FlashLoanLiquidationPath.md)
implementation plan: a same-tx flash-loan-funded execution path
for the keeper bot, so the keeper EOA needs zero working capital.
Landed in the same branch:

1. **`contracts/src/keeper/FlashLoanLiquidator.sol`** — the
   on-chain receiver. Implements both the Aave V3
   `IFlashLoanSimpleReceiver` callback shape and the Balancer V2
   `IFlashLoanRecipient` callback. Two owner-gated entry-points
   (`liquidateViaAaveV3` / `liquidateViaBalancerV2`) initiate the
   flash-loan; the shared `_runLiquidation` inner flow approves
   the diamond, calls `triggerLiquidationDiscounted` with
   `recipient = address(this)`, then swaps the seized collateral
   back to the principal asset using off-chain-supplied
   aggregator calldata. Post-swap balance check reverts the whole
   tx if proceeds don't cover debt + flash-loan fee — borrower
   state is preserved on every failure mode. `withdraw` /
   `rescueToken` let the keeper-bot EOA sweep profits.

2. **17 unit tests** — every constructor guard (zero owner, zero
   diamond, both providers missing, Aave-only chain, Balancer-only
   chain), every owner-gate (Aave / Balancer / withdraw — three
   reverts), every callback in-flight guard, the unprofitable-trade
   revert, the swap-target-reverts revert, the provider-not-
   configured branches, and the happy-path settlements on each
   provider with the exact net-profit math asserted. All green.

3. **`apps/keeper/src/flashLoanProviders.ts`** — per-chain table
   of Aave V3 Pool / Balancer V2 Vault / our FlashLoanLiquidator
   deployment addresses. Aave V3 Pool addresses paste in for all
   6 target chains (Eth / Base / Arb / OP / BNB / Polygon PoS);
   Balancer V2 Vault uses the canonical CREATE2 address on every
   chain it's deployed on (all but BNB). The `liquidator` slot is
   `undefined` everywhere — populated per chain after each
   `DeployFlashLoanLiquidator.s.sol` rehearsal lands. The branch
   silently skips chains where the receiver isn't deployed.

4. **`apps/keeper/src/keeper.ts`** — new
   `tryFlashLoanDiscountedPath` branch wired ahead of the
   existing partial / split / atomic decision tree. Three gates:
   per-chain receiver deployed, diamond `discountPathEnabled`
   true (read via env-side `DISCOUNT_PATH_ENABLED_<chainId>`
   override during the staged rollout), and simulated swap
   proceeds exceed `totalDebt + flashLoanFee + gasHeadroom`. v1
   limitation: the existing `ServerOrchestrationResult` quote
   bundle carries diamond-LibSwap-adapter calldata, not
   DEX-direct calldata; the branch logs the would-submit
   decision but defers actual submission until a `dexDirectQuotes.ts`
   service lands. Operator running with the env flag enabled
   sees simulation-positive trades in the logs and validates
   assumptions before we wire the DEX-direct quote service.

5. **ABI re-export** — `FlashLoanLiquidator.json` added to the
   `@vaipakam/contracts/abis` bundle (named export, NOT spread
   into `DIAMOND_ABI` — it's a standalone contract, not a facet).
   `exportFrontendAbis.sh`'s `FACETS` array picks it up so future
   re-exports stay in sync. All four downstream consumer
   typechecks pass.

## Discount path — completion picture

The flash-loan path now exists end-to-end on the code side:
on-chain receiver, unit tests, TS integration, ABI plumbing. Two
operational follow-ups remain:

- Per-chain `DeployFlashLoanLiquidator.s.sol` deployment script +
  rehearsal on testnets, then mainnets, populating each chain's
  `liquidator` slot in `flashLoanProviders.ts`.
- `apps/keeper/src/dexDirectQuotes.ts` — DEX-direct quote
  fetching (0x v2 / 1inch v6 / Balancer V2 SOR) that returns
  `(swapTarget, swapAllowanceTarget, swapCalldata)` instead of
  the diamond-LibSwap-adapter shape, so the simulated-positive
  trades actually get submitted.

Both are scoped, non-blocking, and external liquidators can
already plug in via the public `triggerLiquidationDiscounted`
ABI without waiting for our bot's wiring to finish.

## Phase 3 closure — deploy script + DEX-direct quotes + live submission

Same-day follow-up commit that closes the flash-loan thread. The
Phase 3 work that was scoped-but-deferred earlier today now
lands:

1. **`contracts/script/DeployFlashLoanLiquidator.s.sol`** — per-
   chain deploy script for the `FlashLoanLiquidator` receiver.
   Reads `KEEPER_BOT_OWNER` (CRITICAL: must match the bot's
   `KEEPER_PRIVATE_KEY` derived address in the Worker
   secrets — the deploy reverts on a mismatch downstream),
   per-chain `<CHAIN>_AAVE_V3_POOL` + `<CHAIN>_BALANCER_V2_VAULT`
   env vars (falls back to bare keys for ad-hoc runs), and reads
   the diamond address from this chain's
   `addresses.json`. Writes the deployed receiver address back
   into `addresses.json` via the new
   `Deployments.writeFlashLoanLiquidator` helper; the
   consolidated `deployments.json` merge step picks it up
   automatically. Constructor enforces at-least-one-provider so
   a chain with neither Aave V3 nor Balancer V2 deployed reverts
   at deploy-time rather than shipping an operationally-inert
   receiver.

2. **`packages/contracts/src/deployments.ts`** — new optional
   `flashLoanLiquidator?: HexAddress` field on `Deployment`.
   Chains without it leave the keeper's flash-loan branch
   skipping silently.

3. **`apps/keeper/src/dexDirectQuotes.ts`** — DEX-direct quote
   service returning `(swapTarget, swapAllowanceTarget,
   swapCalldata, expectedOutput)` for collateral→principal
   swaps. v1 coverage: 0x v2 (uses the Permit2 allowance-target
   split) + 1inch v6 (single address for both). Balancer V2 SOR
   direct-quote deferred — most flash-loan-funded trades route
   fine via 0x/1inch alone, and Balancer SOR needs either the
   SDK or a custom solver against the Vault's `batchSwap`
   interface (bigger lift).

4. **`apps/keeper/src/keeper.ts` `tryFlashLoanDiscountedPath`**
   activated — the function now re-fetches quotes with the
   receiver address as taker (the aggregator builds calldata
   tailored per-taker), re-validates profitability against the
   DEX-direct quote, and calls
   `FlashLoanLiquidator.liquidateViaAaveV3` /
   `liquidateViaBalancerV2` for real. The legacy partial /
   split / atomic branches still run as fallbacks if the
   flash-loan submission reverts.

The keeper bot's path-selection logic is now end-to-end on the
code side. Mainnet rollout sequence per chain (operator-side, NOT
code):

1. Set `KEEPER_BOT_OWNER` + Aave V3 Pool / Balancer V2 Vault env
   vars per chain in the deploy environment.
2. Run `forge script DeployFlashLoanLiquidator --rpc-url <RPC>
   --broadcast` per chain. Verify the address in
   `contracts/deployments/<slug>/addresses.json`.
3. Run `bash contracts/script/exportFrontendDeployments.sh` to
   refresh `packages/contracts/src/deployments.json`.
4. Hand-edit `apps/keeper/src/flashLoanProviders.ts`'s per-chain
   `liquidator` slot to match the deployed address (the keeper
   reads a TS-typed config, not the JSON).
5. Set the `DISCOUNT_PATH_ENABLED_<chainId>` env var in the
   keeper Worker's Cloudflare secrets once governance flips the
   on-chain `discountPathEnabled` flag for that chain.
6. Watch keeper logs for `submitted-flashloan` entries.

External liquidators don't need any of the above — they call
`RiskFacet.triggerLiquidationDiscounted` directly on the
diamond, or write their own receiver against
`IFlashLoanSimpleReceiver` / `IFlashLoanRecipient` (both
interfaces are now in `contracts/src/interfaces/`).

## Operator surfaces — runbooks + protocol-console docs subdomain move

Two operator-facing artifacts landed in the same window so the
flash-loan rollout has a coherent paper trail and the docs live
where the audit team expects them.

**`docs/ops/FlashLoanLiquidatorRollout.md`** (commit `3882989`)
— a focused runbook for the per-chain rollout of the new
discount path. Covers preconditions (audit sign-off, governance
flip of on-chain `discountPathEnabled`, keeper EOA gas funds),
6 sequential steps from env setup → deploy →
`exportFrontendDeployments` → `flashLoanProviders.ts` hand-edit
→ Cloudflare secret flip → log watching, plus a multi-chain
address table (Aave V3 Pool per chain, Balancer V2 Vault
canonical), recommended rollout order (testnet first, lowest-TVL
mainnet next, Ethereum last), and a troubleshooting matrix for
the common failure modes (`NotOwner` mismatch, premature
`DISCOUNT_PATH_ENABLED` flip, oracle-stale, etc.). The 3-tier
snap-off procedure (delete keeper-side env flag → pull receiver
from `flashLoanProviders.ts` → flip on-chain
`setDiscountPathEnabled(false)`) is cross-referenced as
[`§3.5 of IncidentRunbook.md`](../ops/IncidentRunbook.md).
[`AdminConfigurableKnobsAndSwitches.md`](../ops/AdminConfigurableKnobsAndSwitches.md)
gains a "Liquidator-buys-at-discount path" section covering
both governance levers: master kill-switch `discountPathEnabled`
+ atomic per-tier discount setter with the safety boxes
T1 ∈ [3%, 15%] / T2 ∈ [3%, 10%] / T3 ∈ [2%, 8%] documented.

**Protocol-console docs moved to the marketing apex** (commit
`835cd2a`). The interactive `/protocol-console` dashboard stays
on the connected-app surface (apps/defi) where wallet-bearing
flows live; the public-read prose reference (`/protocol-console/docs`)
moves to the marketing apex (apps/www) where the rest of the
indexable explainer content (Whitepaper / Overview / User Guide)
lives. Canonical URL becomes
`https://vaipakam.com/protocol-console/docs`. The connected-app
side bookmark-survives via a new `<ExternalRedirect>` component
that `window.location.replace`s to the marketing URL — the old
defi-side URL still resolves. `AdminDashboard.tsx` `docsPath` +
KnobCard `docsBase` + `HelpTabs` "Parameters" tab all cross-domain
via the existing `marketingUrl()` helper.

## Market-rate-widget / depth-tiered-LTV follow-up list — closed

The
[`MarketRateWidgetAndDepthTieredLTV.md`](../DesignsAndPlans/MarketRateWidgetAndDepthTieredLTV.md)
status block before today had six follow-up items labelled (a)
through (f) — collectively the gate on flipping
`depthTieredLtvEnabled` on any chain. Walking through them in
order this afternoon turned up an unexpected pattern: **most
items were either already done or done modulo a small alignment
gap**; the memory's "NOT done" list had drifted out of date.
What actually landed today:

**(c) HF-recheck alignment** (commit `d9de20a`). The
`RefinanceFacet` post-rollover gate was the last init-gate-class
site that still used the legacy `HF ≥ 1.5` + `LTV ≤ maxLtvBps`
check unconditionally. Today it mirrors
`LoanFacet._checkInitialLtvAndHf` exactly: switch-OFF keeps
today's gate; switch-ON caps LTV at
`min(maxLtvBps, effectiveTierMaxInitLtvBps(getEffectiveLiquidityTier(coll)))`
and relaxes the HF floor to `≥ 1.0e18`. `LibOfferMatch.previewMatch`
was already aligned (Phase 5 autonomy work landed both branches);
`PrecloseFacet.transferObligationViaOffer` has no HF revert gate
to align — borrower substitution preserves the loan's economics
by construction. +4 new RefinanceFacet tests on top of the 5
pre-existing LoanFacet init-gate tests.

**(a) Init-gate integration test** (in the same commit `d9de20a`).
Three boundary additions to round out the LoanFacet matrix:
Tier-2 cap at 62%, Tier-3 cap at 73% (the autonomous-LTV cache's
library default, not the original 65% the design draft mentioned),
and a switch-OFF case verifying the init gate ignores the tier
entirely under the kill-switch default. Suite is now 8 tests
across all three tier values + the kill-switch state + HF floor
matrix + Tier 0 collateral.

**(b) Uni-V2 fork route** (commit `c80eb7e`). The contract code,
storage slots, AdminFacet setters, route integration, and three
test cases all already existed (Piece B). What was missing was
the operational layer — every chain ships with the three storage
slots as `address(0)`, V2 leg dormant until governance flips it
on. A new `contracts/script/ConfigureV2Factories.s.sol`
addresses this with canonical V2-fork factory addresses for
Ethereum / Base / Arbitrum / Optimism / BNB Chain / Polygon PoS
(verified against each protocol's docs registry), per-chain env
overrides for non-canonical forks, and an env-example template
block. Operator runs once per chain to flip the V2 leg on.

**(e) Frontend `useProtocolConfig` wiring** (commit `f73646b`).
The `useProtocolConfig` hook already exposed the full
depth-tiered-LTV config bundle + the per-asset `useAssetTier`
hook existed but had no consumer. Today the
`useMarketRateMinCollateral` auto-fill (powers the Lend/Borrow
at market rate widget) and `OfferRiskPreview` (the HF/LTV
preview on CreateOffer + AcceptOffer) consume both: switch-OFF
keeps today's `HF ≥ 1.5` math; switch-ON resolves
`cap = min(maxLtvBps, tierMaxInitLtvBps[effectiveTier])` and
takes the binding constraint between the LTV-cap leg and the
relaxed HF leg. The min-collateral hook exposes two new return
fields (`effectiveLtvCapBps` + `depthTieredLtvEnabled`) so
callers can render tier-aware hints.

**(d) Doc status block refresh** (commit `7e7a11d`). The doc's
status block was several commits behind reality — entries for
(a)/(b)/(c)/(e)/(f) all needed updating with today's commit
hashes, and the original liquidator-bot hardening "BLOCKED on
risk-committee" footer was no longer accurate after the
flash-loan thread landed. Pure doc edit; no contract changes.

**(f) Keeper liquidity-confidence relay** — discovered to be
fully done, not stubbed (commit `230c3f0` corrects the doc).
`apps/keeper/src/liquidityConfidence.ts` is 799 lines of real
implementation: periodic 0x/1inch slippage checks at tier sizes,
D1-backed promote/demote state machine, `setKeeperTier`
submission, and a complete Tier-3 "battle-tested elsewhere"
2-of-3 ensemble (DeFiLlama listing on Aave V3 / Compound V3 /
Morpho with TVL ≥ $10M default + CoinGecko market cap ≥ $1B
default + CoinGecko 24h volume ≥ $50M default). The relay is
wired into the keeper Worker's scheduled cron via
`runLiquidityConfidence`. The previous doc claim that the
advisory was "STUBBED in v1 ⇒ relay caps at Tier 2" was
inherited from a stale memory entry and is now corrected.

## What's actually left

Code side: **NOTHING blocking the audit**. The remaining work
is operational, per the now-accurate
[`MarketRateWidgetAndDepthTieredLTV.md`](../DesignsAndPlans/MarketRateWidgetAndDepthTieredLTV.md):

1. Run `ConfigureV2Factories.s.sol` per chain (V2 leg of the
   route search). Without this, the depth-tier classification
   under-counts long-tail / mid-cap assets that live mostly on
   V2 venues.
2. Re-run the pre-deploy slippage census in 1–2 weeks, once
   Aave's WETH-restoration AIP settles the post-OFT-exploit
   transient. The Arbitrum / Base / Mantle Tier-3 results should
   climb from library-default fallback into real peer-consensus
   values mirroring Ethereum's 73.37%.
3. Auditor engagement — single review covering all three layers:
   autonomous tier-LTV (Phases 1-7 yesterday), depth-tiered-LTV
   route + init-gate (today's market-rate-widget thread), and
   the new liquidator-buys-at-discount path
   (`FlashLoanLiquidationPath.md`).
4. Risk-committee sign-off.
5. Per-chain rollout — see
   [`docs/ops/FlashLoanLiquidatorRollout.md`](../ops/FlashLoanLiquidatorRollout.md).
   Two independent kill-switches per chain: `setDepthTieredLtvEnabled(true)`
   (higher-LTV gate) and `setDiscountPathEnabled(true)`
   (liquidator-buys-at-discount path). Each enabled separately
   so governance can stage them.

The branch is ready for review.
