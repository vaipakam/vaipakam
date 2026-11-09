## Thread — Keeper clears listings and offers whose position moved

The keeper's hourly teardown duty now also clears the flows a position change has made impossible to complete. A prepay listing or a swap-to-repay intent whose borrower position changed hands since it was posted is cleared at once, without waiting for its grace or cancel-grace window. A vehicle offer bound to a moved position is cancelled: a preclose offset, a lender-sale listing, or a refinance request (also when a later request replaced it). Its refund goes to whoever posted it. The protocol made each of these open to anyone in #3389; this is the keeper backing every permissionless step needs.

To find them without simulating every live flow on every run, the protocol gains two read-only answers that apply the same rule the teardowns apply. One says whether a position's route for a given flow is dead. The other says whether an offer's route is dead. The keeper reads them at one block, then still asks the protocol whether each teardown would succeed before sending it. A flow that is still live costs no simulation.

Cancelling an offer is refused while the protocol is paused, so those cancels run last, with the intents. A lender-sale listing that is both expired and moved is still torn down by the existing sale teardown, which also starts the seller's relist cooldown.

The duty stays switched off behind its existing flag and pays only gas. The two new reads reach the testnets at the next fresh deploy. Until then the duty's new reads fail on the older Diamonds and are reported as unread, and its other work goes on.

Advances #3336 (the app and indexer hiding of dead listings remains).
