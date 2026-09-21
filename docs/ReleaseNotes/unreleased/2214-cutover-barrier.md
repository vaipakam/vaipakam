# The writers are held while the off-chain database is moved

The platform's off-chain database is being moved to its successor. For the
length of that move the three services that write to it — the indexer, the
keeper and the agent — are deployed with **no way to reach any database at
all**.

That is the point, and it is not a precaution layered on top of one. Nothing
available to the platform can revoke a handle that already-running work holds,
so the only thing that genuinely stops new writes is deploying services that
cannot name a database. Watching a database hold still is evidence; removing
the means to write to it is closer to proof, and the difference is what this
step buys.

**What a user sees during the window.** Indexed activity stops advancing, so
recently confirmed on-chain actions take longer than usual to appear; alerts
and notifications pause. Nothing is lost — the chain is the record, and the
services resume reading from it when the move completes. No funds are moved,
touched, or at risk at any point: this is a move of off-chain bookkeeping
between two databases, and the database being left behind is **retained** in
full afterwards, so nothing depends on the move having been perfect.

**What happens next.** Once the services are confirmed to be serving with no
database access, the old database is read twice ten minutes apart to confirm it
has stopped changing, its rows are copied to the new one, and the services are
redeployed against the new database. Afterwards the old one keeps being
compared against the new one — weekly, for as long as it is kept — because work
suspended across the window can still commit afterwards, and retaining the old
database makes such a record recoverable while only continuing to compare makes
one found.

If this state is still in place long after it was announced, the move did not
finish; the operator runbook says what to do, and restoring the previous
configuration is explicitly not it.
