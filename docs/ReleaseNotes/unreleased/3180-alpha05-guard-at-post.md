## Thread — alpha05 can put a price-move guard on an offer as it is posted

A creator could already put a price-move guard on an offer from its page, but only after posting, so the offer sat on the book unguarded until that change landed. In Advanced mode the offer form of the new app now has a price-move guard option for an offer of one token against another. With a limit between 0.5% and 50%, the guard and the offer are sent as one transaction, so the offer is guarded from the moment it is on the book, and if either part fails, nothing is posted.

The review is the protocol's own dry run of exactly that transaction. Because that dry run cannot reach the guard while a token approval is still owed, the review also reads both tokens' prices on its own: a pair the protocol cannot price is named before signing, with the remedy of posting without a guard. The receipt states the limit, what the guard refuses and that no one can fill the offer until hourly price checks cover the pair. The finish card reads the guard from the transaction's own event for the offer it created.

The guard reaches the test networks with the next fresh deploy.

Advances #3358 and #3180.
