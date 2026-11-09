## Thread — alpha05 reads the offer book only once a wallet connects (PR #3419)

The new app (alpha05) no longer reads any part of the offer book before a
wallet connects. This was an owner decision: the book, an offer's own page,
and the offers and requests Borrow and Lend list for a pair are read only
once a wallet is connected on a network the app serves.

Until then, Offers asks the visitor to connect a wallet to see the book and
their own offers, an offer's page asks for a wallet to see that offer, and
Borrow and Lend ask for a wallet to see what is open for a pair. The pair
picker also waits for a wallet. A wallet on a network the app does not
serve is told to switch, and nothing is read for it from another network.

The rule is recorded as RB-OFFER-GATE in the alpha05 rulebook, and the
offer book and offer page rules now point to it. The user guides, Basic and
Advanced in all ten languages, no longer say the book and offer pages can
be read without a wallet.

Advances #3180.
