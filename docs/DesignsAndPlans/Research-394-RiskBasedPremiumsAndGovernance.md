# Research findings — #394: Risk-based per-collateral premiums + governance surface

**Card:** #394 (master sweep #401, Cluster B). **Status:** findings + verdict.
**Verdict:** **ADOPT — adapted, in two independently-shippable pieces.** (1) Evolve the flat,
compile-time HF gate into a per-asset **dual factor** (origination LTV + a distinct, higher
liquidation threshold) with **runtime-tunable, range-bounded** parameters; (2) express any rate
"premium" **quote-time only** via the pluggable rate model (#400) — never floating a live loan
(E2). Governance = **bounded steward setters** under the existing timelock with the role-
separated, timelock-asymmetric pattern.

> External comparison systems referenced generically per the sweep rule.

---

## 1. The gap

Loan admission today is a **binary gate**: HF ≥ `MIN_HEALTH_FACTOR` (1.5e18) at init, full stop.
Riskier collateral is admitted-or-rejected, not priced with a spread. And `MIN_HEALTH_FACTOR` is
a **compile-time constant** (`LibVaipakam.sol:66`) — changing it needs a contract upgrade.

## 2. What we have (foundation already exists)

- **Per-asset `AssetRiskParams`** (`LibVaipakam.sol` ≈:1691; map ≈:2544): `loanInitMaxLtvBps`,
  `liqBonusBps`, `reserveFactorBps`. The per-collateral parameter slots exist.
- **Depth-tiered LTV** (`depthTieredLtvEnabled`, default off): when on, init cap =
  `min(loanInitMaxLtvBps, tierMaxInitLtvBps[effectiveTier])`, and the HF floor drops from 1.5 to
  1.0 (`LoanFacet._checkInitialLtvAndHf` ≈:581). So a per-collateral, depth-aware LTV mechanism
  **already exists** — it just isn't a full origination-LTV-vs-liquidation-threshold split.
- **Interest rate is a fixed per-offer field** (`Offer`/`Loan.interestRateBps`), no model.
- **Governance** = OZ `VaipakamTimelock` + role-based access (`RISK_ADMIN_ROLE`, `ADMIN_ROLE`);
  **no on-chain quorum**.

## 3. External patterns (generic) — steal / avoid

- **Dual factor per asset.** Modern pooled markets separate **origination LTV** (max borrow at
  open) from a **higher liquidation threshold** (point of liquidatability) — e.g. ~75%/80% for
  stables, ~35%/65% for volatile. The gap is the safety buffer. **STEAL** — map onto our per-
  asset params: keep `loanInitMaxLtvBps` as origination LTV, add a distinct per-asset
  **liquidation threshold**. (Today the buffer is global: init HF 1.5 vs liquidation HF 1.0.)
- **Deterministic bonus-from-LTV** rather than a hand-set flat bonus. We already compute a
  **dynamic** slippage-based liquidation incentive (see #395), so we partly have this.
- **Bounded steward setters.** Leading markets moved from per-tweak DAO votes to **optimistic
  bounded setters**: small per-update deltas (e.g. LTV ±0.25%, threshold ±0.25%, bonus ±0.5%,
  caps ≤2×) + a cooldown, with anything outside needing a full vote. **STEAL** — this fits a
  protocol with a timelock but no quorum: a `RISK_STEWARD_ROLE` can nudge within hard ranges;
  larger moves go through the timelock.
- **AVOID** cross-asset commingled correlation categories (e-mode-style) — our no-commingling
  per-user-vault design already delivers per-loan isolation; we don't need shared-risk buckets.

## 4. Recommended design

**Piece A — dual-factor, runtime-tunable risk params (the binary-gate evolution):**
- Make the health floor **runtime-tunable + range-bounded** instead of the `MIN_HEALTH_FACTOR`
  constant: a `cfgMinHealthFactor` setter bounded to a safe range (e.g. [1.2e18, 2.0e18]) so a
  misconfig can't open an unsafe position. Default unchanged (1.5e18).
- Add a **per-asset liquidation threshold** to `AssetRiskParams` (distinct from
  `loanInitMaxLtvBps`), so each collateral carries its own origination-LTV / liquidation-
  threshold pair. The depth-tiered path already clamps init LTV; this generalizes the *exit*
  side per-asset.
- All setters **range-bounded** (reject out-of-band values) — the card's explicit safety ask.

**Piece B — risk premium on the RATE (E2-safe):** a risk premium is expressed **only** as the
rate written into a NEW offer at origination, via the **pluggable rate model `IRateModel`
(#400)** — `quoteRateBps` can add a per-collateral premium. The accepted loan snapshots that rate
immutably; **no live loan is ever re-priced** (E2; reaffirmed in the card's own ethos note). This
is why #394 and #400 are co-dependent: #400 is the *mechanism*, #394 is the *risk content*.

**Governance:** `RISK_STEWARD_ROLE` with hard-bounded optimistic setters (small deltas +
cooldown) for routine tuning; the timelock (with the #393 §4 asymmetry — risk-increasing changes
timelocked + guardian-revocable, risk-reducing instant) for larger moves. **On-chain quorum is
NOT required** for this — the bounded-steward + timelock pattern is the proportionate answer to
the card's "we have no quorum" finding; a full voting system is a separate, larger decision
(touches #404 governance).

## 5. Relationship + sequencing

Co-designed with **#400** (rate-model mechanism) and **#395** (same risk/liquidation engine).
Sequence after Cluster A; Piece A (dual-factor params) can ship independently of the intent
layer.

## 6. Spin-off implementation issues

1. **Runtime-tunable bounded health floor** + **per-asset liquidation threshold** in
   `AssetRiskParams` + range-checked setters (Piece A).
2. **Risk-premium rate content** layered on `IRateModel` (#400) (Piece B) — gated on #400.
3. **`RISK_STEWARD_ROLE` bounded optimistic setters** + timelock-asymmetric governance.

## 7. Sources

Our code anchors above + the dual-factor / bounded-steward pooled-market precedents (generic;
URLs in working notes).
