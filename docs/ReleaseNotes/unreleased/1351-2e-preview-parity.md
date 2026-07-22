# The reward preview now promises exactly what a claim would pay (#1351 slice 2e)

Completes the preview half of the chunked-claim work. Nothing pays
differently anywhere — the new regime is still switched off on every
deployment; what changes is what the *preview* reports once it is on.

**The problem.** Under the new per-participant daily ceiling, what a claim
pays depends on things no single reward can know by itself: the day ceiling
is shared across *all* of a participant's rewards on that day, a single
claim processes a bounded number of days, and a partly-collected reward
resumes from where it stopped. The old preview valued each reward
independently, so a participant with two rewards sharing a day would have
been shown roughly twice what the claim would actually pay, and a long
backlog was shown all at once rather than per claim.

**The fix, without a second implementation.** The preview now runs the very
same day-by-day calculation the claim runs — same eligibility, same
ceilings, same day allowance — but keeps its progress in memory instead of
recording it, carrying forward between simulated days exactly what a real
claim would have recorded between real days. The payment arithmetic itself
exists once; the simulation only replaces where progress is kept. One
deliberate exception is documented in place: the internal funds-availability
safety check keeps a cheaper per-reward sum, because its contract is "a
guaranteed at-least figure" rather than "the exact payment" — and the exact
simulation is heavy enough that carrying it there would have pushed a
deployed component over the platform's hard size limit.

**What the preview now means.** It reports what *the next claim call* would
pay. A backlog longer than one claim's day allowance previews in
per-claim portions, updating as each claim advances. Three properties are
each pinned by a test that compares the preview against a real claim's
actual payout, and each was observed failing — always in the over-promising
direction — against the previous per-reward preview: two rewards sharing a
day, a backlog stopped mid-allowance, and a reward spanning the regime
changeover.

**Deliberately unchanged.** The preview still does not subtract the global
reward budget's remaining headroom — it remains an upper bound that the
claim itself truncates at payment time, which the funds-availability
safety check relies on directionally.

Part of #1351. Umbrella: #1349.
