## Thread — Reward remittances fund one day per send (PR #TBD)

A reward remittance from Base to a mirror now funds exactly one day. Before,
one send could fund several days, and the mirror received them as one shared
batch whose balance paid all of those days at once. The mirror held such a
batch back while more than one of its days was still open, and a day closes
only once every reward entry covering it has claimed past it. A loan open
across those days therefore waited on itself: its claim needed the batch,
and the batch needed its claim to have paid. The new two-chain Anvil suite
found this (#848), and it meant any backlog remitted in one send stranded the
mirror rewards of every loan open across it.

Base now refuses a remittance that funds more than one day, on the send and
on its fee quote alike, naming the bound. A day that only closes, moving no
tokens, can still travel with the one funded day. The keeper already sends
one funded day per remittance (PR #2823), so a backlog drains one day per
send per mirror, at one cross-chain fee per day. On the mirror, the old rules
that sometimes drew from a shared batch are removed, because they can no
longer be reached: a batch listing more than one day, which only a Base
breaking the new rule could send, is admitted, reported as withheld for
listing several days, and never paid out from. The coverage view reports it
under that name. The view of the retired priority tiers is removed.

No funds move differently for a single-day remittance, which is every
remittance a current Base sends. This needs a fresh deploy, like the rest of
the current reward work; no live chain is changed. Closes #2821. Refs #848.
