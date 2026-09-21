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
