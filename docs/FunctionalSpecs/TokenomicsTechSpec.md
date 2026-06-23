# Vaipakam VPFI Tokenomics & Multi-Chain Deployment – Technical Specification

> **SUPERSEDED IN PART by the #687 legal-surface excision (2026-06-23).** Two
> features described below were **removed** and are no longer in scope:
> - the **`5% APR` staking yield** (#687-B) — see §7;
> - the **fixed-rate VPFI sale** / Early Fixed-Rate Purchase Program (#687-A) —
>   see §8.
>
> **Kept and unchanged:** the balance-based **fee-discount tiers** (vault-held VPFI
> still lowers fees — it simply no longer earns a yield) and the **interaction
> rewards** pool. Their freed `25%` allocation (24% staking + 1% sale) is a Reserve
> pending governance reallocation (see §3). Any active-voice reference below to
> "earning staking rewards/APR" or "buying VPFI at a fixed rate" is **historical**
> and overridden by this banner.

## 1. Token Overview

- **Token Name:** Vaipakam DeFi Token
- **Symbol:** `VPFI`
- **Total Supply Cap:** `230,000,000` VPFI
- **Initial Mint:** `23,000,000` VPFI
- **Initial Mint Location:** minted on canonical `Base` deployment at launch
- **Primary Purpose:** protocol and governance token for Vaipakam

Primary uses:

- paying and receiving discounted protocol fees through Vault-held VPFI
- earning interaction rewards on protocol usage (loan interest paid / received)
- future governance in `Phase 2`

Key principles:

- strong early-user incentives through front-loaded emissions
- predictable capped supply curve
- real protocol utility through fee discounts
- treasury strengthening through ETH and wBTC recycling
- pull-model reward distribution rather than automatic reward pushes
- single global supply enforcement across multiple chains

Scope note:

- token deployment, minting, utility, fee discounts (Vault-held VPFI), and interaction rewards are in active scope for `Phase 1` (the fixed-rate sale and the `5% APR` staking yield were removed — see the supersede banner at the top)
- governance activation remains `Phase 2`
- Phase 1 lending, vault, oracle, and risk mechanics remain unchanged unless an approved tokenomics integration explicitly extends them
- this document is the canonical home for the borrower VPFI `Loan Initiation Fee` path; the former standalone borrower-discount specification has been merged here so future references should point to this tokenomics spec

---

## 2. Token Parameters

| Parameter        |                                       Value | Notes                      |
| ---------------- | ------------------------------------------: | -------------------------- |
| Name             |                       `Vaipakam DeFi Token` | Standard ERC-20 metadata   |
| Symbol           |                                      `VPFI` | Same symbol across chains  |
| Decimals         |                                        `18` | Standard ERC-20 precision  |
| Total Supply Cap |                         `230_000_000 ether` | Hard cap enforced on-chain |
| Initial Mint     |                          `23_000_000 ether` | Exactly 10% of cap         |
| Mint Access      | `TreasuryFacet` / multi-sig behind timelock | No direct EOA minting      |

Implementation target:

- token contract path: `contracts/src/token/VPFIToken.sol`
- cross-chain token standard: Chainlink Cross-Chain Token using CCIP
- Phase 1 active scope here: token deployment, cap enforcement, initial mint, mint registration, mint-control plumbing, and live fee-utility integration
- frontend consumers should read the token contract's live `decimals()` value for VPFI unit formatting, with `18` as the graceful fallback while reads are loading or unavailable

---

## 3. Token Allocation

| Category                              | Percentage |     VPFI Amount | Vesting / Release Notes                          |
| ------------------------------------- | ---------: | --------------: | ------------------------------------------------ |
| Founders                              |       `6%` |    `13,800,000` | 12-month cliff + 36-month linear vesting         |
| Developers & Team                     |      `12%` |    `27,600,000` | Same vesting as founders                         |
| Testers & Early Contributors          |       `6%` |    `13,800,000` | 6–12 month cliff                                 |
| Platform Admins / Operational Roles   |       `3%` |     `6,900,000` | Timelock controlled                              |
| Security Auditors                     |       `2%` |     `4,600,000` | One-time grants upon delivery                    |
| Regulatory Compliance Pool            |       `1%` |     `2,300,000` | One-time                                         |
| Bug Bounty Programs                   |       `2%` |     `4,600,000` | Ongoing, locked in multi-sig                     |
| Exchange Listings & Market Making     |      `12%` |    `27,600,000` | Liquidity + CEX incentives                       |
| Ecosystem / Community / Marketing     |       `2%` |     `4,600,000` | 0 cliff + ~12–18 mo linear; ops/governance multisig — see §3a |
| Platform Interaction Rewards          |      `30%` |    `69,000,000` | Usage-based rewards                              |
| Reserve (pending reallocation)        |      `25%` |    `57,500,000` | Freed by the #687 excision (24% staking + 1% fixed-rate sale) — disposition governance-pending |
| **Total (pre-reconciliation)**        |   **101%** | **232,300,000** | See note — normalization to 100% / 230M is governance-pending |

> **Reserve + reconciliation note.** The `25%` Reserve is the allocation freed by
> the #687 legal-surface excision — the `5% APR` staking-rewards pool (`24%`,
> removed in #687-B; see §7) and the Early Fixed-Rate Purchase Program (`1%`,
> removed in #687-A; see §8). Its final disposition — held in reserve, burned to
> reduce the `230M` cap, or otherwise reallocated — is a **pending governance
> decision**, shown here as a placeholder so the freed supply is accounted for.
> The granular rows above currently sum to `101%` / `232.3M` — a **pre-existing**
> over-allocation that predates this excision. Normalizing to exactly `100%` /
> `230M` (the Whitepaper §11.2 table shows one candidate reconciliation: dropping
> the granular Regulatory-Compliance and Ecosystem rows and setting Market Making
> to `14%`) is part of the same pending governance reallocation; the Market-Making
> figure itself (`12%` here vs `14%` in the whitepaper) is one of the open items.

### 3a. People-pool semantics (Founders / Team / Testers / Ecosystem)

The four allocation lines that fund people are reserved **mint headroom**,
not pre-minted bags. The 230M is a *cap*, not a mandatory mint — an
unallocated pool is simply never minted (lower circulating supply).

- **Founders (6%)** — the founder's genuine ownership stake. 1-year
  cliff + 4-year linear vesting via a per-grantee `VaipakamVestingWallet`.
- **Developers & Team (12%)** — ongoing developer / operational hires.
  The solo founder, being also the sole developer, draws a *defined*
  developer grant from this pool — **not** the whole pool; the remainder
  stays as genuine hiring headroom. Each hire gets their own vesting
  wallet, granted as they join (founder-set in Phase 1; governance-
  approved from Phase 2).
- **Testers & Early Contributors (6%)** — early / pre-launch supporters
  (beta testers, pre-TGE community contributors). Shorter cliff because
  the contribution is front-loaded. Granted per-contributor, same
  mechanism.
- **Ecosystem / Community / Marketing (2%)** — a small genesis bridge so
  the protocol can run launch-window marketing before fee revenue makes
  treasury-funded marketing viable. **0 cliff + a short (~12–18 mo)
  linear release** — it must be spendable at launch. Held by an
  ops/governance multisig, **not** the founder's wallet. Ongoing
  marketing beyond the launch window is treasury OpEx (see the
  Treasury convert + distribution flow).

**None of the non-founder pools ever revert to the founder.** If a pool
is under-used, that headroom stays unminted; repurposing long-unused
headroom is a governance decision directed to community uses
(staking-reward top-up / burn), never a founder transfer. This is what
keeps a solo-founder cap table clean — the founder's hard share is 6%,
and the rest is genuinely earmarked for others.

---

## 4. Platform Interaction Rewards

Phase note:

- this section is `Phase 1` scope

Pool size:

- `30%` of total supply
- `69,000,000` VPFI hard-capped for this reward category

Emission schedule based on the `23,000,000` initial mint:

| Period         | Annual Rate | Duration           | Approx. Daily Pool |
| -------------- | ----------: | ------------------ | -----------------: |
| Months `0–6`   |       `32%` | `0.5 yr`           |     `~20,164 VPFI` |
| Months `7–18`  |       `29%` | `1 yr`             |     `~18,274 VPFI` |
| Months `19–30` |       `24%` | `1 yr`             |     `~15,123 VPFI` |
| Months `31–42` |       `20%` | `1 yr`             |     `~12,603 VPFI` |
| Months `43–54` |       `15%` | `1 yr`             |      `~9,452 VPFI` |
| Months `55–66` |       `10%` | `1 yr`             |      `~6,301 VPFI` |
| Months `67–78` |        `5%` | `1 yr`             |      `~3,151 VPFI` |
| Month `79+`    |        `5%` | until category cap |      `~3,151 VPFI` |

Exact daily reward formula:

```solidity
rawReward = (1/2) * (userDailyInterestNumeraire / totalDailyInterestNumeraire)
            * currentAnnualRate
            * (1/365)
            * 23_000_000
```

Per-user interaction reward cap:

```solidity
userRewardCap = eligibleUserInterestETHEquivalent * 500

finalReward = min(rawReward, userRewardCap)
```

Distribution rules:

- `50%` of each daily interaction-reward pool goes to lenders, proportional to daily interest earned
- `50%` goes to borrowers, proportional to daily interest paid
- daily interaction rewards are still calculated on a day-by-day basis, but the first reward day (`day 0`) is excluded from reward calculation
- borrower-side interaction rewards are earned only on clean full repayment
- lender-side interaction rewards also remain locked until the corresponding loan is closed; lenders cannot claim interaction rewards while the loan is still active
- borrower-side interaction rewards become claimable only after repayment closes the loan
- in practice, both lender and borrower interaction rewards are unlocked only after the relevant loan has closed, even though the reward amounts are computed from daily accounting
- on each reward side, each user's daily interaction reward is capped at `0.5 VPFI` for every `0.001 ETH` equivalent of eligible interest
- equivalently, the maximum interaction reward rate is `500 VPFI` per `1 ETH` equivalent of eligible interest
- the ETH-equivalent cap must be computed from the same eligible per-user interest amount already credited into the interaction-reward accounting for that day, using the protocol's on-chain pricing path
- if the proportional formula produces a value above the user's cap, the user receives only the capped amount and the unused remainder stays in the interaction-reward allocation rather than being re-assigned to other users for that day
- once the `69,000,000` VPFI category cap is exhausted, platform interaction rewards must stop
- distribution must follow a pull model only via `claimInteractionRewards()`
- the frontend claim surface for interaction rewards belongs in `Claim Center`, above per-loan claim rows, rather than on a combined Rewards page
- the interaction-rewards UI should show:
  - pending claimable VPFI from `previewInteractionRewards(user)`
  - lifetime claimed VPFI reconstructed from `InteractionRewardsClaimed` events
  - an expandable list of contributing loans, with lender-side and borrower-side participation shown separately when both exist on the same loan
- the contributing-loans list should report numeraire-denominated participation (`perDayNumeraire18`, total contribution, day window, processed / forfeited state) and link each row to Loan Details; it should not imply a precise per-loan VPFI amount because rewards are normalized by the protocol-wide daily denominator
- if a day is waiting for the global denominator to be finalized or broadcast to the local chain, the frontend should show a waiting state instead of submitting a claim that would revert

Public read surface:

- `previewInteractionRewards(user)` returns the current pending VPFI headline for the active chain
- `getUserRewardEntries(user)` returns the full `RewardEntry[]` array from storage, including loan ID, side, start / end day, per-day numeraire contribution, processed state, and forfeited state
- `InteractionRewardsClaimed(user, fromDay, toDay, amount)` events are the source for lifetime-claimed totals in the UI and log-index cache
- the Dashboard may summarize interaction-reward pending + lifetime claimed, but Claim Center remains the canonical interaction-reward claim surface

---

### 4a. Cross-Chain Reward Accounting

Phase note:

- this subsection is `Phase 1` scope, deployed alongside the rest of §4

Problem:

- the reward formula's denominator `totalDailyInterestNumeraire` is **protocol-wide**, not per-chain
- because the Vaipakam core protocol is deployed as **independent Diamond instances** on `Base`, `Ethereum`, `Polygon`, `Arbitrum`, and `Optimism` (see §7), each chain only sees its own local interest flow
- computing rewards against a local-only denominator would give a lender on a quiet chain an outsized share and dilute a lender on a busy chain — this breaks the "one protocol, one reward curve" property that justifies the 30% allocation

Topology:

- `Base` is the **canonical reward chain** — consistent with the canonical VPFI token rule and the §7 canonical-address rule
- every non-canonical Diamond (mirror chains) acts as a **reporter**: at day-close it publishes its daily interest total to `Base` over the approved cross-chain messenger
- `Base` acts as the **aggregator**: it accumulates chain totals into `dailyGlobalInterestNumeraire` and then **broadcasts that single number back** to every mirror
- `claimInteractionRewards()` runs **locally on each chain** using the mirror's own user-level interest data and the broadcast global denominator — users never have to leave their lending chain to claim once the relevant loan has closed

Day-close emission contract (mirror → Base):

- trigger: the first interaction on day `D+1 UTC` (lazy rollover) or a permissionless poke function `closeDay(D)` if no traffic rolls the day naturally
- payload:
  - `dayId` (uint64, UTC day number)
  - `chainInterestNumeraire18` (uint256, 1e18-scaled, sum of `lenderInterestEarned + borrowerInterestPaid` on that chain for day `D`, quoted in the active numeraire)
- transport: the configured cross-chain messenger from the mirror Diamond to the `Base` Diamond, restricted to approved chain and peer channels
- each `(dayId, sourceChainId)` pair must be idempotent on the `Base` side — duplicate messages for the same day are rejected

Finalization on Base:

- storage key: daily chain interest by day and source EVM chain id
- finalization rule: `dailyGlobalInterestNumeraire[dayId]` is finalized once all expected mirror chain ids have reported for `dayId`, OR after a **4-hour grace window** past `dayId + 1` UTC, whichever comes first
- any late-arriving report is recorded for audit but does **not** retroactively change a finalized global — this preserves claim determinism
- finalization records must identify participating chains by EVM chain id, not by legacy cross-chain endpoint identifiers

Broadcast back to mirrors (Base → mirror):

- once finalized, `Base` sends the finalized `dailyGlobalInterestNumeraire[dayId]` to every mirror through the configured cross-chain messenger
- mirrors store it as `knownGlobalInterest[dayId]` — this is the denominator used by their local `claimInteractionRewards()` once the relevant loan-close gate is satisfied
- a claim for `dayId` reverts locally if `knownGlobalInterest[dayId] == 0` (not yet broadcast)

Pull-query alternative:

- if the selected cross-chain stack exposes a reliable read-style query, `Base` may pull each mirror's daily interest total directly at day-close rather than waiting for mirror push messages
- once that pull model is available on every Phase 1 chain, it may replace the mirror-side push path with an aggregator-driven pull
- the mirror-side broadcast of `dailyGlobalInterestNumeraire` still happens either way; the pull model only covers the inbound reporting leg

Reward pool funding on mirrors:

- the interaction-reward VPFI pool (`69,000,000` cap) is held on `Base` (canonical mint chain)
- per-day per-chain VPFI payout budget = `(dailyChainInterest[D][chainId] / dailyGlobalInterestNumeraire[D]) × dailyPool[D]`
- the `Base` treasury bridges that budget to each mirror through the configured cross-chain token path as part of finalization
- mirror-side `claimInteractionRewards()` draws from the local VPFI reward vault after the relevant loan has closed; no synthetic IOUs, no cross-chain claim hops

Accounting identity:

- because each chain's VPFI slice is scaled by `chainInterest / globalInterest`, the uncapped per-user payout `½ × (userInterest / globalInterest) × dailyPool` is mathematically identical to `½ × (userInterest / localChainInterest) × chainSlice`
- after that proportional result is computed, the protocol applies the per-user cap: `finalReward = min(rawReward, userRewardCap)`
- this lets users claim locally while still preserving the protocol-wide denominator and the per-user reward-rate ceiling

Failure modes and safety:

- **missing chain for day D** (e.g. RPC outage on a mirror past the grace window): treated as `chainInterest = 0`; finalization emits a missed-chain report keyed by day and EVM chain id; governance may replay a reconciliation payment from the Insurance pool but must not reopen a finalized `dayId`
- **cross-chain message outage / delayed packet**: claims for affected days are simply delayed (not lost) — the pull model's natural backstop
- **timestamp drift across chains**: day boundary is fixed to UTC 00:00 on-chain via `block.timestamp / 1 days`; small per-chain block-time drift is absorbed within the 4-hour grace window
- **double-counting**: `(dayId, chainId)` idempotency key on the Base side prevents replay; mirror emits are guarded by a last-reported-day check
- **re-org on a mirror**: if a mirror reorgs after emission, the message may be lost mid-flight; cross-chain message redelivery handles most cases, governance replay handles the long tail

Diamond surface (Phase 1 to add):

- `RewardReporterFacet` (on every mirror): day-close reporting and local chain-interest views
- `RewardAggregatorFacet` (on Base only): inbound report handling, day finalization once the grace window elapses, and known-global-interest views
- `ClaimFacet` (on every chain): `claimInteractionRewards(dayId[])` using `knownGlobalInterest[dayId]` as denominator

Testing requirements beyond §9:

- simulate a 3-chain mesh (Base + 2 mirrors) end-to-end including day rollover, finalization, broadcast, and local claim
- invariant: `sum(userPayout[d]) across all chains == dailyPool[d]` for every finalized `d`
- invariant: no user can claim `dayId` before `knownGlobalInterest[dayId]` is set on their chain
- test that interaction rewards remain non-claimable while a loan is still active, and become claimable only after the loan is closed
- test that `day 0` / the first reward day is excluded from interaction-reward calculation
- test that a user's reward is capped at `0.5 VPFI` per `0.001 ETH` equivalent of eligible interest even when the proportional formula would otherwise pay more
- negative test: late-arriving mirror report after finalization is stored but does not alter payouts

## 5. Yield Fee

The protocol charges a **Yield Fee of `1%`** on all interest accrued by lenders.

This fee is automatically collected and directed to Treasury for protocol sustainability, buybacks, reward distribution, and ecosystem growth.

### 5a. Loan Initiation Fee Matcher Share

For ERC-20 loans, the borrower-facing `Loan Initiation Fee` remains the normal fee source documented in the borrower VPFI path below. When a loan is initiated by a permissionless Range Orders matcher, a configurable share of the treasury-directed LIF flow is paid to the matcher / relayer that submitted the transaction.

Rules:

- the default matcher share is `1%` of the LIF amount that would otherwise flow to treasury
- governance may tune the matcher share through live protocol config (`ProtocolConfig.lifMatcherFeeBps` / `ConfigFacet.setLifMatcherFeeBps(uint16)`), with zero meaning "use the default"
- the setter should enforce `MAX_FEE_BPS = 5000` (50%) so a bad governance or admin action cannot accidentally starve Treasury
- the matcher share applies to both the lending-asset LIF path and the VPFI LIF custody path; for deferred VPFI settlements, the matched loan must retain the matcher address so the share can be paid on proper settlement or forfeiture
- the frontend and bot should read the live matcher-fee BPS from `getProtocolConfigBundle()` where they display economics or compute expected match outcomes
- this incentive is intentionally compatible with permissionless matching: community bots can compete to find valid pairs, while protocol logic still determines terms and protects both offer creators

---

## 6. Fee Discounts and VPFI Utility

Phase note:

- this section is `Phase 1` scope

Both lender and borrower discounts are resolved from the user's protocol-tracked VPFI stake on the canonical `Base` deployment. Base computes the user's effective tier, and supported mirror chains apply a cached copy of that Base-resolved tier. Moving VPFI into the Vaipakam Vault on the canonical chain automatically counts as staking for discount-tier purposes. Code-level contracts, storage fields, function names, and diagnostics may continue to use `vault`.

**Tiered Discount Table**  
applies to both lenders and borrowers

| Tier   | Vaulted VPFI Balance      | Discount | Lender Effective Yield Fee | Borrower Effective Initiation Fee |
| ------ | -------------------------- | -------: | -------------------------: | --------------------------------: |
| Tier 1 | `>= 100` and `< 1,000`     |    `10%` |                     `0.9%` |                           `0.09%` |
| Tier 2 | `>= 1,000` and `< 5,000`   |    `15%` |                    `0.85%` |                          `0.085%` |
| Tier 3 | `>= 5,000` and `<= 20,000` |    `20%` |                     `0.8%` |                           `0.08%` |
| Tier 4 | `> 20,000`                 |    `24%` |                    `0.76%` |                          `0.076%` |

Shared rules:

- discount tiers are derived from the user's protocol-tracked Vaipakam Vault VPFI balance on the canonical chain, then propagated to mirrors through the approved cross-chain reward messenger
- Base computes an `effective tier` and `effective discount bps`; mirrors must apply the cached effective values rather than recomputing tier math locally
- effective VPFI utility balance must be clamped to `min(actualVaultBalance, protocolTrackedVaultBalance[user][VPFI])` so unsolicited direct transfers cannot inflate fee-discount tiers
- moving VPFI into the Vault automatically counts toward the fee-discount tier
- the user must explicitly consent through a single platform-level on-chain flag to allow vaulted VPFI to be used for fee discounts
- in the frontend, this shared consent should be managed from `Dashboard`, not as an offer-level, loan-level, or `Buy VPFI`-page-only toggle
- once this common consent is enabled, no separate offer-level or loan-level consent is required
- toggling consent must not by itself trigger a cross-chain tier broadcast; only tier-affecting rollups or an explicit user poke should attempt propagation

Lender rules:

- the lender-side discount applies to the `Yield Fee`
- the lender-side discount applied at repayment, preclose, refinance, or other lender-yield settlement must equal the user's current effective discount at that fee-application moment
- on Base, the current effective discount comes from the canonical time-weighted tier accumulator
- on mirrors, the current effective discount comes from the authenticated mirror tier cache
- loan-opening snapshots may remain for compatibility and analytics, but they must not drive the discount bps once the canonical effective-tier system is active
- a lender cannot obtain a higher discount by briefly topping up just before settlement because the effective tier is gated by the canonical TWA, minimum-history, and minimum-tier-over-history rules below
- when consent is active and sufficient VPFI is available, the system should automatically deduct the required discounted VPFI amount from lender vault to Treasury

Borrower rules (Phase 5 and later):

- the borrower-side discount applies to the `Loan Initiation Fee`
- the borrower VPFI path applies only when the lending asset is liquid under the active-chain `RiskFacet` / `OracleFacet` checks; illiquid assets use the normal lending-asset `0.1%` `Loan Initiation Fee` with no VPFI discount path
- the borrower must have the shared platform-level fee-discount consent enabled; no separate offer-level or loan-level VPFI consent is required once that setting is active
- when consent is active and sufficient VPFI is available, the system deducts the FULL (non-discounted) `Loan Initiation Fee` equivalent in VPFI from the borrower's vault at loan acceptance; this VPFI is held in protocol custody (the Diamond) for the life of the loan rather than flowing immediately to Treasury
- when the VPFI path succeeds, `100%` of the requested lending asset is delivered to the borrower because the initiation fee has been satisfied entirely from vaulted VPFI
- the borrower-side rebate bps at proper settlement must equal the user's current effective discount at that fee-application moment: Base reads the canonical accumulator, and mirrors read the authenticated cached tier
- on proper close (normal repay, borrower preclose, refinance), the Diamond splits the held VPFI into a borrower rebate (held × effective-discount-bps / 10000) and a treasury share (the remainder); the rebate becomes claimable on the borrower's position NFT and is paid out atomically with the normal borrower claim; the treasury share is accrued to Treasury at settlement
- on default or HF-based liquidation, the entire held VPFI is forfeited to Treasury with no rebate
- on refinance, the OLD loan's borrower rebate is credited at settlement (the borrower earned that window fairly); the NEW loan gets a fresh opening snapshot and tracks a new independent window
- pre-upgrade loans that predate Phase 5 carry zero-valued custody and no opening snapshot, so they silently settle with no rebate — they never paid VPFI up front

Received VPFI from protocol-fee flows should be handled under the Treasury Recycling Rule below.

### 6a. Functional Discount Mechanics

Canonical effective-tier mechanics:

- Base is the canonical tier-resolution chain. A user's effective tier is decided on Base and then propagated to supported mirror chains.
- The canonical tier calculator must use a bounded 30-day ring buffer of protocol-tracked VPFI stake snapshots.
- The default launch weighting is the recent 7 days at weight `3` and the previous 23 days at weight `1`, with governance-bounded knobs for recent-day count, total window, recent weight, minimum staked days, and mirror cache max age.
- The effective tier must remain `0` until the user's current positive-stake tenure has satisfied the minimum-history gate. The launch default is 3 elapsed days; the gate is based on elapsed seconds, not only UTC day buckets.
- A user's history must reset when their protocol-tracked VPFI stake transitions from positive to zero. A later restake must satisfy the minimum-history gate again.
- The effective tier must be clamped by the minimum tier observed over the configured minimum-history window, preventing dust-then-bulk deposits from earning a high tier immediately.
- Same-day balance history must preserve both the day's minimum balance and the day's closing balance. The minimum is used for the anti-gaming clamp; the close is used for TWA and gap-fill continuity.
- Protocol-tracked VPFI, not raw token balance alone, is the source of truth for tier math. Direct unsolicited token transfers into a vault must not inflate the effective tier.
- A user whose stake ages into eligibility without a balance mutation may call the explicit tier-poke action to roll up and broadcast their now-effective tier.

Mirror-cache mechanics:

- Mirror chains do not recompute the ring-buffer tier locally. They apply an authenticated cached tuple containing the effective tier, effective discount bps, computation time, nonce, expiry, and tier-table version.
- A mirror cache entry is usable only if it is non-zero, matches the current mirror tier-table version, has not passed its tier-expiry timestamp, and is no older than the configured mirror max age.
- The default mirror max-age backstop is 60 days. Expired or stale mirror entries must resolve to tier `0` until refreshed.
- Tier pushes are protocol-funded and may fail closed when the protocol broadcast budget is exhausted or no broadcast destinations are configured. Dust tier-0 rollups should silent-skip rather than drain the broadcast budget.
- Per-user tier pushes must be nonce-ordered. A stale nonce must not overwrite a fresher mirror cache entry.
- Governance tier-table threshold or bps changes must bump a version number. The version bump invalidates stale mirror cache entries until fresh tier data reaches the mirror.
- Version bumps must propagate atomically across the broadcast set: mirrors should apply the new version as a cache invalidation boundary rather than recomputing local bps values.

Discount application:

- Lender yield-fee discounts and borrower LIF rebates both read the current effective discount bps at the settlement moment.
- On Base, settlement reads the canonical effective tier. On mirrors, settlement reads the mirror cache.
- If the user's shared fee-discount consent is disabled, the effective discount is `0` even if the user has sufficient VPFI stake.
- The dapp should distinguish "balance qualifies for a raw tier" from "effective tier is active now." During the min-history window, a user may see that their stake qualifies for a tier while the fee path still applies tier `0`.

Governance effects:

- Governance may change discount-tier thresholds and per-tier discount percentages.
- Changes must be versioned so mirrors cannot continue applying old bps values under a new table.
- Previously closed settlements are never reopened by a later tier-table change.

---

### 6b. Borrower Loan-Initiation Fee VPFI Path

Objective:

- borrowers who hold VPFI deposit it into their canonical Vaipakam Vault on Base, and use the resulting effective tier to satisfy the full `0.1%` `Loan Initiation Fee` up front on Base or any mirror chain with a fresh cache (VPFI is acquired by transfer/holding — the fixed-rate sale was removed; see the supersede banner)
- the borrower then earns the documented discount as an effective-tier VPFI rebate only if the loan closes properly
- this removes the old point-in-time gaming vector where a borrower could briefly top up VPFI only at acceptance or settlement time to capture a full discount

Eligibility and fallback:

- the lending asset must be liquid on the active lending chain according to the existing `RiskFacet` / `OracleFacet` path
- the borrower must have enabled the shared platform-level VPFI fee-discount consent
- the borrower must have enough protocol-tracked VPFI in their canonical staking vault, and enough usable fee-payment balance on the settlement chain where the up-front VPFI LIF is deducted, to cover the full, non-discounted `0.1%` `Loan Initiation Fee` equivalent
- Vault-held VPFI is a special non-collateral asset: it does not count toward collateral value, Health Factor, liquidation value, or LTV support
- Vault-held VPFI on Base continues to count as staked under the unified Vault-staking model while also serving as the canonical fee-utility balance for borrower discounts
- if the asset is illiquid, the borrower has insufficient VPFI, or consent is disabled, the system falls back to the normal lending-asset fee path: the borrower pays `0.1%` in the loan asset and receives the net amount after that treasury deduction

Acceptance-time flow:

1. the borrower creates or accepts a loan offer
2. the protocol checks active-chain liquidity through the existing risk / oracle logic
3. the protocol verifies the platform-level VPFI-discount consent flag
4. the protocol resolves the borrower's current effective discount from Base or the active mirror cache
5. for a liquid lending asset, the protocol converts the loan amount into ETH equivalent using the Chainlink-led active-chain pricing path
6. the protocol calculates the full `0.1%` `Loan Initiation Fee`
7. the protocol converts that full ETH-equivalent fee into exact VPFI required at the fixed rate `1 VPFI = 0.001 ETH`
8. if vault balance is sufficient, the protocol deducts that VPFI from borrower vault into Diamond custody and sends `100%` of the requested lending asset to the borrower

Settlement:

- on normal repayment, borrower preclose, or refinance, the protocol resolves the borrower's current effective discount from Base or the active mirror cache
- borrower rebate formula: `rebate = heldVPFI * effectiveDiscountBps / 10000`
- the borrower rebate is claimable by the borrower-side Vaipakam NFT holder and is paid with the ordinary borrower claim
- the unrewarded remainder of the held VPFI becomes Treasury's share
- on default or HF-based liquidation, the borrower rebate is `0` and all VPFI held for that loan is forfeited to Treasury

Storage requirements:

- store or derive borrower discount tiers from canonical protocol-tracked VPFI stake and authenticated mirror cache entries
- for each loan that uses the VPFI LIF path, store the full VPFI amount held in protocol custody and any rebate claimable after proper settlement
- track borrower LIF custody and rebate state by loan ID
- keep all storage additions append-only in the existing Diamond storage libraries

Events:

- emit when the VPFI LIF path is selected and the full up-front VPFI amount is custody-held, including loan ID, borrower, lending asset, and VPFI amount
- emit when a borrower VPFI rebate is credited
- emit when borrower-held VPFI for a loan is forfeited to Treasury on default or HF-based liquidation

Integration surface:

- reuse the existing `VaultFactory`, loan lifecycle facets, `VPFITokenFacet`, `TreasuryFacet`, shared settlement libraries, and Chainlink-led oracle path wherever possible
- extend vault handling so VPFI can be deducted for fee utility without being treated as collateral
- Treasury must be able to receive and record VPFI fee flows for later recycling under §9
- keep all existing Phase 1 lending, vault, treasury, oracle, risk, and loan-funding semantics unchanged except for the explicit fee-source and VPFI-custody behavior described in this borrower LIF path

---

## 7. Staking Rewards

> **REMOVED (#687-B, 2026-06-23).** The `5% APR` staking-yield pool was excised
> in the legal-surface reduction — the on-chain accrual surface, the APR config,
> and the user-facing yield are gone. **Fee-discount tiers are unaffected**: the
> tier is a balance-based lookup, not a staking reward (see §5). Vault-held VPFI
> still counts toward the discount tier — it simply no longer earns a yield. The
> `24%` allocation is folded into the §3 Reserve pending governance reallocation.
> The text below is retained for historical context only.

Phase note:

- this section is `Phase 1` scope

Pool size:

- `24%` of total supply
- `55,200,000` VPFI

Design rules:

- staking is unified with the user's Vaipakam Vault: any protocol-tracked VPFI held in a user vault on a lending chain is considered staked
- staking is open to any VPFI holder; the user does not need an existing loan, offer, or borrower position to participate
- the first VPFI deposit may create the user's vault automatically, then treat the deposited balance as staked immediately
- Vault-held VPFI earns a single flat APR paid from the Staking Rewards allocation
- the effective staking balance must be `min(actualVaultBalance, protocolTrackedVaultBalance[user][VPFI])` so direct dust sent to the vault cannot earn rewards
- the default launch APR is `5%`, but governance may raise or lower this APR over time through the protocol admin path
- no separate staking contract is required
- rewards are calculated locally on each chain
- rewards must use a pull model, with claims available on the user's preferred chain

Time-weighted reward model:

```text
rewardPerToken = rewardPerTokenStored
               + (rewardRate * (currentTime - lastUpdateTime)) / totalStaked
```

```text
userReward = userBalance * (rewardPerToken - userRewardPerTokenPaid)
           + userPendingReward
```

Definitions:

- `userBalance` = current protocol-tracked VPFI balance in the user's Vaipakam Vault, clamped to raw token balance
- balances update on every deposit, fee deduction, or withdrawal

Primary reward claim path:

- `claimStakingRewards()`

Frontend claim surface:

- staking rewards are claimed from the connected-app `Buy VPFI` page (`/app/buy-vpfi`), colocated with the `Deposit / Stake` step
- a compact mirror may appear on the Dashboard's discount-status surface, but `/app/buy-vpfi` remains the canonical full claim surface
- the card should show pending VPFI, lifetime claimed VPFI reconstructed from `StakingRewardsClaimed(user, amount)` events, and neutral / inactive chrome when `pending == 0`
- the Dashboard may include a combined rewards summary that adds staking pending, staking lifetime claimed, interaction pending, and interaction lifetime claimed into a single discovery surface with links back to the canonical claim cards
- the former combined in-app Rewards route should not be treated as the canonical reward-claiming surface; staking rewards and platform-interaction rewards have separate natural homes

### 7a. Functional Staking-APR Mechanics

Era semantics:

- each distinct staking APR value that has been active should be treated as its own effective reward era
- when governance changes the APR, the outgoing era's accrual must first be closed and folded into the global staking accumulator before the new APR becomes active
- this close-the-books step is mandatory so that a newly set APR cannot retroactively apply to time that elapsed before the change
- past staking accrual can never be retroactively inflated or clawed back by a later governance update

Dormant-user protection:

- a user who deposits VPFI into vault and then remains inactive across multiple APR changes must still receive the correctly weighted sum of accrual from each APR era when they eventually claim
- dormant users do not need to interact at every governance change in order to preserve historical APR entitlements
- the global staking accumulator and the user's standard reward-debt accounting must preserve that full era history implicitly

Active-user protection:

- a user who deposits, withdraws, claims, or otherwise changes vault balance between APR changes should accrue at each APR only for the exact time intervals during which that APR was active while that balance was held
- user interaction must not reset or refresh the APR itself; it only refreshes the user's balance-based staking position against the globally active APR history

Governance audit trail:

- every governance APR change should emit an event recording the new APR and the timestamp when it took effect
- that event stream is the authoritative historical audit trail for APR changes; no separate on-chain history array is required

### 7b. Cross-Mechanism Invariants

- every canonical vault-balance change, including deposit, withdrawal, claim-to-vault, and fee-driven VPFI deduction, must refresh the user's staking position and canonical effective-tier state where applicable
- governance changes to staking APR, discount thresholds, or discount percentages must always apply prospectively; previously accrued staking rewards remain priced under the APR that was active during the relevant elapsed period, and discount-table changes must invalidate stale mirror cache entries through the tier-table version
- dormant holders must not lose historical staking accrual simply because they did not interact during a governance-change window
- no user action at a single late moment should be able to inflate rewards or discounts for prior elapsed time or minimum-history windows that were spent at a lower balance or lower tier

---

## 8. Early Fixed-Rate Purchase Program

> **REMOVED (#687-A, 2026-06-23).** The fixed-rate public sale was excised in the
> legal-surface reduction — the on-chain buy surface (`VpfiBuyAdapter` /
> `VpfiBuyReceiver` / the CCIP buy channel) and the `/app/buy-vpfi` sale flow are
> gone (the route now redirects to the deposit/withdraw VPFI vault). The price
> anchor was renamed and retained **only** to quote the fee discount
> (`setVPFIDiscountRate`), not to sell VPFI. The `1%` allocation is folded into the
> §3 Reserve pending governance reallocation. The text below is retained for
> historical context only.

To enable easy early access to VPFI for discounts:

- fixed rate: **`1 VPFI = 0.001 ETH`**
- allocation: `1%` = `2,300,000 VPFI`
- global cap: `2,300,000 VPFI`
- per-wallet cap: configurable by admin, applied per origin EVM chain id rather than as one cross-chain wallet cap
- initial recommendation: `30,000 VPFI` per wallet per chain — this is the live per-chain user limit surfaced on `/app/buy-vpfi` until admin explicitly reconfigures it
- ETH received from the fixed-rate purchase program is sent to Treasury and recycled according to the Treasury Recycling Rule
- when the purchase flow routes through the Base canonical receiver, VPFI must be minted or released only after the Base receiver has actually received ETH; quoted, requested, or expected ETH amounts must never be enough to mint VPFI by themselves
- the VPFI amount delivered to the buyer must be based on the ETH amount actually received by the Base receiver

### 8a. User-Facing Purchase Flow

The public `/buy-vpfi` route is a no-wallet marketing / education surface. The wallet-bearing `Buy VPFI` controls live inside the connected app at `/app/buy-vpfi`. The app page never asks the user to switch manually to the canonical `Base` chain. Any cross-chain routing, canonical-chain settlement, or CCIP activity needed under the hood is abstracted away by the page itself.

Two explicit user steps, in this order:

1. **Buy** — the user, connected to their preferred supported chain (`Base`, `Arbitrum`, `Polygon`, `Optimism`, or `Ethereum mainnet`), pays ETH at the fixed rate directly from the page. Purchased VPFI is delivered to the user's wallet **on that same preferred chain** — never auto-routed into vault, and never requiring a manual chain switch. If the flow settles on the canonical Base receiver, receipt of ETH on Base is the mint/release trigger.
2. **Deposit / Stake to vault** — a separate, explicit user action on the same app page moves VPFI from the user's wallet into the user's canonical Vaipakam Vault on Base. This step is always explicit: the protocol never auto-funds vault after a buy or a bridge. Once deposited, the balance begins the canonical staking and effective-tier lifecycle; mirror-chain discounts become available only after the Base tier is effective and propagated. Where supported, this deposit may use Uniswap Permit2 at `0x000000000022D473030F116dDEE9F6B43aC78BA3` so the user signs one EIP-712 authorization and executes the vault deposit in a single transaction; the classic approve-plus-deposit path remains the fallback.

Per-wallet cap display:

- when the admin has not yet configured a per-wallet cap on-chain, `/app/buy-vpfi` MUST display the Phase 1 recommendation (`30,000 VPFI`) as the effective per-chain cap — `Uncapped` is not a valid user-facing state
- the displayed "your remaining allowance" always equals `effectiveCap - soldToWallet`, where `effectiveCap` falls back to `30,000 VPFI` when `perWalletCap == 0` on-chain
- this allowance is keyed by the buyer and the origin EVM chain id where the buy originated; buying up to the cap on one origin chain does not by itself consume the user's allowance on another chain unless admin later introduces an explicit cross-chain cap model
- fixed-rate buy allowance remains keyed by origin chain, while discount-tier rights are keyed by the canonical Base staking state and its mirror-cache propagation

VPFI held in the canonical vault simultaneously satisfies the staking model and the fee-discount tier table in §6. A single canonical stake can qualify loans on supported mirror chains once the effective tier has propagated, but stale or missing mirror cache entries resolve to tier `0` until refreshed.

The app VPFI vault page should expose `Deposit` and `Withdraw` entry points as route anchors (the former `Buy` anchor was removed with the fixed-rate sale — see the supersede banner). `Deposit` is the wallet-to-canonical-vault step; `Withdraw` is the canonical-vault-to-wallet path. The public marketing route may link into those anchors, but should not itself mount wallet controls.

The `Deposit` step should carry the single canonical user-facing message: depositing is open to everyone, no existing loan is required, vault-held VPFI counts toward the fee-discount tier while it remains deposited (it does **not** earn a yield — the `5% APR` staking pool was removed), and the user's vault can be created automatically on first deposit. Duplicated page-level prose should be avoided so this card remains the source of truth.

Payment-token mode requirements:

- the cross-chain VPFI buy adapter owns the payment-token choice; users submit an amount but must not be able to choose an arbitrary ERC-20 at call time
- native-gas mode (`paymentToken == address(0)`) is valid only on chains whose native gas token is ETH-equivalent for the fixed-rate quote model, such as Ethereum, Base, Arbitrum, Optimism, Polygon zkEVM, and their public testnets
- chains whose native gas token is not ETH-equivalent, including BNB Chain and Polygon PoS mainnet, must use WETH-pull mode with that chain's canonical bridged WETH9 token
- adapter initialization and payment-token rotation must reject EOAs, non-ERC-20 contracts, and ERC-20s whose `decimals()` value is not `18`, so an operator cannot accidentally configure USDC or another wrong-decimal token as the ETH-equivalent payment asset
- deployment scripts should pre-flight strict-WETH chains and refuse native-gas mode there, while logging payment-token metadata for operator confirmation against the published canonical WETH address
- the frontend should display the actual buy asset for the active chain and adapter mode rather than hardcoding `ETH`; native-gas chains should show the chain's native gas asset, while WETH-pull chains should show the configured bridged WETH token and provide a verification link to the relevant market-data page
- in WETH-pull mode, approval and balance checks should target the configured ERC-20 payment token; cross-chain execution fees remain paid in the chain's native gas token and should be labelled with that native symbol
- buy-adapter deployments should configure sane default CCIP lane and execution settings so quotes and buys can work immediately after deploy without a separate post-deploy tuning ceremony
- mirror-chain `VPFIBuyAdapter` deployments must expose `getRateLimits()` returning the per-request cap and rolling 24-hour daily cap configured through `setRateLimits`
- deployment health checks and mainnet verify phases must treat unlimited default buy-adapter rate limits as a hard readiness failure; operators should be able to verify configured limits through public getters rather than raw storage-slot inspection
- canonical chains that do not deploy a buy adapter are exempt from buy-adapter rate-limit checks

Cross-chain buy settlement hardening:

- the canonical receiver must not send fixed-rate buy VPFI directly to an arbitrary buyer wallet on the source chain; delivery should route through the approved source-chain buy adapter
- the delivery message must include the buy request identity, and the source-chain adapter must release VPFI only when a matching pending buy exists and names the buyer recorded by the local buy request
- forged or replayed deliveries must not pay an arbitrary wallet; unmatched or already-settled request identities should be recorded as stuck VPFI and recoverable only by owner / governance to a configured recipient
- inbound delivery must authenticate the approved cross-chain messenger, the source chain, the remote messenger, and the expected token peer before any buyer-facing release
- a separate success reply path should not be required for successful buys; the authenticated token delivery is the success signal and should release source-chain vaulted payment to treasury where applicable
- if a buyer overpays the quoted cross-chain execution fee, the buy path should forward only the required fee and refund the surplus to the buyer

Permit2 requirements for VPFI utility flows:

- Permit2 support is an optional convenience path for VPFI deposits and other eligible ERC-20 actions; it must not remove or weaken the classic ERC-20 allowance flow.
- Permit signatures should use 30-minute expiries, high-entropy nonces, and exact asset / amount / spender scope.
- The Diamond should validate the target VPFI asset and deposit amount before pulling through Permit2.
- Token-level allowances remain under the user's control; Permit2 should live beside the legacy path rather than becoming a silent global approval replacement.

---

## 9. Treasury Recycling Rule

All VPFI received as fees is recycled as follows (the fixed-rate-sale ETH inflow described historically in §8 was removed with that program — see the supersede banner):

- **`38%` → Buy ETH**
- **`38%` → Buy wBTC**
- **`24%` → Held as VPFI**

If the insurance / bug bounty pool exceeds `2%` of total supply, any surplus VPFI is also recycled using the same `38 / 38 / 24` split.

Fee-converted VPFI priority routing:

- every partial buyback fill's delivered VPFI should cascade through three destination budgets in priority order: reward-emissions top-up, keeper-reward top-up, then staking-pool buyback overflow
- governance-configured top-up targets decide how much each priority budget can claim; a zero target disables that step and passes the delivered VPFI to the next destination
- the priority split must be sum-preserving: every delivered VPFI unit is assigned to exactly one of rewards, keepers, or staking overflow
- with both top-up targets at their default `0`, the entire fill continues to land in the staking-pool buyback budget
- reward-emissions budget credit is intended to offset fresh VPFI minting once the rewards distributor reads it; until that distributor path is active, the budget may accumulate without affecting mint flow

Keeper reward budget:

- permissionless housekeeping calls may receive VPFI rewards from the keeper-reward budget when the reward switch is enabled
- the reward amount is based on gas used, transaction gas price, a governance-bounded multiplier, and the active VPFI/ETH pricing policy
- Phase 0 uses the fixed VPFI buy rate; the LP TWAP path and cash-out spread are reserved for a later phase
- keeper reward payment must never block the housekeeping action itself. Disabled rewards, empty budget, missing VPFI configuration, zero gas, or other reward failure states should emit or record a skipped reward outcome and let the housekeeping work complete

Productive treasury reserve:

- governance may deploy idle treasury assets into approved external yield venues, subject to a per-token deploy-time exposure cap
- Aave V3 is the Phase 0 operational venue; Lido venue configuration is reserved but not usable until the WETH unwrap and withdrawal-queue flow is active
- the external-yield cap is checked when funds are deployed. It is not a continuously enforced liquidity floor after later treasury debits or conversions
- external principal and in-diamond treasury balance must remain separately visible so operators can monitor liquid reserve levels and venue exposure

Treasury management:

- governance should be able to convert accumulated fee assets into a configured reserve-asset allocation in one deliberate treasury action
- the reserve set should be governance-configurable as ordered asset / percentage targets that must sum to `100%`
- treasury conversion should avoid dust-sized execution by requiring either a minimum value threshold or a maximum time-since-last-conversion threshold
- converted output remains in protocol-controlled treasury custody; treasury conversion is not a user reward push

Founder and contributor compensation:

- contributor salary streams should be explicit budgeted treasury expenses, funded deliberately for a budget period and withdrawable only up to the funded amount
- salary streams must not be automatic percentages of protocol fees and must not be funded implicitly when fees accrue
- genesis founder, team, early-contributor, and ecosystem grants should use per-grantee vesting wallets with the approved cliff and linear-release terms
- real genesis funding actions, including founder grants and salary-stream activation, should remain gated on legal sign-off before token generation

---

## 10. Multi-Chain Deployment Strategy

Standard:

- Chainlink Cross-Chain Token through CCIP

Purpose:

- enforce a single global supply cap across multiple supported chains

Primary chain:

- `Base`

Additional rollout chains for the intended Phase 1 production rollout:

- `Arbitrum`
- `Polygon`
- `Optimism`
- `Ethereum mainnet`

Deployment flow:

1. deploy the canonical VPFI token on `Base`
2. if an initial supply tranche is used for treasury- or allocation-managed distribution, mint it to the secure multi-sig plus timelock-controlled treasury setup (the fixed-rate purchase program that this constraint originally guarded was removed in #687-A — see the supersede banner)
3. deploy connected mirror-token and cross-chain messenger contracts on the additional supported chains
4. wire CCIP lanes, remote messengers, token pools, and channel peers so cross-chain transfers preserve one global supply model
5. keep token symbol and metadata consistent as `VPFI` on every supported chain
6. configure mirror-chain buy-adapter rate limits to finite caps before verification; adapters that remain at unlimited deployment defaults must be treated as not production-ready
7. mark Base as the canonical VPFI tier chain before opening fee-discount flows
8. configure mirror chains with the approved reward messenger, Base chain id, mirror-tier max age, and any required broadcast destinations
9. top up the protocol broadcast budget before expecting automatic tier pushes or version-bump broadcasts to reach mirrors
10. hand cross-chain messenger, token-pool, rate-governor, reward-messenger, adapter, and Cross-Chain Token administrator authority to the configured Timelock / Governance Safe path only from the current on-chain owner key, with scripts reading current authority first and skipping with operator guidance when the signer does not match
11. verify every cross-chain lane from the perspective of both the local chain and the remote chain before it is considered production-ready

Architecture clarification:

- only `VPFI`, reward-accounting messages, tier-cache messages, and approved treasury-buyback remittances are cross-chain through CCIP
- the Vaipakam lending / borrowing / rental core protocol remains single-chain per deployment
- in Phase 1, the core protocol should be deployed as separate Diamond instances on `Base`, `Polygon`, `Arbitrum`, `Optimism`, and `Ethereum mainnet`
- loans, offers, collateral, repayment, claims, liquidation, preclose, refinance, and keeper actions must stay local to the deployment chain of that specific protocol instance
- all protocol-owned cross-chain accounting should key chain identity by EVM chain id. Legacy endpoint-id style identifiers must not be used for per-wallet buy caps, reward reports, events, or frontend / watchdog reconciliation.

Canonical-address rule:

- the Base deployment is the documented source of truth
- canonical addresses must be published in `docs/` and surfaced on the public dashboard / transparency UI
- CREATE2 deployment salts and version strings are part of the token deployment artifact. Where shared deterministic addresses are intended, rehearsals should confirm address parity across chains; if a predicted address already has bytecode from a prior rehearsal, operators should either reuse the idempotent deployment state or bump the documented salt / version before resuming.

CCIP hardening requirements:

- Chainlink CCIP is the intended Phase 1 cross-chain provider. The platform must rely on CCIP's uniform security model rather than a per-integrator verifier-policy configuration surface.
- domain-level reward and tokenomics wording should describe the business action as reporting chain interest, broadcasting a global denominator, or moving VPFI between supported chains. Provider-specific behavior should stay isolated to the approved CCIP messenger adapter, and public or generated documentation should not describe the current system with retired LayerZero / OApp terminology.
- every cross-chain surface that sends or receives runtime messages should have a fast guardian pause path wired during configuration. Pure administration surfaces that only manage limits or ownership may be documented as exceptions when they do not move messages, but mirror-chain token contracts remain in scope because they participate directly in cross-chain VPFI movement.
- the messenger must maintain allowlists for supported remote chains, remote messengers, and channel peers, and must reject inbound or outbound messages outside those allowlists
- chain selector and channel-handler configuration must stay one-to-one. A governance or operator action that would make one local chain map to multiple remote identities, or one channel map to multiple handlers, must be rejected rather than silently replacing state.
- cross-chain token transfers must have bounded, governance-tunable rate limits per lane. Defaults must not be unlimited, and rate limits must not be disabled entirely.
- outbound messages should reject duplicate token entries and invalid chain identity values before attempting a send
- inbound messages should reject out-of-range or mismatched chain identity values rather than silently attributing a message to the wrong chain
- fixed-rate cross-chain buys must release VPFI only when the source-chain delivery matches a genuine pending buy recorded for the same buyer and request identity
- successful fixed-rate buys should use authenticated token delivery as the success signal; a separate cross-chain success reply should not be required to complete a valid purchase
- fixed-rate buy reconciliation should be monitored off-chain: canonical-chain processed buy events should be cross-checked against source-chain `BuyRequested` events by request id, buyer, and amount
- the buy-reconciliation watchdog should run from the operations Worker, read canonical-chain processed-buy events, resolve the originating EVM chain id to that source chain's RPC and adapter address, and verify that a matching source-chain `BuyRequested` event exists with the same request id, buyer, and amount
- the buy-reconciliation watchdog should expose an on-chain kill switch for planned ceremonies; auto-pausing on mismatch is an operations decision for a later phase, not a Phase 1 requirement
- watchdog coverage requires operator-provided source-chain RPC secrets for every configured buy lane. Missing RPC secrets should cause that lane to be skipped with an operator-visible log rather than causing the entire watchdog pass to fail.
- off-chain monitoring should watch configured CCIP lane, token-pool, messenger-peer, and rate-limit state for drift
- off-chain monitoring should check cross-chain token supply invariants by comparing canonical-chain locked / minted accounting against the sum of mirror-chain supplies
- off-chain monitoring should alert on oversized single-transaction VPFI flows above an operator-configured threshold
- the CCIP ops watcher should remain internal / private and separate from the public HF watcher / keeper reference implementation
- CCIP watcher secrets and lane configuration should remain chain-scope explicit. Mainnet-shaped environment keys must not be populated with testnet addresses just to make a rehearsal worker start; use testnet-specific configuration or leave the lane disabled.

---

## 11. Distribution and Claiming Mechanics

Phase note:

- reward claiming and emission-driven distribution are `Phase 1` scope
- Phase 1 includes token deployment, minting, discounts, fixed-rate access, and vault-based staking

Distribution model:

- all user rewards must use pull-based claiming only
- no automatic reward pushes to arbitrary wallets

Primary claim paths:

- `claimInteractionRewards()`
- `claimStakingRewards()`

Initial mint routing:

- initial supply should be sent to a secure `Gnosis Safe` and timelock-controlled structure rather than to a plain EOA

Locked / vested allocations:

- founders, team, and similar long-tail allocations should use `OpenZeppelin VestingWallet` or an equivalent audited vesting / timelock implementation

Transparency expectations:

- remaining reward pools
- active emission rate
- claimable user amounts
- lifetime claimed totals derived from reward-claim events
- per-user interaction reward entries and contributing-loan state
- minted totals
- discount eligibility state where applicable

These values should be exposed through public view functions on the treasury / tokenomics side, likely through `TreasuryFacet`, a lightweight `VPFITokenFacet`, and the token contract itself.

**VPFI token-address lifecycle.** The VPFI token address registered on the Diamond is expected to be set **once**, at deploy. Rotating it to a different address afterwards is a controlled, migration-class operation. The restrictions that read the currently-registered token within a position's lifetime — VPFI forbidden as an NFT-rental prepay asset, and the VPFI-collateral encumbrance consult — assume a stable token address, so a rotation performed while exposure to the old token is still live must follow the operational rotation procedure (reduce inflow while keeping drain paths open — a blanket pause would deadlock the drain; actively drain ALL old-token exposure, namely offers on any leg, loans on any leg, encumbrances, AND protocol-tracked vault balances such as staked VPFI; then hard-freeze and **re-verify zero old-token exposure under the freeze** — the authoritative backstop that does not depend on a perfect inflow-surface list — before rotating; re-enable). A rotation must additionally be observable on-chain via a distinct rotation audit signal, emitted only when an actual rotation occurs (not on the one-time initial registration), so operations can confirm the procedure was followed. Liened collateral is never at risk in a mis-sequenced rotation — each user's collateral lien is protected independently of which token is "current". Un-liened protocol-tracked old-token balances (e.g. staked VPFI), however, would be stranded after a rotation (the standard VPFI withdraw resolves to the new token and the stuck-token recovery path releases only untracked balances) until governance acts — recoverable, not permanently lost, but the reason the rotation procedure must drain every tracked old-token balance, not only offers and loans.

---

## 12. Implementation Requirements

Architecture requirements:

- integrate with the existing Diamond pattern
- keep tokenomics logic primarily in `TreasuryFacet` plus a new lightweight `VPFITokenFacet`
- keep the token contract itself in `contracts/src/token/`

Coding standards:

- full NatSpec on every new function
- use `ReentrancyGuard` and `Pausable` where appropriate
- use project-standard custom errors via `IVaipakamErrors`
- emit events for every mint, claim, buyback, discount-sensitive action where relevant, and every rate change
- prioritize gas efficiency and reuse shared protocol libraries where it makes sense, including `LibVaipakam`, existing oracle logic, and shared accounting helpers
- protect all new VPFI purchase, vault deposit, fee deduction, rebate settlement, and treasury-receipt functions with the project-standard reentrancy guard and global pausable mechanism unless the function is a pure/view helper
- every public or external function added for VPFI purchase, vault deposit, fee deduction, rebate settlement, or treasury receipt must have NatSpec that describes the fee source, custody behavior, and settlement outcome

Storage and event requirements:

- track total VPFI sold through the fixed-rate program, the global sale cap, and the per-wallet cap in append-only Diamond storage
- track per-chain wallet sale usage so the Phase 1 `30,000 VPFI` recommendation is enforced and displayed as a chain-local allowance
- track VPFI held for borrower LIF custody, claimable borrower rebates, and forfeited treasury shares by loan ID
- emit VPFI purchase events with buyer, VPFI amount, ETH amount, and origin chain context where applicable
- emit vault-deposit, LIF-custody, rebate-credit, rebate-forfeit, and treasury-receipt events in the relevant facets

Testing requirements:

- extend the existing scenario tests
- extend invariant coverage
- include supply-cap enforcement tests
- include cross-chain token and messenger configuration tests where practical
- include reward-accounting and vesting tests
- include buyback-routing tests
- include explicit wallet-to-vault deposit tests for both Permit2 and classic approve-plus-deposit paths
- include liquid-asset borrower LIF VPFI tests across every discount tier
- include effective-tier borrower rebate tests for min-history pending, last-minute top-up, unstake-down, mirror-cache stale, and governance-tier-version-change cases
- include illiquid-asset fallback tests where the borrower pays the normal lending-asset LIF
- include default and HF-liquidation tests proving held VPFI is forfeited to Treasury with no rebate
- include normal repayment, borrower preclose, and refinance tests proving proper rebate crediting
- include tests that vault-held VPFI updates fee-discount accrual without being counted as collateral
- include admin pause / disable tests for fixed-rate buying after cap exhaustion or sale shutdown

Frontend integration requirements:

- Phase 1 frontend requirements should focus on token-address transparency, supply visibility, mint/cap visibility where exposed, and clear separation between the cross-chain VPFI token and the single-chain core protocol
- `Dashboard`, `ClaimCenter`, staking views, and reward hooks may gain broader VPFI utility surfaces in `Phase 1`
- `Dashboard` should specifically surface the shared fee-discount consent control for vaulted VPFI usage
- the VPFI tier / discount-status table should live near the connected-app `Buy VPFI` purchase / deposit decision, while Dashboard remains the home for the fee-discount consent toggle and combined rewards summary
- protocol-config-dependent UI copy should read live values from the Diamond wherever possible, including mutable config from `getProtocolConfigBundle()` and compile-time constants exposed through `getProtocolConstants()`
- tier tables, rental buffer displays, max slippage, treasury fee, LIF, and minimum Health Factor copy should use live config placeholders instead of hardcoded locale text
- VPFI tier thresholds returned in base units should be converted through shared token-display helpers before they appear in tier tables, consent copy, or tooltip placeholders
- `/app/buy-vpfi` should let users buy from their preferred supported chain without manually switching to canonical `Base`
- `/app/buy-vpfi` is the single user-facing purchase / stake / unstake flow; public `/buy-vpfi` is the education surface. Any bridge, canonical-chain settlement, cross-chain token routing, or Base-receiver complexity must be abstracted behind the app flow.
- the purchase page must show the exact ETH required, resulting VPFI amount, fixed rate, remaining global supply, and chain-local wallet allowance
- after purchase, the page should guide a separate explicit wallet-to-canonical-vault deposit action on Base; it must not auto-deposit purchased VPFI into vault
- the deposit step should prefer Permit2 where supported, fall back cleanly to classic approval, and explain that Permit2 is optional convenience rather than a replacement for token-level allowance control
- transaction review for buying VPFI, depositing VPFI to vault, and accepting a loan through the VPFI path should include the standard transaction-preview surface where available and fail soft if preview is unavailable
- borrower-facing pages should show current vaulted VPFI balance, current tier, discount eligibility for liquid assets, and the fact that vault-held VPFI also counts as staked
- `Create Offer` and `Loan Details` should provide clear entry points into `/app/buy-vpfi`
- `Offer Book` accept-review copy should explain that the borrower pays the full `0.1%` LIF up front in VPFI and earns any discount over the loan lifetime as a rebate
- `Create Offer` borrower-tip copy should frame the benefit as earning up to a `24%` VPFI rebate, not as paying a reduced up-front fee
- `Claim Center` should show a VPFI rebate line whenever a borrower claim includes a pending LIF rebate
- `Claim Center` should also host platform-interaction reward claims, including lifetime claimed and contributing-loan context (the former `/app/buy-vpfi` staking-reward-claim surface was removed with the `5% APR` staking yield — see the supersede banner)

Acceptance criteria:

- borrowers can purchase VPFI with ETH from the dedicated preferred-chain app page and receive VPFI in their wallet on that same chain
- borrowers can explicitly move that VPFI from wallet to their canonical Vaipakam Vault before expecting discount-tier rights to propagate
- eligible liquid-asset loan acceptance checks liquidity, fee-discount consent, borrower fee-payment balance, effective-tier availability, Chainlink-led ETH conversion, full `0.1%` LIF computation, and exact VPFI deduction before sending `100%` of requested lending asset to the borrower
- properly closed loans credit an effective-tier VPFI rebate; defaulted or HF-liquidated loans forfeit the held VPFI to Treasury
- global caps, per-chain wallet caps, pausing, event transparency, NatSpec coverage, and Diamond storage compatibility are satisfied

---

## 13. Notes on Phase Separation

- this document defines `Phase 1` token deployment, fee utility, fixed-rate acquisition, vault-based staking, and transparency tooling
- broader governance activation remains `Phase 2`
- it does not retroactively change the already-specified Phase 1 loan lifecycle, collateral rules, liquidation rules, vault model, or oracle model unless an approved implementation note says otherwise
- any future fee-discount integration must be applied carefully so it adjusts treasury-fee outcomes without breaking the core Phase 1 accounting invariants
