# Release notes — 2026-05-14

One thread today, but a big one: the **autonomous tier-LTV layer** —
the missing piece in Vaipakam's "no continuous governance tuning"
positioning. Yesterday's depth-tiered-LTV work made the per-asset
*tier* autonomous (on-chain slippage simulation decides whether an
asset is Tier 1, 2, or 3); today's work makes the *mapping from tier
to LTV* autonomous too, by reading peer lending protocols' on-chain
configs as the calibration signal. Seven phases landed end-to-end:
design, oracle-quorum failed-swap fallback, the peer-read library,
the on-chain cache + permissionless refresh, the loan-init
integration, the pre-deploy mainnet-fork audit tool, and a
governance-configurable safety-box layer that retains an emergency
adjustment lever without re-introducing per-asset governance.

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
[`docs/SlippageCensusGuide.md`](../SlippageCensusGuide.md) now
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

## What stays open

Two items remain on this branch:

- **Flash-loan-funded execution** for the liquidator keeper bot, the
  third item from yesterday's liquidator-hardening list, stays
  BLOCKED on a risk-committee decision about the keeper-incentive
  model. Under the current model the keeper EOA needs zero working
  capital (the diamond does the atomic swap from collateral
  custody), so flash-loans have no clear motivating use case. No
  code path until that decision lands.
- **Per-chain operator workflow**: the pre-deploy census script
  needs to be run against each target chain (Base, Arbitrum,
  Optimism, Ethereum, BNB, Polygon zkEVM in turn) with peer
  addresses verified against current docs; outputs go into the
  audit-package per chain; auditor engagement; risk-committee
  sign-off; per-chain `setDepthTieredLtvEnabled(true)` rollout.
  None of that is code — it's the human workflow the autonomy
  layer feeds into.

The protocol's autonomy story is now end-to-end on the code side.
The audit package is the next gate.
