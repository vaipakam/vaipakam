-- UX-012 / Codex #1175: replay protection for the agent's
-- POST /telegram/test endpoint. A signed test-alert body is valid for
-- the full ±600s signature window and (unlike link/unlink, which are
-- idempotent state writes) each call sends a real Telegram message, so
-- a copied body or a buggy retry loop could spam the linked chat. This
-- per-wallet timestamp lets the handler enforce a short cooldown
-- between test sends. DEFAULT 0 means "never sent" — the first test is
-- always allowed. Written only by apps/agent (handleTestTelegram); the
-- cron/read paths ignore it.
ALTER TABLE user_thresholds ADD COLUMN last_test_alert_at INTEGER NOT NULL DEFAULT 0;
