### Operator runbooks can no longer cite a directory that was removed

Review kept finding the same mistake in the operator documentation, in a
different document each time: a reference to a directory that no longer exists.
It is not the kind of mistake care prevents — nothing tells the person renaming
a directory which prose mentions the old name — so it is now checked by a
machine on every change, and the check **blocks** rather than warns.

The application directory was renamed some time ago and one hundred and
forty-seven mentions of the old name survived across thirty-nine documents. An
operator following one looks for something that is not there, usually at the
moment they can least afford to.

Seventy-two of those references — every one in the operator runbooks — are
corrected here rather than merely recorded. Where the old location simply moved,
each citation now names the new one. Where the thing itself was deleted, the
surrounding instructions were rewritten to say so: the deploy documentation had
operators syncing a second copy of the deployment addresses and running an
export step for a component that no longer exists, both of which were removed
when the background workers were split apart.

### Why it blocks instead of reporting

An earlier version of this change did not block. It carried a recorded list of
every existing problem and reported only when a document got worse, because the
backlog was assumed too large and too historical to clear.

That assumption turns out to be false where it matters. The platform is not yet
live, and the operator-facing part of the backlog was seventy-two references
across six documents with knowable answers — so it was fixed. With those
documents clean, the recorded list, the machinery that policed it, and the
follow-up task to eventually turn the warning into a gate all became
unnecessary. The check now demands zero, which is a stronger promise than the
recorded list ever made, and it is roughly seven hundred fewer lines of
machinery to trust.

What it covers is the operator runbooks specifically — where a wrong path costs
somebody real time, and where the cleanup has actually happened. The design
notes and closed to-do entries still hold older references, and some of those
must not be rewritten at all: the document that records the removal of a
component has to name the component it removed. Clearing what should be cleared
is tracked separately, and finishing it is what allows the check to cover more.

### One rule, and the reason it is only one

Three further checks were built alongside this one and deliberately held back:
whether a cited path exists at all, whether documents use the current form of an
application address, and whether a credential is written into a command line
where others can read it. Each was set aside on its own merits over several
rounds of review, and only afterwards did the common cause become clear.

All three ask a question of the form "is this thing absent or wrong", which
means they fire on anything the reader hands them that they cannot account for
— including fragments of text that were never a reference in the first place.
The part that finds candidate references in prose is deliberately imprecise,
because doing that job precisely means implementing the whole markdown language,
and eleven rounds of review demonstrated that approximating it converges on
nothing. Every one of those rounds' false alarms arrived through a question of
that shape.

The rule that shipped asks the opposite kind of question — "does this text
contain one of these two known-dead names". Review then sharpened the claim
behind it: a garbled fragment *can* trip the rule, but only when the garbled
text genuinely contains the dead name — in which case the document really does
mention something that no longer exists, and the alarm is true. What the rule
cannot do is raise an alarm about nothing; the worst an imprecise reader causes
is a miss. That trade is deliberate: a check that cries wolf is one people learn
to ignore, and then it protects nothing at all.

The same round of review found that commands were being read too coarsely —
an instruction like "change into the old directory and deploy" slipped past
because the whole command was treated as one name — and that three of my own
corrections had replaced a stale instruction with a wrong one, including a
database-migration command that does not exist and a credential rotation that
would have left a revoked token live. All are fixed, each verified against the
scripts and configuration they describe rather than against what sounded
plausible.

That distinction is now written down as the standing rule for adding a check
here, so the next person does not have to rediscover it over eleven rounds.

### One correction, kept in view

An earlier draft of this note claimed every broken link in the main
specification had been repaired. Three of them point at test files that exist
nowhere under any name, and repairing those means guessing whether each was
renamed, removed, or never written. They are left alone rather than quietly
deleted. Overstating what a check delivers is the same fault the check exists to
catch, so the correction sits here rather than somewhere quieter.
