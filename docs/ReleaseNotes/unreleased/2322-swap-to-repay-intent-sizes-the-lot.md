## Thread — repay-from-collateral by auction puts up only what the order needs (#2322)

The auction form of repaying a loan from its collateral — where the
borrower posts an order and a resolver fills it — used to put the loan's
entire collateral up for sale, whatever the order asked. A filled auction
therefore turned every unit of collateral into the lending asset and paid
the excess out as surplus, which is the same problem the direct form had
until #2317. The functional specification says collateral the repayment
does not need stays pledged and returns to the borrower through their
claim, and that rule covers both forms, so the auction now follows it.

When a borrower commits an order, the protocol now puts up only the least
collateral whose worst-case value, under the same borrower-facing slippage
allowance the direct form uses, covers the least the order will accept.
Both forms size the sale through one shared rule, so they cannot drift
apart. The rest of the collateral never leaves the borrower's vault and
stays pledged for the whole auction. After a fill, the borrower claims it
through the ordinary claim, together with any part of the auctioned lot the
fill did not take, and it stays pledged until they do. A cancelled or
expired auction returns the lot and leaves the loan exactly as it was. An
order asking more than the whole collateral could be worth at that floor
cannot be backed by any lot, so it is now refused at commit instead of
sitting unfillable. A new read-only preview shows how much collateral an
order would put up before the borrower commits. The committed order is the
one to post to the resolver network, because prices can move between the
preview and the commit.

Fixing this also exposed an accounting issue in how the pledge was
restored after a fill. The old code assumed the whole collateral had been
unpledged at commit, and re-pledged the borrower's whole remaining claim on
top of whatever was still pledged. With the untouched part now pledged
throughout, that would have counted it twice. After a fill the pledge is
now set to exactly the borrower's claim. No shipped interface drives the
auction form yet, and the live testnet still runs the previous contracts
until an operator refreshes them. Closes #2322.
