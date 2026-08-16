## A cross-chain check that was specified but never built is now retired rather than left pending

A storage field on each mirror deployment was set aside for a check on
incoming tier updates: the address of the contract on the canonical network
whose messages the mirror would accept. It was allocated, shipped, and written
up in the design as something the mirror validates on arrival. Nothing ever
read or wrote it. A previous change corrected the field's own description to
say so and deliberately left one question open — whether to finish building the
check or to abandon it. This settles that question: it is abandoned, and the
field is now documented as permanently unused.

Nothing about how the protocol behaves changes. The check was never running, so
there is none to remove.

### Why abandoning it is the safer of the two

Separate work has since put the sender's identity on the wire and made the
shared cross-chain adapter reject any message whose sender is not the partner
configured for that conversation. So by the time a tier update reaches the
mirror's own logic, who sent it has already been established against
configuration once.

Doing it again one layer up would not check the message a second time. It would
compare one stored copy of an address against another stored copy of the same
address — a check on whether a deployment agrees with itself, wearing the
appearance of a check on the message. That distinction matters because the two
copies have nothing keeping them in step. If they ever disagreed, a working
lane would stop delivering, and the reason would be invisible from the message:
both records look equally authoritative and neither says which one is stale.

This is the same failure the recent run of corrections kept turning up — a
second description of a fact drifting away from the first — except with funds
behind it rather than a comment.

### A neighbouring check that looks similar and is not

The mirror also checks that a tier update came from the canonical network, and
that one is genuinely necessary. The conversation carrying rewards traffic is
configured in both directions, so establishing that a message came from its
configured partner does not establish which end of the conversation it came
from. Without the network check, one mirror could push a tier update to
another. That check compares something recovered from the message against
configuration; the abandoned one would have compared configuration against
configuration. The resemblance is only in shape.

The full set of checks a tier update passes today — the transport's own sender
check, the sender-identity check in the adapter, the paired-messenger check,
the source-network check, and ordering — is now recorded alongside the retired
field, so the next reader can see what protects the path without having to
reconstruct it.

### The field itself stays where it is

Removing it would move every field declared after it, which is not a change
worth making to a live deployment to reclaim one unused slot. It stays
declared, unread, and now says plainly that this is deliberate rather than
unfinished.
