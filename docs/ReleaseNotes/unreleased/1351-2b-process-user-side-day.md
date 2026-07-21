## Thread — The calculation behind the per-user daily reward cap (PR #<n>)

Second slice of the new daily reward cap. The previous slice recorded what each
day's ceiling is; this one adds the calculation that actually shares a day's
rewards out under that ceiling. Still nothing pays differently — the new
calculation is not connected to any live payout path until the remaining slices
land, and no day uses the new regime until the reward cutover is switched on.

**One calculation, used by both payout routes.** Rewards can leave via two
routes: a participant claiming, or a sweep that redirects forfeited rewards to
the treasury. Both now go through the same piece of code. That is the whole
point of capping per participant-and-day rather than per loan — there is one
allowance, and two routes spending against it independently is exactly how a
single participant would end up taking more than their share.

**Why order doesn't matter.** A participant may have several loans finishing at
different times. Each settlement records what it actually paid out, so whichever
one settles first consumes allowance the later one then cannot re-spend. The
ceiling therefore holds no matter what order things settle in. What is
deliberately *not* promised is that loans settling at different times split the
day perfectly evenly — only that together they never exceed the ceiling.

**Running out of budget doesn't lose your rewards.** If the pool cannot cover a
day in full, that day pays nothing at all and stays pending, to be retried once
the pool refills. Paying part of a day and marking it done would have quietly
discarded the rest, because the current design records progress a whole day at a
time.

**Rounding never overshoots.** When a day is split between several of a
participant's loans, the leftover from rounding is handed to whichever loan has
the most room left. If none has room, the remainder is simply left in the pool
rather than forced onto a loan that has already hit its own separate limit.

**Days that legitimately pay nothing still move forward.** A day where the
allowance is already used up, or where there is nothing to pay, is marked done so
the walk progresses. Only the "pool ran short" case stays pending. Conflating
those two would either lose rewards or leave a participant stuck retrying a day
that can never pay.

**A forfeited reward is not capped like a payout.** Each loan carries its own
lifetime limit on how much reward it can pay its participants. That limit
applies to money actually paid *out* to someone — it does not apply to a reward
that was forfeited and is being reclaimed, because reclaimed value is returned
to the pool rather than handed to a participant. Applying the payout limit to a
reclaim would have let an exhausted loan limit silently swallow reclaimable
funds, and because the day moves on regardless, they would never have been
recovered. Forfeits are still bounded by the per-participant daily ceiling, so
they can't be used to sidestep it.

**Rewards say where they came from.** A day's reward pool is funded from two
sources: newly scheduled rewards, and rewards recycled from fees already
collected. The calculation now reports each payout broken down by source rather
than as a single number, in the same proportion as the day's pool was funded.
That distinction is not cosmetic — the two sources are settled differently
downstream, and on the treasury side they are not even the same kind of event:
one is genuine new absorption, the other merely releases a reservation on money
that never moved. Reporting a flat total would have made those impossible to
tell apart.

Finally, the calculation refuses to run on a mismatched request — one mixing
different participants or sides, or naming a day a reward doesn't cover — rather
than trusting its caller, since two separate callers construct those requests.
It accepts a reward whose loan simply *ended* (defaulted or was liquidated)
without being formally wound down, because those are exactly the rewards that
get redirected to the treasury: refusing them would have left them stuck
forever, never paid and never redirected.

Part of #1351. Umbrella: #1349.
