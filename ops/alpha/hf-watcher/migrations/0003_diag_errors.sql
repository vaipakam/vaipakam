-- 2026-05-01 — diagnostics error capture.
--
-- Single table that records every `failure` journey event the
-- frontend sees, with redacted metadata only. Powers two ops
-- workflows:
--
--   1. **Cross-reference for GitHub issue reports.** The frontend's
--      `report on GitHub` flow embeds an `id` (UUIDv4) in the issue
--      body. Support team looks up that id in `diag_errors` — if it's
--      there with a matching error fingerprint, the report is
--      genuinely from a website session; if not, it was fabricated.
--      Defeats the "I'll claim a bug from your site happened to me"
--      bad-faith narrative.
--
--   2. **Proactive triage.** Every error users hit, even ones they
--      don't report, is here to investigate. Volume should be low in
--      production; if it spikes, that's the leading indicator we want.
--
-- Privacy: stores only what the existing GitHub-issue prefill already
-- publishes (redacted wallet `0x…abcd`, error metadata, locale,
-- viewport). No user-agent string, no full address, no localStorage,
-- no cookie content. The redaction contract is the same as journey
-- log → GitHub URL.
--
-- Anti-spam: the worker's POST handler rate-limits per-IP AND skips
-- writes when the same fingerprint repeats more than 5 consecutive
-- times. So a bad-faith user who tries to flood the table with
-- intentional repeated failures only ever burns one row per
-- fingerprint cluster (until a different fingerprint resets the
-- streak). The frontend also tracks the streak locally and stops
-- POSTing past 5 consecutive same-fingerprint failures, so the
-- worker rarely has to apply its secondary cap.

CREATE TABLE IF NOT EXISTS diag_errors (
  id                 TEXT PRIMARY KEY,         -- UUIDv4 from frontend
  recorded_at        INTEGER NOT NULL,         -- unix seconds, server clock
  client_at          INTEGER NOT NULL,         -- unix seconds, client clock (per
                                               --   frontend `Date.now() / 1000`)
  fingerprint        TEXT NOT NULL,            -- hash(area+flow+step+errorType+
                                               --   errorName+errorSelector); used
                                               --   for dedup at write time
  area               TEXT NOT NULL,            -- e.g. 'offer-create', 'wallet'
  flow               TEXT NOT NULL,            -- e.g. 'createLenderOffer'
  step               TEXT,                     -- e.g. 'submit-tx', 'precheck'
  error_type         TEXT,                     -- e.g. 'tx-revert', 'validation'
  error_name         TEXT,                     -- decoded custom-error name if any
  error_selector     TEXT,                     -- 4-byte revert selector
  error_message      TEXT,                     -- truncated to 1000 chars
                                               --   server-side (frontend sends
                                               --   what its own redaction
                                               --   contract allowed)
  redacted_wallet    TEXT,                     -- '0x…abcd' or 'not-connected'
  chain_id           INTEGER,
  loan_id            TEXT,                     -- when applicable
  offer_id           TEXT,                     -- when applicable
  app_locale         TEXT,                     -- 'en', 'es', etc.
  app_theme          TEXT,                     -- 'light' / 'dark' / 'unknown'
  viewport           TEXT,                     -- 'WxH', helps mobile / desktop
                                               --   triage
  app_version        TEXT                      -- frontend build hash if exposed
                                               --   via VITE_APP_VERSION; null
                                               --   when not configured
);

-- Lookup for the GitHub-issue cross-reference flow: support team
-- queries by id (always exact-match) so PRIMARY KEY already covers
-- it. The fingerprint+timestamp index powers the worker's
-- "consecutive same-fingerprint" dedup check at write time.
CREATE INDEX IF NOT EXISTS idx_diag_errors_fp_time
  ON diag_errors (fingerprint, recorded_at);

-- The retention prune (cron-driven, configured via DIAG_RETENTION_DAYS)
-- deletes rows older than the threshold. This index covers the
-- `WHERE recorded_at < ?` predicate so the prune doesn't full-scan.
CREATE INDEX IF NOT EXISTS idx_diag_errors_recorded_at
  ON diag_errors (recorded_at DESC);
