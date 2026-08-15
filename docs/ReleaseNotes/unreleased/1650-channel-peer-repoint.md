## Cross-chain messages now carry proof of who sent them, and lane settings refuse to be quietly re-pointed

**This changes the cross-chain message format and must be rolled out to both
sides of a lane together.** A messenger on the new format cannot interpret a
message from a messenger on the old one, and vice versa; a lane upgraded on
only one side stops delivering until the other side catches up.

**Drain each lane before upgrading it.** A message already in flight keeps the
format it was sent in, and an upgraded receiver cannot read it — so upgrading
the other end does not rescue it. Waiting for a refused message to become
deliverable will not work. Recovering one means rolling the receiving side back
to the old format, re-running the message, and upgrading forward again: possible,
but a far worse thing to be doing under pressure than draining was. The same
applies to anything sent into the one-sided window.

Nothing is destroyed in any of these cases — a refused message is recorded as a
failure rather than consumed — but "not destroyed" is not the same as "will
arrive on its own", and the difference is the whole reason to drain.

### What was wrong

Each cross-chain lane records the address of the contract it expects to be
talking to on the other network. That record was passed to the receiving
contract as the answer to "who sent this", and some receivers act on that
answer — but it was an answer read out of local configuration, not one
recovered from the message. So the receiving side was not verifying the
sender at all. It was repeating a claim, and the claim was only as good as
the configuration behind it.

That is a weak place to be even with careful operators, and it was made
weaker by how easily the configuration could move: the record could be
overwritten in a single write, with nothing to distinguish a deliberate
re-point from a first-time assignment.

### What changed

A message now carries the identity of the contract that actually sent it, and
the receiving messenger checks that identity against the configured peer
before handing anything to the local contract. A mismatch is refused rather
than reported as though it were the truth. The message format also carries a
version, and a version the receiver does not recognise is refused rather than
interpreted — reading sender information out of a layout you do not recognise
is guessing, and guessing about who sent a message is the thing this change
exists to stop.

Alongside that, all four lane settings — the chain's network selector, its
remote messenger, a channel's local handler, and a channel's remote peer —
now behave the same way. A change that conflicts with a live value is
rejected. Re-stating a value a setting already holds is still accepted and
does nothing, so a deployment script that reasserts its own configuration
does not need to know whether it has run before. A genuine change is made by
clearing the setting and then assigning the new value: two transactions, two
entries in the event log, and a re-point that reads as a re-point.

The uniformity is the point. The earlier version of this change protected
only the peer, on the reasoning that the other three fail loudly when
mis-set. That reasoning does not hold: a channel pointed at a wrong but
otherwise compatible address delivers its messages and tokens successfully.
None of the four announces itself reliably, so none of them is overwritten in
place. A remote address can also no longer be declared as the peer of two
different channels at once, which is a configuration that could never have
been right on both lanes.

### What operators need to do differently

Rotating a channel's partner address now requires draining the lane first.
Because a message carries the identity of whoever sent it, a message the old
partner had already sent is refused once the new one is installed. The
procedure is: stop the old contract sending, let whatever is in flight arrive
or be abandoned deliberately, then clear the setting and assign the new one.

A message stranded by a rotation done without the drain **is recoverable**, and
it is worth being exact about that rather than implying loss. There is no
expiry and no revocation involved: clear the new partner, put the old address
back, re-run the stranded message, then repeat the rotation properly. An
operator who believes a transfer is gone might abandon one that isn't. Drain
anyway — the recovery works by pointing a live lane's trust setting backwards
for as long as it takes, which is not something to be doing in a hurry.

**Rotating a channel's local handler needs the same drain, for a different
reason and without the same safety net.** A message names the conversation it
belongs to, not the contract that should receive it — that is resolved on
arrival — so a message sent while the old handler was in place is delivered to
the replacement, along with any tokens it carries. Nothing rejects it, because
from the protocol's point of view it arrived on the right conversation. This
one cannot be fixed the way the partner check was: a sender can prove its own
identity, but it has no way of knowing which contract the far side has
appointed. Quiesce the channel, let deliveries land on the old handler, then
change it.

**Upgrading an already-deployed messenger requires a migration step.** The
one-address-one-channel rule is enforced through a new index that starts empty
on an existing deployment, so it must be populated from the configuration
already in place — as part of the upgrade transaction, not afterwards. Until
that runs, the rule is not actually in force. The list of configured lanes has
to be supplied by the operator and derived from the deployment's own event
history, because a contract cannot enumerate its own configuration; a lane left
off the list stays unprotected.
