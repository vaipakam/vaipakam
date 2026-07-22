# Claiming rewards under the new per-participant daily cap (#1351, re-landed)

Connects the day-by-day cap calculation to the actual claim, so a participant
collecting rewards is bounded by their daily ceiling. Nothing pays differently
yet — the new regime governs only days after the reward changeover, which has
not been switched on anywhere. This is the re-landing of the previously parked
claim-routing slice, rebuilt on the single-pricing-core foundation; the
differences from the parked version are noted below.

**Only the days that need it are worked through one at a time.** A reward
covering a long stretch of days is still settled in a single step for the days
that predate the changeover; only the days that fall under the new cap are
handled individually. That distinction is not just an optimisation: the daily
ceiling depends on how much a participant has already drawn on that day across
*all* their loans, so it cannot be derived from a whole-period shortcut. Days
before the changeover have no such interaction and keep their existing, cheaper
treatment.

**Progress is recorded in one place, not two.** The parked version kept a
separate "the old-style part has been settled" marker alongside the day
counter, and the two could disagree — which is exactly how its review found a
reward that could become permanently uncollectable. Now the day counter itself
is the record: its first write *is* the old-style settlement, so "settled" and
"where the day walk stands" are one fact that cannot fall out of step. This is
the structural fix the redesign was reversed for, and it required no new
storage at all.

**A long history may need more than one claim.** Working days individually is
bounded per transaction, so a participant with a very long unclaimed stretch
finishes it across a few claims rather than in one oversized one. Each claim
pays and records the days it actually covered, so nothing is recomputed or
paid twice, and stopping partway is safe.

**Running short of funds pauses or ends, depending on the pot.** Per the rule
established in the foundation slice: a day short on the refillable recycled pot
is left untouched and retried later; a day short on the fixed lifetime schedule
pays what remains and settles, because that shortfall can never be funded.

**One claim's day allowance covers both roles together.** A participant who
both lends and borrows works through a single per-claim allowance of days
rather than a separate full allowance per role — the allowance exists to bound
the size of one claim, and splitting it by role let a claim be twice the
intended size.

**Reclaiming forfeited rewards at loan close is unchanged for now.** The
redirect-to-treasury sweep still settles a forfeited reward in one step; it
moves to the day-by-day treatment in the next slice. A reward whose collection
has already *started* day-by-day is protected in the interim: the expiry
reclaim — whose one-step calculation has no memory of what was already paid —
leaves such rewards to their owner instead of reclaiming them, so nothing can
be counted twice. Rewards nobody has started collecting expire exactly as
before, and the expiry horizon is off by default anyway.

**Where the claim lives has moved.** The claim entry points now sit in their
own component, purely because contracts have a hard byte limit and the
day-by-day logic did not fit alongside everything else. The claim and its new
logic moved together deliberately, so collecting a payout still happens in one
place. There is no change to how a claim is made.

Part of #1351. Umbrella: #1349.
