## Thread — T-087 Sub 3.B: commitBuybackIntent + IntentDispatchFacet (PR #<n>)

Second slice of Sub 3 (treasury buyback umbrella #452). Builds the on-chain intent ledger that the Sub 3.C Fusion submission will plug into. Refactors the 1inch LOP v4 callback surface so the same selectors can route to either order kind without facets fighting for them.

### What changes

#### New surface — buyback intent ledger (TreasuryFacet)

- `commitBuybackIntent(orderHash, token, amountIn, expiresAt)` — ADMIN-gated. Debits `s.baseBuybackBudget[token]`, credits `s.baseBuybackReserved[token]`, records the ledger entry (`token / amountIn / expiresAt / status=Pending`), and stamps `s.orderHashKind[orderHash] = ORDER_KIND_BUYBACK` so the dispatch facet knows to route this orderHash into `LibTreasuryBuyback`.
- `expireBuybackIntent(orderHash)` — permissionless rollback after the deadline. Releases the reservation back to `baseBuybackBudget`, marks the order `Expired`, clears the kind discriminator.
- Public reads: `getBuybackOrder(orderHash)`, `getOrderHashKind(orderHash)`, `getStakingPoolBuybackBudget()`.

#### New library — `LibTreasuryBuyback`

Three internal helpers used by the TreasuryFacet / IntentDispatchFacet wrappers:

- `commitBuyback(orderHash, token, amountIn, expiresAt)` — shape + accounting invariants (zero token / amount / expiry-in-past / amount-overflow / expiry-overflow / orderHash-in-use / budget-insufficient guards).
- `onFill(orderHash, deliveredVPFI)` — called from `IntentDispatchFacet.postInteraction` when the kind is BUYBACK. Releases the source-token reservation, credits the delivered VPFI to `s.stakingPoolBuybackBudget` (Sub 3 add-on #472 will later split between rewards / keeper / staking pool budgets), marks `Filled`, clears the kind.
- `expireBuyback(orderHash)` — past-deadline rollback path. Same teardown as cancel but permissionless.

#### Dispatcher refactor — `IntentDispatchFacet`

New facet that owns the three 1inch LOP v4 callbacks exclusively:

- `preInteraction`, `postInteraction`, `isValidSignature`.

Each arm reads `s.orderHashKind[orderHash]` (stamped at commit time, cleared at every teardown) and dispatches by kind:

- `ORDER_KIND_SWAP_TO_REPAY` → `LibSwapToRepayIntentSettlement` (the T-090 v1.1 GA path, extracted from `SwapToRepayIntentFacet` in this PR).
- `ORDER_KIND_BUYBACK` → `LibTreasuryBuyback`.
- Unknown / cleared kind → `UnknownOrderKind(orderHash)` revert.

`SwapToRepayIntentFacet` no longer owns those selectors — its facet declaration drops `IPreInteraction / IPostInteraction / IERC1271` inheritance, and the four helpers (`preInteraction`, `postInteraction`, `_runSettlement`, `isValidSignature`) move to `LibSwapToRepayIntentSettlement` as internal functions. The facet keeps its borrower-facing commit / cancel / force-cancel surface unchanged; it now also stamps `orderHashKind[orderHash] = ORDER_KIND_SWAP_TO_REPAY` in `commitSwapToRepayIntent` and clears it in every teardown path.

### Why the dispatcher pattern

The 1inch LOP v4 expects to find each callback at the standard signature (`preInteraction.selector`, `postInteraction.selector`, `isValidSignature.selector`). Diamond facets can only own one selector each — so the buyback path can't add its own copy of the callbacks alongside the existing T-090 path. The dispatcher facet owns the selectors; per-kind logic lives in libraries; both paths coexist cleanly.

### Storage additions (append-only)

- `mapping(bytes32 => bytes32) orderHashKind` — per-orderHash discriminator (`ORDER_KIND_SWAP_TO_REPAY` or `ORDER_KIND_BUYBACK`).
- `mapping(bytes32 => BuybackOrderInfo) buybackOrders` — per-order ledger entry (`token / amountIn / expiresAt / status`, packed into 2 slots).
- Constants: `ORDER_KIND_SWAP_TO_REPAY`, `ORDER_KIND_BUYBACK`, status enum values.

### Producer artifacts

- Cuts array grows 49 → 50 (DeployDiamond + SetupTest + DiamondFacetNames). New `IntentDispatchFacet` entry.
- TreasuryFacet selectors 19 → 24 (new commit / expire methods + 3 reads + staking-pool-budget read).
- SwapToRepayIntentFacet selectors 11 → 8 (the three 1inch callbacks moved out).
- IntentDispatchFacet — 3 new selectors (the three 1inch callbacks).
- ABI bundle regenerated; frontend `pnpm exec tsc -b --noEmit` clean.

### Test coverage

18 new tests in `BuybackIntentLedgerTest.t.sol`:

- Commit: happy-path; revert on not-admin / zero-token / zero-amount / amount-overflow / expiry-in-past / budget-insufficient / double-commit.
- Expire: happy-path; revert on not-yet-expired / already-terminal.
- IntentDispatchFacet: `isValidSignature` magic for BUYBACK-pending; `0xffffffff` for unknown + expired; `preInteraction` BUYBACK no-op; `postInteraction` BUYBACK fill credits staking-pool budget + clears kind; `UnknownOrderKind` revert on both pre/post when no kind is stamped.

The existing T-090 path stays green: `SwapToRepayIntentFacetTest` 16/16 passes (one test rewired to call `IntentDispatchFacet.isValidSignature` instead of the now-removed facet method).

### Out of scope (Sub 3.C/D)

- 1inch Fusion intent submission via `apps/agent` (Sub 3.C).
- TWAP order shape (`allowPartialFills` + `expiration`) (Sub 3.C).
- End-to-end CCIP→commit→fill→staker-claim integration test + FunctionalSpec + Advanced UG (Sub 3.D).

### Out of scope (Sub 3 add-ons)

- Fee-converted VPFI priority routing (rewards → keepers → staking pool) — #472. For Sub 3.B all delivered VPFI goes straight to the staking pool budget.

### Verification

- 18 new tests green.
- TreasuryBuybackRemittanceTest (28) + BuybackRemittanceReceiverTest (14) — Sub 3.A regressions still green.
- SwapToRepayIntentFacetTest (16) — T-090 v1.1 still green.
- Deploy-sanity (12) — facet count + selector coverage + collision check all green.
- Frontend tsc clean.
