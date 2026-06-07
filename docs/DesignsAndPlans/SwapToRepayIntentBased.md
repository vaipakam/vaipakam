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

- **`commitSwapToRepayIntent(uint256 loanId, FusionOrderCommit calldata commit)`** —
  Borrower-NFT-owner-only. Validates all eligibility gates above plus
  the no-double-commit guard (§5.5). Computes the minOutput floor
  (§5.4); reverts `IntentMinOutputBelowFloor` if
  `commit.minPrincipalOut < floor × (1 + cfgIntentMinOutputBufferBps)`.
  Pulls the borrower's pledged collateral from the vault into the
  diamond's custodial slot keyed by `loanId`. Pre-approves Fusion's
  ALLOWANCE_TARGET for the custodial collateral (zero-then-set so
  USDT-style tokens work). Records the commit in storage. Emits
  `SwapToRepayIntentCommitted`.

- **`postInteraction(...)`** — *Called by Fusion's `LimitOrderProtocol`
  during the fill transaction*, NOT externally. Implements the
  matching Fusion interface. Fusion has already (a) verified the
  diamond's ERC-1271 signature for the orderHash, (b) transferred the
  principal asset to the diamond (the order's `recipient`), and (c)
  pulled the consumed collateral from the diamond. The hook receives
  the exact `consumed` and `delivered` amounts, looks up the commit
  by orderHash, asserts `delivered ≥ commit.minPrincipalOut`, refunds
  any unconsumed custodial collateral to the borrower-NFT-owner's
  vault (§5.9), runs the canonical settlement waterfall using the
  same Lib calls as v1's `swapToRepayFull`, clears the commit slot,
  and emits `SwapToRepayIntentFilled`. All atomic in one tx.

- **`cancelSwapToRepayIntent(uint256 loanId)`** — Current
  borrower-NFT-owner only (Codex round-1 P2 #6 — authority follows
  the NFT, never freezes to the commit-time holder). Callable any
  time after `commit.deadline`. **Pre-check (round-1 P1 #4):** if
  the orderHash is no longer fillable per Fusion (i.e. the order
  filled while the user was reading the page), revert
  `IntentAlreadyFilled` so the user can't accidentally clear a commit
  whose principal already landed. Cancels Fusion-side via the
  protocol's `cancelOrder(orderHash)` (idempotent / no-op if already
  expired), returns the custodial collateral to the current
  borrower-NFT-owner's vault using the internal direct-credit pattern
  (§5.3), clears the commit slot. Emits `SwapToRepayIntentCancelled`.

- **`cancelExpiredIntent(uint256 loanId)`** — Permissionless safety
  net. Callable after `commit.deadline + cfgIntentCancelGraceSeconds`
  (default 24h). Same already-filled pre-check; collateral always
  returns to the **current** borrower-NFT-owner's vault (never the
  caller's wallet — no incentive abuse). Emits
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

`finalizeSwapToRepayIntent` re-asserts the floor against the *actual*
delivered principal — so even if the solver overdelivers (better than
the committed `minOutput`), the assertion stays correct, and any
favourable surplus flows to the borrower's EOA via the same waterfall
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
  borrower-NFT owner only. Callable any time after `commit.deadline`
  (the Fusion auction end). Already-filled pre-check; cancels
  Fusion-side via `cancelOrder(orderHash)`; transfers the custodial
  collateral directly to the current borrower-NFT-owner's vault via
  `LibVaipakam.recordVaultDeposit`; clears the commit slot. The
  dapp's intent panel surfaces this as an enabled "Cancel & return
  collateral" button the moment the auction expires un-filled. The
  borrower can immediately commit a fresh intent, fall back to
  atomic v1, or walk away.
- **`cancelExpiredIntent(uint256 loanId)`** — permissionless.
  Callable after `commit.deadline + cfgIntentCancelGraceSeconds`
  (default 24h). Same already-filled pre-check, same return path —
  collateral always lands in the **current borrower-NFT-owner's
  vault** (never the caller's wallet), commit slot clears. Exists
  only so a borrower-AFK / dead-wallet scenario can't strand
  collateral indefinitely. 24h is generous: the borrower gets first
  crack at a clean cancel without keepers racing them.

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
2. **`finalize` front-running.** The function is permissionless — any
   observer can poke it. Intentionally: it's a public-good call. The
   body reads `principalBalance >= minPrincipalOut`, then runs the
   settlement waterfall (lender vault credit, treasury cut, borrower
   surplus to EOA). All targets are determined by the immutable loan
   struct. No oracle read at finalize, no swap, no arbitrage
   opportunity — whoever calls it gets nothing. The result is
   identical regardless of caller.
3. **Steal-the-principal-between-fill-and-finalize.** Once the
   principal lands at the diamond, the only code path that touches it
   is `finalize` itself, and it routes exclusively via the loan
   struct's immutable lender / borrower addresses. Custodial
   accounting is keyed by `loanId`; there's no "claim someone else's
   intent" surface.
4. **Replay.** `finalize` clears the commit slot; the orderHash is
   recorded as filled in Fusion's `Settlement` contract too (Fusion's
   own anti-replay). The same Fusion order can't be filled twice; the
   same Vaipakam loan can't be finalized twice.
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

The v1.1 facet handles this by **blocking both recovery paths while
a commit is live**:

- `RiskFacet.triggerLiquidation(loanId, ...)` checks
  `s.intentCommits[loanId].orderHash` first. If non-zero, reverts
  with `IntentPending(loanId)`.
- `DefaultedFacet.markDefaulted(loanId, ...)` same check, same revert.

The borrower committed voluntarily and gets the 5-minute auction
plus the 24h cancel-grace window. After the grace expires, the
permissionless `cancelExpiredIntent` returns the collateral to the
borrower's vault, at which point the standard HF-liquidation and
time-default paths pick up again (no special wiring needed — the
collateral is back where they expect it).

**Why block-vs-route-through-custody?** Routing the recovery paths
through the custodial slot (so a triggerLiquidation while a commit
is pending would liquidate the custodial collateral instead) was
considered and rejected for v1.1. Two reasons:

1. The collateral is mid-swap from the protocol's point of view —
   the borrower committed to an outcome where the principal asset
   replaces the collateral. Liquidating mid-swap would mean racing
   Fusion's fill against the diamond's own liquidation transfer,
   with both touching the custodial slot in unpredictable order.
2. The borrower's exposure window for the lender is bounded: the
   maximum delay is `5 min auction + 24h cancel-grace`. Lender HF
   exposure for an extra 24h on an already-committed-to-be-repaid
   loan is materially safer than racing a swap mid-fill.

If a future v1.2 surfaces "intent with lender consent" (lender can
liquidate immediately by force-cancelling the intent), the design
hooks would land in this section.

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
  collateral. The hook transfers `residual` directly to the
  **current** borrower-NFT-owner's vault via
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

`apps/indexer/scripts/check-event-coverage.mjs` will fail until
these three events are handled (or allowlisted). Adding the typed
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
4. **Recipient pattern** — confirmed. Passive-receive model: the
   diamond is the order's `recipient`; Fusion's `Settlement` contract
   transfers the principal asset to the diamond on fill; a separate
   permissionless `finalize` call runs the settlement waterfall. No
   diamond code runs inside the solver's fill transaction. Simpler
   audit surface than the callback pattern, no MEV vector (see
   §5.7). The brief fill-to-finalize idle window is a UX wart, not a
   security issue; closed by the permissionless `finalize` poke.
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
