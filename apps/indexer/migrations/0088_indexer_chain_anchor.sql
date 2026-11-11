-- #3411 — the reorg guard's anchor: per chain, the block the scan cursor last
-- advanced to and that block's hash, as the chain reported it then.
--
-- The scan reads only up to the chain's own "safe" block and never revisits a
-- block below its cursor, so a reorganisation reaching below the cursor would
-- leave rows describing blocks that are no longer part of the chain. Every
-- pass re-reads the anchor block by number and compares the hash; a changed
-- hash means the chain replaced that block, and the indexer rebuilds the
-- chain's rows from the deploy block (see `src/reorgGuard.ts`).
--
-- One row per chain is enough to detect any such reorganisation: a replaced
-- block changes the hash of every block after it, so the newest anchored block
-- changes too.
--
-- Chain-scoped (it carries `chain_id`), so a deployment epoch reset clears it
-- with the rest, and the next scan anchors again from the new deploy block.
--
-- Additive: a new table, safe while the previous Workers are still serving
-- (they never read it).
CREATE TABLE IF NOT EXISTS indexer_chain_anchor (
  chain_id     INTEGER NOT NULL PRIMARY KEY,
  block_number INTEGER NOT NULL,
  block_hash   TEXT    NOT NULL,
  recorded_at  INTEGER NOT NULL
);
