## T-086 step 12 — indexer handlers + `prepay_listings` D1 table

Closes the indexer-side gap left by step 6 (PR #300): the four
prepay-listing events (`PrepayListingPosted` / `Updated` /
`Canceled` / `PrepayCollateralSaleSettled`) were allowlisted as
"TEMPORARY — step 12 will land the handler" in the indexer's
event-coverage script. This PR removes those four allowlist
entries and ships the actual handlers + persistence table.

### What this PR ships

**New D1 migration `0015_prepay_listings.sql`:**

- Table `prepay_listings` — one row per LIVE listing per loan
  (composite PK `(chain_id, loan_id)` since at most one listing
  per loan is live at a time — the facet enforces this).
- Columns capture the listing payload (order_hash, ask_price,
  conduit, executor, lister), chain-time anchors (posted_at,
  updated_at, grace_period_end), and per-row provenance
  (block_number, tx_hash, log_index).
- Two secondary indexes: `idx_prepay_listings_order_hash`
  (reverse lookup for cancel events that carry orderHash) and
  `idx_prepay_listings_lister` (frontend "my listings" view).

**Four new handlers in `chainIndexer.ts`:**

- `PrepayListingPosted` — `INSERT OR REPLACE` a row, resolving
  `grace_period_end` from the loan's `start_time +
  duration_days × 86_400 + default-grace`. The grace value
  isn't carried in the event payload; we read from `loans`
  (already populated by the time PrepayListingPosted fires
  per the contract's `loan.status == Active` precondition).
- `PrepayListingUpdated` — `UPDATE` the existing row with the
  new orderHash + ask + conduit + lister + tx provenance,
  keyed on `(chain_id, loan_id)`.
- `PrepayListingCanceled` — `DELETE` the row. Loan stays
  Active (a cancel doesn't close the loan; a subsequent
  terminal event will).
- `PrepayCollateralSaleSettled` — `DELETE` the row AND flip
  `loans.status` from `active` → `repaid` (proper-close path,
  same status the regular RepayFacet terminal uses; the
  subsequent `LoanSettled` event flips `repaid` → `settled`
  once both sides have claimed).

**Event-coverage script cleanup:**

The four `TEMPORARY` allowlist entries for the prepay events
are removed from `apps/indexer/scripts/check-event-coverage.mjs`'s
`DELIBERATELY_NOT_HANDLED` map. Coverage now reports
**26 handled / 15 allowlisted** (was 22 / 19).

### Tests + verification

- `pnpm --filter @vaipakam/indexer exec tsc -p . --noEmit` —
  clean.
- `pnpm --filter @vaipakam/indexer check-event-coverage` —
  passes; the script now requires the four prepay events to
  be handled (which they are).
- D1 migration: applies cleanly to a fresh database
  (constraints + indexes idempotent via `CREATE TABLE IF NOT
  EXISTS` + `CREATE INDEX IF NOT EXISTS`).

### Operator action post-merge

Apply the new migration to the live staging D1:

```bash
cd apps/indexer
wrangler d1 migrations apply vaipakam-archive --remote
```

The migration only adds a new table + indexes — no existing
data is touched. Safe to apply during normal traffic; the
indexer's next scan window will start populating the table.

### Out of scope (still deferred)

- **Frontend UI consuming `prepay_listings`** — step 13. The
  table is ready; the React surface ("your loan has a live
  listing" banner + cancel CTA + listings browser) lands in
  the frontend PR.
- **OpenSea API integration** — step 14.
- **ERC1155 collateral** — step 15.

### Why this PR doesn't add a `prepay_listed` loan status

Considered + rejected. A loan with an active prepay listing IS
still `active` — the listing is a SEPARATE state machine that
can be cancelled out of without closing the loan. Conflating
the two would force every "is this loan still open?" query to
do `status IN ('active', 'prepay_listed')` instead of just
`status = 'active'`. The new `prepay_listings` table is a
separate join target the frontend can `LEFT JOIN` for the
"this loan has a listing" UI without changing the loan-status
semantic.
