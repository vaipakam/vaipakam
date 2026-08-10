## Thread — Seven contract comments corrected, and the missing check one of them described

Two review passes over the admin runbook found that several claims a
published operator page was making came straight from contract comments,
and that the code did not support them. The comments were the root
cause, so this change corrects them at the source. Nothing about how the
protocol behaves changes — but the way the code reads to an auditor does,
in two places where it had been actively misleading.

The most important one is the cross-chain channel-peer map. Its comment
said the local handler "does its own equality check against the peer it
expects", and the interface it feeds said the adapter "has already
checked it against the per-channel allowlist". Neither is true. The map
is routing metadata: the receive path asserts only that an entry exists,
never that it matches the address that actually sent the message, and no
handler shipping today compares it — three of them comment the parameter
out entirely, and the remittance receivers bind identity from the payload
instead. A peer configured to the wrong non-zero address is caught by
nothing. The authentication that does hold is one layer up, where the
CCIP router authenticates the sender and the adapter requires it to be
the messenger this chain allowlisted for that source chain. That is a
real boundary; the comments described a second one that does not exist,
which is exactly the belief that makes the next reviewer skip the check
that matters. Both now say what the code does and point at the open
question of whether the peer map should become a guard.

A third comment turned the same problem into an implementation gap
rather than a documentation one. A storage slot for a mirror-side
"authorized business peer" was allocated, shipped, and documented as
validated through that same peer map — and nothing in the tree reads or
writes it. The cross-chain reward design document specifies the check in
full. It was never built. The slot's comment now records that plainly,
names what actually authenticates a mirror tier update instead, and the
decision to build the leg or retire the design has been filed as its own
card so it is not lost in a comment.

The remaining corrections clear residue from the removal of the
fixed-rate VPFI purchase surface. Three comments still described it as
live: an orphaned storage-struct section header whose fields had gone and
whose sentence was cut off mid-clause, a keeper-reward constant claiming
parity with a buy rate that no longer exists, and — the worst shape — an
oracle setter justifying an unchecked operator input by pointing at a
payment-token policy enforced by a contract that was deleted. That last
one also cited a section of the repository guide that no longer exists.
Whoever audited that setter next would have gone looking for the
guarantee it leans on and found nothing, so the comment now states
plainly that nothing enforces it and the operator must verify the address
themselves. Finally, a reward-configuration field documented as "zero on
Base itself" is in fact set to Base's chain id on every chain, canonical
included, because the mainnet deploy script exports it unconditionally —
the wrong description had already caused a correct deployment to be
written up as configuration drift.

Review found that three of these claims had each been copied a second
time, which is the point of the exercise rather than a footnote to it.
The channel-peer claim also sat in the buyback remittance receiver's own
header, asserting a validation the messenger does not perform — and that
receiver, unlike its reward-side sibling, binds no sending identity at
all: its whole payload is a declared token cross-checked against the
delivered one, which proves the delivery is self-consistent and nothing
about who sent it. The "zero on Base" claim appeared in the setter and,
more consequentially, in a guard elsewhere that cited the wording as its
reason for reading the chain's own identity instead of the field. That
guard is still correct, but for a stronger reason than the one recorded:
the field is admin-settable, so a check reading it to decide "am I the
canonical chain?" could be switched off by a governance write, whatever
the deploy happens to configure. Both restatements are corrected, along
with the test commentary that repeated the original reasoning and the
operator runbook paragraph that described the struct comment as still
wrong. And the keeper-reward constant is now described as the
keeper-specific anchor rather than the only place the rate is stated,
because two other constants express the same relationship for different
features and none of the three reads the others.

A repository-wide sweep for the removed purchase surface found more
residue outside the contracts — including two app-side filters that skip
knobs targeting a facet that no longer exists — plus the guard that would
stop it recurring. That is deliberately not in this change: it touches
live application code rather than comments, and folding it in would mix a
documentation correction with a cleanup. It is filed separately.

Closes #1631 and #1641. Follow-ups: #1650 (build or retire the
business-peer check) and #1651 (app-side excision residue plus the grep
guard).
