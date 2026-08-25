## Nine comments in the contracts described behaviour the code beside them had changed (#1349)

A code-first audit of the VPFI recycling programme — reading the source rather
than the tracking cards — found nine explanatory comments that describe how the
platform used to work rather than how it works now. Nothing users can see changes
here. What changes is what the next person reads before touching this code.

Four of them said the notification fee goes straight to the treasury with no
intermediate custody. It has not worked that way since the fee became the first
input to the recycling loop: the fee is taken into the platform's own custody and
credited to the recycling balance. Two of those four cited, as their authority,
the very file that contradicts them.

One was worse than merely out of date. It described how a loan opened before fees
were frozen per-loan resolves its treasury share, and it named the wrong source —
the current setting rather than the frozen historical one. A developer trusting
it would conclude the code had a bug and "fix" it, and that fix would quietly
reprice every grandfathered loan at repayment — in whichever direction the
current setting happens to sit relative to the frozen one. The project's own
engineering notes warn against exactly that change; the comment described it as
already true.

One header contradicted its own file a hundred and forty lines further down: it
said a cross-chain feature was deferred and inactive, while the code below it
implements and uses that feature. The reason the deferral existed is preserved,
because it explains why the current arrangement is safe rather than merely
allowed.

The last said a reserved field would start carrying values at a milestone that
has since passed. It is still empty, for a different and still-open reason, and
now says so.

Review of the first pass found four more, and one of them was introduced by the
pass itself: a corrected paragraph left an older paragraph in the same file still
asserting the state it had just retired, so the file contradicted itself in a new
place. Another named a function that does not exist, in a change whose entire
premise is that comments should resolve against the code. That one is now checked
mechanically rather than by eye — every symbol these comments name is confirmed to
exist before the change goes out.

Two others were understatements rather than errors, and correcting them made the
warnings stronger — then review showed both corrections were themselves too
confident, which is worth recording as its own lesson.

The first described a hazard as capping out at twice the correct fee. It is not
capped there: the fee setting a change like this would wrongly consult can be set
anywhere up to the platform's ceiling, and it can also be set *below* the frozen
historical rate, so the same mistake can move value in either direction. A third
comment elsewhere in the codebase had reasoned about the below-the-line case
correctly for some time, so two files quietly disagreed; they now say the same
thing.

Naming who actually loses took one more round to get right, and both earlier
attempts named the wrong person. This fee is a share of the interest the borrower
already owes — the rate divides that amount, it does not add to it. So the
borrower pays the same either way, and what moves is the split between the lender
and the platform: a rate above the frozen one pays the lender less than the terms
they agreed to, a rate below it short-changes the platform. The lender is the
party the frozen rate exists to protect, and both earlier versions pointed at the
one participant the setting cannot affect.

The second listed the reasons a billing step can fail and omitted one. Saying it
"stops billing for everybody" was then too broad, and the correction after that
was wrong in a third way: it claimed every other listed reason concerns the
individual being billed, when only one of the three does. The other two — a
caller without permission, and a platform-wide setting left unconfigured — fail
every payer alike.

That distinction is the whole diagnostic value, so it was worth a third pass to
state correctly. An exhausted shared budget is the only cause on that list that
fails some payers and not others, because the step skips its costly part for
users whose details have not changed. An operator seeing that partial pattern
correctly rules out the two all-or-nothing causes and is then left inspecting the
one failing payer — the single place the answer is not.

These were found by reading the code and asking what it does, rather than by
reading the documentation and believing it. That distinction is the reason the
audit was worth running.
