# Every reward settlement path now values exactly the uncollected days (#1351 slice 2d)

Follow-up to the chunked-claim slice. Once a reward can be collected a chunk
at a time, every OTHER path that prices that reward — the expiry reclaim, the
loan-close redirect of forfeited rewards, the claim preview, and the
funds-availability check — has to know what part is already collected, or it
will count those days a second time.

**One rule instead of four special cases.** The single pricing calculation
now values a reward's *remaining* days — everything at or after its recorded
collection position — rather than its whole lifetime. Every consumer of that
calculation becomes exact for partly-collected rewards automatically: the
expiry reclaim recovers precisely the days nobody collected (previously such
rewards were parked untouched as an interim safety measure, which this
replaces); the loan-close redirect of a forfeited reward likewise settles
only what the day-by-day collection hadn't already handled; the preview and
the funds check count only value that can still actually move. A reward whose
days are all collected simply has nothing left, on every path.

The interim safety measure this replaces — "a partly-collected reward is not
reclaimable by expiry at all" — was deliberately shipped with its deletion
pre-announced; this is that deletion, with the exact-valuation rule in its
place. A dedicated test proves a partly-collected reward's reclaim equals a
never-touched reward covering the identical remaining days, and fails in a
distinct way against both of the older behaviours (the double-count and the
park-forever).

Nothing pays differently on any current deployment: rewards only acquire a
collection position once the new reward regime's changeover is switched on,
which it is not, anywhere.

Part of #1351. Umbrella: #1349.
