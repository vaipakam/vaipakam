## Previews the app can read before a takeover, a direct sale or an instant borrow (#3761)

The new app needed to tell a user what an action would do before asking
for a signature, and three actions had no way to say it except by trying
them. They now each have a read.

A lender handing an instant-market loan to another lender's Auto-lend
intent can see whether the takeover would be accepted now and the
principal the incoming intent would pay. The read runs the takeover's own
admission, so it and the takeover cannot disagree, and a refusal comes
back as the takeover's own reason.

A lender selling a loan into a standing buy offer can see whether the
sale would be accepted, what they would net, the rate shortfall left for
the buyer, and the funds already held for the lender that move with the
position. Before, the app learned the net from the sale's own refusal.
The read runs every check the sale runs before money moves; the app binds
the sale to the figures it showed.

A borrower can see what an instant borrow would take from each source,
which sources would be refused and why, and how much collateral would come
from the vault and how much from the wallet, without approving a token
first. It sizes each source by the fill's own rule but does not run the
loan checks a fill runs when it opens its loan, and says so: a simulation
of the borrow stays the binding answer.

The late-fee schedule (1% on the first day past due, 0.5% more each
further day, capped at 5%) is now readable, from the same fixed figures
the fee is charged by, so an offer review can state it.
