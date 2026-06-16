## Thread — LenderIntentVault v1-c: permissioned-solver gate (PR pending)

A lender can now mark a standing lending intent **solver-permissioned**: when set,
only the lender themselves or a solver the lender has explicitly authorized may
fill that intent. An intent left open (the default) stays fillable by any solver,
exactly as before.

This closes the gap the earlier slice deliberately left open. When the standing-
intent surface first shipped, the "authorized-solvers-only" flag was rejected at
registration because there was no gate to honour it — accepting it would have
given lenders a false sense of protection. That gate now exists: the flag is
honoured, and registering a solver-permissioned intent is allowed.

Authorization reuses the platform's existing per-user keeper-approval machinery —
the same mechanism that authorizes keepers for loan actions like preclose,
refinance, and loan-sale — with a new dedicated "fill a standing intent" action
the lender grants to specific solver addresses. Because the authorization is
checked before any loan exists, it is keyed to the lender (the party being acted
for) rather than to a loan position. A solver that hasn't been granted the action
is refused; the lender acting for themselves is always allowed.

Part of #393 (does not close the umbrella). The parallel opt-in for the gasless
signed-offer matcher (which would change that order's signature schema) is a
separate follow-up. Next: the zero-gap keeper-claim auto-roll.
