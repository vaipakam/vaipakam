### Partial repayments: deleveraging is no longer blocked, and settled interest isn't double-counted (Pass-2 A2 + A3, #1190 / #1191)

Two fixes to voluntary partial-repayment paths.

**A2 — a partial repayment can no longer be rejected for "health factor too low."**
A partial repayment reduces the borrower's debt while their collateral stays
locked, so it can only *improve* the loan's health factor. The old check
nonetheless rejected a partial unless the loan's health factor *after* the
payment was already back above the strict 1.5 origination threshold — which
inverted the intent: it blocked exactly the case where a borrower (or the lender)
most wants a partial, i.e. an underwater loan the payment improves but doesn't
fully cure (say health factor 1.2 lifted to 1.4). The check now simply requires
that a partial not *worsen* the health factor, which matches the spec (partial
repayment is granted with no post-payment floor). Under-collateralized borrowers
can now deleverage as intended.

**A3 — interest already settled by an automatic periodic charge is no longer
re-charged or mis-counted at a partial.**
On loans using the (currently dormant) periodic-interest feature, an automatic
period settlement records interest the borrower has already paid. Two voluntary
partial paths — a normal partial repayment and the swap-to-repay partial — did
not account for that previously-settled interest: they could charge it a second
time at the partial, and they left the settled amount lingering afterward, which
downstream settlement then subtracted from future interest — understating the
debt (delaying liquidation) and underpaying the lender at final close. Both paths
now credit the already-settled interest against the partial's charge and clear
it once consumed, matching the treatment the same fix already applied elsewhere.
Loans not using periodic interest are unaffected.
