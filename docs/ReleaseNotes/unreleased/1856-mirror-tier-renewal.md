## Thread — a steady tier can be renewed on a mirror

A mirror chain stops honouring a cached tier once it is older than the
mirror's maximum age (sixty days by default, thirty at the least). The
canonical chain, though, only sent a new tier push when the tier changed.
A user who staked once and held steadily therefore lost the discount on
every mirror after the maximum age, and nothing they could do would send
the push again: a poke resolved the same tier and was treated as no news.

The canonical chain now renews an unchanged, non-zero tier once its last
commit is fifteen days old, half the shortest maximum age a mirror may
use. The user's next tier-pushing action, or a tier poke, commits the same
tier again, and each mirror lane whose last delivery is that old is owed
it. A lane last delivered before that commit is owed it too, however
recent the delivery: otherwise a lane paid for late could let a renewal
pass it by and go unrenewed until close to its mirror's maximum age. Before that age an unchanged tier still sends nothing, and tier zero
is never renewed, because a mirror already treats a stale entry as no
discount.

A renewal keeps a discount alive, so it is paid like a raise: the caller
pays the lane fee, never the protocol broadcast budget. A holder who wants
the discount kept on a mirror pokes and pays once every fifteen days or
so; the budget cannot be drained by renewals.

The tier poke's own description was also wrong: it claimed a consent gate
that does not exist. It now says what the poke does, including the
renewal and who pays for it.

Closes #1856
