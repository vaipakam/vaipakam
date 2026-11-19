-- #3572 — retire the shared Telegram tables #1722 emptied.
--
-- WHY. #1722 (PR #3571) moved every Telegram link, handshake code, pending
-- alert-chat change and Telegram LOCK request into the agent's own Durable
-- Object (`apps/agent/src/telegramState/`). Migration 0091 emptied the shared
-- copies but kept them for one release, because the keeper then serving still
-- read and swept them.
--
-- SAFE AGAINST THE DEPLOYED CODE. The keeper reaches Telegram only through the
-- agent's `/keeper/*` routes since its port, and the keeper release the
-- always-on machine runs names none of these tables or the column; neither do
-- the agent, the indexer or any other Worker. The nightly archive and the
-- restore converter stop listing them in the same change.
--
-- `tg_chat_id` carries no index or constraint, so the column drop is a plain
-- one. 0001, 0083, 0084 and 0091 are applied and stay as they are, so a fresh
-- database still creates these and then drops them here.
DROP TABLE IF EXISTS telegram_links;
DROP TABLE IF EXISTS alert_channel_changes;
DROP TABLE IF EXISTS protected_lock_requests;
DROP TABLE IF EXISTS protected_lock_readiness;
ALTER TABLE user_thresholds DROP COLUMN tg_chat_id;
