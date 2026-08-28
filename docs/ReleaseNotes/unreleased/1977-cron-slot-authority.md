## Ops — the account's cron budget now has one authority, and the count in it is the true one

Cloudflare's free plan caps the account at five cron triggers, and how many
were spoken for was stated in ten places across the tree — three wrangler
configs, four source comments, a README, a design doc and one operator
runbook. All of them agreed with each other. All of them were wrong, in the
same way and for the same reason: they counted the Workers that have source in
this repository, and one of the live triggers belongs to a Worker that does
not.

That Worker is `vaipakam-offchain-data-archive`, the pre-rename predecessor of
the nightly backup Worker. It was supposed to be retired once its replacement
had completed a run; it never was. **As read from the account on 2026-08-27**
it was still armed on the same minute as the replacement, with its own storage
credentials and its own copy of the backup encryption key, and had been
scheduled that way for at least three weeks. Reading the account rather
than the prose is what surfaced it.

An earlier draft of that sentence said it had *run a full second backup every
night*. It had not been established that it had. The account API reports
trigger configuration and says nothing about whether an object was written —
which is the distinction this very change had to add to the restore runbook,
after the same inference was found there. Writing it into the incident record
as well would have told a future operator that every night has a fallback copy,
which is the belief the runbook now exists to prevent. **Armed is not
uploaded**, and only the bucket listing settles it.

Those are dated observations, deliberately. This note lives in the pending
folder until the day's notes are assembled, and the account can change in the
meantime — so a present-tense claim here could ship describing a state that
had already been cleaned up. The one place that carries the live figure is the
authority, which is checked against the account; everything here is history
with a date on it.

The checker enforces that, rather than leaving it to care. Its exclusion for
the release-notes tree covers the **assembled, dated** notes, which are
finished history; **pending fragments are scanned like any other file**,
because a fragment is not history yet. It is a forward-looking description of
behaviour shipping in the same change, and a count written into one would sit
there indefinitely with nothing to contradict it. That distinction was itself a
review finding on this change, and the scan caught a restated count in this
very fragment within the hour of being switched on.

Three things follow from that, and this change addresses all three. Every one of
those comments was a trigger short of the account's real state — so the slot
they reserved for the undeployed mesh watcher was already occupied. The figures
are in the authority; this fragment deliberately does not restate them, for the
reason the whole change exists. That does not mean the keeper's re-enable would have stopped at its
first step: the real occupancy still left a trigger free, so
whichever of the two deployments went first would have taken it and succeeded.
What those comments had actually lost was the SECOND one. Deploy mesh-watcher
first and the keeper's re-enable is the deploy that fails; re-arm the keeper
first and mesh-watcher's first deploy fails. Either way the failure is a 10072
at deploy time with no explanation available, and an operator reading those
comments would go looking for a sixth trigger that does not exist. The restore runbook's
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

The case for doing it soon got considerably stronger during this work: two
separate emergency procedures turned out to be written for one Worker where
there are now two, and the consequences are described below.

One thing is worth recording rather than smoothing over, because it is the
most transferable part. **The mechanism did not work first time, or for many
times after.** Review round after review round found the same defect it was
built to prevent — a claim about something live that nothing checks — again
and again *inside the mechanism itself*.

(There is no count in that sentence, deliberately. Earlier drafts said
"twelve rounds", then "fourteen", and each went stale within the day; a
reviewer caught one of them. A restated number describing this change's own
history is the same defect the change is about, and it does not become
acceptable for being about the past.)

The interesting part was never the count anyway. It is that the misses fell
into a small number of repeating shapes — and that two of them were found not
by review but while *writing the reply accepting a different fix*, within an
hour of pushing it. That is the clearest evidence here that the problem is not
attention:

- **Closed worlds keep reopening.** A list of file extensions, a class of
  Markdown prefixes, a set of phrasings gathered from the tree: each was an
  enumeration of what somebody might write, each leaked twice, and each was
  finally fixed by replacing the enumeration with a decidable test rather than
  extending it a third time.
- **Fixing one member of a family and leaving its sibling**, repeatedly — a
  wrap-tolerant matcher applied to one pattern and not the rest; a short-row
  guard added beside the malformed-row finding it belonged with; one file
  extension added while its sibling stayed out; a predicate list taught one
  vocabulary while the matcher beside it kept another. The durable answer
  turned out not to be fixing the sibling but removing the seam: one shared
  definition, used everywhere the thing appears.
- **Closing one direction and opening the reverse.** Requiring every
  reservation to be named, without rejecting a name for a reservation that no
  longer exists. Dropping an anchor so a hidden duplicate could not escape,
  thereby accepting a stamp no reader can see.
- **Answering a question with the neighbouring question's test.** Counting
  well-formed stamps to decide whether there were two. Checking that a
  paragraph is *about* cron to decide whether a sentence *claims* something
  about it.
- **Two fixes, each right alone, contradictory together.** One round added a
  procedure for refreshing the authority after a deploy and, in the same
  commit, a check rejecting the wording that procedure produces — so no
  document satisfied both and the step could not be completed. This is the
  one shape the others do not cover: nothing was individually wrong, and no
  per-change review asks whether the state a fix *produces* is reachable.
- **The correction that landed and was never called.** One check had its
  substring test replaced by a proper parse, for exactly the right reason. The
  parse was written, was correct, and was wired into one of the three places
  that needed it; the other two went on running the test it replaced. So the
  fix and the defect shipped side by side in the same short function, and
  every gate stayed green, because the text being searched happened to contain
  the right word for an unrelated reason. This is not the sibling shape above —
  nothing was left untouched and nothing was overlooked in another file. The
  remedy was present, adjacent, and inert. Nothing that examines a change can
  see this; only reading the finished function can.
- **The correction the producer had already made unreachable.** A later round
  taught the table parser that a code block ends a table, which is what the
  Markdown specification says and what the reader sees. The line was correct
  and it could never run: the stage that strips code blocks out of the
  document runs first, and by the time the parser sees anything the block and
  both of its delimiters are gone. The parser was watching for a marker its
  own input could not contain. The remedy was not to look harder for the
  marker but to stop deleting it — omitted lines are now handed on as blank
  ones, which is the same boundary in a form every reader of that stream
  already understood. A test written against the parser alone would have
  passed; only feeding it the real pipeline's output shows the gap.
- **One rule, two threat models, opposite meanings.** The restore runbook
  gained a rule saying that if a backup fails its checksum, fall back to the
  other bucket. That is right on an ordinary restore, where the second bucket
  is a spare copy — and it is precisely wrong after a compromise, where that
  bucket's Worker holds a write key and a copy of the encryption key, so
  "this one failed, try the other" is the newest-that-verifies move the
  adversarial section of the same document exists to forbid. The sentence
  never changed meaning; the reader's situation did.
- **The general remedy applied without checking that this case has the
  general problem.** A reviewer pointed out that reading only the first page
  of a paginated list would hide exactly the thing the check exists to find.
  True in general, and the endpoint in question turned out not to paginate at
  all — it ignores the parameters and returns everything — so the page loop
  written to fix it was *worse* than the single call it replaced. The same
  round: a file-classifier was rewritten to ask git whether a file is binary
  instead of sniffing for a null byte, keyed on the field that reports git's
  own guess rather than the one carrying the explicit setting — so it still
  excluded the exact file the finding named, while compiling, reading
  correctly and passing its tests. Both were caught by going and asking the
  thing itself. A remedy that is right about the world is not yet right about
  the case in front of it.

Several findings landed outside the mechanism entirely, in the operator
runbooks the un-retired Worker touches, and those mattered more than anything
above. Two were serious enough to change what an operator does in an
emergency.

The disaster-recovery procedure for a **compromised** account said to rotate
the storage credentials and then pointed at a step whose actual instruction
replaces one Worker's pair of keys. With two Workers holding write access,
following it as written leaves the second key valid — so the attacker keeps
the ability to upload after the procedure believes the breach is closed. It
now enumerates the keys from the account before deleting anything, rather
than trusting a number written down in advance.

A second one would destroy data rather than admit an attacker. The routine for
changing the backup encryption key pauses one Worker, migrates one bucket, and
then destroys the old key — while the second Worker carries on writing under
it. Everything that Worker has stored becomes permanently unreadable,
including the copies **this very change had just designated** as the fallback
when the primary ones fail verification. So the edit that made those backups
load-bearing left standing a procedure that would have quietly rendered them
useless. It now says, at each step rather than in a note further up, that the
work applies to both Workers and both buckets — and that the durable fix is
retiring the duplicate.

Neither of those two is wrong sentence by sentence. Each is simply wrong about
how many of something exists, which is the same defect as the copied counts
that started all this, relocated from comments into instructions somebody
follows during an emergency.

And the procedure for bringing the paused keeper back had no failure path for
the validation that runs *after* the fund-moving passes are switched on. The
rollback it did document covers the earlier, still-inert validation, where
backing out costs nothing — so an operator whose post-arming check failed had
no instruction for the one situation where it matters. The Worker's own
configuration file had carried that rollback all along; the runbook had not,
and nothing compares the two.

Smaller, and the same shape: the restore runbook concluded from two armed
schedules that both backup buckets held every recent night — armed is not
uploaded, and an operator restoring under pressure would have taken it as
licence to skip the listing. And a mistyped verification flag printed "OK"
and exited zero without contacting the account at all, in the procedure whose
next step is a deploy that fails if the check was wrong.

Partway through, the review stopped being worth continuing in the same
direction, and it is worth saying how that was decided rather than by feel.
The findings were counted: the rate of new ones was flat across two long
stretches of fixing every single one, the change had doubled in size while
that happened, and two thirds of everything raised concerned the checking tool
rather than the documents it checks. The recent findings had also drifted in
character — they were no longer about the count being wrong, but about
increasingly obscure ways of writing Markdown that the tool interpreted
differently from a reader.

That last part is the diagnosis. The tool had started growing its own
understanding of the document format, one review finding at a time, and each
correction gave the next review more to examine. Two of the bugs *it* caused
were worse than the ones it caught: both would have rejected a perfectly
correct document, which on a check that gates every change means stopping all
work rather than letting one mistake through.

So that machinery was deleted rather than corrected again, and replaced with a
rule: the one file this all protects may not hide any part of itself. That is
a single condition anybody can check, it costs nothing — the file has never
done so, and there is no reason a document whose job is to state one number
plainly would want to — and it makes the entire class of problem impossible
instead of handling it case by case. **Ruling something out is decidable;
interpreting it is not.** Each finding had arrived phrased as an interpretation
problem, and had been answered on those terms for several rounds before anyone
asked whether interpretation was required at all.

One consequence of all that correcting deserved checking on its own, and had
not been. Almost every change to the checker made it **stricter about what
counts as a claim** — each one prompted by it wrongly objecting to an innocent
sentence, and each one carrying the risk of quietly losing the real thing it
was built to find. Nothing had confirmed it still finds them.

So the ten original passages that started this were recovered from the
project's history and run through the checker as it now stands, rather than
through the examples written to describe it. All ten are still caught. The
distinction matters more than the result: an example invented to illustrate a
rule confirms the rule, while a passage lifted from the real history confirms
the job — and no set of invented examples can notice that a rule quietly
stopped matching text nobody thought to write down. That check is recorded
alongside the rules, with a note that anyone proposing to tighten them further
should repeat it rather than trust a clean run of the examples.

Every one of these was written carefully, by someone actively thinking about
this exact failure. That is the argument for the gate rather than an
embarrassment to it: if the defect reproduces this readily under maximum
attention, it was never going to be prevented by care, and the ten copies that
started this were not a lapse.

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
