## Thread — A check that failed late reported nothing it had noticed (PR #2208, issue #2203)

The check that compares the platform's own loan records against the chain is
built to say what it could not establish. A row it could not read, a row for a
loan the chain has never heard of, a state this build does not recognise —
each is named in the operator's log, because a check that quietly skips what
it cannot work out reports perfect health while records stay wrong. Each of
those three exists because somebody found the silent version and said so.

They were being thrown away. The turn saves its place at the end, and if that
last step failed, everything the turn had noticed went with it. So a turn
could examine a record, correctly work out that the chain has no such loan,
fail to save its place, and report none of that — the exact silence the naming
was added to end, reached by a different door.

The worse version of it: saving a place is two steps, and if the first
succeeded and the second did not, the rotation had already moved past that
record. It was examined, not named, and not looked at again until the rotation
came round.

### What changed

There is now one piece of work that turns a turn's findings into what the
operator reads, and both endings call it — the ordinary one and the failed
one. They cannot report different things, because there is no longer a second
place that decides what to report.

That is deliberately not a matter of repeating the reporting in the failure
path. Copying it would leave the next thing worth reporting wired into one
ending and forgotten in the other, which is precisely how this went wrong: the
failure path already had everything it needed in hand and read one field of
it.

Nor is it a matter of remembering to call it from both. The failure path no
longer reports at all — it records what went wrong and hands back the
findings, and the telling happens once, afterwards, on the single path both
endings rejoin. A thing that cannot be written cannot be forgotten, which is a
better guarantee than a thing that is merely tested.

### What this does not change

Nothing about which records are corrected, or when. A turn that finishes
normally reports exactly what it reported before — every case that was already
covered is unchanged — and the failure path now says the same things instead
of almost nothing.

Closes #2203.
