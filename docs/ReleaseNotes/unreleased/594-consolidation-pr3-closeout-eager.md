### #594 (PR 3/3a) — auto-consolidate on the two most common loan terminations

Following PR 1 (the primitive) and PR 2 (borrower-side mid-life actions), this PR
makes consolidation automatic on **both sides** for the two most common ways a
loan ends — voluntary repayment and time-based default — so a transferred
position routes its proceeds and collateral to the *current* holders rather than
the departed owner.

Wired (consolidating **both** the borrower and the lender side, since these
close-outs settle lender economics through the stored lender as well as return
collateral to the stored borrower):

- **Full repayment** and **partial repayment** — lender proceeds (and the
  partial path's `lenderShare`) now route to the current lender holder, and the
  collateral returns to the current borrower holder.
- **Time-based default** — the liquidation proceeds / illiquid-collateral
  transfers route to the current holders on both sides.

As before, every hook is a no-op for a position that has not transferred, and it
never blocks the close-out: a sanctioned or excluded holder simply skips
consolidation and the termination proceeds under its own rules. No existing
behaviour changes for ordinary (non-transferred) loans — confirmed by the full
existing repay and default test suites passing untouched.

Sanctions safety on these eager paths is preserved end-to-end. A position
whose departed (now-stale) owner is sanctions-flagged *after* the transfer no
longer bricks the close-out: moving the asset *out* of that owner's vault to
the current (sanctions-checked) holder is the de-risking action the policy
wants, so it is allowed, while a sanctioned *current* holder is still kept from
receiving funds (the partial-repayment payout refuses a flagged recipient, and
every consolidation still blocks/skips a flagged incoming holder per its tier).

The remaining close-outs — HF-liquidation, internal-match and split liquidation,
early-withdrawal sale, preclose, periodic settlement, in-place extension, full
swap-to-repay, intent settlement, and refinance — are tracked in #658, together
with the architectural note that the size-constrained liquidation facets need a
cross-facet entry point (the consolidation logic inlines into each caller, and
those facets are already at the contract-size limit).
