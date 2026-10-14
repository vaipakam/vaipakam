## Thread — Grace-ended inbox alert (PR #<n>)

The inbox now tells both parties when an open loan's grace window has
closed. Until now the calendar reminders stopped at "a loan went past its
due date": nothing told a lender that the loan had become theirs to close
out, or told a borrower that the ordinary repay window was over. The new
entry fires once per due date, during the first week after grace ends, for
both the borrower and the current holder of the lender position.

It is timed by the protocol's own rule rather than an approximation of it:
strictly after the due date plus the loan's grace length, which follows the
protocol's configured grace schedule (the default unless governance has set
custom tiers). So the inbox never says a loan can be closed out a moment
before the contract would accept the close-out. Like the other reminders it
is worded as a fact as of the notice and points at the position page, which
is the authority for whether the loan was later repaid or closed out. It
covers loans whose collateral has no price feed, because it is computed
from the loan's dates alone.

The reminder sweep's look-back widened by that one week, and an
already-announced past-grace loan is dropped from each tick's working set
the same way the earlier reminders are, so it cannot crowd out loans that
still have something to say. A follow-up to #2463 (the lender close-out);
no schema change.
