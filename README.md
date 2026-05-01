# Vaipakam: Technical Whitepaper

**Version:** `3.0`
**Date:** April 2026
**Status:** Production protocol

---

## Abstract

Vaipakam is a non-custodial peer-to-peer credit protocol for over-collateralized
ERC-20 lending and escrow-mediated ERC-721 / ERC-1155 rentals across
Ethereum-compatible networks. Each supported network — `Ethereum mainnet`,
`Base`, `Polygon zkEVM`, `Arbitrum`, `Optimism`, and `BNB Chain` — runs an
independent Diamond (`EIP-2535`) deployment, with all loan, offer, collateral,
repayment, claim, refinance, and liquidation state remaining local to a single
chain. The protocol couples bilateral offer negotiation with per-user isolated
escrows, tokenized lender / borrower position rights, an oracle stack hardened
by a Soft 2-of-N secondary quorum, a four-DEX swap-failover liquidation
pipeline, and a `LayerZero OFT V2` protocol token (`VPFI`) wired for fee
discounts, escrow-based staking, and locally-claimable interaction rewards
that share a protocol-wide daily denominator.

This document specifies the architecture, the loan and rental lifecycle,
the risk and liquidation engine, the oracle and liquidity-classification
model, the VPFI tokenomics, the cross-chain reward mesh, the security
posture, and the operational and governance topology that together define
the production protocol.

---

## Table of Contents

1. Introduction and Motivation
2. System Model
3. Architecture
4. Asset Classification
5. Offer and Loan Lifecycle
6. Risk Engine
7. Liquidation and Fallback Settlement
8. Oracle Stack
9. NFT Rental Subsystem
10. Strategic Flows: Preclose, Refinance, Lender Early Withdrawal
11. VPFI Token and Tokenomics
12. Reward System
13. Cross-Chain Surface
14. MEV Protection
15. Governance and Operations
16. Frontend as a Safety Layer
17. Verification and Testing
18. References

---

## 1. Introduction and Motivation

Most large DeFi credit systems optimize for pooled liquidity, standardized
assets, and uniform market parameters. That model is efficient for deep,
fungible markets, but it is poorly suited to negotiated bilateral credit,
long-tail collateral, and NFT utility flows. Vaipakam takes a different
path: it keeps lending bilateral, makes economic rights explicit through
position NFTs, treats the frontend as part of the protocol's safety layer
rather than as a thin wrapper over contracts, and refuses to trade on bad
markets even when that means falling back to in-kind collateral settlement.

The protocol's defining commitments are:

- **Bilateral terms.** Lenders and borrowers post their own offers; there
  is no shared interest-rate curve, no global utilization ratio, and no
  imposed risk parameters beyond the safety floor.
- **Per-user escrow isolation.** Every user owns a dedicated `ERC1967` escrow
  proxy. There is no commingled treasury vault.
- **Tokenized rights.** Lender-side and borrower-side position NFTs follow
  ownership; claim authority moves with the NFT, not with the originating
  wallet.
- **Liquidity-aware classification.** An asset is treated as liquid only if
  the **active chain** itself can confirm both a usable Chainlink-led price
  path and sufficient v3-style AMM depth. Ethereum mainnet is never
  consulted as a fallback reference for another chain.
- **Refusal to trade on bad markets.** When liquidation slippage would exceed
  the configured ceiling (default `6%`), the protocol stops trying
  to convert collateral and routes into a documented in-kind fallback path
  rather than dumping into illiquid books.
- **Permissionless safety.** Any address may liquidate when conditions are
  met. Non-liquidation third-party execution is opt-in, role-scoped, and
  whitelisted per user.
- **Chain-local lifecycle, cross-chain protocol token.** Loans, offers,
  collateral, repayment, liquidation, preclose, refinance, and keeper
  actions remain local to the deployment chain. Only `VPFI` (the
  protocol token) and the daily reward denominator cross chains.

Vaipakam is non-custodial. Users negotiate terms directly through on-chain
offers; Vaipakam smart contracts enforce custody, repayment, default,
liquidation, and claim rights.

---

## 2. System Model

### 2.1 Chain Model

Vaipakam core protocol state is deployed as a separate Diamond on each
supported chain. Each Diamond is an independent protocol instance:

- there is no cross-chain loan state machine
- a loan opened on `Base` is settled on `Base`
- per-chain Diamonds are governed by per-chain Safes / timelocks
- only `VPFI` and the daily interaction-reward denominator are cross-chain

Supported chains: `Ethereum mainnet`, `Base` (canonical), `Polygon zkEVM`,
`Arbitrum`, `Optimism`, and `BNB Chain`.

### 2.2 Product Surface

Vaipakam supports:

- ERC-20 lending and borrowing with ERC-20, ERC-721, or ERC-1155 collateral
- ERC-721 and ERC-1155 rentals using ERC-4907-style user-right assignment
- borrower preclose (early repayment in three forms)
- lender early withdrawal (sale-based exits)
- loan refinance (active ERC-20 loans only)
- partial collateral withdrawal when health permits
- additional collateral top-up
- VPFI fixed-rate purchase, escrow deposit, fee discounts
- escrow-based VPFI staking
- daily platform interaction rewards
- public read-only NFT verifier and analytics dashboard

### 2.3 Roles

- **Lender** — supplies the principal, receives principal + interest at
  settlement (or collateral on default).
- **Borrower** — supplies collateral, receives principal at initiation,
  repays + interest by maturity (or loses collateral on default).
- **NFT renter / owner** — analogue of borrower / lender for ERC-4907
  rental flows.
- **Liquidator** — any address. Liquidation is permissionless and timely.
- **Keeper** — opt-in delegated role-manager for non-liquidation flows;
  scoped per role (lender or borrower side) and whitelisted per user.
- **Operator** — the team that runs the canonical frontend, the
  hf-watcher Cloudflare Worker, and the public reference keeper-bot repo.
- **Governance Safe** — long-delay admin authority via 48-hour timelock.
- **Ops Safe (Guardian)** — fast-response pause holder.

---

## 3. Architecture

### 3.1 Diamond Pattern (`EIP-2535`)

`VaipakamDiamond.sol` is the single user-facing entry point on each
chain. It holds no business logic of its own; the constructor registers
`DiamondCutFacet`, and the fallback `delegatecall`s into the facet
resolved by the function selector. Unresolved selectors revert with
`FunctionDoesNotExist()`.

Shared state lives at `keccak256("vaipakam.storage")` (an `ERC-7201`-style
namespaced slot) and is exposed through `LibVaipakam.Storage`. Storage
discipline is **append-only**: existing fields are never reordered or
removed, and new fields land at the end of the struct. There are no
per-facet `__gap` arrays inside the main storage struct; upgrade safety
relies on the append-only invariant.

### 3.2 Facet Layout

Lifecycle facets:

- **OfferFacet** — create / accept / cancel offers (ERC-20 and rental)
- **LoanFacet** — `initiateLoan`, liquidity re-check, HF / LTV gate, NFT mint
- **RepayFacet** — full / partial repayment, late-fee accrual, daily rental deductions
- **ClaimFacet** — claim-based fund release for both sides; routes the borrower VPFI rebate

Risk and oracle:

- **RiskFacet** — LTV / HF computation, HF-triggered liquidation
- **DefaultedFacet** — time-based default after grace expiry
- **OracleFacet** — Chainlink price reads, sequencer uptime, hybrid staleness
- **OracleAdminFacet** — Chainlink registry, secondary oracle config (Tellor / API3 / DIA), per-feed overrides, V3 factory set

Token economics:

- **VPFITokenFacet** — escrow VPFI views and helpers
- **VPFIDiscountFacet** — fixed-rate buy program, time-weighted tier resolution
- **InteractionRewardsFacet** — daily lender / borrower accrual under the 8-band emission schedule
- **StakingRewardsFacet** — `5% APR` reward-per-token accrual on escrow VPFI
- **RewardReporterFacet** — every-chain reporter; sends mirror daily totals to canonical Base
- **RewardAggregatorFacet** — Base-only aggregator; finalizes and broadcasts the daily global denominator

Admin and config:

- **AdminFacet** — treasury address, pause toggles, swap-adapter registry
- **ConfigFacet** — runtime-tunable protocol parameters (fees, LTV, slippage, tier table, APR)
- **AccessControlFacet** — RBAC role plumbing
- **TreasuryFacet** — VPFI mint surface, treasury fee accumulation
- **DiamondCutFacet / DiamondLoupeFacet / OwnershipFacet** — `EIP-2535` plumbing

NFT and escrow:

- **VaipakamNFTFacet** — position NFT mint / update / burn (ERC-721, on-chain metadata)
- **EscrowFactoryFacet** — per-user UUPS escrow proxy deployment, mandatory upgrade gating
- **ProfileFacet** — keeper opt-in surface

Strategic flows:

- **PrecloseFacet** — borrower direct preclose, transfer-via-offer, offset-with-new-offer
- **RefinanceFacet** — atomic settlement after replacement loan exists
- **EarlyWithdrawalFacet** — lender exit (sell-loan, buy-offer, wait-to-maturity)
- **AddCollateralFacet** — borrower collateral top-up
- **PartialWithdrawalFacet** — lender principal reduction with borrower consent

Auxiliary:

- **MetricsFacet** — read-only public analytics surface (TVL, counts, fee totals)

### 3.3 Per-User Escrow

`VaipakamEscrowImplementation.sol` is a UUPS-upgradeable contract.
`EscrowFactoryFacet` deploys one `ERC1967Proxy` per user. Each user's
ERC-20, ERC-721, and ERC-1155 assets are held in their own isolated
escrow — no commingling. Cross-facet calls into escrow use the canonical
`address(this).call(abi.encodeWithSelector(...))` pattern, which routes
through the Diamond fallback.

Mandatory escrow upgrades are not silently mass-pushed. When the protocol
marks an upgrade as mandatory, interactions through outdated escrows are
blocked at the facet boundary, and the frontend prompts the user to
submit their own escrow-upgrade transaction.

### 3.4 Position NFTs

Vaipakam mints `ERC-721` position NFTs at offer creation and again at
loan initiation. Position NFTs are first-class economic objects:

- the lender-side NFT carries lender claim rights
- the borrower-side NFT carries borrower claim rights
- claim authority follows the current `ownerOf`, not the originating wallet
- `tokenURI()` is fully on-chain; off-chain image storage uses IPFS for
  four role-and-status-aware images
- the NFT supports the public NFT Verifier surface, which distinguishes
  valid live NFTs, burned NFTs (warning state with historical context
  where indexed data is available), and never-minted token IDs

`LoanPositionStatus` captures the NFT lifecycle distinct from `LoanStatus`:
`OfferCreated`, `LoanInitiated`, `LoanRepaid`, `LoanDefaulted`,
`LoanLiquidated`, `LoanFallbackPending`, `LoanClosed`.

### 3.5 Storage Constants

Key constants in `LibVaipakam.sol`:

| Constant | Value | Meaning |
|---|---:|---|
| `MIN_HEALTH_FACTOR` | `1.5e18` | HF floor at loan initiation |
| `HF_LIQUIDATION_THRESHOLD` | `1e18` | HF-based liquidation trigger |
| `TREASURY_FEE_BPS` | `100` | `1%` Yield Fee on lender interest |
| `LOAN_INITIATION_FEE_BPS` | `10` | `0.1%` Loan Initiation Fee |
| `MAX_LIQUIDATION_SLIPPAGE_BPS` | `600` | `6%` slippage ceiling |
| `MAX_LIQUIDATOR_INCENTIVE_BPS` | `300` | `3%` cap on liquidator bonus |
| `LIQUIDATION_HANDLING_BPS` | `200` | `2%` treasury surcharge on liquidation |
| `FALLBACK_LENDER_BONUS_BPS` | `300` | `3%` lender share in fallback |
| `FALLBACK_TREASURY_BPS` | `200` | `2%` treasury share in fallback |
| `RENTAL_BUFFER_BPS` | `500` | `5%` NFT rental prepayment buffer |
| `VOLATILITY_LTV_THRESHOLD_BPS` | `11000` | `110%` LTV collapse trigger |
| `VPFI_HARD_CAP` | `230_000_000e18` | Global VPFI supply cap |
| `VPFI_INITIAL_MINT` | `23_000_000e18` | Genesis mint on Base |
| `VPFI_INTERACTION_POOL_CAP` | `69_000_000e18` | Interaction-reward category cap |
| `VPFI_STAKING_POOL_CAP` | `55_200_000e18` | Staking-reward category cap |
| `VPFI_STAKING_APR_BPS` | `500` | `5%` escrow staking APR |
| `INTERACTION_CAP_VPFI_PER_ETH` | `500` | `0.5 VPFI` per `0.001 ETH` of interest |

### 3.6 Rounding Doctrine

Every division in the protocol documents which side it favors. LTV rounds
down (1 BPS under-reported) to favor the borrower. Health Factor rounds
down (slightly under-reported) to favor the protocol — earlier liquidation
is the safety bias. Treasury splits round in favor of the treasury on
liquidation but in favor of the borrower on routine settlement. New
divisions added to the codebase MUST state direction, beneficiary, and
safety rationale; this is enforced by code review, not by lint.

---

## 4. Asset Classification

### 4.1 Liquid vs. Illiquid

Vaipakam classifies an ERC-20 as **liquid on the active chain** if and
only if both of the following hold on that chain:

1. **Priceable.** A usable Chainlink path: preferred direct `asset/USD`,
   else `asset/ETH × ETH/USD`. WETH itself is priced from `ETH/USD`.
2. **Tradeable.** At least one configured v3-style concentrated-liquidity
   AMM `asset/WETH` pool meets the configured minimum-depth threshold
   when converted to USD via the active chain's Chainlink `ETH/USD`.

Multiple V3-clone factories are checked with **OR** logic: Uniswap V3,
PancakeSwap V3, and SushiSwap V3. One sufficiently deep
venue is enough.

**Bright-line rule:** Ethereum mainnet must not be consulted as a
fallback when classifying liquidity for any other chain. If the active
chain's check fails, the asset is illiquid on that chain.

### 4.2 Illiquid Treatment

The following are illiquid for protocol valuation and liquidation:

- all ERC-721 and ERC-1155 assets (platform-assessed value `$0`)
- ERC-20s that fail either the priceability or tradeability check on the
  active chain
- any asset where oracle data is missing, stale, or revert-failed

Loans involving illiquid assets default to **full-collateral-in-kind**
settlement on default. Both parties must explicitly consent via the
combined risk acknowledgement.

### 4.3 Same-Asset Guard

At offer creation, the lending asset and the collateral asset must not
be the same asset. This invariant is enforced directly rather than
through reference-asset hacks.

### 4.4 Fail-Closed Behavior

If oracle reads or pool lookups face transient issues (Chainlink stale
beyond the configured budget, Tellor / API3 / DIA all unreachable, V3
factory revert), the protocol treats the asset as illiquid for that
operation. There is **no manual override** path to mark an asset liquid
when checks fail.

---

## 5. Offer and Loan Lifecycle

### 5.1 Offer Creation

Either side may create an offer:

- **Lender offer** — specifies lending asset, principal, APR, required
  collateral type and (amount or maximum LTV / minimum HF), duration. The
  lender's principal is locked into escrow at creation.
- **Borrower offer** — specifies desired asset and amount, maximum
  acceptable APR, offered collateral, duration. The borrower's collateral
  is locked at creation.
- **NFT rental offer** — analogous, with daily rental fee, duration, and
  the ERC-20 used for prepayment. The NFT is escrowed at creation.

Loan durations: configurable from 1 day to 365 days. Grace periods auto-
assigned by tier:

| Duration | Grace |
|---|---|
| `< 1 week` | 1 hour |
| `< 1 month` | 1 day |
| `< 3 months` | 3 days |
| `< 6 months` | 1 week |
| `≤ 1 year` | 2 weeks |

A position NFT is minted to the creator at creation with status
`OfferCreated`.

### 5.2 Combined Mandatory Risk Consent

Before either party submits a create- or accept-offer transaction, the
frontend requires **one** combined warning-and-consent acknowledgement
covering both:

- the abnormal-market fallback path for liquid collateral
- the full-collateral-in-kind default path for illiquid assets

The consent is mandatory and is captured for the offer and stored on the
resulting loan. The protocol stores a single combined-accepted-by-both-
parties flag rather than two separate per-party bits.

### 5.3 Offer Acceptance and Loan Initiation

When the counterparty accepts, control flows through `OfferFacet.acceptOffer`
into a cross-facet call to `LoanFacet.initiateLoan`. The latter is guarded
by `msg.sender == address(this)` so it can only be reached through the
Diamond fallback.

`initiateLoan` performs:

1. On-chain liquidity re-verification — both legs are re-checked at
   acceptance time (frontend assessments don't bind the contract)
2. Combined fallback consent enforcement
3. For fully-liquid loans: enforce `LTV ≤ maxLtvBps` and `HF ≥ 1.5e18`
4. Snapshot of all economic terms (principal, collateral, APR, duration,
   fallback splits, fee BPS, VPFI discount accrual state)
5. Position NFT mint to the lender and borrower
6. Status transition: offer → `Accepted`, loan → `Active`

The `Loan` struct snapshots the protocol-config BPS values at initiation
so subsequent governance changes never retroactively alter dual-consent
positions.

### 5.4 Loan Initiation Fee

For ERC-20 loans, a `0.1%` Loan Initiation Fee is charged on the lending-
asset amount **before** net proceeds reach the borrower. On a 1,000 USDC
match, the borrower receives 999 USDC and 1 USDC routes to treasury.

The borrower VPFI path inverts the fee source: when consent is
active, the lending asset is liquid, and sufficient VPFI is in escrow,
the borrower receives `100%` of the requested principal and pays the
**full** non-discounted `0.1%` LIF equivalent in VPFI up front. That VPFI
is held in Diamond custody (not Treasury) for the life of the loan.

### 5.5 Repayment

Repayment may be initiated by the borrower or any third party. ERC-20
repayment amount is `Principal + Interest`, where:

```
Interest = (Principal × AnnualRateBps × LoanDurationDays)
         / (BPS × DAYS_PER_YEAR)
```

A third-party repayer is treated only as the payment sender. They do
**not** gain collateral rights; collateral remains claimable only by
the holder of the borrower-side position NFT. The repayment confirmation
flow surfaces a prominent warning stating this when the connected wallet
is not the borrower NFT owner.

Late fees apply post-due-date but within grace:

- `1%` of outstanding principal on day 1 past due
- `+0.5%` per additional day
- capped at `5%` total
- collected with repayment, subject to treasury fee on the late-fee portion

NFT rental repayment auto-deducts daily rental fees from the prepaid
buffer. The `5%` prepayment buffer returns to the borrower on timely
return; on default the buffer escalates to treasury.

### 5.6 Settlement and Claims

After repayment, the loan transitions to `Repaid`. Lender becomes
entitled to `Principal + Interest − YieldFee`; borrower becomes entitled
to full collateral return. Both sides claim independently against their
position NFTs:

- `ClaimFacet.claimAsLender(loanId)` — pays principal + interest from
  escrow; routes the borrower VPFI rebate share if applicable
- `ClaimFacet.claimAsBorrower(loanId)` — pays collateral + VPFI
  rebate atomically

Once both sides have claimed (or have nothing to claim), the loan moves
to `Settled` and position NFTs are burned.

### 5.7 Lifecycle State Machine

`LibLifecycle` enforces the legal `LoanStatus` transition graph as a
single allow-list in an if-ladder (no data structure):

```
Active → Repaid | Defaulted | FallbackPending
FallbackPending → Active | Repaid | Defaulted
Repaid → Settled
Defaulted → Settled
```

Every status mutation routes through `transition()` or `initialize()`;
illegal edges revert with `IllegalTransition`. This keeps audit trails
predictable and prevents subtle ordering bugs in cross-facet flows.

---

## 6. Risk Engine

### 6.1 LTV and Health Factor

For loans with liquid collateral:

```
LTV     = BorrowedValueUSD / CollateralValueUSD
HF      = (CollateralValueUSD × LiquidationThresholdBps / BPS)
        / BorrowedValueUSD
```

`BorrowedValueUSD` includes principal + accrued interest. `LiquidationThresholdBps`
is per-asset and admin-configured under `RISK_ADMIN_ROLE`.

At loan initiation, `HF ≥ 1.5e18` (`MIN_HEALTH_FACTOR`) is enforced.
HF-triggered liquidation becomes available when `HF < 1e18`.

### 6.2 Add Collateral

Borrowers may proactively post additional collateral via
`AddCollateralFacet.addCollateral` to raise HF. The added collateral must
match the existing collateral asset type. The same call also functions
as the cure path during `FallbackPending` — restoring HF above threshold
returns the loan to `Active` and cancels the fallback snapshot.

### 6.3 Partial Collateral Withdrawal

When HF allows, lenders may permit partial principal withdrawal via
`PartialWithdrawalFacet.partialWithdrawCollateral` with borrower consent.
The post-withdrawal HF must remain `≥ MIN_HEALTH_FACTOR`.

### 6.4 Volatility LTV Collapse

If `LTV > 110%` (`VOLATILITY_LTV_THRESHOLD_BPS`), the swap path is
skipped entirely and the loan routes directly to `FallbackPending` to
avoid forcing a sale into a collapsed market. This handles the case where
collateral has crashed below the borrowed amount before any liquidator
arrives.

---

## 7. Liquidation and Fallback Settlement

### 7.1 Triggers

Two distinct liquidation paths exist:

- **HF-based** via `RiskFacet.triggerLiquidation(loanId, AdapterCall[])`
  when `HF < 1e18`. Always permissionless.
- **Time-based** via `DefaultedFacet.triggerDefault(loanId, AdapterCall[])`
  when the grace period has expired. Permissionless.

For NFT rental defaults, `triggerDefault` revokes the borrower's user
rights; the prepayment + buffer route to the lender (minus treasury
fee), and the NFT returns to the lender's escrow.

### 7.2 Swap-Failover (LibSwap)

Liquidation conversion of liquid collateral into the borrowed asset
goes through a four-DEX failover pipeline. The caller (keeper or
frontend) supplies a ranked `AdapterCall[]` try-list:

1. **0x Settler** (production routing aggregator)
2. **1inch v6** (production routing aggregator)
3. **Uniswap V3** (single-hop direct quote)
4. **Balancer V2** (subgraph-discovered pool quote)

`LibSwap.swapWithFailover(...)` iterates the ranked list. For each
attempt:

- approval is set to **exactly** the input amount needed (no unlimited
  approvals)
- the adapter call is wrapped in try / catch
- approval is revoked after the attempt regardless of success or failure
- the protocol enforces `realizedOut ≥ minOutputAmount` via balance-delta
  on the aggregator path or `amountOutMinimum` on the DEX path

The first adapter that meets the floor commits and returns realized
proceeds. Total failure (all adapters revert or under-fill) routes the
loan to `FallbackPending` and emits `SwapAllAdaptersFailed`.

**Caller insulation invariant.** The keeper picks routes, but cannot
weaken the slippage cap. `minOutputAmount` is computed by the protocol
from the oracle-derived expected output minus the configured slippage
budget. `LiquidationMinOutputInvariant.t.sol` asserts this with
`vm.expectCall` against a 1,000-address fuzz of liquidator identities.

### 7.3 Slippage and Liquidator Incentive

Successful liquidations follow a bounded execution model:

- `realized_slippage% + liquidator_incentive% = 6%` (`MAX_LIQUIDATION_SLIPPAGE_BPS`)
- `liquidator_incentive ≤ 3%` (`MAX_LIQUIDATOR_INCENTIVE_BPS`)
- treasury receives `2%` (`LIQUIDATION_HANDLING_BPS`) on top, separate
  from the Yield Fee on recovered interest

The liquidator is paid first. The remainder discharges the lender's
debt. Any residual returns to the borrower via the borrower NFT claim
flow.

The `6%` ceiling is governance-configurable within an audited bounded
range. The frontend reads the live value rather than hard-coding `6%`.

### 7.4 Abnormal-Market Fallback

If the slippage check fails — every adapter reverts, every adapter
under-fills, or volatility LTV has collapsed past `110%` — the protocol
**stops trying to convert** and routes to the fallback path. This is
not a revert; it is a state transition.

Fallback semantics (`LibFallback.record(...)`):

- the loan status moves to `FallbackPending`
- collateral and the per-bps split are snapshotted at fallback time
- the lender may claim immediately — there is no separate borrower
  grace window
- before lender claim execution starts, the borrower may still:
  - **fully repay** the loan (cancels fallback, routes to normal `Repaid`)
  - **add collateral** to restore HF (returns to `Active`)
- once lender claim execution starts, that path is final

When the borrower has not cured before claim, the lender's claim
attempts one more swap retry (lender or keeper supplies a fresh
`AdapterCall[]` try-list). If retry also fails:

- lender receives collateral equivalent to `LendingDue + AccruedInterest + 3%`
- treasury receives collateral equivalent to `2%` of the lending amount
- if remaining collateral value is below the lender entitlement, lender
  receives the full remaining collateral and the borrower receives nothing
- if remaining collateral value exceeds the entitlements, residual
  collateral remains attributable to the borrower

The `+3% / +2%` premium exists because the borrower did not act before
liquidation became necessary.

### 7.5 Settlement as Immutable Plan

`LibSettlement.computeRepayment` and `computePreclose` are pure functions
that produce an immutable `ERC20Settlement` plan: principal, interest,
late fee, treasury share, lender share, lender due, and the
borrower VPFI rebate split. The facet body executes transfers from
that plan exactly. This separation prevents the class of bug where the
event log reports one split and the transfer executes another.

### 7.6 Adapter Registry

Production deploys must register at least one swap adapter via
`AdminFacet.addSwapAdapter`. A deployment with zero adapters reverts on
every swap-based liquidation attempt, automatically reaching the
fallback path. This is intentional — the test suite exercises this as
a bright-line gate.

### 7.7 Operator Tooling

To support the swap-failover flow end-to-end:

- A Cloudflare Worker (`ops/hf-watcher`) exposes `/quote/0x` and
  `/quote/1inch` proxy endpoints that inject operator API keys server-
  side and apply per-IP rate limits.
- The frontend's `swapQuoteService` uses these proxies plus direct
  on-chain `QuoterV2` reads for UniV3 (across three fee tiers) and a
  per-chain Balancer V2 subgraph URL for pool discovery.
- The hf-watcher Worker can run an autonomous keeper mode that polls
  subscribed-user loans and submits permissionless `triggerLiquidation`
  when HF crosses 1.0. This mode is opt-in and requires worker secrets
  + a funded keeper EOA per chain.
- A standalone public reference keeper bot lives in the sibling repo
  `vaipakam-keeper-bot`. MIT-licensed, Node.js / TypeScript,
  ABI-synced from the monorepo via `forge inspect <Facet> abi --json`.

---

## 8. Oracle Stack

### 8.1 Quote Asset and Conversion

ETH (in practice WETH) is the protocol's quote asset for liquidity
classification because it is the deepest cross-chain venue. Pool depth
is converted to USD via the active chain's Chainlink `ETH/USD` feed.

For ERC-20 pricing:

- preferred path: direct Chainlink `asset/USD` feed
- fallback: `asset/ETH × ETH/USD` (only when no direct USD feed exists)
- WETH special case: priced directly from `ETH/USD`; no circular
  WETH/WETH liquidity check

### 8.2 Hybrid Peg-Aware Staleness

The hybrid staleness model:

- volatile assets must be `≤ 2 hours` old (`ORACLE_VOLATILE_STALENESS`)
- stable / reference feeds may extend to `≤ 25 hours` only when the
  reported price stays within `±3%` (`ORACLE_PEG_TOLERANCE_BPS`) of
  either the implicit USD `$1` peg or a governance-registered fiat /
  commodity reference (EUR/USD, JPY/USD, XAU/USD)
- feeds beyond 25 hours always reject

Per-feed overrides allow oracle admins to tighten the staleness budget
or set a minimum-valid-answer floor for critical aggregators. Setting
the override staleness back to zero clears it.

### 8.3 Soft 2-of-N Secondary Quorum

Chainlink remains the primary pricing path. Secondary oracles harden the
gate against single-feed manipulation:

- **Tellor** (`ITellor`) — 15-minute staleness, queried by symbol (e.g.
  "ETH/USD")
- **API3** (`IApi3ServerV1`) — airnode-managed dAPI proxy, queried by
  proxy address
- **DIA** (`IDIAOracleV2`) — DIA price feeds, queried by symbol key

The decision rule:

- if **every** secondary is unavailable, Chainlink is accepted alone
- if **at least one** available secondary agrees with Chainlink within
  `secondaryOracleMaxDeviationBps`, Chainlink is accepted
- if one or more secondaries disagree and **none** agree, pricing
  reverts with `OraclePriceDivergence`

Secondary oracle keys are derived from `IERC20.symbol()` on-chain. There
is **no per-asset governance write** required to enable secondaries on
new collateral assets — adding USDC, USDT, or any symbol with secondary
coverage works automatically. Pyth was specifically not adopted because
its per-asset `priceId` mapping conflicted with this no-config policy.

### 8.4 V3 Multi-Clone Liquidity

Pool depth is read from `IUniswapV3Factory.getPool(asset, WETH, fee)`
across the configured V3-clone factory set:

- Uniswap V3
- PancakeSwap V3
- SushiSwap V3

Across multiple fee tiers (the protocol registers `500 / 3000 / 10000` bps
tiers for each clone). Results combine with **OR** logic — one
sufficiently deep pool on any clone at any fee tier is enough.

### 8.5 L2 Sequencer Circuit Breaker

On L2 chains (`Base`, `Arbitrum`, `Optimism`, `Polygon zkEVM`), HF-based
liquidation reverts if Chainlink's sequencer-uptime feed reports the
sequencer is down OR is still inside its 1-hour post-recovery grace
window. This prevents attackers from exploiting the small stale-price
window at L2 resumption to trigger unfair liquidations.

### 8.6 Off-Chain Consumers

Several off-chain processes read the oracle and liquidation surface:

- the canonical frontend's `useLiquidationQuotes` hook
- the hf-watcher Cloudflare Worker (autonomous keeper + alert sweep)
- the public reference keeper bot in the `vaipakam-keeper-bot` repo

All three submit liquidation transactions permissionlessly. None hold
any Diamond role — a keeper that needed an admin role would be a
structural hazard.

---

## 9. NFT Rental Subsystem

### 9.1 Custody Model

For rentable ERC-721 / ERC-1155 NFTs (ERC-4907 compliant), the protocol
escrows the asset in `VaipakamEscrow` and assigns `ERC-4907`-style
**user rights** to the borrower for the agreed duration. The borrower
never receives custody or ownership of the underlying NFT.

### 9.2 Prepayment and Buffer

The borrower locks ERC-20 prepayment equal to `daily_fee × days × 1.05`.
The `5%` buffer (`RENTAL_BUFFER_BPS`) covers settlement edge cases:

- on timely return, buffer refunds to the borrower
- on default, buffer routes to treasury
- daily auto-deduction is permissionless via `RepayFacet.autoDeductDaily`

### 9.3 ERC-1155 Read Surface

For ERC-1155 rentals, the escrow is the canonical read surface for
external integrations. Third-party apps querying for the active rented
quantity for a given `(collection, tokenId)` pair receive:

- the aggregate rented quantity within that escrow
- the **minimum** active expiry across all rented units

This conservative model prevents external integrations from overstating
duration or simultaneous usability.

### 9.4 Strategic Rental Flows

NFT rental positions support borrower preclose (transfer of remaining
rental to a new borrower) and standard repayment. Rental loans are not
eligible for borrower preclose Option 3 (offset) or for lender early
withdrawal — those flows apply only to ERC-20 loans.

---

## 10. Strategic Flows

### 10.1 Borrower Preclose

Three options for borrower-initiated early closure:

- **Option 1: Standard Early Repayment** — borrower pays `Principal +
  full contractual interest for the original term`. Lender becomes
  entitled to principal + interest − Yield Fee; borrower reclaims
  collateral.
- **Option 2: Loan Transfer to Another Borrower** — original borrower
  exits by accepting a compatible borrower offer. The new borrower locks
  collateral; the original borrower pays accrued interest plus any
  shortfall to keep the original lender whole. The lender's loan
  continues with the new borrower.
- **Option 3: Offset with a New Lender Offer** — the original borrower
  becomes a lender on a new offsetting position, neutralizing their
  borrower obligation. Restricted to active ERC-20 loans only. Atomic
  on counterparty match: the original loan settles in the same
  transaction as the new offer's acceptance.

Across all three:

- principal / payment / collateral asset **types** must remain identical
- replacement terms must favor the original lender, or the borrower
  funds the shortfall
- claim rights continue to follow position NFTs

### 10.2 Refinance

Available for active ERC-20 loans. By the time the borrower calls
`RefinanceFacet.refinanceLoan(oldLoanId, newOfferId)`, the replacement
lender has already accepted the new borrower offer and the replacement
loan exists as a standalone live loan. Refinance is a single atomic
settlement step:

1. repay the old lender (principal + early-repayment interest)
2. release the original collateral back to the borrower's wallet
3. update old-loan NFTs to closed
4. close the old loan

The replacement collateral was already locked at the new loan's
acceptance; the new loan's HF / LTV gate was checked there. There is
no separate refinance-time HF gate for the borrower handoff.

### 10.3 Lender Early Withdrawal

Three options for lender-initiated exit:

- **Option 1: Sell the Loan to Another Lender** — accept a compatible
  lender offer. Original lender forfeits accrued interest to treasury;
  receives outstanding principal. Borrower's loan continues with new
  lender. Available as ERC-20 only.
- **Option 2: Create a New Offer Through the Borrower-Offer Path** —
  initiate exit through an offsetting offer flow.
- **Option 3: Wait for Loan Maturity** — passive fallback; no transfer
  occurs.

### 10.4 Strategic Flow Authority

Borrower-side strategic actions follow the borrower-side position NFT
holder, not the originating wallet. Lender-side actions follow the
lender-side NFT holder. A rented `userOf` address, an approved keeper,
or a third-party helper is **not** sufficient to start a new strategic
flow — those delegations are allowed only on explicitly-documented
keeper-enabled completion functions.

### 10.5 Same-Asset-Type Continuity

All preclose, transfer, and early-withdrawal paths preserve the
**asset types** of the original loan (principal, payment, collateral).
Only **amounts** may vary, and only to the extent that variations do
not disadvantage the protected counterparty. This invariant lets the
protocol safely skip a fresh transfer-time HF gate in cases like
`transferObligationViaOffer` because the original lender's risk
profile remains unchanged.

---

## 11. VPFI Token and Tokenomics

### 11.1 Token Parameters

| Parameter | Value |
|---|---|
| Name | `Vaipakam Finance Token` |
| Symbol | `VPFI` |
| Decimals | `18` |
| Hard Cap | `230_000_000` |
| Initial Mint | `23_000_000` (10% of cap) |
| Canonical Chain | `Base` |
| Standard | `LayerZero OFT V2` |
| Mint Access | TreasuryFacet via timelock-controlled multi-sig |

The token is `ERC20CappedUpgradeable` (UUPS-upgradeable). The cap is
enforced natively by the contract; mints flow only through an authorized
`minter` address (TreasuryFacet). Owner can pause all transfers as an
emergency brake.

### 11.2 Allocation

| Category | % | Amount | Vesting |
|---|---:|---:|---|
| Founders | 6% | 13,800,000 | 12-mo cliff + 36-mo linear |
| Developers & Team | 12% | 27,600,000 | Same as founders |
| Testers & Early Contributors | 6% | 13,800,000 | 6–12 mo cliff |
| Platform Admins | 3% | 6,900,000 | Timelock controlled |
| Security Auditors | 2% | 4,600,000 | One-time on delivery |
| Reserve | 1% | 2,300,000 | One-time |
| Bug Bounty | 2% | 4,600,000 | Multi-sig locked |
| Exchange / Market Making | 14% | 32,200,000 | 50% liquidity / 50% locked |
| **Early Fixed-Rate Purchase** | 1% | 2,300,000 | Public sale at `1 VPFI = 0.001 ETH` |
| **Platform Interaction Rewards** | 30% | 69,000,000 | Daily emission via 8-band schedule |
| **Staking Rewards** | 24% | 55,200,000 | `5% APR` on escrow balances |
| **Total** | **100%** | **230,000,000** | |

### 11.3 Fee Discount Tiers

Both lender and borrower discounts use the same chain-local tier table,
keyed on **escrowed VPFI balance on the relevant lending chain**:

| Tier | Escrowed VPFI | Discount | Lender Effective Yield Fee | Borrower Effective LIF |
|---|---|---:|---:|---:|
| 1 | `≥ 100` and `< 1,000` | `10%` | `0.9%` | `0.09%` |
| 2 | `≥ 1,000` and `< 5,000` | `15%` | `0.85%` | `0.085%` |
| 3 | `≥ 5,000` and `≤ 20,000` | `20%` | `0.8%` | `0.08%` |
| 4 | `> 20,000` | `24%` | `0.76%` | `0.076%` |

Tier resolution is **chain-local**: VPFI in escrow on `Base` does not
discount loans initiated on `Optimism`. Users opt in via a single
platform-level consent surfaced on `Dashboard` — there is no per-offer
or per-loan toggle.

### 11.4 Time-Weighted Discount Accumulator

The protocol enforces **time-weighted** discount calculation across the loan
lifetime, not point-in-time tier lookup. `LibVPFIDiscount.rollupUserDiscount`
re-stamps the BPS at the **post-mutation** escrow VPFI balance on every
balance change. This rollup closes the gaming vector where a user could
keep a high-tier stamp after dropping to tier 0 until the next balance
change.

The lender discount is applied at settlement: the time-weighted average
BPS reduces the Yield Fee taken from lender interest, deducting the
required VPFI amount from the lender's escrow into Treasury via the
ETH+asset USD conversion path.

### 11.5 Borrower LIF — Up-Front + Time-Weighted Rebate

The borrower path inverts the fee source. At `OfferFacet.acceptOffer`
on the VPFI path:

1. Borrower pays the **full** non-discounted `0.1%` LIF equivalent in
   VPFI (not tier-discounted) from escrow into Diamond custody (not
   Treasury). Stored in `s.borrowerLifRebate[loanId].vpfiHeld`.
2. Borrower receives `100%` of the requested lending asset.

At proper settlement (`RepayFacet` terminal, `PrecloseFacet` direct +
offset, `RefinanceFacet`):

```
rebate = vpfiHeld × avgBps / BPS
treasuryShare = vpfiHeld − rebate
```

`LibVPFIDiscount.settleBorrowerLifProper(loan)` splits `vpfiHeld`,
stores rebate on the loan, and forwards the treasury share. At
`ClaimFacet.claimAsBorrower`, the rebate pays atomically with the
normal collateral claim.

At default / HF-liquidation (`DefaultedFacet`, `RiskFacet` HF-terminal):
`LibVPFIDiscount.forfeitBorrowerLif(loan)` forwards the full held
amount to treasury; no rebate.

This model removes the prior gaming vector where a borrower could
briefly top up VPFI at acceptance to capture a full discount and unstake
immediately after. Borrowers pay full LIF up front and earn the discount
**only for the time they actually held the tier balance**.

### 11.6 Early Fixed-Rate Purchase

A `1%` allocation (`2,300,000 VPFI`) is sold publicly at the fixed rate
`1 VPFI = 0.001 ETH`. Caps:

- global: `2,300,000 VPFI`
- per-wallet per-chain: `30,000 VPFI` (admin-configurable)

User flow (the `Buy VPFI` page):

1. The user, connected to their preferred supported chain, pays ETH at
   the fixed rate. The page must not require a manual chain switch.
2. Purchased VPFI is delivered to the user's **wallet** on that same
   chain — never auto-routed into escrow. If the flow settles through
   a Base canonical receiver, mint/release is gated on actual ETH
   receipt (not quoted amounts).
3. A separate explicit user action moves VPFI from wallet into the
   user's personal escrow on the same chain. Permit2 single-signature
   path is supported as a convenience; classic approve-plus-deposit
   remains the fallback.

ETH from the fixed-rate program routes to Treasury under the recycling
rule below.

### 11.7 Treasury Recycling Rule

VPFI received as fees and ETH received from the fixed-rate program both
recycle as:

- `38%` → Buy ETH (via configured aggregator)
- `38%` → Buy wBTC (via approved treasury path)
- `24%` → Held as VPFI

If the Insurance / Bug Bounty pool exceeds `2%` of total VPFI supply,
surplus recycles using the same `38 / 38 / 24` split. This is a
treasury-strengthening conversion, not a token burn.

---

## 12. Reward System

### 12.1 Staking Rewards (`5% APR`)

Any VPFI held in user escrow on a lending chain is automatically treated
as staked. Reward accrual uses the standard reward-per-token model:

```
rewardPerToken = rewardPerTokenStored
               + (APR_BPS × 1e18 × dt)
               / (BPS × SECONDS_PER_YEAR × totalStakedVPFI)

userReward = userBalance × (rewardPerToken − userRewardPerTokenPaid)
           + userPendingReward
```

Implementation notes:

- when `totalStakedVPFI == 0`, `rewardPerToken` freezes (prevents
  retroactive yield to the first staker after a quiet period)
- balance changes (deposit, withdraw, fee deduction) checkpoint the
  user's accrual before mutating the balance
- the `55,200,000 VPFI` pool cap is enforced at claim time via a
  monotone `stakingPoolPaidOut` counter
- rewards are local per chain — there is no cross-chain staking
- governance APR changes are era-bounded: the outgoing era closes its
  accrual into the global accumulator before the new APR activates,
  and dormant users still receive the correctly-weighted sum across
  every era when they eventually claim

Claim path: `claimStakingRewards()`. Unstaking is modeled simply as
moving VPFI from escrow back to wallet on the same chain. No lock-up.

### 12.2 Platform Interaction Rewards

A `30%` allocation (`69,000,000 VPFI`) funds usage-based rewards. The
emission schedule is front-loaded in 8 bands:

| Period | Annual Rate | Daily Pool (approx.) |
|---|---:|---:|
| Months 0–6 | 32% | ~20,164 VPFI |
| Months 7–18 | 29% | ~18,274 VPFI |
| Months 19–30 | 24% | ~15,123 VPFI |
| Months 31–42 | 20% | ~12,603 VPFI |
| Months 43–54 | 15% | ~9,452 VPFI |
| Months 55–66 | 10% | ~6,301 VPFI |
| Months 67–78 | 5% | ~3,151 VPFI |
| Month 79+ | 5% | ~3,151 VPFI (until cap) |

Daily pool split:

- `50%` to lenders, proportional to USD interest earned
- `50%` to borrowers, proportional to USD interest paid (clean repay only)

Per-user cap: `0.5 VPFI` per `0.001 ETH` equivalent of eligible interest
(`500 VPFI` per `1 ETH` equivalent). Excess above the cap stays in the
allocation rather than redistributing to other users.

Borrower interaction rewards are earned only on **clean** full
repayment. Late / defaulted / liquidated / post-grace-cured loans
forfeit the borrower share. Both lender and borrower interaction rewards
are claimable only **after the loan has closed** — `day 0` is excluded
from accrual.

### 12.3 Cross-Chain Reward Mesh

Loans are chain-local but the interaction-reward denominator is
**protocol-wide**. Computing rewards against a local-only denominator
would give a lender on a quiet chain an outsized share. The solution:
aggregate daily totals to the canonical chain and broadcast the global
denominator back.

Topology:

- Base is the **canonical reward chain**
- mirrors (`Ethereum`, `Polygon zkEVM`, `Arbitrum`, `Optimism`, `BNB Chain`)
  are reporters
- each mirror's `RewardReporterFacet.closeDay(dayId)` sends
  `chainInterestUSD` to Base via LayerZero `OApp.send`
- Base's `RewardAggregatorFacet` finalizes when all expected mirrors
  have reported OR after a 4-hour grace window past `dayId + 1 UTC`
- Base broadcasts the finalized `dailyGlobalInterestUSD[dayId]` back to
  every mirror via `OApp.send`
- mirrors store it as `knownGlobalInterest[dayId]`, the local denominator

A claim for `dayId` reverts locally if the global denominator hasn't
been broadcast yet. Late-arriving mirror reports past finalization are
recorded for audit but never retroactively change a finalized day —
this preserves claim determinism.

Each chain's per-day per-user cap is applied **after** the proportional
allocation, so an idle chain doesn't degrade a busy chain's user-level
cap behavior.

The interaction-reward VPFI pool is held on Base. Per-day per-chain
payout budgets compute as `(dailyChainInterest × dailyPool) / globalInterest`.
Treasury bridges that budget to each mirror via the existing OFT path
during finalization. Mirror-side `claimInteractionRewards()` draws from
the local VPFI reward vault — no synthetic IOUs, no cross-chain claim
hops.

### 12.4 Reward UX

Users have one `Rewards` page per chain that shows pending staking and
interaction rewards. `Claim Rewards` mints VPFI directly on the
connected chain. After claim, an optional `Bridge to another chain`
action surfaces the official LayerZero bridge.

---

## 13. Cross-Chain Surface

Five LayerZero OApp / OFT contracts live in `contracts/src/token/`:

### 13.1 `VPFIOFTAdapter` (Base)

OFT V2 adapter wrapping `VPFIToken` on the canonical Base chain.
Bridges OUT lock VPFI on Base + send message → destination mints. IN
burns on mirror + send → Base unlocks. The global cap is enforced via
the adapter's lock-set because mirror chains have no hard cap.

### 13.2 `VPFIMirror` (Non-Base)

Pure OFT V2 deployments on every mirror chain. No independent minter
surface; only `_credit` via authenticated peer messages. Mirror supply
equals currently-bridged VPFI.

### 13.3 `VPFIBuyAdapter` (Non-Base)

Cross-chain fixed-rate buy entry point. User sends ETH (or WETH on
Polygon); adapter locks payment + sends `BUY_REQUEST` to Base. Has
adapter-layer rate limits in addition to the Diamond-side cap:

- per-request: `50,000 VPFI`
- 24-hour rolling: `500,000 VPFI`

Both governance-tunable post-deploy.

### 13.4 `VPFIBuyReceiver` (Base)

Lands cross-chain buys. Processes via VPFIDiscountFacet (debits VPFI
from treasury balance), OFT-bridges result to buyer's origin chain,
sends `BUY_SUCCESS` / `BUY_FAILED` back to the originating adapter.
Pre-funded with ETH for LayerZero native fees.

### 13.5 `VaipakamRewardOApp`

Dedicated OApp for cross-chain reward accounting. Mirrors send `REPORT`
messages to Base; Base sends `BROADCAST` messages back. Authenticates
sender against the registered peer OApp address.

### 13.6 DVN Hardening (Mainnet Operational Requirement)

LayerZero defaults are 1-required / 0-optional DVN — the single-verifier
shape that the April 2026 cross-chain bridge incident exploited. Mainnet
deploys must run `ConfigureLZConfig.s.sol` to install:

- **3 required + 2 optional, threshold 1-of-2**
- Required: LayerZero Labs + Google Cloud + Polyhedra or Nethermind
- Optional: BWare Labs + Stargate / Horizen
- Confirmations: ETH 15, Base 10, OP 10, Arb 10, zkEVM 20, BNB 15
- Enforced options for every (OApp, eid, msgType) triple

`LZConfig.t.sol` asserts every OApp × eid reflects the policy. Builds
fail otherwise. The mainnet deploy runbook gates on this script having
run.

### 13.7 Pause Surface

Every LZ-facing contract exposes owner-gated `pause()` / `unpause()` on
both send and receive paths. The 46-minute pause during the April 2026
cross-chain bridge incident blocked ~$200M of follow-up drain — the
precedent. Pause authority on bridge-related contracts allows the
Guardian Safe to act fast but reserves unpause to the Owner / Timelock.

---

## 14. MEV Protection

### 14.1 What's Enforced On-Chain

- **Sandwich attack on liquidation swap.** RiskFacet + DefaultedFacet
  compute oracle-derived `minOutputAmount` and pass it to `LibSwap.swapWithFailover`.
  Each adapter enforces the same min-out floor on its own side. Caller-
  insulation invariant: keepers pick routes, never weaken the floor.
- **Oracle manipulation to trigger liquidation.** Chainlink + Soft 2-of-N
  quorum (Tellor + API3 + DIA) + L2 sequencer circuit breaker. To push
  a fake price through the gate, an attacker now must compromise
  Chainlink **plus** every secondary that has data for the asset in the
  same block.
- **Liquidator race during HF < 1.** Permissionless by design; first
  liquidator wins the bonus. This is natural MEV — how every serious
  lending protocol handles liquidator selection.

### 14.2 What's NOT Enforced On-Chain (User-Level Vectors)

Defensive borrower / lender txs (repay, addCollateral, refinance) are
visible in the public mempool and can be front-run by liquidation bots
racing for the bonus. Hard-gating against mempool visibility would
require either a private mempool integration at the protocol layer or
a UX most users can't navigate — neither is shipped.

User-level mitigations available:

- **Whitelist a trusted keeper.** The KeeperSettings system lets a user
  pre-authorize an address to execute defensive actions. A keeper
  operating its own private-mempool flow sidesteps the public-mempool
  window.
- **Use a private-mempool RPC.** Flashbots Protect / MEV Blocker on
  Ethereum mainnet; bloXroute / MEV Blocker on BNB Chain. L2 chains
  have sequencer-ordered inclusion and are naturally less exposed.

A frontend CoinGecko / CoinMarketCap sanity banner was evaluated and
**not adopted** — any frontend check is bypassable
via DevTools / a custom frontend / a direct `cast send`, so it doesn't
raise the actual security floor. The in-protocol Chainlink + Soft 2-of-N
deviation check is what actually enforces price sanity.

### 14.3 Keeper Per-Action Authorization

The KeeperSettings system supports granular delegation:

- per-user opt-in (master switch)
- per-keeper-address whitelist (max 5 addresses per user)
- per-action class (lender-side actions vs borrower-side actions)
- per-offer toggle
- per-loan toggle (post-initiation)

Keepers are **delegated role-managers**, not asset claimants. A
lender-approved keeper executes only lender-side keeper-enabled actions;
a borrower-approved keeper executes only borrower-side. Claim authority
**always** follows the current position NFT owner — keeper approval
never grants claim rights.

---

## 15. Governance and Operations

### 15.1 Three-Role Topology

- **Governance Safe (4-of-7, geographically separated).** Holds
  `DEFAULT_ADMIN_ROLE`. Only actor that can grant/revoke roles. Actions
  always go through the timelock.
- **Admin Timelock (`TimelockController`).** Holds `ADMIN_ROLE`,
  `ORACLE_ADMIN_ROLE`, `RISK_ADMIN_ROLE`, `ESCROW_ADMIN_ROLE`. 48-hour
  default delay (24-hour minimum after stabilization). Proposer:
  Governance Safe. Executor: open after delay.
- **Ops Safe / Guardian (2-of-5, fast-response on-call).** Holds
  `PAUSER_ROLE`. No delay — pause in a live exploit is useless if it's
  behind a 48h timelock.
- **Deployer hot key.** Used for initial deploy + role transfer.
  **Revoked within 24 hours.**

### 15.2 What Pause Blocks

`AdminFacet.pause()` sets a single boolean consulted by every
`whenNotPaused` modifier. Blocked: 47 call sites across 19 facets —
every user lifecycle entry point, every reward facet, every escrow
mutation.

**Not** blocked by pause (by design):

- `AccessControlFacet.grantRole / revokeRole / renounceRole`
- `DiamondCutFacet.diamondCut`
- `OracleAdminFacet.*`
- `EscrowFactoryFacet.upgradeEscrowImplementation / setMandatoryEscrowUpgrade`
- `AdminFacet.pause / unpause / paused`
- All view functions
- LayerZero message ingress to reward OApps (in-flight messages have
  their own auth gates)

`PauseGatingTest` enforces the gated set; any change to it must update
the test.

### 15.3 Per-Asset Pause

`AdminFacet.pauseAsset(asset)` is a finer-grained surface separate from
the global pause. When an asset is paused, new offers / loans involving
it revert, but in-flight wind-down (repayment, claims, addCollateral,
preclose, refinance) remains available so counterparties
are not trapped.

### 15.4 Timelock Minimum

`24 hours` after a deploy has stabilized; never below 24h on mainnet
without an audited rationale. Emergency override: no override via
timelock. Emergencies go through `PAUSER_ROLE`. If an admin-only change
is needed under emergency, unpause only after the timelock's delay —
or queue the change immediately and pause until it lands.

### 15.5 Key Rotation Procedure

Executed within 24 hours of a fresh deploy:

1. Grant new Governance Safe `DEFAULT_ADMIN_ROLE`
2. From Governance Safe: `TimelockController.scheduleBatch` granting
   ADMIN/ORACLE/RISK/ESCROW roles to the Timelock
3. From Governance Safe: directly grant `PAUSER_ROLE`
   to the Ops Safe (no timelock)
4. After 48h delay, execute the batch from step 2
5. From deployer hot key: `renounceRole` for every role
6. Verify: deployer holds zero roles; Governance / Timelock / Ops hold
   the expected roles

`DeployerZeroRolesTest` enforces step 6 as a cutover invariant.

### 15.6 Adapter Registration Gate

Mainnet deploys must register at least one swap adapter via
`AdminFacet.addSwapAdapter` before any value flows through the system.
A deployment with zero adapters reverts on every swap-based liquidation
attempt; the test suite exercises this as a bright-line gate.

### 15.7 Off-Chain Operations

- **hf-watcher Cloudflare Worker** — autonomous keeper + HF alert
  sweep. Polls subscribed-user loans, sends Telegram / Push alerts,
  optionally submits permissionless `triggerLiquidation` when HF
  crosses 1.0 (operator-controlled, opt-in).
- **Public reference keeper bot (`vaipakam-keeper-bot`)** — MIT-licensed
  Node.js / TypeScript repo. Third-party operators clone, configure
  their own keeper key + RPC + (optional) aggregator API keys, run on
  any chain. ABI-synced from the monorepo via
  `contracts/script/exportAbis.sh` (uses `forge inspect <Facet> abi --json`).
- **Subgraph** — The Graph indexing schema for analytics; consumed by
  the public dashboard.
- **Tenderly** — VM / simulation config for testing liquidations.

---

## 16. Frontend as a Safety Layer

### 16.1 Public Website

- homepage education
- public `Buy VPFI` flow (reachable from homepage without wallet)
- public analytics dashboard (no wallet required)
- FAQs and risk education
- `Terms` and `Privacy` public routes
- Cookie consent banner (GDPR / Google Consent Mode v2 compliant)
- Farcaster Frame at `/frames/active-loans` — wallet-address lookup
  surfacing active-loan count, lowest HF, per-chain breakdown

### 16.2 Connected App

Built on React + wagmi v2 + viem + ConnectKit. Pages:

- `Dashboard` — overview of loans, positions, metrics, the shared
  fee-discount consent control, and ENS / Basenames address resolution
- `OfferBook` — paginated two-sided market view, sorted around the last
  matched rate
- `Create Offer` — guided + advanced forms with combined risk consent
  enforcement
- `Loan Details` — LTV / HF, liquidation-price calculator (shows the
  collateral price at which HF reaches 1.0), per-side keeper status,
  Liquidate action with parallel route quotes
- `Claim Center` — settled-loan claims, including the borrower
  VPFI rebate line
- `Activity` — paginated lifecycle events
- `Buy VPFI` — fixed-rate purchase with chain selector
- `Rewards` — staking + interaction rewards, claim, unstake
- `Allowances` — ERC-20 / 721 / 1155 approvals to Diamond, with
  one-click revoke
- `Alerts` — HF alert subscriptions per loan (Telegram + Push Protocol)
- `Keepers` (advanced) — per-action keeper authorization

### 16.3 Transaction Safety

- **Permit2 single-signature path.** Uses Uniswap's canonical deployment
  at `0x000000000022D473030F116dDEE9F6B43aC78BA3`. EIP-712 signatures,
  30-minute expiry, high-entropy nonces, exact asset / amount / spender
  scope. Available for create offer, accept offer, VPFI escrow deposit.
  Wallets that don't support Permit2 fall back to classic approve-plus-
  action.
- **Blockaid simulation preview.** Shown on review modals before final
  confirmation. Distinguishes benign / warning / malicious / unavailable
  states. Server-side proxy keeps API keys off the browser. Fail-soft:
  unavailability collapses to a subtle `preview-unavailable` state but
  never blocks the on-chain path.

### 16.4 Mobile and Growth Surfaces

- **PWA support** — web app manifest + production-only service worker
  with stale-while-revalidate for the static shell. RPC, subgraph, and
  worker API responses bypass service-worker caching so chain state is
  never stale.
- **Mobile wallet deep linking** — ConnectKit-powered picker; tapping a
  wallet opens the wallet app directly via mobile deep link. QR pairing
  remains as fallback.
- **Safe app embed** — auto-detects Safe iframe context and auto-connects
  through the Safe postMessage handshake. Outside Safe, the connector
  is a no-op.
- **Farcaster Frame** at `/frames/active-loans` — public read-only growth
  surface.

### 16.5 Public Analytics Dashboard

No-wallet-required transparency surface. Top row: combined all-chains
headline totals. Below: chain-specific drill-down via a visible chain
selector. All metrics are derived from on-chain contract state and event
logs — no PII, no off-chain warehousing.

Required exports: CSV / JSON with snapshot timestamp, contract addresses,
and block number for verifiable provenance.

### 16.6 Two-Mode UX

A single global `Basic / Advanced` mode toggle drives conditional
rendering across the app:

- **Basic** — guided flows, fewer visible controls, safer defaults.
  Hides `Keepers` and `NFT Verifier` from navigation.
- **Advanced** — denser controls, diagnostics, protocol config details,
  exposed `Liquidity type` selectors, partial actions, keeper management.

Both modes use the same protocol rules; mode controls visibility and
density, never policy.

### 16.7 Diagnostics and Observability

A floating diagnostics drawer captures structured frontend telemetry
(step start / success / failure events) for every important action
path. Default filter is `Failure` (the most likely support-relevant
subset). The drawer supports `Download my data` / `Delete my data`
actions for Vaipakam-namespaced browser storage. Always available on
public pages where critical actions can fail.

---

## 17. Verification and Testing

### 17.1 Test Footprint

The Foundry test suite has 91 test files covering:

- **9 lifecycle facet tests** (Loan / Offer / Repay / Claim / Refinance / Preclose / Early Withdrawal / AddCollateral / PartialWithdrawal)
- **5 risk and liquidation tests** (Risk / Defaulted / VolatilityLTV / LiquidationMainnetFork / `LiquidationMinOutputInvariant`)
- **8 oracle tests** (Oracle / OracleAdmin / StalenessHybrid / OracleLiquidityOR / OracleMainnetFork / SecondaryQuorum / SequencerUptimeCheck / FeedOverride)
- **7 VPFI tests** (Discount / Boundaries / Token / OFTRoundTrip / SupplyCap invariant / TreasuryMint)
- **10 reward tests** (Interaction / Coverage / Cap / Staking / Cross-chain plumbing / OApp delivery + 4 invariants)
- **10 governance tests** (AccessControl / Admin / Config / GovernanceConfig / Handover / LZConfig / LZGuardian / PerAssetPause / PauseGating / DeployerZeroRoles)
- **20+ invariant suites** (FundsConservation / EscrowSolvency / FallbackSettlement / ClaimExclusivity / NFTOwnerAuthority / VPFISupplyCap / etc.)
- **8 end-to-end scenario suites** (Scenario1 through Scenario8 + FallbackClaimRace + PositiveFlowsGapFillers)
- **2 Permit2 fork tests** (local mock + real Permit2 against mainnet fork)
- **6 introspection tests** (Metrics / Enumeration / Loupe + 3 parity invariants)

Test settings: 1000 fuzz runs, 100 invariant runs × 50k calls.
Compiler: Solidity 0.8.29 with `viaIR = true`, optimizer at 200 runs.

### 17.2 Mainnet-Cutover Gate

Before any mainnet `-rc` tag, every `Scenario*.t.sol` and every
`invariants/*.invariant.t.sol` must be green on the target network's
fork. Specific load-bearing tests:

- `LZConfig.t.sol` — DVN policy readback for every (OApp, eid) pair
- `GovernanceHandover.t.sol` — three-role topology installed, deployer
  holds zero roles
- `LiquidationMinOutputInvariant.t.sol` — caller-insulation on `minOutputAmount`
- `SecondaryQuorumTest.t.sol` — Tellor + API3 + DIA quorum semantics
- `FeedOverride.t.sol` — per-feed staleness + min-answer bounds
- `Permit2RealForkTest.t.sol` — five negative paths against canonical
  Permit2 (expired deadline, wrong amount, nonce reuse, spender
  mismatch, happy path)

### 17.3 External Audits

Mandatory third-party security audits before mainnet launch on each
network. Audit scope includes the Diamond core, the four-DEX swap
failover, the secondary oracle quorum, the cross-chain reward mesh,
the borrower LIF custody, and the LayerZero OApp surface.

Audit reports will be published where appropriate. The static analysis
toolchain includes Slither and Mythril. Bug bounty scope, severity, and
reward ranges will be public before mainnet launch.

---

## 18. References

1. `EIP-2535` Diamond Standard
2. `ERC-20`, `ERC-721`, `ERC-1155`, `ERC-4907` standards
3. Chainlink Price Feeds and Feed Registry
4. Uniswap V3 / PancakeSwap V3 / SushiSwap V3 concentrated-liquidity AMMs
5. `LayerZero OFT V2` cross-chain token standard
6. Tellor TRB oracle, API3 dAPI, DIA price feeds
7. 0x Settler v2, 1inch v6 routing aggregators
8. Balancer V2 vault and subgraph
9. Uniswap Permit2 (`0x000000000022D473030F116dDEE9F6B43aC78BA3`)
10. OpenZeppelin Contracts Upgradeable (UUPS, AccessControl, Pausable, ERC721)
11. Diamond-3 reference implementation (Mudgen)
12. Vaipakam `README.md`, `CLAUDE.md`, `docs/TokenomicsTechSpec.md`,
    `docs/MEVProtection.md`, `docs/OraclePolicy.md`, `docs/GovernanceConfigDesign.md`,
    `docs/GovernanceRunbook.md`, `docs/WebsiteReadme.md`
13. LayerZero KelpDAO Incident Statement (April 2026) and follow-up
    industry coverage of the cross-chain bridge exploit

---

## License

This document and the Vaipakam codebase ship under
**Business Source License 1.1 (BUSL 1.1)** with the project-specific
terms recorded in `LICENSE`. Change Date: 5 years after production
deployment. Change License: MIT.
