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

Two more followed from those additions. The first is that "check who owns it"
was not precise enough to be safe: ownership transfers here happen in two steps,
and only the second one clears the name of whoever was about to take over. A
contract can therefore be owned by governance and still have another key waiting
to claim it — at any moment, including after the switch, at which point that key
holds every setting and the power to replace the contract. The procedure now
names both expected values rather than one, and the same omission in the earlier
ownership check elsewhere in the document is fixed with it.

The second concerns a lookup the transport keeps in both directions. The reverse
direction was added later, so a contract upgraded from the earlier version
carries it empty until a migration is run over a list of pairs the operator has
to reconstruct from the event history — the contract cannot enumerate its own
configuration. While it is empty, the rule that one counterpart belongs to one
channel is not enforced, and a replacement performed during this very ceremony
can quietly attach a live counterpart to a second channel and leave one route
rejecting everything. Three existing deployments are in that state today, so this
is a migration to confirm rather than a hypothetical.

A further round found that the table's own right-hand column — the one marking
which entries earlier steps already cover — had not itself been checked. Two of
those "already covered" marks were wrong. The pair of lookups that translate
between a chain's ordinary identifier and the one the transport uses are read
nowhere in the procedure, in either direction, and every other check passes with
a stale one; and the entry authorising the chain that sends the funds arrives on
a different channel from the one carrying the announcements, so a single line
about "the peers" covered one and read as covering both. Both are now their own
requirements. The lesson is the obvious one: a table that records what is already
covered has to have each of those claims verified, or it becomes a more confident
version of the list it replaced.

Two smaller corrections came with it. The ownership assertions were scoped to the
contracts that carry a pause guardian, which quietly exempted the one that sets
every lane's rate limits and can authorise its own replacement — they now apply
to every contract the handover transfers, with the guardian check kept only where
there is a guardian. And the instruction to let in-flight deliveries finish
before changing a binding was not something an operator can observe: it is now a
reconciliation of every message sent since the last known-good point, each of
which must have arrived or been explicitly dealt with. A message still pending is
a blocker rather than a delay, because the transport will deliver it eventually
and eventually is after the change.

Three corrections then landed on those corrections, and each is the kind that
only shows up when someone tries to actually perform the step.

The ownership check had become an instruction that cannot be carried out on one
of its nine targets. Eight of them are built on one widely used ownership
library, which lets anyone read who is waiting to take over; the ninth uses the
transport vendor's own version, which keeps that value hidden and offers no way
to read it. The blanket instruction would simply fail there — and an operator who
hits that either stops, or quietly drops the check on the one contract that
controls the token's transfer pools. It now has its own path, established from
that contract's published history of ownership handovers instead.

A second transfer had been missed entirely. Alongside the ordinary ownership
handovers there is a separate two-step handover of the right to designate which
pool the transport uses for the token. None of the ownership readings touch it,
so skipping its second step leaves the original deployer able to swap that pool —
after every check has passed, and after the switch. Both of its values are now
read back.

And the drain instruction had grown an escape hatch that does not close anything.
It allowed a stuck delivery to be "abandoned with the reason recorded". A failed
delivery here stays re-executable indefinitely and there is no way to cancel one,
so an abandoned message can arrive after the rebinding and be handed, with
whatever it carries, to the replacement — the exact outcome the drain exists to
prevent. The only terminal state is a delivery that succeeded, and the procedure
now says so.

All of this is read back before the switch, in the same pass that already
verifies the wiring rather than the components, and the design record carries the
same additions so the two documents do not drift apart.

The remaining review threads are being worked through the same way — each one
checked against the procedure as it now stands, and answered with what was
found. The count of genuinely outstanding points is an outcome of that pass, not
something to be asserted ahead of it.
