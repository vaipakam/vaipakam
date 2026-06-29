## Thread — In-kind settlement made impossible to miss (PR #__)

Illiquid collateral, NFT collateral, and the oracle-unavailable fallback can
all settle a defaulted loan **in-kind** — the lender receives the raw
collateral asset itself rather than the lending asset, regardless of market
value, with no DEX swap and no LTV-based liquidation. This is intended
protocol behaviour, but it is a user-expectation risk: a lender who assumes
Vaipakam always converts collateral to the lent asset could enter a position
they would have declined with full context. This change closes the remaining
gaps so that downside is surfaced at every point a user commits to or holds
such a position.

What changed, surface by surface:

- **Create Offer / Accept Offer review** — the shared Risk Disclosures block
  now renders an explicit, offer-specific in-kind settlement line whenever the
  offer's collateral is an NFT or an illiquid / no-oracle asset, so the generic
  paragraph is no longer the only signal. The line is threaded through the
  English-original modal as well, so non-English users see it in the binding
  copy too. Create wires it off the chosen collateral asset class; Accept wires
  it off the offer's illiquid flag (the same flag the Offer Book already uses
  for its extra illiquid-leg notice).
- **Loan Details** — for an active loan with an illiquid / no-oracle leg, a
  prominent warning banner now sits at the top of the Collateral & Risk card
  (in addition to the pre-existing one-line risk explainer), keeping the
  in-kind outcome visible for the life of the loan rather than only at offer
  time.
- **NFT Verifier** — a live position NFT whose underlying loan settles in-kind
  now shows a labelled `Settlement on default` line (liquid vs in-kind) and a
  warning, so a prospective buyer of the position sees the downside before
  acquiring it.

The Advanced User Guide's "How Liquidation Actually Works" section (four
fallback branches with worked examples) and the public FAQ's `fallback-mechanics`
and `default` entries already cover the in-kind mechanics in plain language, so
no new guide/FAQ copy was needed for that acceptance criterion.

New `RiskDisclosures` component tests assert the in-kind line appears when (and
only when) the collateral settles in-kind, and that it composes with the
full-term-interest line.

Spec: `docs/FunctionalSpecs/WebsiteReadme.md` gains intent bullets for the
Loan Details active-loan in-kind warning and the NFT Verifier settlement
caveat; the create/accept combined-disclosure requirement was already specced.

Closes #796.
