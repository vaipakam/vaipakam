-- #3879 — the two parties named in a loan's opening event, kept with the
-- loan row.
--
-- The counting rule for public figures (ProjectKitDesign.md section 8,
-- guard 1) leaves a loan whose lender and borrower were the same address
-- out of rate figures and counts it on its own line. "The same address"
-- is judged on the two parties the opening event names (`LoanInitiated`'s
-- `lender` and `borrower`), and on nothing later: a sale of either side or
-- a handover moves a loan neither in nor out. `loans.lender` /
-- `loans.borrower` cannot answer this, because a sale or a handover
-- rewrites them; `loan_participants` cannot either, because it records the
-- position HOLDERS at opening (an offer token sold before the accept names
-- its buyer there), not the event's parties.
--
-- Both columns are written once, by the insert that creates the row, and
-- never updated: like the other `init_*` columns they are history, not
-- state. NULL means the parties are not known; a loan with NULL parties is
-- left out of rate figures too and counted as "opening parties unknown",
-- never assumed to have two parties.
-- Stored lowercase (repo convention).
ALTER TABLE loans ADD COLUMN init_lender TEXT;
ALTER TABLE loans ADD COLUMN init_borrower TEXT;

-- The rate candles count the loans the rule leaves out per market beside
-- the candles, capped. Without an index that names the rule, that count
-- reads every loan of the market in range to find the few that qualify;
-- this partial index holds only the left-out loans, in the candle index's
-- order, so the count visits only those. Its WHERE is the rule's SQL
-- exactly (figureRules.ts, leftOutOfRatesSql), which is what lets SQLite
-- use it.
CREATE INDEX IF NOT EXISTS idx_loans_rates_left_out_tenor_start_at
  ON loans (chain_id, lending_asset, collateral_asset, init_duration_days, start_at)
  WHERE init_lender IS NULL OR init_borrower IS NULL OR init_lender = init_borrower;

-- The candles themselves read only loans with two known, different opening
-- parties. The placement index cannot skip left-out loans, so a market
-- full of them would make the capped candle read walk its whole history;
-- this partial index holds only the eligible, placed loans. Its WHERE is
-- the placement rule's flag plus the rule's terms exactly
-- (figureRules.ts, ratesEligibleSql).
CREATE INDEX IF NOT EXISTS idx_loans_rates_eligible_tenor_start_at
  ON loans (chain_id, lending_asset, collateral_asset, init_duration_days, start_at)
  WHERE init_terms_unbacked = 0
    AND init_lender IS NOT NULL AND init_borrower IS NOT NULL
    AND init_lender <> init_borrower;

-- The pass-by-pass repair below looks only at rows still missing their
-- parties; this index keeps that read to those rows.
CREATE INDEX IF NOT EXISTS idx_loans_opening_parties_unknown
  ON loans (chain_id, loan_id)
  WHERE init_lender IS NULL;

-- Existing rows: the parties of the loan's own `LoanInitiated` record in
-- the activity ledger, where there is one. A row with no ledger record
-- stays NULL, as above. Rows the previous Worker writes after this
-- migration and before the new one is published are filled by the same
-- read on every pass (chainIndexer.ts, repairOpeningParties).
UPDATE loans
   SET init_lender = (
         SELECT LOWER(json_extract(ae.args_json, '$.lender'))
           FROM activity_events ae
          WHERE ae.chain_id = loans.chain_id
            AND ae.loan_id = loans.loan_id
            AND ae.kind = 'LoanInitiated'
          ORDER BY ae.block_number, ae.log_index
          LIMIT 1),
       init_borrower = (
         SELECT LOWER(json_extract(ae.args_json, '$.borrower'))
           FROM activity_events ae
          WHERE ae.chain_id = loans.chain_id
            AND ae.loan_id = loans.loan_id
            AND ae.kind = 'LoanInitiated'
          ORDER BY ae.block_number, ae.log_index
          LIMIT 1)
 WHERE init_lender IS NULL;
