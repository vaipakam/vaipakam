## Keeper — the one-runner lease moves into the keeper's private database (PR #<n>)

Every keeper tick first claims a single lease row, so that only one keeper
runner signs at a time. That row lived in the shared database, which the
indexer and the agent can also write: a compromised or faulty indexer or agent
could hold the lease with an expiry years away and stop every keeper action,
liquidations and defaults included, without ever touching the signing key.

The lease now lives in the keeper's private database, which only the keeper
binds. A new keeper migration creates it there, and both the tick and the
machine's renewal on a skipped minute claim it there. The claim also refuses
to honour a lease whose expiry lies further out than the longest term a keeper
ever writes (ten minutes): such a row cannot come from a keeper runner, so the
next claim takes it rather than waiting for it.

The old shared copy is no longer read by anything. It stays until a separate
drop-only shared migration, so that a machine still running the previous
release when the new schema lands keeps claiming where it did and is not
stopped mid-update. The restore procedure now clears the lease in the keeper's
database.

This advances #1722 (the shared-database trust problem). The other two parts
of that issue, the liquidity-confidence streak and unsigned Telegram lock
requests, are separate changes.

> Caveat: until the follow-up drop, the shared database still holds an unused `keeper_runner_lease` table.
