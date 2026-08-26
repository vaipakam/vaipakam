# M7 activation runbook — three preflight checks that were missing, and a review backlog that was never read

The written procedure for switching on the recycling programme gained a section
in August describing, step by step, what an operator must confirm before the
one-shot switch is thrown. That switch cannot be moved once it lands, so every
check that happens after it is a check that happens too late.

The review of that procedure raised a large number of points and almost all of
them were answered while the change was still being written. A little over a
hundred of the review's own conversation threads, though, were never replied to,
and nobody had gone back to establish which of them still described something
missing. That is the work this change begins.

Reading the procedure against each point, most turn out to have been addressed
already — the objection was raised, the paragraph was rewritten, and only the
unanswered thread was left behind. Three were not addressed, and all three share
a shape: a component reads back perfectly on its own inspection while the thing
the protocol actually consults points somewhere else.

The first is the canonical chain's own record of which reward messenger to use.
It is a different address from the cross-chain messenger the procedure already
told the operator to check, so checking that one and stopping leaves a stale
value in place — and both the daily reports and the broadcast that carries the
cutover day to the other chains go through it.

The second is the local binding between a channel and the contract allowed to
use it. Rotating any of the three participating contracts without finishing the
registration leaves every outward-facing check passing — addresses agree, peers
agree, nothing is paused — while each chain's own messenger still points the
channel at the contract that was replaced. The first send after the switch then
fails.

The third is the gas allowance each messenger attaches to its cross-chain
deliveries. Nothing validates it when it is set, so an upgrade can leave it at
zero, and every other check in the procedure passes while each delivery runs out
of gas on arrival.

Review of that change then made the same point about the fix itself, four more
times: the pass reads what the central contract believes, and each thing it
points at is separately settable from its own side. A rotation that updated one
side leaves the other naming what was replaced, and every check still passes. One
of the four is not stored state at all — the address a messenger routes through
is fixed into the implementation when it is built, so replacing the
implementation changes it while every stored value the procedure reads is
untouched.

Rather than add four more remembered items to a list that had already missed
three, the procedure now enumerates each participating contract's settable state
as a table and requires all of it to be read back — marking which entries earlier
steps already cover. The list of things to check is now derived from what the
contracts can actually be told to point at, rather than from what someone
remembered to write down.

Review then made three further points about that table, and the first is the one
that would have hurt an operator soonest: the procedure explicitly permits a
simpler variant of this ceremony in which the other chains carry none of this
machinery, and the new block did not say it was for the fuller variant only. An
operator following the simpler path would have been asked to inspect contracts
that were never deployed, and would have had no way to finish. It is now marked
for the branch it belongs to, with an instruction to skip rather than attempt it.

The second is that matching readings are not sufficient when something has just
been replaced. Deliveries already in flight are directed at their destination
when they arrive rather than when they were sent, so one sent to the old
contract, and anything it carries, is handed to the replacement instead — and
every reading still agrees. The contract itself says this is a procedure to be
written down here rather than something it can enforce, so the procedure is now
written down here: quiet the channel, let what is in flight arrive, then change
the binding, and settle anything that already failed before trusting the new
readings.

The third corrects a claim in our own new text, which said the table enumerated
everything settable. It enumerates the settings — not the people who can change
them afterwards. Each of these contracts has an owner who can rewrite every one
of those fields and authorise a replacement of the contract itself, and a
guardian who can halt the transport, and both can act after the check has passed
and after the switch is thrown. The earlier ownership check in the procedure
covers the main contracts as they were handed over, and says nothing about one
replaced since — which is exactly the situation this section is about. Those are
now read back too.

All of this is read back before the switch, in the same pass that already
verifies the wiring rather than the components, and the design record carries the
same additions so the two documents do not drift apart.

The remaining review threads are being worked through the same way — each one
checked against the procedure as it now stands, and answered with what was
found. The count of genuinely outstanding points is an outcome of that pass, not
something to be asserted ahead of it.
