## Thread — error-selector table is now drift-guarded, and a mis-mapped ERC-20 error fixed (#68)

The shared error decoder (`@vaipakam/lib`) turns a contract revert into
plain-language copy by looking the revert's 4-byte selector up in a
hand-maintained table. Because those selectors were transcribed by hand
(`cast sig`, to avoid shipping a hashing library in the app bundle), the table
could silently drift — a fat-fingered selector, or a Solidity-side signature
change, would quietly mis-decode or fall through to a raw hex blob.

A new drift guard makes the table self-verifying. Every selector is now
recomputed from its own signature and must match, and every mapped name that
the Diamond can actually revert with is cross-checked against the compiled
contract ABI. Its first run surfaced a real, pre-existing bug: the selector
`0x94280d62` was labelled `ERC20InvalidSender` when it is in fact
`ERC20InvalidSpender` (the approval path), so a genuine `ERC20InvalidSender`
revert (the transfer path, selector `0x96c6fd1e`) had no entry at all and
showed the user raw text. Both are now mapped correctly — an invalid-sender
revert reads "Invalid sender address for the token transfer." and an
invalid-spender revert reads "Invalid spender address for the token
approval." A second, older orphan (`0x0857e728`, a "repayment exceeds owed"
message that matches no error anywhere in the current contract surface) is
allowlisted with a documented reason and queued to be retired or
re-identified.

Guard-only for the contracts (no `src/` logic changed); the user-visible
effect is that the two ERC-20 approval/transfer errors now decode to correct,
distinct copy instead of one wrong label plus one raw blob. The guard runs in
the `@vaipakam/lib` unit suite, which now gates CI, so this class of drift
can't recur silently.
