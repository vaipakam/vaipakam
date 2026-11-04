## Thread — a released transport remainder goes home to Base and is recycled there automatically (PR #<n>)

A reward delivery to a mirror is held in a transport epoch until every day it funds is proven closed. What is still in the epoch then is parked, and once an operator acknowledges the parking it is released. Until now a released remainder had one way out: an administrator classifying it, on the mirror, as fresh or recycled. Where no one can say which it was, the remainder had nowhere to go.

It can now go home. On the mirror an administrator sends part or all of a released remainder back to Base over the existing return channel, in parts no larger than the mirror's side of the lane can carry. Each part reduces the parked balance and the delivery's untyped remainder by exactly what it sends, and is recorded as a disposal rather than a classification. Its tokens leave reward custody measured at both ends, and the message names the delivery and the Base Diamond that sent it. It goes to the chain that delivered the packet, even if the mirror has since detached or bound to another Base, the same rule #3015 set for repatriation instructions. A remainder not yet acknowledged, a delivery with no epoch, a zero amount and an amount past what is parked are all refused, with nothing moved. A failed send changes nothing.

On Base, what arrives is credited straight into the recycle bucket, with no operator step (owner decision, refining an earlier "reconcile on Base" plan). As with a retired chain's surplus, it is relocated custody rather than new absorption: it does not feed the day series behind the trailing absorption average and does not reopen fresh headroom. A Base Diamond that replaced the one that sent the delivery refuses the return, which leaves the cross-chain message retryable. Each arrival is announced with its source chain and the mirror delivery it came from, and each side publishes its running total.

The trade-off is stated, not hidden: a remainder that began as fresh budget is booked as recycled when it comes home. That is a labelling cost, not a loss, and it follows from the design rule that value is never typed in passage.

This is a new message kind on the return channel, so a receiver that predates it refuses the message and keeps it retryable. It reaches a chain only at its next fresh deploy.

Closes #2376.
