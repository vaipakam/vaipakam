## Each chain now tracks how much reward funding it was actually sent

Groundwork only. Nothing reads this yet and no behaviour changes — it is the
first of three steps toward letting secondary chains pay rewards at all.

### The gap it fills

Reward funding for secondary chains is sent from the main chain. Until now,
when a secondary chain worked out how much it could still pay out, it
consulted the **programme-wide lifetime cap** less what it had paid locally.
That figure is nearly meaningless there: every secondary chain computes it
independently, so each one concludes it has almost the entire programme
available. What actually limits a secondary chain is what the main chain sent
it, and nothing was counting that.

A recent change did narrow this. Before paying, a chain now refuses if the
amount exceeds the tokens it holds that are not already spoken for. That is a
real improvement and it prevents the worst version of the problem. But it
measures **what the chain happens to be holding**, not **what was delivered
to fund rewards** — so tokens that arrived for some other reason (a donation,
an operator transfer meant for something else) can still be paid out as
rewards, and the main chain's own accounting never sees it happen.

So each chain now keeps a running total of the reward funding delivered to
it, separating the portion that is genuinely new from the portion that is
recycled value being relocated. The recycled portion is already tracked
elsewhere; counting it here too would double-count the backing.

### The subtlety worth recording

The obvious formula — funding received, minus everything paid out — is wrong,
and wrong in a way that would have been painful rather than merely inaccurate.

The paid-out figure is a lifetime total. It includes payouts made **before**
the chain was switched into the coordinated mode this funding belongs to, and
those were drawn from the ordinary programme schedule, not from anything
delivered. Subtracting them would charge the chain for a debt the delivered
funding never owed — deferring every payout until enough new funding arrived
to cover history. On a chain with any prior activity that is a standstill,
not a rounding error.

So the paid-out total is **snapshotted at the moment the chain switches over**
and measured from there. That keeps the figure correct regardless of prior
history, rather than depending on the switch happening at launch with a clean
slate.

Three separate places perform that switch — the main chain's own setting, and
two paths by which a secondary chain learns of it. Rather than ask each to
remember a second bookkeeping step, they now share one routine that does
both. Three independent copies of a two-part write is precisely the pattern
that goes wrong quietly here.

### What comes next, and why this cannot be used yet

Secondary chains do not currently price reward days in the coordinated mode at
all — that is deliberately blocked, and the block cannot lift until a separate
problem is solved (a day the main chain deliberately funds at zero would
otherwise be permanently closed out at zero, before the compensating payment
can reach it). Until that lifts there is nothing for this budget to limit,
which is why this lands as accounting with no consumer.

When it is applied, a shortfall must **postpone** the day rather than pay a
reduced amount. The existing shortfall behaviour trims and moves on, which is
right against the lifetime cap — that ceiling only ever falls, so a trimmed
remainder can never be funded later. A delivered budget is the opposite: it
**grows every time more funding arrives**, so trimming would permanently
underpay a day whose funding was merely still in transit.
