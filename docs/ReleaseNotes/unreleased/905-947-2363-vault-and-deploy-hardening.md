## Governance — vault template lock, deploy admin guard, reachable vault-version bar (PR #<n>)

The shared vault implementation now locks its own initializer when it is
deployed. Only the per-user vault proxies are ever initialized, so nobody can
call `initialize` on an implementation contract and make themselves its owner,
whatever path deployed it. Before, this depended on every deployer
remembering to initialize the template in the same transaction, and the
upgrade path only checked that the new implementation had code. The factory
and the upgrade script no longer initialize the template, since there is
nothing to initialize (#905).

The Diamond deploy now checks the admin address before it deploys anything.
The deploy hands every role and the Diamond's ownership to that address and
then renounces everything from the deployer, so a wrong address used to brick
the new Diamond. It now refuses the zero address, an admin address that is not
the address of the admin key the operator supplied, and, on a production
chain, an admin equal to the deployer key. The deployment runbook's stale
advice to set the admin address to the Timelock is corrected: the deploy-time
admin is the hot admin key, and the handover phase moves its roles to the
Timelock later (#947).

The mandatory vault version can no longer be set above the current vault
version. A user clears the bar by upgrading their own vault, which brings it
to the current version and no further, so a higher bar blocked every existing
vault with no way out until an admin acted again. Every change to the bar now
emits an event naming the old and new values (#2363).

Closes #905. Closes #947. Closes #2363.
