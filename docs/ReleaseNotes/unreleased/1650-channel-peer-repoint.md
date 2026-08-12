### Re-pointing a cross-chain partner address now takes two deliberate steps

Each cross-chain lane records the address of the contract it expects to be
talking to on the other network. That record does not steer anything — messages
find their way by other configuration entirely — but it is passed to the
receiving contract as the answer to "who sent this", and some receivers act on
that answer.

Changing it used to be a single write that overwrote whatever was there. That is
the shape of change worth slowing down, because of how it fails: getting it wrong
breaks nothing visible. Messages keep arriving, nothing errors, and the only
consequence is that the receiving side is told the wrong originator. Every
neighbouring setting already refuses to be silently reassigned for less
dangerous reasons — pointing a network or a handler at the wrong place makes
delivery fail loudly, which announces itself.

So a lane's partner address can now only be changed by clearing it first and then
setting the new one. Two transactions, two entries in the event log, and a
re-point that reads as a re-point rather than as a first-time assignment.
Re-stating the address a lane already has is still accepted and does nothing, so
a deployment script that reasserts its own configuration does not need to know
whether it has run before.

Nothing about how messages are delivered or authenticated changes. Worth being
precise about that, because the original report of this described the address as
unchecked, and it is not: only the network's own registered messenger can deliver
at all, and the lane a message claims is derived from the contract that sent it
rather than from anything the sender chose. Those two facts already mean a
message can only have come from the expected contract — what was missing was
protection against an operator quietly changing what "expected" means.

A cross-chain safety review had also asked for exactly this: partner assignments
that conflict with an existing one should be rejected rather than overwritten.
The neighbouring settings already honoured that rule. This one now does too.
