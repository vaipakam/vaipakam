# Vaipakam VPFI Tokenomics & Multi-Chain Deployment – Technical Specification

## 1. Token Overview

- **Token Name:** Vaipakam DeFi Token
- **Symbol:** `VPFI`
- **Total Supply Cap:** `230,000,000` VPFI
- **Initial Mint:** `23,000,000` VPFI
- **Initial Mint Location:** minted on canonical `Base` deployment at launch
- **Primary Purpose:** protocol and governance token for Vaipakam

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
- omnichain token standard: `LayerZero OFT V2`
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
- the Dashboard may summarize interaction pending + lifetime claimed alongside staking rewards, but Claim Center remains the canonical interaction-reward claim surface

---

### 4a. Cross-Chain Reward Accounting

Phase note:

- this subsection is `Pahse 1` scope, deployed alongside the rest of §4

Problem:

- the reward formula's denominator `totalDailyInterestNumeraire` is **protocol-wide**, not per-chain
- because the Vaipakam core protocol is deployed as **independent Diamond instances** on `Base`, `Ethereum`, `Polygon`, `Arbitrum`, and `Optimism` (see §7), each chain only sees its own local interest flow
- computing rewards against a local-only denominator would give a lender on a quiet chain an outsized share and dilute a lender on a busy chain — this breaks the "one protocol, one reward curve" property that justifies the 30% allocation

Topology:

- `Base` is the **canonical reward chain** — consistent with the VPFI OFT canonical rule and the §7 canonical-address rule
- every non-canonical Diamond (mirror chains) acts as a **reporter**: at day-close it publishes its daily interest total to `Base` over LayerZero
- `Base` acts as the **aggregator**: it accumulates chain totals into `dailyGlobalInterestNumeraire` and then **broadcasts that single number back** to every mirror
- `claimInteractionRewards()` runs **locally on each chain** using the mirror's own user-level interest data and the broadcast global denominator — users never have to leave their lending chain to claim once the relevant loan has closed

Day-close emission contract (mirror → Base):

- trigger: the first interaction on day `D+1 UTC` (lazy rollover) or a permissionless poke function `closeDay(D)` if no traffic rolls the day naturally
- payload:
  - `dayId` (uint64, UTC day number)
  - `chainInterestNumeraire18` (uint256, 1e18-scaled, sum of `lenderInterestEarned + borrowerInterestPaid` on that chain for day `D`, quoted in the active numeraire)
- transport: LayerZero `OApp.send(...)` from the mirror Diamond to the `Base` Diamond, peered via `setPeer`
- each `(dayId, sourceEid)` pair must be idempotent on the `Base` side — duplicate messages for the same day are rejected

Finalization on Base:

- storage key: `dailyChainInterest[dayId][sourceEid] -> uint256`
- finalization rule: `dailyGlobalInterestNumeraire[dayId]` is finalized once all expected mirror eids have reported for `dayId`, OR after a **4-hour grace window** past `dayId + 1` UTC, whichever comes first
- any late-arriving report is recorded for audit but does **not** retroactively change a finalized global — this preserves claim determinism
- finalization event: `DailyGlobalInterestFinalized(dayId, dailyGlobalInterestNumeraire, participatingEids)`

Broadcast back to mirrors (Base → mirror):

- once finalized, `Base` sends the finalized `dailyGlobalInterestNumeraire[dayId]` to every mirror via `OApp.send(...)`
- mirrors store it as `knownGlobalInterest[dayId]` — this is the denominator used by their local `claimInteractionRewards()` once the relevant loan-close gate is satisfied
- a claim for `dayId` reverts locally if `knownGlobalInterest[dayId] == 0` (not yet broadcast)

lzRead alternative (pull model):

- instead of a push-broadcast, `Base` can issue an `lzRead` query to each mirror at day-close to pull `chainInterestNumeraire18` directly — a single quorum read returns all chain totals in one message
- once `lzRead` is GA on all Phase 1 chains, this replaces the mirror-side push path with a single aggregator-driven pull
- the mirror-side broadcast of `dailyGlobalInterestNumeraire` still happens either way — `lzRead` only covers the inbound leg

Reward pool funding on mirrors:

- the interaction-reward VPFI pool (`69,000,000` cap) is held on `Base` (canonical mint chain)
- per-day per-chain VPFI payout budget = `(dailyChainInterest[D][eid] / dailyGlobalInterestNumeraire[D]) × dailyPool[D]`
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

- `RewardReporterFacet` (on every mirror): `closeDay(dayId)`, `_sendChainInterest(...)` (private OApp send), view `getLocalChainInterestNumeraire18(dayId)`
- `RewardAggregatorFacet` (on Base only): `lzReceive` handler for inbound mirror reports, `finalizeDay(dayId)` (permissionless once the grace window elapses), view `getKnownGlobalInterestNumeraire18(dayId)`
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

- discount tiers are derived from the user's escrowed VPFI balance on the relevant lending chain, with both lender and borrower discount value measured through the time-weighted rules below once Phase 5 is active
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

Borrower rules (Phase 5 and later):

- the borrower-side discount applies to the `Loan Initiation Fee`
- the borrower VPFI path applies only when the lending asset is liquid under the active-chain `RiskFacet` / `OracleFacet` checks; illiquid assets use the normal lending-asset `0.1%` `Loan Initiation Fee` with no VPFI discount path
- the borrower must have the shared platform-level fee-discount consent enabled; no separate offer-level or loan-level VPFI consent is required once that setting is active
- when consent is active and sufficient VPFI is available, the system deducts the FULL (non-discounted) `Loan Initiation Fee` equivalent in VPFI from the borrower's escrow at loan acceptance; this VPFI is held in protocol custody (the Diamond) for the life of the loan rather than flowing immediately to Treasury
- when the VPFI path succeeds, `100%` of the requested lending asset is delivered to the borrower because the initiation fee has been satisfied entirely from escrowed VPFI
- the borrower-side discount is TIME-WEIGHTED across the loan's lifetime, mirroring the lender-side model: each loan snapshots the borrower's discount-accrual state at acceptance, and on proper settlement the protocol computes the loan-specific average discount from the delta between the settlement-moment accumulator and the opening snapshot, divided by the actual elapsed loan duration
- on proper close (normal repay, borrower preclose, refinance), the Diamond splits the held VPFI into a borrower rebate (held × time-weighted-avg-discount-bps / 10000) and a treasury share (the remainder); the rebate becomes claimable on the borrower's position NFT and is paid out atomically with the normal borrower claim; the treasury share is accrued to Treasury at settlement
- on default or HF-based liquidation, the entire held VPFI is forfeited to Treasury with no rebate
- on refinance, the OLD loan's borrower rebate is credited at settlement (the borrower earned that window fairly); the NEW loan gets a fresh opening snapshot and tracks a new independent window
- pre-upgrade loans that predate Phase 5 carry zero-valued custody and no opening snapshot, so they silently settle with no rebate — they never paid VPFI up front

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

Borrower initiation-fee discount mechanics (Phase 5):

- the borrower pays the FULL Loan Initiation Fee up front in VPFI when the VPFI-fee path is selected; the Diamond holds that VPFI in custody for the life of the loan
- the borrower-side discount is time-weighted across the loan window; there is no more point-in-time discount at acceptance
- the stamped tier between balance-changing events pins the discount-accrual rate for the next elapsed-time bucket, identical to the lender-side mechanic; a borrower cannot capture a full higher-tier rebate by depositing VPFI only shortly before settlement
- on proper settlement the held VPFI is split into rebate (to the borrower NFT holder via ClaimFacet) and treasury share; on default / HF liquidation the full held VPFI flushes to Treasury and no rebate is credited
- governance changes to borrower discount thresholds or percentages apply prospectively only; periods already accrued under the previously stamped tier remain locked at those older values, mirroring the lender-side governance semantics

---

### 6b. Borrower Loan-Initiation Fee VPFI Path

Objective:

- borrowers can acquire VPFI through the fixed-rate purchase flow, explicitly deposit it into their personal escrow on the lending chain, and use that escrowed VPFI to satisfy the full `0.1%` `Loan Initiation Fee` up front
- the borrower then earns the documented discount as a time-weighted VPFI rebate only if the loan closes properly
- this removes the old point-in-time gaming vector where a borrower could briefly top up VPFI only at acceptance time to capture a full discount

Eligibility and fallback:

- the lending asset must be liquid on the active lending chain according to the existing `RiskFacet` / `OracleFacet` path
- the borrower must have enabled the shared platform-level VPFI fee-discount consent
- the borrower's escrow on that same lending chain must contain enough VPFI to cover the full, non-discounted `0.1%` `Loan Initiation Fee` equivalent
- escrow-held VPFI is a special non-collateral asset: it does not count toward collateral value, Health Factor, liquidation value, or LTV support
- escrow-held VPFI continues to count as staked under the unified escrow-staking model while also serving as the fee-utility balance for borrower discounts
- if the asset is illiquid, the borrower has insufficient VPFI, or consent is disabled, the system falls back to the normal lending-asset fee path: the borrower pays `0.1%` in the loan asset and receives the net amount after that treasury deduction

Acceptance-time flow:

1. the borrower creates or accepts a loan offer
2. the protocol checks active-chain liquidity through the existing risk / oracle logic
3. the protocol verifies the platform-level VPFI-discount consent flag
4. the protocol snapshots the borrower's discount-accrual state for that loan
5. for a liquid lending asset, the protocol converts the loan amount into ETH equivalent using the Chainlink-led active-chain pricing path
6. the protocol calculates the full `0.1%` `Loan Initiation Fee`
7. the protocol converts that full ETH-equivalent fee into exact VPFI required at the fixed rate `1 VPFI = 0.001 ETH`
8. if escrow balance is sufficient, the protocol deducts that VPFI from borrower escrow into Diamond custody and sends `100%` of the requested lending asset to the borrower

Settlement:

- on normal repayment, borrower preclose, or refinance, the protocol computes the borrower's time-weighted average discount across the actual loan window
- borrower rebate formula: `rebate = heldVPFI * timeWeightedAverageDiscountBps / 10000`
- the borrower rebate is claimable by the borrower-side Vaipakam NFT holder and is paid with the ordinary borrower claim
- the unrewarded remainder of the held VPFI becomes Treasury's share
- on default or HF-based liquidation, the borrower rebate is `0` and all VPFI held for that loan is forfeited to Treasury

Storage requirements:

- store or derive borrower discount tiers from escrowed VPFI balance on the relevant lending chain
- for each loan that uses the VPFI LIF path, store the full VPFI amount held in protocol custody, the borrower's opening discount-accrual snapshot, and any rebate claimable after proper settlement
- track borrower LIF custody and rebate state by loan ID
- keep all storage additions append-only in the existing Diamond storage libraries

Events:

- emit when the VPFI LIF path is selected and the full up-front VPFI amount is custody-held, including loan ID, borrower, lending asset, and VPFI amount
- emit when a borrower VPFI rebate is credited
- emit when borrower-held VPFI for a loan is forfeited to Treasury on default or HF-based liquidation

Integration surface:

- reuse the existing `EscrowFactory`, loan lifecycle facets, `VPFITokenFacet`, `TreasuryFacet`, shared settlement libraries, and Chainlink-led oracle path wherever possible
- extend escrow handling so VPFI can be deducted for fee utility without being treated as collateral
- Treasury must be able to receive and record VPFI fee flows for later recycling under §9
- keep all existing Phase 1 lending, escrow, treasury, oracle, risk, and loan-funding semantics unchanged except for the explicit fee-source and VPFI-custody behavior described in this borrower LIF path

---

## 7. Staking Rewards

Phase note:

- this section is `Phase 1` scope

Pool size:

- `24%` of total supply
- `55,200,000` VPFI

Design rules:

- staking is unified with escrow: any VPFI held in a user escrow on a lending chain is considered staked
- staking is open to any VPFI holder; the user does not need an existing loan, offer, or borrower position to participate
- the first VPFI deposit may create the user's escrow automatically, then treat the deposited balance as staked immediately
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
- per-wallet cap: configurable by admin, applied per origin-chain LayerZero endpoint ID rather than as one cross-chain wallet cap
- initial recommendation: `30,000 VPFI` per wallet per chain — this is the live per-chain user limit surfaced on `/app/buy-vpfi` until admin explicitly reconfigures it
- ETH received from the fixed-rate purchase program is sent to Treasury and recycled according to the Treasury Recycling Rule
- when the purchase flow routes through the Base canonical receiver, VPFI must be minted or released only after the Base receiver has actually received ETH; quoted, requested, or expected ETH amounts must never be enough to mint VPFI by themselves
- the VPFI amount delivered to the buyer must be based on the ETH amount actually received by the Base receiver

### 8a. User-Facing Purchase Flow

The public `/buy-vpfi` route is a no-wallet marketing / education surface. The wallet-bearing `Buy VPFI` controls live inside the connected app at `/app/buy-vpfi`. The app page never asks the user to switch manually to the canonical `Base` chain. Any cross-chain routing, canonical-chain settlement, or LayerZero OFT activity needed under the hood is abstracted away by the page itself.

Two explicit user steps, in this order:

1. **Buy** — the user, connected to their preferred supported chain (`Base`, `Arbitrum`, `Polygon`, `Optimism`, or `Ethereum mainnet`), pays ETH at the fixed rate directly from the page. Purchased VPFI is delivered to the user's wallet **on that same preferred chain** — never auto-routed into escrow, and never requiring a manual chain switch. If the flow settles on the canonical Base receiver, receipt of ETH on Base is the mint/release trigger.
2. **Deposit / Stake to escrow** — a separate, explicit user action on the same app page moves VPFI from the user's wallet into the user's personal escrow on the same chain. This step is always explicit: the protocol never auto-funds escrow after a buy or a bridge. Once deposited, the balance immediately counts as staked for the `5% APR` model and toward local discount tiers. Where supported, this deposit may use Uniswap Permit2 at `0x000000000022D473030F116dDEE9F6B43aC78BA3` so the user signs one EIP-712 authorization and executes the escrow deposit in a single transaction; the classic approve-plus-deposit path remains the fallback.

Per-wallet cap display:

- when the admin has not yet configured a per-wallet cap on-chain, `/app/buy-vpfi` MUST display the Phase 1 recommendation (`30,000 VPFI`) as the effective per-chain cap — `Uncapped` is not a valid user-facing state
- the displayed "your remaining allowance" always equals `effectiveCap - soldToWallet`, where `effectiveCap` falls back to `30,000 VPFI` when `perWalletCap == 0` on-chain
- this allowance is keyed by `(buyer, originEid)`, where `originEid` is the LayerZero endpoint ID of the chain where the buy originated; buying up to the cap on one origin chain does not by itself consume the user's allowance on another chain unless admin later introduces an explicit cross-chain cap model
- likewise, VPFI deposited into escrow on a given chain counts toward lender / borrower fee-discount tiers only for loans initiated on that same chain

VPFI held in escrow simultaneously satisfies the staking model and the fee-discount tier table in §6 on that same chain — a single deposit serves both purposes locally, but does not qualify loans initiated on other chains.

The app purchase page should expose `Buy`, `Stake`, and `Unstake` entry points as route anchors. `Stake` is a user-facing name for the wallet-to-escrow deposit step; `Unstake` is the escrow-to-wallet withdrawal path on the same chain. The public marketing route may link into those anchors, but should not itself mount wallet controls.

The `Deposit / Stake` step should carry the single canonical user-facing open-staking message: staking is open to everyone, no existing loan is required, escrow-held VPFI earns the staking APR while it remains deposited, and the user's escrow can be created automatically on first deposit. Duplicated page-level staking prose should be avoided so this card remains the source of truth.

Payment-token mode requirements:

- the cross-chain VPFI buy adapter owns the payment-token choice; users submit an amount but must not be able to choose an arbitrary ERC-20 at call time
- native-gas mode (`paymentToken == address(0)`) is valid only on chains whose native gas token is ETH-equivalent for the fixed-rate quote model, such as Ethereum, Base, Arbitrum, Optimism, Polygon zkEVM, and their public testnets
- chains whose native gas token is not ETH-equivalent, including BNB Chain and Polygon PoS mainnet, must use WETH-pull mode with that chain's canonical bridged WETH9 token
- adapter initialization and payment-token rotation must reject EOAs, non-ERC-20 contracts, and ERC-20s whose `decimals()` value is not `18`, so an operator cannot accidentally configure USDC or another wrong-decimal token as the ETH-equivalent payment asset
- deployment scripts should pre-flight strict-WETH chains and refuse native-gas mode there, while logging payment-token metadata for operator confirmation against the published canonical WETH address
- the frontend should display the actual buy asset for the active chain and adapter mode rather than hardcoding `ETH`; native-gas chains should show the chain's native gas asset, while WETH-pull chains should show the configured bridged WETH token and provide a verification link to the relevant market-data page
- in WETH-pull mode, approval and balance checks should target the configured ERC-20 payment token; LayerZero execution fees remain paid in the chain's native gas token and should be labelled with that native symbol
- buy-adapter deployments should encode a default LayerZero Type-3 buy-options payload so `quoteBuy` works immediately after deploy without requiring a separate post-deploy `setBuyOptions` transaction first; the default LzReceive gas budget should be conservative and chain-tunable, with a companion script able to update live adapters using the same `OptionsBuilder` recipe

Cross-chain buy settlement hardening:

- the canonical receiver must not OFT-send fixed-rate buy VPFI directly to the buyer wallet on the source chain; it should target the source-chain buy adapter through LayerZero OFT compose
- the compose payload must include the buy request id, and the source-chain adapter must release VPFI only when `pendingBuys[requestId]` exists and names the buyer recorded by the source-chain `buy()` call
- forged or replayed compose arrivals must not pay an arbitrary wallet; unmatched or already-settled request ids should be recorded as stuck VPFI and recoverable only by owner / governance to a configured recipient
- the compose handler must authenticate both the LayerZero endpoint caller and the configured local VPFI mirror source; deployments must configure receiver `buyAdapterByEid` plus source-adapter `vpfiToken` and `vpfiMirror`
- a separate `BUY_SUCCESS` reply path should not be required for successful buys; the OFT compose arrival is the success signal and should release source-chain escrowed payment to treasury where applicable
- operator-configured OFT send options for the back leg must include gas for both LzReceive minting and LzCompose adapter execution; deploy-time defaults should exist, and a post-deploy script should allow controlled gas-budget adjustment

Permit2 requirements for VPFI utility flows:

- Permit2 support is an optional convenience path for VPFI deposits and other eligible ERC-20 actions; it must not remove or weaken the classic ERC-20 allowance flow.
- Permit signatures should use 30-minute expiries, high-entropy nonces, and exact asset / amount / spender scope.
- The Diamond should validate the target VPFI asset and deposit amount before pulling through Permit2.
- Token-level allowances remain under the user's control; Permit2 should live beside the legacy path rather than becoming a silent global approval replacement.

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

LayerZero hardening requirements:

- each reward OApp packet type must validate the exact expected encoded payload size before decoding; for the current report / broadcast tuple this is `128` bytes
- malformed, undersized, or oversized reward packets must revert with a typed payload-size error carrying the observed and expected sizes
- fixed-rate buy reconciliation should be monitored off-chain: canonical-chain processed buy events should be cross-checked against source-chain `BuyRequested` events by request id, buyer, and amount
- the buy-reconciliation watchdog should run from the operations Worker, read canonical-chain processed-buy events, resolve the originating LayerZero endpoint id to that source chain's RPC and adapter address, and verify that a matching source-chain `BuyRequested` event exists with the same request id, buyer, and amount
- the buy-reconciliation watchdog should expose an on-chain kill switch for planned ceremonies; auto-pausing on mismatch is an operations decision for a later phase, not a Phase 1 requirement
- watchdog coverage requires operator-provided source-chain RPC secrets for every configured buy lane. Missing RPC secrets should cause that lane to be skipped with an operator-visible log rather than causing the entire watchdog pass to fail.
- off-chain monitoring should watch DVN-set drift for each configured `(chain, OApp, peer eid, send / receive)` pair
- off-chain monitoring should check OFT supply invariants by comparing Base canonical-adapter locked VPFI against the sum of mirror-chain `totalSupply()` values
- off-chain monitoring should alert on oversized single-transaction VPFI flows above an operator-configured threshold
- the LayerZero ops watcher should remain internal / private and separate from the public HF watcher / keeper reference implementation

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
- lifetime claimed totals derived from reward-claim events
- per-user interaction reward entries and contributing-loan state
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
- protect all new VPFI purchase, escrow deposit, fee deduction, rebate settlement, and treasury-receipt functions with the project-standard reentrancy guard and global pausable mechanism unless the function is a pure/view helper
- every public or external function added for VPFI purchase, escrow deposit, fee deduction, rebate settlement, or treasury receipt must have NatSpec that describes the fee source, custody behavior, and settlement outcome

Storage and event requirements:

- track total VPFI sold through the fixed-rate program, the global sale cap, and the per-wallet cap in append-only Diamond storage
- track per-chain wallet sale usage so the Phase 1 `30,000 VPFI` recommendation is enforced and displayed as a chain-local allowance
- track VPFI held for borrower LIF custody, claimable borrower rebates, and forfeited treasury shares by loan ID
- emit VPFI purchase events with buyer, VPFI amount, ETH amount, and origin chain context where applicable
- emit escrow-deposit, LIF-custody, rebate-credit, rebate-forfeit, and treasury-receipt events in the relevant facets

Testing requirements:

- extend the existing scenario tests
- extend invariant coverage
- include supply-cap enforcement tests
- include receipt-based mint/release tests for the fixed-rate purchase path, including successful receipt, failed receipt, and partial receipt cases
- include cross-chain / OFT configuration tests where practical
- include reward-accounting and vesting tests
- include buyback-routing tests
- include preferred-chain fixed-rate purchase tests where purchased VPFI is delivered to the user's wallet on that same chain
- include explicit wallet-to-escrow deposit tests for both Permit2 and classic approve-plus-deposit paths
- include liquid-asset borrower LIF VPFI tests across every discount tier
- include time-weighted borrower rebate tests for long-hold, partial-hold, last-minute top-up, unstake-down, and governance-tier-change cases
- include illiquid-asset fallback tests where the borrower pays the normal lending-asset LIF
- include default and HF-liquidation tests proving held VPFI is forfeited to Treasury with no rebate
- include normal repayment, borrower preclose, and refinance tests proving proper rebate crediting
- include tests that escrow-held VPFI updates staking rewards and fee-discount accrual without being counted as collateral
- include admin pause / disable tests for fixed-rate buying after cap exhaustion or sale shutdown

Frontend integration requirements:

- Phase 1 frontend requirements should focus on token-address transparency, supply visibility, mint/cap visibility where exposed, and clear separation between the cross-chain VPFI token and the single-chain core protocol
- `Dashboard`, `ClaimCenter`, staking views, and reward hooks may gain broader VPFI utility surfaces in `Phase 1`
- `Dashboard` should specifically surface the shared fee-discount consent control for escrowed VPFI usage
- the VPFI tier / discount-status table should live near the connected-app `Buy VPFI` purchase / deposit decision, while Dashboard remains the home for the fee-discount consent toggle and combined rewards summary
- protocol-config-dependent UI copy should read live values from the Diamond wherever possible, including mutable config from `getProtocolConfigBundle()` and compile-time constants exposed through `getProtocolConstants()`
- tier tables, staking APR labels, pool-cap labels, rental buffer displays, max slippage, treasury fee, LIF, and minimum Health Factor copy should use live config placeholders instead of hardcoded locale text
- VPFI tier thresholds returned in base units should be converted through shared token-display helpers before they appear in tier tables, consent copy, or tooltip placeholders
- `/app/buy-vpfi` should let users buy from their preferred supported chain without manually switching to canonical `Base`
- `/app/buy-vpfi` is the single user-facing purchase / stake / unstake flow; public `/buy-vpfi` is the education surface. Any bridge, canonical-chain settlement, OFT routing, or Base-receiver complexity must be abstracted behind the app flow.
- the purchase page must show the exact ETH required, resulting VPFI amount, fixed rate, remaining global supply, and chain-local wallet allowance
- after purchase, the page should guide a separate explicit wallet-to-escrow deposit action on the same chain; it must not auto-deposit purchased VPFI into escrow
- the deposit step should prefer Permit2 where supported, fall back cleanly to classic approval, and explain that Permit2 is optional convenience rather than a replacement for token-level allowance control
- transaction review for buying VPFI, depositing VPFI to escrow, and accepting a loan through the VPFI path should include the standard transaction-preview surface where available and fail soft if preview is unavailable
- borrower-facing pages should show current escrowed VPFI balance, current tier, discount eligibility for liquid assets, and the fact that escrow-held VPFI also counts as staked
- `Create Offer` and `Loan Details` should provide clear entry points into `/app/buy-vpfi`
- `Offer Book` accept-review copy should explain that the borrower pays the full `0.1%` LIF up front in VPFI and earns any discount over the loan lifetime as a rebate
- `Create Offer` borrower-tip copy should frame the benefit as earning up to a `24%` VPFI rebate, not as paying a reduced up-front fee
- `Claim Center` should show a VPFI rebate line whenever a borrower claim includes a pending LIF rebate
- `Claim Center` should also host platform-interaction reward claims, including lifetime claimed and contributing-loan context
- `/app/buy-vpfi` Step 2 should host staking reward claims, including pending and lifetime claimed values

Acceptance criteria:

- borrowers can purchase VPFI with ETH from the dedicated preferred-chain app page and receive VPFI in their wallet on that same chain
- borrowers can explicitly move that VPFI from wallet to personal escrow on that same chain
- eligible liquid-asset loan acceptance checks liquidity, fee-discount consent, borrower escrow balance, discount snapshot, Chainlink-led ETH conversion, full `0.1%` LIF computation, and exact VPFI deduction before sending `100%` of requested lending asset to the borrower
- properly closed loans credit a time-weighted VPFI rebate; defaulted or HF-liquidated loans forfeit the held VPFI to Treasury
- global caps, per-chain wallet caps, pausing, event transparency, NatSpec coverage, and Diamond storage compatibility are satisfied

---

## 13. Notes on Phase Separation

- this document defines `Phase 1` token deployment, fee utility, fixed-rate acquisition, escrow-based staking, and transparency tooling
- broader governance activation remains `Phase 2`
- it does not retroactively change the already-specified Phase 1 loan lifecycle, collateral rules, liquidation rules, escrow model, or oracle model unless an approved implementation note says otherwise
- any future fee-discount integration must be applied carefully so it adjusts treasury-fee outcomes without breaking the core Phase 1 accounting invariants
