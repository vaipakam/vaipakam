### alpha02: risk visibility — health-aware list badges, grace countdown, jargon glosses (UX batch 3)

Third batch from the 2026-07-11 whole-site UI/UX review
(`docs/FindingsAndFixes/Findings20260711-Alpha02UiUxReview.md`),
covering UX-003, UX-004 and UX-030 — making risk visible before it
becomes loss:

- **Positions list tells the truth about health (UX-003).** A loan
  hovering near the liquidation line used to list with a reassuring
  green "Due in N days" badge, because the list badge only knew about
  time. The list now also reads the loan's live health for active
  priced loans and lets a worse health state override the time badge —
  "Watch closely" or "Close to liquidation" replaces the green, never
  the other way around ("Past due" is never softened by a healthy
  reading).
- **Past-due loans show the actual deadline (UX-004).** The grace
  window was previously read only when submitting a repayment, so a
  past-due borrower could not see whether they had hours or days left.
  The loan detail page now shows a danger banner once a loan is past
  due, counting down the remaining grace ("Repay within about 2d 4h —
  after that the lender can take the collateral"), and switching to
  honest grace-expired wording once the window closes. Lenders see the
  mirror-image copy for their side.
- **Jargon explains itself at the moment of consequence (UX-030).**
  "Grace period" is now glossed inline wherever it appears — with the
  loan's concrete window length once the live read has it; the
  illiquid-asset consent warning spells out what "not priced by the
  protocol" means in outcomes; and the Advanced-mode health factor /
  loan-to-value numbers carry one-clause definitions instead of bare
  figures.
