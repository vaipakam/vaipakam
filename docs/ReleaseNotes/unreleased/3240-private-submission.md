## Keeper — private submission route per chain (PR #<n>)

On a chain with a public mempool, a liquidation or forced sale sent to the
ordinary RPC can be seen before it lands, then copied or sandwiched. The
keeper can now be given a private submission endpoint per chain, such as
Flashbots Protect on Ethereum. Its signed transactions are broadcast there
instead, while every read (nonces, gas estimates, receipts) stays on the
chain's ordinary RPC.

The route is set per chain, not per pass. Every transaction the keeper key
sends on a private chain goes through the endpoint. The key's sends share one
nonce sequence, and the ordinary RPC cannot see a private transaction until it
is mined. A public send on the same chain would read the wrong next nonce and
could replace the private one. For the same reason, the keeper trusts a
remembered nonce longer on a private chain: seven minutes, against the six
minutes Flashbots Protect keeps a transaction pending. A dropped private
transaction can therefore hold later sends on that chain for up to that long.

Falling back to the ordinary RPC is opt-in per chain. When it is allowed and
the private endpoint refuses or does not answer, the same signed transaction
goes to the ordinary RPC, so a second transaction can never result. It does
become public, and the keeper logs that it fell back. When it is not allowed,
a failed private send is a failed send.

Settings the keeper cannot read stop every send on every chain, and the log
says why, rather than quietly sending publicly. Every tick logs a
`submission routes:` line naming each chain's route and the endpoint's host,
never its URL, which can carry an access key. With nothing configured, every
chain sends publicly, as before.

This closes the keeper side of #3240. Which mainnet chains get a private route
is the owner's decision, to be recorded in the mainnet checklist (#3243).

> Caveat: the per-close-out hold (`keeperTxPending`) reads the ordinary RPC, which cannot see a pending private transaction. On a private chain, a second attempt at the same loan inside the pending window can still be sent; it queues behind the first and reverts once the first lands, costing gas but moving nothing.
