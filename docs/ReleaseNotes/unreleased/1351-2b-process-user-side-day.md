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
time. Each funding source is checked against its own remainder rather than
against a single combined figure — the two sources are physically separate, so a
combined check could report "enough" while one of them was actually short.

**A day that hasn't closed yet is simply not ready.** Days that haven't been
finalized are left pending and retried later, not treated as an error. Only a
day that *has* closed but is missing its regime marker is refused outright,
because that combination should be impossible and quietly guessing would apply
the wrong limit.

**Reward that a loan's own limit refuses is accounted for.** When a loan's
lifetime limit turns some of a day's reward away, that amount is reported back
so the bookkeeping can be released. Nobody can ever draw it — the day has moved
on — so leaving it recorded as still-owed would shrink every future day's
available rewards for value that cannot exist. The separate case of a
participant hitting their own daily ceiling is deliberately *not* treated this
way: that reward stays in the pool and someone else can still receive it.

**Rounding never overshoots.** When a day is split between several of a
participant's loans, the leftover from rounding is handed to whichever loan has
the most room left. If none has room, the remainder is simply left in the pool
rather than forced onto a loan that has already hit its own separate limit. When
two loans have equally much room, the tie is settled by which reward is older —
not by the order the caller happened to list them in, so the same set of rewards
always splits the same way no matter who asks.

**The budget check counts what will actually be paid.** Because each side of the
split rounds on its own, the exact amounts drawn from each source can differ from
a single estimate by the smallest possible unit. The amounts are therefore worked
out in full first and the available budget checked against those, rather than
against an estimate — an "off by the smallest unit, absorbed somewhere
downstream" discrepancy is precisely the kind that becomes impossible to trace
later.

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

**A loan's own limit is met from newly scheduled rewards first.** When a loan's
lifetime limit only permits part of a day's reward, the part that is paid comes
from the newly scheduled pool before any recycled reward is touched — the same
order the existing settlement path already uses. Sharing it proportionally
instead would have drawn down the recycled pot for reward that should have come
from elsewhere, and left the corresponding bookkeeping unreleased by exactly that
amount. The separate reduction that happens when a participant hits their own
daily ceiling is *not* treated this way: that one keeps whatever mix survived, so
a day whose ceiling binds tightly still draws on both sources.

**Reclaiming a forfeited reward doesn't wait on spare funds.** Reclaimed reward
that was originally funded from the recycled pot never actually leaves that pot —
reclaiming it just cancels the earmark. So it is no longer held up when the
recycled pot has nothing spare to pay out with; otherwise a reclaim could sit
stuck behind unrelated payout funding it never needed. Reclaimed reward funded
from newly scheduled rewards *is* still counted, because that genuinely moves.

**Rounding always favours the same side.** Wherever a reward has to be divided
between its two funding sources, the recycled share rounds down and the newly
scheduled share absorbs the remainder. That direction is applied uniformly, so
the recycled pot is never drawn on for a fraction that should have stayed in it.

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
