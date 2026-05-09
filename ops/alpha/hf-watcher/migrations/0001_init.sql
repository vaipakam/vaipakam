-- Phase 8a.3 — HF alerts schema.
--
-- Three tables:
--   user_thresholds  : per-user per-chain alert configuration
--   notify_state     : idempotency + hysteresis bookkeeping per loan
--   telegram_links   : Telegram handle linking flow (handshake codes)
--
-- All wallet / address columns are stored lowercased `0x…` hex.

CREATE TABLE IF NOT EXISTS user_thresholds (
  wallet         TEXT NOT NULL,      -- lowercase 0x-hex
  chain_id       INTEGER NOT NULL,   -- EVM chain id (e.g. 8453 for Base)
  warn_hf        REAL NOT NULL,      -- default 1.5 — first ping
  alert_hf       REAL NOT NULL,      -- default 1.2 — heightened
  critical_hf    REAL NOT NULL,      -- default 1.05 — imminent liquidation
  tg_chat_id     TEXT,               -- Telegram chat id once linked; null → no TG rail
  push_channel   TEXT,               -- 'subscribed' when user signed the Push opt-in; null → no Push rail
  created_at     INTEGER NOT NULL,   -- unix seconds
  updated_at     INTEGER NOT NULL,
  PRIMARY KEY (wallet, chain_id)
);

-- Idempotency + hysteresis: remember the last band each loan crossed
-- plus the timestamp, so a cron that polls every 5 min doesn't re-send
-- the same alert 12 times per hour. Bands map to thresholds:
--   'healthy'  = HF > warn_hf
--   'warn'     = alert_hf < HF <= warn_hf
--   'alert'    = critical_hf < HF <= alert_hf
--   'critical' = HF <= critical_hf
-- Alert fires only on band change, and only when dropping to a worse
-- band. Recovery alerts (climbing back to healthy) are optional —
-- enabled via `notify_recovery` column on the thresholds row if the
-- user turns them on.
CREATE TABLE IF NOT EXISTS notify_state (
  wallet         TEXT NOT NULL,
  chain_id       INTEGER NOT NULL,
  loan_id        INTEGER NOT NULL,
  last_band      TEXT NOT NULL DEFAULT 'healthy',
  last_hf_milli  INTEGER NOT NULL DEFAULT 0,    -- HF * 1000, last observed
  last_sent_ts   INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (wallet, chain_id, loan_id),
  FOREIGN KEY (wallet, chain_id) REFERENCES user_thresholds(wallet, chain_id) ON DELETE CASCADE
);

-- Telegram handshake: the user pastes their @handle on the Settings
-- page; we insert a row with a 6-digit code and a 10-minute expiry.
-- User DMs the code to the bot; the bot validates it, writes the
-- user's `chat_id` back onto `user_thresholds.tg_chat_id`, and deletes
-- the row. Prevents handle squatting — only whoever controls the
-- Telegram account can complete the link.
CREATE TABLE IF NOT EXISTS telegram_links (
  code           TEXT PRIMARY KEY,   -- 6-digit numeric code
  wallet         TEXT NOT NULL,      -- wallet that initiated the link
  chain_id       INTEGER NOT NULL,
  expires_at     INTEGER NOT NULL    -- unix seconds
);

CREATE INDEX IF NOT EXISTS idx_notify_state_chain ON notify_state(chain_id);
CREATE INDEX IF NOT EXISTS idx_telegram_links_exp ON telegram_links(expires_at);
