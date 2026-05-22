## UX direction ADR — DEX/CEX conventions where they map, lending-native where they don't (Issue #166)

DeFi onboarding pain mostly comes from "the words / shapes I'm used to
from Uniswap / 1inch / Binance suddenly don't mean what I think they
mean." Vaipakam should reuse user muscle memory where the semantics
actually match — and consciously diverge, with clear naming and
tooltips, only where lending primitives have no DEX analog.

This release publishes
[`docs/DesignsAndPlans/UxDirectionDexCexHybrid.md`](../../DesignsAndPlans/UxDirectionDexCexHybrid.md)
— the design pass that names every Tier-A vocabulary borrow (where the
DEX/CEX wording AND idiom is adopted 1:1) and every Tier-B retention
(where the lending-native name stays but the visual idiom is borrowed
so the surface feels familiar). The ADR catalogues:

- **Tier A (13 entries)** — range/limit-order entry shape, fill modes,
  order expiry, in-place modification, slippage tolerance, basis-points
  display, base/quote pair selector, gas/network-fee disclosure,
  order-book idioms on `OfferBook`, notional/quantity toggle, "You
  sell / You buy" notation on confirm modals, risk-disclosure idiom,
  KYC-tier-up inline callout.
- **Tier B (10 entries)** — Health Factor + LTV, liquidation grace +
  time-based default, offer accept, collateral add/withdraw/partial,
  loan settlement / preclose / refinance, liquidation auction / dust
  close, early-withdrawal haircut, internal-liquidation match (if
  shipped), NFT rental prepay + buffer, claim.
- **Page-by-page checklist** — every `apps/defi/src/pages/*.tsx`
  surface gets a current-state-to-target-state row naming exactly
  which Tier-A borrows and Tier-B retentions apply, and what concretely
  changes per page.
- **Sub-cards to file** — 11 implementation cards grouped by user
  journey (order-entry / active-loan / post-loan / cross-cutting /
  conditional / adjacent), each scoped to a single per-page rework.
  These cards land in the same wave as this ADR merge so each rework
  has a single source of truth for "what's the target state".
- **Out of scope** — the rejected vocabulary borrows ("margin ratio"
  instead of HF, "stop-loss" instead of liquidation, "funding rate" on
  the interest-rate field, etc.) are explicitly recorded so the design
  doesn't drift back toward the cargo-cult version.

The ADR respects the retail-deploy policy throughout — sanctions /
KYC / country-pair gates stay narrow on user-facing copy, never appear
on marketing or first-impression surfaces, and the runtime gates stay
disabled on retail per CLAUDE.md. The KYC-tier-up callout shape
(Tier A.13) exists for the industrial-deploy fork where the runtime
gates ARE on.

Implementation is sub-card work. This release publishes the design
chokepoint that prevents the cargo-cult version of the cross-DEX
visual lift.

Closes #166.
