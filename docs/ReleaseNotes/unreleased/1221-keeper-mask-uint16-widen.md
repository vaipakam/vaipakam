## Delegated-keeper action bitmask widened to make room for future actions (#1221)

The per-user delegated-keeper authorization bitmask — the mask that records
which actions a lender or borrower has authorized a keeper address to drive on
their behalf — was widened from an 8-bit to a 16-bit container.

The eight action bits defined today (complete-loan-sale, complete-offset,
init-early-withdraw, init-preclose, refinance, extend, signed-fill, auto-roll)
had completely filled the original 8-bit byte, so adding a ninth action would
have forced a storage-layout and interface change. Widening the container now
means each future keeper action — the auto-protect and keeper-sweep actions
planned for later user-value work — is a pure additive change: define the new
bit, add it to the "grant everything" set, and add the executor's authorization
check, with no storage migration.

Note this does not silently extend any keeper's authority. Authorization is
still an exact per-action bit check, so a user who previously granted "everything"
under the 8-action regime does **not** automatically authorize a future ninth
action — they must deliberately re-grant to include the new bit. That is the
desired safety property: the container growing can never widen what an existing
keeper is allowed to do; a newly-defined action reaches a keeper only by the
user's explicit new grant.

There is no behaviour change in this release. The same eight actions are the
only ones that exist, the same "grant everything" convenience value is
unchanged, and the authorization rules are identical. An attempt to grant an
undefined action (a bit outside the current action set) is still refused — the
validation now explicitly rejects the newly-expressible high bits, so the type
growth can never be used to grant an action the protocol has not defined.

Existing keeper approvals are unaffected: a value stored under the old 8-bit
container reads back identically under the widened one. Part of #1221;
prerequisite for the auto-protect (E-4) and keeper-sweep (E-10) work.
