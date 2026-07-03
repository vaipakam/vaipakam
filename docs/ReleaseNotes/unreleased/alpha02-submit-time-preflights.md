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

Advanced mode also gains refinancing: the original borrower of an
active, not-yet-matured loan (refinancing is only offered while the
position hasn't changed hands — collateral carry-over is tied to the
original borrower) can post a refinance request — a borrow offer for
exactly the loan's outstanding amount, marked so that the moment any
lender accepts it, one transaction opens the new loan, pays the old
lender off from the borrower's wallet, closes the old loan, and moves
the collateral across without ever unlocking it. The review states the
payoff rule plainly (always principal plus the full remaining term's
interest — the exiting lender's fixed entitlement, regardless of the
loan's day-by-day setting), how much spare balance the wallet must
keep while the request is open, that a short balance simply makes an
acceptance fail with nothing taken, that posting takes up to three
wallet confirmations whose earlier steps persist if abandoned partway,
and — for loans on a periodic payment schedule — that the replacement
loan won't carry one. The request expires on-chain at the reviewed
lifetime, so a forgotten request can't be accepted months later, and
completion is additionally bounded to the reviewed rate ceiling. The
page remembers and live-verifies the pending request in a standing
card that outlives every other gate — it stays through data hiccups,
mode switches, maturity, and even the loan settling another way. That
card warns distinctly when the standing payoff approval no longer
covers completion (with a restore action that first re-verifies the
request is still completable) or when the wallet balance is short,
holds off partial repayment and close-early while the request is live
(either would strand it), warns inside the full-repayment review that
the request survives settlement until cancelled, and cancels in place
— cancellation opens a few minutes after posting per the protocol's
cooldown (judged by chain time) and also removes the standing payoff
approval. Abandoning the posting sequence partway automatically
unwinds an already-granted payoff approval.

Lenders get their own advanced-mode exit: selling an active loan
position into a matching open lending offer. The picker shows only
offers the sale can really complete against and leads with what the
seller would receive — principal minus the forfeited accrued interest
or, if larger, the rate difference the higher-rate buyer expects for
the remaining term (flagged clearly before review). Payment lands in
the seller's wallet in the same transaction: nothing to approve,
nothing to claim, and the borrower's terms don't change. Because a
bought-out offer can briefly linger as available in off-chain data,
confirming always re-verifies the chosen offer live and re-reads the
payout with chain time, asking for a fresh review if anything
material moved.

Lenders can also list a position for sale at their own rate. The
review states, before anything is signed, that the lender position
NFT is locked until the sale completes or the listing is cancelled,
and that the settlement — the larger of interest accrued by
acceptance or the rate difference for the remaining term — is pulled
from the seller's wallet inside the buyer's transaction, which is why
listing sets a standing approval sized to cover the loan's whole term
plus a month's headroom. The listing's status card is driven by the
chain itself (the lock on the position NFT), so a listing made on
another device still appears, still warns when the approval or
balance would make a buyer's acceptance fail (with a restore action
that first verifies the listing still stands; where the listing's
record can't be identified the card says the funding can't be
verified rather than showing a false all-clear), and cancelling —
where the listing id is known, once the protocol's short cancel
cooldown passes — unlocks the NFT and removes the approval, with the
outcome reported on the page. A listing that ends off-page (accepted
or cancelled elsewhere) is announced once instead of silently
disappearing. On the buyer's side, accepting an offer that is really
a position sale is clearly disclosed before signing: the review names
the running loan being bought and waits for that check to resolve.
