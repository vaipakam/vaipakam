-- #3751 — the public rate curve's daily history.
--
-- One row per (chain, lending asset, curve term, UTC day). Two halves, kept
-- apart and labelled apart on the API:
--
--   own_*  the platform's own loans, under the standing rule for figures
--          built from them (TermAverageAndLinkGuardsDesign.md §8): each loan
--          weighted by interest PAID, repaid loans only, one wallet's share capped, a minimum number
--          of distinct lenders and borrowers, shown as a quartile band.
--          `own_state` is 'shown' or 'withheld'; a withheld row carries the
--          reason and no figures.
--   ref_*  the outside-source term average read from the rate reference
--          (`termAverage(asset, term)`, design §6.2). NULL with
--          ref_state = 'not-published' until that view exists on the
--          deployment.
--
-- Every row is a pure function of the `loans` table (and, later, a chain
-- read), recomputed by the indexer's rate-curve pass, so the table is
-- replay-derived: a restore clears it and the pass rebuilds the days it
-- covers. Additive: a new table only.
CREATE TABLE IF NOT EXISTS rate_curve_daily (
  chain_id        INTEGER NOT NULL,
  asset           TEXT    NOT NULL,   -- lending asset, lower-case 0x address
  term_days       INTEGER NOT NULL,   -- curve point: 7, 30, 90, 180 or 365
  day             INTEGER NOT NULL,   -- UTC day number (unix seconds / 86400)
  own_state       TEXT    NOT NULL,   -- 'shown' | 'withheld'
  own_reason      TEXT,               -- why withheld; NULL when shown
  own_p25_bps     INTEGER,
  own_median_bps  INTEGER,
  own_p75_bps     INTEGER,
  own_loans       INTEGER NOT NULL DEFAULT 0,
  own_lenders     INTEGER NOT NULL DEFAULT 0,
  own_borrowers   INTEGER NOT NULL DEFAULT 0,
  ref_state       TEXT    NOT NULL DEFAULT 'not-published',
  ref_value_bps   INTEGER,
  ref_a24_bps     INTEGER,
  ref_a90_bps     INTEGER,
  ref_weight_bps  INTEGER,
  computed_at     INTEGER NOT NULL,   -- unix seconds of the pass that wrote it
  PRIMARY KEY (chain_id, asset, term_days, day)
);
