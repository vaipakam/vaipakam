## T-086 step 2 — `LockReason.PrepayCollateralListing` enum extension

Round-4 design doc §13 step 2 closes with this PR. The setApprovalForAll-during-lock hardening (PR #282) put the counter + epoch chain in place; this PR adds the missing enum value the upcoming `NFTPrepayListingFacet` (step 6) will pass to `LibERC721._lock` when a borrower posts a Seaport-mediated prepay listing on their collateral NFT.

### The change

One line in `contracts/src/libraries/LibERC721.sol`:

```solidity
enum LockReason { None, PrecloseOffset, EarlyWithdrawalSale, PrepayCollateralListing }
```

The new value lands at the tail (storage value `3`) so the on-chain meaning of every existing `locks[tokenId]` is preserved. `None` (0), `PrecloseOffset` (1), and `EarlyWithdrawalSale` (2) keep their values. The natspec on the enum was promoted to call out the append-only requirement explicitly — adding a new reason post-launch is fine; reordering or removing entries reinterprets every existing lock value on a live diamond, which is a footgun if not flagged.

### Why this is its own PR

Step 2 in `docs/DesignsAndPlans/NFTCollateralSaleAndAuction.md` §13 is the foundation step every later piece depends on. The counter + epoch + `setApprovalForAll` gate shipped via PR #282 — this PR adds the only remaining piece (the enum value) so step 3 (`LibCollateralSettlement.liveFloor`) and step 5 (`CollateralListingExecutor`) can land cleanly without bundling a one-line enum change into a bigger surface.

### Why it's safe

- **No call site needs to change.** Every existing reference to `LockReason` either compares against `None` (lock-state predicate) or supplies a specific reason at `_lock` time. There's no exhaustive switch on the enum values — verified by grep across `contracts/src/` + `contracts/test/`. The new value is purely additive.
- **Append-only on enums is upgrade-safe.** The underlying storage type is `uint8`; existing tokens that carry `locks[tokenId] == 1` (PrecloseOffset) keep that value. The Solidity ABI doesn't expose enum ordinals to external callers; consumers that read `lockOf` / `positionLock` get the bytes representation of the enum, which is already correct for any value 0–2.
- **Tests prove the new reason is a first-class citizen, not a special case.** Lock → unlock round-trip on `PrepayCollateralListing` exercises the same counter math, epoch bump, `setApprovalForAll` gate, and `positionLock` view as the existing reasons. A mixed-reason test (`PrecloseOffset` on token A + `PrepayCollateralListing` on token B) confirms the counter sums across reasons and each fresh lock bumps the epoch.

### Follow-ups still queued from §13

- Step 3: `LibCollateralSettlement.liveFloor(loanId, asOfTimestamp)` — closed-form floor formula. Standalone library.
- Step 4: `Offer`/`Loan` `allowsPrepayListing` flag (append-only).
- Step 5: `CollateralListingExecutor` singleton (ERC-1271 + Seaport zone). Biggest single step.
- Steps 6–17 per `docs/DesignsAndPlans/NFTCollateralSaleAndAuction.md` §13.
