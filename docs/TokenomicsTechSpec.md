# Vaipakam VPFI Tokenomics & Multi-Chain Deployment – Technical Specification

## 1. Token Overview

- **Token Name:** Vaipakam Finance Token
- **Symbol:** `VPFI`
- **Total Supply Cap:** `230,000,000` VPFI
- **Initial Mint:** `23,000,000` VPFI
- **Initial Mint Location:** minted on canonical `Base` deployment at launch
- **Primary Purpose:** utility and governance token for Vaipakam

Primary uses:

- paying and receiving discounted protocol fees through escrow-held VPFI
- earning `5% APR` staking rewards through escrow-based staking
- future governance in `Phase 2`

Key principles:

- strong early-user incentives through front-loaded emissions
- predictable capped supply curve
- real protocol utility through fee discounts
- treasury strengthening through ETH and wBTC recycling
- pull-model reward distribution rather than automatic reward pushes
- single global supply enforcement across multiple chains

Scope note:

- token deployment, minting, utility, fixed-rate purchase, discounts, and escrow-based staking are in active scope for `Phase 1`
- governance activation remains `Phase 2`
- Phase 1 lending, escrow, oracle, and risk mechanics remain unchanged unless an approved tokenomics integration explicitly extends them

---

## 2. Token Parameters

| Parameter        |                                       Value | Notes                      |
| ---------------- | ------------------------------------------: | -------------------------- |
| Name             |                    `Vaipakam Finance Token` | Standard ERC-20 metadata   |
| Symbol           |                                      `VPFI` | Same symbol across chains  |
| Decimals         |                                        `18` | Standard ERC-20 precision  |
| Total Supply Cap |                         `230_000_000 ether` | Hard cap enforced on-chain |
| Initial Mint     |                          `23_000_000 ether` | Exactly 10% of cap         |
| Mint Access      | `TreasuryFacet` / multi-sig behind timelock | No direct EOA minting      |

Implementation target:

- token contract path: `contracts/src/token/VPFIToken.sol`
- omnichain token standard: `LayerZero OFT V2`
- Phase 1 active scope here: token deployment, cap enforcement, initial mint, mint registration, mint-control plumbing, and live fee-utility integration

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
| Exchange Listings & Market Making     |      `14%` |    `32,200,000` | Liquidity + CEX incentives                       |
| **Early Fixed-Rate Purchase Program** |       `1%` |     `2,300,000` | Sold at `1 VPFI = 0.001 ETH`, caps admin-managed |
| Platform Interaction Rewards          |      `30%` |    `69,000,000` | Usage-based rewards                              |
| Staking Rewards                       |      `24%` |    `55,200,000` | `5% APR`, escrow-based                           |
| **Total**                             |   **100%** | **230,000,000** | Hard cap enforced on Base                        |

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
rawReward = (1/2) * (userDailyInterestUSD / totalDailyInterestUSD)
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

---

### 4a. Cross-Chain Reward Accounting

Phase note:

- this subsection is `Pahse 1` scope, deployed alongside the rest of §4

Problem:

- the reward formula's denominator `totalDailyInterestUSD` is **protocol-wide**, not per-chain
- because the Vaipakam core protocol is deployed as **independent Diamond instances** on `Base`, `Ethereum`, `Polygon`, `Arbitrum`, and `Optimism` (see §7), each chain only sees its own local interest flow
- computing rewards against a local-only denominator would give a lender on a quiet chain an outsized share and dilute a lender on a busy chain — this breaks the "one protocol, one reward curve" property that justifies the 30% allocation

Topology:

- `Base` is the **canonical reward chain** — consistent with the VPFI OFT canonical rule and the §7 canonical-address rule
- every non-canonical Diamond (mirror chains) acts as a **reporter**: at day-close it publishes its daily interest total to `Base` over LayerZero
- `Base` acts as the **aggregator**: it accumulates chain totals into `dailyGlobalInterestUSD` and then **broadcasts that single number back** to every mirror
- `claimInteractionRewards()` runs **locally on each chain** using the mirror's own user-level interest data and the broadcast global denominator — users never have to leave their lending chain to claim once the relevant loan has closed

Day-close emission contract (mirror → Base):

- trigger: the first interaction on day `D+1 UTC` (lazy rollover) or a permissionless poke function `closeDay(D)` if no traffic rolls the day naturally
- payload:
  - `dayId` (uint64, UTC day number)
  - `chainInterestUSD` (uint256, 1e18-scaled, sum of `lenderInterestEarned + borrowerInterestPaid` on that chain for day `D`)
- transport: LayerZero `OApp.send(...)` from the mirror Diamond to the `Base` Diamond, peered via `setPeer`
- each `(dayId, sourceEid)` pair must be idempotent on the `Base` side — duplicate messages for the same day are rejected

Finalization on Base:

- storage key: `dailyChainInterest[dayId][sourceEid] -> uint256`
- finalization rule: `dailyGlobalInterestUSD[dayId]` is finalized once all expected mirror eids have reported for `dayId`, OR after a **4-hour grace window** past `dayId + 1` UTC, whichever comes first
- any late-arriving report is recorded for audit but does **not** retroactively change a finalized global — this preserves claim determinism
- finalization event: `DailyGlobalInterestFinalized(dayId, dailyGlobalInterestUSD, participatingEids)`

Broadcast back to mirrors (Base → mirror):

- once finalized, `Base` sends the finalized `dailyGlobalInterestUSD[dayId]` to every mirror via `OApp.send(...)`
- mirrors store it as `knownGlobalInterest[dayId]` — this is the denominator used by their local `claimInteractionRewards()` once the relevant loan-close gate is satisfied
- a claim for `dayId` reverts locally if `knownGlobalInterest[dayId] == 0` (not yet broadcast)

lzRead alternative (pull model):

- instead of a push-broadcast, `Base` can issue an `lzRead` query to each mirror at day-close to pull `chainInterestUSD` directly — a single quorum read returns all chain totals in one message
- once `lzRead` is GA on all Phase 1 chains, this replaces the mirror-side push path with a single aggregator-driven pull
- the mirror-side broadcast of `dailyGlobalInterestUSD` still happens either way — `lzRead` only covers the inbound leg

Reward pool funding on mirrors:

- the interaction-reward VPFI pool (`69,000,000` cap) is held on `Base` (canonical mint chain)
- per-day per-chain VPFI payout budget = `(dailyChainInterest[D][eid] / dailyGlobalInterestUSD[D]) × dailyPool[D]`
- the `Base` treasury bridges that budget to each mirror via the existing VPFI OFT path as part of finalization
- mirror-side `claimInteractionRewards()` draws from the local VPFI reward vault after the relevant loan has closed; no synthetic IOUs, no cross-chain claim hops

Accounting identity:

- because each chain's VPFI slice is scaled by `chainInterest / globalInterest`, the uncapped per-user payout `½ × (userInterest / globalInterest) × dailyPool` is mathematically identical to `½ × (userInterest / localChainInterest) × chainSlice`
- after that proportional result is computed, the protocol applies the per-user cap: `finalReward = min(rawReward, userRewardCap)`
- this lets users claim locally while still preserving the protocol-wide denominator and the per-user reward-rate ceiling

Failure modes and safety:

- **missing chain for day D** (e.g. RPC outage on a mirror past the grace window): treated as `chainInterest = 0`; finalization emits `ChainReportMissed(dayId, eid)`; governance may replay a reconciliation payment from the Insurance pool but must not reopen a finalized `dayId`
- **LayerZero outage / delayed packet**: claims for affected days are simply delayed (not lost) — the pull model's natural backstop
- **timestamp drift across chains**: day boundary is fixed to UTC 00:00 on-chain via `block.timestamp / 1 days`; small per-chain block-time drift is absorbed within the 4-hour grace window
- **double-counting**: `(dayId, eid)` idempotency key on the Base side prevents replay; mirror emits are guarded by a `lastDayIdReported` check
- **re-org on a mirror**: if a mirror reorgs after emission, the message may be lost mid-flight; LayerZero redelivery handles most cases, governance replay handles the long tail

Diamond surface (Pahse 1 to add):

- `RewardReporterFacet` (on every mirror): `closeDay(dayId)`, `_sendChainInterest(...)` (private OApp send), view `chainInterestUSD(dayId)`
- `RewardAggregatorFacet` (on Base only): `lzReceive` handler for inbound mirror reports, `finalizeDay(dayId)` (permissionless once the grace window elapses), view `dailyGlobalInterestUSD(dayId)`
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

---

## 6. Fee Discounts and VPFI Utility

Phase note:

- this section is `Phase 1` scope

Both lender and borrower discounts are based purely on the VPFI balance held in the user’s escrow on the respective lending chain. Moving VPFI into escrow automatically counts as staking.

**Tiered Discount Table**  
applies to both lenders and borrowers

| Tier   | Escrowed VPFI Balance      | Discount | Lender Effective Yield Fee | Borrower Effective Initiation Fee |
| ------ | -------------------------- | -------: | -------------------------: | --------------------------------: |
| Tier 1 | `>= 100` and `< 1,000`     |    `10%` |                     `0.9%` |                           `0.09%` |
| Tier 2 | `>= 1,000` and `< 5,000`   |    `15%` |                    `0.85%` |                          `0.085%` |
| Tier 3 | `>= 5,000` and `<= 20,000` |    `20%` |                     `0.8%` |                           `0.08%` |
| Tier 4 | `> 20,000`                 |    `24%` |                    `0.76%` |                          `0.076%` |

Shared rules:

- discount tiers are derived from the user's escrowed VPFI balance on the relevant lending chain, with borrower discounts resolved point-in-time at loan initiation and lender discounts applied through the time-weighted rules below
- moving VPFI into escrow automatically counts as staking
- the user must explicitly consent through a single platform-level on-chain flag to allow escrowed VPFI to be used for fee discounts
- in the frontend, this shared consent should be managed from `Dashboard`, not as an offer-level, loan-level, or `Buy VPFI`-page-only toggle
- once this common consent is enabled, no separate offer-level or loan-level consent is required

Lender rules:

- the lender-side discount applies to the `Yield Fee`
- the lender-side discount must be time-weighted across the life of each loan rather than resolved from the lender's escrow balance at one final settlement moment
- at every moment during a loan, the lender's current escrowed VPFI balance maps to a tier and that tier maps to the corresponding lender discount percentage
- the protocol must continuously track the time-weighted average of that discount percentage over the actual life of the loan
- at repayment, preclose, refinance, or other lender-yield settlement, the discount applied to the lender's `Yield Fee` must equal that time-weighted average discount, not the lender's tier at the settlement moment
- the lender discount tracker should refresh whenever the lender's escrowed VPFI balance changes through deposit, withdrawal, claim-to-escrow, or fee deduction that consumes escrowed VPFI
- each loan should snapshot the user's discount-accrual state at loan open and compute the loan-specific average discount from the delta between settlement and that opening snapshot, divided by the actual elapsed loan duration
- this time-weighted design is required so a lender cannot obtain the full higher-tier discount by topping up VPFI just before repayment
- when consent is active and sufficient VPFI is available, the system should automatically deduct the required discounted VPFI amount from lender escrow to Treasury

Borrower rules:

- the borrower-side discount applies to the `Loan Initiation Fee`
- the borrower-side discount is a one-shot fee resolution taken at the moment of loan acceptance, using the borrower's escrowed VPFI balance and the then-current discount schedule at that exact moment
- the borrower-side discount is not time-weighted, because the `Loan Initiation Fee` is computed, charged, and settled atomically with loan creation rather than over a multi-period interval
- the borrower-side discount does not maintain its own ongoing rollup state beyond the normal escrow balance and staking accounting
- when consent is active and sufficient VPFI is available, the system should automatically deduct the required discounted VPFI amount from borrower escrow to Treasury

Received VPFI from protocol-fee flows should be handled under the Treasury Recycling Rule below.

### 6a. Functional Discount Mechanics

Lender yield-fee discount mechanics:

- the promise is that the lender's yield-fee discount on a specific loan reflects the lender's time-weighted average escrowed-VPFI tier across the life of that loan
- the lender cannot capture a full higher-tier discount by depositing VPFI only shortly before the loan closes
- between balance-changing events, the lender's stamped discount tier remains pinned at the tier that applied when the last balance change happened
- there is no per-block or per-day lender discount rollup; the accounting is driven by balance-change events plus the settlement moment itself
- if a lender spends most of the loan in a lower tier and enters a higher tier only near the end, the resulting discount must be a duration-weighted blend of those tiers

Governance effects on lender discounts:

- governance may change the discount-tier thresholds and the per-tier discount percentages over time
- those governance changes must apply prospectively only
- periods already accrued under the lender's previously stamped tier remain locked at those older values
- a lender is re-evaluated against the current governance schedule the next time their escrow balance changes or when the loan-specific discount is otherwise refreshed through settlement logic
- a lender whose balance stays flat across a governance change should continue accruing under the previously stamped tier until the next refresh event, after which future accrual follows the new schedule

Same-block safety:

- if a lender's escrow balance changes multiple times in the same block, the elapsed time is zero, so no duplicate time accrual should be created
- the tracker should simply stamp the latest balance-driven tier for future elapsed time

Borrower initiation-fee discount mechanics:

- the borrower-side discount remains a point-in-time discount resolved exactly once, at loan initiation
- because the initiation fee is charged and settled atomically, there is no borrower-side time-weighted discount interval for that fee
- borrower escrow balance changes before or after loan initiation do not retroactively alter the borrower discount already applied to that loan
- governance changes to borrower discount thresholds or percentages affect only future loan-acceptance transactions, not already-created loans

---

## 7. Staking Rewards

Phase note:

- this section is `Phase 1` scope

Pool size:

- `24%` of total supply
- `55,200,000` VPFI

Design rules:

- staking is unified with escrow: any VPFI held in a user escrow on a lending chain is considered staked
- escrow-held VPFI earns a single flat APR paid from the Staking Rewards allocation
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

- `userBalance` = current VPFI balance in the user escrow
- balances update on every deposit, fee deduction, or withdrawal

Primary reward claim path:

- `claimStakingRewards()`

### 7a. Functional Staking-APR Mechanics

Era semantics:

- each distinct staking APR value that has been active should be treated as its own effective reward era
- when governance changes the APR, the outgoing era's accrual must first be closed and folded into the global staking accumulator before the new APR becomes active
- this close-the-books step is mandatory so that a newly set APR cannot retroactively apply to time that elapsed before the change
- past staking accrual can never be retroactively inflated or clawed back by a later governance update

Dormant-user protection:

- a user who deposits VPFI into escrow and then remains inactive across multiple APR changes must still receive the correctly weighted sum of accrual from each APR era when they eventually claim
- dormant users do not need to interact at every governance change in order to preserve historical APR entitlements
- the global staking accumulator and the user's standard reward-debt accounting must preserve that full era history implicitly

Active-user protection:

- a user who deposits, withdraws, claims, or otherwise changes escrow balance between APR changes should accrue at each APR only for the exact time intervals during which that APR was active while that balance was held
- user interaction must not reset or refresh the APR itself; it only refreshes the user's balance-based staking position against the globally active APR history

Governance audit trail:

- every governance APR change should emit an event recording the new APR and the timestamp when it took effect
- that event stream is the authoritative historical audit trail for APR changes; no separate on-chain history array is required

### 7b. Cross-Mechanism Invariants

- every escrow-balance change, including deposit, withdrawal, claim-to-escrow, and fee-driven VPFI deduction, must refresh the user's staking position and the lender-side time-weighted discount tracker where applicable
- governance changes to staking APR, discount thresholds, or discount percentages must always apply prospectively; previously accrued value must remain priced under the schedule that was active during the relevant elapsed period
- dormant holders must not lose historical accrual simply because they did not interact during a governance-change window
- no user action at a single late moment should be able to inflate rewards or discounts for prior elapsed time that was spent at a lower balance or lower tier

---

## 8. Early Fixed-Rate Purchase Program

To enable easy early access to VPFI for discounts:

- fixed rate: **`1 VPFI = 0.001 ETH`**
- allocation: `1%` = `2,300,000 VPFI`
- global cap: `2,300,000 VPFI`
- per-wallet cap: configurable by admin, applied per chain rather than as one cross-chain wallet cap
- initial recommendation: `30,000 VPFI` per wallet per chain — this is the live per-chain user limit surfaced on the `Buy VPFI` page until admin explicitly reconfigures it
- ETH received from the fixed-rate purchase program is sent to Treasury and recycled according to the Treasury Recycling Rule

### 8a. User-Facing Purchase Flow

The `Buy VPFI` page never asks the user to switch to the canonical `Base` chain. Any cross-chain routing, canonical-chain settlement, or LayerZero OFT activity needed under the hood is abstracted away by the page itself.

Two explicit user steps, in this order:

1. **Buy** — the user, connected to their preferred supported chain (`Base`, `Arbitrum`, `Polygon`, `Optimism`, or `Ethereum mainnet`), pays ETH at the fixed rate directly from the page. Purchased VPFI is delivered to the user's wallet **on that same preferred chain** — never auto-routed into escrow, and never requiring a manual chain switch.
2. **Deposit to escrow** — a separate, explicit user action on the same page moves VPFI from the user's wallet into the user's personal escrow on the same chain. This step is always explicit: the protocol never auto-funds escrow after a buy or a bridge.

Per-wallet cap display:

- when the admin has not yet configured a per-wallet cap on-chain, the `Buy VPFI` page MUST display the Phase 1 recommendation (`30,000 VPFI`) as the effective per-chain cap — `Uncapped` is not a valid user-facing state
- the displayed "your remaining allowance" always equals `effectiveCap - soldToWallet`, where `effectiveCap` falls back to `30,000 VPFI` when `perWalletCap == 0` on-chain
- this allowance is chain-local: buying up to the cap on one chain does not by itself consume the user's allowance on another chain unless admin later introduces an explicit cross-chain cap model
- likewise, VPFI deposited into escrow on a given chain counts toward lender / borrower fee-discount tiers only for loans initiated on that same chain

VPFI held in escrow simultaneously satisfies the §3 staking model and the fee-discount tier table in `docs/BorrowerVPFIDiscountMechanism.md` on that same chain — a single deposit serves both purposes locally, but does not qualify loans initiated on other chains.

---

## 9. Treasury Recycling Rule

All VPFI received as fees is recycled as follows, and ETH received from the fixed-rate purchase program is routed into Treasury under the same treasury-management policy:

- **`38%` → Buy ETH**
- **`38%` → Buy wBTC**
- **`24%` → Held as VPFI**

If the insurance / bug bounty pool exceeds `2%` of total supply, any surplus VPFI is also recycled using the same `38 / 38 / 24` split.

---

## 10. Multi-Chain Deployment Strategy

Standard:

- `LayerZero OFT V2`

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

1. deploy `VPFIToken.sol` as the canonical OFT deployment on `Base`
2. if an initial supply tranche is used for treasury- or allocation-managed distribution, mint it to the secure multi-sig plus timelock-controlled treasury setup; the fixed-rate purchase program itself must not rely on a pre-minted sale reserve
3. deploy connected peer contracts on the additional supported chains
4. wire LayerZero peer configuration so omnichain transfers preserve one global supply model
5. keep token symbol and metadata consistent as `VPFI` on every supported chain

Architecture clarification:

- only `VPFI` is cross-chain through `LayerZero OFT V2`
- the Vaipakam lending / borrowing / rental core protocol remains single-chain per deployment
- in Phase 1, the core protocol should be deployed as separate Diamond instances on `Base`, `Polygon`, `Arbitrum`, `Optimism`, and `Ethereum mainnet`
- loans, offers, collateral, repayment, claims, liquidation, preclose, refinance, and keeper actions must stay local to the deployment chain of that specific protocol instance

Canonical-address rule:

- the Base deployment is the documented source of truth
- canonical addresses must be published in `docs/` and surfaced on the public dashboard / transparency UI

---

## 11. Distribution and Claiming Mechanics

Phase note:

- reward claiming and emission-driven distribution are `Phase 1` scope
- Phase 1 includes token deployment, minting, discounts, fixed-rate access, and escrow-based staking

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
- minted totals
- discount eligibility state where applicable

These values should be exposed through public view functions on the treasury / tokenomics side, likely through `TreasuryFacet`, a lightweight `VPFITokenFacet`, and the token contract itself.

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

Testing requirements:

- extend the existing scenario tests
- extend invariant coverage
- include supply-cap enforcement tests
- include cross-chain / OFT configuration tests where practical
- include reward-accounting and vesting tests
- include buyback-routing tests

Frontend integration requirements:

- Phase 1 frontend requirements should focus on token-address transparency, supply visibility, mint/cap visibility where exposed, and clear separation between the cross-chain VPFI token and the single-chain core protocol
- `Dashboard`, `ClaimCenter`, staking views, and reward hooks may gain broader VPFI utility surfaces in `Phase 1`
- `Dashboard` should specifically surface the shared fee-discount consent control for escrowed VPFI usage

---

## 13. Notes on Phase Separation

- this document defines `Phase 1` token deployment, fee utility, fixed-rate acquisition, escrow-based staking, and transparency tooling
- broader governance activation remains `Phase 2`
- it does not retroactively change the already-specified Phase 1 loan lifecycle, collateral rules, liquidation rules, escrow model, or oracle model unless an approved implementation note says otherwise
- any future fee-discount integration must be applied carefully so it adjusts treasury-fee outcomes without breaking the core Phase 1 accounting invariants
