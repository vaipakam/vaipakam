# The next app lets a lender post an offer in parts

In Advanced mode, a lender posting their own offer on the next app's Lend page can now let matches lend it in parts, and can choose how it fills. The amount typed stays the whole amount: posting locks all of it, and a borrower taking the offer directly still borrows all of it, which is how the protocol sizes a direct take of a lending offer. The lender adds the smallest part one match may lend; a part larger than the whole amount is refused on the form.

The review's figures are the whole amount's. It also states the smallest part and the least collateral a match asks for it: the protocol pro-rates the collateral the lender asks for the whole amount to the part matched, rounding down. The consequences say that matches lend the offer in parts at the lender's rate while matching is switched on for the network (the switch is stated whether on, off or unread), that once a match has lent a part no borrower can take the rest directly (cancelling takes it back), and that when less than the smallest part is left the protocol returns it to the lender's wallet and closes the offer.

The fill mode is now offered to a lender as well as a borrower: partial by default, all or none for one loan of the whole amount (so not with parts), or immediate or cancel, which needs an expiry. Any mode other than the default, and any offer in parts, is stated as fixed once posted. Options set in Advanced still apply in Basic, which says so and offers to clear them.

When the protocol refuses an offer because it asks for less collateral than the whole amount needs at today's prices, the review now names that as the lender's to fix and states the least collateral the protocol asks, instead of showing the raw reason. The lender's interest schedule and fee tariff follow in a later update; in Advanced mode the form says so.

The user guide's Basic and Advanced editions describe an offer in parts in every language.

Rulebook: `docs/DesignsAndPlans/Alpha05AppDesign.md` RB-LEND-POST. Epic #3180.
