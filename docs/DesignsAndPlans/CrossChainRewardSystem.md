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
| Q3  | Base → mirror CCIP push policy        | **Tier change OR projected-expiry shift OR tier-threshold-table change, no TTL, no keeper.** Push fires when `effectiveTier`, `tierExpirySec`, or the on-chain tier-table version changes (the expanded condition catches expiry-only shifts that the round-1 "tier change only" rule missed; see §4.3 + §4.1). |
| Q4  | Treasury buyback execution            | **Per-chain accumulate → CCIP remit to Base → Base swap → reward pool.** Plus per-tranche USD cap, 1% slippage cap, randomized swap delay.   |
| Q5  | Consent flag on mirrors               | **Auto-consent at tier ≥ 1**; mirror has no separate consent storage; cached tier is the eligibility signal.                                  |
| —   | Staking-vault architecture            | **Per-user vault** (existing `VaultFactoryFacet` UUPS proxy pattern); single protocol-owned `stakingRewardPool` on Base pays APR.            |

## 3. What the design reuses (no new primitives)

| Existing surface                                  | Role in the new design                                                                                                                |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `VaultFactoryFacet` UUPS proxy per user           | Holds each user's staked VPFI on Base. Diamond reads `vault.balance(VPFI)` to compute tier.                                            |
| `LibVPFIDiscount.rollupUserDiscount(user, bal)`   | Already the integration point at every balance-mutation site. Reworked internally to compute the two-tier TWA + emit `TierComputed`. |
| `LibVPFIDiscount.tryApply` / `tryApplyYieldFee`   | Stay; their internal tier-lookup branches change to read the local accumulator's EFFECTIVE_TIER on Base (NOT the raw vault balance — the min-history gate must apply on Base too per Codex round-6 P1 #5) OR (on mirrors) the cached EFFECTIVE_TIER slot. Both paths return the same gated value. |
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

For each user, the diamond maintains a **30-slot daily ring buffer** of vault VPFI balance snapshots, indexed by `dayId = block.timestamp / 1 days`. Each slot stores BOTH the dayId and the balance: `slot[i] = (uint16 dayId, uint128 balance)`. The buffer is updated lazily on BOTH writes AND reads:

- **On every write** (balance-mutation site): fill gap days from `lastUpdateDay` to `currentDay - 1` with the *prior* balance, then write today's new balance into `slot[currentDay % 30]`.
- **On every read** (fee-charging path, tier query, broadcast step): if `lastUpdateDay < currentDay`, fill gap days first, write today's `currentBalance` (which equals the last-known balance — no mutation has happened since). Without this read-side gap-fill, a long-tenured constant-balance staker who hasn't mutated for many days would have only the OLD slots visible to the TWA scanner — slots whose `dayId` no longer falls in the active window — and the scanner would compute TWA = 0 → tier 0, mispricing fees at the higher rate. (Codex round-6 P1 #8.)

The TWA is computed on demand by reading the 30 slots, checking each slot's `dayId` field against the active 30-day window (`dayId ∈ [currentDay - 29, currentDay]`), and applying the weighted average over slots that pass the window check.

**Why per-slot dayId, not derived from `firstWriteDayId` (Codex round-4 P1 #2)**: a naive ring-buffer layout that derives each slot's dayId from `firstWriteDayId + i % 30` produces incorrect mappings after the ring wraps. On day 100 with `firstWriteDayId = 0`, slot 0 actually represents day 90 (the most recent overwrite of that slot), not day 0. Storing the dayId in the slot itself eliminates this ambiguity: the TWA scanner simply ignores any slot whose `dayId` falls outside the active window.

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

**Minimum-history gate (Codex round-4 P1 #3 + round-5 P1 #1 + P1 #2)**: the self-seeded denominator alone would let a fresh wallet stake huge VPFI, get tier 4 for a single fee transaction, and immediately unstake — the discount fires at the discounted rate and decay arrives too late to matter. To close this gaming vector, the discount is gated on `stakedDays >= cfgTwaMinStakedDays` (default 3 days, governance-bounded 1-14 days). Below this threshold the user's tier-from-TWA is computed for accumulator continuity but EFFECTIVE_TIER is forced to 0.

**The payload carries EFFECTIVE_TIER, NOT raw TWA-derived tier (Codex round-5 P1 #1)**. The mirror cache has no visibility into `cfgTwaMinStakedDays` or `stakedDays`, so propagating the raw tier would let a fresh wallet broadcast tier 4 to mirrors and get the discount on the mirror fee path immediately even though Base-effective tier is 0. Base computes `effectiveTier = stakedDays >= cfgTwaMinStakedDays ? rawTier : 0` and sends THAT value across CCIP; the mirror's `tryApply` / `tryApplyYieldFee` paths apply whatever effective-tier the cache holds without re-deriving it.

**`stakedDays` definition (Codex round-5 P1 #2 + round-6 P1 #1)** — count only days where the user actually had non-zero balance, NOT synthetic zero-fill days from the lazy gap-fill, AND reset the tenure clock on each zero-balance exit. The implementation tracks `currentStakeStartDayId[user]`:

- On a balance transition from `0 → positive`: set `currentStakeStartDayId[user] = currentDayId`. If this is the first-ever stake, the tracker is initialized; if the user previously fully unstaked and is returning, the tracker is RE-INITIALIZED (NOT preserved from the original stake — otherwise a primed wallet could wait out the min-history once, fully exit, and later flash-restake to immediately bypass the gate).
- On a balance transition from `positive → 0`: clear `currentStakeStartDayId[user] = 0` so the next zero→positive transition seeds a fresh count.
- `stakedDays = min(cfgTwaWindowDays, currentDayId - currentStakeStartDayId + 1)` at every TWA read, ONLY when `currentStakeStartDayId > 0`.

The naive "never overwrite" approach Codex caught in round 5 P1 #2 reopens the gaming vector. The fresh-on-restake reset closes it (Codex round-6 P1 #1).

This shifts the cost-vs-discount tradeoff: a fresh wallet must commit stake for `cfgTwaMinStakedDays` of GENUINE non-zero balance BEFORE drawing any discount benefit. Pre-live freedom lets us tune this knob during early-user testing; 3 days is the proposed launch value.

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
   - **Computes the projected expiry**: scans the future trajectory of the ring buffer assuming no further balance mutations (older days roll out, all newer days hold the current balance), determines the dayId on which the projected TWA will first cross BELOW the current tier boundary, and stores `tierExpirySec[user] = thatDayId × 1 day`. This is the closed-form solution the mirror later uses to enforce decay-driven expiry without a Base round-trip.
   - Increments `s.userTierPushNonce[user]` (uint64, monotonic) IF the tier crossed a boundary OR the projected expiry shifted earlier vs the previous stored value OR the caller signals a forced push (Codex round-4 P1 #1 — an unstake that lowers expiry without crossing a tier-boundary today MUST still trigger a re-broadcast; otherwise the per-destination de-dup check skips and mirrors keep the stale, later expiry).
   - Emits `BaseTierChanged(user, oldTier, newTier, computedAt, nonce, tierExpirySec)`.
   - **Does NOT send any CCIP messages.** No `msg.value` required.

2. **Broadcast step — protocol-funded only, fail-CLOSED on empty budget**:

   - **Protocol-funded auto-broadcast (Codex round-5 P1 #3 + round-6 P1 #2 + P1 #3)**: when the rollup pass in step 1 produces a nonce bump (effectiveTier crossed OR tierExpirySec shifted earlier OR tier-table-version bumped), the same step 1 transaction also calls `_protocolBroadcastTierUpdate(user)` *internal* helper. The helper pulls CCIP gas from a `s.protocolBroadcastBudget` (uint256, native gas balance held by the diamond on Base, topped up by treasury allocation) and fans out the `TierUpdated` message to every live destination. The user does NOT pay msg.value; the protocol does.

   - **Fail-closed when the budget is empty**: if `s.protocolBroadcastBudget < estimatedCcipFee(allDests)`, the whole step 1 transaction REVERTS (`Error: broadcast-budget-exhausted`). Round-5's "skip silently" fallback was wrong — it let a user observe the empty budget and unstake at a moment of no broadcast coverage, preserving the stale high tier on mirrors. The fail-closed behaviour means a balance mutation that would lower the tier cannot land at all if downgrade-propagation is unfunded; the operator must top up the budget before the user can act. The treasury-allocation top-up flow + operator alert when balance crosses below a 7-day-running-cost reservation is part of Sub 3.

   - **Forced-resend path is caller-funded only** (Codex round-6 P1 #6): a separate `forceResendTierUpdate(user, dests[])` entry point exists for recovery — when a CCIP message was router-accepted but executor-failed, or when a chain was just added and the operator hasn't pushed every staker to it yet. This entry point requires the CALLER to pay CCIP fees via `msg.value`. The protocol budget is NOT touched. Without this caller-funded constraint, any participant could spam `forceResendTierUpdate` to drain `s.protocolBroadcastBudget`, leaving genuine downgrade broadcasts unfunded.

   - **Removed**: the user-initiated `broadcastTierUpdate` payable entry point from round-5 is dropped. With the protocol-funded auto-broadcast fail-closed, there is no scenario where a user-initiated push is required for the normal flow. The forced-resend path covers recovery.

**Projected tier-decay expiry (Codex round-3 P1 #1 + round-6 P1 #9)**: the central observation is that, under the ring-buffer + two-tier weighting, the TWA's future trajectory is FULLY DETERMINED by the current ring-buffer state if no further balance mutations occur. So Base can compute, at push time, the EXACT day on which the projected TWA crosses below the current tier boundary, and embed that future moment in the CCIP payload as `tierExpirySec` (uint40 seconds, absolute timestamp).

A user whose balance keeps the projected TWA trajectory above the current tier boundary forever (e.g., a steady-state staker holding well above the tier threshold for an unbounded time) has NO crossing day. The design uses `tierExpirySec = type(uint40).max` (≈ year 36,800) as the explicit "no expiry" sentinel for this case. Mirrors treat `tierExpirySec == type(uint40).max` as "discount never expires from age alone" — `now < tierExpirySec` is trivially true. Without an explicit sentinel, the field's default-zero would cause mirrors to reject every steady-state cache write as "already expired".

On the mirror, the fee path applies the discount ONLY IF `now < userTierCache[user].tierExpirySec`. Past expiry, the cache is stale-by-construction and the user pays at tier 0 until a fresh push arrives. This:

- Pushes the decay-handling logic onto Base (where the ring buffer state lives) at push time.
- Adds a single uint40 to the payload (no balance trajectory propagation).
- Eliminates the keeper requirement: pure on-chain enforcement.
- Pre-empts the "stake-then-unstake-then-exploit-stale-mirror-tier" vector Codex flagged: the moment the unstake happens, the projected expiry is recomputed, the new (much sooner) expiry is propagated on the next push, and mirrors honour the new expiry.

The `cfgMirrorTierMaxAgeSec` knob remains as a *secondary* safety cap (the on-mirror "even if Base hasn't pushed an update in N months, treat the cache as expired"), but the primary correctness path is now the projected expiry baked into the cached tier itself.

**The dapp orchestrates step 2** after every stake/unstake action: it asks the user to confirm a small native-gas top-up to fund the CCIP broadcasts to all live mirror destinations. The user pays once per stake action; mirrors get the update in CCIP-DON time (typically <2 minutes). For users who don't want to pay (or transact through a relayer), step 1 alone still updates the user's tier on Base; their cached tier on mirrors stays stale until somebody (themselves, a keeper, a friend) calls `broadcastTierUpdate`.

**Strict ordering via per-user nonce (Codex round-2 P1 #1)**: `block.timestamp`-based ordering isn't strict — two tier-changing actions in the same block both stamp the same `computedAt`. The monotonic per-user `nonce` is the ordering key the mirror uses (`if msg.nonce <= s.userTierCache[user].lastNonce, drop`). `computedAt` is retained in the payload for forensics and dapp display, not for ordering.

**Per-destination tracking (round-1 P2 #11)**: `s.userTierLastPushedNonce[user][destSelector]` is set when the auto-broadcast sends the message. Adding a new mirror later automatically gets a push on the next nonce-bumping rollup because its slot is `0 < currentNonce`.

**Tier-table version invalidation (Codex round-6 P1 #10)**: governance changes to `VPFI_TIER{N}_MIN` thresholds or `VPFI_TIER{N}_DISCOUNT_BPS` constants must invalidate every mirror cache, not just the affected boundaries. The design adds `s.tierTableVersion` (uint16) on Base; any ConfigFacet call that mutates a tier threshold or BPS bumps the version + bumps every active staker's `userTierPushNonce` (via an iterative pass scheduled by the keeper after a tier-table mutation, paid from the protocol broadcast budget). Mirrors store the `tierTableVersion` in their cache slot too; their fee-application path treats a stale `tierTableVersion` as "tier 0" until a fresh push arrives. The keeper-driven catchup ensures the iteration cost is bounded by the cardinality of active stakers; tier-table mutations are rare governance events, not hot-path.

**Re-send semantics for failed deliveries (Codex round-2 P1 #2)**: `broadcastTierUpdate` is *idempotent* in this sense: if the CCIP send doesn't reach the mirror (router accepts but executor fails permanently), the mirror's cache stays at the pre-failure value, while Base's `userTierLastPushedNonce` shows the send was attempted. The user can call a `forceResendTierUpdate(user, dests)` overload that bypasses the de-dup check and re-sends regardless of `userTierLastPushedNonce`. Keepers can do the same when monitoring CCIP delivery status off-chain. The standard `broadcastTierUpdate` is the cheap "send if not yet sent" path; the force version is the recovery path.

**Sender authentication (round-1 P1 #2 + round-4 P1 #4)**: the mirror inbound handler validates the **business-peer mapping** that `VaipakamRewardMessenger` already exposes for REPORT/BROADCAST messages — NOT the raw `Any2EVMMessage.sender` field. Codex caught that in the existing CCIP adapter, `Any2EVMMessage.sender` is the *remote `CcipMessenger`*, not the business peer; the messenger resolves the actual peer through its channel-peer mapping before forwarding the decoded payload to the diamond. The tier-update inbound path mirrors that pattern exactly: the messenger validates `channelPeer[srcChainSelector] == decodedBusinessPeer` and forwards a `(payload, srcChainSelector, businessPeer)` triple to the diamond. The diamond then checks `srcChainSelector == s.baseChainSelector` AND `businessPeer == s.baseAuthorizedMessenger`. Using `Any2EVMMessage.sender` directly would reject every legitimate tier update because the address would always be the local `CcipMessenger` adapter, not the Base business peer.

**Reward-messenger payload-size gate update (Codex round-4 P1 #5)**: the existing `VaipakamRewardMessenger` rejects every inbound payload whose ABI length doesn't match the current 4-word REPORT/BROADCAST shape. The new `TierUpdated` payload is 6 ABI words (`kind`, `user`, `tier`, `computedAt`, `nonce`, `tierExpirySec`). Sub 2 (cross-chain wiring) MUST extend the messenger's payload-size gate to accept both the existing 4-word shape AND the new 6-word `TierUpdated` shape — without that change, every mirror tier update will revert at the messenger's pre-decode length check before reaching the new decode branch. The messenger's existing dispatch-by-kind pattern handles the actual branching; this is purely a size-check update.

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
2. The agent worker picks up the event and triggers `TreasuryFacet.remitBuyback(token, amount)` on the source-chain diamond. The diamond **approves `CcipMessenger`** (the local messenger contract) for `amount` of `token`, then calls `CcipMessenger.send(...)`. The messenger then `safeTransferFrom`s the tokens into itself and approves the underlying CCIP router / pool internally (Codex round-5 P1 #4 — the original draft "approve the CCIP token pool" was wrong because the existing messenger adapter pulls tokens from `msg.sender` via `safeTransferFrom` and then approves the router itself; the diamond's approval must target the messenger, not the router).
3. On Base, a **new dedicated `BuybackRemittanceReceiver` contract** (NOT `VaipakamRewardMessenger`) accepts the inbound token transfer. `VaipakamRewardMessenger.onCrossChainMessage` is data-only and reverts on `tokens.length != 0` (Codex round-5 P1 #5); reusing it for buyback remittance would revert every inbound. The receiver validates source chain + authenticated business peer, decodes a small remittance header carrying `(uint8 kind = REMITTANCE, address baseDeliveredToken, uint256 sourceAmount, uint32 srcChainId)`, and credits `s.baseBuybackBudget[baseDeliveredToken] += amount` where `baseDeliveredToken` is the Base-side token address that CCIP actually delivered, NOT the source-chain token address (Codex round-6 P1 #11 — a source-chain token address may not exist on Base and may collide across chains). The receiver then calls `TreasuryFacet.absorbRemittance(baseDeliveredToken, amount, srcChainId)`. The receiver is part of the cross-chain layer alongside `CcipMessenger` and `VaipakamRewardMessenger` — Sub 3 builds it as a separate UUPS contract.

**Sub 3 also explicitly registers the source-chain diamond as the buyback channel handler** on every chain's `CcipMessenger` (Codex round-6 P1 #7). `CcipMessenger.sendMessage` only accepts calls from `channelOf[msg.sender]`; without this registration step, every `remitBuyback` call reverts on the messenger's authorization check. The mirror configuration step also registers the Base `BuybackRemittanceReceiver` as the cross-chain peer for the buyback channel.

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
// Each slot stores BOTH the dayId AND the balance — this lets the
// TWA scanner reject slots whose dayId falls outside the active
// window without depending on a derived index (Codex round-4 P1 #2
// caught that a wrap-around in `dayId % 30` indexing without an
// in-slot dayId mis-labels old balances after day 30).
struct DaySnapshot { uint16 dayId; uint128 balance; }
mapping(address => DaySnapshot[30]) dayBalances;
mapping(address => uint16)          lastUpdateDayId;   // most recent day written
mapping(address => uint16)          currentStakeStartDayId;
// dayId of the user's most recent 0→positive balance transition.
// Reset to 0 on positive→0 transition so the next stake re-seeds
// the tenure clock from scratch (Codex round-6 P1 #1 — a primed
// wallet that previously waited out the gate can't carry old
// tenure across a zero-balance gap).

// Bumped by ConfigFacet on any tier-threshold or BPS mutation.
// Mirrors treat a stale `tierTableVersion` as tier 0 until a
// fresh push catches them up. (Codex round-6 P1 #10.)
uint16 tierTableVersion;

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

// Protocol-funded broadcast budget (native gas on Base). Topped
// up by treasury allocation; consumed by `_protocolBroadcastTierUpdate`
// on every nonce-bumping rollup pass. (Codex round-5 P1 #3 —
// closes the user-skips-downgrade-broadcast abuse vector by
// removing user agency from the broadcast trigger.)
uint256 protocolBroadcastBudget;
```

Cold cost per active staker on Base: 30 `DaySnapshot` array elements — Solidity allocates one slot per element of a struct array even when the struct itself fits in less than a slot, so the ring buffer is 30 slots, NOT 15 (Codex round-6 P2 #12). Plus 3 metadata slots (`lastUpdateDayId`, `currentStakeStartDayId`, `tierExpirySec`) + 1 push-nonce slot + per-destination last-pushed (1 slot per active destination per user). Sub 1 includes the precise gas snapshot vs the existing Phase-5 accumulator.

**Mirror-side additions:**

```
struct CachedTier {
    uint8  tier;             // current cached EFFECTIVE_TIER (0-4) — post-min-history gate, propagated as-is from Base
    uint40 lastUpdateSec;    // wall-clock of last cache write (used for the secondary max-age safety cap)
    uint64 lastNonce;        // monotonic ordering key — payload nonce, NOT timestamp
    uint40 tierExpirySec;    // absolute timestamp past which the cached tier is stale-by-construction; `type(uint40).max` if no projected crossing (Codex round-6 P1 #9)
    uint16 tierTableVersion; // Codex round-6 P1 #10 — staleness signal when governance mutates tier thresholds
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
| `cfgTwaMinStakedDays`                 | uint8   | 3           | 2 ≤ x ≤ 14 (lower bound raised from 1 per Codex round-6 P2 #13 — `= 1` reopens the same-day flash-stake gaming case) |
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
| 2   | **Cross-chain — `VaipakamRewardMessenger` extension** | Add `TierUpdated` message kind; Base outbound on tier-change; mirror inbound handler writes `userTierCache`; mirror-side fee-path reads from cache; **extend the messenger's payload-size gate to accept BOTH the existing 4-word REPORT/BROADCAST shape AND the new 6-word `TierUpdated` shape** (Codex round-4 P1 #5); **route business-peer authentication through the messenger's existing `channelPeer` mapping, NOT raw `Any2EVMMessage.sender`** (Codex round-4 P1 #4); full fork-test on Base Sepolia → Sepolia mirror.                                                                                                                              |
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
