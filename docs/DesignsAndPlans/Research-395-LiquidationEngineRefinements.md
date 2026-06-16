# Research findings — #395: Position-level / partial liquidation refinements

**Card:** #395 (master sweep #401, Cluster B). **Status:** findings + verdict.
**Verdict:** **ADOPT — small, targeted refinement.** Our engine is already advanced (runtime
close factor, dynamic slippage-based bonus, per-loan bad-debt split, internal-match priority,
sequencer guard). The one worthwhile steal is a **two-tier close factor with a dust floor**
(prevent un-liquidatable dust / stuck bad debt). Defer health-scaled Dutch-auction bonuses.

> External comparison systems referenced generically per the sweep rule.

---

## 1. What we already have (verified 2026-06-16 — more advanced than the card assumes)

- **HF-based liquidation** (`RiskFacet.triggerLiquidation`, HF < 1e18) with an **internal-match
  auto-dispatch priority window** before external swap (≈:526), and a multi-adapter swap
  failover (Phase 7a); on total failure → FallbackPending.
- **Partial liquidation** (`triggerPartialLiquidation` ≈:1132): `fractionBps ∈ (0,
  maxPartialLiquidationCloseFactorBps]`, and the close factor is **runtime-settable**
  (`cfgMaxPartialLiquidationCloseFactorBps`, default 100%). So we already have a *configurable*
  close factor — not a hard-coded 50%.
- **Dynamic liquidation bonus** (≈:663): base = max-slippage (6%) minus realized slippage, capped
  at 3% (`cfgMaxLiquidatorIncentiveBps`), with `assetRiskParams.liqBonusBps` as a per-asset
  ceiling. **Already slippage-scaled, not flat.**
- **Bad-debt / shortfall handling** (`LibFallback.computeFallbackEntitlements` ≈:104): when
  collateral < lender claim, lender gets the full collateral, treasury+borrower zero; oracle
  failure forces full collateral to lender. The loan sits **FallbackPending** with a borrower
  **cure window** (repay / addCollateral) until the lender claims. This is **per-loan bad-debt
  realization** — no cross-loan contagion, which is exactly the modern best practice.
- **Sequencer-uptime guard** blocks liquidation on L2 outage + grace (≈:516).

## 2. External patterns (generic) — steal / avoid

- **Two-tier close factor.** Leading markets liquidate **50% by default, flip to 100% once HF ≤
  ~0.95 or the residual would drop below a dust floor** (≥ ~$1k of both collateral and debt must
  remain, else clear the whole position). This prevents two failure modes our flat-100%-default
  doesn't optimally handle: (a) over-liquidating a barely-unhealthy position, and (b) leaving
  **un-liquidatable dust** that becomes stuck bad debt. **STEAL** — graduate the close factor:
  cap a routine partial at ~50% of the shortfall-needed amount, escalate to 100% when HF is deep
  underwater (≤ a config threshold) OR when a partial would leave sub-dust residual.
- **Per-loan bad-debt realization** — **already have it** (FallbackPending split per loan).
- **Dynamic, health-scaled bonus / Dutch-auction soft liquidation** (discount grows as health
  falls). **AVOID for now** — health-scaled Dutch bonuses amplify oracle-manipulation and bad-
  debt risk on **spot-price** HF math. Our oracle is well-hardened (3-source quorum + sequencer
  guard, see #392), but the marginal benefit over our existing slippage-scaled bonus is small and
  the added complexity/risk isn't worth it pre-audit. Revisit post-audit if needed.

## 3. Recommended design

- **Graduated (two-tier) close factor with a dust floor.** Replace the single
  `maxPartialLiquidationCloseFactorBps` ceiling semantics with: (a) a *routine* close factor
  sized to restore health (liquidate only as much as needed — "position-health-scaled amount"),
  (b) auto-escalate to 100% when HF ≤ a configurable deep-underwater threshold (~0.95) **or** when
  a partial would leave less than a configurable **dust floor** of collateral/debt. This is the
  card's "dynamic close factor relative to health shortfall" ask, kept E2-safe (it only sizes
  *how much collateral to sell*, never re-prices the loan).
- **Keep** the existing dynamic slippage-based bonus and per-loan FallbackPending bad-debt split
  — they already match best practice; document them as the answer to the card's bonus + bad-debt
  questions.
- **Interaction with the internal-match window** (card Q4): the graduated close factor must
  respect the existing internal-match priority band — a graduated partial still defers to an
  internal match within the priority window before any external swap. No change to that ordering.

## 4. Verdict

Mostly **already-good**; the single net-new piece is the **graduated close factor + dust floor**.
Everything else (dynamic bonus, bad-debt split, sequencer guard, internal-match priority) is
already at or above the benchmarked engine. Low-risk, contained refinement.

## 5. Spin-off implementation issue

**Graduated close factor + dust floor:** size routine partials to the health shortfall; auto-
escalate to full at a deep-underwater HF threshold or a sub-dust residual; config-bounded
thresholds; preserve the internal-match priority ordering. Co-designed with #394 (same risk
engine). Defer health-scaled Dutch bonus (note as a post-audit revisit).

## 6. Sources

Our shipped `RiskFacet`/`LibFallback`/`DefaultedFacet` + the two-tier-close-factor / bad-debt /
soft-liquidation pooled-market precedents (generic; URLs in working notes).
