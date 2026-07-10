-- 0032_rate_desk_phase2.sql — Rate Desk phase 2 (#1130): persisted loan
-- participation history + the executed-rate candle index.
--
-- 1. `loan_participants` — append-only participation rows backing the desk's
--    History tab (ProRateTerminalDesign.md §3 History row). The immutable
--    `loans.lender` / `loans.borrower` columns snapshot offer.creator +
--    acceptor at LoanInitiated (LoanFacet.sol:1169-1180) and the
--    `*_current_owner` columns are a MUTABLE pointer (a lender whose position
--    was repaid + claimed gets burned to 0x0 and disappears) — so neither can
--    answer "every loan this wallet ever participated in". This table can:
--    the chainIndexer appends a row whenever a wallet becomes a holder of a
--    loan position (LoanInitiated seed from the current-owner projection,
--    position-NFT Transfer, LoanSold / LoanSaleCompleted /
--    LoanObligationTransferred token-id migrations) and NEVER deletes or
--    updates one. Participation is history, not a pointer.
--
--    PK (chain_id, loan_id, wallet, role, from_at) doubles as the idempotency
--    constraint: re-scans / webhook replays / the backfill below all write
--    INSERT OR IGNORE, so a duplicate observation of the SAME acquisition
--    (same event → same block timestamp → same from_at) is a no-op, while a
--    wallet RE-acquiring a role it previously held (sold the position NFT,
--    bought it back later) appends a fresh row at the new timestamp — the
--    history's MAX(from_at) ordering then bubbles the reacquisition up
--    (Codex #1139 round-4: with from_at outside the PK the reacquisition
--    was silently dropped and the loan stayed sorted by the ORIGINAL
--    acquisition). Each row is one acquisition event; participation is
--    append-only history, never a mutable pointer. `from_at` is the block
--    timestamp at ingest (backfill approximates — see below). Wallets are
--    stored lowercase (repo convention, matches every other address column).
CREATE TABLE IF NOT EXISTS loan_participants (
  chain_id  INTEGER NOT NULL,
  loan_id   INTEGER NOT NULL,
  wallet    TEXT    NOT NULL,             -- lowercase 0x-40-hex
  role      TEXT    NOT NULL CHECK (role IN ('lender', 'borrower')),
  from_at   INTEGER NOT NULL,             -- unix seconds, this acquisition
  PRIMARY KEY (chain_id, loan_id, wallet, role, from_at)
);

-- Wallet lookups are the hot path (`/loans/by-participant`): the composite
-- (chain_id, wallet, loan_id) index serves both the participation filter AND
-- the `ORDER BY loan_id DESC` pagination in one scan.
CREATE INDEX IF NOT EXISTS idx_loan_participants_wallet
  ON loan_participants (chain_id, wallet, loan_id);

-- 2. Candle index — the phase-2 executed-rate candle endpoint
--    (`/loans/rate-candles`) range-scans one market's fills by start time:
--      WHERE chain_id = ? AND lending_asset = ? AND collateral_asset = ?
--        AND duration_days = ? AND start_at >= ?
--      ORDER BY start_at ASC
--    The key matches the market boundary exactly, `start_at` last so the
--    range predicate + ORDER BY ride the index tail (ProRateTerminalDesign.md
--    §7 "Migration" note — deliberately deferred out of 0029 to this slice).
CREATE INDEX IF NOT EXISTS idx_loans_market_start_at
  ON loans (chain_id, lending_asset, collateral_asset, duration_days, start_at);

-- 3. Backfill participation for loans indexed BEFORE this deploy — the ingest
--    cursor never replays old logs (same rationale as the 0030/0031
--    backfills), so without this every pre-migration loan would be invisible
--    to the History route.
--
--    Best-available sources:
--      a) The init/latest parties (`loans.lender` / `loans.borrower`). Note
--         these are not strictly immutable in D1: the LoanSold /
--         LoanSaleCompleted / LoanObligationTransferred handlers repoint them
--         to the buyer/new obligor — so for a migrated position this seeds
--         the LATEST party, and (b) below cannot recover the exited one.
--      b) The current-owner projection (`*_current_owner`) where it differs
--         from (a) — captures the current secondary-market holder. Burned
--         (0x0) and never-seeded ('') values are excluded: the zero address
--         is not a participant.
--
--    KNOWN LIMITATION: intermediate pre-migration transferees (wallet held
--    the position NFT for a while, sold it on, all before this migration
--    deployed) are unrecoverable — no table retained them. From this deploy
--    on, the chainIndexer's append path captures every holder.
--
--    `from_at` approximations: start_at for the init parties (correct for
--    the untransferred common case), updated_at for a differing current
--    owner (upper bound of when they acquired it). Both are values READ
--    FROM THE ROW (never strftime('now')), so within one migration apply
--    every statement is deterministic and INSERT OR IGNORE dedupes an
--    accidental re-run under the (…, from_at)-inclusive PK. (This
--    migration applies exactly once per environment via wrangler's
--    migrations ledger; a re-apply months later could see a moved
--    updated_at, but that path doesn't exist under the ledger.)
INSERT OR IGNORE INTO loan_participants (chain_id, loan_id, wallet, role, from_at)
SELECT chain_id, loan_id, lender, 'lender', start_at
  FROM loans
 WHERE lender LIKE '0x%' AND length(lender) = 42
   AND lender != '0x0000000000000000000000000000000000000000';

INSERT OR IGNORE INTO loan_participants (chain_id, loan_id, wallet, role, from_at)
SELECT chain_id, loan_id, borrower, 'borrower', start_at
  FROM loans
 WHERE borrower LIKE '0x%' AND length(borrower) = 42
   AND borrower != '0x0000000000000000000000000000000000000000';

INSERT OR IGNORE INTO loan_participants (chain_id, loan_id, wallet, role, from_at)
SELECT chain_id, loan_id, lender_current_owner, 'lender', updated_at
  FROM loans
 WHERE lender_current_owner LIKE '0x%' AND length(lender_current_owner) = 42
   AND lender_current_owner != '0x0000000000000000000000000000000000000000'
   AND lender_current_owner != lender;

INSERT OR IGNORE INTO loan_participants (chain_id, loan_id, wallet, role, from_at)
SELECT chain_id, loan_id, borrower_current_owner, 'borrower', updated_at
  FROM loans
 WHERE borrower_current_owner LIKE '0x%' AND length(borrower_current_owner) = 42
   AND borrower_current_owner != '0x0000000000000000000000000000000000000000'
   AND borrower_current_owner != borrower;
