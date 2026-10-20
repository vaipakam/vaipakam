## Rewards — every remittance records where it was sent, and the keeper reports one sent to a replaced mirror (PR #<n>)

A reward-budget remittance waits on Base, reserved, until the destination
mirror acknowledges it, and the keeper sends that acknowledgement once the
mirror shows a receipt. If a mirror is redeployed on its own and Base's lane
re-pointed at the new one, a remittance sent before that landed at the old
receiver. The new mirror never holds its receipt, so the keeper waited for
it forever and nothing said so. No live case exists today, but BNB Testnet was
redeployed on its own on 2026-10-18.

Base now records, for every remittance it sends, the remote messenger and the
reward-budget receiver the lane named at that moment, and a new read returns
that record beside the route the lane names now. A remittance is refused,
before any value moves, when either is undeclared for the destination, and
the fee quote refuses it by the same rule, so every remittance leaves with a
route Base can name. The keeper still acknowledges any remittance whose
receipt the configured mirror holds. When the receipt is missing and the
recorded route is no longer the lane's, it posts an ops alert instead of
waiting: the remittance, the destination, both routes, the CCIP message id and
the amount, and that settling it is an operator decision (finalize on proven
delivery, release when it will never execute, or acknowledge by hand from the
old mirror). The alert re-posts daily and clears once the reservation is
settled. The deployment runbook's drain section now says what to do.

Base's cross-chain trust is unchanged: it still accepts acknowledgements only
from the lane's current peers. Recording the route is what makes the case
visible; it does not, and should not, let a retired mirror's acknowledgement
through. The contract half reaches a chain by fresh deploy (owner decision
O1 = A), and it needs the messenger and the Diamond from the same release:
the route is read from the messenger at each send, so remittance facets
refreshed in place against an older messenger would refuse every remittance.
A Base Diamond deployed earlier records no route, and the keeper treats its
remittances as route unknown, exactly as before. Closes #2561.
