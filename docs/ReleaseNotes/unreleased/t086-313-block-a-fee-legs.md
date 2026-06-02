## T-086 #313 Block A — fee-legs for fee-enforced collections (atomic)

Extends the canonical Seaport prepay-listing order shape from a fixed
3 consideration legs (lender / treasury / borrower) to **3 + up to 4
optional fee legs**, so listings published against fee-enforced
OpenSea collections (royalty + marketplace fees, OpenSea's "enforcing"
collection tier) can carry the fee recipients OpenSea requires and
still pass the same canonical orderHash on both producers — frontend
proxy and indexer autonomous fallback. Closes Issue #313 (the last
fee-enforced-collection UX gap T-086 had left open).

This PR lands every layer of that change in **one atomic cut** — the
sole acceptable shape for an ABI-breaking diamond+executor rotation:
the executor's UUPS implementation, the diamond facet wiring, the
shared `@vaipakam/lib` order-shape library, the indexer D1 column +
sweep path, the agent proxy + indexer-autonomous payload, and the
dapp. A non-atomic rollout would leave the deployed executor temporarily
unable to validate orders posted with the new shape.

### What this PR ships

**Shared Solidity types** — new `contracts/src/seaport/PrepayTypes.sol`
exporting `FeeLeg{address recipient, uint96 startAmount, uint96 endAmount}`
and `MAX_FEE_LEGS = 4`. Used by `LibPrepayOrder`, `IListingExecutorRecorder`,
`CollateralListingExecutor`, and `NFTPrepayListingFacet`. The
`startAmount` / `endAmount` shape is forward-compatible with Block B's
Dutch decay; for the fixed-price posting path this PR enforces
`startAmount == endAmount` at the facet boundary.

**`LibPrepayOrder` extended** — `buildAndHash` and `componentsForCancel`
now both accept `FeeLeg[] calldata feeLegs`. The borrower leg is
re-derived as `askPrice - lenderLeg - treasuryLeg - sum(feeLegs)` so
the protocol's lender/treasury solvency invariant is preserved; the fee
legs are then appended at consideration indices `3..N`. The library is
split into two helpers (`_componentsAtCalldata` for the sign-time path,
`_componentsAtMemory` for the cancel-time path) so each caller pays the
right copy cost.

**Facet boundary — fee-aware solvency checks** — new
`NFTPrepayListingFacet` errors `FeeLegsExceedCap`, `FeeLegInvalidRecipient`,
`FeeLegInvalidAmount`, `FeeLegDecayNotAllowedOnFixedPrice`, and
`AskBelowFloorPlusFees`. Both `postPrepayListing` and `updatePrepayListing`
grew a `FeeLeg[] calldata feeLegs` arg. The new `_validateFeeLegsFixedPrice`
checks cap (≤4) + non-zero recipient/amount + the fixed-price invariant
(`startAmount == endAmount`). The new `_requireAskCoversFloorWithFees`
folds the fee sum into the existing floor-buffer check:
`minAsk = (floor * (10_000 + bufferBps)) / 10_000 + feeSum` — listings
that wouldn't clear the buffered floor *after* fee deductions are
rejected up front instead of seating a leaky order on-chain.

**`PrepayListingPosted` / `PrepayListingUpdated` events** — extended
with a `FeeLeg[] feeLegs` non-indexed tail. Producers (frontend +
indexer) decode the tail to drive the same canonical orderHash
reconstruction the executor records on-chain.

**`CollateralListingExecutor` (UUPS impl)** — new
`mapping(bytes32 => FeeLeg[]) internal _orderFeeLegs;` (with public
`orderFeeLegs(bytes32)` getter) so the cancel path on `_tryCancelOnSeaport`
can rebuild the exact `OrderComponents` Seaport saw at fill-time.
`recordOrder` validates length cap + per-leg recipient/amount and pushes
each leg to storage; `clearOrder` and the post-fill branch of
`validateOrder` both `delete _orderFeeLegs[orderHash]` (the post-fill
cleanup was a Codex-caught storage-leak; same shape as the existing
`orderContext` cleanup). `_assertOrderContent` length-cap relaxed from
exactly-3 to `3..3+MAX_FEE_LEGS` with per-fee-leg item-type / token /
identifier asserts.

**`@vaipakam/lib/prepayOrderShape` (TS)** — `PrepayOrderInput.feeLegs?`
threaded through to `buildPrepayOrderComponents`. Same
subtract-then-append math; same single source of truth the frontend and
indexer both consume so the off-chain reconstruction can never diverge
from the on-chain executor's view (the load-bearing invariant — any
field-order divergence would hash to a different orderHash and OpenSea
would reject the vault's ERC-1271 sig).

**Atomic deploy harness** — new
`contracts/script/multicallDeploy.s.sol`,
`contracts/script/utils/BatchCaller.sol`,
`contracts/script/utils/EncodeMultiSend.sol`,
`contracts/script/utils/DeployGnosisSafe.s.sol`. Builds a single
Gnosis Safe `multiSend(bytes)` payload that performs the executor
UUPS `upgradeToAndCall` AND the facet `diamondCut` in **one
transaction** so there is no window where the diamond is wired to the
new ABI while the executor still validates the old shape. Block B
will reuse this same harness for its UUPS rotation. `BatchCaller` is
`operator`-gated at construction (immutable address); the Codex-caught
front-run vector during transient ownership was closed by adding
`if (msg.sender != operator) revert NotOperator(msg.sender);` to
`batch()`.

**Indexer payload** — `apps/indexer/src/openseaPublish.ts` +
`chainIndexer.ts`'s `PrepayListingPosted` / `PrepayListingUpdated`
handlers now decode the `feeLegs` event tail and thread it to the
shared `buildPrepayOrderComponents`. New D1 column `fee_legs_json TEXT`
(migration `0017_prepay_listings_fee_legs.sql`) stores the legs for
the sweep retry path so a late autonomous republish reconstructs the
exact same orderHash months later. Retry sweep reads the JSON back,
converts to BigInt, and re-publishes.

**Agent proxy** — `apps/agent/src/openseaCollectionProxy.ts`
(GET `/opensea/collection/{slug}`) and
`apps/agent/src/feeRecipientPreflight.ts`
(POST `/opensea/feeRecipientPreflight`). The collection proxy is
stateless + per-IP rate-limited (new `OPENSEA_COLLECTION_RATELIMIT`
binding, namespace 1006, 30 req/min/IP); the preflight returns
`not_applicable` for every recipient on the allow-list (honest verdict
— Codex P2 called out the optimistic `passed` shape as worse than no
signal). Both echo `resolvedOrigin` in CORS, not raw `FRONTEND_ORIGIN`
CSV.

**Dapp** — `useNFTPrepayListing` grew a `ReadonlyArray<FeeLegInput>`
arg on `postPrepayListing` / `updatePrepayListing` / `runOpenSeaPublish`.
`PrepayListingActions` passes empty `[]` for now (the fee-picker UI is
the deferred follow-up — fee-enforced collection support reaches
parity with #313's contract surface in this PR; the dapp picker is
queued as a separate UX card).

### What's NOT in this PR (intentional)

- **UI fee-leg picker** — the contracts and the off-chain reconstruction
  are wired for arbitrary fee legs; the dapp passes `[]` today. The
  picker is a focused follow-up card (collection-page sniff →
  recipient list → "use OpenSea defaults" toggle) tracked separately.
- **`feeRecipientPreflight` actually sim-validating** — current verdict
  is `not_applicable` until the on-chain sim plumbing lands. Returning
  optimistic `passed` would be worse than the current honest "we
  haven't checked"; replaced as a deliberate downgrade per Codex P2.
- **`borrower_remainder` D1 column** — Round 2 originally proposed it;
  dropped per both reviewers since proper math needs an extra
  `getPrepayContext` RPC plumbing. Will reappear as a discrete follow-up.
- **Block B (Dutch decay) + Block C (English via OpenSea Offers)** —
  #309. Block A's `startAmount/endAmount` shape is forward-compatible
  with Block B; the recorder will grow one more parameter when Block B
  lands.

### Operator action post-merge

This PR is **atomic for the codebase** — both the executor UUPS impl
and the diamond facet wiring land on `main` together. The **on-chain**
rotation is operator-gated and uses the new `multicallDeploy.s.sol`
harness:

1. Deploy the new `CollateralListingExecutor` implementation.
2. Build the multisend payload via `multicallDeploy.buildPayload(...)`
   — one `upgradeToAndCall` + one `diamondCut`.
3. Send the multisend through the Safe (1 transaction, atomic).
4. Apply the D1 migration:
   ```
   cd apps/indexer && wrangler d1 migrations apply vaipakam-archive --remote
   ```

There is **no period during the rotation when half the system is on
the new ABI and half is on the old** — that's the only acceptable
shape for an executor-side breaking change.

### Verification

- Full forge regression: **2227 / 2227 PASS** (5 new fee-leg
  integration tests + the existing 2222) — happy-path 2-leg
  OpenSea+royalty, cap-exceeded revert, zero-recipient revert,
  decay-on-fixed-price revert, ask-below-floor-plus-fees revert
- CI on `2504ad4d`: contracts-fast / Slither / CodeQL / JS analyze /
  workspaces pnpm typecheck / Workers Builds (agent + indexer) /
  Build docs — all green
- 4 rounds of adversarial review closed: Codex GPT-5, Gemini 2.0
  Flash Thinking, Codex round-2, Codex round-3, Codex round-4
  ("Didn't find any major issues. Swish!"), plus three sequential
  human reviews

### Closes

Issue #313 (T-086 fee-legs for fee-enforced collections).

### Related

- T-086 step 14 (OpenSea integration, prior PR): #312
- T-086 step 16 (Seaport cancel emit): #316 / #321
- Round 5 design + Round 5.1 errata: #322 + #323
- **Block A (this PR): fee-legs atomic** — #324
- Block B (Dutch decay): #309
- Block C (English via OpenSea Offers): #309
- Multi-marketplace fan-out: #281
