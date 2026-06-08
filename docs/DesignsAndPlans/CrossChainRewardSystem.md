# Cross-Chain Reward System (T-087): canonical-centric global staking and instant rebates

**Status:** Draft for Codex pre-design review.
**Parent ToDo:** T-087 (`docs/ToDo.md`).
**Operator-internal seed:** `docs/internal/RewardSystemRedesigned.md` (informal source-of-truth notes by the project owner; this design doc is the canonical PR-reviewed counterpart).

## 1. Goal

Make VPFI staking + the fee-discount tier system **global** across every chain Vaipakam deploys on, while keeping the user surface chain-agnostic and the protocol implementation as simple as the pre-live freedom allows.

Concretely, after this lands:

- Every borrower-initiated and lender-initiated fee on **every** chain (Base canonical or any mirror) is charged net of the user's current discount tier at the moment of charge — no separate rebate-claim step in the main flow.
- The tier is derived from a single, authoritative VPFI staking balance held on the **canonical chain (Base) only**. Mirrors hold no VPFI staking surface; their fee path reads a cached tier propagated from Base.
- Treasury fee revenue on every chain feeds a continuous VPFI buyback on Base, recycling fee value into the staking-rewards pool.
- The frontend presents staking as one chain-agnostic feature; one-click switch from any mirror page lands the user on the Base staking flow.

The platform is **pre-live** (no production users), so this design treats ABI-breaking rewrites of `LibVPFIDiscount`, deletion of mirror-chain VPFI staking facets, and storage-layout changes on every chain's diamond as cheap moves. No backwards-compat shims or migration scripts ship.

## 2. Locked-in decisions (from design-iteration round 1)

| ID  | Decision                              | Choice                                                                                                                                     |
| --- | ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| Q1  | Mirror-chain VPFI staking surface     | **Deleted.** Mirrors lose `VPFIDiscountFacet` + `StakingRewardsFacet` + `VpfiBuyAdapter`. `VPFIMirrorToken` is **retained** on mirrors so `InteractionRewardsFacet` can continue to pay local VPFI on claim (see §4.6 for the full reasoning behind keeping the mirror token). |
| Q2  | TWA weighting curve                   | **Two-tier**: last 7 days × 3 + previous 23 days × 1, divided by total weight.                                                              |
| Q3  | Base → mirror CCIP push policy        | **Tier change only, no TTL, no keeper.** Push fires when `oldTier ≠ newTier` after a stake/unstake mutation.                                |
| Q4  | Treasury buyback execution            | **Per-chain accumulate → CCIP remit to Base → Base swap → reward pool.** Plus per-tranche USD cap, 1% slippage cap, randomized swap delay.   |
| Q5  | Consent flag on mirrors               | **Auto-consent at tier ≥ 1**; mirror has no separate consent storage; cached tier is the eligibility signal.                                  |
| —   | Staking-vault architecture            | **Per-user vault** (existing `VaultFactoryFacet` UUPS proxy pattern); single protocol-owned `stakingRewardPool` on Base pays APR.            |

## 3. What the design reuses (no new primitives)

| Existing surface                                  | Role in the new design                                                                                                                |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `VaultFactoryFacet` UUPS proxy per user           | Holds each user's staked VPFI on Base. Diamond reads `vault.balance(VPFI)` to compute tier.                                            |
| `LibVPFIDiscount.rollupUserDiscount(user, bal)`   | Already the integration point at every balance-mutation site. Reworked internally to compute the two-tier TWA + emit `TierComputed`. |
| `LibVPFIDiscount.tryApply` / `tryApplyYieldFee`   | Stay; their internal tier-lookup branches change to read either the local Base vault balance OR (on mirrors) the cached tier slot.    |
| `LibVaipakam.VPFI_TIER{1,2,3,4}_MIN/_DISCOUNT_BPS` | Tier thresholds + BPS unchanged.                                                                                                       |
| `VPFI_PER_ETH_FIXED_PHASE1 = 1e15`                | Existing fixed rate (1 VPFI = 0.001 ETH); `buyVPFIWithETH()` survives unchanged on Base.                                                |
| `VpfiBuyAdapter` / `VpfiBuyReceiver` (T-068)      | **Removed entirely.** With mirror VPFI vaults gone, the cross-chain purchase flow is replaced by the dapp's one-click chain switch to Base. |
| `VaipakamRewardMessenger` (CCIP)                  | Extended with a new `TierUpdated` message kind (Base → mirrors).                                                                       |
| `CcipMessenger` (T-068)                           | Unchanged. The new message kind rides the existing lane.                                                                              |
| `LibSwap.swapWithFailover` (T-090 + T-068)        | Backs the Base-side buyback swap.                                                                                                      |
| `TreasuryFacet`                                   | Adds a `buybackBudget` accumulator per source chain; existing fee write paths credit a configurable bps into it.                       |
| `ConfigFacet`                                     | New knobs: `cfgBuybackFeeBps`, `cfgBuybackMinRemittance`, `cfgBuybackMaxTrancheUsd`, `cfgBuybackSwapSlippageBps`, `cfgTwaRecentDays`. |

## 4. Architecture

### 4.1 Tier resolution — two-tier TWA on Base

For each user, the diamond maintains a **30-slot daily ring buffer** of vault VPFI balance snapshots, indexed by `dayId = block.timestamp / 1 days`. The buffer is updated lazily — on each balance-mutation site (deposit, withdraw, claim, sale settlement, etc.), the diamond fills in any gap days from `lastUpdateDay` to `currentDay - 1` with the *prior* balance (because the balance was unchanged during the gap), then writes today's new balance into `slot[currentDay % 30]`. The TWA is computed on demand by reading the 30 slots, mapping each slot's `dayId` to its weight region, and applying the weighted average.

> **Why a ring buffer, not aggregate sums?** Codex round-1 P1 #3 caught that two aggregate sums (`recentSum`, `olderSum`) cannot be advanced exactly without knowing what balance held during the day that just rolled across the recent/older boundary. Two users with the same aggregate sums but different intra-window balance distributions would produce identical TWAs but actually deserve different ones. The ring buffer carries the full per-day balance distribution and is the simplest exact representation; the gap-fill is O(days-since-last-update) bounded by 30, so cost is capped.

**Weighting + denominator self-seeding:**

```
weight(dayId) = 3 for dayId ∈ [today-6, today]
             = 1 for dayId ∈ [today-29, today-7]
             = 0 otherwise

stakedDays = count of buffer slots with dayId ∈ [today-29, today]
             (capped at 30; equal to 30 for a long-tenured user)

denominator = (3 × min(stakedDays, 7)) + (1 × max(0, min(stakedDays - 7, 23)))
            = 44 once stakedDays ≥ 30

TWA = (Σ balance(dayId) × weight(dayId)) / denominator
```

The self-seeded denominator lets a fresh staker reach a meaningful TWA on day 1 (denominator starts at 3 for one recent day, so TWA = balance immediately) and ramps to the full 44 over 30 days. Codex round-1 P2 #7 caught that a fixed 44 denominator would force a 100-VPFI staker to wait 30 days for tier 1; the self-seeded denominator fixes this.

**Behaviour highlights:**

- **Constant-balance steady state**: balance held at `X` for the past 30 days produces `TWA = X` and no CCIP push fires.
- **Fresh stake with prior empty balance**: a user staking 100 VPFI on day 1 has `stakedDays = 1`, denominator = 3, TWA = (3 × 100 × 1) / 3 = 100 → tier 1 immediately. Larger stakes hit higher tiers immediately; smaller stakes ramp linearly as `stakedDays` grows.
- **Post-unstake decay**: a user who unstakes drops their balance to 0 but the ring buffer still carries non-zero balances for the prior days that haven't rolled out. The TWA decays daily as zero-balance days replace the non-zero ones. The mirror cache holds at the pre-unstake tier until the TWA crosses a tier boundary — see §4.3 for the push policy that handles this case.

**Storage exposure for accumulator:** 1 packed slot per user holding 30 × `uint80` balance snapshots, plus `(uint16 lastUpdateDayId, uint16 firstWriteDayId)` — fits in 2 slots cold per active staker. Detailed layout in §5.

### 4.2 Per-user staking on Base

No changes to the existing vault-proxy pattern. Each user has a `VaipakamVaultImplementation` ERC1967 proxy deployed by `VaultFactoryFacet` on first interaction. The user's VPFI tokens sit in their own proxy; the diamond reads `vault.balance(VPFI)` for tier computation and `vault.transfer(VPFI, ...)` for stake/withdraw moves.

**Why per-user vault, not commingled pool:**

| Concern                                       | Per-user vault outcome                                  | Hypothetical commingled-pool outcome                                       |
| --------------------------------------------- | ------------------------------------------------------- | -------------------------------------------------------------------------- |
| Bug-blast radius                              | A vault bug touches only the affected user.             | A pool bug can drain every user's stake.                                   |
| Sanctions / regulatory hygiene                | Freezing one vault doesn't touch other users.           | Freezing a sanctioned beneficiary requires share-tracking gymnastics.       |
| Share-math complexity (proportional rewards) | Trivial: stake share = `vault.balance / totalStaked`.    | Needs an `stkVPFI` receipt token + snapshot logic for proportional accrual. |
| Audit surface                                 | Reuses the same pattern every other asset class follows. | Introduces a new staking-share token + its own accounting library.          |
| Pre-live cost                                 | Zero — uses existing `VaultFactoryFacet`.                | Multi-week rebuild for negative architectural payoff.                       |

**Staking rewards inventory:** a single protocol-owned `stakingRewardPool` (the existing 55.2M VPFI allocation, untouched by this design) lives in a diamond-controlled slot on Base. The continuous treasury buyback (§4.5) adds to this pool. Users withdraw earned rewards into their own vault via the existing `StakingRewardsFacet.claimStakingRewards()` path — no changes to that surface.

### 4.3 Cross-chain tier propagation — CCIP `TierUpdated` message

**Two-step path (Codex round-2 P1 #4)**: the design decouples *state mutation* from *CCIP broadcast* so Base fee paths (loan-init, repay, preclose) don't have to carry `msg.value` for CCIP gas.

1. **State mutation step** — Any balance-mutating call site invokes `LibVPFIDiscount.rollupUserDiscount(user, currentBal)`. This:
   - Advances the ring buffer to today (lazy gap-fill).
   - Recomputes the current tier from the buffer.
   - **Computes the projected expiry**: scans the future trajectory of the ring buffer assuming no further balance mutations (older days roll out, all newer days hold the current balance), determines the dayId on which the projected TWA will first cross BELOW the current tier boundary, and stores `tierExpiryDayId[user] = thatDayId`. This is the closed-form solution the mirror later uses to enforce decay-driven expiry without a Base round-trip.
   - Increments `s.userTierPushNonce[user]` (uint64, monotonic) ONLY IF the tier crossed a boundary OR the caller signals a forced push.
   - Emits `BaseTierChanged(user, oldTier, newTier, computedAt, nonce, tierExpirySec)`.
   - **Does NOT send any CCIP messages.** No `msg.value` required.

2. **Broadcast step** — A *payable* entry point `broadcastTierUpdate(address user, uint64[] dests)` (callable by anyone) reads the current tier + the projected expiry from the user's accumulator state, then for each destination in `dests` checks whether the cached `userTierLastPushedNonce[user][dest] < userTierPushNonce[user]`. For destinations where the nonce is stale, the function calls `VaipakamRewardMessenger.sendTierUpdate(...)` with the payload `(uint8 kind, address user, uint8 tier, uint40 computedAt, uint64 nonce, uint40 tierExpirySec)`. The caller pays the CCIP fee via `msg.value`; `nonce` is the strict ordering key.

**Projected tier-decay expiry (Codex round-3 P1 #1)**: the central observation is that, under the ring-buffer + two-tier weighting, the TWA's future trajectory is FULLY DETERMINED by the current ring-buffer state if no further balance mutations occur. So Base can compute, at push time, the EXACT day on which the projected TWA crosses below the current tier boundary, and embed that future moment in the CCIP payload as `tierExpirySec` (uint40 seconds, absolute timestamp).

On the mirror, the fee path applies the discount ONLY IF `now < userTierCache[user].tierExpirySec`. Past expiry, the cache is stale-by-construction and the user pays at tier 0 until a fresh push arrives. This:

- Pushes the decay-handling logic onto Base (where the ring buffer state lives) at push time.
- Adds a single uint40 to the payload (no balance trajectory propagation).
- Eliminates the keeper requirement: pure on-chain enforcement.
- Pre-empts the "stake-then-unstake-then-exploit-stale-mirror-tier" vector Codex flagged: the moment the unstake happens, the projected expiry is recomputed, the new (much sooner) expiry is propagated on the next push, and mirrors honour the new expiry.

The `cfgMirrorTierMaxAgeSec` knob remains as a *secondary* safety cap (the on-mirror "even if Base hasn't pushed an update in N months, treat the cache as expired"), but the primary correctness path is now the projected expiry baked into the cached tier itself.

**The dapp orchestrates step 2** after every stake/unstake action: it asks the user to confirm a small native-gas top-up to fund the CCIP broadcasts to all live mirror destinations. The user pays once per stake action; mirrors get the update in CCIP-DON time (typically <2 minutes). For users who don't want to pay (or transact through a relayer), step 1 alone still updates the user's tier on Base; their cached tier on mirrors stays stale until somebody (themselves, a keeper, a friend) calls `broadcastTierUpdate`.

**Strict ordering via per-user nonce (Codex round-2 P1 #1)**: `block.timestamp`-based ordering isn't strict — two tier-changing actions in the same block both stamp the same `computedAt`. The monotonic per-user `nonce` is the ordering key the mirror uses (`if msg.nonce <= s.userTierCache[user].lastNonce, drop`). `computedAt` is retained in the payload for forensics and dapp display, not for ordering.

**Per-destination tracking (round-1 P2 #11)**: `s.userTierLastPushedNonce[user][destSelector]` is set when `broadcastTierUpdate` sends the message. Adding a new mirror later automatically gets a push on the next `broadcastTierUpdate` call because its slot is `0 < currentNonce`. The dapp's "Active destinations" list dynamically reads the messenger's `broadcastDestinations` array; users adding a stake see the broadcast UI populated with whichever chains are live.

**Re-send semantics for failed deliveries (Codex round-2 P1 #2)**: `broadcastTierUpdate` is *idempotent* in this sense: if the CCIP send doesn't reach the mirror (router accepts but executor fails permanently), the mirror's cache stays at the pre-failure value, while Base's `userTierLastPushedNonce` shows the send was attempted. The user can call a `forceResendTierUpdate(user, dests)` overload that bypasses the de-dup check and re-sends regardless of `userTierLastPushedNonce`. Keepers can do the same when monitoring CCIP delivery status off-chain. The standard `broadcastTierUpdate` is the cheap "send if not yet sent" path; the force version is the recovery path.

**Sender authentication (round-1 P1 #2)**: the mirror inbound handler validates both `srcChainSelector == s.baseChainSelector` AND `authenticatedSender == s.baseAuthorizedMessenger`. The authenticated sender comes from CCIP's `Any2EVMMessage.sender` field. Governance sets `baseAuthorizedMessenger` on each mirror via `setBaseAuthorizedMessenger(...)`.

**Mandatory tier freshness on mirrors (Codex round-2 P1 #3)**: the mirror fee path additionally enforces a maximum cache age. At fee-application time, `LibVPFIDiscount.tryApply` / `tryApplyYieldFee` compare `now - userTierCache[user].lastUpdateSec` against `cfgMirrorTierMaxAgeSec` (default 60 days, governance-bounded 30-180 days). If the cache is older than the bound, the fee is charged WITHOUT the discount (tier resolves to 0 for that fee). This is the on-chain backstop against the "stake then never return + nobody pokes" worst case: the user can either re-trigger a CCIP push (by transacting on Base + calling `broadcastTierUpdate`), or accept the tier-0 fee on the mirror until they refresh. No keeper required for correctness.

### 4.4 Mirror-side tier cache + auto-consent

Each mirror chain's diamond exposes:

- Storage: `mapping(address => CachedTier) public userTierCache` where `CachedTier = struct { uint8 tier; uint40 lastUpdateSec; uint64 lastNonce; uint40 tierExpirySec; }` — packed into a single slot (8 + 40 + 64 + 40 = 152 bits; the final `tierExpirySec` field is the Codex round-3 P1 #1 addition that drives mirror-side decay enforcement, per §4.3).
- Inbound message handler: `onCcipMessageReceived(...)` decodes the `TierUpdated` kind and runs the §4.3 source-chain + authenticated-sender + nonce-monotonic validations before writing the cache. The handler also writes `tierExpirySec` from the payload.

**Fee-path beneficiary lookup (Codex round-1 P1 #5)**: `LibVPFIDiscount.tryApply` and `tryApplyYieldFee` on mirrors take an explicit **beneficiary** argument and look up `userTierCache[beneficiary].tier`. The beneficiary is the address that earns the discount — not necessarily `msg.sender`:

| Path                                  | Beneficiary                                                       |
| ------------------------------------- | ----------------------------------------------------------------- |
| Borrower LIF discount (`tryApply`)    | Current borrower-position-NFT holder (resolved via `VaipakamNFTFacet.ownerOf(loan.borrowerTokenId)`) |
| Lender yield-fee discount (`tryApplyYieldFee`) | Current lender-position-NFT holder (resolved via `VaipakamNFTFacet.ownerOf(loan.lenderTokenId)`)   |
| Keeper-submitted partial-period close | Original borrower if NFT holder unchanged; tracks NFT holder if transferred (same rule as above)    |

Using `msg.sender` would mis-attribute the discount when the keeper submits a borrower's repay or when a third-party permissionless cancel runs — Codex caught this on the v1 design. The lib's existing Base-side code already passes explicit beneficiary addresses (per scout: `rollupUserDiscount(loan.lender, ...)`, `rollupUserDiscount(loan.borrower, ...)`); the mirror-side lookups mirror that convention.

**Auto-consent semantics:** if `userTierCache[beneficiary].tier >= 1`, the discount is applied automatically. There is no separate consent storage on mirrors. The Phase-5 borrower-LIF custody flow is Base-only now (since mirror VPFI vaults are deleted), so the rebate accounting on mirrors collapses to: the user pays the net-discounted fee, and the diamond keeps less of the fee. No VPFI custody / rebate / settlement steps fire on mirrors.

### 4.5 Treasury buyback — per-chain accumulate → CCIP → Base buyback intent

Each fee-collecting site on every chain credits a fraction (`cfgBuybackFeeBps`, default 1500 = 15%) of the fee — in the **lending asset** — into a per-chain `s.buybackBudget[token]` accumulator. **The buyback slice is custodied in the diamond itself**, not transferred onward to `s.treasury`, so the diamond has approve / transfer authority to send the funds via CCIP when remittance fires. The remaining fee fraction (85% by default) still flows to `s.treasury` as usual (Codex round-1 P2 #12 caught the original draft's omission here).

**Asset allow-list (Codex round-1 P2 #9)**: only fee tokens that have a configured CCIP token pool + remote-token mapping on the source chain feed the buyback budget. The diamond reads `s.buybackAllowedToken[chainId][token]`; tokens not on the list still flow to `s.treasury` in full (no buyback slice credited). Operators curate the list as new chains and tokens are added, preventing stranded budgets in non-bridgeable assets.

When a per-token buyback balance crosses `cfgBuybackMinRemittance` (default $1k worth, oracle-resolved at write time):

1. The chain's diamond emits `BuybackBudgetReady(token, amount)`.
2. The agent worker picks up the event and triggers `TreasuryFacet.remitBuyback(token, amount)` on the source-chain diamond. The diamond approves the CCIP token pool + calls `CcipMessenger.send(...)` to move the funds to Base.
3. On Base, the existing CCIP inbound handler routes the funds into `s.baseBuybackBudget[token]`.

**Base-side execution via 1inch Fusion intent (Codex round-1 P2 #10)**: a Base-side keeper trigger periodically calls `TreasuryBuybackIntentFacet.commitBuybackIntent(token, amountIn)`:

- Subject to `cfgBuybackMaxTrancheUsd` cap (default $5k per call) so a single tranche's max-profit blast radius is bounded.
- Routes through 1inch's LOP orderbook (same upstream the T-090 v1.1 GA bridge uses), but the on-chain callback surface is **a NEW separate facet, not the existing `SwapToRepayIntentFacet`** (Codex round-2 P1 #5). The swap-to-repay facet's `isValidSignature` / `preInteraction` / `postInteraction` callbacks are keyed by `s.orderHashToLoanId` / `s.intentCommits[loanId]` — its postInteraction runs the loan-repayment settlement waterfall (lender leg, treasury leg, surplus to borrower). A treasury buyback order has no `loanId` at all; reusing those callbacks would either revert or, worse, attempt to settle a non-existent loan.

The new `TreasuryBuybackIntentFacet` mirrors the swap-to-repay facet's *structure* but uses its own storage namespace:

- `s.orderHashToBuybackCommit[orderHash]` → `BuybackCommit { token; amountIn; minVpfiOut; expiry; }`.
- Its own `isValidSignature(orderHash, sig)` looks up the buyback commit (not the loan), returns ERC-1271 magic value if the orderHash matches a live commit.
- Its own `preInteraction(...)` records baseline VPFI balance.
- Its own `postInteraction(...)` verifies the diamond received >= `minVpfiOut` VPFI and exactly `amountIn` of the fee token was deducted; on success, increments `s.stakingPoolBuybackBudget` by the received VPFI; clears the commit.
- The diamond exposes one *combined* `isValidSignature` entry point that dispatches by orderHash → loan-commit OR buyback-commit OR rejects; this is the same dispatch pattern Diamond facets already share for selectors.

The 1inch agent endpoint (`apps/agent/src/intentFusionPost.ts`) is extended to accept buyback-flavored orders too — the on-chain commit preflight switches behaviour based on the maker (loan-commit vs treasury-commit). Same RPC, same rate-limit binding, same operator activation as T-090 GA.

- Compared to a public-mempool keeper swap, the Fusion intent eliminates sandwich-attack surface entirely: the order is matched off-chain by competing solvers; the fill tx is submitted by the winning solver — no public mempool exposure for the diamond's swap.
- Output VPFI lands in `s.stakingPoolBuybackBudget` (NOT directly into `stakingRewardPool` — the budget is the separate cap-widener; see §4.5 below).

**Pool-cap expansion (Codex round-1 P2 #13)**: the existing `VPFI_STAKING_POOL_CAP = 55.2M` (`LibVaipakam`) bounds the original allocation. The buyback-fed inflow needs a separate budget so the existing `stakingPoolPaidOut < CAP` check doesn't silently truncate buyback rewards. A new storage slot `s.stakingPoolBuybackBudget` tracks cumulative buyback inflow; the claim check widens to `stakingPoolPaidOut < (VPFI_STAKING_POOL_CAP + s.stakingPoolBuybackBudget)`. Buybacks increment the budget atomically with the inflow into the pool, so the cap moves up by exactly the amount being recycled.

**Fallback if Fusion is unavailable for a token / chain**: the `LibSwap.swapWithFailover` 4-DEX path (0x v2 / 1inch v6 / Uniswap V3 / Balancer V2) remains available as the second-tier fallback, gated behind `cfgBuybackFallbackEnabled` (default `false`). When enabled, the keeper submits via the fallback with a tighter `cfgBuybackFallbackSlippageBps` (default 50 = 0.5%) + randomized 0-300s submission delay. This is for chains / tokens where Fusion liquidity is thin; not the primary path.

**Governance levers**:

- `pauseBuybacks()` halts all `commitBuybackIntent` + `remitBuyback` calls (matches the existing CCT cross-chain pause pattern). Accumulator credits still happen — funds just queue.
- All knobs (fee bps, min remittance, max tranche, slippage cap, fallback enable / slippage) are bounds-checked via `ConfigFacet` (§5).

### 4.6 Mirror-chain VPFI staking surface removal

In the pre-live transition:

- `VPFIDiscountFacet` is removed from every mirror's diamond cut. The tier-resolution + discount-application logic lives only on Base; mirrors read the cached tier (§4.4).
- `StakingRewardsFacet` is removed from mirrors. The 5% APR staking pool lives only on Base.
- `VpfiBuyAdapter` deployment is dropped. Cross-chain VPFI purchase becomes a frontend one-click chain switch to Base + invoking the existing `buyVPFIWithETH()`.

**`VPFIMirrorToken` is RETAINED on every mirror chain (Codex round-1 P1 #6)**: the original draft proposed deleting `VPFIMirrorToken` entirely, but `InteractionRewardsFacet.claimInteractionRewards()` transfers `s.vpfiToken` locally on every chain — the existing tokenomics (`TokenomicsTechSpec.md`) bridges each chain's interaction-reward slice to a local mirror VPFI vault for local claim. Dropping the mirror VPFI token would either break interaction reward claims on mirrors or force every claim to round-trip through Base via CCIP (a UX regression). The compromise:

- Mirror chains continue to deploy `VPFIMirrorToken` + the CCT BurnMintTokenPool (T-068 path).
- Mirror chains continue to receive interaction-reward VPFI slices via the existing `VaipakamRewardMessenger` BROADCAST path.
- Mirror chains do NOT host a staking pool (no 5% APR accrual on mirror-held VPFI) — APR happens only on Base.
- A user holding VPFI on a mirror chain can either: (a) claim it as part of their interaction-reward flow on that chain, (b) bridge it to Base via the standard `VPFIMirrorToken.burnAndMessage` → `VPFIToken.mint` CCT path to stake there.

Diamond storage on mirrors carrying mirror-side staking slots is reset / left dead (`stakingRewardPool`, `stakingRewardPerTokenStored`). Per-user stake balances on mirrors are zero (no users yet) so no recovery flow needed.

The Diamond's `predeploy-check.sh` selector-coverage suite is updated to expect different facet sets on canonical vs mirror — same pattern T-068 already established.

## 5. Storage layout

**Append-only discipline (Codex round-1 P2 #8)**: the existing Phase-5 `userVpfiDiscountState` mapping at its fixed storage slot is NOT reinterpreted; instead, that slot is left in place as deprecated (renamed to `userVpfiDiscountState_DEPRECATED` in the storage struct), and the new ring-buffer state is added at the end of `LibVaipakam.Storage` as fresh mappings. This preserves the layout contract that loupe-reading deploy tools (and any forked-state simulators) rely on, even in the pre-live phase where no production users exist.

**`LibVaipakam.Storage` additions (Base only):**

```
// === DEPRECATED in T-087 — do NOT reuse this slot ===
// mapping(address => UserVpfiDiscountState) userVpfiDiscountState_DEPRECATED;

// === T-087 — Ring-buffer TWA accumulator ===
// Per-user 30-slot ring buffer of daily balance snapshots.
// `dayBalances[user][i]` is the closing VPFI vault balance for
// (firstWriteDayId[user] + i) % 30. uint128 covers the full
// 230M VPFI token cap (Codex round-2 P2 #8 — uint80 would cap
// per-user balance at ~1.2M VPFI, smaller than the 55.2M staking
// pool itself).
mapping(address => uint128[30]) dayBalances;
mapping(address => uint16)      firstWriteDayId;   // dayId of slot index 0
mapping(address => uint16)      lastUpdateDayId;   // most recent day written

// Monotonic per-user nonce — strict ordering key for cross-chain
// tier propagation. Incremented on every tier-crossing balance
// mutation OR on every forced push. uint64 = effectively unbounded.
// (Codex round-2 P1 #1.)
mapping(address => uint64) userTierPushNonce;

// Per-destination last-pushed nonce. Distinct from `userTierPushNonce`
// because two destinations can be at different last-sent values.
// (Codex round-2 P1 #2 — gives the forced-resend path a separate
// state to rewind.)
mapping(address => mapping(uint64 => uint64)) userTierLastPushedNonce;

// Projected tier-decay expiry — absolute seconds-since-epoch past
// which the user's current Base tier will fall to a lower tier
// IF no further balance mutations occur. Computed at every rollup
// pass from the ring buffer's deterministic future trajectory.
// Embedded in the CCIP payload so mirrors enforce decay locally
// without a Base round-trip. (Codex round-3 P1 #1.)
mapping(address => uint40) tierExpirySec;
```

Cold cost per active staker on Base: 30 × `uint128` packs into 15 slots + 2 metadata slots + 1 push-nonce slot + per-destination last-pushed (1 slot per active destination). Sub-card 1 includes the gas snapshot vs the existing accumulator.

**Mirror-side additions:**

```
struct CachedTier {
    uint8  tier;            // current cached tier (0-4)
    uint40 lastUpdateSec;   // wall-clock of last cache write (used for the secondary max-age safety cap)
    uint64 lastNonce;       // monotonic ordering key — payload nonce, NOT timestamp
    uint40 tierExpirySec;   // Codex round-3 P1 #1 — the absolute timestamp past which the cached tier is stale-by-construction
}
mapping(address => CachedTier) userTierCache;

// Authenticated remote sender — the Base messenger that the
// inbound handler accepts TierUpdated messages from.
address baseAuthorizedMessenger;
uint64  baseChainSelector;
```

`CachedTier` packs into a single slot (8 + 40 + 64 + 40 = 152 bits). One slot per user with a cached tier.

**`TreasuryFacet` additions (every chain):**

```
// Per-chain buyback budget accumulator. Diamond holds the funds
// directly (NOT s.treasury) so the diamond can approve / send via
// CCIP without round-tripping through an external custody contract.
mapping(address => uint256) buybackBudget;

// Per-chain CCIP-bridgeable asset allow-list. Tokens not on the list
// don't feed buyback; their full fee fraction flows to s.treasury.
mapping(address => bool) buybackAllowedToken;

// Base-only — incoming budgets aggregated by source token.
mapping(address => uint256) baseBuybackBudget;

// Base-only — cumulative buyback-fed staking-pool inflow, used to
// widen the existing VPFI_STAKING_POOL_CAP claim gate.
uint256 stakingPoolBuybackBudget;
```

**New `ConfigFacet` knobs:**

| Knob                                  | Type    | Default     | Range (governance-enforced) |
| ------------------------------------- | ------- | ----------- | --------------------------- |
| `cfgBuybackFeeBps`                    | uint16  | 1500 (15%)  | 0 ≤ x ≤ 3000 (max 30%)      |
| `cfgBuybackMinRemittance` (USD18)     | uint256 | 1e21 ($1k)  | 1e19 ≤ x ≤ 1e23             |
| `cfgBuybackMaxTrancheUsd` (USD18)     | uint256 | 5e21 ($5k)  | 1e21 ≤ x ≤ 5e22             |
| `cfgBuybackSwapSlippageBps`           | uint16  | 100 (1%)    | 25 ≤ x ≤ 600                |
| `cfgBuybackFallbackEnabled`           | bool    | `false`     | —                           |
| `cfgBuybackFallbackSlippageBps`       | uint16  | 50 (0.5%)   | 25 ≤ x ≤ 300                |
| `cfgTwaRecentDays`                    | uint8   | 7           | 1 ≤ x ≤ 14                  |
| `cfgTwaWindowDays`                    | uint8   | 30          | 14 ≤ x ≤ 30 (capped at the 30-slot ring buffer per Codex round-2 P2 #7) |
| `cfgTwaRecentWeight`                  | uint8   | 3           | 1 ≤ x ≤ 10                  |
| `cfgMirrorTierMaxAgeSec`              | uint32  | 5_184_000 (60d) | 2_592_000 (30d) ≤ x ≤ 15_552_000 (180d) |

All bounds-checked via `ConfigFacet`'s existing `setUint256WithBounds` pattern (T-008).

## 6. Risks + mitigations

| Risk                                                              | Mitigation                                                                                                                                                          |
| ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| CCIP latency between Base mutation and mirror cache update         | Existing `VaipakamRewardMessenger` retry mechanism; manual `pushMyTierToAllMirrors()` fallback. Mirrors render a "tier syncing" notice to the user for ≤30 minutes. |
| Mirror cache poisoning (forged source chain)                      | Source-chain selector validated against `baseChainSelector` constant in the inbound handler. Anything from a non-Base source reverts.                                |
| Treasury buyback MEV (sandwich attack on Base swap)               | Per-tranche USD cap + tight slippage cap + randomized swap delay + governance pause lever.                                                                            |
| Buyback budget drain via fee-bps misconfiguration                 | `cfgBuybackFeeBps` capped at 30% in `ConfigFacet`; multisig governance gates every set.                                                                                |
| TWA gaming (flash stake / unstake bursts)                         | Front-loaded weighting means recent stake matters most; flash-stake-and-unstake leaves a brief TWA spike that's already counted at tier-change-push time but decays quickly. |
| Per-user vault storage cost on Base                               | Per-user vault is the existing pattern (T-090, T-086, all asset classes); cost is already paid for in the protocol's UX assumption.                                  |
| Mirror cache size growth                                          | `CachedTier` is packed (1 slot per user); 100k stakers ≈ 100k slots; ≈ 2 ETH worth of mirror storage at typical L2 prices — bounded.                                |
| Reward-pool depletion before treasury buyback steady-state        | Initial 55.2M VPFI allocation covers ~5 years at expected staking-yield draw; treasury buyback kicks in immediately at any fee volume.                              |

## 7. Out of scope

- **Phase-2 cross-chain governance**: token-weighted votes on tier thresholds + APR knobs is a future card; this design only addresses fee-rebate tier resolution.
- **VPFI bridging from third-party L2s / sidechains** (e.g., a user bridging from BNB to Base via a third-party bridge): handled by the user as an external action. The dapp's chain-agnostic UI surfaces the chain switch + the existing `buyVPFIWithETH()` on Base but does not bundle bridging.
- **NFT-based rewards / loyalty multipliers**: separate card if the protocol wants to layer position-NFT bonuses on top of the tier table.
- **Per-asset class tier overrides** (e.g., higher tier for stablecoin loans): not on the roadmap; tier is a single global per-user value.

## 8. Sub-card slicing

The implementation lands in 5 PRs, each independently reviewable + Codex-audited:

| Sub | Title                                                | Scope                                                                                                                                                                                                                                                                                                                              |
| --- | ---------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **Contracts — Base accumulator + tier resolution**   | Rewrite `LibVPFIDiscount` for two-tier TWA via 30-slot ring buffer + monotonic nonce; storage additions on Base; emit `BaseTierChanged(user, oldTier, newTier, computedAt, nonce)`; delete `StakingRewardsFacet` + `VPFIDiscountFacet` + `VpfiBuyAdapter` from mirrors (RETAIN `VPFIMirrorToken` so `InteractionRewardsFacet` keeps working); new `ConfigFacet` knobs (TWA window/weighting + mirror max-age). Producer artifacts + tests + frontend ABI sync. |
| 2   | **Cross-chain — `VaipakamRewardMessenger` extension** | Add `TierUpdated` message kind; Base outbound on tier-change; mirror inbound handler writes `userTierCache`; mirror-side fee-path reads from cache; full fork-test on Base Sepolia → Sepolia mirror.                                                                                                                              |
| 3   | **Treasury buyback** | `TreasuryFacet` budget accumulators on every chain; remit flow via existing CCIP path; Base-side `executeBuyback()`; agent + keeper worker wiring for event observation + randomized swap delay; new `ConfigFacet` knobs (fee bps, tranche cap, slippage); pause lever.                                                            |
| 4   | **Frontend — chain-agnostic UX** | Global "Stake VPFI" entry on every page; one-click chain-switch flow; tier display + balance + rewards previews uniform across chains; 30-minute "tier syncing" notice after a stake/unstake action; "Managed on Base" footnote in Advanced; new `useUserTier` hook reading from indexer + on-chain fallback.                       |
| 5   | **Indexer + docs** | New indexer event handlers for `BaseTierChanged` + `TierUpdated` + `BuybackBudgetReady` + `BuybackExecuted`; functional spec under `docs/FunctionalSpecs/CrossChainRewards.md`; refresh of `docs/TokenomicsTechSpec.md` §6 + §7; Advanced UG entry; release-notes thread.                                                          |

Each sub follows the project's standard PR-with-Codex-review cycle. Sub 1-2 are sequencing-critical (contracts before cross-chain); Sub 3 + Sub 4 can ship in parallel after Sub 2 lands; Sub 5 lands last to capture the full surface.

---

**This design is a draft for Codex pre-design review.** Open questions for reviewers:

- Is the two-tier weighting (7d × 3 + 23d × 1) the right tradeoff vs. exponential decay on gas + simplicity grounds, or should we lean exponential for smoother behaviour?
- Does the manual `pushMyTierToAllMirrors()` fallback need an automatic keeper sweep for users who don't notice their tier is stale, or is the user-driven model sufficient?
- Is the per-tranche USD cap of $5k the right starting value, or should it scale with treasury buyback budget growth?
- The Phase-5 borrower LIF custody flow simplifies dramatically when mirrors stop holding VPFI; should we keep the consent-flag opt-in for the Base-only optional VPFI-fee-boost flow (§5 of the seed doc), or auto-consent there too?
