# VPFI Discount System

T-087 (full umbrella). Code-free, implementation-independent description of how a user's VPFI stake produces a yield-fee discount they receive at settlement — on the canonical chain (Base) and across every mirror chain Vaipakam deploys to.

This spec complements [`CrossChainTierPropagation.md`](CrossChainTierPropagation.md) (transport-layer mechanics for how the cached tier travels) by stating the user-facing INTENT end-to-end: stake → tier resolution → discount application. As required by [`README.md`](README.md), this spec is the test oracle: it states intent, not implementation. Specific function names, storage slots, and library call paths are intentionally omitted; the deployed contracts are what's *under test*, not the source of the spec.

## 1. Purpose

VPFI is the platform's discount-rights token. The protocol charges a yield-fee on lender interest at loan settlement (default 1% of accrued interest; governance-tunable). Users who stake VPFI receive a tiered DISCOUNT on that fee, sized by the amount + age of their stake.

The platform's intent is:

- **Tier on Base, application on each chain.** The tier resolution lives on Base (the canonical chain); the discount is APPLIED at settlement time on whichever chain the loan lives on.
- **Time-weighted, not snapshot.** A user can't game the system by topping up VPFI right before a loan settles. The tier reflects a rolling 30-day average AND the minimum tier observed in that window.
- **Permissionless.** No KYC, no allowlist, no governance approval. Stake VPFI; the protocol does the rest.

## 2. Tier table

The discount table is governance-configurable on the canonical chain. The dapp reads the live table at render time; documentation values can drift, so this spec deliberately doesn't enumerate the literal numbers. As of this writing the deployed table is:

| Tier | VPFI required | Discount on yield-fee |
|---|---|---|
| 0 | < tier-1 floor | 0% |
| 1 | tier-1 floor … tier-2 floor − 1 wei | step-1 BPS |
| 2 | tier-2 floor … tier-3 floor − 1 wei | step-2 BPS |
| 3 | tier-3 floor … tier-3 ceiling | step-3 BPS |
| 4 | > tier-3 ceiling | step-4 BPS |

Floors and ceilings are governance-set on the canonical chain only. The cached tier carries the canonical discount BPS with it to every mirror; mirror chains do NOT re-resolve the user's tier against any mirror-local table. The dapp's `/app/buy-vpfi` page renders the live canonical table.

## 3. Canonical-chain lifecycle

### 3.1 Stake

The user deposits VPFI into their per-user vault on the canonical chain. This increments the protocol-tracked vault balance — the accumulator's source of truth (direct-transfer dust into the vault does NOT count; only deposits through the proper path do). The deposit also advances the accumulator at the post-deposit balance.

### 3.2 Tier derivation

The accumulator maintains a 30-day ring buffer of daily-closing balances per user. The user's effective tier is derived from TWO observations across the buffer:

1. **TWA tier** — weighted average of the daily balances:
   - Last 7 days × 3.
   - Previous 23 days × 1.
2. **Min-tier observed** — the LOWEST tier reached during the configured minimum-history window.

The effective tier is the MINIMUM of those two. This means:
- A "top-up right before a loan settles" doesn't immediately bump the tier — the topped-up amount accumulates through the TWA.
- A partial unstake that DROPS below the current tier's floor downgrades the effective tier IMMEDIATELY on the next read — the min-tier-observed clamp captures the new lower floor.
- A partial unstake that STAYS within the current tier's range smooths into the TWA over the rolling window while the min-history clamp continues to look only at the configured minimum-history window.

### 3.3 Min-history gate

A brand-new staker doesn't immediately get the discount. The protocol requires holding qualifying VPFI for at least a configurable number of days (default 3) before the effective tier unlocks. Reasoning: prevents a 1-block "deposit-claim-withdraw" gaming pattern.

During the aging window:
- The accumulator records the daily balance.
- The user's raw tier (from current balance) might be ≥ 1.
- The user's effective tier (the one the fee path uses) is still 0.
- The dapp surfaces "Your tier is aging — almost there" copy.

### 3.4 Time-only activation

Once the min-history threshold is crossed, the effective tier activates on the canonical chain automatically — no transaction needed. The next on-chain READ of the user's effective tier returns the new value, and the next fee path that touches the user applies the discount.

**But time alone doesn't broadcast the new tier to mirrors.** The broadcast happens only on a state-mutating call to the accumulator. No transaction is invoked just because the calendar advances. Mirror caches get refreshed when the canonical chain's broadcast path runs, which requires:
- Any canonical-chain vault mutation by the user (deposit / withdrawal) that produces a changed, non-zero push tuple.
- An explicit permissionless tier-push call the user makes on the canonical chain, when the current effective tier tuple differs from the last pushed tuple.
- A force-resend / operator catch-up path where available for stale-cache repair.

The broadcast path de-duplicates identical tuples and skips brand-new `(0, 0)` tier pushes so dust or pre-min-history deposits cannot drain the protocol broadcast budget. Until a changed tuple or force-resend path fires, the cached tier on every mirror stays at whatever was last broadcast.

### 3.5 Consent gate

The discount surface is OPT-IN. The user must enable a consent flag for the protocol to apply the discount. Consent is read per-chain at the SETTLEMENT chain — opting in on the canonical chain does NOT auto-enable the discount on mirror chains. The user toggles consent on each chain they want the discount on.

When consent is OFF on the canonical chain:
- The canonical read of the user's effective tier returns (0, 0) regardless of stake.
- A a permissionless tier-push call on the canonical chain pushes (0, 0) to mirrors — clearing the cached tier.

When consent is OFF on a mirror chain:
- The mirror's local fee path skips the discount regardless of cached tier.
- This is a LOCAL opt-out — no broadcast, no cache change. The cached tier on the mirror still says whatever Base last pushed; the mirror just doesn't consult it.

A canonical-chain consent toggle does NOT automatically push (0, 0) to mirrors (anti-drain — see §6). The dapp UI surfaces a manual a permissionless tier-push call prompt on the canonical chain after a consent-off so the user can immediately clear mirror caches.

## 4. Mirror-chain lifecycle

The mirror chain doesn't run the accumulator. It holds a per-user `per-user cached tier` slot that the canonical chain populates by CCIP message. See [`CrossChainTierPropagation.md`](CrossChainTierPropagation.md) for the transport details.

User-facing flow for a discounted mirror-chain loan:

1. User stakes on canonical → tier activates after min-history.
2. Canonical broadcasts the tier on the next user-triggered rollup.
3. CCIP delivers to mirrors; each mirror writes the (tier, bps, expiry, version) to its cache.
4. User takes a loan on the mirror. At settlement, the mirror's fee path requires ALL of:
   - The mirror's cached tier is fresh (not staleness-expired).
   - The cached tier table version matches the mirror's current version.
   - The user's local consent flag on the mirror is ON.
   - The user holds AT LEAST the QUOTED REQUIRED amount of PROTOCOL-TRACKED VPFI in the mirror's local user vault. Only deposits through the proper protocol-tracked path count — direct transfers of VPFI into the vault address are operationally invisible to the fee path and don't qualify. The fee path computes the required VPFI for the discount tier and falls back to the full fee when the protocol-tracked balance is below it.

In practice: the cached BASE tier is what determines the DISCOUNT BPS — the mirror doesn't re-compute against a mirror-local table. But the user still needs ENOUGH VPFI in the mirror vault to cover the quoted requirement + a local consent toggle for the discount to actually apply.

## 5. Governance levers

Tier-system parameters are governance-controlled on the canonical chain:

- **Tier thresholds** — VPFI floors per tier + the Tier-3 ceiling.
- **Tier discount BPS** — discount BPS per tier.
- **Min-history days** — aging gate (default 3).
- **TWA window length** — total ring-buffer span in days (default 30).
- **TWA recent-day count** — how many days at the head of the window count as "recent" (default 7).
- **TWA recent-day weight** — the multiplier applied to recent days vs. older days in the weighted average (default 3, vs. older-day weight 1).
- **Mirror cache staleness threshold** — how long a cached tier is honoured before falling back to (0, 0).

Only the first two (thresholds + BPS) bump the canonical tier-table version + emit a local version-bump event. Mirrors learn the new version only when they receive an inbound TIER-UPDATE message carrying the new (tier, bps, version) tuple from the canonical chain (no separate VersionBumped CCIP message exists today). On a given mirror, the FIRST per-user new-version update that lands raises the mirror's `currentTierTableVersion` — at which point every OTHER user's old-version cached tier on that mirror is treated as stale and falls back to (0, 0) until each user's own next push lands. So a governance change creates a per-mirror cliff: dormant users on that mirror lose their cached discount the moment ANY active user pushes their post-bump update, regardless of when (or whether) the dormant user takes action themselves.

Min-history and mirror staleness changes don't bump the version. The min-history change takes effect at the canonical chain's next user read; the mirror staleness change takes effect at the mirror's next discount read (no rollup or push needed).

## 6. Anti-gaming + anti-drain measures

- **TWA window** — top-up-then-unstake doesn't work. The 30-day weighted average smooths the user's effective stake.
- **Min-tier-observed clamp** — temporary dips below a floor capture the lower tier, blocking a "stake briefly to game the TWA" pattern.
- **Min-history gate** — 3-day delay before effective tier activates.
- **Consent-toggle doesn't itself broadcast** — A consent toggle is a flag flip with no CCIP cost. Otherwise a user could toggle on/off to drain the protocol's CCIP broadcast budget. The dapp lets the user chain a manual a permissionless tier-push call on the canonical chain for an immediate mirror clear if they want it.
- **Protocol-funded broadcasts are budget-gated** — the protocol broadcast budget is a finite ETH pool the operator tops up. When the budget can't cover the CCIP fee for the NEXT non-deduped broadcast, the broadcast facet reverts; the calling rollup bubbles that revert. So a non-deduped broadcast — any of: tier change, BPS change, expiry change, version bump — BLOCKS the underlying canonical-chain mutation (deposit / withdrawal / poke / settlement that would re-rollup the user). The operator must monitor budget burn-rate and top up before exhaustion to avoid user-facing reverts. The combination of de-dup gating (no-op pushes don't burn budget) + per-user mutation frequency means the budget isn't easily drained by a single user, but it IS finite and the failure mode is hard-fail.
- **De-dup gate** — the broadcast facet compares the FULL `(tier, bps, expiry, version)` tuple against the last-pushed snapshot. Repeated no-op pokes don't cost protocol budget, but a same-tier mutation that changes the projected expiry (or a post-governance version bump) DOES count as non-deduped and gets dispatched.

## 7. Two flavours of "discount"

The VPFI discount surface gates TWO distinct fee paths:

1. **Lender yield-fee discount** — applied at loan settlement on the protocol's treasury cut of the lender's accrued interest. The lender's effective tier (read at settlement time) determines the BPS off the standard yield-fee. NOT every settlement triggers a rollup: when the lender has consent off OR no applicable VPFI on the settlement chain, the fee path bails before invoking the accumulator. So a settlement on the canonical chain doesn't ALWAYS re-broadcast the user's tier to mirrors — it does only when the discount path actually engages.

2. **Borrower Loan Initiation Fee (LIF) rebate** — at loan accept time, the borrower's consent + local VPFI gate whether the LIF path engages; if it does, the borrower pays the full configured-LIF equivalent in VPFI from their vault into protocol custody (the LIF percentage is governance-tunable; the historical default is 0.1% but is not hard-coded into the discount path). At proper-close settlement, the custodied VPFI is split into a borrower rebate (sized by the borrower's effective tier read AT SETTLEMENT TIME — T-087 Sub 1B replaced the previous loan-window averaging with an instant read) and a treasury share; the rebate is claimable by the borrower. At default / HF-liquidation, the custodied VPFI is forfeited: for matched loans the matcher's configured share is paid to the matcher first; the net goes to treasury — no borrower rebate.

The LIF flow's consent + local-VPFI gates are evaluated at ACCEPT TIME (not at settlement). Once the LIF is custodied, the proper-close split and the default-forfeit path don't re-check those gates.

Both flavours use the SAME effective tier resolution path. The lender yield-fee flow evaluates consent + local VPFI at every settlement; the LIF flow evaluates them only at accept time.

## 8. What stakers see

The dapp's surfaces (driven by phase 1 + 2 of T-087 Sub 4):

- **LenderDiscountCard** (per-loan): live discount the lender earns on the loan's yield-fee. Distinguishes "no eligible VPFI" from "min-history pending".
- **StakeVPFICTA** (Dashboard): chain-aware CTA. Switches to canonical from a mirror, prompts new stakers, surfaces a manual poke button when useful.
- **VPFIDiscountConsentCard** (Dashboard): consent toggle. Per-chain — the toggle on this card always refers to the chain you're connected to.
- **DiscountStatusCard** (Buy VPFI page): live tier table + the user's current effective tier + the next-tier delta.

## 9. Cross-references

- Transport-layer mechanics of cross-chain push: [`CrossChainTierPropagation.md`](CrossChainTierPropagation.md).
- Tokenomics + tier math: [`TokenomicsTechSpec.md`](../FunctionalSpecs/TokenomicsTechSpec.md) §5–§8.
- Treasury-side buyback that ultimately rewards stakers: [`TreasuryBuyback.md`](TreasuryBuyback.md).
- Code-vs-spec divergence log: [`_CodeVsDocsAudit.md`](../FunctionalSpecs/_CodeVsDocsAudit.md).
