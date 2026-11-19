# Keeper waits out the forced-sale fallback gate (#3538)

A health-factor liquidation or a past-grace default whose every swap route
fails no longer moves a loan into the in-kind fallback in one transaction.
The contract first records the failure and undoes the sale, and opens the
fallback only to a failing sale made at least ten minutes after the first.

The keeper now follows that rule. It sends the first failing sale, which
starts the ten minutes, and retries once with a fresh quote in case the
failure was the quote's and not the market's. After that it stops paying to
record more failures and says in its log when the fallback opens. From then
on a sale that still fails is sent, so a market that is really dead costs
the lender about ten minutes. A sale that works is sent whenever it is found.

The past-grace pass, which used to refuse any sale it could see falling
back, now sends one once the loan's record shows an earlier failure and the
ten minutes have passed. On a deployment without the rule it keeps refusing.
The shared close-out preview now reports a deferred ending, so the app's
close-out card can say so too.
