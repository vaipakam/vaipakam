-- 0038_notifications.sql — In-app notification center (#1213 / E-11), PR 1.
--
-- A derived, per-RECIPIENT materialization of the loan/offer lifecycle
-- the indexer already ingests, so the connected app can render a free
-- wallet-native inbox (bell + unread count + panel) instead of relying
-- on the off-chain paid channels (Telegram/Push/SMS/Email). The chain
-- stays authoritative for any action — rows deep-link to Loan Details /
-- the Claim Center and re-verify there (indexed-hints-only discipline).
--
-- One row per (recipient wallet, notification). A loan event that
-- concerns both parties materializes TWO rows (one per wallet), so the
-- per-wallet feed is a plain indexed `WHERE recipient = ?` read and
-- read/unread state lives on the row itself (wallet-keyed, no PII).
--
-- Idempotency: `dedup_key` is UNIQUE and every producer computes a
-- deterministic key, so a re-scan / catch-up re-run of the same event
-- can INSERT OR IGNORE without creating duplicate inbox rows.
--
-- See docs/DesignsAndPlans/InAppNotificationCenterDesign.md. This PR
-- ships the event-derived rows (loan matched / partial repay / repaid /
-- defaulted / liquidated); the time-based calendar rows (maturity, grace)
-- and the liquid-only HF-band rows are a follow-up cron pass — the
-- nullable `block_number` / `log_index` columns leave room for them.

CREATE TABLE IF NOT EXISTS notifications (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  chain_id     INTEGER NOT NULL,
  -- Lowercased recipient wallet. The notification is FOR this wallet.
  recipient    TEXT    NOT NULL,
  -- Notification taxonomy (NOT the raw contract event) — see
  -- `NOTIF_KINDS` in apps/indexer/src/notifications.ts.
  kind         TEXT    NOT NULL,
  loan_id      INTEGER,
  offer_id     INTEGER,
  -- Provenance of an event-derived row (null for cron-derived rows).
  event_kind   TEXT,
  block_number INTEGER,
  log_index    INTEGER,
  -- Optional small render-param bag (JSON) — the client mostly renders
  -- from `kind` + `loan_id` and deep-links to the detail page.
  data_json    TEXT,
  -- Unix seconds; the source block time for event rows.
  created_at   INTEGER NOT NULL,
  -- Unix seconds when the recipient marked it read; NULL = unread.
  read_at      INTEGER,
  -- Deterministic idempotency key (UNIQUE) — see notifications.ts.
  dedup_key    TEXT    NOT NULL
);

-- Idempotent materialization: a repeated event can't duplicate a row.
CREATE UNIQUE INDEX IF NOT EXISTS idx_notifications_dedup
  ON notifications(dedup_key);

-- The per-wallet feed: newest-first, cursor on (created_at, id).
CREATE INDEX IF NOT EXISTS idx_notifications_feed
  ON notifications(chain_id, recipient, created_at, id);

-- Unread-count + unread-only filter.
CREATE INDEX IF NOT EXISTS idx_notifications_unread
  ON notifications(chain_id, recipient, read_at);
