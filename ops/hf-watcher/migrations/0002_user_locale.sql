-- Phase 3b — Backend / contract event copy translation.
--
-- Adds a per-user `locale` column to `user_thresholds` so the
-- Telegram and Push notification text can be sent in the language
-- the user reads. Defaults to 'en' for existing rows; the frontend
-- writes the active locale at the time the user enables Telegram
-- or Push, and re-writes on every threshold-update.
--
-- Stored as a 2-letter ISO 639-1 code (`en`, `es`, `fr`, `de`, `ja`,
-- `zh`, `ko`, `hi`, `ta`, `ar`). Unknown codes fall back to 'en' at
-- send-time, so a corrupted column never silently drops alerts.

ALTER TABLE user_thresholds ADD COLUMN locale TEXT NOT NULL DEFAULT 'en';
