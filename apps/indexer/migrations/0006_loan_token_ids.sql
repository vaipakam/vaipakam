-- T-041 Phase C-alt — capture position-NFT token IDs on the loans
-- table so the worker can ask the chain "who currently holds these
-- NFTs?" via multicall(ownerOf,…) at query time.
--
-- Why columns instead of a separate `nft_positions` table: ownership
-- changes over time but the (loan_id → lender_token_id, borrower_token_id)
-- mapping is immutable from LoanInitiated forward. We bootstrap these
-- once per loan (via getLoanDetails RPC at LoanInitiated event time)
-- and never write them again. The "who currently owns this NFT?"
-- question goes to the chain at query time — no maintenance, always
-- live, no re-org window.
--
-- Trade-off accepted: by-lender / by-borrower / claimables endpoints
-- now fan out a multicall(ownerOf) per request, costing one RPC
-- round trip. ownerOf is a single SLOAD against the current state
-- root — cost is flat regardless of chain history depth (unlike the
-- eth_getLogs we're trying to retire from browsers).

ALTER TABLE loans ADD COLUMN lender_token_id TEXT NOT NULL DEFAULT '0';
ALTER TABLE loans ADD COLUMN borrower_token_id TEXT NOT NULL DEFAULT '0';
-- Captured at the same getLoanDetails bootstrap so the loans table
-- carries every field Dashboard / LoanDetails render. Both immutable
-- after LoanInitiated (interest rate stamped at acceptance, start time
-- stamped at init). Stored as integers — interest rate is small uint,
-- start time is unix-seconds.
ALTER TABLE loans ADD COLUMN interest_rate_bps INTEGER NOT NULL DEFAULT 0;
ALTER TABLE loans ADD COLUMN start_time INTEGER NOT NULL DEFAULT 0;
-- Whether the lender opted in to borrower-initiated partial repay
-- (snapshot from Offer.allowsPartialRepay at acceptance; immutable).
-- 0/1 boolean — same SQLite-friendly encoding the offers table uses.
ALTER TABLE loans ADD COLUMN allows_partial_repay INTEGER NOT NULL DEFAULT 0;
