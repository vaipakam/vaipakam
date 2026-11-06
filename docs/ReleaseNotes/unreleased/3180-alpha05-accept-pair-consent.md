# The next app asks for a standing pair agreement before taking an offer on an illiquid pair

Taking a lender's offer on an illiquid pair used to go through on the acknowledgement every acceptance carries, without a standing agreement to that pair. The owner decided on 2026-11-06 that this acknowledgement no longer stands in for the agreement: the borrower taking an offer needs a recorded agreement to that exact pair, in effect after any waiting period, just like the lender who posted it. The protocol change is #3231.

The next app's Borrow page now applies this rule. An offer on an illiquid pair that the wallet has not agreed to is shown as needing a step, the review offers the pair agreement in place, and the offer can be taken once it is in effect. This is also correct on networks still running the earlier rule: the agreement clears the block there as well, so nothing is wrongly held back. The Advanced guide's risk-access section says so in every language.

Epic #3180.
