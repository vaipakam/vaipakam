-- #1525 / #1349 M5 — the retained-reserve backing snapshot, captured on the
-- SCHEDULED path rather than inside the public read route.
--
-- WHY A TABLE AND NOT A REQUEST-TIME READ. The first shape of this feature
-- made a live chain read inside `GET /metrics/recycling`, which is public,
-- unauthenticated and open-CORS. Six review rounds established that doing so
-- couples a chain call to a browser request, and every consequence of that
-- coupling has to be re-solved: the read must finish inside the frontend's
-- abort or it takes the D1-derived day series down with it; concurrent and
-- sequential callers must be coalesced or they spend the operator RPC quota
-- the indexer's own scanning depends on; coalescing must be cross-isolate to
-- mean anything; and each caller joining shared work needs its own deadline.
-- Those are real problems, they were being solved one at a time, and each fix
-- created the next.
--
-- None of them exist if the request path does no network I/O. The scheduled
-- pass already runs every minute, already holds the RPC configuration, and is
-- already the single place chain reads are budgeted. The snapshot lands here
-- and the route serves what is stored.
--
-- The cost is freshness — minutes rather than seconds — and that is disclosed
-- rather than hidden: `captured_at` is published as `asOf` and rendered beside
-- the figures. For a solvency check ("do the tokens behind the reported
-- reserve exist"), a reading minutes old answers the question; it is not a
-- trading input. A stale figure a reader can SEE the age of is a different
-- object from one they cannot.
CREATE TABLE IF NOT EXISTS recycle_backing_snapshot (
  chain_id INTEGER PRIMARY KEY,
  -- The six raw lens values plus the derived reserve, as a JSON object. Stored
  -- whole because the consumer publishes them whole: splitting them into
  -- columns would invite a partial row, and a partial backing block is exactly
  -- what the surface's all-or-nothing rule forbids.
  payload TEXT NOT NULL,
  -- TWO clocks, kept apart because they answer different questions. Holding
  -- one column for both made each answer wrong in a different way.
  --
  --   observed_at — wall clock when the capture ran. The only honest basis
  --                 for "has the scheduled pass kept up?", since that is a
  --                 question about the SCHEDULE.
  --   block_time  — the safe block's own timestamp. The only honest basis
  --                 for "is the chain still moving?", since a frozen RPC
  --                 answers happily with an old head and a wall clock would
  --                 renew that stale reading on every pass.
  --
  -- Stamping observation time from the block also silently charged the
  -- expiry for the safe head's finality lag, so a snapshot could expire
  -- before its own next scheduled turn.
  observed_at TEXT NOT NULL,
  block_time TEXT NOT NULL,
  -- How many chains were configured WHEN THIS WAS CAPTURED. The refresh
  -- cadence is `chains × tick`, and reading the count at request time
  -- instead lets a transient secrets failure — which drops chains from the
  -- readable set — shrink the expiry below the cadence that actually
  -- produced the row, marking a healthy snapshot stale. The row carries the
  -- cadence that made it.
  chain_count INTEGER NOT NULL,
  -- The block the reads were pinned to. Both lens calls describe one moment,
  -- because they explain each other: read independently, a remittance release
  -- landing between them shows a depleted reserve with no stranded term to
  -- account for it.
  block_number TEXT NOT NULL
);
