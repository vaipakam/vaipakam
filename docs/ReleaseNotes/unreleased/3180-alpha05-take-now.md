## New app: take an open offer instead of posting

When a lending offer or a borrow request is about to be posted in the new app, and an open offer on the other side already fits it, the app now shows that offer first. The reader can take it at once, on that offer's own terms, or post anyway.

An offer is shown only when taking it stays inside every limit the reader set: the same term, interest mode, partial repayment and interest schedule, an amount within the reader's range, a rate no worse than the reader's, and collateral no worse than the reader's for that amount. It must also be open and takeable by this wallet now. A draft that arms a price-move guard or the Full fee tariff is never offered a take, because a direct accept carries neither. If the latest re-read of the offers failed, the step says the list is from the read before. Taking opens the usual review on the offer's own terms. Posting waits for a taker or, while matching is on, a match with an offer whose rate range includes the reader's rate, which lends at that rate. Nothing is taken or posted without the reader's press.

This is part B1 of #3622 and needs no contract change. Until now a new offer waited for the matcher even when a counterparty was already resting. The rule is in the rulebook as RB-TAKE-NOW.
