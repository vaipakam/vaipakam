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
| Q1  | Mirror-chain VPFI vault               | **Deleted entirely.** Mirrors lose `VPFIDiscountFacet` + `StakingRewardsFacet` + `VPFIMirrorToken` + `VpfiBuyAdapter`.                       |
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

For each user, the diamond maintains an **accumulator** that integrates balance × weight over the trailing 30 days. The accumulator advances at every Base-side mutation that changes the user's vault VPFI balance (deposit, withdraw, claim-into-vault, claim-from-vault, sale settlement crediting into vault). The instantaneous tier on Base is derived from the accumulator's weighted average via the existing constants in `LibVaipakam`.

**Weighting:**

```
TWA = (Σ balance(t) × weight(t)) / Σ weight(t)
weight(t) = 3 for t ∈ (now-7d, now]
          = 1 for t ∈ (now-30d, now-7d]
          = 0 for t ≤ now-30d
```

This is computed lazily at read time from two stored running sums (one per weighting region). The sums advance with each balance mutation; the older-region sum bleeds out as time passes through a closed-form update. Detailed storage in §5.

**Behaviour highlights:**

- **Constant-balance steady state**: if balance has been `X` for the past 30 days, `TWA = X`. The tier doesn't move; no CCIP push fires.
- **Fresh stake with prior empty balance**: TWA jumps quickly (front-loaded weight on recent days) so a user reaches tier 1 within hours of staking 100 VPFI, not 30 days later.
- **Post-unstake decay**: a user who unstakes drops their balance to 0 but their TWA decays gradually over the next 30 days. The cached tier on mirrors holds at the pre-unstake level for the decay window — a deliberate stickiness rewarding the user for past stake.

**Storage exposure for accumulator:** 4 slots per user (`recentSum`, `recentLastUpdate`, `olderSum`, `olderLastUpdate`). See §5 for the exact layout.

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

On Base, after every accumulator update, the diamond compares the user's new tier to their previously cached tier (a per-user storage slot `s.userTierAtLastPush[user]`). If they differ:

1. Diamond emits `BaseTierChanged(user, oldTier, newTier, computedAt)`.
2. Diamond calls `VaipakamRewardMessenger.broadcastTierUpdate(user, newTier)`.
3. The messenger fans out a `TierUpdated` CCIP message to every mirror chain in its `broadcastDestinations` list. Payload: `(uint8 messageKind, address user, uint8 tier)`. Total ~64 bytes per chain (within CCIP's economical-message regime).
4. `s.userTierAtLastPush[user]` is set to `newTier` on Base so subsequent mutations that don't cross a tier boundary don't re-push.

**No push fires** when the mutation doesn't change the tier (e.g., a tier-3 user adding 10 VPFI stays tier 3). This keeps CCIP gas spend bounded to the cardinality of tier-boundary crossings.

**Failure handling:** CCIP messages can revert at the destination. The `VaipakamRewardMessenger` retry mechanism (existing) handles transient failures. If a message goes permanently unfilled, the mirror's cached tier stays stale; the user can manually trigger a re-push via a Base-side `pushMyTierToAllMirrors()` view-then-call entry point on `VPFIDiscountFacet`. This is a manual fallback, not a routine path.

### 4.4 Mirror-side tier cache + auto-consent

Each mirror chain's diamond exposes:

- Storage: `mapping(address => CachedTier) public userTierCache` where `CachedTier = struct { uint8 tier; uint40 lastUpdateSec; }`.
- Inbound message handler: `onCcipMessageReceived(uint64 srcChainSelector, bytes payload)` decodes the `TierUpdated` kind, validates `srcChainSelector == baseChainSelector` (so only Base can write the cache), then writes `userTierCache[user] = (tier, now)`.

**Fee path on mirrors:** `LibVPFIDiscount.tryApply` and `tryApplyYieldFee` on mirrors short-circuit to `userTierCache[msg.sender].tier` instead of reading the (now-deleted) mirror vault balance. The discount BPS comes from the same `VPFI_TIER{N}_DISCOUNT_BPS` constants.

**Auto-consent semantics:** if `userTierCache[user].tier >= 1`, the discount is applied automatically. There is no separate consent storage on mirrors. The Phase-5 borrower-LIF custody flow is also Base-only now (since mirror VPFI vaults are deleted), so the rebate accounting collapses to: the user pays the net-discounted fee on every chain, and the diamond just keeps less of the fee. No VPFI custody / rebate / settlement steps.

### 4.5 Treasury buyback — per-chain accumulate → CCIP → Base swap

Each fee-collecting site on every chain credits a fraction (`cfgBuybackFeeBps`, default 1500 = 15%) of the fee — in the **lending asset** — into a per-chain `s.buybackBudget[token]` accumulator inside `TreasuryFacet`.

When a per-token balance crosses `cfgBuybackMinRemittance` (default $1k worth, oracle-resolved at write time):

1. The chain's diamond emits `BuybackBudgetReady(token, amount)`.
2. The agent worker (existing CCIP path) picks up the event, signs a CCIP message moving the ERC-20 to Base treasury via the standard `LibSwap`/`CcipMessenger` token-transfer flow.
3. On Base, `TreasuryFacet.absorbRemittance(token, amount, srcChainId)` credits the funds into `s.baseBuybackBudget[token]`.

A Base-side keeper trigger (existing `apps/keeper` infra) periodically calls `TreasuryFacet.executeBuyback(token, amountIn)`:

- Subject to `cfgBuybackMaxTrancheUsd` cap (default $5k per call).
- Routes through `LibSwap.swapWithFailover` against the same 4-DEX try-list the HF-liquidation path uses.
- Slippage cap from `cfgBuybackSwapSlippageBps` (default 100 = 1%), strictly tighter than the HF-liquidation 6% cap because there's no adversarial timer.
- Output VPFI lands directly into `stakingRewardPool` on Base.

**MEV-hardening:**

- The Base keeper deliberately introduces a random 0-300 second offset between event observation and swap submission so the swap block is unpredictable.
- The per-tranche USD cap bounds the maximum profit a sandwich attack can extract per call.
- The tight slippage cap forces the attacker to put up disproportionately large counter-liquidity per profitable basis point.
- A `pauseBuybacks()` governance lever exists if MEV pressure materialises post-launch (matches the existing CCT cross-chain pause pattern).

### 4.6 Mirror-chain VPFI staking surface removal

In the pre-live transition:

- `VPFIDiscountFacet` is removed from every mirror's diamond cut (it stays only on Base canonical).
- `StakingRewardsFacet` is removed from mirrors.
- `VPFIMirrorToken` deployment is dropped entirely. Operators who haven't yet deployed mirror VPFI infrastructure simply skip it; operators who have deployed it on a testnet treat the contract as a stale artifact (no upgrade path needed — no production users).
- `VpfiBuyAdapter` deployment is dropped. Cross-chain purchase becomes a frontend one-click chain switch to Base + invoking the existing `buyVPFIWithETH()`.
- Diamond storage on mirrors carrying VPFI-related slots is reset / left dead (`stakingRewardPool`, `stakingRewardPerTokenStored`, etc.). Per-user stake balances on mirrors are zero (no users yet) so no recovery flow needed.

The Diamond's `predeploy-check.sh` selector-coverage suite is updated to expect different facet sets on canonical vs mirror — same pattern T-068 already established.

## 5. Storage layout

All new slots are appended to existing structures; no slot reordering of pre-existing storage.

**`LibVaipakam.Storage` additions (Base only):**

```
// Existing accumulator state (Phase 5) — repurposed:
// - recentSum[user]      : Σ balance(t)·dt over t ∈ (now-7d, now]
// - olderSum[user]       : Σ balance(t)·dt over t ∈ (now-30d, now-7d]
// - lastUpdateSec[user]  : timestamp the two sums were last advanced
mapping(address => uint256) recentSum;
mapping(address => uint256) olderSum;
mapping(address => uint40)  lastUpdateSec;

// Tier-push de-dup state:
mapping(address => uint8) userTierAtLastPush;
```

Storage cost per user (active staker): 4 slots cold, ~80k gas amortised across stake/unstake actions over the user lifetime. Sub-card 1 has the exact gas snapshot.

**Mirror-side additions:**

```
struct CachedTier { uint8 tier; uint40 lastUpdateSec; }
mapping(address => CachedTier) userTierCache;
```

One slot per user (packed). Written only by the CCIP inbound handler; read by `tryApply` / `tryApplyYieldFee` on every fee-charging site.

**`TreasuryFacet` additions (every chain):**

```
mapping(address => uint256) buybackBudget;       // per-token accumulator on this chain
mapping(address => uint256) baseBuybackBudget;   // Base-only — incoming from mirrors
```

**New `ConfigFacet` knobs:**

| Knob                                 | Type   | Default                            | Range (governance-enforced)     |
| ------------------------------------ | ------ | ---------------------------------- | ------------------------------- |
| `cfgBuybackFeeBps`                   | uint16 | 1500 (15%)                         | 0 ≤ x ≤ 3000 (max 30%)          |
| `cfgBuybackMinRemittance` (USD18)    | uint256 | 1e21 ($1k)                        | 1e19 ≤ x ≤ 1e23                 |
| `cfgBuybackMaxTrancheUsd` (USD18)    | uint256 | 5e21 ($5k)                        | 1e21 ≤ x ≤ 5e22                 |
| `cfgBuybackSwapSlippageBps`          | uint16 | 100 (1%)                          | 25 ≤ x ≤ 600                    |
| `cfgTwaRecentDays`                   | uint8  | 7                                  | 1 ≤ x ≤ 14                      |
| `cfgTwaWindowDays`                   | uint8  | 30                                 | 14 ≤ x ≤ 60                     |
| `cfgTwaRecentWeight`                 | uint8  | 3                                  | 1 ≤ x ≤ 10                      |

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
| 1   | **Contracts — Base accumulator + tier resolution**   | Rewrite `LibVPFIDiscount` for two-tier TWA; storage additions on Base; emit `BaseTierChanged`; `pushMyTierToAllMirrors()` manual fallback; delete `StakingRewardsFacet` from mirrors; delete `VPFIDiscountFacet`/`VPFIMirrorToken`/`VpfiBuyAdapter` from mirrors; new `ConfigFacet` knobs (TWA window/weighting). Producer artifacts + tests + frontend ABI sync. |
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
