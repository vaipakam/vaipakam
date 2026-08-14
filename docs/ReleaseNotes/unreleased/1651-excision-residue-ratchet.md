## A gate that stops the removed purchase surface being described as live again (#1651)

A feature was removed from this project to reduce legal exposure: the protocol
had a fixed-rate way to buy its own token across chains, and that shape carries
enough securities-law risk that the project chose not to carry it. That is the
project's own risk assessment, not a legal opinion and not a ruling about how
any regulator would classify it. The contracts went. The roughly hundred places
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
about severity: text presenting a deliberately removed surface as available is
not a style preference, and the reason it was removed is what makes a stale
description of it worth stopping.

Review of the first version found three ways past it, all of them real. It
matched only code spellings, so ordinary English — "VPFI buy adapter" — walked
straight through, and two deployment scripts were presenting the removed
components as current steps while the check reported green. Its list of
directories to search omitted the security policy document, which described the
deleted contracts as live parts of the cross-chain system. And because it
compared only a total, removing one mention while adding another in the same
file left the number unchanged — the exact shape of this project's own cleanup,
so a live instruction could have ridden in under cover of a legitimate edit.

All three are closed. Matching now happens on normalized text, which folds
casing, spacing and punctuation together and joins the file into one string, so
a phrase broken across two lines is caught too — one such mention was found
immediately. The scope became an exclusion list rather than an inclusion list,
because a list of places to look cannot cover the file nobody thought of, and
that is precisely what this is for. And each file now carries a fingerprint of
its mentions alongside the count, so a substitution that keeps the total the
same still fails.

Widening the net roughly doubled what it sees: fifty-three files rather than
thirty-one. Most of the newly visible text is legitimate, but some of it is not,
including operator-facing deployment steps and a security document. Those are
recorded as pending triage rather than fixed here — the ratchet stops the
problem growing, and the cleanup is reviewed on its own.

Two further things came out of building it, both worth stating because they
change what the numbers mean. Counting *occurrences* rather than *matching lines*
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
