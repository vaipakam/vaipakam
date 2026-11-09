## Thread — alpha05 can post a request to rent an NFT (PR #3469)

A renter can now ask to rent a named NFT on the new app's Rent page. The
form is the listing form worded for the renter: the collection and the
token's number (and a quantity for a multi-token collection), the token the
renter pays in, the daily fee as one figure, the term, the rent rule and how
long the request stays open. Only one of the two forms is open at a time,
and the rental book steps aside while either is.

The review states that the rent for the whole term and a buffer move from
the renter's wallet into the renter's own vault now and stay there while the
request is open, that the buffer share is fixed by the request at today's
setting, that the term runs from when an owner takes the request, and that
an owner who takes it starts the rental at once with no further step from
the renter. It also states what comes back on time, the grace period, the
late fee, what a default does, and that cancelling returns the rent and
buffer to the wallet.

A wallet short of the rent and buffer is told so before any wallet step, and
the review reads again on its own once that changes. A token that does not
exist yet is noted, and a token the wallet already holds is refused, since
nobody else could take the request. The wallet approves exactly the rent and
buffer, the request is tried as a dry run, and then posted; the approval is
put back if it does not go through. The outcome is measured from the
transaction: the request recorded and the rent and buffer in the renter's
vault, with a link to the request's own page. Taking a renter's request
still points to the current app.

Advances #3180.
