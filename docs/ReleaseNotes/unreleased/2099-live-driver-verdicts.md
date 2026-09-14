# A live driver can no longer be added without saying what it means

The batch that runs the live drives reads each one's exit code and turns
it into a verdict. Two of those verdicts are easy to tell apart — the
drive passed, or the drive found a defect — and the third is the one that
matters here: the drive did not finish, so its surfaces were not fully
reviewed.

That third verdict needs stating carefully, and an earlier draft of this
note got it wrong. It does NOT mean the drive saw nothing. A drive can
check every screen for one kind of user, hit a setup failure on the next,
keep everything it already established, write its report, and still end
on that verdict so the run is not called clean. Describing that as
"verified nothing" throws away work the drive deliberately preserved, and
sends whoever reads it back over ground already covered.

A driver only gets that third reading if it appears on a list, and the
list is kept by hand while the drives themselves are discovered by
looking in a directory. That is deliberate. A drive that never agreed to
mean "I did not finish" by exiting the way it does should not have that
read into it, so being on the list is something each drive opts into.

What was missing was not the opting in. It was any way to tell a drive
that opted OUT from one nobody had got to yet, and any consequence for
the second. The runner printed a warning naming unlisted drives — but it
printed it during a batch run, which happens before a release and not
when someone proposes a change. So a drive could be added, reviewed,
merged, and run for weeks with its "did not finish" reported as "found a
defect".

The row is not silent about it — it carries a note saying the drive is
undeclared and the result may be infrastructure, and the summary repeats
that. An earlier draft of this note said the reader had no way to know,
which was an overstatement worth correcting rather than quietly dropping.
What is wrong is the VERDICT ITSELF: a row saying a defect was found,
hedged, is still a row saying a defect was found, and a hedge asks the
reader to discount a verdict instead of giving them the right one.

Now there are two lists: the drives that speak the third verdict, and the
drives that deliberately do not, each with its reason written down. A
drive in neither fails a check that runs on every proposed change, and
the failure names it and says what to do about it. The reason is required
too — an opt-out without one is an oversight wearing the clothes of a
decision. The runner tells the two apart in its own output as well: a
drive that opted out is reported with its reason, and no longer carries
the "might be infrastructure" hedge that belongs on a drive nobody has
classified.

Be precise about that check's force, because the workflow it runs in says
in its own header not to overstate it, and an earlier draft of this note
did exactly that. The suite it belongs to is visible on every change and
is meant to be treated as blocking by reviewers, but it is not one of the
checks that mechanically prevents a merge. So this closes the gap of
nobody NOTICING — which is what actually went wrong, a warning that
printed only during a release run — and not the gap of somebody
overriding a red check on purpose. Making it mechanical is a separate
decision about which checks are required, and belongs to whoever owns
that list.

One drive turned out to be in exactly the gap this describes, and listing
it needed two fixes to the drive first — which is the most useful thing
this change found.

It ended each of four checks with the third verdict, and all four turned
out to be wrong. Three rounds of review reached that from three
directions: a defect found early and then buried by a later check; a
defect reported as an incompletion because the check that ended the run
came FIRST, before anything had been recorded; and finally the last two,
on evidence that needed no judgement.

None of those four checks is a precondition. Each of them runs only after
a page has been served, and each asks whether what was served is right:
is the connector offered, did clicking it open anything, did what opened
go where it must. Something served, a question asked of it, the answer
wrong — that is finding a defect, not failing to start.

What settled it was not an argument about definitions but the drive
contradicting itself. It already recorded a missing WalletConnect entry
as a defect, and a WalletConnect connection that never opened as a
defect. The Coinbase halves of those exact two questions were being
reported as "did not finish". One drive, one kind of fact, two different
verdicts, a few lines apart. All four report a defect now.

The drive still reports "did not finish" — through the shared machinery
that every drive uses, for an unreachable site or a missing credential or
no browser at all. Those are the real preconditions, and none of them is
a check written in the drive itself.

Adding a drive to that list without reading it is the same mistake as
leaving one off: it puts a claim into the runner's output that the drive
never made.

The lists moved out of the runner to make any of this possible. The
runner starts every drive the moment it is loaded, so nothing could read
its lists without launching browsers against the live site, which is why
a warning printed during a run was the only guard that could exist.

An earlier draft of this note ended by saying the runner behaves exactly
as before. That was true when it was written and stopped being true two
paragraphs above, once the runner learned to tell a deliberate opt-out
from an oversight. What has not changed is the translation from exit code
to verdict: the same code still means the same thing. What has changed is
what the runner says about it, which was the point.
