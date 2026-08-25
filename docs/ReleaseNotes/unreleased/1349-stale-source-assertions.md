## Nine comments in the contracts described behaviour the code beside them had changed (#1349)

A code-first audit of the VPFI recycling programme — reading the source rather
than the tracking cards — found nine explanatory comments that describe how the
platform used to work rather than how it works now. Nothing users can see changes
here. What changes is what the next person reads before touching this code.

Five of them said the notification fee goes straight to the treasury with no
intermediate custody. It has not worked that way since the fee became the first
input to the recycling loop: the fee is taken into the platform's own custody and
credited to the recycling balance. Three of those five cited, as their authority,
the very file that contradicts them.

One was worse than merely out of date. It described how a loan opened before fees
were frozen per-loan resolves its treasury share, and it named the wrong source —
the current setting rather than the frozen historical one. A developer trusting
it would conclude the code had a bug and "fix" it, and that fix would quietly
reprice every grandfathered loan upward at repayment. The project's own
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
anywhere up to the platform's ceiling. It can also be set *below* the frozen
historical rate, in which case the same mistake underpays the treasury on every
grandfathered loan instead of overcharging the borrower. That direction is the
easier one to miss, because nobody is visibly harmed by it. A third comment
elsewhere in the codebase had reasoned about the below-the-line case correctly
for some time, so two files quietly disagreed; they now say the same thing.

The second listed the reasons a billing step can fail, all of which concerned the
individual being billed, and omitted one that does not. Saying it "stops billing
for everybody" was then too broad: the step skips its costly part for users whose
details have not changed, so while the shared budget is empty some payers keep
billing normally and others fail. Mixed success is exactly what a
one-user-at-a-time problem looks like, which is what makes this one hard to
recognise — a sharper warning than the one it replaced.

These were found by reading the code and asking what it does, rather than by
reading the documentation and believing it. That distinction is the reason the
audit was worth running.
