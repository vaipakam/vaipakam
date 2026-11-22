-- #3778 — an index over the loan a companion statement names in its payload.
--
-- Some activity rows are filed with no `loan_id`: the companion statements
-- `LoanInterestPaid`, `LoanInterestUndelivered` and `LoanInitiatedDetails`,
-- whose primary event in the same transaction carries the loan reference
-- (`packages/lib/src/activityRefsPolicy.json`, notScoped). The repayment
-- record reads them for one address's loans by the payload's `loanId`, and
-- without an index that read scans every such row on the chain.
--
-- A partial expression index over exactly those rows. The repayment record's
-- query repeats the expression and the index's conditions byte for byte; SQLite uses an expression index only for an identical expression.
-- The index takes only rows whose payload is valid JSON, so an insert of a
-- malformed payload is never refused because of it (json_extract would
-- raise on one); the record's query repeats that condition too.
-- Additive: a new index, no table or column change.
CREATE INDEX IF NOT EXISTS idx_activity_payload_loan
  ON activity_events (chain_id, CAST(json_extract(args_json, '$.loanId') AS INTEGER))
  WHERE loan_id IS NULL AND json_valid(args_json);
