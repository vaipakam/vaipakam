-- #2753 — one-time use of a signed alert request.
--
-- The agent's alert routes (save settings, link and unlink Telegram, send a
-- test alert) each take a wallet signature over a message that names the
-- action and when it was made. The signature proves the wallet asked; the
-- timestamp bounds how long the request may be presented. Neither stopped
-- the same request from being presented again inside that window, so a
-- captured request could be replayed as often as the caller liked.
--
-- The agent now records each request it accepts here, keyed by the SHA-256
-- of the exact message the wallet signed, and refuses a second presentation.
--
--   message_sha256 — hex SHA-256 of the signed message. Not the message: the
--                    row carries no wallet, chain or settings.
--   expires_at     — unix seconds after which the request could no longer
--                    pass the agent's age check (plus a small margin), so the
--                    row may go. The agent drops expired rows in the same
--                    batch as each claim; nothing else writes the table.
--
-- Additive: a new table the deployed agent does not read. Until the agent
-- that uses it ships, nothing writes it; once it has, a deployment whose
-- schema lacks it refuses alert writes (503) rather than accepting them
-- unrecorded. It carries no chain_id, so a Diamond change does not reset it.
CREATE TABLE IF NOT EXISTS signed_request_use (
  message_sha256 TEXT PRIMARY KEY,
  expires_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_signed_request_use_expires ON signed_request_use(expires_at);
