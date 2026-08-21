## The documentation caught up with a pause that had already been lifted (#1222)

Reward claims on chains other than the canonical one used to stop entirely for
days after the cross-chain cutover. That pause was deliberate: such a chain's
reward funding arrives from the canonical chain, and until the platform could
bound a payout by what had actually been received, resuming would have let a
chain pay out of tokens held for unrelated obligations. An attempt to lift it was
made and withdrawn in review when two further problems came to light.

**Both were subsequently solved, and the pause was lifted.** A chain now prices
those days from its own record of what it was funded, and a day it cannot yet
cover **waits** rather than stopping the chain: the wait ends by itself when the
funding arrives. What remains is a per-day pause on a day whose funding record
has not landed at all — a materially different thing from the chain-wide stop it
replaced, because a chain-wide stop had no way to end on its own.

**The documentation did not follow.** Thirteen separate places across nine files
still told the reader the pause was in force and that the attempt to lift it had
been withdrawn — including the functional specification, which is the reference
for what the platform is *intended* to do and is therefore the document an audit
would judge the code against. Someone reading it would have concluded that
correct behaviour was a defect. Several stale statements sat in the same passage
as the correction, contradicting themselves a few lines apart; one was a section
heading directly above a test that proves the opposite, and another was a status
table still reporting the work as abandoned.

**Corrected as a class, not as a list.** The statements were found by searching
for the *claim* in every phrasing it takes, rather than by fixing the places
someone had happened to notice, and the search was repeated after every pass —
which is what found them: the first sweep located five, and four further passes
raised it to thirteen.

**Three nearby statements were deliberately left standing**, because correcting
them would have introduced errors of the opposite kind. A day whose funding
record never arrives genuinely does still halt, so that sentence is accurate. A
dated release note from the period is a historical record of what was true when
written. And an unrelated deployment pause merely shares the vocabulary.

**The specification change is a recorded decision, not a transcription.** These
documents are written from the project's stated intent and never copied from the
code — a rule that exists so the specification can still catch a bug rather than
merely restating one. The intent here was settled and shipped when the lift was
merged; what had been skipped was the specification edit that should have
accompanied it. This closes that gap and does not decide anything new.
