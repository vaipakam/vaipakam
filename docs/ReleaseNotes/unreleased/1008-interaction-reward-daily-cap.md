## Interaction rewards: the daily cap is now enforced per day, not per loan window (#1008)

The platform gives out a small VPFI interaction reward for participating in a
loan, and that reward has always been meant to carry a **daily** ceiling — a
cap of 0.5 VPFI for every 0.001 ETH of eligible interest, on each side, each
day. That ceiling is the main defence against "wash-farming" the reward pool.

Until now the code applied the ceiling **once across a loan's whole reward
window** rather than day by day. The practical effect was a loophole: a day
where a participant's share of the pool spiked far above the ceiling could be
quietly netted against other days that sat below it, so the spike leaked
through instead of being trimmed. The reward paid could exceed the sum of the
individual daily caps.

This change closes that loophole. The cap is now applied **per day**: each
day's reward is trimmed to the ceiling on its own, and only the trimmed amounts
are added up. A quiet day's unused headroom can no longer absorb a high-share
day. For anyone who was always under the ceiling, nothing changes; only a
genuine over-cap day is now trimmed, exactly as the rule always intended.

**How the daily ceiling is priced.** The ceiling depends on the ETH price and
the governance cap setting. Those are now read **once, when a day is finalised**
(rather than at the moment someone claims), and the same finalised value is
shared across every chain so the cap is identical everywhere. A consequence
worth stating plainly: a change to the cap setting applies to days that have not
been finalised yet — it does not retroactively re-price days that are already
finalised. If the reward system's price feed is briefly unavailable when a day
is finalised, that single day is left uncapped rather than blocking
finalisation; the outage cannot spill onto other days.

**Cross-chain funding stays exact.** The amount of VPFI shipped to each mirror
chain to fund its claims is trimmed by the very same daily ceiling, rounded up
just enough that a mirror can never end up short of what its users are owed —
so the cap no longer leaves unspendable VPFI stranded on a mirror.

There is no change to how or when a user claims, and no reward already earned
is reduced beyond the trimming the daily rule always intended. The platform is
pre-live, so there is no historical reward balance to migrate.

Part of #998. Implements `docs/DesignsAndPlans/S13InteractionRewardCloseoutAndDailyCap.md`
Part 1. Closes #1008.
