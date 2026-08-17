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

The thirteen are now written, and the gate now asks the missing question: every
component installed must also be recorded, or the deploy stops. Building that
check is what found them. The follow-up it came from assumed there was one such
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

A second check lands alongside it, closing a gap a guardrail added earlier the
same day explicitly declared out of its scope. That guardrail proves the refresh
script touches the same components, running the same code, as a real deploy — but
it says nothing about the *labels* the refresh files them under, and it cannot:
the labels exist only as text inside the deploy script, with nothing in the
contract language able to read them. A mislabelled component would pass every
check there and then land in the record under a name no consumer looks for. The
new check compares the two scripts' labels for each component and fails on any
disagreement.

Both checks pair the two scripts without guessing at names. Each component
appears in the deploy script twice — once when installed, once when recorded —
and the two mentions share a variable; both scripts also refer to each
component's function list by the same name. Those shared references are what the
checks match on. The tempting alternative, converting a component's type name
into its record label by lowercasing the first letter, breaks on names beginning
with an acronym — and a name-guessing rule inside a drift check is just a new
place for drift to hide.

Each check was confirmed by breaking it on purpose first: removing one
recording, mislabelling one component in the refresh script, and renaming the
call the checks look for. The third matters as much as the other two — a check
whose inputs quietly disappear reports success, which is the failure mode being
fixed here, so it now refuses to pass when it finds implausibly little to
inspect and says so.
