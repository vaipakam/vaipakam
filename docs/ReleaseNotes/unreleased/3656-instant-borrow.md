### Instant market: the instant borrow (#3656, part 7b)

A borrower can now borrow from several lenders in one transaction. They name the pair, the amount, the collateral, the term, the highest rate they accept and a list of sources, cheapest first, and set the least they must receive. Each fill is its own loan with one lender, at that lender's own price, and passes every check a new loan passes. A source that cannot fill is skipped and reported with its reason, so a stale or changed source never fails the whole request; only receiving less than the stated least does.

A source is either an Auto-lend intent whose owner has given the new instant-market consent, or a standing lender offer whose interest runs by time. Intent owners give three consents separately from their terms: fills from a borrower's direct request, renewal of these loans in place, and takeover of another lender's loan at face value. Setting new terms clears them, and a fill waits the usual minimum age after they are given.

Collateral is shared across the loans in proportion to what each lends. It is taken from free collateral already in the borrower's vault first and from the wallet for the rest, and the share of anything not filled is never taken. The principal arrives in the borrower's vault less the initiation fee, and no part of that fee is paid back to the borrower as a match share; it goes to the treasury.

The loans carry one group number and are stated together in one summary event, but each keeps its own collateral, health factor and liquidation. The common ledger now also counts the principal opened through the instant market. The feature is off by default, serves only pairs of blue-chip assets, and offers fixed-rate loans until floating rates exist. Takeover follows next; renewal waits for the per-loan reserve (#3681). This changes the storage layout, so it reaches a chain only through a fresh deploy.

The Auto-lend figure in the common ledger now follows each loan's current intent: a loan sold out of an intent leaves it, so "how full" counts only what intents hold now.
