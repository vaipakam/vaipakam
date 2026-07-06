### Support drawer: connection health + report-a-problem (alpha02)

The naive-user app now has a Support button on every page — a small
floating control that opens a health-check panel (#1028 item 4, the
last item of that card; the lightweight port of the primary app's
diagnostics drawer).

The panel answers the questions a user actually has when the app
feels broken: which network am I on, is the blockchain connection
responding, is the market-data cache up to date (with the reassurance
that their own positions load directly from the chain when it isn't),
what app build is this, and what was the last error recorded on this
device. Checks only run while the panel is open — nothing polls in
the background.

From the panel, "Report an issue" opens a pre-filled GitHub issue
carrying exactly what the panel showed — page, network, connection
statuses, build, and the last recorded error — and a copy-to-clipboard
button covers users without a GitHub account. Reports are redacted by
construction: the wallet address is shortened to its first and last
characters, error text is length-capped, and no browser fingerprint is
included.

The app's crash-recovery card now records the error it caught into a
session-scoped slot, so a report filed after a crash automatically
includes what went wrong — closing the loop the error boundary's
original "console-only" note left open.
