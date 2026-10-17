-- 0001_keeper_state.sql — the keeper's PRIVATE operational state (#2450).
--
-- This database (`vaipakam-keeper-db`, binding `KEEPER_DB` in
-- apps/keeper/wrangler.jsonc) holds tables that ONLY apps/keeper reads or
-- writes: its scan cursors, its completion markers, its ack attempt log, its
-- HF-band edge state and its operator-alert de-duplication. Nothing in another
-- Worker, the app or the nightly backup reads any of them.
--
-- WHY A SEPARATE DATABASE, rather than more tables in the shared
-- `vaipakam-warm` D1:
--
--   - TRUST BOUNDARY. CLAUDE.md ("Cloudflare D1 schema discipline") keeps
--     internal ops-alert state out of the shared, user-facing database — the
--     rule ops/mesh-watcher already follows with its own D1.
--     `keeper_ops_alert` is exactly that kind of state.
--   - A D1 binding is database-scoped, not table-scoped (#1722). On the shared
--     database the indexer and the agent can write any keeper table; here they
--     have no binding at all. That matters most for the completion records:
--     a row in `keeper_commitment_day` makes the commitment-report pass skip a
--     day with zero RPC reads, so a writer that is not the keeper should not
--     be able to create one.
--
-- THE RULE FOR WHAT BELONGS HERE: a table any other Worker, the app or the
-- backup reads STAYS in the shared database, under apps/indexer/migrations —
-- `notifications`, `notify_state`, `keeper_commitment_reconciled` (the
-- indexer writes it) and the rest. Only keeper-only state moves.
--
-- WHERE FIVE OF THESE TABLES CAME FROM. `hf_band_state`
-- (apps/indexer/migrations/0041), `keeper_commitment_scan` and
-- `keeper_commitment_day` (0043), and `keeper_remit_ack_frontier` and
-- `keeper_remit_ack` (0044) were created in the shared database first, and
-- those migrations are ALREADY APPLIED. Do not edit, renumber or delete them:
-- D1 keys its applied-migration record on the FILENAME, so a renamed file
-- re-runs and an edited one silently diverges from what production ran. The
-- live rows are copied across at cutover (docs/ops/DeploymentRunbook.md,
-- "Keeper private D1 — one-time cutover"), and the old copies are dropped
-- later by a NEW indexer migration — never by changing these. The sixth,
-- `keeper_ops_alert`, was never applied anywhere, so it is created here only.
--
-- The DDL below is the live shape of each table (no later migration altered
-- any of them); the comments keep each table's reason for existing.
--
-- Apply from apps/keeper/: `wrangler d1 migrations apply vaipakam-keeper-db
-- --remote` (or `pnpm --filter @vaipakam/keeper run migrate`). No deploy
-- script applies these: the keeper's `deploy` verifies only the SHARED
-- database's migrations.

-- ── HF-band notification state (#1213 PR 2b; was indexer 0041) ────────────
--
-- One row per (chain, loan): the last health-factor band the keeper's
-- liquidator scan observed for that loan. The liquidator pass piggybacks band
-- classification on the full-book HF multicall it already performs.
--
-- Distinct from `notify_state` (shared) on purpose: that table is the
-- SUBSCRIBER alert rail — keyed by (wallet, chain, loan) with the wallet's own
-- thresholds. This one is GLOBAL protocol-band state (fixed 1.5 / 1.2 / 1.05
-- thresholds, one row per loan regardless of subscriptions) feeding the free
-- in-app inbox, whose rows land in the SHARED `notifications` table.
--
-- Only loans observed OUTSIDE the healthy band get a row (absence means
-- healthy), and rows for loans that left the active set are pruned each pass,
-- so the table stays proportional to the currently-at-risk book.
CREATE TABLE IF NOT EXISTS hf_band_state (
  chain_id       INTEGER NOT NULL,
  loan_id        INTEGER NOT NULL,
  -- 'warn' | 'alert' | 'critical' (never 'healthy' — see above).
  last_band      TEXT    NOT NULL,
  -- HF in milli-units (1e18-scaled HF / 1e15) at the last band change.
  last_hf_milli  INTEGER NOT NULL,
  -- The lowercased borrower-position holder the last row went to. Part of the
  -- edge detection (Codex #1300 r2): a borrower transfer while the loan stays
  -- inside the SAME band must still notify the NEW holder.
  last_recipient TEXT    NOT NULL,
  updated_at     INTEGER NOT NULL,
  PRIMARY KEY (chain_id, loan_id)
);

-- ── Commitment-report scan state (#1222 M3 B2-d1, Codex #1425 r2; was 0043) ─
--
-- The commitment-report pass walks the mirror chain's global reward-entry id
-- sequence per (day, side). The ON-CHAIN cursor only advances on submissions,
-- so without a persisted frontier a long run of non-covering ids would be
-- re-read every tick forever by a stateless Worker (livelock), and a day that
-- resolved out of order would need per-day RPC probing on every tick.
--
-- `scan_next` is the entry id the next scan resumes from — every id below it
-- is submitted on-chain or verified non-covering. `last_cursor` detects an
-- operator resetCommitmentAccumulation (the on-chain cursor moved BACKWARD),
-- which invalidates the frontier so the full range is rescanned.
CREATE TABLE IF NOT EXISTS keeper_commitment_scan (
  chain_id INTEGER NOT NULL,
  day_id INTEGER NOT NULL,
  side INTEGER NOT NULL,
  scan_next TEXT NOT NULL,     -- bigint as string
  last_cursor TEXT NOT NULL,   -- bigint as string
  updated_at INTEGER NOT NULL, -- unix seconds
  PRIMARY KEY (chain_id, day_id, side)
);

-- Per-(chain, day) resolution marker: stamped once the day's report is
-- complete AND dispatched. Later ticks skip marked days with zero RPC reads —
-- which is also why a marker is a completion record only the keeper should be
-- able to write (see the header).
CREATE TABLE IF NOT EXISTS keeper_commitment_day (
  chain_id INTEGER NOT NULL,
  day_id INTEGER NOT NULL,
  resolved_at INTEGER NOT NULL, -- unix seconds
  PRIMARY KEY (chain_id, day_id)
);

-- ── Remit-ack driving (#1222 M3 B2-d2; was 0044) ──────────────────────────
--
-- Base's reservations are dense (remitId 1..getRemitReservationNonce()), so
-- the keeper scans from a persisted frontier instead of re-reading every
-- reservation each tick, and rate-limits per-reservation ack attempts: an ack
-- takes minutes to deliver over CCIP, and re-sending every tick burns fees.
-- Losing these rows makes the keeper re-send acknowledgements it already paid
-- for, which is why the cutover copies them rather than starting empty.
--
-- `next_remit_id` is the terminal-prefix frontier: every reservation below it
-- is terminal (Acked/Released). `scan_cursor` is a SEPARATE rotating cursor
-- (Codex #1426 r1): a single permanently-Pending early reservation pins the
-- frontier, so without the rotation the bounded per-tick window would re-read
-- the same stuck range forever. Keys include the canonical DIAMOND (Codex
-- #1426 r4): remit numbering restarts per deployment, so a same-chain redeploy
-- must start a fresh scan namespace.
CREATE TABLE IF NOT EXISTS keeper_remit_ack_frontier (
  base_chain_id INTEGER NOT NULL,
  diamond       TEXT    NOT NULL,
  next_remit_id INTEGER NOT NULL DEFAULT 1,
  scan_cursor   INTEGER NOT NULL DEFAULT 1,
  updated_at    INTEGER NOT NULL,
  PRIMARY KEY (base_chain_id, diamond)
);

-- Per-reservation ack attempt log (backoff + observability). `acked_at` is
-- stamped once Base reports the reservation Acked; rows are retained as the
-- audit trail of keeper-driven acks.
CREATE TABLE IF NOT EXISTS keeper_remit_ack (
  base_chain_id   INTEGER NOT NULL,
  diamond         TEXT    NOT NULL,
  remit_id        INTEGER NOT NULL,
  mirror_chain_id INTEGER NOT NULL,
  attempts        INTEGER NOT NULL DEFAULT 0,
  last_attempt_at INTEGER,
  acked_at        INTEGER,
  PRIMARY KEY (base_chain_id, diamond, remit_id)
);

-- ── Ops-alert de-duplication (#2450) ──────────────────────────────────────
--
-- The keeper's reward passes raise OPERATOR alerts (the ops bot,
-- `TG_OPS_BOT_TOKEN`, never the user-facing one): the first is the #1566
-- sanctions-hold observer (apps/keeper/src/rewardSanctionsHold.ts). A pass
-- runs every few minutes and the condition it reports usually persists for
-- hours, so without a record of what was already sent the operator chat would
-- get the same line on every tick.
--
-- One row per alert KEY (a pass-chosen string naming the condition and its
-- subject, e.g. `sanctions-hold-overdue:<chainId>:<owner>`). `first_seen_at`
-- is when the condition was first reported, `last_sent_at` when it was last
-- delivered; a pass re-sends only after its own minimum interval.
--
-- Disposable state: losing it re-sends at most one line per live condition and
-- changes nothing on chain, so a restore may simply start it empty.
CREATE TABLE IF NOT EXISTS keeper_ops_alert (
  alert_key     TEXT    NOT NULL PRIMARY KEY,
  first_seen_at INTEGER NOT NULL,
  last_sent_at  INTEGER NOT NULL
);
