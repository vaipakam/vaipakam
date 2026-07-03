# alpha02 — submit-time preflights, consent integrity, disclosure accuracy

The naive-user connected app now re-checks every fact that matters at
the moment of signing, not just at review time. Immediately before any
token approval or signature, the app re-reads live from the chain: the
wallet's balance of whatever is being locked or paid, whether either
asset of the deal is protocol-paused, whether the connected wallet
still holds the position it is acting on (positions travel with their
NFTs), the current grace window (including governance-configured
schedules), and — where the review showed no "unpriced asset" warning
— whether either side of the deal has since become unpriced. Anything
stale aborts with a plain explanation before the user pays for a
doomed transaction; an unreadable answer never silently passes where
it gates a disclosure.

Consent is now tied to what was actually reviewed: editing any term of
an offer or listing, or picking a different offer or listing, clears a
previously ticked risk-and-terms acknowledgement so it must be given
again against the new facts. If the "unpriced asset" warning appears
after consent was already ticked (the check resolves asynchronously),
consent is cleared and must be re-given with the warning visible.

Review copy is more precise: offer receipts state the loan's interest
mode explicitly (full-term interest applies even when repaying early;
day-by-day loans cost less when repaid early), self-posted offers with
unpriced assets get the same in-kind-default warning as accepted ones,
and one-year offers now show their correct 30-day grace window. The
shown grace period and the enforced grace window are derived from the
same schedule so they cannot drift apart.

Advanced mode gains the first loan-strategy action: borrowers on an
active, not-yet-matured ERC-20 loan can close it early from the loan's
detail page. The review quotes the protocol's own settlement figure —
never a locally derived estimate — and states the interest-mode
implication up front: full-term loans (the protocol default) still pay
the whole term's interest when closed early, day-by-day loans pay only
what has accrued. The figure is re-read live at confirmation, maturity
is judged by chain time at both display and confirmation, and
collateral is released immediately after closing. After a successful
close or repayment the page stops offering repay-family actions until
fresh data confirms the loan's state, and only one pending-action
review can be open at a time.

Advanced mode also gains refinancing: the borrower of an active,
not-yet-matured loan can post a refinance request — a borrow offer for
exactly the loan's outstanding amount, marked so that the moment any
lender accepts it, one transaction opens the new loan, pays the old
lender off from the borrower's wallet, closes the old loan, and moves
the collateral across without ever unlocking it. The review states the
payoff rule plainly (always principal plus the full remaining term's
interest — the exiting lender's fixed entitlement, regardless of the
loan's day-by-day setting), how much spare balance the wallet must
keep while the request is open, and that a short balance simply makes
an acceptance fail with nothing taken. Posting sets on-chain
guardrails at the reviewed rate ceiling and end-date window, and the
request can be cancelled any time before acceptance from the same
page, which remembers and live-verifies the pending request.
