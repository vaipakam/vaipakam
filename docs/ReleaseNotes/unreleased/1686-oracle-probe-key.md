# Recovery: the sanctions-oracle check always describes the chain you are on

The recovery page checks whether the network you are connected to has its
sanctions oracle configured, and only opens the recovery flow once that check
comes back positive. The result of that check was not tied to the network it was
read for, so for a moment after switching chains the page could still be showing
the previous network's answer.

That mattered more than a stale label usually does, because this particular
answer is what unlocks signing. Arriving on a network whose oracle is not
configured, from one where it is, could briefly leave the flow open when it
should have been closed.

The check is now tied to the network, the contract address and the connection it
was made against, and reverts to "checking" the instant any of those change —
which closes the flow, the safe direction. Pressing retry likewise returns the
page to "checking" rather than leaving the previous answer on screen while the
new one is fetched.

The mid-submit re-check that runs immediately before signing is tied to the same
identity, so the state you are left looking at after an aborted submit matches
what was actually just read.
