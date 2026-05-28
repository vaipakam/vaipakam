## T-086 step 7 — Vault narrow entries + ERC-1271 delegate

Builds on step 6's borrower-facing diamond surface (PR #300). Ships
the vault-side pieces that make the Seaport prepay-collateral-listing
flow actually fill-able once governance flips the master kill-switch.

### What this PR ships

**On `VaipakamVaultImplementation` (per-user UUPS proxy):**

- `setCollateralOperatorApproval(nftContract, tokenId, conduit, approved)`
  — Diamond-gated. Grants (or revokes) a Seaport conduit's
  per-token approval on the vault's collateral NFT. The diamond
  is responsible for pre-validating that the conduit is in the
  executor's governance allow-list at call time.
- `registerListingOrderHash(orderHash, executor)` — Diamond-gated.
  Pins the orderHash → executor binding on the vault so its
  ERC-1271 callback can delegate.
- `revokeListingOrderHash(orderHash)` — Diamond-gated. Idempotent.
  Clears the orderHash → executor binding so Seaport's signature
  verification at fill time refuses the order.
- `isValidSignature(hash, sig) → bytes4` (ERC-1271 callback) —
  reads the pinned executor for `hash` and delegates the
  decision to `executor.isOrderValid(hash)`. Returns the magic
  value iff the executor approves; the `sig` argument is
  intentionally ignored (the vault doesn't sign with a private
  key; the orderHash binding is the authoritative authorization
  record).
- `getListingExecutor(orderHash)` — view helper for the
  indexer / frontend to query which executor a given orderHash
  is bound to.
- New storage `mapping(bytes32 => address) _listingExecutor`
  appended to the pre-gap layout; `__gap` shrunk from 50 to 49
  slots so the overall UUPS storage footprint stays constant.

**On `CollateralListingExecutor`:**

- New `isOrderValid(bytes32 hash) → bool` view, factored out of
  the existing `isValidSignature` so the vault's ERC-1271
  delegate can consult it in plain-bool shape without
  re-deriving the magic-value-encoded `bytes4`. The local
  `isValidSignature` now delegates to `isOrderValid` itself —
  same semantics, single source of truth for the check stack.

**New interface `IListingExecutorValidator`:**

Narrow `isOrderValid(bytes32) → bool` surface that the vault
imports. Separate from `IListingExecutorRecorder` (the diamond's
record-order surface) so the vault doesn't pull in the conduit
allow-list / order-record entries that aren't its concern.

**On `NFTPrepayListingFacet` (diamond, step 6 facet):**

- `postPrepayListing` now also calls into the borrower's vault:
  `vault.setCollateralOperatorApproval(collateralAsset,
  collateralTokenId, conduit, true)` + `vault.registerListingOrderHash(orderHash,
  executor)`. Without these, Seaport couldn't pull the NFT
  through the conduit at fill time and signature verification
  would fail — making the listing un-fillable.
- `updatePrepayListing` revokes the OLD orderHash on the vault +
  registers the NEW one + re-grants the conduit approval
  (idempotent if conduit unchanged).
- `cancelPrepayListing` / `cancelExpiredPrepayListing` revoke
  both the conduit approval AND the orderHash binding on the
  vault so a previously-signed order can no longer fill.

**On `PrepayListingFacet.executorFinalizePrepaySale` (step 5 facet):**

- After a successful Seaport fill, the post-fill callback also
  revokes the orderHash binding on the vault. Seaport's
  `transferFrom` already clears the per-token approval at the
  ERC-721 level, so we only need the orderHash revoke here.

### Tests

4 new step-7-specific tests in
`test/NFTPrepayListingFacetTest.t.sol`:

- `test_post_wiresVaultOperatorApproval` — confirms the post
  path grants the conduit approval on the real ERC721 mock.
- `test_post_registersOrderHashOnVault` — confirms the vault's
  orderHash → executor mapping is populated.
- `test_cancel_revokesVaultBinding` — confirms cancel clears
  BOTH the orderHash binding and the conduit approval.
- `test_vault_isValidSignature_returnsMagicWhenExecutorApproves`
  — confirms the ERC-1271 callback returns INVALID for an
  unregistered orderHash (the registered-positive path needs a
  real executor; covered separately in the executor's tests).

Test scaffolding extended: each test now deploys a real
`MockRentableNFT721` as the collateral NFT, mints the token to
the borrower, transfers it to the borrower's vault (created via
`VaultFactoryFacet.getOrCreateUserVault`). The vault entries
operate against a live ERC-721 + a real UUPS proxy, not
fake addresses.

Full `cifast` regression: 103 / 103 passing. Cross-flow
verification: PrecloseFacetTest (60/60), EarlyWithdrawalFacetTest
(68/68 + 1 skipped), PrepayListingFacetTest (8/8) all green under
the default profile.

### End-to-end fill path now wired

Once governance calls `ConfigFacet.setPrepayListingEnabled(true)`
on a chain (post-audit), the full flow runs:

1. Borrower → `postPrepayListing(loanId, askPrice, orderHash, conduit)`.
2. Diamond validates, locks borrower NFT, records on executor,
   wires vault (grants conduit approval + pins orderHash).
3. Frontend posts the signed Seaport order to the conduit's
   order book (e.g. OpenSea).
4. Buyer fills via Seaport → Seaport calls vault.isValidSignature
   (which delegates to executor.isOrderValid) → Seaport pulls
   NFT from vault through conduit → distributes lender + treasury
   + borrower considerations → fires executor's `validateOrder`
   zone callback.
5. Executor's `validateOrder` re-runs the floor + recipient +
   grace checks, then calls back into the diamond via
   `executorFinalizePrepaySale(loanId)`.
6. Diamond transitions Active → Settled, unlocks borrower NFT,
   settles VPFI LIF rebate, clears bookkeeping (diamond +
   vault orderHash binding).

### Out of scope (still deferred)

- **ERC1155 collateral** — step 9 / 15. Step 7's
  `setCollateralOperatorApproval` is ERC721-only (uses
  `IERC721.approve`).
- **Default-flow lock-bypass** — step 10. `DefaultedFacet` +
  `RiskFacet` need to unlock the borrower NFT as their first
  step if the lock reason is `PrepayCollateralListing`.
- **Indexer prepay_listings table** — step 12.
- **Frontend UI** — step 13.
- **OpenSea API integration** — step 14.
