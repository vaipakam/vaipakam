## Thread — Claiming rewards under the new per-participant daily cap (PR #<n>)

Third slice of the new daily reward cap. The previous slices recorded each day's
ceiling and built the calculation that shares a day out under it. This one
connects that calculation to the actual claim, so a participant collecting their
rewards is now bounded by their daily ceiling. Nothing pays differently yet —
the new regime governs only days after the reward changeover, and that
changeover has not been switched on.

**Only the days that need it are worked through one at a time.** A reward
covering a long stretch of days is still settled in a single step for the days
that predate the changeover; only the days that fall under the new cap are
handled individually. That distinction is not just an optimisation: the daily
ceiling depends on how much a participant has already drawn on that day across
*all* their loans, so it cannot be derived from a whole-period shortcut. Trying
to would overpay. Days before the changeover have no such interaction, so they
keep their existing, cheaper treatment.

**A long history may need more than one claim.** Working days individually is
bounded per transaction, so a participant with a very long unclaimed stretch
finishes it across a few claims rather than in one oversized one. Each claim
pays and records the days it actually covered, so nothing is recomputed or paid
twice, and stopping partway is safe. This already applied to catching up on the
reward schedule, so it is not a new obligation for anyone integrating.

**Running short of funds pauses rather than skips.** If the pool cannot cover a
day, that day is left untouched and retried on a later claim instead of being
partially paid and marked done.

**A reward that spans the changeover is handled once by each mechanism.** The
part earned before the changeover is settled the old way and the part after it
the new way, with no overlap in either direction — the two are separable by
construction, not by bookkeeping we have to keep in step.

**Reclaiming forfeited rewards is unchanged for now.** The redirect-to-treasury
sweep still settles a forfeited reward in one step; it moves to the new
day-by-day treatment in the next slice. Splitting that change out keeps each
step's blast radius contained — had the claim's change been applied to the sweep
without giving it the matching machinery, a forfeited reward could have been
left stranded with nothing able to collect it.

**One claim's day allowance now covers both roles together.** A participant who
both lends and borrows works through a single per-claim allowance of days rather
than a separate full allowance for each role. The allowance exists to keep any
one claim from growing too large to run; splitting it by role let a claim be
twice the intended size. Anyone whose catch-up now spans an extra claim simply
claims again — the leftover days are recorded as unclaimed, not lost.

**A part-collected reward is no longer reclaimable by expiry.** Rewards left
uncollected past the optional expiry horizon are reclaimed in one step, using a
calculation that has no memory of what was already paid out. Now that a long
reward can be collected across several claims, that would have counted the
already-collected days a second time. Such rewards are therefore left to their
owner to finish collecting, rather than being reclaimed. Rewards nobody has
started collecting are unaffected and expire exactly as before. The expiry
horizon is off by default, so nothing in use today is affected.

**Where the claim lives has moved.** The claim entry points now sit in their own
component. This is purely a size constraint — contracts have a hard byte limit
and the day-by-day logic did not fit alongside everything else. The claim and
its new logic were moved together deliberately, so that collecting a payout
still happens in one place rather than becoming a call that depends on a second
component being reachable. There is no change to how a claim is made.

Part of #1351. Umbrella: #1349.
