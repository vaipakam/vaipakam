## Notification center — loan-health warnings (PR #<n>)

The in-app inbox now warns borrowers when a loan's health worsens
(#1213 PR 2b, the final piece of the notification center). The
platform's autonomous monitor already checks every active loan's
health factor each minute as part of its liquidation watch; it now
also files a free inbox row when a loan's health CROSSES DOWN through
a protocol-level line:

- **below 1.5** — the level loans must start above; worth a look.
- **below 1.2** — the cushion is getting thin.
- **below 1.05** — close to the 1.0 line where liquidation becomes
  possible; time to act.

These fire only on the way down — a recovering loan is not an alert —
at most once per line per day, and they follow the borrower position
to its current holder. Like every inbox entry, the wording states the
dip as of the notice and defers the live number to the position page,
so an old entry stays truthful after the loan recovers or closes.

This is deliberately the borrower's lane: health is the borrower's
actionable number (top up collateral, repay). Lenders learn about
trouble through the grace and outcome entries. Loans whose collateral
has no price feed have no health number — their risk reminders are the
due-date and grace entries that shipped in the calendar half of this
work — so between the two halves, every loan has a risk lane.

Unlike the optional Telegram/Push alerts (which are instant and use
each user's own thresholds), these inbox rows use one fixed protocol
schedule, need no setup, and arrive on the inbox's normal refresh
cadence. They are produced by the autonomous monitor, so they only
mint while that monitor is enabled.

Part of #1213 — this completes the notification center (events,
calendar reminders, and health warnings).
