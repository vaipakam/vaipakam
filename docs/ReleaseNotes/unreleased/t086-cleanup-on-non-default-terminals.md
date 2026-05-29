## T-086 — wire `LibPrepayCleanup.clearActiveListing` into the non-default terminal paths

Closes the acknowledged technical debt that step 6 (PR #300) and step 10 (PR #303) explicitly noted: when a borrower has an active prepay-collateral-listing and the loan terminates via any path OTHER than default or HF-liquidation (i.e. `repayLoan`, `precloseDirect`, `refinanceLoan`, offset-completion), the listing's on-chain bookkeeping was previously left in place — the orderHash binding stayed on the vault, the borrower-position-NFT lock stayed on, and the executor's `orderContext` mapping kept the now-stale record. The only escape was the borrower's `cancelPrepayListing` after-the-fact escape hatch.

This change adds the existing `LibPrepayCleanup.clearActiveListing(loan, loanId)` library call to four more terminal sites:

- `RepayFacet.repayLoan` (full repay; both Active and FallbackPending cure paths)
- `PrecloseFacet.precloseDirect` (the ERC20-principal direct-close path; NFT-rental rentals can't carry a prepay-listing — gate is `assetType == ERC20`)
- `PrecloseFacet.offsetCompleted` (defensive — in normal flow the borrower must cancel the listing before initiating an offset because the step-6-round-2 lock-overwrite-protection blocks `_lock(PrecloseOffset)` over a live `_lock(PrepayCollateralListing)`; the call is belt-and-suspenders)
- `RefinanceFacet.refinanceLoan` (the OLD loan flip to Repaid)

Each call is placed AFTER every safeTransferFrom has committed but BEFORE the LibLifecycle status transition. This follows the standard validate-pull-mutate-finish pattern: by the time we touch listing bookkeeping, the lender has already been paid; if any earlier transfer reverts the whole tx rolls back atomically (including the cleanup) and the listing stays live as expected.

The library function is idempotent (early-returns when no listing is on the loan), so every site can call unconditionally without branching on `s.prepayListingOrderHash[loanId]`.

### Behavioural consequences

- **Borrower's repay/preclose/refinance is now self-contained.** They no longer need to remember to call `cancelPrepayListing` after closing a loan that had a live listing — the bookkeeping clears atomically with the close.
- **Same-block race resolution is cleaner.** If a buyer's `Seaport.fulfillOrder` lands AFTER the borrower's `repayLoan` in EVM order in the same block, the buyer's tx calls `isValidSignature` on the borrower's vault, which now returns invalid (the binding was revoked atomically with the repay) — Seaport rejects the fill cleanly with `BadSignatureV{X}` (or whatever Seaport returns for ERC-1271 rejection). If the buyer's tx lands FIRST, the borrower's repay sees `loan.status != Active` and reverts `InvalidLoanStatus()` — same EVM-determinism outcome as before, but no orphan listing left behind in either branch.
- **OpenSea catalog refresh** still lags by minutes (their re-validation pass picks up the now-invalid signature). That latency is closed by the Option B follow-up tracked in #316 (Seaport.cancel emit).

### Out of scope (explicitly)

- **`Seaport.cancel(orders[])` emit** — gives OpenSea's indexer instant notification (seconds, not minutes). Requires an executor storage change + new method to reconstruct OrderComponents and call Seaport.cancel as the order's zone. Tracked as #316.
- **Frontend friendly error** — when a borrower's `repayLoan` reverts because the loan was settled via prepay sale, the dapp can decode `InvalidLoanStatus()` + read the loan's current status + show a tailored "Your loan was settled via OpenSea sale; your borrower-remainder is in your claimables" message. Pure dapp-side change; will land alongside the MEV doc note follow-up.
- **`Seaport.incrementCounter()` sledgehammer** — rejected on the multi-loan vault concern: a borrower with three NFT-collateral loans can have three live listings on the same vault simultaneously; bumping the vault's Seaport counter would invalidate all of them.

### Test coverage

The library itself is unit-tested via the existing `LibPrepayCleanup`-call paths in `triggerDefault` / `triggerLiquidation`. The new wiring sites all go through the same library, so the existing assertions about "after cleanup: orderHash binding revoked, NFT lock released, executor's orderContext cleared, vault's per-orderHash mapping cleared" carry over. New integration tests can be added in a follow-up — the wiring itself is a single library call at each site so the audit surface is small.
