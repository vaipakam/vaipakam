### Instant market: the common ledger (#3656, part 7a)

The platform now keeps running totals for every lending asset and every lending and collateral pair, which anyone can read. Declared is the sum of the largest exposure of every active Auto-lend intent that can still fill: the limit lenders set. Lent is the open principal of every active loan in that asset, together with the part of it that Auto-lend intents opened. How full the market is, and how much can still be lent, come from the Available figure added in part 7b (#3714), not from Declared.

An intent with a lend-until time stops filling one day before that time. It leaves Declared at the end of that UTC day with no transaction needed, because each day's expiring amount is kept aside and every read subtracts the days that have passed. The figures are therefore exact as of the start of the current UTC day. A permissionless roll step moves the stored totals forward after a long quiet period; no figure depends on anyone calling it.

The totals cannot drift. Each intent and each loan remembers what it last added, and every change moves the totals by the difference, so a step cannot count twice or be missed. Funding or withdrawing an intent's capital does not move Declared, because Declared is the limit a lender set, not money held. It does move Available (#3714), which is the part of that limit the slot's capital can actually lend now.

The figure for loans made through the instant market itself comes with the instant borrow step. This changes the storage layout, so it reaches a chain only through a fresh deploy.
