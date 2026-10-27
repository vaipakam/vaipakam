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
net of the marketplace fee legs), and the platform settles the loan in the
same transaction by one rule, as a repayment funded by the collateral, at
what a full repayment at the moment of the fill would owe. The loan becomes
repaid, exactly as after a repayment: the lender's due, plus any yield-fee
discount the current lender-position holder qualifies for, waits in the
lender's vault for the ordinary lender claim; the treasury receives its
share net of that discount; and the current borrower-position holder
receives everything above that in their wallet. When that holder is flagged,
or their wallet refuses the payment, the remainder is held for them and paid
by the ordinary borrower claim, using the same pay-or-hold rule the periodic
forced sale already used. The loan settles when the lender claims, as after
any repayment.

The sale is neutral between the two sides. Before, the whole sale was
refused when either position holder was flagged, or when the lender's wallet
refused the token, so one side could stop the other's payout. Now a flagged
lender holder, or a lender wallet that would refuse the token, cannot stop
the borrower's sale or get a standing listing cancelled, because the lender is paid through the claim, which
decides on its own screen when the money may leave. A refusing borrower
wallet cannot stop it either. The one refusal left is the borrower's own: a
borrower-position holder flagged by the time of the fill cannot sell their
collateral, and the loan simply stays open with all of the lender's rights.

The loan is marked repaid before any payment moves, so nothing a payment
reaches can repay or sell it again. A fill that pays less than the lender's
due plus the treasury's share is refused, both by the listing's zone and
again by the platform, and so is a fill after the grace boundary. One event,
CollateralSaleProceedsSplit, names every amount and says whether the
borrower's remainder was paid or held, for either listing type; it replaces
the parallel-sale-only split event. The indexer now records a sold loan as
repaid (claimable) instead of settled, and the inbox tells both sides about
the sale. A Dutch listing's posting floor is still
priced at its auction's end; its payout is what is owed at the fill, with
the excess going to the borrower side. The grace-period auto-list now
decides that an old order can no longer fill by reading its proceeds leg at
the current block against the live floor, and the executor no longer keeps
a per-order copy of the signed lender and treasury amounts.

Closes #2876 (owner decision 2026-10-26, "One proceeds leg"; neutrality per
owner direction 2026-10-27). This changes the executor's storage, the order
shape and the sale's close, so it reaches a chain only by fresh deploy; the storage-layout break is acknowledged. The off-chain order
builder the indexer uses to publish a listing to OpenSea builds the same
one-leg shape in the same change, so a published listing's reconstructed
order still matches the one the platform signed.
