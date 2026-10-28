## Thread — keeper sends carry the shared gas-limit margin

The repository has one rule for the gas limit a transaction is sent with: the node's estimate plus a fixed 30% margin (#2997). A node estimates against the latest block with no margin at all, and the transaction mines in a later block. So a call whose cost moves with time, like the reward-budget remittance #2997 found, can run out of gas at the bare estimate and revert. The app and the Anvil harness already followed the rule. The keeper sent every transaction at the bare estimate.

Every keeper send now follows the same rule, applied where the keeper prepares a transaction. That covers the queued wallet every pass sends through and the raw submission slot used for prepared sends. A send whose nonce the caller chose follows it too. A call that names its own gas limit keeps it.

Unused gas is not charged, so the margin costs nothing when it is not needed. The one visible effect: a node accepts a transaction only when the account holds the fee for its whole limit, so a keeper wallet running very low on gas tokens hits that refusal slightly sooner. Refs #2997.
