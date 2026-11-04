## Keeper — announce the untyped return of a transport remainder (PR #3149)

#2376 added an administrator-only mirror call that sends a released transport
remainder home to its issuing Base, untyped, where Base books it recycled on
arrival. It moves VPFI off the mirror, so the return-transport pass now
announces it to operators the same way it announces every other return: from
the chain's own `UntypedRemainderReturnDispatched` record in the indexer's
event ledger, with the amount, the budget packet, the destination, what stays
in the remainder, and the transaction. The keeper never makes this call
itself, because it is admin-gated.

The keeper README also stated the old rule for a mirror bound to another
Base, which #3147 changed. It now says the current rule: a recorded
instruction is driven toward its issuing Base, and only a new instruction is
withheld.

Nothing is armed: `REWARD_RETURN_TRANSPORT_ENABLED` is unset on the keeper
machine, and #2376 reaches chains only at the next fresh deploy. Advances
#2376.
