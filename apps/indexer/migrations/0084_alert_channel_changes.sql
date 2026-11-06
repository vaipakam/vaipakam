-- #3246 — a delayed, announced removal of a Telegram alert chat while
-- protected account mode is on.
--
-- Protected mode makes every payout wait a delay, and its alerts are how the
-- owner sees a payout or a change in time to lock the vault (the Telegram
-- LOCK command included). A thief holding only the owner key could otherwise
-- silence those alerts first: unlink the chat, or link their own chat in its
-- place, both of which used to take effect at once. So while the wallet's
-- account is protected on a chain, the agent does not remove the chat linked
-- for that chain at once. It records the change here and:
--
--   - keeps sending every alert to the chat linked now until the change
--     takes effect (the account's own protected delay, 2 to 5 days);
--   - tells that chat at once, and the chat can reply CANCEL to stop the
--     change, or LOCK to lock the vault;
--   - applies the change on its scheduled tick once `effective_at` passes.
--
-- Adding a chat where none is linked is still immediate: it only adds a
-- listener. Accounts without protected mode keep the immediate unlink.
--
-- One row per (wallet, chain) row of `user_thresholds` the change touches.
-- At most one is pending per (wallet, chain): a new request supersedes the
-- pending one and starts a fresh delay (it can only push the change later).
--
--   id            — order of requests.
--   wallet        — lowercase 0x-hex.
--   chain_id      — the chain of the `user_thresholds` row.
--   kind          — 'unlink' (clear the chat) or 'replace' (link new_chat_id
--                   in place of old_chat_id).
--   old_chat_id   — the chat linked when the change was asked for: the one
--                   told, and the only one that may CANCEL.
--   new_chat_id   — the chat that takes over; NULL for an unlink.
--   requested_at  — unix seconds.
--   effective_at  — unix seconds; requested_at plus the account's delay.
--   state         — pending, applied, cancelled or superseded.
--   closed_at     — unix seconds when it left 'pending'; NULL while pending.
--
-- User intent, not chain data: kept across a fresh Diamond on the chain
-- (`apps/indexer/src/diamondEpochKeep.json`). Cleared on a restore, which
-- can only cancel a pending change and so keep the chat linked now (the safe
-- direction); the owner asks again.
CREATE TABLE IF NOT EXISTS alert_channel_changes (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  wallet        TEXT    NOT NULL,
  chain_id      INTEGER NOT NULL,
  kind          TEXT    NOT NULL CHECK (kind IN ('unlink', 'replace')),
  old_chat_id   TEXT    NOT NULL,
  new_chat_id   TEXT,
  requested_at  INTEGER NOT NULL,
  effective_at  INTEGER NOT NULL,
  state         TEXT    NOT NULL DEFAULT 'pending'
                CHECK (state IN ('pending', 'applied', 'cancelled', 'superseded')),
  closed_at     INTEGER
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_alert_channel_changes_one_pending
  ON alert_channel_changes (wallet, chain_id) WHERE state = 'pending';

CREATE INDEX IF NOT EXISTS idx_alert_channel_changes_due
  ON alert_channel_changes (state, effective_at);

CREATE INDEX IF NOT EXISTS idx_alert_channel_changes_old_chat
  ON alert_channel_changes (old_chat_id, state);
