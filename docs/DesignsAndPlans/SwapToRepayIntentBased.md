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

Two cancel surfaces. The borrower has full control of their own
collateral the moment the auction ends; the permissionless safety net
only exists for borrower-AFK / wallet-dead scenarios.

- **`cancelSwapToRepayIntent(uint256 loanId)`** — borrower-NFT-owner
  only. Callable any time after `commit.deadline` (the Fusion auction
  end). Pulls the custodial collateral back to the borrower's vault
  via the standard `vaultDepositERC20` path; clears the commit slot.
  The dapp's intent panel surfaces this as an enabled "Cancel & return
  collateral" button the moment the auction expires un-filled. This
  is the borrower's clean recovery path — they can immediately commit
  a fresh intent, fall back to atomic v1, or just walk away.
- **`cancelExpiredIntent(uint256 loanId)`** — permissionless. Callable
  after `commit.deadline + cancelGrace` (default 24h). Same effect:
  custodial collateral returns to the **borrower's vault** (never the
  caller's wallet — no incentive abuse), commit slot clears. This
  exists only so a borrower-AFK / dead-wallet scenario can't strand
  collateral indefinitely. The 24h gap is generous: the borrower gets
  first crack at a clean cancel without keepers racing them.

**No-double-commit guard.** `commitSwapToRepayIntent` reverts with
`IntentAlreadyCommitted(loanId)` if `s.intentCommits[loanId]` is
non-zero. Without this guard, a fresh commit could overwrite a live
commit's storage slot while the first auction is still running, and
collateral pulled by the first commit would be stranded. The borrower
must cancel the existing commit before placing a new one.

### 5.6 Admin enable flag — `cfgIntentSwapToRepayEnabled`

The v1.1 surface ships on every chain but is **default-OFF**. An admin
flag controls per-chain rollout:

- Storage: append `bool cfgIntentSwapToRepayEnabled` to
  `ProtocolConfig`.
- Setter: `ConfigFacet.setIntentSwapToRepayEnabled(bool)`. ADMIN_ROLE
  pre-handover; timelock post-handover. Emits
  `IntentSwapToRepayEnabledSet(bool)` for audit / indexer surfacing.
- Getter: `getIntentSwapToRepayEnabled() returns (bool)`.
- Enforcement: all three intent-facet entry points (`commit...`,
  `finalize...`, `cancel...`) check the flag and revert with
  `IntentSurfaceDisabled()` when false — clean rejection at the entry,
  not a downstream revert.
  - **Exception**: `cancelSwapToRepayIntent` AND `cancelExpiredIntent`
    skip the flag check IFF there's an existing commit slot for that
    loan. Otherwise a borrower whose chain had the flag toggled off
    *after* they committed would be unable to recover their custodial
    collateral.

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
   `loanId`. A solver can't fulfil loan A's intent and have the
   proceeds credited to loan B — the orderHash → loanId mapping is
   enforced at finalize (`s.intentCommits[loanId].orderHash` must
   match the order Fusion filled into the diamond).

One UX wart (NOT a security issue): there's a brief window between
fill (principal lands) and finalize (waterfall runs) where the loan
stays Active in indexed views even though the principal is already
sitting custodially. No theft vector — `finalize`'s routing is
determined by the loan struct. The window is closed by the
permissionless `finalize` call that any observer (the dapp, a keeper,
the indexer's catch-up worker) can poke immediately upon seeing the
Fusion fill event.

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

## 8. Decisions closed (resolved 2026-06-07)

All five open checkpoints have explicit picks. Sub 1 can start.

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
