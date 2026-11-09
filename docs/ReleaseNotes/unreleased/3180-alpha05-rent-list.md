## Thread — alpha05 can list an NFT for rent (PR #<n>)

An owner can now list an NFT for rent on the new app's Rent page. A short
form asks for the collection and the token's number (and a quantity for a
multi-token collection), the token renters pay in, the daily fee as one
figure, the term, the rent rule (pro-rata or full term) and how long the
listing stays open. It has no collateral or rate fields, because a rental
carries neither.

The review states that the NFT moves from the owner's wallet into the
owner's own vault and stays there while the listing is open and while it is
rented, what a renter would pay up front, the buffer share the listing
fixes at today's setting when it is posted, what the owner receives (the
rent due, less the protocol's share, which is fixed when a renter takes
the listing), the grace period and what a default does. A token the wallet
does not hold, or too few units, is said before any wallet step, and the
review reads again on its own once that changes.

The wallet is asked to let the protocol move that one token (for a
multi-token collection, the whole collection for this listing only, taken
back afterwards whatever happens), the listing is tried as a dry run, and
then posted. The outcome is measured from the transaction: the listing
recorded and the NFT in the owner's vault, with a link to the listing's
own page. Posting a renter's request still points to the current app.

Advances #3180.
