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
| No keeper observation exists | Tier 0; no durable-liquidity credit. |
| Keeper observation is older than the max-age TTL | Tier 0/no-admission; prior promotion expires automatically. |
| Current route fails floor check | Tier 0 immediately. |
| Qualifying-depth window below minimum | Tier 0; pool deployment age alone is not enough. |
| Single venue only | Tier 1 maximum unless governance explicitly accepts single-venue risk. |
| Dominant LP concentration above threshold | Tier 1 maximum or Tier 0. |
| Stable passing observations across window | May promote up to observed on-chain tier. |

The keeper must never raise above the tier currently proven by the on-chain
route and manipulation guards. The effective-tier read used by admission must
check an on-chain observation timestamp or expiry sentinel; keeper-side D1 state
or operator dashboards are not sufficient to expire a promoted tier.

### 3. Promotion Is Delayed, Demotion Is Fast

Promotion from illiquid / low tier to a higher tier must require durable
observations. The observation window should include elapsed time, sample
count, and continuous-depth evidence between samples.

Example defaults for mainnet tuning:

- minimum qualifying-depth age before any nonzero durable tier: 24 hours from
  the first passing floor-sized depth observation, not from pool deployment;
- minimum observation window before Tier 2: 24 hours and 12 samples;
- minimum observation window before Tier 3: 72 hours and 48 samples;
- max age for any promoted keeper confidence tier: 30 minutes without a fresh
  healthy observation;
- Tier 3 / blue-chip promotion should require multi-venue or deep canonical
  venue evidence;
- any failed current route, large slippage jump, oracle divergence, pool history
  failure, material LP churn, or material liquidity removal demotes immediately,
  increments the asset's liquidity-demotion epoch, and restarts the
  qualifying-depth window;
- continuous-depth evidence must come from time-weighted minimum-depth checks,
  LP mint/burn/churn event monitoring, or unpredictable sampling so liquidity
  added only around predictable keeper samples cannot qualify.

These values are intentionally governance-tunable. The invariant is asymmetric:
promotion is slow, demotion is immediate.

### 4. Revalidate At Acceptance And Loan Admission

Offer creation should not be enough. Any path that creates a live loan must
recompute or re-read the current effective tier at admission:

- direct offer acceptance;
- keeper-driven matching;
- all lender-intent fills, including public `OfferMatchFacet.matchIntent` paths that
  materialize a lender slice before initiating the loan;
- refinance / preclose replacement flows that create new exposure;
- lender-sale buyer admission;
- obligation-transfer incoming borrower admission;
- in-place lifecycle extensions or renewals, including auto-extend paths such as
  `AutoLifecycleFacet.extendLoanInPlace`;
- any other current or future path that can materialize, renew, or lengthen loan
  exposure from an offer, signed payload, lender intent, matcher action, or
  replacement flow.

This list is intentionally exhaustive for current known admission paths and must
be extended whenever a new path can materialize a loan; no lender-intent,
signed-offer, matcher, or replacement-flow fill is exempt from the same
effective-tier and cumulative-epoch revalidation.

If the current effective tier is lower than the offer creation-time effective
tier, the transaction must fail before value moves, even when the lower tier
would still satisfy the numeric LTV cap. Risk-config compatibility must be
cumulative over the full interval from offer creation to fill: an offer may fill
only if every intervening risk-config change is fill-compatible, or if the
current config exposes a monotonic non-decreasing `fillCompatibleFromEpoch`
floor that is less than or equal to the offer creation-time epoch. That floor
must never be reset behind an intervening incompatible epoch; alternatively,
admission must retain enough epoch history to prove cumulative compatibility.
A stale offer must not be auto-rerouted into the explicit illiquid-consent
path, because the original terms were calibrated against the higher liquid/tiered assumption.
The user must re-author or re-accept fresh terms that explicitly reflect the
current risk state. The same rejection applies when the offer or intent snapshot
predates the asset's latest liquidity-demotion epoch or qualifying-window
restart, even if the asset later re-promotes to the same numeric tier.

This prevents an attacker from creating offers while liquidity is temporarily
healthy and filling them after it disappears.

`fillCompatibleFromEpoch` is a risk-config storage value updated only by the
risk-governance path that publishes liquidity-tier parameters. It is monotonic
non-decreasing. A governance action that changes floor sizes, slippage budgets,
route families, tier caps, or other admission-critical parameters must either
advance the risk-config epoch without moving this floor past incompatible prior
epochs, or explicitly mark the new epoch as fill-compatible. Admission compares
the offer/intent creation epoch against this floor or against retained epoch
history before any value moves.

### 5. Snapshot Risk State On Offers And Loan Initiation

Every offer and standing lender intent, including signed off-chain offers that
exist only as EIP-712 calldata until fill time, should bind the risk state
visible at creation or registration so the Offer Book, intent fill, and accept
review can compare current risk against the author's original assumptions:

- creation-time observed on-chain tier;
- creation-time keeper confidence tier;
- creation-time effective tier;
- floor sell size used;
- slippage budget used;
- concrete winning route identity or route hash, including pool address,
  factory, fee tier, quote asset, and path hops;
- timestamp or block of the tier read;
- risk-terms version / config epoch, with cumulative admission rejection when
  any intervening risk-config epoch is not fill-compatible, or when the current
  monotonic `fillCompatibleFromEpoch` floor is newer than the offer/intent
  creation-time epoch;
- asset liquidity-demotion epoch or qualifying-window-start marker, with
  rejection when the current marker is newer than the offer/intent snapshot;

The signed-offer EIP-712 payload must carry these snapshot fields. If the
existing typed data cannot carry them, the implementation must introduce an
explicit schema-version cutoff that blanket-invalidates pre-snapshot signed
orders involving the asset until they are re-signed with the new fields. Legacy
signatures cannot be selectively checked for demotion because they carry no
creation-tier or creation-epoch value.

Pre-snapshot on-chain offers and standing intents must likewise require
cancellation and re-authoring/re-registration before fill; zero or empty
snapshot fields must not default into compatibility.

Each admitted loan should also store the risk state used at admission:

- observed on-chain tier;
- keeper confidence tier;
- effective tier;
- floor sell size used;
- slippage budget used;
- concrete winning route identity or route hash, including pool address,
  factory, fee tier, quote asset, and path hops;
- timestamp or block of the tier read;
- risk-terms version / config epoch.

These snapshots should not freeze future liquidation behavior in an unsafe way.
They are audit trails and terms records. Live liquidations and rescue paths still
use current prices and current route safety. A post-admission demotion must not
make an otherwise healthy borrower liquidatable solely by lowering the loan's
admitted liquidation threshold. Instead, demotion should block new admissions,
block or tighten unsafe discount/swap liquidation paths that depend on the old
depth assumption, and route affected open loans into an explicit safe-mode or
rescue treatment. The admitted liquidation threshold remains in force unless a
separate borrower-protective safe-mode rule is explicitly defined.

### 6. New Assets Start At Tier 0

New or newly observed assets receive no durable-liquidity credit until keeper
observations satisfy the promotion window. Implementations should add an explicit
`hasKeeperObservation`/observation-expiry flag or equivalent sentinel so
"never observed" and "explicitly Tier 1" are distinguishable; changing a
zero-default keeper tier into Tier 0 by implication is not acceptable without a
separate migration plan for existing deployments.

The observation universe must include
pending offers, signed-order/indexer feeds, standing lender intents, requested
collateral assets, and governed candidate assets, not only assets already
backing live loans. A first live loan must not be the seed
that creates its own durability history.

Capacity controls are mandatory for every measured tier, not only Tier 1:

- per-asset aggregate principal caps derived as a governance-bounded fraction of
  the measured floor/tier depth, net of already-open exposure;
- per-loan principal caps derived as a smaller governance-bounded fraction of
  the measured floor/tier depth, so one loan cannot consume the whole measured
  exit route;
- no auto-lifecycle enablement by default for new or confidence-limited assets;
- no treasury backstop Role A / Role B support until a separate governance
  allow decision and oracle-coverage requirements pass.

This means a spoofed pool cannot create immediate liquid-collateral exposure;
only assets with durable observations can move into capped nonzero tier
treatment, and aggregate exposure cannot exceed the depth actually measured for
that tier.

### 7. Pool Quality Checks

Keeper / operator checks should record the properties that make liquidity
durable:

- qualifying-depth age, measured from the first passing floor-sized depth
  observation and reset by material liquidity removal or LP churn;
- number of independent venues and quote assets;
- LP concentration and recent LP churn, with material churn thresholds defined by
  governance or left explicitly as a ratification item before code;
- depth distribution for V3-style concentrated liquidity;
- token transfer behavior, including fee-on-transfer, blacklist, pause, rebase,
  upgradeability, and abnormal decimals;
- route success through aggregator quotes and direct pool simulation;
- recent realized slippage for representative sell sizes;
- deviation between pool spot, pool average, Chainlink-led price, and secondary
  oracle checks where configured.

Transfer-restrictable or mutable token behavior is not merely an illiquid-risk
case. Fee-on-transfer, blacklistable, pausable, rebasing, upgradeable,
sell-taxed, or otherwise non-standard collateral should be unsupported for new
collateral unless a specific on-chain support mechanism exists. Assets with
admin-controlled mutability should be banned by default unless the mutability is
irrevocably disabled or the support mechanism continuously monitors the token
and can freeze new admissions plus route existing loans into safe-mode/rescue
treatment on behavior change. Treating these assets as merely illiquid is
insufficient because the illiquid fallback still relies on later in-kind transfer
and usable recovery.

### 8. UI And Operator Surfaces

Create Offer, Offer Book, Loan Details, and operator dashboards should expose:

- current observed tier;
- keeper confidence tier;
- effective tier;
- whether the asset is confidence-limited;
- last healthy observation time;
- qualifying-depth age warning;
- single-venue warning;
- current route slippage at floor size;
- whether the current effective tier is below the offer creation-time snapshot,
  making the offer stale and unacceptable until re-authored.

Basic mode should not expose every raw metric, but it must show the decision:

- `This asset has limited liquidity history.`
- `Vaipakam is treating this asset as higher risk.`
- `This offer cannot be accepted because liquidity has weakened.`
- `If liquidation cannot execute safely, recovery may fall back to collateral
  in-kind.`

### 9. Governance And Emergency Controls

Governance and guardian roles should have remove-only or risk-reducing controls:

- pause new offers for an asset;
- force Tier 0/no-admission through an explicit sentinel or separate freeze flag;
  the implementation must not rely on the existing keeper-tier zero default if
  that default maps back to Tier 1;
- enter a safe-mode / freeze that blocks new tiered admissions or forces the
  safest tier, without falling back to a less conservative legacy path;
- remove a specific pool factory or quote-asset route family from future route
  search;
- lower per-tier LTV caps;
- lower per-asset caps;
- mark a token behavior profile as unsupported.

These controls should not be able to upgrade an asset above measured and
confidence-backed depth. Safe-mode means new admissions and in-place extensions
are blocked, stale offers/intents cannot fill, unsafe old-depth discount or swap
liquidation paths are disabled or tightened, affected users are warned, and
ordinary borrower-protective exits such as repay, add collateral, and claim flows
remain available where safe.

The ordinary depth-tiered-LTV disable switch is explicitly not an
incident-response control for liquidity spoofing. Unless it also enforces the
safe-mode behavior above, disabling tier checks could fall back to a less
conservative legacy admission path.

## Attack Handling Matrix

| Attack | Expected handling |
| --- | --- |
| Concentrated liquidity at spot only | Slippage-at-floor rejects if floor sell cannot execute safely. |
| Pool price moved away from Chainlink-led price | Spot-vs-oracle guard rejects or demotes. |
| Short-lived real liquidity | Promotion delay and keeper confidence floor prevent immediate high tier. |
| Liquidity removed or tier demotes after offer creation | Accept-time / admission-time revalidation rejects stale tiered offers, even if lower-tier LTV would pass. |
| Single attacker-controlled pool | Qualifying-depth age, LP concentration, and single-venue limits cap tier. |
| Chain-specific shallow liquidity | Active-network-only rule treats the asset as risky on that chain. |
| Token blocks transfers or taxes sells | Token behavior checks mark the asset unsupported for new collateral and monitor supported assets after admission. |
| Keeper unavailable | Promoted confidence expires by TTL and fails closed to Tier 0/no-admission. |

## Implementation Phases

### Phase 1: Spec And Surfaces

- Ratify this design.
- Add functional-spec language for durable liquidity, promotion delay, fast
  demotion, and accept-time revalidation.
- Add frontend copy requirements for confidence-limited assets.
- Add operator runbook requirements for emergency demotion.

### Phase 2: Keeper Confidence Floor

- Implement keeper observations over pending offers, signed-order/indexer feeds,
  standing lender intents, requested collateral assets, governed candidate
  assets, and live collateral.
- Enforce promoted-confidence TTL on-chain through an observation timestamp,
  expiry sentinel, or equivalent automatic no-admission state.
- Add demotion-first update semantics.
- Add max-age / heartbeat expiry for promoted confidence tiers.
- Expose read views for current confidence tier, last observation, and reason
  codes.
- Wire Create Offer / Offer Book / Loan Details to show confidence-limited state.

### Phase 3: Protocol Admission Enforcement

- Re-read effective tier at every live-loan admission or exposure-extension path,
  including direct accepts, signed-offer fills, keeper matches, lender-intent
  fills, refinance / preclose replacements, lender-sale buyers, obligation-
  transfer incoming borrowers, and in-place auto-extend/renewal paths.
- Store offer and standing-intent creation-time risk snapshots, bind the same
  snapshot into signed-offer typed data or blanket-invalidate pre-snapshot signed
  schemas, and fail stale tiered offers/intents whose current effective tier is
  lower than the creation-time tier, whose cumulative risk-config interval is no
  longer fill-compatible, or whose snapshot predates the latest demotion epoch.
- Store loan risk snapshots with exact route identity/hashes.
- Enforce per-asset and per-loan caps tied to measured depth for every tier.
- Add governance-bounded configuration for observation windows, TTLs, monotonic
  fill-compatible epoch floors or epoch history, explicit keeper-observation
  sentinels, exact Tier 0/no-admission sentinels, safe-mode freezes, material
  churn thresholds, and cap fractions.

### Phase 4: Tests And Simulations

- Unit-test V2 reserve spoofing, V3 concentrated liquidity spoofing, and
  spot-vs-average divergence.
- Integration-test offer creation during high depth followed by acceptance after
  liquidity removal.
- Fork-test a pool seeded for a short window, then demoted after route failure.
- Test keeper outage behavior: promoted confidence expires to Tier 0/no-admission.
- Test stale promoted keeper confidence expiring without fresh observations.
- Test token behavior rejection and post-admission monitoring for fee-on-transfer,
  blacklist, pause, upgrade, and tax changes where practical.
- Test cumulative risk-config epoch changes making old offers stale, including
  incompatible-then-compatible epoch sequences and monotonic floor behavior.
- Test live-loan demotion preserving borrower liquidation thresholds while
  blocking unsafe old-depth liquidation/discount paths or entering safe-mode
  handling.
- Test in-place auto-extend/renewal blocked or safe-moded after liquidity
  demotion or confidence expiry.
- Test pre-snapshot on-chain offers, standing intents, and legacy signed orders
  cannot fill without re-authoring under the snapshot schema.

## Open Questions

- Should Tier 3 require multi-venue evidence, or can a single canonical deep pool
  qualify with stronger LP concentration requirements?
- How much token-behavior analysis should live on-chain versus in keeper and
  operator tooling?
- What emergency SLA should operators commit to for demotion after a public
  liquidity incident?
- What concrete thresholds define material LP churn and material liquidity
  removal for each route family?
- Should V2-only liquidity be capped at Tier 1 unless an external TWAP/durability
  mechanism is available?

## Acceptance Criteria

- A short-lived spoofed pool cannot immediately grant high-tier collateral
  treatment.
- Any loan-creating or exposure-extension path, including signed-offer,
  lender-intent, matcher, and auto-extend/renewal fills, revalidates effective
  liquidity and cumulative risk-config compatibility before value moves.
- Any liquidity demotion after offer creation blocks stale offers from becoming
  live loans under old assumptions, even when lower-tier LTV would pass.
- Unobserved assets and expired keeper observations receive no durable-liquidity
  credit.
- The keeper can only reduce or slowly promote within the on-chain measured tier,
  and promoted confidence expires on-chain to Tier 0/no-admission without
  heartbeat.
- Transfer-restrictable or mutable collateral tokens are unsupported unless a
  specific support mechanism exists.
- Users and operators can see why an asset is confidence-limited, stale,
  epoch-incompatible, or demoted.
- Tests cover temporary depth, pool withdrawal, intermittent-liquidity sampling,
  concentrated liquidity, keeper outage, stale-offer acceptance, signed-offer
  risk binding, standing-intent snapshots, lender-intent fills, cumulative
  risk-epoch changes, auto-extend gating, and live-loan demotion.
