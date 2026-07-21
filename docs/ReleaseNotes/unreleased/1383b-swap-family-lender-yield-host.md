## Thread — Honor the lender Full/hold stamp on the swap-to-repay settlement paths (M2 PR-6 follow-up, part B — swap family) (PR #<n>)

Continues #1383. Part A extracted the lender yield-fee resolve into a shared
helper and pointed the four **primary** settlement paths at it. This part
delivers the same §F2 lender Full/hold discount to the **swap-to-repay**
secondary settlement paths, which previously transferred the treasury cut with
no discount at all — so a lender who paid the Full `C*` tariff and was settled
through a swap received none of the promised **+10%**.

Two pieces of groundwork make this work cleanly:

- **A diamond-internal resolve host.** `VPFIDiscountFacet.resolveLenderYieldFeeFor`
  runs the whole try-VPFI-then-direct-reduction delivery for a given loan and
  settling lender, and emits the analytics passthrough when VPFI moves. Because
  the delivery logic now lives on one facet, the size-constrained settlement
  facets call it with a single cross-facet call instead of carrying the delivery
  bytecode themselves — the EIP-170 headroom an inlined library helper cannot
  free.

- **Keying the discount on the party actually being paid.** The resolve helpers
  now take an explicit settling-lender address. On the paths that consolidate
  the lender to the current position-NFT holder, that is the recorded lender; on
  the paths that do not, it is the **current holder**. Because the hold-tier
  discount is an instantaneous per-address tier read (the per-loan time-weighted
  window was retired earlier), the current holder's own tier is exactly the
  correct discount for them, and the Full `+10%` — being loan-scoped — applies to
  whoever holds the position.

Wired in this part:

- **`swapToRepayFull`** — consolidates the lender, so keyed on the recorded
  lender. The discount shifts the treasury cut to the lender in the lending
  asset (or is paid in the lender's VPFI when a price source is configured),
  with the settlement's required-proceeds and borrower-surplus amounts unchanged.
- **`swapToRepayPartial`** — does not consolidate the lender, so keyed on the
  current lender-NFT holder (matching where the path already routes the payout).
- **The Fusion swap-to-repay intent settlement** — the lender-side consolidation
  runs after the treasury split, so likewise keyed on the current holder.

The remaining secondary paths — preclose obligation-transfer / offset /
rental-prepay, partial repay, and periodic interest — are handled in the next
part, reusing this same host.

Ships **dark**: no loan carries a `Full` lender stamp until the M2
`feeEntitlementEnabled` cut-over, so every current swap-to-repay settlement
resolves to exactly the pre-existing behaviour (the consent-gated hold discount,
which these paths also now honor). Part of the #1383 cut-over blocker. Umbrella:
#1349.
