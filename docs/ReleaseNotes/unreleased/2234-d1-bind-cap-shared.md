## Thread — A lookup no longer fails because there is a lot waiting for it (PR #2235)

The platform's back-office services ask their own store about many records at
once: who each inbox notification is for, who owns a sold offer row, which
delivered cross-chain remittances have already been acknowledged. Each of those
questions names every record in the batch being worked on, and the store
refuses a question that names more than a hundred things at a time.

Refusal is not a slow answer — it is no answer, and the work the question
belonged to fails whole. Worse, it fails the same way on the next attempt,
because what made the question too large is a backlog, and a backlog does not
shrink while the thing that would drain it is failing. That is the shape worth
naming: not a flaky moment, a stall, and one that arrives precisely when the
platform has fallen behind and most needs to catch up.

Three of these lookups already split their question up. Two did not. The one
that mattered most is the pass that acknowledges cross-chain reward
remittances: it examines a window two hundred wide, so a hundred or more
unacknowledged deliveries in that window made every attempt fail — and because
that pass records its new position **before** asking, each failing attempt also
moved past a window whose acknowledgements were never sent. Value had been
delivered and the bookkeeping that closes it would never have followed. The
likeliest moment to meet that is the first time the pass is switched on, since
nothing has been acknowledging while it was off.

That pass has not run in production — this service's schedule is currently
empty and the feature is not enabled — so this is a defect on the arming path
rather than an incident. It was found by reading the arming prerequisites, not
by anything reporting it.

**The fix is one shared rule rather than five careful authors.** The store's
limit and the splitting now live in one place used by every service. Callers
hand over the rest of their question's contents and get back complete,
correctly sized pieces, so there is no count for anyone to keep in step with a
condition added later — which is how the three that knew about the limit came
to be three rather than five. Splitting costs nothing extra: the pieces travel
together as one request, so a lookup that used to be one request still is.

One place deliberately does **not** use the shared splitter, and the reason is
recorded where it lives: the sweep that releases long-held records limits how
many it examines per pass so that what comes back always fits a single
instruction. That is a bound on how much work one pass does, and splitting
would remove it rather than respect it. An exception with a stated reason is
worth more than a rule that reads absolute and quietly is not.

A fourth service, the internal mesh watcher, asks similar questions. The first
version of this change exempted it on the grounds that its lists are sized by
how the deployment is configured. **That was wrong, and review caught it**: the
set of chains it watches is read from the canonical chain itself, where nothing
limits how many may be registered, and one chain can raise more than one
finding. So the exemption was the same unexamined assumption of smallness that
this change set out to remove — written in the same breath as removing it.

Two of its questions could not simply be split, and the reason is worth
recording. They were phrased as "delete everything EXCEPT these", and that
phrasing cannot be broken into pieces: the first piece deletes what the second
was going to keep. They now ask the opposite question — read what is stored,
work out what is not being kept, and delete that in bounded pieces — which
splits safely and means the same thing. The read happens inside the same
guarded boundary as the writes, so a failure of it is reported rather than
escaping.

That service also had no test of what those two operations actually delete —
only of how they behave when the database is unavailable. So the rewrite could
have changed the retention behaviour with every existing test still passing.
Tests for the behaviour itself were written first, and then deliberately broken
to confirm they would object.

The watcher stays outside the shared package for trust reasons — its own
database, its own alerting channel — but it now uses the same splitting rule,
reached the same way it already reads shared deployment data. One definition
beats a copy that drifts.

Closes #2234.
