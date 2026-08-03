-- #1525 / #1349 M5 — the retained-reserve backing snapshot, captured on the
-- SCHEDULED path rather than inside the public read route.
--
-- WHY A TABLE AND NOT A REQUEST-TIME READ. The first shape of this feature
-- made a live chain read inside `GET /metrics/recycling`, which is public,
-- unauthenticated and open-CORS. Review established that doing so couples a
-- chain call to a browser request, and every consequence of that coupling has
-- to be re-solved separately: the read must finish inside the frontend's abort
-- or it takes the D1-derived day series down with it; concurrent and sequential
-- callers must be coalesced or they spend the operator RPC quota the indexer's
-- own scanning depends on; coalescing must be cross-isolate to mean anything;
-- and each caller joining shared work needs its own deadline. Those were real
-- problems, they were being solved one at a time, and each fix created the next.
--
-- None of them exist if the request path does no network I/O. The scheduled
-- pass already runs regularly, already holds the RPC configuration, and is
-- already where chain reads are budgeted. The snapshot lands here and the route
-- serves what is stored.
--
-- The cost is that the reading trails the chain, and that is disclosed rather
-- than hidden: the surface publishes the moment the reading describes. For a
-- solvency check ("do the tokens behind the reported reserve exist"), a reading
-- somewhat behind the chain answers the question — but only if the reader can
-- tell how far behind it is.
CREATE TABLE IF NOT EXISTS recycle_backing_snapshot (
  chain_id INTEGER PRIMARY KEY,

  -- The six raw lens values plus the derived reserve, as a JSON object. Stored
  -- whole because the consumer publishes them whole: splitting them into
  -- columns would invite a partial row, and a partial backing block is exactly
  -- what the surface's all-or-nothing rule forbids.
  payload TEXT NOT NULL,

  -- WHICH DIAMOND these figures came from. `chain_id` alone is not an identity:
  -- a `--fresh` redeploy puts a NEW Diamond on the SAME chain, and without this
  -- the row from the old one keeps being served as current — a fully backed
  -- predecessor masking an empty or short successor, with no reason attached
  -- because nothing looked wrong. The block number cannot rescue that either:
  -- a block identifies WHEN, never WHOSE.
  diamond TEXT NOT NULL,

  -- TWO CLOCKS, kept apart because they answer different questions. Holding one
  -- column for both made each answer wrong in a different way, in opposite
  -- review rounds.
  --
  --   observed_at — wall clock when the capture ran. The only honest basis for
  --                 "has the scheduled pass kept up?", which is a question
  --                 about the SCHEDULE. Never published as the state's
  --                 timestamp: it post-dates the block by the finality lag.
  --   block_time  — the safe block's own timestamp, and what the surface
  --                 publishes as `asOf`. The only honest basis for "is the
  --                 chain still moving?", since a frozen RPC answers happily
  --                 with an old head and a wall clock would renew that stale
  --                 reading on every pass.
  observed_at TEXT NOT NULL,
  block_time TEXT NOT NULL,

  -- The block both pinned reads observed. They explain each other — read
  -- independently, a remittance release landing between them shows a depleted
  -- reserve with no stranded term to account for it — so they must describe one
  -- moment, and that moment is published so a reader can reproduce the figures.
  block_number TEXT NOT NULL,

  -- THE CADENCE THAT PRODUCED THIS ROW, recorded rather than inferred at read
  -- time. Captures rotate one chain per executed tick, so the refresh interval
  -- is `chain_count × tick_minutes`; deriving either at request time lets an
  -- unrelated failure — a transient Secrets Store outage shrinking the readable
  -- chain set, or a flag/binding mismatch changing the real tick — compute an
  -- expiry the row was never captured under, and mark a healthy snapshot stale
  -- or accept a stopped one.
  chain_count INTEGER NOT NULL,
  tick_minutes INTEGER NOT NULL
);
