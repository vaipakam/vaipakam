-- #3180 — the wallet's unread count (the Alerts bell in the new app).
-- `GET /notifications/<addr>?newerThan=<id>` counts the wallet's rows whose
-- id is above the newest one the reader has seen, and reads the wallet's
-- newest id. Ids grow in write order, which the chain order of the feed does
-- not follow, so the count is taken by id. The feed index orders by
-- (block_number, log_index, id), so neither `id > ?` nor `MAX(id)` could use
-- it and every poll scanned the wallet's whole history. This index lets both
-- read only the rows above the seen id and the last entry.
--
-- Additive: a new index on an existing table, safe while the previous
-- Workers are still serving.
CREATE INDEX IF NOT EXISTS idx_notifications_recipient_id
  ON notifications(chain_id, recipient, id);
