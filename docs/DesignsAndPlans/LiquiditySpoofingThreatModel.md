# Liquidity Spoofing Threat Model

## Purpose

This design note covers a liquidity-depth manipulation attack against Vaipakam's
liquid / illiquid classification and depth-tiered LTV model. The concrete
scenario is a malicious actor temporarily creating or funding an AMM pool, making
an otherwise weak asset appear liquid, inducing victims to lend or borrow against
that asset, then removing depth or dumping the asset after positions open.

The goal is to make this attack expensive, slow, visible, and unable to grant
high-risk assets favorable treatment from a short-lived pool state.

## Background

The current functional spec already requires a liquid ERC-20 asset to have:

- a usable Chainlink-led active-network price path;
- a slippage-at-floor route over configured V2 / V3 pool families and quote
  assets;
- pool spot agreement with the trusted oracle path;
- recent average agreement where usable pool history exists;
- fail-closed handling when pricing or liquidity checks fail;
- an effective depth tier equal to `min(onChainTier, keeperConfidenceTier)`.

Those rules defend against many shallow-pool and spot-price manipulation attacks.
They do not, by themselves, fully solve short-lived real liquidity. An attacker
can temporarily supply genuine depth, pass a current-block liquidity check, and
then withdraw that depth after offer creation or loan initiation.

## Threat Scenario

1. Attacker creates or identifies a weak ERC-20 asset.
2. Attacker seeds a Uniswap-style pool with enough temporary depth near the
   trusted oracle price, or concentrates liquidity around the current tick.
3. The asset passes a naive current-state depth check.
4. A borrower posts or accepts offers using the asset as collateral, or a lender
   accepts exposure to that asset.
5. The attacker withdraws liquidity, dumps inventory, disables transferability,
   or otherwise leaves the market unable to support liquidation.
6. Victims hold a loan whose original "liquid" assumptions no longer match the
   exit market.

The highest-risk victim path is a lender who funds a borrower against spoofed
collateral. The lender expects liquidation or default recovery through a liquid
route, but the collateral becomes unmarketable before liquidation.

## Security Objectives

- A pool that is deep for only a short window must not upgrade an asset into a
  high tier.
- Offer creation must not permanently bless an asset if liquidity disappears
  before acceptance.
- Loan initiation must snapshot the effective risk state used for admission.
- Keeper and off-chain confidence signals may reduce an asset's effective tier
  quickly, but must never raise it above on-chain measurement.
- Users must see a clear warning when an asset is new, thin, single-venue, or
  confidence-limited.
- If the system cannot determine durable liquidity, it must classify the asset
  conservatively or require the illiquid-risk path.

## Design Requirements

### 1. Current-Block Liquidity Is Necessary But Not Sufficient

The on-chain slippage-at-floor check remains the hard minimum gate. A route that
cannot sell the configured floor size within the configured slippage budget must
not be treated as liquid.

However, passing the current-block check should only establish an
`observedOnChainTier`. It should not automatically establish the `effectiveTier`
used for LTV or risk-access decisions.

### 2. Effective Tier Uses A Confidence Floor

The effective tier remains:

```text
effectiveTier = min(observedOnChainTier, keeperConfidenceTier)
```

The keeper confidence tier is a conservative floor derived from off-chain
durability checks. It can demote immediately. It can promote only after the asset
has passed the configured observation window.

Recommended initial policy:

| Condition | Keeper confidence result |
| --- | --- |
| No keeper observation exists | Tier 1 maximum, even if on-chain tier is higher. |
| Current route fails floor check | Tier 0 immediately. |
| Pool age below minimum | Tier 0 or Tier 1 maximum, depending on governance mode. |
| Single venue only | Tier 1 maximum unless governance explicitly accepts single-venue risk. |
| Dominant LP concentration above threshold | Tier 1 maximum or Tier 0. |
| Stable passing observations across window | May promote up to observed on-chain tier. |

The keeper must never raise above the tier currently proven by the on-chain
route and manipulation guards.

### 3. Promotion Is Delayed, Demotion Is Fast

Promotion from illiquid / low tier to a higher tier must require durable
observations. The observation window should include both elapsed time and sample
count.

Example defaults for mainnet tuning:

- minimum pool age: 24 hours;
- minimum observation window before Tier 2: 6 hours and 12 samples;
- minimum observation window before Tier 3: 24 hours and 48 samples;
- Tier 3 / blue-chip promotion should require multi-venue or deep canonical
  venue evidence;
- any failed current route, large slippage jump, oracle divergence, or pool
  history failure demotes immediately.

These values are intentionally governance-tunable. The invariant is asymmetric:
promotion is slow, demotion is immediate.

### 4. Revalidate At Acceptance And Loan Admission

Offer creation should not be enough. Any path that creates a live loan must
recompute or re-read the current effective tier at admission:

- direct offer acceptance;
- keeper-driven matching;
- refinance / preclose replacement flows that create new exposure;
- lender-sale buyer admission;
- obligation-transfer incoming borrower admission.

If the current effective tier is lower than the tier needed by the offer terms,
the transaction must fail before value moves or route into the explicit
illiquid-consent path where applicable.

This prevents an attacker from creating offers while liquidity is temporarily
healthy and filling them after it disappears.

### 5. Snapshot Risk State On Loan Initiation

Each admitted loan should store the risk state used at admission:

- observed on-chain tier;
- keeper confidence tier;
- effective tier;
- floor sell size used;
- slippage budget used;
- route family / quote asset class used for the winning route;
- timestamp or block of the tier read;
- risk-terms version / config epoch.

The snapshot should not freeze future liquidation behavior in an unsafe way.
It is an audit trail and a terms record. Live liquidations and rescue paths still
use current prices and current route safety.

### 6. New Assets Start Small

New or newly observed assets should have small exposure until they build history.
Recommended caps:

- per-asset aggregate principal cap while confidence is Tier 1;
- per-loan principal cap while confidence is Tier 1;
- no auto-lifecycle enablement by default for new or confidence-limited assets;
- no treasury backstop Role A / Role B support until a separate governance
  allow decision and oracle-coverage requirements pass.

This means a spoofed pool can at most create limited exposure before demotion
or operator review catches it.

### 7. Pool Quality Checks

Keeper / operator checks should record the properties that make liquidity
durable:

- pool age;
- number of independent venues and quote assets;
- LP concentration and recent LP churn;
- depth distribution for V3-style concentrated liquidity;
- token transfer behavior, including fee-on-transfer, blacklist, pause, rebase,
  upgradeability, and abnormal decimals;
- route success through aggregator quotes and direct pool simulation;
- recent realized slippage for representative sell sizes;
- deviation between pool spot, pool average, Chainlink-led price, and secondary
  oracle checks where configured.

Any non-standard token behavior should force illiquid classification unless
governance explicitly designs support for that behavior.

### 8. UI And Operator Surfaces

Create Offer, Offer Book, Loan Details, and operator dashboards should expose:

- current observed tier;
- keeper confidence tier;
- effective tier;
- whether the asset is confidence-limited;
- last healthy observation time;
- pool age warning;
- single-venue warning;
- current route slippage at floor size;
- whether the asset was demoted since offer creation.

Basic mode should not expose every raw metric, but it must show the decision:

- `This asset has limited liquidity history.`
- `Vaipakam is treating this asset as higher risk.`
- `This offer cannot be accepted because liquidity has weakened.`
- `If liquidation cannot execute safely, recovery may fall back to collateral
  in-kind.`

### 9. Governance And Emergency Controls

Governance and guardian roles should have remove-only or risk-reducing controls:

- pause new offers for an asset;
- force keeper confidence tier to `0`;
- disable depth-tiered LTV globally;
- disable a pool factory / quote asset route family;
- lower per-tier LTV caps;
- lower per-asset caps;
- mark a token behavior profile as unsupported.

These controls should not be able to upgrade an asset above measured and
confidence-backed depth.

## Attack Handling Matrix

| Attack | Expected handling |
| --- | --- |
| Concentrated liquidity at spot only | Slippage-at-floor rejects if floor sell cannot execute safely. |
| Pool price moved away from Chainlink-led price | Spot-vs-oracle guard rejects or demotes. |
| Short-lived real liquidity | Promotion delay and keeper confidence floor prevent immediate high tier. |
| Liquidity removed after offer creation | Accept-time / admission-time revalidation rejects or downgrades. |
| Single attacker-controlled pool | Pool age, LP concentration, and single-venue limits cap tier. |
| Chain-specific shallow liquidity | Active-network-only rule treats the asset as risky on that chain. |
| Token blocks transfers or taxes sells | Token behavior checks force illiquid / unsupported status. |
| Keeper unavailable | Fail closed to low confidence; no promotion beyond conservative floor. |

## Implementation Phases

### Phase 1: Spec And Surfaces

- Ratify this design.
- Add functional-spec language for durable liquidity, promotion delay, fast
  demotion, and accept-time revalidation.
- Add frontend copy requirements for confidence-limited assets.
- Add operator runbook requirements for emergency demotion.

### Phase 2: Keeper Confidence Floor

- Implement keeper observations and confidence-tier persistence.
- Add demotion-first update semantics.
- Expose read views for current confidence tier, last observation, and reason
  codes.
- Wire Create Offer / Offer Book / Loan Details to show confidence-limited state.

### Phase 3: Protocol Admission Enforcement

- Re-read effective tier at every live-loan admission path.
- Store loan risk snapshots.
- Enforce per-asset and per-loan caps for low-confidence assets.
- Add governance-bounded configuration for observation windows and caps.

### Phase 4: Tests And Simulations

- Unit-test V2 reserve spoofing, V3 concentrated liquidity spoofing, and
  spot-vs-average divergence.
- Integration-test offer creation during high depth followed by acceptance after
  liquidity removal.
- Fork-test a pool seeded for a short window, then demoted after route failure.
- Test keeper outage behavior: no promotion and conservative tier floor.
- Test token behavior rejection for fee-on-transfer / blacklist / pause cases
  where practical.

## Open Questions

- Should brand-new assets default to Tier 0 or Tier 1 maximum when the keeper has
  not observed them yet?
- Should Tier 3 require multi-venue evidence, or can a single canonical deep pool
  qualify with stronger LP concentration requirements?
- How much token-behavior analysis should live on-chain versus in keeper and
  operator tooling?
- Should existing offers become visibly stale when an asset demotes, or should
  they remain listed but fail at accept with an explicit reason?
- What emergency SLA should operators commit to for demotion after a public
  liquidity incident?

## Acceptance Criteria

- A short-lived spoofed pool cannot immediately grant high-tier collateral
  treatment.
- Any loan-creating path revalidates effective liquidity before value moves.
- Liquidity demotion after offer creation blocks stale offers from becoming
  live loans under old assumptions.
- The keeper can only reduce or slowly promote within the on-chain measured tier.
- Users and operators can see why an asset is confidence-limited or demoted.
- Tests cover temporary depth, pool withdrawal, concentrated liquidity, keeper
  outage, and stale-offer acceptance.
