## Ops — the account's cron budget now has one authority, and the count in it is the true one

Cloudflare's free plan caps the account at five cron triggers, and how many
were spoken for was stated in ten places across the tree — three wrangler
configs, three source comments, a README, a design doc and two operator
runbooks. All of them agreed with each other. All of them were wrong, in the
same way and for the same reason: they counted the Workers that have source in
this repository, and one of the live triggers belongs to a Worker that does
not.

That Worker is `vaipakam-offchain-data-archive`, the pre-rename predecessor of
the nightly backup Worker. It was supposed to be retired once its replacement
had completed a run; it never was. It is still armed on the same minute as the
replacement, with its own storage credentials and its own copy of the backup
encryption key, and it has been running a full second backup every night for
at least three weeks. Reading the account rather than the prose is what
surfaced it.

Three things follow from that, and this change addresses all three. The budget
is four triggers live, not three, so the slot every one of those comments
reserved for the undeployed mesh watcher is already occupied — the keeper's
re-enable procedure, whose first step is "confirm a trigger is free", would
have failed at that step with no explanation available. The restore runbook's
rule for choosing between the two backup buckets ("the two never both hold a
given night") stopped being true the moment both Workers were left running, so
an operator restoring under pressure would have found two candidates and no
way to choose; it now names the supported bucket, treats a gap in it as a
finding in its own right, and records that the compromise reasoning further
down assumes one holder of the write credentials where there are two.

The structural half is that the count now lives in exactly one file,
`docs/ops/CloudflareCronSlots.md`, carrying the date it was last read from the
account. Everywhere else says why a Worker registers one schedule rather than
two — which is durable — and links there for the arithmetic, which is not. A
new gate in CI refuses any text that goes back to restating the occupancy,
while deliberately permitting statements of the cap itself, since the sentence
that replaces a count has to say what the constraint is. The gate also has a
live mode that diffs the committed inventory against the account, which is the
only half that can tell whether the inventory is current; CI runs the offline
half, because CI has no credentials, and a green offline run means "nobody
re-copied the count" rather than "the count is right".

Retiring the duplicate Worker is not done here. It sits on the
disaster-recovery path, and until its replacement is confirmed to be landing
and verifying in the new bucket, the un-retired predecessor is what would mask
a defect in it — so the sequence (confirm, unschedule, delete, rotate its
credentials, expire the old bucket) is an operator decision recorded in the
issue rather than something to take unilaterally.

One thing is worth recording rather than smoothing over, because it is the
most transferable part. The mechanism did not work first time. Review found
the same defect it was built to prevent — a second copy of the count that
nothing reads — six times **inside the mechanism itself**: the wrap-tolerant
matcher applied to one pattern and not the rest, so a wrapped restatement went
undetected and the gate reported clean over it; the authority file's own
summary left unpinned; the summary parser reading only the first of a
duplicated section; the inventory parser keeping only the last of a duplicated
row; a committed-vs-live comparison loose enough to accept every value; and a
plain-prose restatement three paragraphs below the summary that pins it.

Each was written carefully, by someone actively thinking about this exact
failure. That is the argument for the gate rather than an embarrassment to it:
if the defect reproduces this readily under maximum attention, it was never
going to be prevented by care, and the ten copies that started this were not a
lapse.

**#1977 stays open**, deliberately. This change is the repository half of it;
the account half — confirm, unschedule, delete, rotate the credentials that
Worker holds, expire the old bucket — has not happened, and the issue is the
only place that sequence is written down. Closing it on merge would retire the
tracker for a live Worker still holding a `writeFiles` storage key and a copy
of the backup encryption key, and still occupying the trigger the keeper's
return depends on.

Refs #1972, the general class this came out of — live infrastructure state
asserted in many documents and authoritative in none. This is that issue's
shape applied to the one fact where the drift turned out to be load-bearing
rather than cosmetic; the hostname half of it is still open.
