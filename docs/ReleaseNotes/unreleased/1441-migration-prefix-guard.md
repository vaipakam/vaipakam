## Thread — Migration numbers are now checked for uniqueness (PR #1449)

The indexer's migrations directory is the single source of truth for every
table on the shared archive database, specifically so a fresh environment
can be built by replaying it in order. An audit found two migrations
sharing the number `0011`.

Nothing was broken, and nothing needed repairing on any existing
environment: the database keys its applied-migrations record on the
filename rather than the number, so both files ran and neither was
skipped. The latent problem is replay order on a *fresh* environment.
Pending migrations are applied in alphabetical order, so a colliding pair
replays in whatever order their descriptive names happen to sort in —
which need not be the order production actually experienced. The existing
pair is order-independent (one creates a table nothing else in the pair
touches, the other adds an unrelated column), so today it is harmless. The
next collision might not be.

A check now fails the build when two migrations share a number. The
existing pair is recorded as a deliberate exception with its reasoning
written down next to it, because the obvious tidy-up is the wrong move:
renaming a migration changes the key the database recorded it under, which
makes it re-run everywhere it has already been applied. For a
non-idempotent statement that fails the whole apply. The check also flags a
stale exception — one whose collision no longer exists — so the
exception list cannot quietly accumulate entries that would mask a real
future clash on the same number.

While auditing: two migrations are pending on the live staging database,
and that is correct rather than drift. Both belong to the cross-chain
commitment work and applying them is an activation step, not routine
housekeeping.

Closes #1441.
