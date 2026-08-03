-- 0041_hf_band_state.sql — HF-band notification state (#1213 PR 2b).
--
-- One row per (chain, loan): the last health-factor band the keeper's
-- liquidator scan observed for that loan. WRITTEN BY apps/keeper (the
-- liquidator pass piggybacks band classification on the full-book HF
-- multicall it already performs every tick); the schema lives here
-- because apps/indexer/migrations owns every table on the shared
-- `vaipakam-archive` D1 (CLAUDE.md "Cloudflare D1 schema discipline").
--
-- Distinct from `notify_state` on purpose: that table is the
-- SUBSCRIBER alert rail — keyed by (wallet, chain, loan) with the
-- wallet's own configured thresholds driving Telegram/Push sends.
-- This table is GLOBAL protocol-band state (fixed 1.5 / 1.2 / 1.05
-- thresholds, one row per loan regardless of subscriptions) feeding
-- the free in-app inbox. Folding the two would couple the inbox to
-- subscription rows that most wallets never create.
--
-- Only loans observed OUTSIDE the healthy band get a row (healthy
-- loans carry no state — absence means healthy), and rows for loans
-- that left the active set are pruned each pass, so the table stays
-- proportional to the currently-at-risk book, not loan history.
CREATE TABLE IF NOT EXISTS hf_band_state (
  chain_id       INTEGER NOT NULL,
  loan_id        INTEGER NOT NULL,
  -- 'warn' | 'alert' | 'critical' (never 'healthy' — see above).
  last_band      TEXT    NOT NULL,
  -- HF in milli-units (1e18-scaled HF / 1e15) at the last band change.
  last_hf_milli  INTEGER NOT NULL,
  -- The lowercased borrower-position holder the last row went to. Part
  -- of the edge detection (Codex #1300 r2): a borrower transfer while
  -- the loan stays inside the SAME band must still notify the NEW
  -- holder — the claim follows the NFT, and a band keyed on loan id
  -- alone would stay "unchanged" and never reach them.
  last_recipient TEXT    NOT NULL,
  updated_at     INTEGER NOT NULL,
  PRIMARY KEY (chain_id, loan_id)
);
