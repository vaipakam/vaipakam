-- #2219 — the pre-notify scan resumes at a DEADLINE, not at a list position.
--
-- The lane remembered where it stopped as a numeric index into the
-- deadline-ordered candidate list. That list is rebuilt every tick and a loan
-- stamped last tick is no longer in it, so the index does not point where it
-- did: stamp the nearest five, persist 5, and next tick position 5 is the
-- ELEVENTH original loan — the sixth through tenth, the nearest remaining
-- deadlines, are stepped over. The lane's stated guarantee is
-- nearest-deadline-first, and under sustained load a position-based cursor
-- inverts it.
--
-- A deadline is stable under insertion and removal in a way a position is not,
-- so the cursor becomes the ordering key itself — the same pair the candidate
-- list sorts by. Two named columns rather than the two packed into one integer:
-- an encoding would fit the existing cursor table without a migration, and
-- would leave a number nobody can read and every future reader has to decode
-- correctly.
--
-- This table belongs to apps/agent's pre-notify lane, and lives here because
-- apps/indexer/migrations is the single owner of the shared database's schema
-- (CLAUDE.md, "Cloudflare D1 schema discipline") — not because the indexer
-- reads it.
CREATE TABLE IF NOT EXISTS prenotify_scan_cursor (
  -- One row per chain. No `kind`: this table holds exactly one kind of thing.
  chain_id        INTEGER NOT NULL PRIMARY KEY,
  -- The deadline to resume AT: the next tick examines the first candidate at
  -- or after (next_checkpoint, loan_id) in the deadline order.
  next_checkpoint INTEGER NOT NULL,
  -- The tiebreak within one deadline second, so the pair is a TOTAL order and
  -- a resume cannot land in the middle of a group ambiguously.
  loan_id         INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
);

-- The positional cursor this replaces. Left in place it would be a row whose
-- value means nothing to anything that still reads that table, which is how a
-- later reader comes to interpret a stale index as a live position. The lane
-- tolerates the row being gone: an absent cursor starts at the nearest
-- deadline, which re-reads a prefix rather than skipping one.
DELETE FROM indexer_cursor WHERE kind = 'prenotify_scan';
