## Keeper — repatriations already on a mirror go home after it moves (PR #<n>)

The return-transport pass used to stop driving an authorization as soon as
its mirror was no longer bound to the Base that issued it. That stall was
the keeper's own caution from before #3015. Since #3015, a mirror executes a
recorded instruction, and acknowledges a cancelled one, only toward the
issuing Base. Nothing the mirror's current binding says can redirect it.

The keeper now follows that rule. An instruction the mirror has already
recorded is executed, or its cancellation acknowledged, toward the issuing
Base even after the mirror detached or reattached elsewhere. The same checks
as before still run first: Base must be served, the named Base Diamond must
be the one there, and its return receiver must deliver to it.

A new instruction is still not sent to such a mirror. The mirror records an
instruction only from the Base it is bound to now, so the delivery would be
refused and its CCIP fee spent. The keeper alerts operators instead, since
cancelling the authorization is then their decision. A chain that has become
Canonical holds no instruction to act on and is alerted the same way.

The pass ships unarmed on the keeper machine (`REWARD_RETURN_TRANSPORT_ENABLED`
unset), and the #3015 contract change reaches chains only at the next fresh
deploy. Advances #3015.
