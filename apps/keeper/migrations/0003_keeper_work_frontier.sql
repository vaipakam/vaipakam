-- #2497 r4 — the DONE frontier of a done-set pass, keeper-private.
--
-- The delivery-proof and late-ack passes read every candidate the shared event
-- ledger holds and skip the ones their done set (keeper_work_done) records.
-- Without a frontier that read grows with every delivery and release ever
-- made. `from_block` is the first block at or after which some item is NOT yet
-- confirmed done: every item below it is done, so a pass reads the ledger only
-- from max(the active Diamond's deploy block, this). It moves only on positive
-- evidence (the done set), never past an open item.
--
-- Disposable: an empty table reads from the deploy block, as before.
CREATE TABLE IF NOT EXISTS keeper_work_frontier (
  chain_id   INTEGER NOT NULL,
  diamond    TEXT    NOT NULL,          -- lowercased, like keeper_work_done
  kind       TEXT    NOT NULL,          -- 'delivery_proof' | 'late_ack'
  from_block INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,          -- unix seconds
  PRIMARY KEY (chain_id, diamond, kind)
);
