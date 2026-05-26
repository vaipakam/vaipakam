## T-086 step 5 — `CollateralListingExecutor` singleton + `PrepayListingFacet` trust boundary

Step 5 of `docs/DesignsAndPlans/NFTCollateralSaleAndAuction.md` §13. Lands the executor↔diamond pair that brokers Seaport-mediated prepay collateral sales. The borrower-facing post / update / cancel entry points are step 6 (`NFTPrepayListingFacet`); this PR is the trust boundary between Seaport's order-matching engine and the diamond's loan state.

### The executor singleton — `contracts/src/seaport/CollateralListingExecutor.sol`

A UUPS-upgradeable singleton implementing two trust-boundary surfaces Seaport calls into at fill time:

1. **ERC-1271 sign-time delegate** (`isValidSignature(hash, signature)`). Verifies that the `orderHash` is one this executor recorded for an active loan + an approved conduit. The richer content checks (live floor, recipient binding, schema) happen at fill time, not sign time — Seaport doesn't pass the order content into the 1271 call.

2. **Seaport 1.6 zone hooks** — BOTH `authorizeOrder` (pre-transfer) AND `validateOrder` (post-transfer). The 2-hook split is required by Seaport 1.6's `ZoneInterface`; missing `authorizeOrder` would make every listing unfulfillable (Seaport reverts on the missing selector before our checks run). Both hooks share `_checkOrderPreconditions`, which runs the FULL stack: `msg.sender == seaport` gate, conduit re-validation (catches post-sign governance revokes), loan-Active status, grace expiry, full offer-side schema (itemType / token / identifier / amount must match the loan's collateral), full consideration-side schema (3 legs in the loan's principalAsset; ERC20 lending only), live-floor amounts, recipient binding (lender + treasury + borrower recipients re-derived from current NFT holders + the diamond's `getTreasury()` — the signed recipient is checked against THIS value, not trusted from the order). `validateOrder` additionally calls the diamond's privileged finalization callback after Seaport's transfers complete.

3. **Governance-managed conduit allow-list** with `addApprovedConduit` / `removeApprovedConduit` (ADMIN_ROLE on the owner, → timelock + multisig post-handover). Re-checked at fill time.

4. **`recordOrder` / `clearOrder`** — diamond-only entry points (`msg.sender == vaipakamDiamond`) for step 6's `postPrepayListing` / `cancelPrepayListing` to bind / unbind `orderHash` to `loanId` + sign-time conduit. Includes an explicit `uint96` bounds check on `loanId` (silent narrowing would let a future `loanId > 2^96` wrap into a different loan record).

### The diamond-side trust boundary — `contracts/src/facets/PrepayListingFacet.sol`

A new diamond facet that pairs with the executor. Four entry points:

1. **`getPrepayContext(loanId, asOfTimestamp) external view`** — the single bundled view the executor reads for every fill. Runs `LibCollateralSettlement.principalPlusAccruedInterest` + `treasuryAndPrecloseFee` + `LibVaipakam.gracePeriod` + the NFT-owner / treasury resolves all in the DIAMOND's storage context. This is the **load-bearing architectural fix** for the Codex P0 finding on PR #288's first draft: the executor used to call those libraries directly, in its own (empty) storage context, which evaluated the live floor to 0 — every fill would have passed. The bundled-view design moves all storage reads to the diamond and ships the executor a struct.

2. **`executorFinalizePrepaySale(loanId) external whenNotPaused`** — the privileged finalization callback. Gated `msg.sender == s.collateralListingExecutor`; performs the three atomic mutations: `LibLifecycle.transition(loan, Active, Settled)`, `LibERC721._unlock(loan.borrowerTokenId)`, `LibVPFIDiscount.settleBorrowerLifProper(loan)` (the latter load-bearing per CLAUDE.md "VPFI Fee Discounts — Phase 5 flow").

3. **`setCollateralListingExecutor(address) external`** — ADMIN_ROLE-gated setter for the trusted executor address. `address(0)` disables the path; rotation supports executor upgrades without diamond changes.

4. **`getCollateralListingExecutor() external view`** — read-side for frontends + the executor itself.

### Storage extension

`LibVaipakam.Storage` gains one append-only field: `address collateralListingExecutor` (default `address(0)` while unset; `executorFinalizePrepaySale` reverts `ExecutorNotSet` until governance configures it).

### What this PR does NOT do

- **No borrower-facing flow.** Step 6's `NFTPrepayListingFacet` ships the `postPrepayListing` / `updatePrepayListing` / `cancelPrepayListing` / `cancelExpiredPrepayListing` entry points borrowers actually call. Step 6 also performs `LibERC721._lock(LockReason.PrepayCollateralListing)` (the enum value from #285) and `recordOrder` against this executor.
- **No `cfgPrecloseFeeBps()` getter** — the prepay-fee summand on the treasury leg stays `0` until governance opts in. Library structure is ready for the field; step 6 or a follow-up adds it.
- **No frontend / indexer / agent / keeper wiring** — those land in step 11 (ABI export + consumer typechecks) and step 12 (indexer event coverage).

### Test coverage

A dedicated executor unit test suite (mock-diamond harness) + diamond-side integration tests for `PrepayListingFacet` land in a follow-up commit on this branch. The mock harness covers each `authorizeOrder` / `validateOrder` revert path (wrong sender, unknown order, revoked conduit, non-Active loan, expired grace, schema mismatches, short-paid lender / treasury, wrong recipients) plus the happy path that drives a Settled-via-prepay state. Integration tests cover the executor↔diamond callback round-trip with the real `PrepayListingFacet` cut into the test diamond.
