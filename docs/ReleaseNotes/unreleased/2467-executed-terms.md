## Desk History — the terms a fill executed at (#2467)

The desk's History panel showed each past loan's current interest rate and term. Extending a loan rewrites both, so an extended 30-day fill at 5% could appear in History as a 60-day fill at 9%, a market it never traded in. The indexer has kept the executed rate and term since its rate-desk work. It now serves them, and History shows them.

As with the starting principal (#2461), they are served only where the protocol's own initiation event backs both values. A value copied from a loan's current terms, or read from the chain after an extension, is kept for the market charts, which need a frozen figure, but is not shown as history. Each indexer pass re-checks unconfirmed values against the initiation events. Where the terms cannot be confirmed, the row says the starting terms are not available.

Closes #2467.
