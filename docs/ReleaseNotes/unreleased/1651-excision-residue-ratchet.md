## A gate that stops the removed purchase surface being described as live again (#1651)

A feature was removed from this project for legal reasons: the protocol had a
fixed-rate way to buy its own token across chains, and that shape is the one
regulators treat as a security. The contracts went. The roughly hundred places
that *describe* those contracts did not, and clearing them has been running as
a series of small changes for weeks.

Each of those changes found something the one before it missed, and never in
the same kind of file twice — a contract comment telling operators that a
deleted contract still enforces a safety property, a security questionnaire
sent to a partner, deployment runbook steps, a section heading left behind
after its contents were deleted so that it silently retitled the unrelated
settings underneath it. The pattern is not carelessness. It is that prose has
no compiler: deleting a thing tells you nothing about which sentences describe
it, and no amount of care makes a person reliable at that search.

This adds an automated check for the class rather than another pass over it.

The obvious design does not work. Banning the removed names outright would
fail on the very text doing the cleanup, because a note explaining that
something was removed has to name it. So the check counts instead of bans: it
records how many times each file currently mentions the removed surface, and
fails when a count changes. A count going **up** means new text describing a
removed thing — the case worth blocking. A count going **down** means someone
cleaned up and the record is now out of date, which fails too, on the grounds
that a ledger nobody maintains stops being evidence.

Scope is deliberately narrow: live code, deployment scripts, operator
configuration, operator runbooks, user-facing copy and the specifications —
places where a mention is an instruction someone might follow. The historical
record is left alone. A release note about a removal is *supposed* to name
what was removed, and pinning those would produce constant noise from
documents doing their job.

The check runs on every pull request and blocks. That is a deliberate choice
about severity: text presenting a legally-removed surface as available is not
a style preference.

Two things came out of building it, both worth stating because they change
what the numbers mean. Counting *occurrences* rather than *matching lines*
turned out to matter — the two disagree wherever a line mentions the thing
twice, and line-granularity would let a mention be added to an
already-matching line without moving the number. And the first honest count
found two files nobody had listed, plus a stretch of deployment runbook that
still carries a step-by-step configuration checklist for the removed component
underneath a heading marking it historical. A label above a checklist does not
stop someone skimming for their chain's steps from following it. That is
recorded as known debt in the ledger rather than fixed here, so the cleanup
can be reviewed on its own terms.

No behaviour changes in the product.
