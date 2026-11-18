-- #3411 follow-up (row 3.9) — say when the index is REPLAYING, and how far
-- behind the chain's safe head it is.
--
-- WHY. A deployment adoption or a reorg rebuild clears the chain's rows and
-- replays them from the deploy block. Until the replay reaches the chain's
-- safe head, the lists and position statuses the indexer serves are partial:
-- a loan can be missing, or show a status it left long ago. Nothing said so.
-- `/health/ingest` reported the cursor's AGE (time since the last scan), which
-- stays small through a replay because the replay scans every few seconds, so
-- an app reading it called a half-built index "fresh".
--
-- WHAT, all on the deployment record (it survives the resets it describes,
-- and one UPDATE per pass keeps it current — see `src/replayState.ts`):
--   * `replay_reason` — set when a replay begins and kept until the scan
--     cursor first comes within one scan pass of the safe head: 'deployment'
--     (a deployment was adopted, the first one included) or 'rebuild' (the
--     reorg guard found an indexed block replaced).
--   * `safe_head` — the safe head the last pass resolved; NULL when that pass
--     could not read one (or none has been recorded).
--   * `safe_head_at` — when that pass ran (unix seconds).
--
-- Additive: three nullable columns. The serving Workers never read them, and
-- the read paths that do tolerate their absence.
ALTER TABLE indexer_deployment ADD COLUMN replay_reason TEXT;
ALTER TABLE indexer_deployment ADD COLUMN safe_head INTEGER;
ALTER TABLE indexer_deployment ADD COLUMN safe_head_at INTEGER;
