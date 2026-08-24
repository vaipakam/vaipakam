### A position sale now checks the fee rate the buyer inherits

A loan keeps the treasury-fee rate it was created under for its whole life, and
settles at that rate no matter what governance does later. That rule is
deliberate and unchanged — a retune must never re-price a loan someone already
holds.

What it did not account for is a loan changing hands. When a lender sells their
position, the buyer inherits the loan's original fee rate along with everything
else. If the fee has been lowered since that loan was created, the buyer ends up
paying the older, higher cut and earning less than the terms of their own
standing offer imply — and nothing they could look at would have told them so.
The rate is not part of the offer they wrote, and it does not show up in any
health or collateral reading.

Sales are now refused when the inherited rate is higher than the rate a loan
created today would carry. A position created under a **cheaper** rate stays
sellable, because its buyer inherits a better deal than a fresh loan would give
them — the same one-directional test already applied to the loan's inherited
risk terms. The refusal names the fee specifically rather than being reported as
a collateral problem.

The existing loan is untouched by this: it still settles at its own rate. A fee
change can now leave a position temporarily unsellable while it remains
perfectly valid to hold, repay, or liquidate.
