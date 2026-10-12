-- #2450 — keeper ops-alert de-duplication.
--
-- The keeper's reward passes raise OPERATOR alerts (the ops bot,
-- `TG_OPS_BOT_TOKEN`, never the user-facing one): the first is the #1566
-- sanctions-hold observer (apps/keeper/src/rewardSanctionsHold.ts), which
-- warns when a held claimant's observation deadline is about to pass, or when
-- a hold — and the staging encumbrance that blocks custody activation and
-- reward-role changes with it — outlasts the confirmation window. A pass runs
-- every few minutes and the condition it reports usually persists for hours,
-- so without a record of what was already sent the operator chat would get
-- the same line on every tick.
--
-- One row per alert KEY (a pass-chosen string naming the condition and its
-- subject, e.g. `sanctions-hold-overdue:<chainId>:<owner>`). `first_seen_at`
-- is when the condition was first reported, `last_sent_at` when it was last
-- delivered; a pass re-sends only after its own minimum interval.
--
-- Disposable state: losing it re-sends at most one line per live condition and
-- changes nothing on chain, so a restore may simply start it empty. Schema
-- lives here per the D1 discipline (every table in the shared database is
-- defined by an apps/indexer migration, whichever Worker writes it).
CREATE TABLE IF NOT EXISTS keeper_ops_alert (
  alert_key     TEXT    NOT NULL PRIMARY KEY,
  first_seen_at INTEGER NOT NULL,
  last_sent_at  INTEGER NOT NULL
);
