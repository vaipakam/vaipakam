# Planned-surplus repatriation — the accounting core lands dark (#1568, part 1)

The recycling programme gained the ledger half of "Mode A" repatriation:
the books that let the canonical chain deliberately move a mirror chain's
surplus recycled value back home, without ever conflating that movement
with reward spending.

What shipped, in behaviour terms:

- The canonical chain can now issue a bounded, releasable **authorization**
  against a specific chain's surplus. Issuing one immediately stops that
  amount being offered to any later funding round — the safe direction: an
  instruction that is still in flight can never be double-spent by the
  daily mesh.
- An authorization ends in exactly one of two ways: the value **arrives**
  (the books close it, and any transfer-fee gap is recorded openly rather
  than silently absorbed), or the mirror **confirms cancellation** (the
  amount becomes offerable again). Merely believing an instruction was
  never executed releases nothing — belief is not evidence.
- Arriving value re-enters the canonical books as a **custody move**, never
  as new absorption — so the transparency figures that size reward budgets
  cannot count the same value twice.
- A mirror's own books gained the matching outflow record, so the
  cross-chain composition picture stays exact after a repatriation.
- The whole surface is **dark by default**: until the cross-chain transport
  for this path is deployed and explicitly configured, every entry point
  refuses to act, on every deployment.

The safety rule this enforces (and the reason the earlier plan wording was
corrected): a repatriation is tracked in its **own** ledger pair, never by
borrowing the counter that tracks reward consumption — borrowing it would
corrupt the identity the mesh watcher checks on every tick. The mesh
invariant suite now drives this new draw alongside hostile report
magnitudes, and the transparency views publish its raw figures.

The moving half — the actual cross-chain send/receive machinery and its
operational watcher checks — follows as its own change.
