## T-086 Round-8 design doc — borrow-OR-sell optionality at offer creation

Adds §19 to `docs/DesignsAndPlans/NFTCollateralSaleAndAuction.md`
specifying a borrower-side opt-in at offer-creation that lets the
collateral NFT sit on an OpenSea (or Seaport-conformant) listing
denominated in the offer's principal asset at a reserve at-or-above
the protocol floor. The listing surfaces during the offer-pending
phase, and the borrower retains the option to either be matched on
the loan (lender accepts) or be matched on the sale (buyer fills) —
whichever fires first wins, the other becomes structurally
unfillable in the same tx.

The motivation is that today a borrower whose NFT's market price
drifts above their loan target during the offer-pending phase has
to cancel-then-list-then-recreate (five steps, multiple txs, NFT
spends time outside the vault). Round-8 collapses that to a single
opt-in flag at offer creation; the off-chain ordering of
lender-accept vs. buyer-fill resolves which path runs.

**Two-order model (round-2 design + round-3 refinements).** Round-1
of the design doc had assumed a single Seaport orderHash could
span the offer-pending → loan-active → grace lifecycle. That is
structurally impossible at the Seaport / executor level because
(a) Seaport hashes `endTime` into the orderHash and the pre-loan
endTime cannot match `pctx.graceEnd` (the loan doesn't exist yet),
(b) the consideration array shape differs (single-leg pre-loan,
three-leg post-loan), and (c) the active-loan `lenderLeg` grows
monotonically via day-by-day interest accrual. Round-2 ratified the
two-order model: a pre-loan Seaport order signed at offer-create
(single-leg consideration, endTime = `offer.expiresAt`) and a
fresh active-loan Seaport order signed at offer-accept via the
vault's ERC-1271 delegate (three-leg consideration, endTime =
`pctx.graceEnd`). At offer-accept the pre-loan order is atomically
cancelled + the active-loan order is signed + recorded in the
SAME `acceptOffer` tx. The borrower's signature is captured at
offer-create + the vault attests at offer-accept; the borrower does
NOT need to be online to authorize the active-loan order.

**Three structural simplifications:** (1) lending-asset-only
removes all swap / oracle / slippage exposure at settlement;
(2) above-floor-only reuses Round-7's solvency invariant verbatim
(the buffer-inclusive floor is the same single value, with no
double-buffer applied at the §19.2 invariant); (3) the no-loan
branch's settlement waterfall has zero protocol legs to satisfy —
proceeds flow through a dedicated diamond callback that credits
the borrower's vault balance via the standard
`_creditUserVaultBalance` path, keeping the proceeds withdrawable
through the existing vault-balance flow.

**Round-3 architectural rewrites** (in response to Raja's CHANGES_REQUESTED
+ Codex round-1 + round-2 review):

- A new `OfferStatus.ConsumedBySale` terminal (distinct from
  `Cancelled`) blocks lender acceptance after a sale-fill; the
  existing `OfferAcceptFacet._acceptOffer` gate is extended to
  observe the new terminal. Without this, a lender accept tx
  landing after the sale-fill tx would proceed against a vault
  that no longer holds the NFT.
- A dedicated `recordOfferOrder` / `clearOfferOrder` /
  `offerContext` interface surface on the executor — distinct
  from the loan-keyed `recordOrder` / `orderContext` — keeps the
  two branches' invariants independent. The round-1 "reuse
  `recordOrder` with `loanId = 0`" path collided with the
  executor's existing unrecorded-order revert sentinel.
- A diamond-hosted live sanctions recheck callback
  (`assertOfferFillNotSanctioned`) runs during pre-loan fill in
  the diamond's storage slot — the round-2 "executor calls
  `LibVaipakam._assertNotSanctioned(...)` directly" would have
  read the executor's storage slot, silently failing open with
  no oracle consultation.
- The vault's ERC-1271 binding is rotated at offer-accept: the
  pre-loan hash is revoked, the active-loan hash is registered;
  the round-1 implicit assumption that one binding spanned the
  transition was wrong.

Design-doc-only change in this PR. Contract implementation, dapp
wiring, indexer event handling, and the off-chain publish step
that POSTs the active-loan order to the OpenSea API at
offer-accept time are tracked as separate follow-up Issues after
the design ratifies.

Closes the design half of Issue #358.
