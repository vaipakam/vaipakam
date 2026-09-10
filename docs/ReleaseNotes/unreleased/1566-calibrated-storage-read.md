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
