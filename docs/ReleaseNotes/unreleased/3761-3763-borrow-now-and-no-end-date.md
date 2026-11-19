## Thread — Borrow now, and lending with no end date (#3761, #3763)

The new app's Borrow page now opens on "Borrow now". The borrower states the amount, the most collateral to lock, the term and the highest rate they accept; no rate is suggested. The app lists the lenders standing ready on the pair (Auto-lends that gave the instant market's fill consent, and lender offers that charge interest by time), cheapest first, and asks the protocol itself what borrowing from them would give in this block, from the borrower's wallet. The review shows that figure, labelled as what this block gives, with each loan, its lender, its rate and the collateral it locks.

Collateral comes from the vault's free balance first and then from the wallet, which approves exactly its part, with the contract the approval is given to named on the review. So that the figure can be shown before that approval exists, the question is asked with the approval in place for the question only; where the token's records cannot be read that way, the review says the figure is not known until the approval is given. Signing asks the protocol again right before the wallet prompt, and the transaction carries the figure shown as the least it borrows, so it never borrows less. Any approval left unused is put back.

Where the lenders ready cover only part, the borrower can borrow that part and then post a request for exactly the rest, read from the transaction's own record. Where they cover none, or the instant market is off on the network, the review says nothing is borrowed now and offers a request. Every loan ends on its due date; renewal is not built yet.

On the Lend side, Auto-lend now has no end date unless the lender asks for one ("Lend for a set period"). Re-lending a repayment is pre-selected only where the platform's keeper reports that step running on the network, and the form says when it is not running or cannot be read. Renewal is shown as not available yet. The review says what no end date means and how funds in a loan come back, without promising a date.

Advances #3761 and #3763.
