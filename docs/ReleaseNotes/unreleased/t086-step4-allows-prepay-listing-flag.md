## T-086 step 4 — `allowsPrepayListing` lender-consent flag

Step 4 of `docs/DesignsAndPlans/NFTCollateralSaleAndAuction.md` §13. Adds a one-bit lender-consent gate that flows from `CreateOfferParams` → `Offer` → `Loan`, gating the (step-6) `NFTPrepayListingFacet.postPrepayListing` entry. Today the gate's consumer (step 6) hasn't shipped yet; this PR lays the storage groundwork so step 6 can land as a clean addition with no struct-layout work.

### What this PR does

1. **Adds `allowsPrepayListing` to three structs** in `contracts/src/libraries/LibVaipakam.sol`, all at the tail of their respective definitions (append-only per the project's storage-layout rule):
   - `CreateOfferParams` — the lender's `createOffer`-time toggle.
   - `Offer` — the on-chain offer record, copied verbatim from `CreateOfferParams`.
   - `Loan` — the on-chain loan record, snapshotted from `Offer` at loan-init.
2. **Wires the two copies** that move the flag through the create / accept lifecycle:
   - `OfferCreateFacet.createOffer` — one line: `offer.allowsPrepayListing = params.allowsPrepayListing;`.
   - `LoanFacet.initiateLoan` — one line: `loan.allowsPrepayListing = offer.allowsPrepayListing;`.

### Default `false`; sweep across 222 construction sites

`CreateOfferParams` is constructed via Solidity named-arg syntax in 47 files (8 deploy / fixture scripts + 39 test files), totalling 222 `CreateOfferParams({ ... })` sites. Each one now explicitly carries `allowsPrepayListing: false` — the safe default. The sweep was done deterministically by a Python script that inserts the new field on the line immediately following the existing `allowsPartialRepay:` field (which is present at every site by Solidity's named-arg-completeness requirement) — preserving indentation, alphabetic neighbours, and not touching any non-construction reference.

### Mirrors the `allowsPartialRepay` pattern exactly

The lender opt-in shape mirrors the existing `allowsPartialRepay` consent gate verbatim. Both flags:

- Are take-it-or-leave-it parts of the offer package; an acceptor who disagrees simply doesn't accept.
- Default `false` for safe, explicit opt-in.
- Snapshot onto the `Loan` at init; immutable for the loan's lifetime regardless of any later offer-level change.

This shape choice keeps reviewer cognitive load minimal: anyone who has reviewed the `allowsPartialRepay` plumbing sees the same diagram applied one struct field deeper. The (step-6) `NFTPrepayListingFacet.postPrepayListing` gate will mirror the `RepayFacet.repayPartial` `PartialRepayNotAllowed` gate one-to-one.

### What this PR explicitly does NOT do

- **No step-6 facet.** `NFTPrepayListingFacet` (and its `postPrepayListing` / `updatePrepayListing` / `cancelPrepayListing` / `cancelExpiredPrepayListing` entry points) is the next foundational step in the queue. Until that lands, no caller can act on `Loan.allowsPrepayListing == true` — the flag is inert.
- **No ABI re-export.** `CreateOfferParams`'s ABI shape changes (one extra `bool` slot), which means consumers — frontend, indexer, agent, keeper — that build their own `CreateOfferParams` need a re-export + typecheck cycle to pick up the new field. The standard `bash contracts/script/exportFrontendAbis.sh` + `pnpm --filter @vaipakam/{defi,keeper,indexer,agent} exec tsc -b --noEmit` sweep runs as a separate change (per CLAUDE.md "Frontend ABI sync" + `feedback_abi_sync_after_contract_changes.md`).
- **No frontend UI** — the lender-side CreateOffer page doesn't yet expose the toggle. That's a step-13 deliverable (Frontend "Auction to prepay loan" UI), and includes both the lender-side opt-in and the borrower-side listing post / cancel / browse surfaces.

### Test coverage

`contracts/test/AllowsPrepayListingTest.t.sol`:

- **Offer round-trip**: a `setOffer({ allowsPrepayListing: true })` survives a read-back through `OfferCancelFacet.getOffer` with the flag intact.
- **Offer default**: an offer that doesn't set the flag reads back `false`.
- **Loan round-trip**: a `setLoan({ allowsPrepayListing: true })` lands correctly in storage (verified via `getLoanDetails` identity check; the `LoanDetails` struct's surface for this field can be added alongside the step-6 facet that needs it).
- **Loan default**: similar to the offer default case.
- **CreateOfferParams compile-time**: pins the field's presence on the calldata-input struct, fails to compile if removed.

The sweep itself is the second half of the test plan: every existing test that constructs a `CreateOfferParams` now does so with `allowsPrepayListing: false`, so the full forge-test regression validates that the new field's default-false path runs cleanly through every existing flow (create / accept / repay / preclose / refinance / partial-withdrawal / liquidate / default / claim / etc.).

<!-- ci-retrigger marker: empty rerun stuck in queue 90+ min on 79edb6a0; pushing trivial change to fire fresh workflow_run -->
