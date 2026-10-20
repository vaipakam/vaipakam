## Keeper — the reward claim-horizon heartbeat (PR #<n>)

The reward claim horizon (RL-3, #1956) lets a reward that its owner never
claims be reaped into the recycle bucket, but only after the reward has stayed
claimable for the whole horizon plus a 90-day notice — measured as time the
owner could actually have claimed, not calendar time. That clock advances only
when something touches the reward, and nothing did: with the horizon switched
on, no clock would start, no final notice would be filed and nothing would
ever expire, while the setting read as live. The keeper now provides the touch.

The new keeper pass keeps a private list of every reward that is not yet
settled, read from the chain's own sequence of rewards, and touches each one
about every 12 hours, far inside the contract's 7-day limit on how far apart two
touches may be and still count. A touch on a reward that cannot advance changes
nothing. While the horizon is off, the pass only keeps its list current and
finishes the settlement of any reward whose removal had already begun; so it can
be armed first and the horizon switched on afterwards, and clocks start at once.
It reports to the operations chat when a touch is refused (naming the reward and
why), when due touches have not landed for two rounds, and when a reward's clock
did not advance across two landed touches, saying both readings: an owner who
could not claim in that time (expected), or touches landing without being
credited (a fault). Its moves of value go only to the recycle bucket, never to
the keeper.

The pass ships disarmed behind its own flag, `REWARD_HORIZON_HEARTBEAT_ENABLED`,
and its list lives in a new private keeper database migration. The governance
runbook now states what "verified" means before the horizon is armed on a
chain. Part of #2517; the end-to-end scenario against a local chain follows
in its own change.
