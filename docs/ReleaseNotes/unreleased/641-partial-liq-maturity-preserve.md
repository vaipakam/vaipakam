## Thread — Partial liquidation / repayment no longer move a loan's deadline (PR #<n>)

A loan's term — its `startTime` plus whole-day `durationDays` — was doing
three jobs at once: it defined the **maturity** (`startTime + durationDays`),
the **grace window** that follows maturity (sized by tiers of `durationDays`),
and the **interest-accrual clock**. Whenever a partial liquidation or partial
repayment reduced the principal, the code reset `startTime` to "now" and shrank
`durationDays` so the reduced principal would accrue interest cleanly from that
moment. But because the same two fields also defined the maturity and grace,
that reset silently:

- pulled the loan's **maturity earlier** (the whole-day rounding dropped the
  sub-day remainder, so a partial part-way through a day matured the loan early,
  and repeated partials compounded it);
- **collapsed the grace window** — a deep or late partial shrank `durationDays`
  into a much smaller grace tier (e.g. a 90-day loan's 3-day grace toward the
  sub-7-day, 1-hour tier), so the borrower could be declared in default far
  sooner than their agreed term; and
- let a tiny **post-maturity partial repayment reset the grace clock**, so a
  borrower could roll the lender's recovery deadline indefinitely with small
  payments.

The fix separates the two concerns. The interest-accrual clock now lives in its
own pair of fields (`interestAccrualStart` and `interestRemainingDays`). A
partial re-stamps **those** — the reduced principal still accrues from the
moment of the partial over its remaining committed term, exactly as before — and
the loan's term tuple (`startTime` + `durationDays`) is left **completely
untouched**. Because the term never moves, the maturity and the grace window are
preserved exactly on **every** path that previously re-stamped the loan (partial
liquidation, partial repayment, and swap-to-repay), with no per-call-site
patching of the deadline gates. The interest arithmetic is unchanged — it's the
same reset, just recorded in dedicated fields — so settlement amounts are
identical; this was verified against the full settlement test surface (repay,
preclose, refinance, swap-to-repay, time-default, periodic interest, and both
liquidation routes).

Closes #641. Surfaced during the #395 partial-liquidation sizing review and
refined across several review rounds, which is what made the structural shape
clear: the bug was never in one re-stamp path, it was the term tuple being
overloaded. The loan now carries the two `interest*` fields; loans that predate
them fall back to `startTime` / `durationDays` (none exist — the platform is
pre-live). The loan-detail ABI swaps in the new fields; frontend and keeper ABI
bundles are re-exported in the same change. Grace remains fully
admin/governance-configurable — the schedule is still read live via
`gracePeriod`, now off the (immutable) `durationDays`.
