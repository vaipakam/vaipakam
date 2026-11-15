### Instant market: the common ledger (#3656, part 7a)

The platform now keeps running totals for every lending asset and every lending and collateral pair, which anyone can read. Declared is the sum of the largest exposure of every active Auto-lend intent that can still fill, so it states what lenders have offered. Lent is the open principal of every active loan in that asset, together with the part of it that Auto-lend intents opened; the second figure divided by Declared is how full the market is.

An intent with a lend-until time stops filling one day before that time. It leaves Declared at the end of that UTC day with no transaction needed, because each day's expiring amount is kept aside and every read subtracts the days that have passed. The figures are therefore exact as of the start of the current UTC day. A permissionless roll step moves the stored totals forward after a long quiet period; no figure depends on anyone calling it.

The totals cannot drift. Each intent and each loan remembers what it last added, and every change moves the totals by the difference, so a step cannot count twice or be missed. Funding or withdrawing an intent's capital changes nothing, because a vault balance is not an offer. How much of the declared amount is free right now is an estimate the app and the indexer compute and label as one.

The figure for loans made through the instant market itself comes with the instant borrow step. This changes the storage layout, so it reaches a chain only through a fresh deploy.
