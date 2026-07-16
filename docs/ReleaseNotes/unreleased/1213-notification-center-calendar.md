## Notification center — due-date and grace reminders (PR #<n>)

The notification center now reminds people about time, not just events
(#1213 PR 2). No contract event fires when a due date quietly approaches,
so the indexer runs a calendar sweep on its ingest tick and materializes
three reminder rows from its own loan table:

- **Due within a week** and **due within a day** — to the borrower, the
  party who can act (repay, extend, or list collateral).
- **Past due, grace window running** — to both parties: the borrower can
  still repay with the late fee, and the current lender-position holder
  learns a default (and their claim) may be near.

Because the sweep is pure calendar math over the indexed loans — no
oracle, no price feed — these reminders cover **illiquid loans too**,
which is exactly the gap the design called out (health-factor alerts can
only ever cover liquid loans).

Each reminder fires once per loan per due date: extending a loan pushes
the due date out and re-arms the reminders for the new date, and repeated
sweep ticks never duplicate a row. Reminders are stamped at the current
chain position so they sort as fresh items in the inbox, and the
past-due reminder stops once the grace window has closed — stale advice
is never shown (the definitive outcome row arrives from the default /
liquidation events instead). The grace length mirrors the contract's
default schedule; the sweep skips bookkeeping rows (sale vehicles,
unhealed stubs) the same way the market views do.

The app renders the three new reminder kinds with their own icons and
plain-English copy; an older app build shows them as a generic loan
update (the safe fallback that already existed).

Part of #1213 (the calendar half of PR 2; the liquid-only HF-band rows
follow separately).
