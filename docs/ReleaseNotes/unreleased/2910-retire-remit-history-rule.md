## Rewards — the remittance history rule is retired (PR #2941)

Two facts on a reward remittance's record were added after remittances had
already been released and finalized on Diamonds upgraded in place: how much of
a released remittance's recycled share is stranded in transit, and whether a
consumed remittance's recycled share has been booked against its destination.
A history rule filled both in for those older records, lazily where they were
read and through a public walk anyone could run, and the mesh watcher held back
its relocated-custody check until the walk had covered every record.

On this build a release writes its stranded share in the same transaction that
marks the remittance released, and every attested consumption books its share
in the transaction that records it. Every chain reaches this build by a fresh
deploy, so no record can be missing either fact, and the history rule is
removed together with everything that served it:

- the public history walk and its event, and the lazy stamping a recovery
  ceremony or a terminal-loss record performed first;
- the separate "booked from history" figure on the canonical chain and the
  three read-outs that reported it, the rows behind it and how much history
  was still unbooked;
- in the keeper, the "not stamped yet" state of a released remittance and its
  alert wording. A released remittance whose read shows nothing stranded and no
  compensation gate is finished; one whose read lacks the figure stays open;
- in the mesh watcher, the history-pending gap, the history reconstruction from
  the mirror's receipts and the advisory that compared declared history shares.
  The relocated-custody check compares the acknowledged share with the mirror's
  relocated custody directly, every tick.

Nothing changes for an operator of a fresh deploy: the walk had nothing to do
there. The governance runbook's post-refresh walk step is removed. The two
storage fields keep their places, marked retired, so the storage layout is
unchanged.

Refs #2910.
