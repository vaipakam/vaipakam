## Thread — Collateral sales pay one proceeds leg to the platform (PR #2916)

A loan's own collateral listing used to ask the marketplace to pay three
parties directly: the lender-position holder, the treasury, and the
borrower-position holder, each a fixed amount written into the order when
it was posted. A borrow-or-sell listing carried into a loan was shaped
differently: it paid the whole price to the platform, which split it. The
two could pay the same sale differently, the loan's listing could not give
the lender the yield-fee discount a repayment gives, and its signed amounts
went stale as interest accrued or a position changed hands.

Both listing types now pay the platform one proceeds leg (the sale price
net of the marketplace fee legs), and the platform splits it in the same
transaction by one rule, at what a full repayment at the moment of the fill
would owe: the current lender-position holder its due plus any yield-fee
discount it qualifies for, the treasury its share net of that discount, and
the current borrower-position holder everything above that, into their
vault, or into their wallet when they have no vault or theirs is waiting on
a mandatory upgrade. That is the delivery the borrower's fee refund on the
same close already used: the borrower side's vault can never stop the sale
that pays the lender, and a payout never creates a vault. The loan is
marked settled before any of these payments moves, so nothing a payment
reaches can repay, claim or sell it again. The platform's own vault credit
now records what the vault actually received, which matters for the sale's
lending asset as it can be any token. A fill
that pays less than the lender's due plus the treasury's share is refused,
both by the listing's zone and again by the platform, and so is a fill after
the grace boundary. One event, CollateralSaleProceedsSplit, names every
amount as its recipient received it and says whether the remainder reached
the vault or the wallet, for either listing type; it replaces
the parallel-sale-only split event. A Dutch listing's posting floor is still
priced at its auction's end; its payout is what is owed at the fill, with
the excess going to the borrower side. The grace-period auto-list now
decides that an old order can no longer fill by reading its proceeds leg at
the current block against the live floor, and the executor no longer keeps
a per-order copy of the signed lender and treasury amounts.

Closes #2876 (owner decision 2026-10-26, "One proceeds leg"). This changes
the executor's storage and the order shape, so it reaches a chain only by
fresh deploy; the storage-layout break is acknowledged. The off-chain order
builder the indexer uses to publish a listing to OpenSea builds the same
one-leg shape in the same change, so a published listing's reconstructed
order still matches the one the platform signed.
