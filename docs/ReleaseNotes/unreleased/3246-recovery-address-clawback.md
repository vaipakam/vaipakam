## Protected accounts — recovery address and clawback (#3246 part 2)

A locked protected account now has one exit that no single key can block and
no single key can steer. The owner sets a recovery address, which proves it
is controlled when it is set, comes into force after twice the account's
delay, and can be changed only after a 30-day wait that the owner or any
signer may cancel and a lock drops. Protected mode cannot be switched on
without one, and a signer cannot be finalized until one is in force.

The owner or any recovery signer may then claw the account back, even while
it is locked: everything the owner could withdraw moves at once to the
recovery address, outside the payout queue and the delay. Nobody chooses
where it pays. The account becomes recovered for good: it stays locked,
opens nothing, its positions cannot leave it, and anything paid to it later
is swept on to the recovery address by any caller. Its open offers and
Auto-lend funding can be released by anyone and are swept on the same way.
While an address is in force, the paused-platform escape route pays it.

The recovery address and clawback rules run in their own code contract,
`VaultRecovery`, which the vault's protected-mode code reaches for those
writes and which shares its record and authorization rules. Together they
would have passed the contract size limit. The vault still has one entry
point for every protected-mode write, and the deployment records both
addresses.

Moving a replaced account's positions to its replacement wallet is now a
delayed change in the protected record, like any other. The replacing wallet
asks for the move; it can run only once the account's delay has passed and
before the request expires. A lock or a clawback ends a waiting move, so the
positions stay with the account and follow the recovery path instead. A
keeper pass applies an open move when it matures, and ships disarmed.

The trigger from the owner's linked chat is not part of this change: a
clawback cannot be undone, so it will get its own permission with the keeper
mandate work (#3353) instead of riding on the lock permission. The keeper
passes for the sweep and the release are still to be built, and ship
disarmed. The design and its reviewed defaults are in
`docs/DesignsAndPlans/RecoveryAddressClawbackDesign.md`.

> Caveat: on an account with no signer, someone holding the owner key can change the recovery address after 30 days; protected mode without a signer protects against a stolen owner key only for that wait.
