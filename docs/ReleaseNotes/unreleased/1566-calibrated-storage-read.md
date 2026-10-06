## Thread — the custody census reads the rows a Diamond will not tell it about (#1566)

Twelve of the twenty deployments in the custody census were undetermined
because the Diamond in question routes no getter for one or more of the
custody classes: nine of them only for the live-intent class, three because
they are bare shells whose facet cut never ran. The census now reads those
rows directly from storage, at a block named by its fingerprint like every
other read, and it does so soundly rather than by trust.

Three things make the read sound. The slot of every field is taken from the
compiler — a probe asks it which slot each load used — and pinned in a file
that a test asserts on every run, so a reordered struct fails before the
census can read a slot that no longer means what the file says. The slots are
calibrated: a test writes an intent commit, a rebate row and a fallback
snapshot through the same library layout the contracts use, reads each back
through the routed getter, and requires the raw storage at the derived slots
to equal both, on rows that are not zero. And the read is complete across history: the storage layout has not
been append-only since the earliest deployment — fields were inserted in May
and removed in June and August — so the census reads each row at the slot
every layout era used, and a row counts as absent only when it is zero at all
of them. What storage shows at today's slot is checked against what the
getter reported, loan by loan and in both directions, so a getter cut from
an older layout than the one the census assumes cannot certify a row away.
Where that era table cannot be read at all, no getter-based proof is issued.
And because a deployment could have been built from sources that were never
committed, every facet that may have written to a Diamond is matched by the
hash of its code to the build of one of those layout eras; a Diamond with a
facet that matches none is not certified on any class. That last rule is
what moves the census's headline from seventeen of twenty deployments proven
empty to ten: the live testnet Diamonds of base-sepolia and arb-sepolia have
run facets built from working trees no commit reproduces, and whether the
routed reads alone may certify such a Diamond is a decision the design puts
to the owner, with each withheld verdict recorded beside its refusal; the
standard is a recorded switch on the census, so ratifying either is a flag
rather than a change of evidence. The archive manifest now carries each
archived record's facet set, so a clean checkout attributes the same
population the operator's checkout does.
A bare shell is settled the same way from its loan counter, whose slot never
moved.

What it changes: where the read finds nothing, the cell is proven empty and
says how; where it finds a row, the row is reported with the era it was
found under and the cell stays undetermined, because the row's asset cannot
be read without the getter. The record naming a contract that is not a
Diamond is untouched, as an artifact correction for the operator.

The layout history the census had to reckon with is also a finding on its
own: a live Diamond refreshed in place across one of those removals reads
older state at the wrong slots, and nothing in the deploy tooling checks the
property an in-place upgrade depends on. That is raised as its own issue
(#2092); the guidance file now says the struct must only ever grow.

Two rules about what the census may claim were widened after review, and both
are the same idea said properly rather than said again in one more place. A
row counted as VPFI custody rests on exactly the comparison a row filed away
from it rests on — the row getter's asset against the token getter's answer —
so where those getters do not read the same layout, the census now withdraws
both sides of that comparison, not only the rows it excluded. The amounts are
kept and reported as evidence whose asset is unknown; the class total is not
stated at all, because stating it would assert the very thing the comparison
could not settle.

And a Diamond routes its functions one at a time, so any one of them may be
missing. Where a getter the census wanted is not routed, the class that needed
it is now recorded as undetermined and the rest of the deployment is still
read — where before a single absent getter could end the whole deployment's
read and leave every other class unexamined.

Those two rules withdraw a class, and a later review round found the
withdrawal did not travel: the census publishes a liability figure for the
whole deployment and a shortfall against the Diamond's balance, and both were
written before the passes that withdraw a class ever ran. So the report could
say in one place that a row's asset is unreconciled and in another still
present its amount as a substantiated liability. A class could also be
certified empty while holding rows whose asset nobody could read — a count of
zero standing beside the rows themselves.

Both are now one rule, applied once at the end of every deployment's census
rather than at the places that raised them: a verdict, and every figure
derived from it, is computed from the evidence the census finally holds. A
class holding rows of unknown asset is never certified and its count says how
many there are; the deployment-wide liability and shortfall are stated only
where every class contributing to them was established, and otherwise the
report says they are not established and why, with each class's own rows still
reported beside it. A withdrawn shortfall is now printed as unknown rather
than left blank, since a blank reads exactly like "none".

That one rule then had to become literally one place. Three more review
rounds each found a door between two parts of the census that wrote a verdict
separately — one granting a proof the other never saw withdrawn, one keeping a
count beside rows the other had filed as unknown. So the census now works in
two clean halves. The first half only reads: every value it takes from a
chain — the loan range from storage, every counter at every layout era, every
row any getter or storage scan saw, which functions are routed, the facet
history — goes into a recorded evidence file for that deployment, tagged with
where it came from, and nothing is concluded while reading. The second half
is a single judgement that runs over that frozen record and produces every
verdict and every figure the report publishes. A class is certified only when
every named condition holds on evidence actually present; otherwise it is
undetermined and the report names each condition that failed. Storage alone
decides which loans exist; what the routed functions report is checked
against it, never trusted in its place. In particular, "no loan was ever
created" is now concluded only from storage's own loan counter and every kept
lifetime and live-commit counter reading being zero at every layout era — a
routed report of zero can agree with that, but can no longer stand in for it.
A reading is kept unless it sits where an older layout kept a counter but a
current field (a list length, a version number) lives today; such a reading
is that field's value, not a counter, so it is set aside and named in the
verdict's evidence rather than silently ignored. A reading that cannot be
parsed is never taken as zero, and neither is a reading that is missing: the
current layout's reading of both counters must be present, so a record with
no counter readings, or without one of them, proves nothing about zero.
Likewise, a function is treated as not routed only where the evidence records
that answer, and the optional cross-check against the event history counts as
skipped only where the evidence says it was not taken or was unavailable — a
missing answer leaves the class undetermined rather than passing it.

Because the evidence is recorded, a verdict can be recomputed without touching
a chain. The census file moves to a second format version in which each
deployment carries the proof standard, which layout table and which judging
rule produced its verdict, and a fingerprint of its recorded evidence; the
evidence itself is kept in a companion file beside it, and a pair in which
either file was edited is refused when read back. A test re-derives every
committed verdict from its own evidence and requires an exact match. Both files
must stay under the size limit the repository's file checks enforce, and a
publication that would exceed it is refused with its reads saved, so they can
be republished later without reading any deployment again — though checking
that the new snapshot descends from the one it replaces may still need the
chain's endpoint, and where that check cannot be made the publication is
refused and a fresh run is the way forward; a test builds a census at the
committed scale on every run and confirms both files fit with room to spare.

The census tool gains a re-judge mode: after a change to the judging rule or
to the layout table, it recomputes every verdict from the committed evidence
and republishes through the same safety checks as a live run, with no network
reads when it re-judges the snapshot it replaces (a saved set of results newer
than that snapshot needs the chain's endpoint to check that it descends from
it, as above). It refuses a file in the older format, and it stops without publishing,
naming the deployment, whenever a fresh read is owed: the current layout table
lists a storage slot the recorded reads never covered; no storage was read at
all on a deployment because the layout table could not be used at the time, so
what the reads cover cannot be worked out; or a deployment's record was
corrected, removed or added after the reads were taken. One such read is owed
now, to write the first file in the new format; every later rule or table
change is a re-judge. The tool's request for missing layout builds is now
written only after a publication passes every safety check, so a refused
publication changes nothing. And the tool checks its command line against one
list of options before it reads anything: a mistyped option, an option
missing its value, or an option that only adjusts another mode given without
that mode (a re-judge option without re-judge, say) stops it at once instead
of being ignored — any of them could otherwise have started a full chain
read — and a help option lists every option it accepts. A verdict recomputed
from saved evidence now also reads word for word, and in the same order, as
the one the live run published: a large number held in memory and the same
number read back from the saved file are written out identically.

A census verdict is also never certified from a record the census could not
have written: a value that cannot be parsed, a scan that read fewer loans than
the range holds, one reading recorded twice, or a contributing facet whose code
was never read each leave the affected verdict undetermined, with the reason
named. A facet's recorded code fingerprint that is missing or malformed counts
as code never read; before, it could be taken for proof that the address held
no code at all, which reads as a facet that never wrote anything. And whether
the upgrade history named a facet is now taken from the history's own lists,
not from a label stored beside the facet, so a facet the history names with no
code at the census block is treated as unreadable even when its label omits
the history. A facet's code fingerprint recorded twice — even twice alike — and
the facet answering a function recorded twice with different answers are
records of one read the census cannot tell apart, so the facet's layout is
treated as unknown instead of taken from whichever record happens to come
first. And a record naming no contributing facet at all no longer passes as
"every contributing facet is accounted for", which is true of no facets only
vacuously: the census needs at least one named facet whose code it accounts for.
That reaches each recorded row too. A row whose loan cannot be read or
lies beyond the loan range, whose amount cannot be read or is missing, or whose
recorded source is not one the census reads is set aside, named and kept out of
the class's total. Before this, such a row could be counted under a certified
verdict. One row read from storage and through the protocol with no readable
amount could even be counted twice, because the census compared amounts by two
rules that differed on a missing one; there is now one rule, and under it a
missing amount matches nothing.

The committed census's verdicts do not move: the same ten of twenty
deployments are proven empty under the default standard. One figure recorded
beside them does move, and the design lists it for the owner. For three
base-sepolia bare shells archived on 1 July 2026 (the records of 00:15:58,
00:27:51 and 00:39:00 UTC), the result they would have had under the routed
standard goes from four classes proven to four undetermined. A shell has
no routed listing of its loans, so its emptiness rests on storage alone, and an
earlier review round already ruled that a storage-only proof does not survive
a refused provenance check under the routed standard; the committed file was
written a few hours before that rule and still shows the older figure. Every
other withheld deployment's routed-standard result is expected to stand, to be
confirmed by the next archive read. So ratifying the routed standard would now
certify fourteen of twenty deployments rather than the seventeen the committed
file implies.

Under the routed standard the protocol's own listing of loans must also list
at least as many loans as today's loan counter counted, not only as many as
older layouts' counters did; before, a listing that missed loans today's
counter counted could still vouch for a deployment whenever the counter matched
the protocol's own report of it. No recorded figure moves on this, since every
listing the committed file records matches today's counter exactly. One test
case the plan had fixed described a listing the protocol cannot produce (a
counter that included a loan the listing correctly hides), so it now uses the
figures the protocol does produce; the design records this for the owner to
confirm.

Six places where the design text and the code disagreed are settled on the
stricter reading and recorded in the design for the owner to confirm or
overturn, each with a single line.
