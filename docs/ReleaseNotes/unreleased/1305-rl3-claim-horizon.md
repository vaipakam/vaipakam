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

This is a genuine soundness guarantee up to the sampling resolution, not
best-effort: no outage longer than the max observation gap (observed or
not), and no observed outage of any length, is ever credited — the
earlier wall-clock design credited any outage the moment funding
returned, if no keeper touched the entry during it. The one residual is
a sub-max-gap unobserved outage that starts and ends between two
executable touches: the sweep sees both endpoints executable and credits
it, bounded by the max gap — so the max gap is the sampling resolution,
and a tighter gap tightens the guarantee at the cost of a denser
heartbeat. The cost is a keeper heartbeat: an entry only ever expires if
keepers observed it claim-executable throughout with no gap over the
bound; otherwise it simply never reaps, a safe failure mode that errs
toward not-reaping. A non-executable touch also RECORDS the block, so an
outage a keeper actually observed is dropped on recovery regardless of
length. A sanctioned owner cannot claim, so their entries
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
alone). An entry whose fresh share cannot be credited at removal — the fresh
budget fully exhausted, or no recycle-bucket backing room — is deferred,
never processed with its value silently burned; a batch draws fresh
capacity (against both the pool cap and the bucket's backing room) per
entry, so it can never terminalise several entries against one remaining
sliver, and it can never revert on the bucket-backing invariant and
poison the whole permissionless batch. Every horizon reconfiguration
advances a strictly-monotonic epoch, so even two reconfigurations in the
same block are distinguishable and an entry is never measured against a
stale epoch that would skip its fresh notice. (The mirror-chain
remitted-recycled bucket-credit accounting is tracked separately as a
Phase-B′ follow-up, #1331 — it is a benign ledger-label gap, not a fund
movement, and RL-3 is dark by default.)

Removal uses the ratified split signals riding the governor's PR-3c
machinery: the fresh-funded share genuinely leaves the fresh budget
(consumes the pool cap) and credits the bucket as ExpiredReward
absorption; the recycled-funded share never left the bucket and releases
its commitment with zero new credit — dormant recycled rewards can never
inflate the absorption average. The claim-center countdown view exposes
each entry's accumulator start and a forward estimate of the earliest
removal (assuming continuous claimability from now). It credits the
interval a sweep-now would apply — so it never reports a removal later
than the contract enforces — but only while the entry is genuinely
claim-executable, mirroring the sweep's own gate and its zero-credit-
fresh defer exactly (owner unsanctioned, non-zero post-cap payable,
balance covers it, fresh share creditable against the pool cap and
bucket backing), so it never shows a false-imminent removal a sweep
would defer; a processed (claimed/expired) entry carries no countdown.
The final-notice and reconfiguration re-notice signals are timed from
the true crossing, not the sweep timestamp; the pre-expiry notice rides
the
free in-app notification channel per the design (paid push may only be
additional). The governor design's "released only by forfeit — never by
time" sentence gains its ratified superseding note, and functional spec
§4 gains the claim-horizon rules. Closes #1305.
