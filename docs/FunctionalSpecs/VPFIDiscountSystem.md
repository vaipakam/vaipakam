# VPFI Discount System

T-087 (full umbrella). Code-free description of how a user's VPFI stake becomes a yield-fee discount they actually receive — across every chain Vaipakam deploys to.

This spec complements [`CrossChainTierPropagation.md`](CrossChainTierPropagation.md) (which covers the cross-chain transport mechanics) by laying out the user-facing intent end-to-end: stake → tier resolution → discount application.

## 1. Purpose

VPFI is the platform's governance + discount-rights token. The protocol charges a yield-fee on lender interest at loan settlement (default 1% of accrued interest, governance-configurable). Holders of VPFI in their per-user vault on the canonical chain (Base) earn a tiered DISCOUNT on that fee, based on the size + age of their stake.

The platform's intent is:

- **Stake on one chain, discount on every chain.** The user stakes once on Base; their tier propagates automatically (via Chainlink CCIP) to every chain they take loans on.
- **Time-weighted, not snapshot.** A user can't game the system by topping up VPFI right before a loan settles. The tier is averaged across a rolling 30-day window.
- **Permissionless.** No KYC, no allowlist, no governance approval. Stake VPFI; the protocol does the rest.

## 2. Tier table

The discount table is governance-configurable at runtime via `setVpfiTierThresholds` + `setVpfiTierDiscountBps`. The dapp reads the live table on every render; documentation values can drift, so this spec deliberately doesn't enumerate the literal numbers. As of this writing the deployed table is:

| Tier | VPFI required | Discount on yield-fee |
|---|---|---|
| 0 | < tier-1 floor | 0% |
| 1 | tier-1 floor … tier-2 floor − 1 wei | step-1 BPS |
| 2 | tier-2 floor … tier-3 floor − 1 wei | step-2 BPS |
| 3 | tier-3 floor … tier-3 ceiling | step-3 BPS |
| 4 | > tier-3 ceiling | step-4 BPS |

Floors and ceilings are configured per-chain by governance; the dapp's [Buy VPFI page](https://vaipakam.com/buy-vpfi) renders the live table.

## 3. Lifecycle on the canonical chain

### 3.1 Stake

The user deposits VPFI into their per-user vault on the canonical chain via `depositVPFIToVault(amount)`. This:

- Pulls `amount` VPFI from the user's wallet.
- Increments the user's `protocolTrackedVaultBalance` — the accumulator's source of truth (direct-transfer dust into the vault is EXCLUDED; only deposits through this function count).
- Calls `rollupUserDiscount(user, newBalance)` on the accumulator, advancing the ring-buffer and re-stamping at the post-deposit balance.

### 3.2 Time-weighted average (TWA)

The accumulator maintains a 30-day ring buffer of daily-closing balances per user. The "effective" tier is derived in TWO steps:

1. **TWA tier** — weighted average across the ring buffer:
   - Last 7 days × 3.
   - Previous 23 days × 1.
2. **Min-tier clamp** — `effectiveTierAndBps` clamps the TWA-derived tier against the MINIMUM tier observed in the ring buffer (`_computeRingBufferMinTier`). This captures same-day lows (a user who briefly dipped below a tier floor during the window) and cross-floor unstakes.

So `effectiveTier = min(tierOf(TWA), minTierObservedInWindow)`. This means:
- A "top-up right before a loan settles" doesn't immediately bump your tier — the topped-up amount accumulates slowly through the TWA.
- A partial unstake that drops below the current tier's floor downgrades IMMEDIATELY on the next read — the min-tier clamp captures the new lower floor.

### 3.3 Min-history gate

A brand-new staker doesn't immediately get the discount. They must hold qualifying VPFI for at least `cfgTwaMinStakedDaysEffective` days (default 3, set via `setTwaMinStakedDays`) before the EFFECTIVE_TIER unlocks. Reasoning: prevents a 1-block "deposit-claim-withdraw" gaming pattern.

During the min-history window:
- The accumulator records the daily balance.
- The user's RAW tier (from current balance) might be ≥ 1.
- The user's EFFECTIVE tier (the one the fee path uses) is still 0.
- The dapp surfaces "Your tier is aging — almost there" copy.

### 3.4 Time-only activation

Once min-history elapses, the EFFECTIVE tier activates AUTOMATICALLY — no transaction needed. The on-chain `getEffectiveDiscount(user)` view starts returning the user's tier. The next fee path that touches the user reads the new value and applies the discount.

For mirror chains, the new tier needs to propagate. Two paths:

1. **Wait for the next balance mutation.** Any deposit / withdrawal / loan-settlement that touches the user triggers a fresh broadcast.
2. **Explicit poke.** The user calls `pokeMyTier()` — a permissionless, balance-mutation-free function that re-rolls the accumulator and triggers the broadcast. The dapp's StakeVPFICTA surfaces a "Push my tier to mirrors now" button when this is useful.

### 3.5 Consent gate

The protocol won't apply the discount unless the user has explicitly opted in via `setVPFIDiscountConsent(true)`. Reasoning: some users (rare, but real) want to keep VPFI in the vault for governance purposes but pay the full yield-fee for accounting clarity.

When consent is OFF:
- `getEffectiveDiscount(user)` returns `(0, 0)` regardless of stake.
- `pokeMyTier()` still works but `ProtocolBroadcastFacet` forces the broadcast tier to 0 — clearing mirror caches.

When consent flips OFF mid-life, mirror caches don't automatically clear (anti-drain — see §6). The dapp's UI prompts the user to chain a `pokeMyTier()` for an immediate clear.

## 4. Lifecycle on a mirror chain

The mirror chain doesn't run the accumulator. Instead, it holds a per-user `userTierCache` slot that the canonical chain populates by CCIP message. See [`CrossChainTierPropagation.md`](CrossChainTierPropagation.md) for the transport details.

User-facing flow:

1. User stakes on canonical → tier activates after min-history.
2. Canonical broadcasts tier to all configured mirrors.
3. CCIP delivers to mirrors; each `MirrorTierReceiverFacet` writes to `userTierCache[user]`.
4. User takes a loan on a mirror → mirror reads `userTierCache[user]` → applies the cached tier as the discount at settlement.

The mirror's cache has staleness gates:
- `cfgMirrorTierMaxAgeSec` — cache discount applies only if `now - cacheWrittenAt < maxAge` (default 60 days; min-floor 30 days).
- `currentTierTableVersion` — if governance bumps the canonical tier table via `setVpfiTierThresholds` / `setVpfiTierDiscountBps`, Base's `s.tierTableVersion` increments AND `TierTableVersionBumped` emits. But mirrors don't see this bump until they receive a `TierUpdated` or `VersionBumped` inbound message from Base. Until then, old-version caches on mirrors continue to apply at the OLD discount values. Operators changing thresholds / BPS should expect a sync delay until the next per-user mutation triggers a broadcast.

## 5. Governance levers

Tier system parameters are governance-controlled via the diamond's admin role (eventually a timelocked multisig):

- `setVpfiTierThresholds(t1, t2, t3, t3Ceiling)` — VPFI floors and Tier-3 ceiling. Bumps `tierTableVersion`.
- `setVpfiTierDiscountBps(t1Bps, t2Bps, t3Bps, t4Bps)` — discount basis points per tier. Bumps `tierTableVersion`.
- `setTwaMinStakedDays(days)` — min-history days (default 3). Does NOT bump `tierTableVersion`; new aging behaviour takes effect on next read.
- `setMirrorTierMaxAgeSec(seconds)` — mirror cache staleness threshold (default 60 days; min-floor 30 days). Does NOT bump `tierTableVersion`; takes effect on next read.

Only the first two (threshold / BPS) invalidate mirror caches via the version bump.

## 6. Anti-gaming + anti-drain measures

- **TWA window** — top-up-then-unstake doesn't work. The 30d weighted average smooths the user's effective stake.
- **Min-history gate** — 3-day delay before effective tier activates.
- **Consent-toggle doesn't broadcast** — `setVPFIDiscountConsent` is a flag-flip with no CCIP cost. Otherwise a user could toggle on/off to drain the protocol's CCIP broadcast budget.
- **Protocol-funded broadcasts are budget-gated** — `protocolBroadcastBudget` is a finite ETH pool the operator tops up. Broadcasts fail-closed when budget is exhausted (rather than blocking the underlying rollup), so a single user can't burn through it forever.
- **De-dup gate** — `ProtocolBroadcastFacet.protocolBroadcastTierUpdate` skips emitting CCIP when the (tier, bps, expiry, version) tuple matches the last-pushed snapshot. Repeated no-op pokes don't cost protocol budget.

## 7. What stakers see

The dapp's surfaces (driven by phase 1 + 2 of T-087 Sub 4):

- **LenderDiscountCard** (per-loan): live discount the lender earns on the loan's yield-fee. Distinguishes "no eligible VPFI" from "min-history pending".
- **StakeVPFICTA** (Dashboard): chain-aware CTA. Switches to canonical from a mirror, prompts new stakers, surfaces a manual poke button when useful.
- **VPFIDiscountConsentCard** (Dashboard): consent toggle.
- **DiscountStatusCard** (Buy VPFI page): live tier table + the user's current effective tier + the next-tier delta.

## 8. Cross-references

- Mechanics of cross-chain push: [`CrossChainTierPropagation.md`](CrossChainTierPropagation.md).
- Tokenomics + tier math: [`TokenomicsTechSpec.md`](TokenomicsTechSpec.md) §5–§8.
- Treasury-side buyback that ultimately rewards stakers: [`TreasuryBuyback.md`](TreasuryBuyback.md).
- Code-vs-spec divergence log: [`_CodeVsDocsAudit.md`](_CodeVsDocsAudit.md).
