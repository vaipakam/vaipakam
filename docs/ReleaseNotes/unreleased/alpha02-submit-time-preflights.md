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
active, on-time ERC-20 loan can close it early from the loan's detail
page. The review states the real cost up front — full-term loans (the
protocol default) still pay the whole term's interest when closed
early, day-by-day loans pay only what has accrued — with the exact
amount read live at confirmation and collateral released immediately
after closing.
