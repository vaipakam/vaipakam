## Keeper — applying vault-beacon changes once due (PR #3297)

The vault beacon (#3204) holds three kinds of change that wait out a delay and
then may be applied by anyone: a Timelock proposal of a new current vault
version or a revoke, a vault owner's signed pin or unpin, and a vault owner's
signed lowering of its pin delay. Until now nothing applied them when nobody
did it by hand, and the permissionless-steps ledger recorded all four as a
gap. The new `vaultBeaconUpkeep` keeper pass is that backstop.

Every hour, on each chain whose Diamond names a beacon, the pass reads the
beacon's own request events up to the finalized block, keeps the vaults they
name in its work queue, and re-reads every queued vault's pending changes on
chain. A change is applied only once the beacon's own time for it has passed,
after a simulation shows it would succeed, at most one proposal, four pins and
four delay lowerings per chain per run. A change someone else applied or
cancelled first, and one the beacon says is still early, are reported apart
from a refusal. A vault leaves the queue only when nothing is pending for it
at both the latest and the finalized block.

The pass moves no value and pays only gas. It ships disarmed behind
`VAULT_BEACON_UPKEEP_ENABLED`; arming it is an owner decision. The four
ledger rows now name this pass and its flag.

Closes #3282.
