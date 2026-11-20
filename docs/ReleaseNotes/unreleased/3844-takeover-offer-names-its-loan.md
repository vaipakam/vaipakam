## Thread — An obligation handover takes only an offer that names its loan (PR #<n>)

An obligation handover moves a loan's debt from its borrower to a new borrower, who pledges collateral and receives no principal. Until now the leaving borrower could hand the debt to any matching open borrow request. A request to borrow is not a request to take over someone else's debt, so the handover now consumes only an offer its creator posted for that purpose, naming the loan.

The incoming borrower posts such an offer with a new entry, `createTakeoverOffer`, which takes the loan id beside the usual offer terms. The offer is a borrower offer in every other respect: the creator's collateral moves into their vault, and the book bounds and the Terms rule apply. The offer records the loan it names, a `TakeoverOfferPosted` event carries the same record, and `getTakeoverOfferLoan` returns it (0 for an ordinary request). That record is the creator's own statement that they take on the existing debt and receive no principal, so a review screen can say so from the record rather than from the route.

The handover refuses any offer that does not name the loan being handed over, before any state change. An offer that names a loan never opens a new loan: a direct accept and a match both refuse it, and their previews report it with new appended codes.

The app and the indexer do not yet offer the new posting or hide such offers from the order book; that is #3845.

Closes #3844

> Caveat: until #3845 lands, the app's handover screen lists ordinary requests the contract now refuses, so a handover can be attempted only from a takeover offer posted by direct contract call.
