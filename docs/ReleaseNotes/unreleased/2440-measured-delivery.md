## Thread — The protocol books only what arrived (PR #2622)

Every token move the protocol records is now measured where the tokens land,
so no ledger can name tokens that are not there. Before this change the
protocol recorded the amount it asked a token to move. For an ordinary token
that is the same thing, but a token that delivers less than it sends (a fee on
transfer, share rounding, an upgradeable token that switches a fee on after a
loan opens) left the books ahead of the balances. A forced close-out then sold
or forwarded the full recorded collateral, and the difference came out of
tokens the protocol holds for other users. A deposit or repayment recorded the
full amount against a vault that received less, so the lender's claim could
not be paid in full.

The rule now has three outcomes, decided by who is acting. A payment or
deposit from a user's wallet (offer funding, collateral, a rental prepayment,
repayment, preclose, refinance, a liquidator's payment, a fee, and Permit2
pulls) is refused by name unless all of it arrived. A move out of a vault the
owner chose to make now (a rental repayment, a lender's early-withdrawal sale,
swap-to-repay) is refused the same way. A move the protocol must complete
(liquidation in all its routes, time-based default including the in-kind and
rental cases, periodic-interest auto-liquidation, the fallback entry and the
fallback retry) never stalls: it acts on what arrived, and the shortfall
reduces only that loan's own figures. In an internal match, a leg that
delivers less clears only what it delivered of the receiving loan's debt, and
the rest stays owed on that loan. This keeps the lender-first principle
(owner decision 2026-10-20): issue #2440 suggested refusing a short delivery on
liquidation, which was deliberately not taken because it would trap the lender
once a token switched a fee on. Every credit into a vault (lender proceeds,
borrower surplus, fallback custody, claims, internal matches, consolidation,
backstop seeds, prepay listings) records what the vault received, and the
claim, lien or custody row beside it uses that same figure. A move whose
source is also its destination (one user on both sides of a match or a
default, so tokens move from that user's vault into the same vault, or a
payer who is also the payee) counts as delivered in full for an ordinary
token, because the tokens stay where they were sent.

Review of the change added the remaining moves that are recorded as a payment
in full. Accepting an offer now refuses a lending asset whose net principal
reaches the borrower short, as it already refused short collateral. A rental
day's fee, a partial swap-to-repay, an in-place extension and the lender's
share of a marketplace collateral sale are refused the same way, so a rental
whose prepay token starts charging is no longer serviced day by day and
settles through the time-based default at the end of its term (the renter's
buffer then goes to the treasury, as on any rental default). The forced
payouts to a lender out of resident tokens (periodic auto-liquidation and
partial liquidation) now report what the lender received, and the loan books
only that; a short payout leaves the period it settles open. A failed
fallback retry that restores less than it pulled lowers the loan's recorded
collateral along with the custody. The optional backstop purchase of fallback
collateral is priced on what actually reached the backstop, and its cash to
the lender must arrive in full. Moving parked lender proceeds to a new holder
shrinks the reservations beside them to what arrived. Two backstop
withdrawals credit the treasury with what reached it.

Every fee into the treasury drawn from a wallet or a vault now runs through
one small new facet, TreasuryFeeFacet, which measures what the treasury
received and records the accrual once. A wallet fee is refused unless it all
arrived; a vault fee is recorded as it arrived and never stops a close-out.
Moving the fee legs there is also what keeps PrecloseFacet under the contract
size limit. Two related defects were fixed on the way: a rental preclose
moved the lender's rental share into the lender's vault without recording it,
so the lender's claim could not be paid; and a rental default sent the
forfeited buffer to the treasury without recording the accrual. Deployments
must refresh TreasuryFeeFacet together with its callers; the complete refresh
and both curated refresh scripts carry it.

Closes #2440. Closes #667. Addresses #1281 item 011. Out of scope and
unchanged: the VPFI recycling and reward custody paths, which already measure
their own deliveries.
