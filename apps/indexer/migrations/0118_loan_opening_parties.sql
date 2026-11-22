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
-- not left out, since it cannot be shown to have one address on both sides.
-- Stored lowercase (repo convention).
ALTER TABLE loans ADD COLUMN init_lender TEXT;
ALTER TABLE loans ADD COLUMN init_borrower TEXT;

-- Existing rows: the parties of the loan's own `LoanInitiated` record in
-- the activity ledger, where there is one. A row with no ledger record
-- stays NULL, as above.
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
