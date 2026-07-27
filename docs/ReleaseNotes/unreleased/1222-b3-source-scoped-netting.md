## #1222 M3 B3 — a receiving chain's unspent reward commitments stop being lost

Stage B3 of the recycling completion programme (plan #1348 §M3; umbrella
#1349; design record `Vpfi1222B3SourceScopedNettingDesign.md`) closes the last
open half of the cross-chain reward books.

**The setup.** When the platform runs reward accounting across several chains,
one chain does the sizing and each other chain is told how much of a day's
reward budget to pay from its own recycled balance rather than waiting for a
transfer. The sizing chain records that instruction, and it models each other
chain's remaining balance as "everything that chain reported absorbing, less
everything it has been instructed to pay".

**What was wrong.** That model had no way to learn what a chain actually did
with an instruction. Two things followed.

First, the record of a chain's outstanding instructions only ever grew. It was
never reduced as those instructions were spent, so the figure operators and
monitoring read drifted further from reality every day.

Second — and this is the one that mattered — a reward can end without being
paid. A borrower or lender can forfeit their reward, or leave it unclaimed
past the claim horizon. When that happens the tokens set aside for it simply
stay in the chain's balance; nothing moves. But the sizing chain still counted
them as spent. Over a deploy's lifetime that gap widens without limit: a chain
with ordinary forfeit rates would eventually read as having no balance at all
while its balance was in fact full, and the platform would quietly go back to
funding every chain's rewards from the one sizing chain — exactly the
behaviour the multi-chain design exists to avoid.

**What changed.** Each chain now keeps two running totals — how much of its
reward commitments it has settled in total, and how much of that was settled
without any payout — and reports both on its daily close, alongside the
figures it already sends. The sizing chain uses the first to draw its
outstanding-instruction record down as those instructions are settled, and the
second to give the chain its balance back for commitments that ended without
paying anyone.

**Trust boundaries.** A reporting chain is believed about *when* things
happened, never about *how much*. Both totals are checked against what the
sizing chain itself instructed before they are accepted, and against each
other. The effect is a hard ceiling: a chain's available balance can never be
made to read higher than what that chain reported absorbing in the first
place — so this cannot be used to re-offer funding that was already sent to it
from elsewhere, which an earlier stage deliberately excluded.

**Rollout.** The daily report grows by two fields. The receiving side accepts
the new shape before any sender uses it, and both the sending and receiving
paths fall back one generation at a time if a component has not been upgraded
yet, so a partially-upgraded deployment keeps closing days normally and simply
omits the new figures until it catches up. Chains upgraded over existing state
start both totals at zero and recover forward as new settlements happen.

**No user-visible change.** Nothing here is reachable until the operator
arming ceremony, and no reward amount, claim, or fee changes. It is the
bookkeeping that decides which chain pays a reward from its own balance.

**Also in this change**, two operator read-outs about per-chain recycled
balances moved from the general configuration surface to the rewards surface,
alongside the rest of the per-chain reward records. Their content is
unchanged.
