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
configured mirror holds. When the receipt is missing and the recorded adapter
is no longer the lane's, it posts an ops alert instead of waiting. One post per
run covers every such remittance on a path, however many there are. Each one is
listed with its destination, the adapter it was sent to, the adapter the lane
names now (or that it names none), the CCIP message id and the amount, and for
a released remittance the stranded share still unresolved. The post says that
settling it is an operator decision. For a Pending remittance that means
finalizing on proven delivery or releasing it when it will never execute; for a
released one, a late acknowledgement or a recovery record (a recovery ceremony
or a recorded terminal loss). Each remittance's alert re-posts daily and clears
once it is settled, or once its adapter is the lane's again. The deployment
runbook's drain section now says what to do.

Base's cross-chain trust is unchanged: it still accepts acknowledgements only
from the lane's current peers. Recording the route is what makes the case
visible; it does not, and should not, let a retired mirror's acknowledgement
through. The contract half reaches a chain by fresh deploy (owner decision
O1 = A), and it needs the messenger and the Diamond from the same release:
the route is read from the messenger at each send, so remittance facets
refreshed in place against an older messenger would refuse every remittance.
A Base Diamond deployed earlier records no route, and the keeper treats its
remittances as route unknown, exactly as before. Closes #2561.
