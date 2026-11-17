## Thread — alpha05: how much of an Auto-lend's money is in loans (PR #3708)

Positions now shows, above the Auto-lend cards and for each lending asset, how much of the money behind Auto-lend is in loans and how much waits in the lender's own vault, with the share in loans. It is read at the same block as the cards. A loan counts in full until its repayment is claimed or lent again, as the cards already say.

Amounts in different assets are never added together, since no total across assets exists without a price. The share is rounded down, so it never reads higher than it is. Waiting money behind a stopped or ended Auto-lend is named on its own, because it will not be lent until the lender takes it back or starts that Auto-lend again. When the wallet has more settings than one read lists, the figures say they cover only the listed ones.

The figures always say they cover only the listed settings. The protocol drops a stopped Auto-lend with nothing left waiting from the wallet's list while its loans run on, and no on-chain list of those loans exists, so the page names that gap and points to each loan's own page instead of showing a share that quietly leaves them out.

This is the first part of #3664, the part its own recommendation says can ship for ordinary Auto-lend. The rest needs data the app cannot read today: the rate earned across the loans Auto-lend made (no per-owner list of those loans exists on-chain, and the indexer does not record intent fills yet), why the rest is waiting (#3623), what lower limits would have filled, the opt-in alerts, and the instant-market row (#3656).

Advances #3664.
