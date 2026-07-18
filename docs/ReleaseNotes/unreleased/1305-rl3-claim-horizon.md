## Thread — RL-3: post-claimability reward claim horizon (PR #TBD)

Third ratified delta of the recycling loop-closure design. Once
governance sets the bounded horizon knob (default 365 days, never below
180; dark until set), a reward that has stayed claimable for a full
horizon-plus-notice of accrued time becomes sweepable into the recycle
bucket by a permissionless keeper call — closing the unbounded liability
tail of dormant claimants the design flagged, with the dYdX epoch-sweep
precedent.

Expiry is measured in executable-elapsed time, never wall-clock. The
platform keeps, per reward entry, an accumulator of time during which
the reward was provably claimable. It starts on the first sweep touch
that observes the entry claim-executable, and each later interval
between two touches is credited only if the entry was claim-executable
at both ends and the gap is short enough to trust as continuous (a fixed
max-observation-gap bound). An entry can be removed only once its
accumulator reaches the full horizon + 90-day notice. "Claim-executable"
means the amount a claim would really pay (fresh capped to remaining
pool capacity, plus recycled) is non-zero, covered by local funding, and
the owner unsanctioned.

This is a genuine soundness guarantee, not best-effort: because credit
requires observation at both ends with a bounded gap, no unobserved
funding outage or sanction can let the clock run past time the claimant
could not actually claim — the earlier wall-clock design could, if no
keeper happened to touch the entry during the outage. The cost is a
keeper heartbeat: an entry only ever expires if keepers observed it
claim-executable throughout with no gap over the bound; otherwise it
simply never reaps, a safe failure mode that errs toward not-reaping.
A non-executable touch also RECORDS the block, so even a short outage a
keeper actually observed is dropped on recovery (not just unobserved
gaps over the bound). A sanctioned owner cannot claim, so their entries
never accrue and can never be swept while flagged (a delist resumes
accrual — freeze, not seize). A horizon reconfiguration — dark reset or any retune — caps the
accumulator back to the horizon threshold on the next touch, so the full
90-day notice must be re-earned under the new configuration; an
already-due entry is never reaped without a fresh funded notice after
governance changes the rules. A claim landing any time before removal
always wins.

The lifecycle is fully observable: reward-entry ids are enumerable per
user, and the accumulator start, the entry into the final-notice window,
and the removal each emit a public per-entry signal (the notification
pipeline schedules the free pre-expiry notice from indexed events
alone). An entry whose fresh share cannot be credited at removal — the
fresh budget fully exhausted — is deferred, never processed with its
value silently burned; a batch draws fresh capacity per entry, so it can
never terminalise several entries against one remaining sliver.

Removal uses the ratified split signals riding the governor's PR-3c
machinery: the fresh-funded share genuinely leaves the fresh budget
(consumes the pool cap) and credits the bucket as ExpiredReward
absorption; the recycled-funded share never left the bucket and releases
its commitment with zero new credit — dormant recycled rewards can never
inflate the absorption average. The claim-center countdown view exposes
each entry's accumulator start and a forward estimate of the earliest
removal (assuming continuous claimability from now — an outage or
sanction pauses it, and it credits the interval a sweep-now would apply
so it never reports a removal later than the contract enforces); the
final-notice and reconfiguration re-notice signals are timed from the
true crossing, not the sweep timestamp; the pre-expiry notice rides the
free in-app notification channel per the design (paid push may only be
additional). The governor design's "released only by forfeit — never by
time" sentence gains its ratified superseding note, and functional spec
§4 gains the claim-horizon rules. Closes #1305.
