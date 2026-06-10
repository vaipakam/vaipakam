# Treasury Buyback (T-087 Sub 3)

> Code-free, implementation-independent functional specification.
> The platform IS the test oracle; this doc states intent, not
> code.

This spec describes the platform's intent around **treasury-funded VPFI buyback**: how protocol fee revenue routed to the Base-side treasury becomes constant on-chain buy pressure for VPFI via 1inch Fusion TWAP orders, and how the proceeds flow to stakers.

## 1. Purpose

VPFI is the platform's governance + discount-rights token. Fees the protocol collects on every loan, swap-to-repay settlement, and aggregator-routed liquidation are denominated in heterogeneous source assets (USDC, WETH, WBTC, source-chain native tokens, etc.). The buyback flow consolidates those source assets on Base, opens a Fusion TWAP order for VPFI, and routes the delivered VPFI to the staker reward pool.

The platform's intent is that this flow produces **continuous, governance-bounded buy pressure** for VPFI rather than discrete large market orders — preserving floor stability while accruing value to long-term stakers.

## 2. Lifecycle

A buyback intent moves through five named states. Every state transition is observable on-chain (events) and surfaced via the agent's status endpoints.

### 2.1 Per-chain budget accumulation

On every chain the platform deploys to (Base + mirrors), fee revenue in bridgeable source assets accumulates in the treasury (`treasuryBalances`). The buyback budget slot is then populated by **explicit admin allocation**, not automatic fee accrual:

- The platform's settlement paths credit fees into `s.treasuryBalances[token]` at fee-collection time. This is the same path the existing treasury-claim flow uses.
- The admin allocator (`creditBuybackBudget`) moves a chosen amount of `treasuryBalances[token]` into the buyback budget. This is the on-chain mechanism for "decide this much of our fee accrual goes to buybacks". Sub 3.B / 3.C do NOT auto-route a fixed percentage at accrual time — the split is operator-decided each tranche. A fully-automated split-at-accrual hook is tracked as a Sub 3 add-on follow-up.
- The accumulator is per-token. ETH from `buyVPFIWithETH` callers is on the **no-convert list** — it's reserved for operational ETH + VPFI/ETH LP seeding, never for cross-chain remittance or treasury conversion.
- Tokens are admin-allowlisted per chain (`buybackAllowedToken`). Non-allowlisted tokens cannot enter the budget.
- A per-token tranche cap (`cfgBuybackMaxTranche`) bounds the blast radius of any single commit (defence against operator typo / misconfiguration).

### 2.2 Cross-chain remittance (mirrors → Base)

When a mirror chain's per-token budget crosses a threshold, the operator calls `remitBuyback(srcToken, destToken, amount, refundAddress)`:

- The diamond debits its per-chain budget for the local source token.
- The diamond approves the cross-chain messenger for the exact amount.
- The messenger forwards the value cross-chain (via Chainlink CCIP today) with a 32-byte payload carrying the **destination-side token address** (so a mirror's USDC delivery on Base credits the Base-side USDC budget, not the mirror-side address).
- Operator pins each `srcToken → destToken` mapping at config time. The diamond rejects remittances whose declared destination doesn't match the pinned mapping (defence against operator typo).

On Base, the `BuybackRemittanceReceiver` UUPS contract is the inbound channel handler. It:

- Validates strict-1-token-per-delivery.
- Validates the payload-declared token matches the actually-delivered token.
- Forwards the delivered tokens into the diamond.
- Calls `absorbRemittance(token, actualReceived, sourceChainId)` with the actual received amount (handles fee-on-transfer tokens by reading the diamond's balance delta).
- The diamond credits the **Base-side consolidated budget** (`baseBuybackBudget`).

If the delivered amount is zero (100% fee-on-transfer or silent transfer no-op), the receiver reverts to keep the CCIP message manually re-executable. No silent budget loss.

### 2.3 Validated commit (Base)

Once the Base consolidated budget for a token can fund a tranche, the operator calls `commitBuybackIntentValidated(orderHash, fusionOrderTemplate, amountIn, minVpfiOut, expiresAt)`:

- The diamond bounds the TWAP window (default 30 min; admin-tunable 10..60 min).
- The diamond fetches the LOP's EIP-712 domain separator and **recomputes the orderHash on-chain** from the operator-supplied template.
- The recomputed orderHash must equal the operator-supplied hash. If not, the commit reverts. This guarantees the on-chain ledger and the off-chain order template agree on every field.
- The diamond validates every field of the canonical buyback shape:
  - `maker == receiver == diamond` — the diamond IS the Fusion maker.
  - `makerAsset` matches the operator's `tpl.makerAsset`.
  - `takerAsset == vpfiToken` — the only acceptable taker asset is VPFI.
  - `makingAmount == amountIn`, `takingAmount == minVpfiOut`.
  - `makerTraits` carries: `HAS_EXTENSION` + `PRE_INTERACTION_CALL` + `POST_INTERACTION_CALL` + `ALLOW_MULTIPLE_FILLS` REQUIRED; `NO_PARTIAL_FILLS` + `USE_PERMIT2` + `NEED_CHECK_EPOCH_MANAGER` + `UNWRAP_WETH` FORBIDDEN. (Partial fills + multiple fills are REQUIRED for TWAP; the swap-to-repay path requires the opposite.)
  - The makerTraits `expiration` sub-field matches `expiresAt`.
  - The extension bytes match the canonical layout (`preInteractionData = postInteractionData = diamond`).
- `minVpfiOut > 0` — a zero floor would produce an unfillable order (1inch LOP rejects zero `takingAmount`) and strand the source-token reservation.

If every check passes:

- The diamond reserves `amountIn` of the source token (debits `baseBuybackBudget`, credits `baseBuybackReserved`).
- The diamond grants LOP an aggregate allowance for the source token via the shared `intentAggregateAllowance` counter (the same counter the swap-to-repay path uses; both arms coexist).
- The diamond stamps `s.orderHashKind[orderHash] = BUYBACK` so the dispatcher routes future Fusion callbacks here.
- The diamond sets `s.buybackValidated[orderHash] = true`. This flag is the load-bearing precondition for `isValidSignature` returning the ERC-1271 magic value.
- The diamond bumps the shared `intentLiveCommitCount` so LOP rotation is blocked until this intent reaches terminal.

### 2.4 Fusion solver pickup + partial fills

The agent (`apps/agent`) posts the signed Fusion order body to 1inch's LOP orderbook v4.1 endpoint. The diamond signs as ERC-1271 — Fusion's LOP staticcalls `isValidSignature(orderHash, '')` at fill time and gets the magic value back ONLY IF:

- `s.buybackValidated[orderHash] == true`, AND
- The order status is still `Pending`, AND
- `block.timestamp < expiresAt`.

The order is **partial-fill enabled** + **multi-fill enabled**. Fusion solvers compete to fill it across the TWAP window. Each partial fill triggers:

- `preInteraction`: dispatcher routes to the buyback library, which snapshots the diamond's VPFI balance AND source-token balance into transient storage.
- The LOP itself pulls the partial source-token amount from the diamond (via the aggregate allowance) and delivers the corresponding VPFI to the diamond.
- `postInteraction`: dispatcher routes back. The buyback library:
  - Verifies the source token actually left the diamond (`srcBaseline - srcNow >= consumed`).
  - Reads the VPFI balance delta against the preInteraction baseline.
  - Enforces the **cumulative pro-rata minVpfiOut floor**: `cumulativeVpfi >= floor(minVpfiOut * consumedSoFar / amountIn)`. Per-partial floor-division is rejected because rounding loss compounds — many tiny fills could each round their share down to zero. The cumulative check rejects under-delivery even if individual partials happen to clear their per-partial pro-rata share.
  - Releases the proportional reservation; credits the partial VPFI delta to `stakingPoolBuybackBudget`; decrements the aggregate LOP allowance.
- The order flips `Filled` only when `consumedSoFar == amountIn`. Earlier partials leave status `Pending` so subsequent partials re-enter through the dispatcher.

A final `BuybackIntentClosed(orderHash, token, totalAmountIn)` event fires once per orderHash on the FINAL partial — the indexer's terminal-fill signal.

### 2.5 Expire / cancel

If a Fusion order is past its `expiresAt` without reaching `consumedSoFar == amountIn`, anyone can call `expireBuybackIntent(orderHash)`:

- Permissionless (no admin gate).
- Releases the **unconsumed** portion of the source-token reservation back to `baseBuybackBudget`. Anything already swapped via partial fills stays settled.
- Decrements the aggregate LOP allowance by the unconsumed amount.
- Marks the order `Expired`; clears the kind discriminator + validated flag.

The operator can then commit a fresh TWAP at a different price target.

## 3. Failure modes the operator must understand

| Failure | Symptom | Recovery |
|---|---|---|
| Operator commits with the wrong `destToken` | `remitBuyback` reverts `BuybackDestTokenMismatch` before any state change | Operator fixes the pinned mapping via `setBuybackDestToken` |
| Operator commits with `amountIn > tranche cap` | `commitBuyback*` reverts `BuybackTrancheCapExceeded` | Raise the cap via `setBuybackMaxTranche` OR commit a smaller tranche |
| Operator commits an order with mutated fields | `commitBuybackIntentValidated` reverts at the on-chain orderHash recomputation | Operator fixes the order template + re-commits |
| Fusion fill underdelivers VPFI | `postInteraction` reverts `BuybackBelowMinVpfiOut`; partial settles but cumulative floor blocks the next | Operator can `expireBuybackIntent` after deadline + re-commit at a lower floor OR wait for solvers to deliver more |
| Mid-flight CCIP delivery fails (fee-on-transfer with 100% fee) | `BuybackRemittanceReceiver` reverts `ZeroAmount`; CCIP marks the message failed-and-re-executable | Operator delisten the token via `setBuybackAllowedToken(false)` + manually re-execute when the token is fixed |
| LOP rotation while buyback is live | `IntentConfigFacet.setFusionLimitOrderProtocol` rejects: `intentLiveCommitCount > 0` | Wait for all live buyback + swap-to-repay intents to reach terminal |

## 4. What stakers see

**Today (Sub 3 core):** buyback fills credit `stakingPoolBuybackBudget` on every partial. This slot is the on-chain staging area for buyback-delivered VPFI. The existing `StakingRewardsFacet.claimStakingRewards` distribution path does NOT yet widen its cap from this slot — claimable staking rewards still come exclusively from the original reward bucket (the governance-set drip).

**Sub 3 add-on (#472):** the priority router widens the staker claim cap from `stakingPoolBuybackBudget`. When that PR merges, stakers' claimable VPFI will grow automatically as buyback velocity accumulates — on top of the original reward bucket. The same router will also route a portion of delivered VPFI into the rewards budget / keeper budget when those add-ons are wired.

Until the router lands, buyback fills land safely in the staging slot but are invisible to staker `claim`s. This is by design — Sub 3 ships the buyback infrastructure; the staker-facing distribution is a separate scoped follow-up.

The constant-buy-pressure mechanic emerges from:

1. Multiple committed buyback intents can be live concurrently (each within its TWAP window).
2. Each intent's solvers compete on price across 30 minutes.
3. The operator schedules commits at a cadence informed by the consolidated `baseBuybackBudget` velocity.

No single tx generates massive market-buy pressure that would impact LP pools; instead, the buying is dispersed across solver auctions throughout the day.

## 5. Out-of-scope (deferred / external)

- **USD-denominated tranche cap** with oracle: Sub 3 add-on. Currently the cap is per-token raw amounts.
- **Routing the delivered VPFI to rewards budget / keeper budget**: Sub 3 add-on #472.
- **Productive treasury reserve** (Aave for WBTC / Lido for ETH): Sub 3 add-on #473.
- **Keeper VPFI rewards for catchup tasks**: Sub 3 add-on #474.
- **VPFI / ETH LP seeding from operational ETH**: tracked under #455.
- **Live 1inch Fusion testnet integration**: operator-gated. The contract surface + agent submission are wired; the operator opens the 1inch API key + posts the first real order during testnet rehearsal.
