-- #3721 / #3434 — owner alerts from the agent.
--
-- `owner_alert_cursor`: per chain, the last activity_events position (block,
-- log index) the agent's owner-alert pass handled. It walks the position
-- token's Approval / ApprovalForAll and the Diamond's VaultOutflow in chain
-- order. An empty table restarts at the newest event the indexer holds, so a
-- restore or a fresh Diamond never sends history as news.
--
-- `user_thresholds.notify_vault_outflow`: the owner's choice about vault
-- outflow alerts. 1 on, 0 off, NULL not chosen — and NOT CHOSEN means on
-- while the owner's protected mode is on, off otherwise (#3434).
--
-- Additive: a new table and a nullable column with no default.
CREATE TABLE IF NOT EXISTS owner_alert_cursor (
  chain_id      INTEGER PRIMARY KEY,
  block_number  INTEGER NOT NULL,
  log_index     INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);

ALTER TABLE user_thresholds ADD COLUMN notify_vault_outflow INTEGER;
