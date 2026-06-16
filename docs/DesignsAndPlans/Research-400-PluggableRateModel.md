# Research findings — #400: Pluggable interest-rate-model interface (the keeper-"AMM" quote side)

**Card:** #400 (master sweep #401, Cluster B; proactively proposed). **Status:** findings +
verdict.
**Verdict:** **ADOPT — adapted, as a QUOTE-TIME-ONLY rate-model interface.** A pluggable model
may compute the rate written into a *new* offer/loan at origination; it may **never** re-price a
live loan. This is the correct, E2-safe reading of "keepers doing AMM-like things" for lending.

> No third-party product names per the sweep rule.

---

## 1. What T-093's "keeper AMM" actually means for a fixed-rate lender

An AMM continuously quotes a price from a curve. The tempting analogy — "an AMM that quotes a
*lending rate* from utilization" — is the **pooled money-market floating-rate model**, which
**violates E2** (our loan rate is fixed at init and never floats). So the AMM analogy is only
valid for the **quote side**: a curve/model that prices a **new** offer at creation (a rate
recommendation or an auto-quoted offer), after which the accepted loan **snapshots that rate
immutably**. "Keeper-AMM" = keepers/solvers quoting competitive *new-offer* rates against a
shared rate-model, not a pool re-pricing live debt.

## 2. What we have today

- A loan's rate is **written once** at init and never mutated: the offer's `interestRateBps`
  (or the range midpoint at match) → `Loan.interestRateBps` in `LoanFacet.initiateLoan` (≈:170)
  — the only loan-rate write (ethos E2, verified in #401).
- The rate is **user-supplied** (or midpoint of two user ranges via `OfferMatchFacet`). There is
  **no rate-model abstraction** — no curve, no per-collateral premium, no reference-rate input.
- `MIN_HEALTH_FACTOR` is a **compile-time constant** (#401 / #394 note) — the risk gate is flat,
  not risk-priced.
- Market-rate scaffolding exists (the market-rate widget + depth-tiered LTV, Phase A) — on-chain
  price-discovery the quote model could consume.

## 3. Recommended design — quote-time pluggable model

- **Interface:** `IRateModel { quoteRateBps(RateModelInput) view returns (uint16) }` where
  `RateModelInput` carries the priced dimensions (lendingAsset, collateralAsset, LTV/HF at init,
  duration, a reference rate, optional VPFI tier). Models are **pure quote functions** — no
  storage write to any live loan.
- **Where it plugs in:** at **offer creation / match**, an offer may optionally reference a
  registered rate-model id; `OfferCreateFacet` / `OfferMatchFacet` call `quoteRateBps` to derive
  the offer's `interestRateBps` (or to bound the acceptable range). At `initiateLoan` the quoted
  rate is **snapshotted immutably** exactly as today. A live loan never consults a model again.
- **Default model:** an identity model returning the user-supplied rate — so the current
  behavior is just "the identity rate-model," and nothing changes unless a richer model is
  registered. Zero-config backward compatibility.
- **Risk-premium models (ties to #394):** a model can express **risk-based per-collateral
  premiums** — the mechanism #394 needs. A keeper/solver "AMM" then competes by quoting
  attractive new-offer rates from a shared model + live reference rate, which is the legitimate,
  E2-safe form of the T-093 "keeper AMM."
- **Governance:** registering/altering a model is a **risk-increasing** change → timelocked +
  guardian-revocable (the #393 §4 asymmetry); the identity default needs no governance.

**Ethos:** E2 — the model only ever produces the *value written at init*; immutability of the
live loan's rate is untouched. E1 — a rate model is a pure function, holds no funds. E3 —
orthogonal (`useFullTermInterest` is a separate flag).

## 4. Relationship + sequencing

- **Mechanism for #394** (risk-based premiums) — #394 should adopt this interface to express
  premiums rather than inventing its own. Research #394 next in Cluster B.
- **Quote source for #399** (backstop posted rate) and the keeper-AMM quoting in #393.
- **Lower priority than Cluster A** (substrate/matcher/aggregator) for the T-093 themes — it
  enriches *pricing*, while Cluster A solves *matching*. Sequence after Cluster A unless #394's
  risk-pricing work is pulled forward.

## 5. Spin-off implementation issue

**Pluggable rate-model v1:** `IRateModel` interface + a model registry (timelock-gated) + the
identity default + `OfferCreate`/`OfferMatch` quote-time hook (snapshot unchanged). Built after
Cluster A; co-designed with #394.

## 6. Sources

Our code anchors above + the pooled-money-market floating-rate model (researched generically as
the pattern to **avoid** re-pricing live loans).
