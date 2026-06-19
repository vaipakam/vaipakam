### #394 — Dual-factor risk premiums + a runtime risk-appetite knob

Risk pricing on Vaipakam now has **two independent, governance-tunable levers**,
where before it had hard-coded constants. Neither touches a human's typed
interest rate — market price-discovery stays the differentiator.

**Lever A — a runtime, range-bounded loan-admission Health Factor floor.**
Until now the minimum HF a loan must clear to be admitted was the fixed
`1.5` constant. It is now a governance knob (`RISK_ADMIN_ROLE`) tunable within
a hard `[1.2, 2.0]` band, defaulting to `1.5` so nothing changes until it is
deliberately moved. The protocol can now tighten admission in a volatile
regime, or loosen it for a proven-safe book, **without a contract redeploy**.

- The change is *branch-aware*: only the standard (non-depth-tiered) admission
  floor moves. The depth-tiered regime keeps its `1.0` not-born-liquidatable
  floor, and the **liquidation trigger** (`HF < 1.0`) is deliberately untouched
  in both regimes — so a retune can never make an open loan liquidatable.
- The floor applies only to loans admitted *after* a change; open loans were
  gated at their own admission time and are never retro-checked.
- Every place the protocol enforces the health floor — loan admission,
  collateral top-up cure, partial withdrawal, repay/swap-to-repay guards, and
  the min-collateral / max-borrow preview math — now reads the same runtime
  value, so they stay consistent with whatever admission is set to.

**Lever B — a deployable dual-factor risk-premium rate model.** Building on the
#400 pluggable rate-model substrate, a new `RiskPremiumRateModel` quotes
`reference + collateral-risk premium + tenor premium`:

- *Collateral risk* — keyed on the collateral's live liquidity tier (the same
  signal the depth-tiered LTV gate uses): thinner liquidity charges more, and an
  unknown / oracle-stale collateral charges the most (it fails *expensive*,
  never cheap).
- *Tenor* — a per-year premium applied pro-rata to the loan's duration, capped.

It is consulted **only on the automated / delegated lending path** (auto-lend /
keeper-AMM) — a human who types a rate still posts at exactly that rate. And
because it only ever *adds* to the live market reference, #400's deviation clamp
bounds its output to the market band: even a misconfigured premium can never
push an automated offer off-market. The model holds no funds, is a pure view,
and is swapped (never mutated) by deploying a new one and re-registering it —
governance can also revert to the identity model instantly in an incident.

**Governance:** both levers use the existing `RISK_ADMIN_ROLE` with hard
range-bounded setters. The optimistic-delta / cooldown "risk-steward" machinery
is intentionally left to the governance track (#404).
