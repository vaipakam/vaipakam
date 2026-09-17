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
)
-- STRICT, so the column types are ENFORCED rather than advisory (#2229 r2
-- `4034537653`). Ordinary SQLite lets a REAL sit in an INTEGER column, and a
-- cursor of `(deadline, 7.5)` is not a loan id — it compares as ordering
-- between loan 7 and loan 8 and steps over loan 7 silently, which is the
-- defect this whole table exists to remove, reintroduced through the type
-- system. Cheap here because the table is new: there is no existing copy for
-- `IF NOT EXISTS` to leave un-STRICT.
--
-- The reader validates anyway. It cannot see which statement created the
-- table it is reading — a restore, or a hand-run `wrangler d1 execute`, can
-- produce one this migration did not — so the guarantee is asserted at both
-- ends rather than assumed from one.
STRICT;

-- The positional cursor this replaces. Left in place it would be a row whose
-- value means nothing to anything that still reads that table, which is how a
-- later reader comes to interpret a stale index as a live position. The lane
-- tolerates the row being gone: an absent cursor starts at the nearest
-- deadline, which for that tick re-reads a prefix rather than skipping one,
-- and says so — a cursor that stays absent stops the scan progressing at all.
DELETE FROM indexer_cursor WHERE kind = 'prenotify_scan';
