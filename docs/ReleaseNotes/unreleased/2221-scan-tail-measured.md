## The indexer measures what the end of each scan costs (#2221)

The indexer keeps back part of each run's request allowance so that, after reading new blocks, it can still record how far it got and finish its once-per-run steps (market summaries, notifications, the protocol settings refresh, the progress stamps). That reserve was a starting estimate, waiting to be tuned once real traffic showed what those steps cost.

A week of live logs showed no run that stopped early on the reserve, but nothing logged the cost of those steps on its own, so the estimate could not be checked against anything. Each run now logs one line giving what those steps actually spent, beside the reserve. The loan reconciliation and the calendar sweep, which size themselves to what is left, are reported separately so they do not inflate the figure. The reserve will be re-set from those lines once they have accumulated, rather than from another estimate.

Nothing a user sees changes.

Part of #2221.
