-- #1722 — the Telegram links, handshake codes, pending chat removals and LOCK
-- requests moved out of the shared database into the agent's own Durable
-- Object (`apps/agent/src/telegramState/`), which no other Worker's binding
-- can write. The shared copies are emptied here rather than copied across.
--
-- Why emptied, not left: an owner who unlinks a chat now unlinks it in the
-- object, and nothing clears the shared `tg_chat_id` any more. A chat left
-- here would keep receiving the keeper's alerts after its owner removed it.
-- Emptying fails toward no message, never toward a message to a removed chat.
--
-- Why not copied: the platform is pre-live and only testnets carry links.
-- Owners link Telegram again from the app. A link made in the minutes
-- between this migration and the new agent going live lands here, under the
-- old code, and is lost the same way; the owner links again.
--
-- What goes dark until the keeper is moved onto the agent's routes: the
-- keeper's own Telegram sends (health-factor bands, pre-grace warnings, LOCK
-- answers and protected-vault alerts) find no chat here and send nothing on
-- Telegram. Push is unaffected. A LOCK sent meanwhile is not recorded, and
-- the agent tells the owner to lock from the app, because no keeper polls it.
--
-- Data-only and additive: the tables and the column stay (a following
-- release drops them once nothing reads them).
UPDATE user_thresholds SET tg_chat_id = NULL WHERE tg_chat_id IS NOT NULL;
DELETE FROM telegram_links;
DELETE FROM alert_channel_changes;
DELETE FROM protected_lock_requests;
