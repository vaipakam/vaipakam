## Thread — Offer-grouped loans view on the Dashboard (PR #<n>)

Closes #124. When a single offer fans out into multiple loans (range
orders, partial fills), the Dashboard previously showed those as N
orphaned rows in the flat "My Loans" table. A lender who posted one
offer for $100k accepting borrowers in 5-25% LTV slices would see
their offer turn into 4-7 child loans — and have no visible link
back to the originating offer.

This PR adds an **Offer-grouped section** above the flat loans table
that surfaces only when there's at least one fan-out (≥2 children
from one offer). Each fan-out renders as a card with:

- Cross-link to `/offers/:offerId` so the user can see the original
  offer terms alongside what got filled.
- **Total filled amount** (SUM across children, in the principal
  asset's native units — no cross-asset normalisation since the
  hook doesn't have prices).
- **Weighted-average interest rate** by filled amount —
  `Σ(rate × amount) / Σ(amount)`. The card spec's "My take" block
  called this out specifically: plain `mean(rates)` is misleading
  when child loans have different fill sizes. A $1k fill at 10% APR
  plus a $99k fill at 5% APR is not a 7.5% effective rate — it's
  5.05%. The hook computes the right number; the test file pins
  the example to lock the math.
- **Minimum HF** across **active** children (terminal loans don't
  carry liquidation risk anymore so they're excluded). The card
  spec emphasised MIN not mean because showing an average HF would
  lull the user into false safety — the worst child governs the
  group's risk.
- **Collateral per-asset bucket** — one row per collateral type. An
  offer accepting multiple collateral assets gets one collateral
  row per asset rather than a dollar-sum the hook can't compute.
- **Status counts** (active / repaid / defaulted / settled / etc.)
  alongside the total child count.
- **Expand toggle** revealing each child loan as a compact inline
  row with the standard "View" CTA.

Single-child offers (the common case) deliberately stay in the flat
table only — rendering them in both the group section and the flat
table would duplicate the row.

What this PR does NOT include (acknowledged in the hook's doc
block, slot reserved for the data-source follow-up):

- **Interest accrued so far** per group — needs per-loan
  `getLoanDetails` data that LoanSummary doesn't currently carry.
- **Fees collected** (yield-fee + LIF) per group — same.
- **Fill percentage** (Σ filled / `offer.amountMax`) — needs the
  parent offer's `amountMax` from offer storage, fetched via a
  follow-up `useOffersByIds` hook.

A pure-function vitest suite in `useOfferGroupedLoans.test.ts`
pins the load-bearing aggregations (weighted-avg rate, MIN HF,
per-asset collateral bucket, per-status counts, sort order). The
test won't run in CI today — `pnpm -r test` is intentionally
off the required-check workflow pending Issue #85's
test-setup-failure resolution — but documents the contract for
when the test infrastructure comes back.

Pure frontend change: no contract change, no facet rename, no
deployments-sync. Sets up #126 (batch ops on offer-grouped loans)
which needs the grouped-view primitive as its UI starting point.
