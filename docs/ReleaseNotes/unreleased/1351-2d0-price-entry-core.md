# One reward-pricing calculation, and what happens when the pool truly runs out (#1351 slice 2d-0)

Foundation slice of the per-user daily reward cap work. Nothing pays
differently on any current deployment — the new daily-cap regime is still
switched off everywhere, and the day-by-day payment walk this slice prepares
for has no live callers yet. What changes is *how the code is shaped* and
*what is specified to happen at the end of the reward programme*.

**One calculation, one place that records.** Before this slice, five separate
places each computed "what is this reward entry worth", and each was
independently responsible for agreeing with the others. A previous attempt to
build the payment walk on top of that (the parked slice 2c) showed exactly
where that goes wrong: review rounds kept finding new disagreements between
the copies, including one that could have left a claim permanently stuck.
Now a single read-only calculation prices an entry — the settlement path, the
expiry sweep, the claim preview, and the funding-need check all read it — and
a single place records the result. A preview can no longer promise what a
claim would not pay, because they are the same arithmetic by construction
rather than by discipline.

**The expiry countdown now tests what a claim would actually pay.** The gate
that decides whether an entry's expiry clock is running previously looked at
the entry's raw face value. It now looks at the same capped figure the claim
itself would pay, so a reward that a cap has already turned away can no
longer keep an expiry clock running on value no claim will ever move. (The
value reclaimed *at* expiry is deliberately still the uncapped figure — an
expired reward is returned to the pool, not paid to a person, so the
paid-to-a-person cap does not apply to it.)

**Running out of newly scheduled rewards is now an ending, not a wait.** The
day calculation distinguishes its two funding sources when one is short.
Rewards recycled from collected fees live in a pot that refills over time —
if that pot is short, the day still waits and is retried later, exactly as
before. Newly scheduled rewards, however, come from a fixed lifetime
schedule that can only ever go down. Under the previous rule a day short on
scheduled rewards also waited — but that wait could never end, leaving the
claimant retrying forever and the rest of their claim stuck behind the
unpayable day. Now such a day pays out exactly what the schedule still
holds, settles, and writes off the remainder that no future ever funds —
with the claimant's own payout funded first, before any forfeited amount is
redirected to the treasury. This supersedes the "a short day always stays
pending" wording from the earlier day-calculation slice: that remains true
for the refillable pot, and is deliberately no longer true for the one that
cannot refill.

Each side of that rule carries a test that fails if the other side's
behaviour leaks across, so the distinction cannot erode silently.

Part of #1351. Umbrella: #1349.
