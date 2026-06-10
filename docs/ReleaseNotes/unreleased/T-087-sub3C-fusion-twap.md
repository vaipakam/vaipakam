## Thread — T-087 Sub 3.C: Fusion TWAP intent submission via T-090 GA bridge (PR #<n>)

Third slice of Sub 3 (treasury buyback umbrella #452). Wires the actual 1inch Fusion API submission for buyback intents + ships the Fusion-order-template validation that Sub 3.B deferred. The on-chain ledger from Sub 3.B can now produce real on-chain buy pressure: the validated commit makes `isValidSignature` return the ERC-1271 magic value, and the agent posts the order to 1inch's LOP orderbook for solver discovery.

### What changes

**New on-chain validation surface — `TreasuryFacet.commitBuybackIntentValidated`**

Operator passes the full Fusion order template + extension bytes + (amountIn, minVpfiOut, expiresAt). The diamond:

1. Bounds the TWAP window (default 1800s; admin-tunable 600..3600s).
2. Fetches the LOP's EIP-712 DOMAIN_SEPARATOR via staticcall.
3. Validates every field against the canonical buyback shape:
   - `maker == receiver == diamond`.
   - `makerAsset == tpl.makerAsset`, `takerAsset == s.vpfiToken`.
   - `makingAmount == amountIn`, `takingAmount == minVpfiOut`.
   - `makerTraits`: HAS_EXTENSION + PRE_INTERACTION + POST_INTERACTION + ALLOW_MULTIPLE_FILLS all REQUIRED; NO_PARTIAL_FILLS / USE_PERMIT2 / NEED_CHECK_EPOCH_MANAGER / UNWRAP_WETH all FORBIDDEN.
   - Expiration sub-field (bits 80-119) matches `expiresAt`.
   - Salt low 160 bits == uint160(keccak256(extension)) — LOP v4's extension binding.
   - Extension bytes match the canonical layout (preInteractionData = postInteractionData = diamond).
4. Recomputes the LOP v4 orderHash on-chain via EIP-712 and asserts it matches the operator-supplied hash.
5. Reserves the source token via `LibTreasuryBuyback.commitBuyback` (debit budget + credit reserved + grant LOP allowance + bump live-commit counter).
6. Sets `s.buybackValidated[orderHash] = true`.

`IntentDispatchFacet.isValidSignature` now returns the ERC-1271 magic value ONLY for orderHashes where `buybackValidated == true` AND the order is still `Pending` AND `block.timestamp < expiresAt`. Sub 3.B's blanket-invalid for buyback is replaced by validation-gated magic.

### TWAP partial-fill support

Sub 3.B's strict `consumed != amountIn` rejection becomes partial-fill aware:

- `postInteractionImpl` tracks `s.buybackConsumedSoFar[orderHash]` across multiple fills.
- Each partial settles a portion: releases proportional reservation + LOP allowance + credits the per-partial VPFI delta to `stakingPoolBuybackBudget`.
- Cumulative pro-rata minVpfiOut floor (round-1 P2): `s.buybackVpfiDeliveredSoFar[orderHash]` tracks total delivered VPFI; each partial enforces `cumulativeVpfi >= floor(info.minVpfiOut * consumedSoFar / info.amountIn)`. Catches rounding-loss compounding across many tiny partials (per-partial floor-division could otherwise round to zero on each fill and the order could settle below `minVpfiOut`). Early over-delivery can subsidise a later under-delivery; the invariant holds on the cumulative side.
- Order flips Filled only when `consumedSoFar == amountIn`. Earlier partials leave status Pending so subsequent fills re-enter through the dispatcher.
- New event `BuybackIntentClosed(orderHash, token, totalAmountIn)` fires once per orderHash on the FINAL partial. Indexer treats it as the terminal-fill signal.
- The intermediate `BuybackIntentFilled` event now reports per-partial consumed + per-partial actualVpfi (vs. cumulative in Sub 3.B).
- `expireBuyback` releases ONLY the unconsumed portion (`amountIn - consumedSoFar`). Anything already swapped via partial fills stays settled.

### Storage additions (append-only)

- `mapping(bytes32 => bool) buybackValidated` — Sub 3.C validation flag.
- `mapping(bytes32 => uint128) buybackConsumedSoFar` — partial-fill source-token accumulator.
- `mapping(bytes32 => uint128) buybackVpfiDeliveredSoFar` — partial-fill VPFI delivered accumulator (cumulative floor enforcement; added round-1 P2).
- `uint32 cfgBuybackTwapMaxWindowSec` — TWAP window upper bound (default 1800 when 0).

### Producer artifacts

- TreasuryFacet selectors 26 → 32 (6 new: `commitBuybackIntentValidated`, `canonicalBuybackExtension`, `setBuybackTwapMaxWindowSec`, `getBuybackTwapMaxWindowSec`, `isBuybackValidated`, `getBuybackConsumedSoFar`).
- ABI bundle regenerated; frontend tsc clean.

### apps/agent extension

`intentFusionPost.ts` gains a `kind?: 'swap_to_repay' | 'buyback'` discriminator on the request body:

- `'swap_to_repay'` (default for backwards compat) preserves the existing T-090 v1.1 GA bridge: matches `SwapToRepayIntentCommitted` event topic + fetches `getIntentCommit(loanId)` + per-field on-chain recheck.
- `'buyback'` matches `BuybackIntentValidated(bytes32)` event topic only — the on-chain `commitBuybackIntentValidated` already validates every field against the canonical Fusion shape, so the per-field recheck is redundant.

Both kinds POST the same signed-order shape to the same 1inch LOP orderbook v4.1 endpoint. The diamond's `isValidSignature` handles ERC-1271 binding at fill time.

### Test coverage

13 new tests in `BuybackValidatedCommitTest.t.sol`:

- Validated commit happy path → validated flag set, isValidSignature returns magic.
- Field tamper reverts (wrong makerAsset).
- MakerTraits tamper reverts (NO_PARTIAL_FILLS bit set forbidden).
- TWAP window > 30 min reverts.
- `canonicalBuybackExtension()` view matches library.
- Partial fill happy path → accumulates + status stays Pending → final partial flips Filled + clears validated.
- Expire after partial releases only unconsumed.
- isValidSignature returns invalid for: non-validated commits, post-fill orders.
- TWAP window setter: happy path, below min, above max, default fallback.

Sub 3.B's `test_PostInteraction_RevertWhen_PartialFill` rewritten to `test_PostInteraction_RevertWhen_PartialOverflow` — partials are now allowed; only consumed > remaining reverts.

### Out of scope (Sub 3.D)

- End-to-end integration test against a real CCIPMessenger + LOP fork.
- FunctionalSpec + Advanced UG docs.

### Verification

- 13 new Sub 3.C tests + 28 Sub 3.B tests + Sub 3.A regression all green (86 total contract tests in the buyback surface).
- Deploy-sanity 12/12.
- Frontend tsc clean. Agent tsc clean.
