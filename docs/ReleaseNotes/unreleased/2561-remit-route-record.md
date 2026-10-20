## Rewards — every remittance records where it was sent, and the keeper reports one sent to a replaced mirror (PR #2607)

A reward-budget remittance waits on Base, reserved, until the destination
mirror acknowledges it, and the keeper sends that acknowledgement once the
mirror shows a receipt. If a mirror is redeployed on its own with a new
messenger and Base's lane re-pointed at it, a remittance sent before that
executes, if at all, behind the old messenger. The new mirror never holds its
receipt, so the keeper waited for
it forever and nothing said so. No live case exists today, but BNB Testnet was
redeployed on its own on 2026-10-18.

Base now records, for every remittance it sends, the remote messenger the
message was bound to, which is the one adapter on the destination that can
ever execute it. A new read returns that record beside the adapter the lane
names now. Only the adapter is recorded because it is the whole route: the
destination adapter hands the message to whichever receiver it has registered
when the message executes, so a receiver replaced behind the same adapter still
receives it, and a replaced adapter never will. A remittance is refused, before
any value moves, when the destination has no remote messenger declared, and the
fee quote refuses it by the same rule, so every remittance leaves with a route
Base can name. The keeper still acknowledges any remittance whose receipt the
configured mirror holds. Each run it now reads the receipt of every
reservation in that run's slice, which is up to 200 in-flight reservations and
300 released ones, rotating through any larger backlog over later runs. It
classifies both kinds before it posts any alert, and posts its alerts before it
sends any acknowledgement. So neither a backlog of ordinary acknowledgements,
nor a slow send, nor a slow alert channel can hide a remittance it cannot make.
An alert is still sent when the keeper cannot read its record of open alerts. A reservation with no
receipt is reported to ops, never left waiting in silence, in two cases. The
first is a remittance sent through an adapter the lane no longer names. The
second is a Pending remittance still without a receipt more than 8 hours after
its send, the window after which CCIP needs a message executed by hand, whatever
its route. For that one the alert says the cause is not known to the keeper:
the message may be waiting for manual execution, or it may have executed at a
receiver since replaced behind the same adapter, which the route record cannot
see. One post per run covers every remittance of a kind, however many there
are. Each is listed with its destination, its age, the adapter it was sent to
and the one the lane names now (or that Base has no record of it), the CCIP
message id and the amount. A released remittance also shows what it still
waits on: its stranded share, the fact that the share is not stamped yet, or
the compensation gate it holds. The post says that settling it is an operator
decision. For a Pending remittance that means manual execution, finalizing on
proven delivery or releasing it when it will never execute. For a released
one, a late acknowledgement or a recovery record. Each alert re-posts daily
and clears once its remittance is settled, its receipt appears or its reason
no longer holds. The deployment
runbook's drain section now says what to do.

Base's cross-chain trust is unchanged: it still accepts acknowledgements only
from the lane's current peers. Recording the route is what makes the case
visible; it does not, and should not, let a retired mirror's acknowledgement
through. The contract half reaches a chain by fresh deploy (owner decision
O1 = A). That is the deploy policy, not a runtime dependency: the remote
messenger is read from the messenger's existing public getter, which every
deployed messenger already answers. A Base Diamond deployed earlier records no route, and the keeper treats its
remittances as route unknown, exactly as before. Closes #2561.
