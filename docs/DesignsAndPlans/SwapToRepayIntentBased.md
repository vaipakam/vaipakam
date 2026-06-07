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

**Integration shape for Vaipakam:** the diamond is the Fusion order
`maker`, `recipient`, AND `postInteraction` target — see §5.1 for
the final architecture. The diamond signs the orderHash via ERC-1271
(no borrower-side off-chain signature needed). On fill, Fusion's
`Settlement` contract transfers the principal to the diamond and
calls `diamond.postInteraction(...)` atomically, which runs the
full settlement waterfall inside the solver's fill tx. (Earlier
revisions of this section described a "vault as maker, diamond as
passive recipient" shape; that was rejected during Codex round-1
review — it left the orderHash → loanId binding unenforceable, the
balance-delta finalize step racy, and the cross-loan substitution
vector open. The final architecture closes all three.)

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

Lives at `contracts/src/facets/`. The facet uses Fusion's native
**postInteraction hook** so the swap fill, the principal delivery,
and the full settlement waterfall all execute atomically inside the
solver's fill transaction — there is no separate finalize step,
no idle window between fill and waterfall, no fill-vs-cancel race.

Eligibility (mirrors v1's `SwapToRepayFacet` gating exactly):

- Caller of `commit`: current borrower-position-NFT owner. NFT
  authority gates every borrower-facing surface across Vaipakam.
- Loan shape: ERC20-on-ERC20 only. **NFT-collateral loans are out
  of scope** — those are handled by T-086 prepay-listing (Seaport
  flow), not by swap-to-repay v1 or v1.1.
- Both legs Liquid (Chainlink feed + v3-style AMM pool + $1M volume).
  **Illiquid ERC20 collateral is rejected at commit** with
  `UnsupportedLoanShape` — Fusion solvers can't price illiquid assets
  reliably. Illiquid ERC20 loans fall back to the existing illiquid
  paths (HF-liquidation transfers collateral in-kind to the lender;
  time-default same; direct-repay with the borrower paying
  principal-asset out of pocket).
- Lender-self-repay guard: caller ≠ current lender-NFT holder AND
  caller ≠ `loan.lender`.
- Active status only, not past `endTime + gracePeriod`.

Phase 1 surface — three external entry points:

- **`commitSwapToRepayIntent(uint256 loanId, FusionOrderFields calldata order)`** —
  Borrower-NFT-owner-only. The `order` parameter carries every
  structured field of the Fusion order (NOT just an opaque hash —
  Codex round-2 P1 #1). Sequence:
  1. Verify all eligibility gates above.
  2. Verify `order.maker == address(this)`, `order.recipient ==
     address(this)`, `order.makerAsset == loan.collateralAsset`,
     `order.takerAsset == loan.principalAsset`, `order.makerAmount
     == loan.collateralAmount`, `order.deadline >= block.timestamp +
     cfgIntentMinAuctionSeconds`, `order.deadline <= block.timestamp
     + cfgIntentMaxAuctionSeconds`, `order.extension` includes the
     diamond's `postInteraction` callback target. Revert
     `IntentOrderFieldsMismatch(field)` on any mismatch.
  3. Recompute the orderHash on-chain from `order`'s fields using
     Fusion's canonical hash function (must match what Fusion's
     contract computes during the fill); this is the hash the
     diamond's ERC-1271 will bless.
  4. **Pre-commit HF gate** (Codex round-2 P1 #2 first half): compute
     the loan's live health factor via `RiskFacet.calculateHealthFactor`.
     Revert `IntentBlockedHFTooLow(currentHF, minHF)` if HF <
     `cfgIntentMinCommitHFBps` (default 1.2e18 = 120%). This blocks
     an already-stressed borrower from using intent as a stall
     tactic during a collateral price drop; lender exposure is
     bounded because borrowers near liquidation can't enter the
     intent surface at all.
  5. No-double-commit guard: revert `IntentAlreadyCommitted(loanId)`
     if `s.intentCommits[loanId].orderHash != 0`.
  6. **OrderHash uniqueness** (Codex round-2 P1 #6): revert
     `IntentOrderHashAlreadyInUse(orderHash)` if
     `s.orderHashToLoanId[orderHash] != 0`. Prevents a second loan
     from clobbering the first's reverse-index mapping.
  7. minOutput floor: compute `floor = lenderLeg + treasuryLeg` from
     `IVaipakamPrepayContext.getPrepayContext(loanId, block.timestamp)`.
     **Floor is denominated in the loan's PRINCIPAL asset** — it's
     the amount that needs to come back from the swap to cover the
     debt (Codex round-3 P1 #1). Compared against the Fusion order's
     **`takerAmount` (principal side)**, NOT `makerAmount` (collateral
     side):
     ```
     required = floor × (10_000 + cfgIntentMinOutputBufferBps) / 10_000
     if (order.takerAmount < required) revert IntentMinOutputBelowFloor(order.takerAmount, required);
     ```
     This is unit-safe across any collateral/principal pair with
     mismatched prices or decimals — the comparison is principal-
     vs-principal. The Fusion `makerAmount` is informational at
     commit (it equals `loan.collateralAmount` per field-validation
     step 2) and the floor check has no opinion on it.
  8. Pull the pledged collateral from the borrower's vault into the
     diamond's custodial slot via `VaultFactoryFacet.vaultWithdrawERC20`.
  9. **Aggregate allowance management** (Codex round-2 P2 #7): the
     diamond tracks `s.intentAggregateAllowance[token]` — the sum
     of all live custodial collaterals per collateral token. On
     commit, add `order.makingAmount` to the aggregate and
     reapprove Fusion's ALLOWANCE_TARGET to the new aggregate
     (zero-then-set for USDT). On fill / cancel, subtract consumed
     amount + remaining custodial from the aggregate and reapprove
     to the new lower aggregate. This serializes correctly across
     multiple concurrent intents on the same collateral token —
     no allowance can be reduced below the sum of outstanding
     maker amounts.
  10. Record commit + reverse-index. Emit `SwapToRepayIntentCommitted`.

- **`postInteraction(...)`** — *Called by Fusion's `LimitOrderProtocol`
  during the fill transaction*, NOT externally callable by users.
  Marked `nonReentrant` against the diamond's standard reentrancy
  guard (Codex round-2 P1 #9 — without it a callback-capable token
  or malicious recipient could reenter the diamond mid-settlement).
  Sequence:
  1. **Authorized-caller check** (Codex round-2 P1 #5): revert
     `IntentPostInteractionUnauthorized(msg.sender)` unless
     `msg.sender == cfgFusionLimitOrderProtocol` for this chain.
     The protocol address is recorded in `ProtocolConfig` at deploy
     and admin-rotatable via `ConfigFacet.setFusionLimitOrderProtocol`.
     Without this check any external caller could supply
     attacker-chosen `consumed`/`delivered` and trick the diamond
     into settling the wrong loan against unrelated principal-token
     balance.
  2. Reverse-index lookup: `loanId = s.orderHashToLoanId[orderHash]`.
     Revert `IntentNotRegistered(orderHash)` if zero.
  3. **Live floor re-check** (Codex round-2 P1 #8): recompute
     `liveFloor = lenderLeg + treasuryLeg` via
     `IVaipakamPrepayContext.getPrepayContext(loanId, block.timestamp)`.
     `commit.minPrincipalOut` was static at commit time; live
     `lenderLeg` can grow up to 5% from `calculateLateFee` for
     post-maturity loans (the 2% intent buffer wouldn't cover that
     gap). Revert `IntentDeliveredBelowLiveFloor(delivered, liveFloor)`
     if `delivered < liveFloor`. Fusion's contract reverts the
     fill on our revert, the borrower's collateral stays in
     custody, and the borrower can cancel + retry with a higher
     committed minOutput.
  4. Refund unconsumed custodial collateral (§5.9) to the
     **commit-time-of-record borrower vault** (`loan.borrower`),
     NOT the current NFT-owner's vault (Codex round-2 P1 #3 —
     `RiskFacet.triggerLiquidation` and `DefaultedFacet.markDefaulted`
     both withdraw from `loan.borrower`'s vault; landing residual
     elsewhere would strand it for those recovery paths). Surplus
     principal (delivery above lender + treasury) routes to the
     **current borrower-NFT-owner's EOA** — that's the
     borrower-friendly v1 pattern that mirrors `swapToRepayFull`.
  5. Run the canonical settlement waterfall using the same Lib calls
     as v1's `swapToRepayFull`.
  6. Decrement the per-token aggregate allowance (§5.1 step 9).
  7. Clear `intentCommits[loanId]` and `orderHashToLoanId[orderHash]`.
  8. Emit `SwapToRepayIntentFilled(loanId, orderHash, consumed,
     delivered, residualRefunded)`.
  All atomic in one tx — fill + waterfall + cleanup.

- **`cancelSwapToRepayIntent(uint256 loanId)`** — Current
  borrower-NFT-owner only (Codex round-1 P2 #6 — authority follows
  the NFT, never freezes to the commit-time holder). Callable any
  time after `commit.deadline`. **Pre-check (round-1 P1 #4):** if
  the orderHash is no longer fillable per Fusion (i.e. the order
  filled while the user was reading the page), revert
  `IntentAlreadyFilled` so the user can't accidentally clear a commit
  whose principal already landed. Cancels Fusion-side via the
  protocol's `cancelOrder(orderHash)` (idempotent / no-op if already
  expired), returns the custodial collateral to **`loan.borrower`'s
  vault** (the commit-time borrower-of-record, where RiskFacet,
  DefaultedFacet, and RepayFacet recovery paths look for it — see
  §5.5 for the full authority-vs-return-target rationale) via the
  internal direct-credit pattern (§5.3), clears the commit slot.
  Emits `SwapToRepayIntentCancelled`.

- **`cancelExpiredIntent(uint256 loanId)`** — Permissionless safety
  net. Callable after `commit.deadline + cfgIntentCancelGraceSeconds`
  (default 24h). Same already-filled pre-check; collateral always
  returns to **`loan.borrower`'s vault** (never the caller's
  wallet — no incentive abuse). Emits
  `SwapToRepayIntentCancelled` with `cancelledBy = msg.sender` for
  observability. Bypasses the §5.6 admin-flag check IFF a commit
  exists, so a chain-toggle-off can't strand custodial collateral.

### 5.2 Storage

Append-only to `LibVaipakam`:

```
struct SwapToRepayIntentCommit {
    bytes32 orderHash;            // Fusion order hash — primary key for ERC-1271 + postInteraction lookup
    uint64  deadline;
    uint256 minPrincipalOut;      // §5.4 floor enforced at commit + postInteraction
    uint256 custodialCollateral;  // exact amount pulled from vault — needed for partial-fill refund (§5.9)
    address committedByForRecord; // commit-time borrower-NFT holder, for activity surfacing only
}
mapping(uint256 loanId => SwapToRepayIntentCommit) intentCommits;
mapping(bytes32 orderHash => uint256 loanId) orderHashToLoanId; // reverse index for postInteraction + ERC-1271 lookup
```

The reverse index is load-bearing: when Fusion calls
`diamond.isValidSignature(orderHash, sig)` during the fill or
`diamond.postInteraction(...)` after the swap, the diamond has only
the orderHash — it needs the loanId to look up the commit. The
forward map `intentCommits` is keyed by loanId for the
borrower-facing surfaces (`commit`, `cancel`).

The `committedByForRecord` field is *not* used for authority decisions
— it's a fixed record of who initiated the commit so activity
indexing can attribute the row consistently even if the borrower NFT
transfers mid-auction. Cancel authority always follows the **current**
borrower-NFT holder (Codex round-1 P2 #6).

### 5.3 Settlement waterfall — atomic inside postInteraction

The settlement waterfall is identical to v1 `swapToRepayFull` and runs
inside the postInteraction hook (in the same transaction as the
Fusion fill). Reuses every Lib call from §3 verbatim:
`LibSettlement.computeRepayment`, `LibEntitlement.{settlementInterest,
splitTreasury}`, `LibPrepayCleanup.clearActiveListing`,
`LibVPFIDiscount.settleBorrowerLifProper`,
`LibInteractionRewards.closeLoan`, `LibFacet.{getTreasury,
recordTreasuryAccrual}`.

Custodial → vault return paths use **direct diamond → vault transfer
followed by `LibVaipakam.recordVaultDeposit`** (the internal helper
that updates the protocol-tracked-balance counter without pulling
fresh tokens from a wallet). Critically, this is NOT the public
`VaultFactoryFacet.vaultDepositERC20` path — that one pulls from
the caller via allowance and would either revert here (no allowance)
or charge the borrower twice (Codex round-1 P1 #3). The
diamond-held-tokens → vault pattern is the same one
`LibPrepayCleanup` uses on prepay-listing teardown.

The financial logic doesn't need to know whether the principal
arrived via an AMM swap or a Fusion fill — postInteraction passes the
exact delivered amount, the waterfall runs the same splits, and any
favourable-quote surplus principal lands in the current
borrower-NFT-owner's wallet (matching v1's borrower-friendly surplus
routing).

### 5.4 minOutput floor — reuse the NFT auction prepay formula

v1 enforces slippage via `cfgMaxSwapToRepaySlippageBps` (admin-tunable,
default 3%). v1.1 doesn't use a slippage cap at all — the order's
`minPrincipalOut` IS the floor. But the borrower can't pick that floor
freely: it must cover the full debt obligation plus a safety buffer.

The canonical formula already exists for the NFT auction prepay-listing
flow (T-086 §17.5-bis), at
`contracts/src/facets/NFTPrepayListingAtomicFacet.sol:267-295`:

```
floor    = lenderLeg + treasuryLeg              // full settlement entitlement
minOut   = floor × (10_000 + bufferBps) / 10_000
```

Where `(lenderLeg, treasuryLeg)` come from
`IVaipakamPrepayContext.getPrepayContext(loanId, timestamp)` — the
context computes:

- `lenderLeg` = principal + interest (full-term snapshot if the loan
  was created with `useFullTermInterest = true`, pro-rata otherwise) +
  any accrued late-fee leg.
- `treasuryLeg` = the protocol's cut on the interest leg per the
  current `cfgTreasuryFeeBps`.

**v1.1 reuses this verbatim.** Two changes vs the NFT path:

1. A new admin knob `cfgIntentMinOutputBufferBps` (default 200 bps =
   2%) separate from `cfgPrepayListingBufferBps` (currently 500 bps =
   5%). The NFT-auction buffer absorbs resale-volatility risk and
   stale-listing risk; the intent buffer only absorbs the gap between
   commit and fill (max ~5 minutes) plus solver-side rounding. 2% is
   ample for that window.
2. The buffer-not-configured guard from
   `PrepayListingBufferNotConfigured` becomes
   `IntentMinOutputBufferNotConfigured`; the
   `cfgIntentMinOutputBufferBps` admin knob must be set by deploy
   bootstrap before the surface can be enabled (§5.6 below).

`commitSwapToRepayIntent` enforces the floor at commit time:

```
PrepayContext pctx = IVaipakamPrepayContext(this).getPrepayContext(loanId, block.timestamp);
uint256 floor  = pctx.lenderLeg + pctx.treasuryLeg;
uint256 minOut = (floor * (10_000 + s.cfgIntentMinOutputBufferBps)) / 10_000;
if (commit.minPrincipalOut < minOut) revert IntentMinOutputBelowFloor(commit.minPrincipalOut, minOut);
```

The `postInteraction` hook re-asserts the floor (against the *live*
recomputed `lenderLeg + treasuryLeg` at fill time, see §5.1
postInteraction step 3) — so even if the solver overdelivers (better
than the committed `minOutput`), the assertion stays correct, and
any favourable surplus flows to the borrower's EOA via the same waterfall
v1 uses.

### 5.5 Cancel paths — borrower button + permissionless safety net

Two cancel surfaces. The current borrower-NFT-owner has full control
of their own collateral the moment the auction ends; the
permissionless safety net only exists for AFK / wallet-dead scenarios.

**Cancel authority follows the current borrower-NFT owner**, not the
commit-time owner (Codex round-1 P2 #6). If the borrower NFT
transfers mid-auction, the new holder gets cancel rights immediately
on deadline — consistent with Vaipakam's protocol-wide convention
that authority + claim rights travel with the NFT.

**Already-filled pre-check.** Both cancel paths first check Fusion's
`LimitOrderProtocol.remainingInvalidatorForOrder(diamond, orderHash)`
(or equivalent). If the order is already fully filled, the cancel
reverts with `IntentAlreadyFilled` — the principal has already
arrived and postInteraction either ran or is the next step; clearing
the commit here would either lose the principal in storage or let
the borrower walk away with both collateral and principal (Codex
round-1 P1 #4).

- **`cancelSwapToRepayIntent(uint256 loanId)`** — current
  borrower-NFT owner only (authority gate). Callable any time after
  `commit.deadline`. Already-filled pre-check; cancels Fusion-side
  via `cancelOrder(orderHash)`; transfers the custodial collateral
  directly to the **`loan.borrower` vault** (the commit-time
  borrower-of-record, NOT the current NFT owner's vault — Codex
  round-2 P1 #3) via `LibVaipakam.recordVaultDeposit`; decrements
  the per-token aggregate allowance (§5.1 step 9); clears
  `intentCommits[loanId]` and `orderHashToLoanId[orderHash]`. The
  dapp's intent panel surfaces this as an enabled "Cancel & return
  collateral" button the moment the auction expires un-filled. The
  borrower can immediately commit a fresh intent, fall back to
  atomic v1, or walk away. *Why authority is "current NFT owner" but
  return target is "commit-time borrower vault":* claim rights for
  initiating the action travel with the NFT, but the cancelled
  collateral must land where the recovery paths (`RiskFacet`,
  `DefaultedFacet`) look for it — both withdraw from
  `loan.borrower`'s vault.
- **`cancelExpiredIntent(uint256 loanId)`** — permissionless.
  Callable after `commit.deadline + cfgIntentCancelGraceSeconds`
  (default 24h). Same already-filled pre-check, same return target
  (`loan.borrower`'s vault), same aggregate-allowance + cleanup
  pattern. Exists only so a borrower-AFK / dead-wallet scenario
  can't strand collateral indefinitely.

**No-double-commit guard.** `commitSwapToRepayIntent` reverts with
`IntentAlreadyCommitted(loanId)` if `s.intentCommits[loanId]` is
non-zero. Without this guard, a fresh commit could overwrite a live
commit's storage slot while the first auction is still running, and
collateral pulled by the first commit would be stranded. The current
borrower-NFT-owner must cancel the existing commit before placing a
new one.

### 5.6 Admin enable flag — `cfgIntentSwapToRepayEnabled`

The v1.1 surface ships on every chain but is **default-OFF**. An admin
flag controls per-chain rollout:

- Storage: append `bool cfgIntentSwapToRepayEnabled` to
  `ProtocolConfig`.
- Setter: `ConfigFacet.setIntentSwapToRepayEnabled(bool)`. ADMIN_ROLE
  pre-handover; timelock post-handover. Emits
  `IntentSwapToRepayEnabledSet(bool)` for audit / indexer surfacing.
- Getter: `getIntentSwapToRepayEnabled() returns (bool)`.
- Enforcement: `commitSwapToRepayIntent` checks the flag and reverts
  with `IntentSurfaceDisabled()` when false. `postInteraction` doesn't
  need the flag check because it can only be reached via a live
  commit — and no fresh commits exist while the flag is off.
  `cancelSwapToRepayIntent` AND `cancelExpiredIntent` skip the flag
  check IFF there's an existing commit slot for that loan; otherwise
  a borrower whose chain had the flag toggled off *after* they
  committed would be unable to recover their custodial collateral.

Initial rollout (per §8.5): **Base + Arbitrum first** (deepest Fusion
solver depth among the chains Vaipakam supports), Sepolia for QA.
Other chains stay OFF until governance toggles them on.

### 5.7 MEV-resistance — design notes for auditors

The intent-based path is intentionally MEV-resistant across every
surface. Recording the analysis here so a future auditor doesn't need
to re-derive it:

1. **The swap itself.** Fusion's whole architecture is MEV-resistant
   by design — resolvers compete in an off-chain Dutch auction; the
   winning resolver internalizes execution to their private mempool /
   book. The swap calldata never sits in the public mempool waiting
   to be sandwiched. This is a primary feature of intent-based
   protocols, not a property of Vaipakam's integration.
2. **`postInteraction` front-running.** The hook is not externally
   callable — `msg.sender` must be `cfgFusionLimitOrderProtocol`
   (§5.1 postInteraction step 1). No public-mempool front-run vector
   exists for the settlement step.
3. **Steal-the-principal-during-fill.** The principal lands at the
   diamond inside Fusion's fill transaction and the same tx's
   `postInteraction` routes it exclusively via the loan struct's
   immutable lender / borrower addresses. There is no idle window
   where the principal sits at the diamond unattributed — the
   settlement is atomic with the fill. Custodial accounting is keyed
   by `loanId` + `orderHash`; there's no "claim someone else's
   intent" surface.
4. **Replay.** `postInteraction` clears `intentCommits[loanId]` AND
   `orderHashToLoanId[orderHash]` atomically; the orderHash is
   recorded as filled in Fusion's `LimitOrderProtocol` too (Fusion's
   own anti-replay). The same Fusion order can't be filled twice;
   the same Vaipakam loan can't be settled twice via the same
   intent.
5. **Cross-loan substitution.** The commit binds an `orderHash` to a
   `loanId` via the storage reverse-index (§5.2). The binding is
   enforced *during the fill itself* via the diamond's ERC-1271
   `isValidSignature(orderHash, sig)` — the diamond returns the
   ERC-1271 magic value if and only if `orderHashToLoanId[orderHash]`
   is non-zero AND `s.intentCommits[loanId].orderHash == orderHash`.
   Fusion's `LimitOrderProtocol` rejects fills with an invalid
   signature, so an attacker can't forge a fill that credits loan B's
   commit with the proceeds of a swap they meant to give to loan A.
6. **No fill-vs-finalize race or window** — the postInteraction hook
   runs the settlement waterfall atomically with the Fusion fill in
   the same transaction. There's no idle period where the principal
   sits at the diamond unattributed; the moment Fusion's contract
   transfers the principal in, the same tx settles the loan, clears
   the commit, and emits `SwapToRepayIntentFilled`.

### 5.8 Liquidation / default interaction

A committed intent leaves the loan Active while moving the pledged
collateral out of the borrower vault into diamond custody. During
the 1-3 minute fill window plus the 24h cancel-grace window, the
existing HF-liquidation (`RiskFacet.triggerLiquidation`) and
time-default (`DefaultedFacet.markDefaulted`) paths would otherwise
expect to withdraw `loan.collateralAmount` from `loan.borrower`'s
vault — and find it absent (Codex round-1 P1 #5).

The v1.1 facet handles this with a **two-layer defence** (Codex
round-2 P1 #2): a pre-commit HF gate that keeps already-stressed
borrowers out of the surface entirely, plus a liquidation-side
force-cancel path that handles the residual case where HF degrades
during a live commit.

**Layer 1 — pre-commit HF gate (§5.1 step 4).** `commitSwapToRepayIntent`
rejects with `IntentBlockedHFTooLow` when current HF <
`cfgIntentMinCommitHFBps` (default 1.2e18 = 120%). Borrowers near
liquidation can't enter intent at all. This handles the typical
"stall during a collateral price drop" attack at commit time.

**Layer 2 — liquidation force-cancel.** For the residual case where
HF degrades during a live commit (collateral price falls mid-auction
after a healthy commit landed), `RiskFacet.triggerLiquidation` gets
a new internal force-cancel path:

- `triggerLiquidation(loanId, ...)` checks
  `s.intentCommits[loanId].orderHash`. If non-zero AND current HF <
  `MIN_HEALTH_FACTOR` (the standard 1.0e18 liquidation threshold),
  the facet:
  1. Calls Fusion's `cancelOrder(orderHash)` to invalidate the
     intent on the Fusion side (any in-flight fill against it now
     reverts on the protocol layer).
  2. Returns custodial collateral to `loan.borrower`'s vault via
     the same direct-credit pattern §5.3 uses.
  3. Decrements the per-token aggregate allowance.
  4. Clears `intentCommits[loanId]` + `orderHashToLoanId[orderHash]`.
  5. Emits `SwapToRepayIntentForceCancelled(loanId,
     reason=hfBelowLiquidationThreshold)`.
  6. Proceeds with the standard HF-liquidation flow.
- If a commit exists but HF >= `MIN_HEALTH_FACTOR`, liquidation
  still reverts with `IntentPending(loanId)` — the borrower's
  intent is healthy enough to deserve the 5-min + 24h window.

**`DefaultedFacet.markDefaulted` force-cancel** (Codex round-3 P1 #8).
A borrower committing shortly before `endTime + gracePeriod` would
otherwise gain an extra ~24h delay against default: the intent's
`commit.deadline + cancelGrace` lives 24h past Fusion's 5min
deadline, which extends past `endTime + gracePeriod` if the commit
landed close to maturity. Same force-cancel pattern as
`triggerLiquidation`:

- `markDefaulted(loanId, ...)` checks `s.intentCommits[loanId].orderHash`.
- If non-zero AND `block.timestamp >= loan.endTime + gracePeriod`
  (the loan is already defaultable on time-grounds), the facet
  force-cancels: calls Fusion's `cancelOrder`, returns custodial
  collateral to `loan.borrower`'s vault, decrements aggregate
  allowance, clears commit slots, emits
  `SwapToRepayIntentForceCancelled(loanId, reason=timeDefaultDue)`,
  then proceeds with the standard `markDefaulted` flow.
- If commit exists but loan is NOT yet defaultable (commit landed
  while still inside grace), `markDefaulted` reverts with
  `IntentPending(loanId)` — same as `triggerLiquidation`'s healthy
  path. The default caller can retry after grace.

**`RepayFacet.repayLoan` interaction** (Codex round-3 P1 #7). Third
parties can call `repayLoan` on Active ERC20 loans. If a repay
landed while a swap-to-repay intent has the collateral in custody,
the loan would flip Repaid via the regular path and the custodial
collateral would orphan (no claim, no recovery). Block this with the
same revert pattern:

- `repayLoan(loanId)` and `repayPartial(loanId, amount)` both check
  `s.intentCommits[loanId].orderHash`. If non-zero, revert with
  `IntentPending(loanId)`.
- No force-cancel path here — `repayLoan` is voluntary; whoever
  called it can wait for the borrower's auction + cancel-grace, or
  the borrower can cancel and accept regular repayment manually.
  Unlike liquidation, there's no lender-protection urgency.

**Why HF-1.0 threshold for force-cancel and not HF-1.5 (the
MIN_HEALTH_FACTOR at loan init)?** Force-cancel is a lender-protection
escape hatch — it should fire only when liquidation is otherwise
needed (HF < 1.0). For loans that are still solvent (HF >= 1.0) but
the borrower committed an unfillable intent to stall, the borrower
is the one waiting; their stall hurts them, not the lender. The
intent expires in 5 minutes; the cancel-grace closes in 24h.

### 5.9 Partial fills + residual custodial collateral

Fusion orders typically fill the full maker amount, but partial
fills and solver rounding can leave a small residual of the
custodial collateral unconsumed. The diamond's postInteraction hook
receives `consumed` and `delivered` amounts from Fusion directly —
no balance-delta inference needed.

- If `consumed == custodialCollateral`, the swap consumed
  everything; the residual is zero.
- If `consumed < custodialCollateral`, the difference
  (`residual = custodialCollateral - consumed`) is the unspent
  collateral. The hook transfers `residual` directly to
  **`loan.borrower`'s vault** (the commit-time borrower-of-record
  — same target the cancel paths use; see §5.5 for the
  authority-vs-return-target split rationale) via
  `LibVaipakam.recordVaultDeposit` (same internal helper §5.3 uses),
  in the same atomic transaction as the settlement waterfall.

This closes Codex round-1 P1 #7 — there's no residual-stranding
path on successful fills. The exact accounting (`consumed`,
`delivered`, `residual`) is emitted as part of
`SwapToRepayIntentFilled` so the indexer can surface the breakdown
on Loan Details + Activity.

Note: the §5.4 floor formula already bakes in the principle that
the borrower's committed minOutput must cover the full debt. So
even when the swap consumes less than the full custodial
collateral (because the solver found a route that needed less to
hit `minOutput`), the lender still gets paid in full. The residual
is genuinely "savings" the borrower keeps.

## 6. Off-chain shape

### 6.1 Intent builder service

The diamond is the Fusion order maker, so the borrower never signs an
off-chain Fusion order — Vaipakam never touches the borrower's
signature (intentional simplification + safety property). The
borrower's only signature is on the `commitSwapToRepayIntent` tx
itself, just like every other Vaipakam loan-action surface.

The dapp:
1. Computes the orderHash for a fully-specified Fusion order
   (maker = diamond, recipient = diamond, deadline, makerAsset,
   takerAsset, makerAmount, takerAmount, salt, …) — deterministic
   off-chain hash, no signature required.
2. Submits the orderHash plus the structured order fields as part of
   the `commit` struct to the diamond.
3. After the on-chain commit lands (the diamond is now the registered
   maker of `orderHash` via §5.2's reverse-index + ERC-1271), the
   dapp posts the full order to 1inch Fusion via `apps/agent`.

The `apps/agent` new endpoint: `POST /intent/fusion/post`. It accepts
the orderHash + structured order + the v1.1 facet's commit-tx hash
(for provenance), and forwards to 1inch Fusion's resolver-pickup
endpoint. The API key for 1inch stays Vaipakam-side; the dapp never
touches it directly. Telemetry on the agent worker captures
fill-rate + resolver-set health for governance tuning.

No off-chain signature handling on the dapp side. No 1inch SDK
client-side dependency. The signing surface for Fusion is
entirely on-chain (the diamond's ERC-1271 implementation) — which
means the audit boundary is the diamond's signature-validation
function and the on-chain reverse-index, both inside
`SwapToRepayIntentFacet` + `LibVaipakam`.

### 6.2 Dapp flow

The Loan Details swap-to-repay panel grows a mode toggle (atomic vs
best-price intent). On the intent path:

1. Borrower picks `minPrincipalOut` (default = the §5.4 floor + a
   small UX buffer; the dapp shows the live floor so the borrower
   can override if they want to raise the threshold further).
2. Dapp computes the orderHash for a Fusion order with
   `maker = diamond`, `recipient = diamond`, `validTo = now + 5min`,
   `makerAsset = collateral`, `takerAsset = principal`,
   `makerAmount = loan.collateralAmount`, `takerAmount = minPrincipalOut`.
3. Borrower submits one transaction: `commitSwapToRepayIntent(loanId,
   commit)`. The diamond pulls the borrower's collateral into the
   custodial slot, records the commit + reverse-index, and approves
   Fusion's ALLOWANCE_TARGET. The borrower's *only* signature is on
   this on-chain transaction — there's no off-chain order signature
   to handle (the diamond signs via ERC-1271 inside the fill).
4. Dapp posts the orderHash to 1inch Fusion (via `apps/agent`) so
   Fusion's resolver set picks it up.
5. Dapp polls Fusion's API for fill status — purely informational;
   no diamond-side action needed when the fill lands. The fill
   transaction itself (submitted by the winning solver) runs the
   diamond's `postInteraction`, which settles the loan atomically.
   The dapp observes via the `SwapToRepayIntentFilled` event.
6. If the auction expires without fill, the dapp surfaces a
   "Cancel & return collateral" button that calls
   `cancelSwapToRepayIntent`. The button is gated on
   `now >= commit.deadline AND !alreadyFilled` (the dapp pre-checks
   the second condition via Fusion's API to avoid a wasted gas).

### 6.3 Indexer

Three new event handlers in `apps/indexer/src/chainIndexer.ts`:
- `SwapToRepayIntentCommitted` — record the intent in a new
  `swap_to_repay_intents` D1 table. Loan stays Active in `loans`
  table. Reserved-collateral surfacing: the borrower's vault row
  shows the custodial slot separately so the dapp can render
  "collateral in pending swap-to-repay" distinctly from "available
  collateral".
- `SwapToRepayIntentFilled` — same terminal-close treatment as
  `SwapToRepayExecuted` from v1 (flip loan to Repaid in `loans`;
  clear any prepay-listing; record the principal-received + residual-
  refunded breakdown for activity surfacing). Delete the
  corresponding `swap_to_repay_intents` row.
- `SwapToRepayIntentCancelled` — delete the `swap_to_repay_intents`
  row; loan stays Active. The `cancelledBy` field on the event
  distinguishes borrower-initiated (the regular `cancel`) from
  permissionless-poke (the `cancelExpired` path) for activity feed
  attribution.
- `SwapToRepayIntentForceCancelled` (Codex round-3 P2 #6) — delete
  the `swap_to_repay_intents` row. The loan flips to Defaulted (if
  `reason == timeDefaultDue` or HF-based liquidation actually
  succeeded) or stays Active (if force-cancel ran but liquidation
  reverted downstream). The `reason` enum field
  (`hfBelowLiquidationThreshold`, `timeDefaultDue`) drives the
  activity-feed copy: "intent force-cancelled by liquidation" vs
  "intent force-cancelled by time default". This event is emitted
  by `triggerLiquidation` (§5.8 layer 2) and `markDefaulted` (§5.8
  force-cancel) inside the same tx as the recovery action — the
  indexer can attribute the row by the bundling tx hash.

`apps/indexer/scripts/check-event-coverage.mjs` will fail until
these four events are handled (or allowlisted). Adding the typed
table is preferred over allowlisting since intent state IS
user-facing projection (the dapp needs to render "you have a
pending intent fill").

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

## 8. Decisions closed (resolved 2026-06-07, expanded 2026-06-07 post-Codex)

All five original checkpoints have explicit picks AND the Codex
round-1 architectural findings on PR #412 are folded in (the design
moved from "passive recipient + separate finalize" to "diamond as
maker + Fusion postInteraction hook + ERC-1271 binding" to close
all 7 issues atomically; see §5.1, §5.2, §5.3, §5.5, §5.7, §5.8,
§5.9). Sub 1 can start.

1. **Intent backend: 1inch Fusion** — confirmed. CoWSwap and UniswapX
   stay viable as v1.2+ if Fusion underperforms in production.
2. **Min-output floor: reused from NFT auction prepay-listing.**
   `floor = lenderLeg + treasuryLeg`; `minOutput ≥ floor × (1 +
   cfgIntentMinOutputBufferBps)`, default 200 bps (2%). Borrower
   does NOT pick freely — the floor must cover the full debt
   obligation (principal + interest leg + treasury cut) plus the 2%
   buffer for the commit-to-fill window. Reuses
   `IVaipakamPrepayContext.getPrepayContext(...)` verbatim; same
   pattern as `NFTPrepayListingAtomicFacet:267-295`. See §5.4.
3. **Cancel surface: borrower button at deadline + permissionless
   safety net after 24h.** Two paths:
   - `cancelSwapToRepayIntent` — borrower-NFT-owner only, callable
     immediately after `commit.deadline` (~5 min Fusion auction end).
     The dapp surfaces this as the "Cancel & return collateral" button
     the moment the auction expires un-filled.
   - `cancelExpiredIntent` — permissionless, callable after
     `commit.deadline + 24h`. Borrower-AFK safety net only; collateral
     always returns to the borrower's vault. See §5.5.
4. **Recipient pattern + Fusion postInteraction hook** — confirmed.
   *Decision revised after Codex round-1.* Initial design was
   passive-receive + a separate permissionless finalize call, but
   that left 7 architectural gaps (fill-vs-finalize race; no
   fill-proof; default/liquidation unaware of pending commits;
   partial-fill residuals stranded; cancel after fill;
   `vaultDepositERC20` return path broken; cross-loan substitution
   via balance delta). All seven close at once by having the
   diamond participate atomically in the fill via Fusion's native
   `postInteraction` hook: diamond is the order maker AND the
   recipient AND the post-interaction callback target. The hook
   runs the full settlement waterfall inside the solver's fill tx;
   no idle window; no separate finalize. The diamond signs the
   orderHash via ERC-1271 (the only "signature" Fusion needs).
   §5.1 captures the three external entry points (commit, two
   cancels); §5.3 captures the atomic-fill settlement; §5.7 captures
   the MEV-resistance analysis with the ERC-1271 binding closing
   cross-loan substitution.
5. **Chain scope: ship on every chain but admin-flag default-OFF.**
   New `cfgIntentSwapToRepayEnabled` per-chain boolean; admin enables
   per chain via `ConfigFacet.setIntentSwapToRepayEnabled(bool)`
   (pre-handover ADMIN_ROLE, post-handover timelock). All three entry
   points reject with `IntentSurfaceDisabled()` while OFF. Initial
   rollout: Base + Arbitrum first (deepest Fusion solver depth);
   Sepolia for QA. Other chains stay OFF until governance toggles.
   The flag check is bypassed only for the two cancel paths on a
   pre-existing commit, so a chain-toggle-off can't strand any
   borrower's custodial collateral. See §5.6.

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
