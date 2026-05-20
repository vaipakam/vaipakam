# ADR-0005: Depth-tiered LTV behind a kill-switch

**Status:** Accepted
**Date:** 2026-05 (Piece B implementation; ADR backfilled 2026-05-20)

## Context

The pre-Phase-7 LTV policy was a single ceiling per asset
(`maxLtvBps`) set by governance config. That works for assets whose
on-chain liquidity is roughly stable, but it under-uses liquidity
when it's deep (e.g. a top-tier asset can safely carry a higher LTV
than `maxLtvBps`) and over-uses it when it's thin (a thinly-traded
asset may not survive a liquidation at `maxLtvBps`).

The "Lend/Borrow at market rate" widget (Piece A, landed Phase 7)
exposed this tension directly: when the matched rate brought
borrowers and lenders together, the LTV ceiling didn't differentiate
between an asset with $50K depth and one with $5M depth — both got
the same cap.

A "depth-tiered LTV" scheme — where the LTV cap depends on the
asset's *current* depth-classification tier — gives the protocol a
liquidity-aware risk surface. But it introduces three new risks:

1. **Tier-classification accuracy**: getting the depth probe wrong
   means handing out a higher LTV than the liquidity supports.
2. **Manipulation surface**: pool depth is on-chain and can be
   inflated transiently. The tier read at loan init must resist
   short-window manipulation.
3. **Operational risk during ramp**: turning on a more aggressive
   LTV system without a way to roll back is a one-way gate. We
   want to ship the surface code, then ramp it on chain-by-chain
   only when each chain's liquidity confidence is established.

## Decision

Adopt **depth-tiered LTV behind a kill-switch**
(`depthTieredLtvEnabled`, default `false`). When the switch is off,
the protocol behaves exactly like the pre-Phase-7 single-ceiling
LTV (HF >= 1.5 at init; `maxLtvBps` cap; HF >= 1e18 threshold
preserved). When flipped on (chain-by-chain, by admin → eventually
timelock), the LTV cap at loan init becomes
`min(maxLtvBps, cfgTierMaxInitLtvBps(getEffectiveLiquidityTier
(collateral)))` and the HF init gate stays at HF >= 1e18.

Components:

- **`LibSlippage`** — fee-aware CPMM price-impact math; V3
  virtual-reserve in-tick approximation (NOT the gas-heavy Quoter).
  Decimal-independent.
- **`OracleFacet.getLiquidityTier / getEffectiveLiquidityTier`** —
  the on-chain tier authority. Best route over `effectivePaa
  Assets() × {Uni/Pancake/Sushi V3} × fee ≤ 0.3%`. Value-balance +
  TWAP-tick guards against manipulation. `effectiveTier =
  min(onChain, keeperTier ∈ {1,2,3})` where `keeperTier` defaults
  to 1 — the keeper can only DEMOTE from on-chain reads, never
  promote unilaterally.
- **`ProtocolConfig`** — depth-tier knobs:
  `liquiditySlippageBps`, `twapWindow / twapBps`, `floorSizePad`,
  `tier{1,2,3}SizePad` (PAD = T-048 Predominantly Available
  Denominator, USD on retail). `MIN_LIQUIDITY_USD` →
  `MIN_LIQUIDITY_PAD`.
- **`Storage.paaAssets[]`** — per-chain quote tokens the depth
  probe looks at; empty ⇒ `[wethContract]`.
- **`KEEPER_ROLE`** + `setKeeperTier` (KEEPER_ROLE) — the keeper-
  side relay can DEMOTE the tier on degradation (immediate effect);
  promotion to Tier-3 also requires an off-chain Aave / Compound
  / Morpho listing + TVL advisory check (advisory, no contract
  impact).
- **`LoanFacet._checkInitialLtvAndHf`** — init-gate enforces the
  tier cap when the kill-switch is on.

Default starting LTVs (when the switch flips on the first chain):
50% / 60% / 65% for Tier-1 / 2 / 3. Tier sizes default $5K floor /
$50K → T1 / $500K → T2 / $5M → T3 @ ≤ 2% slippage. Route fee tiers
≤ 0.3% only.

## Consequences

**Positive**

- Liquidity-aware risk surface: thin-liquidity assets are properly
  capped; deep-liquidity assets are properly utilised.
- The kill-switch + chain-by-chain ramp let the operator gate
  on each chain's actual confidence-window data, not a global
  flip-day.
- Manipulation defence: value-balance + TWAP-tick guards on the
  on-chain tier read; keeper-tier-only-demotes shape means the
  worst a misbehaving keeper can do is force more conservatism.

**Negative / accepted costs**

- Larger storage surface (new `ProtocolConfig` fields,
  `paaAssets[]`, `keeperTier` mapping) and a new role
  (`KEEPER_ROLE`).
- The kill-switch is a configuration knob that an attacker who
  compromised governance could weaponise to grant themselves
  higher LTV. Mitigation: governance flow is admin → timelock at
  mainnet; the timelock window provides reaction time.
- Tier-3 specifically requires an off-chain advisory (Aave /
  Compound / Morpho listing + TVL). The on-chain code doesn't
  enforce this — it's an operator commitment. Mitigation: the
  policy is documented; promotion past Tier-2 by the keeper relay
  is a low-volume, deliberate action.
- The §4.4-step-5 keeper liquidity-confidence relay PROCESS is
  NOT yet implemented — the storage + role landed, the process
  didn't. Acceptable for v1 because the kill-switch defaults to
  off; the process must be in place before the switch is flipped
  on the first chain.

**Risks the decision creates**

- `previewMatch` and Preclose / Refinance HF-recheck paths still
  use the pre-tier HF >= 1.5 math (under-conservative vs the 50%
  Tier-1 cap). A bot could submit a `matchOffers` that reverts at
  the init gate. Audit-prep dependency: align these before the
  kill-switch flips on any chain.
- Tier-3's LTV ramp past its conservative opening figure is gated
  on the liquidator keeper being hardened (faster HF monitoring,
  best/split-route aggregator swaps, partial liquidations,
  flash-loan-funded). Documented as deferred work.

## Alternatives considered

**Alternative A — Per-asset manually-configured LTV ceiling
(status quo)**: Rejected for the reasons in Context — under-uses
deep liquidity, over-uses thin.

**Alternative B — Off-chain oracle reports a tier number**: An
external service (Chainalysis-style, or a custom oracle) publishes
each asset's tier; on-chain consumes it. Rejected because it
introduces a new third-party oracle dependency, an out-of-band
trust assumption, and removes the protocol's own ability to read
its own liquidity. The chosen approach reads the depth directly
on-chain.

**Alternative C — V3 Quoter for the depth read instead of virtual-
reserve math**: Strictly more accurate but ~10-100x more gas. The
in-tick virtual-reserve approximation is well-bounded (sub-tick
moves don't change the tier) and avoids a Quoter call per init
gate.

**Alternative D — Market-cap-based tiers**: Rejected as gameable
(supply can be manipulated by issuance schedule) and a poor proxy
for liquidity at the moment of loan init.

**Alternative E — Ship without the kill-switch (default-on)**:
Rejected. The change is significant enough that a global flip-day
is too risky; chain-by-chain ramping is the operator-safe shape.

## References

- Spec: [`docs/DesignsAndPlans/MarketRateWidgetAndDepthTieredLTV.md`](../DesignsAndPlans/MarketRateWidgetAndDepthTieredLTV.md)
  (§5 = locked decisions, §4.4 = sequencing)
- Source:
  [`contracts/src/libraries/LibSlippage.sol`](../../contracts/src/libraries/LibSlippage.sol),
  [`contracts/src/facets/OracleFacet.sol`](../../contracts/src/facets/OracleFacet.sol),
  [`contracts/src/facets/ConfigFacet.sol`](../../contracts/src/facets/ConfigFacet.sol),
  [`contracts/src/facets/LoanFacet.sol`](../../contracts/src/facets/LoanFacet.sol)
- Tests: `contracts/test/DepthTieredLtv.t.sol` (24 cases)
- Related: ADR-0007 (FunctionalSpecs source rule — `previewMatch` alignment is a spec-vs-code divergence candidate)
