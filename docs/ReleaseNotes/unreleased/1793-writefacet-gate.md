## Thirteen components were missing from the record of what a deploy installed

A deploy writes a file listing every component it installed and the address each
one landed at. Everything downstream reads that file: the apps, the background
workers, upgrade tooling, and anyone verifying the deployment by hand.

Thirteen components were installed by a fresh deploy and never written to it.

Nothing looked wrong. The components were live and working — they were installed
correctly, and only the *record* of them was missing. The pre-deploy gate
reported success, because the one check it had asks whether every address the
deploy *did* record is of a kind the consumers understand. That question cannot
notice an address never recorded at all. So the gate was structurally incapable
of seeing this, and passed every time.

The thirteen are now written. Building the check that found them is what
surfaced them: the follow-up this came from assumed there was one such
component — the one whose omission was caught in review last week. There were
thirteen, and that one was not among them; it had already been fixed.

Two details worth recording, because they explain why this sat unnoticed.

The consumers already expected all thirteen. A second script, the one that
refreshes every component in place, writes the full set — so any chain that had
ever been refreshed had a complete record, and only a freshly deployed chain was
missing entries. That is why nothing downstream ever complained: the gap was
invisible on exactly the chains people look at.

And the addresses were never actually lost. A deployed system can be asked
directly which component serves any given function, so every missing address was
recoverable on-chain, as well as from the deploy's own logs. This was an
inconvenience, not a lost deployment — worth stating plainly, since an earlier
note about the same gap overstated it, and treating a recoverable record as an
unrecoverable incident is its own kind of error.

**The automated guard against this recurring is deliberately not in this
change.** A version of it was written — it read the two deploy scripts as text
and tried to prove that everything installed was also recorded — and then
withdrawn after review found thirteen distinct ways to slip a registration past
it. A registration hidden in a conditional written on one line, in a loop header
whose own punctuation split the statement, in a helper that is never called or
is called only sometimes, under a variable reassigned before the record is
written, or written by a second, more general writer that reaches the same part
of the file by another route. Every one of those was real, and every fix opened
the next.

That is not a run of bad luck. Proving that a particular line runs, under the
identity it appears to have, on every chain, is a question about scope and
control flow — and reading source text line by line cannot answer it. The check
was reaching a confident verdict it had not earned, which on a gate that stands
between a change and a deployment is worse than having no gate at all: nobody
reads a green one.

What settles the question needs no reading of source at all. Run the deploy,
then compare the record it produced against what the deployed system reports it
actually installed. That does not care how a registration is written, where it
lives, or what guards it. It is tracked as its own follow-up, along with the
label-comparison check described above, which has the same weakness for the same
reason.

So this change fixes the thirteen missing entries and states plainly that the
regression guard is still owed, rather than shipping an approximation of one.
