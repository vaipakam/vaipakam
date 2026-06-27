## Thread — Indexer: re-scan-idempotent loan/offer handlers (#760)

A correctness fix to the chain indexer's projection of on-chain state into D1.

The indexer's per-chain scan writes its domain rows **before** it advances its
block cursor, so a tick that fails partway (after writing some rows, before the
cursor moves) makes the next tick **re-scan the same block range**. Two handlers
computed their write by reading the *current* D1 row and applying a **delta** to
it, which double-applies under that re-scan:

- An **internal-match** settlement read each loan's current principal/collateral
  and *subtracted* the matched amounts — a re-scan subtracted them again,
  corrupting the loan's principal and collateral.
- An **offer match** computed the filled amount from the current row's maximum —
  if the offer was also modified in the same batch, a re-scan computed it
  against the wrong (post-modify) base.

Both now write **absolute** values read **from the chain, pinned to the exact
block of the event being processed**, so re-applying the same event sets the
same value — the projection converges no matter how many times a range is
re-scanned. If the chain read fails, the row is left untouched for the next scan
to heal rather than committing a fallback value.

This is a latent bug today (partial-tick failures are rare) and changes no
intended behaviour — loan balances and offer fills were always meant to be
exact; this makes the indexer reliably reflect that. It is also the prerequisite
for the near-real-time render work (#757), which raises how often a range is
re-scanned.
