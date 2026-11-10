## Thread — alpha05 VPFI deposits can be signed instead of approved (PR #<n>)

The VPFI deposit on the Rewards page can now be funded with a one-time
signature instead of a token approval. The review offers it only where
Permit2 is deployed and the wallet has already approved Permit2 for VPFI
elsewhere. The app never asks for that approval itself, because it is
open-ended and shared with other apps. The usual approval of exactly the
amount stays the default and is always available.

The signature covers exactly the amount, names the protocol as the only
spender, can be used once, and lapses after 30 minutes. Only a transaction
the wallet itself sends can use it. The receipt says all of this, and the
deposit is dry-run with the signature before it is sent. The result is
measured from the deposit's own event and the transfer into the vault, so
the VPFI counts toward the fee-discount tier exactly as on the approval
route.

Advances #3180.
