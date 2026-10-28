## Reward remittance — parts sized by both lane ends, no dust parts, no forgotten days (PR #TBD)

Since #918 a mirror's reward budget for a day can go in several parts. Three gaps in how the keeper sized and continued those parts are closed. First, a part is now sized by both ends of the cross-chain lane: what Base can send right now, and the most the mirror's side can ever receive in one transfer. A part above the mirror's inbound capacity could never be delivered and would sit in the lane until someone re-executed it by hand. Each chain now reports its inbound lane bucket publicly, and the keeper reads the mirror's on the mirror itself. The mirror's end is bounded by its capacity rather than its momentary balance, because that balance is drawn only when a part arrives, after any part still in flight.

Second, the keeper no longer sends dust. A part that would leave its day still owing waits, below a configurable minimum (1,000 VPFI by default, never more than the lane could ever carry), for the lane to refill. A part that completes its day is always sent. Each part costs a cross-chain fee, a reservation and a mirror transport epoch, so dust parts spent money to move almost nothing.

Third, a partly sent day is never forgotten. Base now keeps a public list of the days it has sent a mirror in part and still owes. A day joins the list when a part leaves it owing or a release reopens it, and leaves when it becomes whole or is abandoned with its chain. The keeper continues every listed day, oldest first, whatever its age. Before this, a day older than the keeper's scan window dropped out of it while the mirror held every later day behind it.

The two new views reach a chain only with the next fresh deploy. On a Diamond deployed before them the keeper says, every tick, which end or list it could not read, and sizes and scans as before. Closes #2960.

> Caveat: on a Diamond deployed before this change, a partly sent day older than the keeper's lookback is still continued only by widening the window or by hand, and the mirror's inbound capacity is not read.
