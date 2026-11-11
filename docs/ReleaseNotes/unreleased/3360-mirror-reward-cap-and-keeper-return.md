## Thread — Mirror loans carry the fee-linked reward cap, and a keeper returns a settled day's leftover to Base (PR #3555)

Every token loan opened on a reward mirror chain now records its lifetime
reward ceiling when it opens, exactly as Base loans have since the first half
of this work. Before this change a mirror loan had no per-loan ceiling, so two
wallets of one person could lend to each other there and earn VPFI bounded
only by the per-wallet daily share, which more wallets get around. Recording
the ceiling charges nothing.

A mirror pays its users from the VPFI Base delivered for each reward day, and a
claim takes only what it pays. So the part the ceiling or the daily share cap
trims, and any reward nobody claimed, stays with that day's delivery. Once the
day is proven closed (every loan and claim covering it has ended and nothing
can draw on it again), a keeper can now send that whole leftover back to the
Base that delivered it, which adds what arrives to its recycle bucket. The
keeper can send it only home and only after closure, chooses the size of each
part so it fits the lane, and pays the transport fee itself; no operator step
is needed. The operator's existing route, which needs the operator's
acknowledgment, stays available. The keeper pass that makes this call ships
switched off, so until an owner arms it the leftover waits on the mirror, held
and accounted.

The launch check that the reward cap is armed before any loan now applies on a
mirror too. A mirror does not arm the cap itself: it learns the first armed day
from Base's broadcast. So a mirror launches only after Base has armed the cap
and that broadcast has reached it, and on or after that day; until then its
check says so by name.

The owner chose this design: the cap on every chain, with the
leftover returned by a keeper rather than by an operator step.

Advances #3360.

> Caveat: on the next fresh testnet deploy each mirror's launch waits for Base's broadcast of the first armed day.
> Caveat: the returned leftover moves only once the keeper pass is built and armed.
