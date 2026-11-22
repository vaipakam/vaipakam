## Thread — A contract wallet can adopt an untracked asset

Adopting an asset that reached a vault outside the protocol needs the
owner's signed acknowledgement of the warning text. That check used to
recover a plain key from the signature and compare it with the caller, so
a contract wallet (a multisig, or the group and team accounts of #3770)
could never adopt anything sent to its vault by plain transfer.

The adoption now checks the signature the same way every other signed step
on the platform does: a key's signature is recovered as before, and a
contract wallet answers through the standard contract-signature check
(ERC-1271). What is signed is unchanged: the same acknowledgement, the same
per-account nonce and the same deadline, so a used signature still cannot
be replayed. A malformed signature is now refused with the adoption's own
"signature invalid" error rather than a low-level recovery error.

Closes #3780.
