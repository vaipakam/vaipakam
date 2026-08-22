## Buying a position: an out-of-date listing is now refused instead of sold

A position put up for sale is advertised through a listing that states what the
position permits — whether the borrower may repay it in instalments, whether
they may raise money against it by listing a prepayment, which interest model
the loan runs under, and whether interest falls due periodically. Those four
things decide what the borrower can do to whoever buys the position, and how
that buyer is paid, so a buyer chooses on them.

Listings created from a recent change onwards copy those terms off the live
position, so they describe it accurately. Listings created **before** that
change did not: they still say "none of the above" while the position itself may
permit all of it. Nothing caught this, and the reason is worth stating plainly.
When a buyer commits, the platform checks that what the buyer signed matches
what the listing said — and on an out-of-date listing those two agree
perfectly. The buyer read the listing, signed exactly what it advertised, and
every application shows the same thing. The mismatch is not between the buyer
and the listing; it is between the listing and the position, and nothing was
comparing those two.

That comparison now happens at the moment of purchase. If a listing's terms
disagree with the position it sells, the purchase is refused before any of the
buyer's money moves, and the refusal says what it actually is: the listing is
out of date and the seller needs to relist. That wording matters — the buyer did
nothing wrong, so telling them their terms don't match would send them to sign
the same wrong listing again. Relisting produces a correct listing, because
listings have described their positions accurately since the earlier change.

One thing about that refusal took most of the work to get right: it is only
ever the answer when nothing else is. "The listing is out of date, ask the
seller to relist" is useful advice, but only where relisting is actually
possible — and often it isn't. A position that has already been repaid,
defaulted or liquidated cannot be relisted at all. Neither can one that has
passed its due date, or one whose seller has since been placed under
sanctions, or one holding an asset the platform has paused. In each of those
cases the platform has a reason that the person reading it can act on, and
answering "relist" instead would have buried it behind advice that cannot be
followed. So the out-of-date refusal now speaks last, after every other reason
a purchase can be turned down, and the buyer sees the reason that is worth
seeing. The preview shown on the card and the refusal from the transaction
itself agree on which one that is, so the card never offers a purchase the
transaction then rejects for a different stated reason.

Sellers and buyers on current listings notice nothing: an accurate listing
satisfies the check by construction, and a normal purchase is unaffected.

This closes a gap that had been recorded but left open, because the change
needed room the accept path did not have until the facet carrying it was split
in the preceding release. The check costs 164 bytes; before the split there were
exactly 164 bytes free, which would have left nothing for whatever came next.
