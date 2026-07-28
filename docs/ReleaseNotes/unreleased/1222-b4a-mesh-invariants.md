## #1222 M3 B4-a — the cross-chain reward books are now proved, not just tested

Stage B4-a of the recycling completion programme (plan #1348 §M3; umbrella
#1349) adds a property-based test suite for the multi-chain reward
bookkeeping. It changes no behaviour — it establishes that the behaviour
already shipped cannot be broken.

**What it proves.** Six standing rules about what the sizing chain believes of
every other chain, checked against tens of thousands of randomly generated
message sequences rather than a handful of hand-written scenarios:

- a chain is never asked to fund more than it has reported absorbing, once
  commitments it settled without paying anyone are credited back;
- the record of a chain's outstanding instructions always equals what it was
  instructed minus what it has settled — exactly, including while messages are
  still in flight;
- a chain's available funding can never read higher than what that chain
  reported absorbing in the first place;
- a reporting chain is believed about *when* things happened, never about *how
  much* — both settlement totals stay bounded by what the sizing chain itself
  instructed;
- a day can never be sized against funds another unsettled day already
  committed;
- the sizing chain's books about itself stay empty, so a single-chain
  deployment is untouched by any of this.

**Why generated sequences.** The generator is free to reorder, duplicate,
drop, and interleave reports with day closings, and to send deliberately
absurd figures — which is the honest way to check bounds that exist precisely
because a faulty or compromised chain might lie. A scripted test can only
demonstrate the cases its author thought of.

**What generated sequences cannot establish, and what covers it instead.**
The six rules above are all *upper bounds on final state*. Several further
guarantees are about a **transition** — a repeated message must change
nothing, a skipped report must be made whole by the next one, a settlement
total must never move backwards, and a commitment ended without payment must
actually give funding capacity back. A bound cannot prove any of those: a
ledger could mishandle every one of them and still finish inside every bound.
Those guarantees are therefore covered by deliberately scripted checks that
read the books, apply exactly one message, and read them again. The generated
campaign owns the bounds; the scripted checks own the transitions. Saying
otherwise would be the kind of assurance overclaim this note is at pains to
avoid.

**A note on how this suite was built, because it matters.** All six rules are
upper bounds, so all six hold trivially on an untouched ledger — a test driver
that quietly does nothing produces a completely green suite that proves
nothing at all. That happened twice while writing this, and both times the
output was indistinguishable from success. The suite therefore carries a guard
that fails the run outright if the generator never actually exercised the
machinery. Anyone extending it should keep that guard honest.

The rules were also checked in the other direction: with the protective bounds
deliberately removed, three of the six fail as they should. That exercise
confirmed something worth recording — the "available funding can never exceed
what was reported" rule now holds because of how the arithmetic is arranged,
not because of the bounds, so it survives even that mutation.
