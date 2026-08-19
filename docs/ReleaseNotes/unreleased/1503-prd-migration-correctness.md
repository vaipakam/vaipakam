## Selling or handing over a position now carries its bookkeeping with it (PR #TBD)

Two things that should have moved when a loan position changed owner did not.

**A bought position was not findable by its own token.** The platform keeps a
lookup from position NFT to loan, so a holder can go from the token in their
wallet to the loan behind it. That lookup was written once, when the loan was
created, and never revisited. Every sale mints the buyer a fresh position token
and retires the seller's — so after any lender sale the buyer's token led
nowhere, while the seller's superseded token still pointed at a loan they no
longer held. Anything reading the loan by token — position lists, the loan
lookup a holder's own client uses — answered for the wrong party or not at all.

The same was true when a borrower handed their obligation to someone else. The
audit item was written about lender sales, because that is where it surfaced,
but the lookup is keyed by position token rather than by side, so the borrower
half had the identical gap. Both are fixed together, in the one place every
position migration passes through, rather than at each route that happens to
move a position — the point being that a future route inherits the correct
behaviour instead of having to remember it.

**A seller's lending capacity stayed reserved after they exited.** A lender who
sets a standing intent has a cap on how much principal they can have live at
once. When they exit a loan through the listed sale route, that cap is freed
immediately, because waiting for the buyer to claim would hold the seller's
capacity hostage to an action the buyer may never take. The instant sale route
never did this, so a seller who exited that way kept the exited loan counting
against their own limit — quietly reducing how much they could lend, with no
error and nothing to indicate why.

Neither of these is a loss of funds. Both are the same shape as several recent
fixes on the lender-exit paths: a mechanism that exists, is correct, and was
applied to one route and not its sibling.

Part of #1503 (items 17 and 25).
