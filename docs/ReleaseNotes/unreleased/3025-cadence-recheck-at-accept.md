## Thread — The cadence rule runs again when a loan opens (#3025)

The cadence admission rule from #3009 ran only when an offer was posted and
when its amount changed. An offer could therefore wait in the book while the
rule's inputs moved underneath it, and then open a loan the rule would now
refuse. The plainest case: a lender posts a two-year offer with no periodic
interest while the feature is switched off, which is allowed, and the feature
is then switched on. A fresh two-year offer on those terms would be refused,
because the annual checkpoint is mandatory on multi-year loans while the
feature is on, but the old offer could still be accepted.

Now every loan that opens from an offer is admitted by the same rule at the
moment it opens: a direct accept, every match and intent fill, and the
acceptance of a refinance or offset offer all pass through the one place a
loan is created, and the rule runs there on the loan's own terms. Those terms
are the principal actually funded, both legs' liquidity as it reads in that
transaction, and the current switch and threshold. An offer the rule would
now refuse is refused with the rule's own error until its creator cancels it
and posts it again. Owner decision 2026-10-28, "Re-check at accept".

The lender's early-exit sale listing is exempt, as it is at posting: it
carries the live loan's cadence and opens no new position.

> Caveat: liquidity is classified live, so a cadence offer whose collateral
> turns illiquid after posting is refused at accept for as long as it reads
> illiquid.
