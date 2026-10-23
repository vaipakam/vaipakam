-- #2071 — publish the protocol-wide settings the configuration bundle does
-- not carry.
--
-- `protocol_config` holds the Diamond's `getProtocolConfigBundle` and
-- `getMasterFlags` tuples. The Protocol Console reports more settings than
-- those carry (the loan-admission health-factor floor, the oracle stack's
-- staleness and deviation limits, the reward reporting grace window, the
-- periodic-interest and numeraire switches, the automation switches, the
-- treasury). Each comes from its own single-output getter, read at the same
-- block as the tuples, and is stored already named:
--
--   knob_values_json — JSON object `{ "values": { <key>: <value> },
--                      "unreported": [<key>, ...] }`, where `unreported`
--                      lists the settings the chain did not answer. NULL
--                      when that read failed or the row predates it.
--
-- Additive: one NULLable column; the deployed code neither reads nor writes
-- it. Rows captured before this migration carry NULL, and the route then
-- serves no extra settings until the next capture writes them. Not
-- backfilled: the values must come from the block the row was read at.
ALTER TABLE protocol_config ADD COLUMN knob_values_json TEXT;

-- Codex #2683 r7 — when a scan sees a governance event the stored row
-- predates, the row is marked stale (`updated_at = 0`). This records the
-- block of that scan, so a reader knows how far a replacement read must
-- reach to include the event: a direct chain read from an earlier block
-- carries the same obsolete values. NULL when the row is not known to be
-- stale, or was marked before this column existed. Additive: the deployed
-- code neither reads nor writes it.
ALTER TABLE protocol_config ADD COLUMN stale_at_block INTEGER;
