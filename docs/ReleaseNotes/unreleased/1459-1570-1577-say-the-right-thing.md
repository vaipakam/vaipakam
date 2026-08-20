## The reward allocation is described as what it is: a spending limit, not a balance (#1459)

The platform reserves 69,000,000 VPFI for interaction rewards. Across the design
set that figure was repeatedly described as a *pre-funded pool* — a balance set
aside at launch and drawn down over time.

It is not, and the difference matters operationally. Deploying the token creates
a smaller initial amount for one recipient; nothing anywhere creates a 69,000,000
balance. The figure is a ceiling on how much may be *spent*, and the balance it
is spent from has to be funded into the platform as a separate, deliberate act.
The consequence the old wording concealed is the one an operator most needs to
know: the platform can report ample remaining headroom while holding nothing to
pay it with. Headroom is permission to spend, not evidence of funds.

The statements found saying otherwise now say so — including the one inside a
**ratified principle**, whose substance is unchanged and whose reword is recorded
in place alongside it. Several of the corrected statements are in the
machine-readable documentation that integrators inherit, so a downstream reader
no longer picks up the wrong model of where reward value comes from. No claim is
made that none remain: a wording sweep can only reach the phrasings someone
thought to look for, and the correction below is what happens when that limit
bites.

Wording that uses "pre-funded" in its ordinary and correct sense — a loan's
prepaid buffer, a test account funded in advance, surplus already delivered to a
chain that genuinely does pay later claims there — is untouched. The correction
is specifically about the 69,000,000 allocation.

Dated release notes already published are left as they stand. They are a record
of what was said at the time, and the specification is what governs.

## The commitment rule reads the same way everywhere it is stated (#1577)

Chains report how much recycled value they hold, and the platform instructs them
to spend against it. The rule bounding that has a subtlety: value committed and
then released un-spent stays where it was and may legitimately be committed
again, so the amount instructed over a lifetime is deliberately *not* bounded by
the amount reported. What is bounded is the instructed amount **net of releases**.

The working code has said this correctly for some time. Several places
*describing* it had not caught up, and one of them was a live test asserting the
older, simpler rule — passing only because that particular scenario never
releases anything. A test that is true by fixture rather than by rule will reject
a perfectly healthy state the day the fixture grows, and until then it teaches
every reader the wrong rule. Both assertions now state the real bound; they pass
identically today, which is the point.

An invariant elsewhere had the opposite problem: its **name** stated a form its
own body deliberately avoids, with a comment underneath explaining why that form
would break. The two forms agree in ordinary arithmetic and differ in the
arithmetic that actually runs, where the rejected one can overflow on a hostile
report. The name now matches the body — a name is read far more often than the
comment correcting it.

The descriptions in the contracts were corrected too, and there were more of them
than the record of outstanding work listed. That record is now kept without a
count, because this change demonstrated the reason for the rule: a first pass
corrected four of them and said so, and a review then found four more — all
describing the availability calculation by a formula that predates the release
term, one of them inside a comment block the first pass had already edited. A
count in a status note is a claim like any other, and it goes stale in the
direction that stops the next person looking.

## The treasury recycling rule is no longer filed inside one of its own footnotes (#1570)

The specification's treasury-recycling section had gained a subsection about a
per-chain surplus signal, and that subsection was placed directly beneath the
section heading — ahead of the section's own rule. Everything the section
actually says about recycling treasury value, the bug-bounty bucket, buyback
dormancy and the keeper budget therefore appeared, to any reader and to the table
of contents, to be part of a subsection titled "per-chain recycled-surplus flag
(operator signal only)".

The rule now comes first and its two refinements follow it. Moving it turned one
cross-reference inside the subsection — which said "the rule below", and was
correct while the rule was below — into a statement pointing the wrong way, so it
was corrected as part of the same move. A note deferring the disposal of a
flagged surplus to a section "tracked separately" now points at the section that
specifies it, which has since been written.

No statement of intended behaviour changed in any of this — the section says what
it said, in an order that lets it be found.
