## T-086 Block D cleanup — drop tautological balance guard + retire race-window framing

Block D atomic match-rotation (PR #346) shipped with a defence-in-depth
`AtomicMatchBalanceMismatch` revert that the §17.9 spec asked for, and
with a borrower-facing "race window" confirm modal carried over from the
v1 two-step cancel + post flow. With Block D fully landed both are now
historical:

- The balance guard checks `Σ(consideration) == offer_value` before
  forwarding to Seaport. By construction `effectiveAsk = offer_value
  − bidder_fee_total`, so the consumed-vs-offer-value identity is
  algebraically true at the call site. The real protocol-leg + routing
  assertions live upstream in `AskBelowFloor` and `FeeLegsExceedAvailable`
  — those fire independently of the tautology. The dead revert + its
  error symbol are removed.

- The "race window" confirm modal warned the borrower that any buyer,
  not just the matched bidder, could fulfill the rotated listing in the
  minutes between the v1 two-step cancel and post. Atomic match-rotation
  closed that window structurally — Seaport's `matchAdvancedOrders`
  settles cancel + replacement + bidder fill in one transaction — so the
  framing is misleading. The modal copy is rewritten as a plain
  confirm-this-match dialog and the cross-link is repointed at the
  atomic-match section of the Advanced User Guide.

No protocol-level behaviour change. The on-chain assertions that matter
(floor + buffer, fee-legs solvency, shape invariants) all stay; the
defence-in-depth pre-Seaport identity check is the only thing dropped.
