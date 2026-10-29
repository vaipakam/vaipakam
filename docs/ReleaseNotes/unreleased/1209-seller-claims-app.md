## Thread — sellers see and collect their interest claims (PR #3072)

The app now follows the rule that a lender who sells keeps the interest they
earned. The sell-now and listing screens no longer say the earned interest is
forfeited: the only cost at the sale is the rate top-up when the buyer's rate
is above the loan's own, and the review states, apart from the payout, about
how much interest the seller has earned so far and that it stays theirs as a
claim on the loan. It also says what that claim risks: it is paid as the
borrower pays interest, and if the loan ends short the buyer's principal is
paid first. No fee is taken at the sale; the usual cut of interest comes out
of the claim when it is paid.

The Claims page has a new card, "Interest from positions you sold". A seller
holds no position token any more, so the app finds these loans from the
activity index (every step of a seller claim is now filed under the seller)
and reads each one from the chain: what is still owed to this seller, and what
has already reached their vault, per asset. Each loan says where it stands
(being paid as the borrower pays, waiting on a fallback, or settled at
withdrawal from what the loan recovered). The withdraw button appears only
when the protocol's own check says the withdrawal would pay something now,
and that check runs again just before signing. When the index is down, a loan
cannot be read, or a wallet has more sales than the card reads, the card says
so rather than showing nothing.

The contracts behind this (PR #3068) reach the testnets only with the all-waves
fresh deploy. Until then the sale quote stays unavailable on the old Diamonds
and the card lists nothing, because no seller claim exists there. Advances
#1209.

> Caveat: Claim all does not include seller claims yet; each is withdrawn from its own row.
> Caveat: no end-to-end spec drives a seller claim until a Diamond with the new facets exists to run it against.
