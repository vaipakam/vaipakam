## T-086 step 10 — default-flow lock-bypass

Builds on step 7 (#302). Resolves the deadlock that would otherwise
arise if a borrower's loan reaches default / liquidation while they
have an active Seaport prepay listing — the borrower-position NFT
is locked, and without step 10 the default-flow facets would
either fail outright (the strict `LibERC721._lock` overwrite-guard
from step 6 round 2 blocks re-locking under a different reason) or
leave stale orderHash bindings on the executor + vault that future
governance rotations could resurrect.

### What this PR ships

**New library `LibPrepayCleanup`** with one `internal` function:

- `clearActiveListing(loan, loanId)` — idempotent sweep. When a
  listing is live, atomically:
  1. Clears the diamond's per-loan `prepayListingOrderHash` +
     `prepayListingExecutor` mappings.
  2. Releases the `PrepayCollateralListing` lock on the
     borrower-position NFT (`LibERC721._unlock`).
  3. Tells the pinned executor to clear its `orderContext`.
  4. Tells the borrower's vault to revoke the conduit's per-token
     approval AND the orderHash → executor binding.
  No-op when no listing is live (early-return on zero orderHash).

**Wired into 3 terminal liquidation paths:**

- `DefaultedFacet.triggerDefault` — invokes `clearActiveListing`
  immediately after the `loan.status == Active` check, BEFORE the
  KYC / liquidity / swap scaffolding. The lock-release + bookkeeping
  clear must happen first so the subsequent state mutations
  (full-collateral-transfer fallback, internal-match dispatch, or
  external-aggregator swap) operate on an unlocked NFT.
- `RiskFacet.triggerLiquidation` — same pattern, after the
  `loan.status == Active` check.
- `RiskFacet.triggerLiquidationSplit` — same pattern.
- `RiskFacet.triggerLiquidationDiscounted` — same pattern.

`RiskFacet.triggerPartialLiquidation` is intentionally NOT wired
— partial liquidation keeps the loan Active with reduced principal
/ collateral; the borrower's listing stays meaningful and should
NOT be force-cancelled. (If the partial liquidation happens to
seize NFT collateral underlying an active listing, that's a
follow-up integration concern; today partial liquidation operates
on ERC20 collateral so the conflict doesn't arise.)

### Tests

2 new tests in `test/NFTPrepayListingFacetTest.t.sol`:

- `test_libPrepayCleanup_noopWhenNoListing` — confirms the
  library is a true no-op when no listing exists (no revert, no
  state change).
- `test_libPrepayCleanup_clearsLiveListing` — posts a listing
  then invokes the cleanup, asserts ALL five state mutations
  happen atomically (diamond mappings, executor.clearOrder, vault
  binding, conduit approval, NFT lock).

The library is invoked via a thin test-only entry on
`TestMutatorFacet.invokePrepayCleanup(loanId)` so the test
doesn't have to stand up the full default-flow scaffolding
(KYC + oracle + swap) to exercise just the cleanup logic.

Full `cifast` regression: 105 / 105 passing. Cross-flow
verification: DefaultedFacetTest (48/48), RiskFacetTest (73/73)
both green under the default profile — the new
`clearActiveListing` no-op path didn't break any existing default
/ liquidation tests.

### Why the strict `s; // suppress` pattern

Three of the four wired entry points (`triggerDefault`,
`triggerLiquidation`, `triggerLiquidationSplit`) read
`s = LibVaipakam.storageSlot()` BEFORE the cleanup call and use
`s` later for downstream state writes. The cleanup library reads
storage internally, so we don't pass `s` through — but Solidity
complains about the unused `s` in the brief window between the
status check and the next statement that uses it. The
`s; // suppress unused-storage warning` pattern matches the
existing convention used elsewhere in the codebase.

### Out of scope (still deferred to later steps)

- **Repay / Preclose / Refinance terminal cleanup integration**
  (`RepayFacet.repayLoan`, `PrecloseFacet.directClose` /
  `transferObligationViaOffer`, `RefinanceFacet`) — these still
  don't call `LibPrepayCleanup.clearActiveListing` on close.
  Step 6 round 2 added a borrower-side escape hatch (dropped the
  `loan.status == Active` gate on `cancelPrepayListing`) so the
  borrower can always self-clean post-close. Wiring the cleanup
  into the close paths themselves is queued for a follow-up
  contract-side pass once steps 12-15 land.
- **Indexer prepay_listings table** — step 12.
- **Frontend UI** — step 13.
- **OpenSea API integration** — step 14.
- **ERC1155 collateral** — step 15.
