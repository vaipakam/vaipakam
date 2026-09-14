# A live driver can no longer be added without saying what it means

The batch that runs the live drives reads each one's exit code and turns
it into a verdict. Two of those verdicts are easy to tell apart — the
drive passed, or the drive found a defect — and the third is the one that
matters here: the drive could not start, so it verified nothing.

A driver only gets that third reading if it appears on a list, and the
list is kept by hand while the drives themselves are discovered by
looking in a directory. That is deliberate. A drive that never agreed to
mean "I verified nothing" by exiting the way it does should not have that
read into it, so being on the list is something each drive opts into.

What was missing was not the opting in. It was any way to tell a drive
that opted OUT from one nobody had got to yet, and any consequence for
the second. The runner printed a warning naming unlisted drives — but it
printed it during a batch run, which happens before a release and not
when someone proposes a change. So a drive could be added, reviewed,
merged, and run for weeks with its "could not start" reported as "found a
defect", and the person reading that row had no way to know.

Now there are two lists: the drives that speak the third verdict, and the
drives that deliberately do not, each with its reason written down. A
drive in neither fails a check that runs on every proposed change, and
the failure names it and says what to do about it. The reason is required
too — an opt-out without one is an oversight wearing the clothes of a
decision.

One drive turned out to be in exactly the gap this describes, and is now
listed. It was added to the first list only after reading it: it does
speak the third verdict, in four places, and says so at its head. Adding
a drive to that list without checking is the same mistake as leaving one
off — it puts a claim into the runner's output that the drive never made.

The lists moved out of the runner to make any of this possible. The
runner starts every drive the moment it is loaded, so nothing could read
its lists without launching browsers against the live site, which is why
a warning printed during a run was the only guard that could exist. The
runner behaves exactly as before.
