## T-086 #309 Block B — Codex post-merge findings (4 × P2)

Pure polish PR addressing four P2 issues Codex flagged on the
merged Block B PR #326. No new features; no new selectors; no
behavioural change to the happy paths.

### What this PR fixes

**P2 #1 — Indexer's Dutch publish reconstruction reads governance
config at the wrong block.** The `getPrepayContext(loanId,
asOfTimestamp)` view's `asOfTimestamp` parameter affects the live-
floor interest-accrual math but NOT the governance config the
floor formula reads from storage (`cfgTreasuryFeeBps` etc.). Before
this PR, the autonomous OpenSea publish's `readContract` call ran
against latest chain state, so a mid-window `setFeesConfig` bump
between the post tx and indexer ingest would shift the projected
lender + treasury legs the JS reconstruction computes — the
defensive `expectedOrderHash` compare would fail and the publish
would skip even though the on-chain order is still validly signed
+ fillable. Fix: pin the eth_call to the post-tx's block number
(`blockNumber: receipt.blockNumber`). Applied to the pctx read, the
executor `seaport()` read, and the vault `getCounter(vault)` read
— all three feed the canonical-shape reconstruction and all three
should observe sign-time state.

**P2 #2 — Permissionless cleanup must allow Dutch listings to be
cleaned up at `auctionEndTime`, not `gracePeriodEnd`.** Dutch
listings have a Seaport `endTime` of `auctionEndTime` which the
facet enforces is `≤ gracePeriodEnd`. Past `auctionEndTime`,
Seaport rejects all fills — the order is functionally dead — but
the existing `cancelExpiredPrepayListing` guard only opened the
cleanup window at `block.timestamp > gracePeriodEnd`. For any
Dutch auction that closes hours or days before grace + a borrower
who's offline, the borrower-position NFT would sit locked even
though the listing was already unfillable. Fix: read the recorded
`mode` + `auctionEndTime` from the executor's `OrderContext` and
gate cleanup on `(mode == DUTCH ? auctionEndTime : gracePeriodEnd)`.
New revert `AuctionWindowStillOpen(loanId, nowTime, auctionEndTime)`
for the Dutch-too-early case. Fixed-price listings keep their
existing `GraceNotExpired` semantics verbatim. Mock recorder
extended with a `setOrderContextMode` test-side hook so unit tests
can stamp the Dutch shape without standing up the real executor;
new integration test
`test_cancelExpiredPrepayListing_dutchPathAtAuctionEnd` covers the
happy + revert paths.

**P2 #3 — Document the legacy-event-shape pre-live posture.**
Block B's event extension rotated the `PrepayListingPosted` /
`PrepayListingUpdated` topic hashes. The indexer's decoder derives
its allowlist from the current ABI; a redeployment whose cursor
crosses a pre-Block-B emission would silently skip the old log.
The Vaipakam platform is **pre-live** on every chain, so no
production emissions persist; the only legacy events live on
short-lived testnet rehearsals that the indexer is redeployed
against with a fresh cursor at the new diamond's deploy block. A
legacy-ABI fallback decoder was considered + rejected as
unnecessary for the pre-live case + a footgun (would silently mask
any future event shape regression). The event natspec now states
this posture so future readers don't ship a legacy-ABI fallback by
default.

**P2 #4 — Sweep starvation by expired Dutch rows.** The
`PrepayListingPostsSweep` cron query selects rows with
`opensea_published_at IS NULL` ordered by `posted_at ASC, LIMIT 5`.
A Dutch row whose `auctionEndTime` has passed is rejected by
OpenSea on every publish attempt (the Seaport order is expired),
so the row stays NULL forever and occupies one of the five batch
slots on every cron tick — newer publishable listings stay starved
behind it. Fix: extend the WHERE clause to filter
`(auction_mode IS NULL OR auction_mode != 1 OR auction_end_time
IS NULL OR auction_end_time > strftime('%s','now'))`. Fixed-price
rows + pre-Block-B rows (NULL columns) are unaffected.

### What's NOT in this PR

- **Legacy-ABI fallback decoder for the indexer** — the pre-live
  framing makes this unnecessary + adds the silent-skip footgun
  noted under P2 #3 above.
- **Persist projected lender + treasury legs in `OrderContext`**
  (the alternative for P2 #1's governance-drift case) — design
  doc §15.2 explicitly rejected this in the "Alternative
  considered + rejected" box because the fee-curve-decrease case
  would let frozen-shape orders keep filling at above-current-
  policy treasury take. The block-pin fix solves the indexer
  side without the on-chain trade-off.

### Verification

- Full forge cifast regression: **122/122 PASS** (+1 vs Block B
  post-merge baseline — the new Dutch-expiry integration test).
- `apps/defi` typecheck: green.
- `apps/indexer` typecheck: green.
- `apps/agent` typecheck: green.
- `apps/keeper` typecheck: green.
- No new selectors, no facet bytecode bumps, no ABI re-export
  needed beyond the recorder mock's new helper (test-side only,
  not part of the production diamond ABI).

### Closes

Codex's 4 post-merge P2 findings on PR #326 (linked via inline
review at https://github.com/vaipakam/vaipakam/pull/326).

### Related

- Block B: #326 (merged `b0aa7058`).
- Block A: #324 (merged `1bd9e472`).
- Round 5 design + Round 5.1 errata: #322 + #323.
- Pre-live framing: `memory/project_platform_prelive.md`.
