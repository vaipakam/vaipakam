-- 0114_slot_history_indexes.sql — the reads behind an Auto-lend slot's
-- history card (`GET /loans/slot-history`, src/slotHistoryRoute.ts).
--
-- The route picks one slot's rows out of the decoded-event ledger by the
-- owner inside `args_json`: its set / cancel events (the slot's terms) and
-- its `SlotLedgerSet` moves (the slot's live principal and unlent capital
-- after each move). With the owner only inside the JSON, the planner's best
-- would be `idx_activity_chain_kind`, every such row of the chain per
-- request. Two partial expression indexes on exactly the expression the
-- route compares make each read one probe; partial on the kinds so they
-- cover only these rows.
--
-- Additive: two indexes, no table or column change; the deployed code never
-- reads them, and `IF NOT EXISTS` makes a re-run harmless.
CREATE INDEX IF NOT EXISTS idx_activity_slot_terms_owner
  ON activity_events(chain_id, lower(json_extract(args_json, '$.owner')), block_number DESC, log_index DESC)
  WHERE kind IN ('LenderIntentSet', 'LenderIntentCancelled');

CREATE INDEX IF NOT EXISTS idx_activity_slot_ledger_owner
  ON activity_events(chain_id, lower(json_extract(args_json, '$.owner')), block_number DESC, log_index DESC)
  WHERE kind = 'SlotLedgerSet';
