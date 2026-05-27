## T-086 step 6 — borrower-facing NFTPrepayListingFacet

Closes the design doc §13 step-6 bullet: ships the borrower's
diamond surface for the Seaport prepay-collateral-listing flow.

### What the borrower can now do

For a live loan whose lender consented at offer time
(`Offer.allowsPrepayListing == true`, snapshotted onto
`Loan.allowsPrepayListing` at loan-init), the current
borrower-position-NFT holder can:

- **Post a listing** of the collateral NFT at an ask price the
  borrower picks, as long as the ask covers the live floor
  (lender principal + accrued interest + treasury cuts) plus a
  governance-configured safety buffer.
- **Update the listing** by re-signing with a fresh order hash and
  ask price — used when interest has eaten through the original
  buffer and a fresh Seaport order needs to be posted.
- **Cancel the listing** at any time pre- or post-grace.

If a listing's grace window expires without a fill, anyone can
**cancel the expired listing** — the permissionless cleanup is
the safety net so the borrower's position NFT isn't left locked
forever waiting for a buyer that didn't show up.

### Master kill-switch — listings dormant until governance enables

A new ConfigFacet setter `setPrepayListingEnabled(bool)` gates the
`postPrepayListing` / `updatePrepayListing` paths behind a master
flag. The flag defaults `false` on a fresh deploy: until the
vault's narrow `setCollateralOperatorApproval` entry (design-doc
step 7), the vault's ERC-1271 delegate, and the default-flow lock-
bypass (step 10) are wired end-to-end, a posted listing CANNOT
actually fill (Seaport can't pull the NFT through the conduit
without the vault's per-token approval). Shipping step 6 behind
this gate keeps the UX trap dormant — borrowers can't post
listings that would lock their position NFT without an escape
until they manually cancel. The cancel paths (borrower-side AND
the permissionless grace-expired cleanup) stay open regardless of
the flag so any listings posted under a previous `true` always
have a cleanup path.

### What this PR ships in detail

Five entry points on the new `NFTPrepayListingFacet`:

- `postPrepayListing(loanId, askPrice, orderHash, conduit)`
- `updatePrepayListing(loanId, newAskPrice, newOrderHash, conduit)`
- `cancelPrepayListing(loanId)`
- `cancelExpiredPrepayListing(loanId)` (permissionless,
  intentionally NOT pause-gated so locked NFTs can always be
  released)
- `getPrepayListingOrderHash(loanId)` + `getPrepayListingBufferBps()`
  (view helpers for the frontend / indexer)

Three new events tagged `state-change/loan-mutation`:

- `PrepayListingPosted(loanId, lister, orderHash, askPrice, conduit)`
- `PrepayListingUpdated(loanId, lister, oldOrderHash, newOrderHash, newAskPrice, conduit)`
- `PrepayListingCanceled(loanId, caller, orderHash, reason)`
  where `reason` is `Borrower` or `GraceExpired`.

The events are temporarily allowlisted in the indexer's
event-coverage guardrail (`apps/indexer/scripts/check-event-coverage.mjs`)
with the same shape as step 5's `PrepayCollateralSaleSettled`
allowlist: the indexer handlers + new `prepay_listings` D1 table
land in step 12 of the design doc.

### Storage + config additions

Two append-only fields on `LibVaipakam.Storage`:

- `mapping(uint256 => bytes32) prepayListingOrderHash` — per-loan
  active orderHash. Used by cancel paths to look up the binding to
  clear without forcing the caller (especially the permissionless
  cancel) to know the off-chain hash; the borrower-position-NFT
  lock is the consent + safety primitive, this mapping is the
  orderHash bookkeeping.
- `uint256 cfgPrepayListingBufferBps` — the governance-configured
  safety margin on top of the live floor.

One new ConfigFacet setter:

- `setPrepayListingBufferBps(uint16)` — ADMIN_ROLE-gated,
  range-bounded to 1000 bps (10%) ceiling. Default storage value
  `0` is the intentional pre-config block: the listing facet
  refuses every post / update until governance explicitly
  configures the buffer (design doc §10.2 recommends 200 bps /
  2%).

### How the pieces fit with step 5

Step 5 shipped the executor singleton + the diamond-side trust-
boundary facet. Step 6 builds on top: the borrower-facing facet
talks to the executor via a narrow `IListingExecutorRecorder`
interface, calling `recordOrder` at post time and `clearOrder` at
cancel / update time. The executor's existing diamond-only gate
on `recordOrder` (msg.sender == vaipakamDiamond) makes the new
facet the only authorized caller; conduit-allow-list discipline
stays enforced on the executor side, so the borrower facet just
fails fast with a clear `ConduitNotApproved` error before issuing
the executor call.

The full end-to-end fill path (Seaport → ERC-1271 → vault NFT
transfer → zone callback → diamond finalization) is still the
executor's responsibility; step 6 only owns the diamond-side
listing lifecycle (sign → update → cancel).

### Out of scope (deferred)

- **ERC1155 collateral** — v1 is ERC721 only (design doc §7).
  ERC1155 lands in step 9; the facet reverts
  `UnsupportedCollateralForV1` if the loan's collateral is
  anything other than ERC721.
- **Vault narrow approval entry** (`setCollateralOperatorApproval`)
  — step 7 in the design doc; the conduit's per-token approval
  on the collateral NFT contract is the operator's responsibility
  for now (off-chain frontend orchestration). The Seaport fill
  cannot complete without this approval, so the path is not yet
  end-to-end functional on chain — but the borrower-facing
  diamond surface is.
- **Frontend UI** (step 13), **OpenSea API integration** (step 14).

### Test plan

- 22 new unit tests in `test/NFTPrepayListingFacetTest.t.sol`
  cover the ConfigFacet setter (admin gate + bounds), every
  documented revert path on `postPrepayListing`, the
  `updatePrepayListing` happy path (old hash cleared, new
  hash recorded, lock stays on), both cancel paths
  (borrower-authority gated + permissionless grace-expired),
  and the executor stub assertions (recordOrder + clearOrder
  argument verification).
- Full `cifast` profile regression: 92 / 92 passing including
  the new tests + every step-5 + step-2/3/4 test.
- Deploy-sanity guardrails: facet selector coverage + EIP-170
  size + integration cut verification all green for the 39-
  facet diamond.
- Frontend ABI sync: regenerated `packages/contracts/src/abis/`
  via `exportFrontendAbis.sh`; barrel updated to re-export both
  `PrepayListingFacetABI` (step-5 catch-up) and
  `NFTPrepayListingFacetABI`; `@vaipakam/defi` typecheck clean.
- Indexer event-coverage guardrail passes with the three new
  events allowlisted with explicit step-12 deferral reasons.
