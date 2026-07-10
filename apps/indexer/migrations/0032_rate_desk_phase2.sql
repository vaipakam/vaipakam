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

-- 2. Immutable initiation-term snapshot (Codex #1139 round-5 P2). The
--    candle endpoint reconstructs EXECUTED fills, and a fill's terms are
--    immutable history — but the loans row is a MUTABLE projection:
--    PartialRepaid / SwapToRepayPartialExecuted / InternalMatchExecuted
--    rewrite `principal`, and LoanExtended rewrites `interest_rate_bps` +
--    `duration_days` in place (see the matching handlers in
--    chainIndexer.ts). Without a snapshot, a partial repay retroactively
--    shrinks the chart's executed volume and an extended 30d loan
--    teleports into the 60d market at its original start_at. The
--    chainIndexer stamps these at every LoanInitiated insert path (same
--    values as the mutable columns at insert time) and NO mutation
--    handler ever touches them. NULL — not 0 — when unknown, so the read
--    side can COALESCE to the mutable column for any row written by a
--    pre-snapshot worker between this migration's apply and the worker
--    deploy.
--
--    Plain ALTER TABLE ADD COLUMN is the repo's 0006/0012/0029 idiom: it
--    is NOT re-apply-safe on its own (SQLite has no ADD COLUMN IF NOT
--    EXISTS) and relies on wrangler's migrations ledger applying each
--    file exactly once — the same contract every prior column-add
--    migration in this directory rides. Every OTHER statement in this
--    file stays independently idempotent.
ALTER TABLE loans ADD COLUMN init_principal TEXT;
ALTER TABLE loans ADD COLUMN init_rate_bps INTEGER;
ALTER TABLE loans ADD COLUMN init_duration_days INTEGER;

-- 3. Candle index — the phase-2 executed-rate candle endpoint
--    (`/loans/rate-candles`) range-scans one market's fills by start time:
--      WHERE chain_id = ? AND lending_asset = ? AND collateral_asset = ?
--        AND COALESCE(init_duration_days, duration_days) = ?
--        AND start_at >= ?
--      ORDER BY start_at ASC
--    The key matches the market boundary exactly, `start_at` last so the
--    range predicate + ORDER BY ride the index tail (ProRateTerminalDesign.md
--    §7 "Migration" note — deliberately deferred out of 0029 to this slice).
--
--    The tenor key is the COALESCE EXPRESSION, not the bare column: market
--    scoping must use the INIT duration (an extended loan's fill stays in
--    the market it executed in — Codex #1139 round-5 P2), falling back to
--    the mutable column only for rows whose snapshot is NULL (written by a
--    pre-snapshot worker in the migration→deploy window; the backfill
--    below fills every row that exists at apply time). SQLite matches
--    expression indexes TEXTUALLY, and the candle SQL in loanRoutes.ts
--    spells the identical expression, so the equality + range predicates
--    ride this index. Correct first, fast second: correctness never
--    depends on the planner taking it — a miss still answers via the
--    (chain_id, lending_asset, collateral_asset) prefix + post-filter,
--    just slower. (An index on the bare `duration_days` was rejected: the
--    query MUST filter on the init tenor, and a bare-column index cannot
--    serve that equality at all once a loan has been extended.)
CREATE INDEX IF NOT EXISTS idx_loans_market_start_at
  ON loans (chain_id, lending_asset, collateral_asset,
            COALESCE(init_duration_days, duration_days), start_at);

-- 4. Backfill participation for loans indexed BEFORE this deploy — the ingest
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

-- 5. Backfill the init_* snapshot (section 2) for loans indexed BEFORE
--    this deploy.
--
--    Preferred source — the append-only activity ledger, which preserved
--    the ORIGINAL event payloads even for loans whose mutable columns
--    have since been rewritten:
--      a) `LoanInitiated` rows carry the executed principal in args_json
--         ("principal": "<decimal string>" — serializeArgs coerces
--         bigints to decimal strings, matching the TEXT column) and land
--         with loan_id denormalized (pluckActivityRefs has a case).
--      b) `LoanInitiatedDetails` rows carry interestRateBps +
--         durationDays inside args_json's nested `details` tuple, but
--         land with loan_id NULL (no pluckActivityRefs case — same shape
--         0030 handled for LoanSaleOfferLinked), so the correlated
--         lookup extracts + CASTs `$.loanId` from the JSON itself. Cost
--         is O(loans × per-chain details rows) json_extracts via the
--         (chain_id, kind) prefix of idx_activity_chain_kind — a
--         one-shot migration cost, acceptable at this archive's scale.
--
--    A reorg-replayed duplicate event lands as a second ledger row with
--    identical args, so `ORDER BY block_number, log_index LIMIT 1` is
--    deterministic AND value-stable across duplicates.
--
--    Fallback — the current mutable column values. BEST-EFFORT
--    LIMITATION: a pre-migration loan with no usable ledger row (it
--    predates the details companion event, or the principal arg is
--    absent) that was ALSO already mutated (partial-repaid principal,
--    extended rate/duration) cannot be reconstructed and inherits
--    today's values; its historical fill stays wrong exactly as far as
--    it already was pre-migration, and every loan from this deploy on is
--    stamped exactly at insert.
--
--    Idempotent: every UPDATE is guarded `WHERE init_* IS NULL`, so a
--    re-run never overwrites a previously-stamped snapshot.
UPDATE loans
   SET init_principal = (
     SELECT json_extract(ae.args_json, '$.principal')
       FROM activity_events ae
      WHERE ae.chain_id = loans.chain_id
        AND ae.loan_id  = loans.loan_id
        AND ae.kind = 'LoanInitiated'
        AND json_extract(ae.args_json, '$.principal') IS NOT NULL
      ORDER BY ae.block_number ASC, ae.log_index ASC
      LIMIT 1)
 WHERE init_principal IS NULL;

UPDATE loans
   SET init_rate_bps = (
     SELECT CAST(json_extract(ae.args_json, '$.details.interestRateBps') AS INTEGER)
       FROM activity_events ae
      WHERE ae.chain_id = loans.chain_id
        AND ae.kind = 'LoanInitiatedDetails'
        AND CAST(json_extract(ae.args_json, '$.loanId') AS INTEGER) = loans.loan_id
        AND json_extract(ae.args_json, '$.details.interestRateBps') IS NOT NULL
      ORDER BY ae.block_number ASC, ae.log_index ASC
      LIMIT 1)
 WHERE init_rate_bps IS NULL;

UPDATE loans
   SET init_duration_days = (
     SELECT CAST(json_extract(ae.args_json, '$.details.durationDays') AS INTEGER)
       FROM activity_events ae
      WHERE ae.chain_id = loans.chain_id
        AND ae.kind = 'LoanInitiatedDetails'
        AND CAST(json_extract(ae.args_json, '$.loanId') AS INTEGER) = loans.loan_id
        AND json_extract(ae.args_json, '$.details.durationDays') IS NOT NULL
      ORDER BY ae.block_number ASC, ae.log_index ASC
      LIMIT 1)
 WHERE init_duration_days IS NULL;

-- Fallback to the current mutable values (see the limitation note above).
UPDATE loans SET init_principal     = principal         WHERE init_principal     IS NULL;
UPDATE loans SET init_rate_bps      = interest_rate_bps WHERE init_rate_bps      IS NULL;
UPDATE loans SET init_duration_days = duration_days     WHERE init_duration_days IS NULL;
