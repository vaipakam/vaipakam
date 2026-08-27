# The reward expiry clock now stops when a claim would be refused

**Task:** #1499

Interaction rewards can eventually expire: once a reward has been claimable for
a long enough stretch, a keeper may sweep it back into the recycling pool. The
clock that measures "claimable" is supposed to run only while the owner could
actually have collected.

It did not match the claim. The claim refuses a payout whose funded part will
not fit above the balance already spoken for by the recycling bucket and the
recovery reservations; the expiry clock was testing the raw balance instead. On
a thinly funded deployment those disagree, and they disagree in the direction
that costs the claimant: the clock keeps running through a period when every
attempt to claim reverts, and the reward can then be swept away on time the
owner never had.

The clock now measures the same thing the claim does — the balance net of what
is already reserved, and whether the recycled part of the payout can actually be
transferred. Where the platform cannot compute a claimant's exact recycled
obligation it uses a bound that may pause a clock which would in fact have run,
and never the reverse. Pausing only delays a sweep; running too freely destroys
the reward.

Nothing is observable yet: the expiry horizon ships switched off, so no clock is
accruing on any deployment today. This is the correctness precondition for
turning it on.

Also in this change: the sweep and the countdown now compute each claimant's
per-user figures once and share them, instead of recomputing the same walks
several times per reward examined. That work grew with a claimant's history and
could have pushed a keeper's batch past the block gas limit, which would have
stranded exactly the rewards the sweep exists to process.
