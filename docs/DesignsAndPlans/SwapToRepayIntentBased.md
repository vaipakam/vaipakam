# T-090 v1.1 — Intent-Based Swap-to-Repay (Design)

**Card:** #389. **Parent umbrella:** #384. **Predecessor:** T-090 v1
(`SwapToRepayFacet` shipped as PRs #390 / #391 / #402 / #405 / #406 / #409
on 2026-06-06/07).

## 1. Problem

T-090 v1 ships `swapToRepayFull` / `swapToRepayPartial` against the
proven Phase 7a 4-DEX failover primitive (`LibSwap.swapWithFailover` →
0x Settler v2 / 1inch v6 / Uniswap V3 / Balancer V2). Atomic in one
block; capped at 3% slippage; matches the "click → done" UX.

The atomic AMM-route works well for small-to-medium swaps in liquid
pairs. It gets uncomfortable in three corners:

1. **Large swaps in middle-liquidity pairs** — the 3% cap is binding,
   but the realized price is 100-300 bps worse than what a solver-based
   protocol could deliver. The borrower either eats the worse price or
   waits for the cap to widen.
2. **Fee-enforced tokens** — USDT-style transfer fees, tokenized stocks
   with notional rebases — get poorly modelled by AMM routes. Solver
   protocols quote the actual delivered amount, not the swap-line
   notional.
3. **MEV exposure** — the AMM swap's calldata is public the moment the
   borrower submits, making them sandwich-bait on illiquid pairs.
   Solver protocols hide intent behind a commit-then-fulfil pattern.

For the borrower categories that hit these corners, paying a 1-2 minute
settlement wait in exchange for solver-guaranteed pricing is the better
trade. That's what v1.1 adds.

## 2. Scope

v1.1 introduces an **intent-based** sibling entry point on the
swap-to-repay surface, NOT a replacement of v1. Both surfaces coexist.
The borrower picks per-transaction:

- **Atomic** (v1) — instant settlement, AMM route via
  `LibSwap.swapWithFailover`, 3% slippage cap. Default for most flows.
- **Best-price intent** (v1.1) — 1-2 minute settlement wait, solver-
  guaranteed execution price (no slippage cap because the solver's
  fillment is the price), MEV-resistant. Right for size + illiquid
  pairs.

Mode is a UX toggle in the dapp. On-chain, the two surfaces use
different entry points and different settlement hooks; they share the
post-swap settlement waterfall (treasury cut + lender vault credit +
borrower surplus to EOA + claim slots + Repaid transition + LIF rebate
+ prepay-listing cleanup + position-NFT flip + reward close).

## 3. Existing primitives the v1.1 path can reuse

- `LibAuth.requireBorrowerNftOwner` — same authority root.
- `LibSettlement.computeRepayment` — same immutable settlement plan.
- `LibEntitlement.{settlementInterest, splitTreasury}` — same waterfall.
- `LibPrepayCleanup.clearActiveListing` — same listing teardown.
- `LibVPFIDiscount.settleBorrowerLifProper` — same LIF settlement.
- `LibInteractionRewards.closeLoan` — same reward close.
- `LibFacet.{getOrCreateVault, getTreasury}` — same vault routing.
- `VaultFactoryFacet.vaultWithdrawERC20` — same collateral pull.

The full settlement waterfall is identical between v1 and v1.1 — only
the swap step differs. The new code is concentrated in the
intent-commit / intent-fulfilment surface, not in the financial logic.

## 4. Intent-backend candidates

Three production-grade intent-settlement protocols are viable for v1.1.
Each has a different model for "the borrower commits, a solver fills,
the protocol settles." All three are mainnet-live with measurable
solver competition.

### 4.1 1inch Fusion (V2)

**Model:** Borrower signs a Fusion order off-chain. Resolvers (1inch's
solver set) compete in a Dutch auction to fill the order at the best
price. On fill, 1inch's `Settlement` contract atomically transfers the
maker asset out of the borrower's wallet and credits the taker asset to
a configurable recipient.

**Integration shape for Vaipakam:** the dapp builds a Fusion order with
the borrower's vault as the `maker` and the diamond as the `recipient`
of the taker asset. The diamond's role is purely the receiving address;
1inch's contract handles the actual swap.

- **Settlement window:** 1-3 minutes typical; configurable per order.
- **Solver depth:** 30+ resolvers, large overlap with 1inch v6 routes.
- **Failure mode:** if no resolver fills before the auction ends, the
  order expires; the diamond's commit slot just clears and the borrower
  can resubmit or fall back to v1 atomic.
- **Integration cost:** moderate. Need to build the order off-chain
  (1inch SDK), commit to the diamond, observe fill via event, run the
  settlement waterfall in the same tx as the fill (via a callback the
  diamond exposes to 1inch's Settlement).
- **Trust assumptions:** 1inch's resolver set; the Fusion contracts are
  audited and have been mainnet-live since 2023.

### 4.2 CoWSwap (CoW Protocol)

**Model:** Borrower signs a CoW order off-chain. CoW's solver auction
batches orders across users and finds coincidence-of-wants matches
(borrower's collateral could be swapped against another user wanting
the inverse, no AMM hop needed). On fill, CoW's `GPv2Settlement`
contract executes the batch.

**Integration shape:** very similar to Fusion — order built off-chain,
`recipient` is the diamond, fill happens in CoW's settlement contract.
Key difference: CoW orders are *batched*; the solver round happens
every ~30 seconds.

- **Settlement window:** 30 seconds to 5 minutes; predictable batch
  cadence rather than a continuous Dutch auction.
- **Solver depth:** 30+ solvers; better for stable-pair swaps where
  CoW matches dominate; comparable to Fusion for general AMM-backed
  pairs.
- **Failure mode:** if no solver matches within a few batches, the
  order's `validTo` deadline expires; same cancel-and-retry pattern as
  Fusion.
- **Integration cost:** moderate. CoW SDK + `GPv2Settlement` recipient
  pattern. CoW also has a partner program with rebates on fees, which
  could offset Vaipakam's treasury cut.
- **Trust assumptions:** CoW's solver set; CoW contracts audited and
  mainnet-live since 2022.

### 4.3 UniswapX

**Model:** Borrower signs a Permit2-style order. Fillers compete in a
Dutch auction. The reactor contract executes the fill, calling an
optional `IReactorCallback.reactorCallback` on the borrower-specified
callback target during the fill. This callback is where Vaipakam would
run the settlement waterfall.

**Integration shape:** the diamond becomes the `output recipient` AND
optionally the callback target. The borrower's collateral is pulled via
Permit2; the diamond's callback receives the principal and runs the
waterfall before the reactor's solvency check.

- **Settlement window:** typically 30 seconds to 2 minutes.
- **Solver depth:** Uniswap's fillers; growing but smaller than Fusion's
  set as of late 2025.
- **Failure mode:** no-fill → order expires by deadline. Same recovery
  pattern.
- **Integration cost:** higher. The reactor callback pattern means
  Vaipakam writes a `IReactorCallback`-compatible facet that handles
  edge cases (callback runs *during* the reactor's fill, in a
  reentrancy-locked context the diamond must coordinate with).
- **Trust assumptions:** Uniswap's Permit2 + reactor; audited by
  Cantina, mainnet-live since 2023.

### 4.4 Recommendation

**Default pick: 1inch Fusion** for v1.1. Three reasons:

1. Vaipakam already integrates 1inch v6 in the atomic path
   (`OneInchAggregatorAdapter`). The team's familiarity with the 1inch
   API surface + the existing quote-proxy worker (`apps/agent/src/
   quoteProxy.ts → /quote/1inch`) flatten the integration ramp.
2. Fusion's solver set is the deepest of the three for the generic
   ERC-20 ↔ ERC-20 pairs Vaipakam loans use.
3. Fusion's settlement contract is a passive recipient — the diamond
   doesn't need to run code during the fill, just receive the taker
   asset. That simplifies the on-chain shape: the v1.1 facet becomes a
   commit-then-settle pair, not a callback-during-fill contract. Lower
   audit surface area; fewer corners for the fulfilment race.

The doc treats Fusion as the default and Sub 1's contracts as
Fusion-shaped. CoWSwap and UniswapX stay viable as v1.2 or later if
Fusion underperforms in production.

## 5. On-chain shape (Fusion default)

### 5.1 New facet: `SwapToRepayIntentFacet`

Lives at `contracts/src/facets/`. Phase 1 surface:

- `commitSwapToRepayIntent(uint256 loanId, FusionOrderCommit calldata commit)` —
  Borrower-NFT-owner-only. Validates loan shape (same gates v1 uses:
  ERC20-on-ERC20, both liquid, lender exclusion, grace window). Pulls
  the borrower's pledged collateral from the vault into a custodial
  slot keyed by `loanId`. Records `commit` (Fusion order hash +
  deadline + minOutput) in storage. Emits `SwapToRepayIntentCommitted`.
- `finalizeSwapToRepayIntent(uint256 loanId)` — Permissionless (anyone
  can poke it after the Fusion fill lands the principal at the
  diamond). Reads the principal balance delta vs the recorded
  `minOutput`, asserts the fill happened, then runs the canonical
  settlement waterfall using the same Lib calls as `swapToRepayFull`.
  Emits `SwapToRepayIntentExecuted`.
- `cancelSwapToRepayIntent(uint256 loanId)` — Borrower-NFT-owner-only.
  Permitted after `commit.deadline`. Returns the custodial collateral
  to the borrower's vault (same `vaultDepositERC20` path) and clears
  the commit slot. Emits `SwapToRepayIntentCancelled`.

### 5.2 Storage

Append-only to `LibVaipakam`:

```
struct SwapToRepayIntentCommit {
    bytes32 orderHash;
    uint64  deadline;
    uint256 minPrincipalOut;
    uint256 custodialCollateral;
    address commitedBy;        // current borrower NFT owner at commit time
}
mapping(uint256 loanId => SwapToRepayIntentCommit) intentCommits;
```

The `committedBy` field lets `cancelSwapToRepayIntent` re-verify that
the canceller is the same NFT owner that committed — needed because
the borrower NFT could have changed hands during the 1-3 minute
auction window.

### 5.3 Settlement waterfall

Identical to v1 `swapToRepayFull`. Reuses
`LibSettlement.computeRepayment` + `LibEntitlement.splitTreasury` etc.
The financial logic doesn't need to know whether the principal arrived
via an AMM swap or a Fusion fill — it sees a principal-asset balance
delta at the diamond and routes the splits the same way.

### 5.4 Slippage / minOutput

v1 enforces slippage via `cfgMaxSwapToRepaySlippageBps` (admin-tunable
default 3%). v1.1 doesn't need a separate cap — the Fusion order's
`minPrincipalOut` is the slippage floor; if the auction doesn't fill at
or above that, the order expires. The borrower sets the floor at
commit time via the dapp; the diamond just enforces "delivered
principal ≥ minPrincipalOut" at finalize.

A new admin knob `cfgMinIntentMinOutputBps` could optionally floor the
borrower's choice (e.g. "you can't commit at worse than 5% slippage
against current oracle price"), but v1.1 defers that to v1.2 — the
borrower is the one waiting, the borrower picks the floor.

### 5.5 Timeout / cancel-by-keeper

If the borrower forgets to cancel an expired intent, the collateral
sits in the custodial slot indefinitely. v1.1 ships a permissionless
`cancelExpiredIntent(uint256 loanId)` that anyone can poke after
`deadline + cancelGrace` to nudge the collateral back to the borrower's
vault. This avoids a stuck-position scenario without giving a keeper
authority over the borrower's collateral.

## 6. Off-chain shape

### 6.1 Intent builder service

The dapp needs to build a signed Fusion order. Three options:

- **Direct integration with 1inch SDK** — the dapp's wagmi client signs
  the order client-side, posts it to 1inch's Fusion endpoint, then
  passes the commit struct to the diamond. No new Vaipakam-side worker.
- **`apps/agent` extension** — add a `/intent/fusion` endpoint that
  brokers the order build + post. Keeps the 1inch API key
  Vaipakam-side; centralizes intent activity for indexer hookups.
- **Hybrid** — the dapp builds + signs the order via the 1inch SDK
  (using a public 1inch endpoint), and `apps/agent` only intermediates
  the *post* step + observability.

**Default pick: hybrid.** Keeps the signing on the borrower's wallet
(Vaipakam never touches the borrower's signature) but routes posting +
observability through `apps/agent` for the indexer's benefit. New
endpoint: `POST /intent/fusion/post`.

### 6.2 Dapp flow

The Loan Details swap-to-repay panel grows a mode toggle (atomic vs
best-price intent). On the intent path:

1. Borrower picks `minPrincipalOut` (with a sane default of "live
   AMM-route quote − 0.5% buffer").
2. Dapp builds the Fusion order (`maker = borrower's vault`,
   `recipient = diamond`, `validTo = now + 5min`).
3. Borrower signs the order with their wallet.
4. Dapp calls `commitSwapToRepayIntent` on the diamond (pulls
   collateral into the custodial slot + records the commit).
5. Dapp posts the signed order to 1inch Fusion (via `apps/agent`).
6. Dapp polls Fusion's API for fill status.
7. When fill lands, anyone (the dapp, a keeper, or any observer) calls
   `finalizeSwapToRepayIntent`. The diamond settles, the loan flips
   Repaid.
8. If the auction expires without fill, the dapp surfaces a "cancel"
   button that calls `cancelSwapToRepayIntent`.

### 6.3 Indexer

Two new event handlers in `apps/indexer/src/chainIndexer.ts`:
- `SwapToRepayIntentCommitted` — record the intent in a new
  `swap_to_repay_intents` D1 table. Loan stays Active in `loans` table.
- `SwapToRepayIntentExecuted` — same terminal-close treatment as
  `SwapToRepayExecuted` (flip loan to Repaid; clear prepay-listing if
  any). Plus delete the corresponding `swap_to_repay_intents` row.
- `SwapToRepayIntentCancelled` — delete the `swap_to_repay_intents`
  row; loan stays Active.

`apps/indexer/scripts/check-event-coverage.mjs` will fail until these
three events are handled (or allowlisted). Adding the typed table is
preferred over allowlisting since intent state IS user-facing
projection (the dapp needs to render "you have a pending intent
fill").

## 7. Sub-card breakdown

Same shape as T-090 v1's four-sub split:

- **Sub 1 contracts** — `SwapToRepayIntentFacet` + storage extension +
  events + Fusion-recipient pattern + producer artifacts. ~3 days.
- **Sub 2 indexer + D1 migration** — event handlers + new
  `swap_to_repay_intents` table + event-coverage allowlist update.
  ~1 day.
- **Sub 3 frontend + agent worker** — mode-toggle UI on Loan Details
  panel, intent-build hook, `apps/agent` `/intent/fusion/post`
  endpoint, fill-polling, Activity / Timeline labels + breakdown for
  the three new event kinds. ~3 days.
- **Sub 4 docs** — functional spec + Advanced User Guide + release
  notes fragment. ~0.5 days.

Sub 1 ships independently. Subs 2-4 are sequenced behind it because the
new events / ABIs come out of Sub 1.

## 8. Decisions still open

These warrant explicit user input before Sub 1 starts:

1. **Intent backend pick.** This doc recommends Fusion. CoWSwap is the
   close runner-up. Confirming the pick gates everything below.
2. **Min-output floor.** v1.1 lets the borrower pick freely; v1.2 adds
   `cfgMinIntentMinOutputBps`. Confirm v1.1 ships without that floor.
3. **Cancel-by-keeper grace.** Setting `cancelGrace` too short means
   keepers race the borrower's own cancel. Default proposal: 24 hours
   after `deadline`.
4. **Recipient pattern vs callback pattern.** This doc picks the
   Fusion-recipient model (passive). If UniswapX-style callback
   patterns are preferred (lower latency between fill + waterfall,
   higher complexity), Sub 1 needs to switch shape — confirm before
   coding.
5. **Single-chain or multi-chain at v1.1.** The atomic v1 ships on every
   chain Vaipakam supports. v1.1 should probably ship intent-based on
   Base + Arbitrum first (largest TVL chains where solver depth
   matters), with Sepolia testnet for QA. Confirm chain scope.

## 9. Out of scope for v1.1 (deferred to v1.2+)

- Multi-source intent comparison (Fusion + CoW + UniswapX side-by-side
  with auto-routing to the best-priced backend).
- NFT-collateral intent-based settlement (T-086 prepay-listing covers
  a different version of this; intent-based NFT settlement is its own
  design effort).
- Cross-chain intent settlement (CCIP-mediated; out of scope for the
  v1.1 surface).
- Solver-set comparison telemetry for governance tuning.

## 10. References

- Existing T-090 v1 design doc: `docs/DesignsAndPlans/SwapToRepay.md`.
- T-090 v1 release notes: `docs/ReleaseNotes/ReleaseNotes-2026-06-07.md`.
- T-090 v1 functional spec entries: `docs/FunctionalSpecs/WebsiteReadme.md`
  (search for "swap-to-repay").
- 1inch Fusion docs: https://docs.1inch.io/docs/fusion-swap/introduction
- CoWSwap protocol docs: https://docs.cow.fi/
- UniswapX protocol docs: https://docs.uniswap.org/contracts/uniswapx/overview
