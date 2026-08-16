## A cross-chain check that was specified but never built is now retired rather than left pending

A storage field on each mirror deployment was set aside for a check on
incoming tier updates: the address of the contract on the canonical network
whose messages the mirror would accept. It was allocated, shipped, and written
up in the design as something the mirror validates on arrival. Nothing ever
read or wrote it. A previous change corrected the field's own description to
say so and deliberately left one question open — whether to finish building the
check or to abandon it.

This settles that question: the check is abandoned, and **the field is deleted**
rather than kept and explained. Deleting it moves nothing else — it shared a
storage slot with its neighbour, and the field after it is of a kind that always
begins a new one, so every other field stays exactly where it was.

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

A misdirected partner setting cannot be caught this way either, which is the
other reason the second copy earns nothing. Pointing a network's partner
setting at the wrong contract makes the lane refuse the *right* sender rather
than accept a wrong one: a message carries the name of the conversation it
belongs to, and that name is stamped from whoever sent it, so only the
conversation's registered contract can send on it at all. The failure is a
lane that stops, not a lane that lets something through — and a second stored
copy of the address adds only a further way for two records to disagree, with
neither of them saying which is stale.

### A neighbouring check that looks similar and is not

The mirror also checks that a tier update came from the canonical network, and
that check stays. It is defence in depth rather than the only thing standing
in the way: the messenger already refuses a message from a network it has no
partner configured for on that conversation, and a correctly configured mirror
has exactly one partner. What the network check adds is what still holds if a
partner is ever configured for a network that should not be sending tier
updates at all.

That is still a different thing from the abandoned check. It constrains a fact
recovered from the message more tightly than configuration alone does; the
abandoned one would have compared configuration against configuration and
constrained nothing further.

The full set of checks a tier update passes today — the transport's own sender
check, the sender-identity check in the adapter, the paired-messenger check,
the source-network check, and ordering — is now recorded where the field used
to be, so the next reader can see what protects the path without having to
reconstruct it.

### The field is removed outright

An earlier draft of this change kept it, on the stated grounds that removing it
would move every field declared after it. That was wrong, and checking rather
than reasoning is what settled it: the field shared a slot with its neighbour,
and the next field along is of a kind that always begins a new slot. A
before-and-after comparison of the entire structure's layout shows one field
gone and **not a single other field moved**.

So it is deleted rather than kept and explained. Keeping a permanently unused
field alive on a justification that turned out not to hold would have been the
same kind of residue this change exists to clear.
