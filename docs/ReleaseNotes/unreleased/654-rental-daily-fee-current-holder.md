## Thread — NFT-rental daily fee follows the current lender-position holder (PR #<n>)

Fixes a fund-misrouting bug surfaced during the #594 design review: the
permissionless daily rental deduction (`autoDeductDaily`) paid each day's lender
share **directly to the stored `loan.lender`**, with no claim indirection. So
after a lender-position NFT was sold or transferred on the secondary market, the
daily rental income kept flowing to the **departed** lender instead of the
current holder.

The daily deduction now routes the lender's share to the current
`ownerOf(lenderTokenId)` resolved at payment time, with the same direct-recipient
sanctions gate the other direct-payout paths use — mirroring
`_autoLiquidatePeriodShortfall` and `RepayFacet.repayPartial`. The loan is Active
when the daily fee is taken, so the lender position NFT is live and `ownerOf`
holds.

The other rental lender paths were already correct and are unchanged: full
`repayLoan` and `markDefaulted` deposit the lender's share into the lender vault
and write a `lenderClaims` row, which the current holder pulls through the
`ownerOf`- and sanctions-gated `ClaimFacet.claimAsLender`; the rented NFT itself
likewise returns to the current holder through that same gated claim. Only the
direct-payout daily path needed the current-holder routing.

This is the lender-side analogue of the borrower-side drain protection — the
rental income stream now follows position-NFT ownership over the life of the
loan (earlier days to the old holder, later days to the new one).

Closes #654.
