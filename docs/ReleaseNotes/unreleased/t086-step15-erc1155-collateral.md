## T-086 step 15 — ERC1155 collateral support

Extends the Seaport prepay-collateral-listing flow shipped in
step 6 (PR #300) + step 7 (PR #302) to accept ERC1155 collateral
in addition to ERC721. Per design doc §7: ERC1155 listings cover
the full vaulted balance and require `FULL_RESTRICTED` Seaport
orders (no partial-quantity fills); the executor's content gate
already enforces both invariants at fill time, so step 15 is
the borrower-side and vault-side wiring that lets the path
accept ERC1155 collateral in the first place.

### What this PR ships

**On `VaipakamVaultImplementation`:**

- New entry `setCollateralOperatorApprovalERC1155(nftContract,
  conduit, approved)` — Diamond-gated. Wraps `IERC1155.setApprovalForAll(conduit,
  approved)`. ERC1155 doesn't have per-token approve (the
  standard's only approval surface is operator-wide), so this
  is necessarily operator-level — the FULL_RESTRICTED order
  semantic + the executor's content-gate full-balance check
  are what bound the operator-wide approval's blast radius.
- Reuses the existing `CollateralOperatorApprovalSet` event
  with `tokenId == 0` placeholder.

**On `NFTPrepayListingFacet`:**

- `postPrepayListing` ERC721-only revert relaxed to accept BOTH
  ERC721 and ERC1155. ERC20 collateral stays rejected
  (`UnsupportedCollateralForV1` — no NFT identifier to put in
  the Seaport offer item).
- `_wireVaultForListing` branches on `loan.collateralAssetType`:
  ERC721 calls `setCollateralOperatorApproval` (per-token),
  ERC1155 calls `setCollateralOperatorApprovalERC1155`
  (operator-wide).
- `updatePrepayListing` mirrors the same branch for the
  re-approval after orderHash rotation.
- `_cancel` branches: ERC721 explicitly revokes the per-token
  approval; ERC1155 leaves the operator approval in place. The
  rationale (documented in the code): the FULL_RESTRICTED order
  + the executor's content gate prevent partial-quantity fills,
  AND `revokeListingOrderHash` invalidates the vault's
  ERC-1271 sign-verification path — both together make the
  stale operator approval unfillable.

**On `LibPrepayCleanup.clearActiveListing` (step 10 library):**

- Same branch: ERC721 revokes per-token approval; ERC1155 only
  invalidates the orderHash binding. Default-flow lock-bypass
  paths (DefaultedFacet / RiskFacet) get the right semantics
  for ERC1155 collateral automatically.

### Tests

- `test_postPrepayListing_revertsUnsupportedCollateralForV1`
  updated to use ERC20 as the unsupported case (was ERC1155,
  which is now supported).
- Full `cifast` regression: 105 / 105 passing.

### Out of scope (still deferred)

- **Frontend UI** (step 13) — the ERC1155 path now works end-to-
  end at the contract layer; the React surface needs an explicit
  collateral-type branch (different listing UX for ERC1155 vs
  ERC721 since the asset's quantity is implicit in the
  full-balance offer shape).
- **OpenSea API integration** (step 14).
- **Per-conduit ERC1155 revoke on cancel** — a future v2
  enhancement would store the (collection, conduit) pair at
  post time so cancel can explicitly `setApprovalForAll(false)`
  on the recorded conduit. Today the orderHash invalidation +
  full-balance constraint are the safety primitives; leaving
  the operator approval in place matches the standard Seaport
  ERC1155 conduit pattern.

### Note on the existing `UnsupportedCollateralForV1` error

The error name still says "ForV1" but the natspec on the
matching docstring has been updated to reflect the post-step-15
scope (ERC721 + ERC1155 accepted; ERC20 rejected). Keeping the
name avoids a breaking ABI change and the off-chain UX impact
is minimal — the error fires only on the rare ERC20-collateral
case that wasn't valid at any version of the prepay flow.
