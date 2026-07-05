# Vaipakam: Technical Whitepaper

**Version:** `4.0`
**Date:** July 2026
**Status:** Production-oriented technical specification. Live protocol deployments are currently testnet and local only; a third-party security audit is required before any mainnet launch.

---

## Abstract

Vaipakam is a non-custodial, peer-to-peer credit protocol in which lenders and
borrowers negotiate their own terms — rate, duration, collateral, and interest
mode — instead of borrowing from a pooled money market. The protocol supports
over-collateralized ERC-20 lending against ERC-20 or NFT collateral, and true
NFT rental in which the renter receives on-chain usage rights while the asset
never leaves vault custody. Every user's assets are held in an isolated
per-user vault; every open position is represented by a transferable on-chain
position NFT whose current holder carries the position's claim rights; and the
protocol's safety-critical actions — liquidation and default resolution — are
permissionless by design.

Each supported network runs an independent `EIP-2535` Diamond deployment, with
all offer, loan, collateral, and claim state local to its chain. The intended
mainnet chain set is Ethereum, Base, Arbitrum, Optimism, and Polygon. Risk is
managed through a risk-adjusted Health Factor, a liquidity classification that
prices unverifiable assets at zero rather than guessing, an oracle stack with
peg-aware staleness rules and a soft secondary quorum, and a
multi-adapter swap-failover liquidation pipeline with an in-kind fallback for
abnormal markets. The protocol token, `VPFI`, is a fee-discount and
interaction-reward utility transported between chains as a Chainlink CCIP
Cross-Chain Token, with reward accounting aggregated on a canonical chain and
claims served locally on every chain.

This document specifies the architecture, the offer and loan lifecycle, the
risk and liquidation engine, the oracle and liquidity model, the NFT rental
subsystem, the strategic position-management flows, the VPFI tokenomics and
reward mesh, the MEV and keeper-authorization model, and the governance,
verification, and operational posture that together define the protocol.

---

## Table of Contents

1. Introduction and Design Principles
2. System Model
3. Architecture
4. Asset Classification and Liquidity
5. The Offer Book
6. Loan Lifecycle
7. Risk Engine
8. Liquidation and Default Settlement
9. Oracle Infrastructure
10. NFT Rental
11. Strategic Position Management
12. VPFI Token and Tokenomics
13. Interaction Rewards
14. Cross-Chain Infrastructure
15. MEV Protection and Keeper Authorization
16. Governance, Security, and Operations
17. Product Interfaces
18. Verification and Testing
19. References

---


## 1. Introduction and Design Principles

Vaipakam is a decentralized peer-to-peer lending, borrowing, and NFT rental protocol. It facilitates loans of ERC-20 tokens and rentals of ERC-4907-compliant ERC-721/1155 NFTs, collateralized by any ERC-20 token or NFT the counterparties agree on. Unlike pooled money markets, Vaipakam has no shared liquidity pool and no protocol-set interest curve: every loan is formed from two explicit offers — a lender's terms and a borrower's terms — that meet either by direct acceptance or by permissionless matching of overlapping limit orders.

Peer-negotiated terms matter for two reasons. First, they permit asset-specific pricing: a lender can demand a rate, duration, and collateral package appropriate to the exact asset pair, including assets no pooled market would list — the protocol supports any ERC-20 and any NFT, pricing what it can through oracles and treating the rest as explicitly consented illiquid risk. Second, they eliminate shared-pool contagion: each loan is a bilateral position with its own collateral, its own liquidation path, and its own claim rights. A bad loan can harm only its own counterparties; there is no pool whose depositors socialize the loss.

The protocol is built around the following named design principles.

**User-defined terms.** Lenders state the maximum they will lend, the minimum rate they will accept, and the collateral they require; borrowers state the minimum they need, the maximum rate they will pay, and the collateral they will lock. Offers are canonical limit orders — single-value offers are simply ranges with equal bounds — and the protocol's matching rules are deterministic, so no third party can impose terms neither side authored.

**Per-user vault isolation.** Every user's assets are held in that user's own vault contract — a dedicated proxy deployed per user — never in a shared pool. Collateral, escrowed offer principal, rental NFTs, and vaulted VPFI are segregated per user with no commingling, so one user's position can never be paid out of another user's assets.

**Non-custodial at the user-action layer.** Assets move from a user's wallet into that user's own vault by explicit user action, and settlement flows transfer value directly to the counterparty's vault or the treasury rather than parking it in shared protocol custody. The Diamond itself holds user assets only for deliberately staged custody (for example, borrower VPFI fee custody over a loan's life and liquidation swap-output routing), and claims are pull-based: funds are released only to the current holder of the relevant position NFT.

**Fail-closed defaults.** When a safety check cannot be completed, the protocol assumes the unsafe answer. An asset whose price path or liquidity check fails is classified illiquid — no manual override can reclassify it. Oracle cross-check divergence reverts pricing rather than guessing. Fresh Diamond deployments initialize paused until every facet cut and post-deploy assertion has succeeded. Powerful features (partial-fill matching, depth-tiered LTV, periodic interest, keeper automation classes) ship behind master switches that default off.

**Positions as transferable NFTs.** Every offer and loan position is represented by an ERC-721 with on-chain metadata. Claim rights, role-gated actions, and payout routing follow the current NFT owner, so positions are portable financial objects that can be inspected, verified, and transferred on the secondary market.

**Permissionless safety actions.** Liquidation of an unhealthy loan and default processing after an expired grace period may be triggered by any address. These actions carry no caller discretion over pricing or settlement terms — the caller can only execute what protocol state already permits — so keeping them permissionless guarantees the protocol's safety valves work even if every operator disappears.

**Single-entry-point Diamond.** All protocol logic is reached through one contract, `VaipakamDiamond`, which routes calls by function selector to modular facets sharing one storage layout. Users, integrators, and indexers interact with a single stable address per chain while the implementation stays upgradeable in small, auditable units.

**Frontend as a safety layer, not a gatekeeper.** The reference interface adds warnings, risk previews, simulation, and consent capture, but every binding rule is enforced on-chain: the contract's own liquidity classification overrides the frontend's assessment, acceptance signatures bind to the exact economic terms of the stored offer, and mandatory risk-and-terms consent is recorded on-chain. A hostile or buggy interface can degrade convenience, not safety.

## 2. System Model

### 2.1 Chain Model

Vaipakam's core protocol is single-chain per deployment. Each supported network hosts its own independent `VaipakamDiamond` instance, and every aspect of a given loan — offer, acceptance, collateral, repayment, claims, liquidation, preclose, refinance, and keeper actions — stays local to the chain where the loan was initiated. There is no cross-chain loan lifecycle.

The Phase 1 production target set is Ethereum mainnet, Base, Polygon, Arbitrum, and Optimism, each receiving a separate Diamond deployment from chain-parameterized deploy tooling. The active testnet mesh is defined by an explicit operator-maintained allow-list of exported deployment artifacts: Base Sepolia is the canonical testnet, with mirror testnets such as Sepolia, Arbitrum Sepolia, and OP Sepolia joining only when their artifacts, RPC secrets, and peer wiring are current. BNB Smart Chain Testnet participates primarily as a cross-chain mirror and rehearsal network. Local development and end-to-end flow sweeps run against Anvil, and the connected app recognizes Anvil/Hardhat as a distinct local-dev mode.

The only cross-chain elements are the VPFI token and its accounting: VPFI is deployed as a Chainlink Cross-Chain Token (CCT) over CCIP to preserve one global supply cap, reward accounting reports flow to a single canonical chain, and tier-cache and reward-budget messages flow back out. Base is the canonical chain for VPFI, fee-discount tier resolution, and reward aggregation; all other deployments are mirrors that consume authenticated caches. The Phase 1 cross-chain scope matches the production set — Ethereum, Base, Polygon, Arbitrum, and Optimism; BNB Smart Chain participates at the testnet tier as a cross-chain rehearsal network, and zk-rollup chains and Solana are out of scope.

Deployment status: as of July 2026 Vaipakam runs on testnets and local environments only — production-network Diamonds have not been deployed. Contracts undergo third-party security audits before mainnet deployment on each network, and the deploy ceremony itself is gated by preflight checks (facet size, selector coverage, born-paused initialization, governance-handover verification).

### 2.2 Product Surface

The platform's user-facing surface, as specified for the reference web application, comprises:

- **ERC-20 lending and borrowing** — offer creation (on-chain, or gasless EIP-712 signed offers), acceptance, repayment (full, partial, periodic-interest cadence), collateral top-up and partial withdrawal, borrower swap-collateral-to-repay, preclose, refinance, and lender early-withdrawal flows.
- **NFT rental** — rentable ERC-4907-compliant ERC-721/1155 NFTs held in the owner's vault, with the renter receiving temporary user rights against an ERC-20 prepayment (total rental fees plus a 5% buffer); the vault acts as the stable rental-state integration surface for third parties.
- **Offer Book** — the market-browsing surface with side/asset/status/liquidity/duration filters, market-rate anchors, direct accept, and range-order (partial-fill) visibility.
- **Dashboard** — the user's own positions: active loans with role and status filters, offers across states, grouped range-offer summaries, auto-lend standing-intent and auto-lifecycle settings, and the shared VPFI fee-discount consent.
- **Loan Details** — live per-loan state, role-gated actions resolved from position-NFT ownership, chronological on-chain timelines, liquidation planning, periodic-interest checkpoints, and keeper-permission controls.
- **Claim Center** — pull-based claims for terminal loans (principal, interest, collateral, surpluses, VPFI rebates) plus platform-interaction reward claims.
- **VPFI utility** — deposit externally acquired VPFI into the user's vault, withdraw free VPFI, and inspect tiered fee-discount status; users acquire VPFI outside the protocol, and vault-held VPFI serves fee utility only.
- **Rewards** — platform-interaction rewards earned from lending and borrowing activity, claimed chain-locally through the Claim Center.
- **Your Vaipakam Vault** — the per-user vault surface showing Total / Locked / Free balances per asset, deposits, withdrawals, and protocol-tracked balance display.
- **Activity** — a wallet-scoped and market-scoped event feed built from indexed protocol events.
- **Public Analytics** — a no-wallet transparency dashboard over protocol-wide metrics, treasury data, and deployed-contract artifacts, backed by public view functions on the Diamond.
- **NFT Verifier** — a public tool for inspecting any Vaipakam position NFT, including its live status, linked loan or offer, and default-settlement mode.
- **Protocol Console** — the admin/governance surface (`/admin`): read-only parameter visibility for everyone, Safe-transaction composition for privileged wallets.

### 2.3 Roles

**Lender.** Creates lending offers (escrowing principal in their vault, locked while the offer is live) or accepts borrower offers. Earns interest less the yield fee; holds the lender-side position NFT, which carries the claim rights to repayment proceeds and default settlements. May exit early by selling the position or via the documented early-withdrawal options.

**Borrower.** Creates borrowing offers (locking collateral) or accepts lender offers. Receives principal net of the loan-initiation fee, must maintain the loan's health constraints, and holds the borrower-side position NFT, which carries the rights to reclaim collateral and any surplus at settlement.

**NFT owner / renter.** The rental-market specialization of lender and borrower. The NFT owner lists a rentable ERC-4907-compliant NFT at a daily rate; the NFT itself remains vault-controlled for the whole rental. The renter locks an ERC-20 prepayment (total rental fees plus the 5% buffer) and receives only temporary user rights — never custody or ownership of the NFT.

**Liquidator (permissionless).** Any address may call `triggerLiquidation` when a loan's Health Factor falls below 1.0, and `triggerDefault` once the grace period has expired. The caller earns a bounded incentive but has no discretion over terms; liquidation is deliberately independent of every keeper whitelist and access switch.

**Keeper (delegated, per-action opt-in).** A user-whitelisted external address (at most 5 per user) that may initiate specific strategic flows — preclose, obligation transfer, refinance, sale-listing — on the consenting party's behalf. Authorization is a three-switch model: a per-user master switch, per-keeper narrow action grants (one permission bit per flow, never a blanket grant), and a per-loan switch; all default off and all three must agree. A keeper is a role-manager only: it can never receive funds, claim rights, or position ownership, and a protocol-wide delegated-keeper pause can freeze all keeper activity while leaving owner-direct actions and permissionless liquidation untouched.

**Matcher.** Any caller of `matchOffers` when range-order matching is enabled. Like liquidation, matching is permissionless because it can only execute a valid pairing of two live consenting offers under deterministic rules; the matcher earns a configured share of the loan-initiation fee flow (default 1%, governance-tunable).

**Treasury / operator.** The treasury collects protocol fees — the 0.1% loan-initiation fee, the yield fee on interest and rental earnings, late-fee intake, and liquidation-handling entitlements — and is managed through `TreasuryFacet` and admin configuration. Operators run the off-chain surfaces (keeper worker, indexer, deploy ceremonies) but hold no special on-chain authority beyond the roles granted to them.

**Governance (multisig → timelock).** Privileged authority is split by blast radius after handover: a Governance Safe holds `DEFAULT_ADMIN_ROLE`, a Timelock holds delayed-action roles (admin, oracle/risk/vault administration, `UNPAUSER_ROLE`) and ERC-173 Diamond ownership, and the deployer renounces every privileged role once grants are confirmed. All parameter changes flow through bounded, range-validated setters composed as Safe/Timelock batches. Broader VPFI token-holder governance is Phase 2 scope.

**Guardian.** The fast incident lever. A Pauser/Guardian Safe holds `PAUSER_ROLE` for immediate global and per-asset pause, and every cross-chain contract carries a guardian-or-owner `pause()`. Unpause is deliberately asymmetric — owner/Timelock only — so a compromised or mistaken fast-pauser cannot undo a freeze without the review delay.

## 3. Architecture

### 3.1 Diamond Pattern (EIP-2535)

The protocol's on-chain core is a single EIP-2535 Diamond, `VaipakamDiamond`. Every external call lands in its `fallback`, which looks up the facet address registered for the call's 4-byte function selector and delegatecalls it. Facets are stateless logic modules; all protocol state lives in one shared storage struct accessed by every facet through `LibVaipakam` at a fixed ERC-7201 namespaced slot derived from `keccak256("vaipakam.storage")`. Cross-facet calls are made through the Diamond's own address, so they re-enter the fallback and route to the owning facet like any external call.

`DiamondCutFacet` is the sole entry point for adding, replacing, or removing facet functions, and `DiamondLoupeFacet` provides the standard introspection surface (which facets exist, which selectors each owns). Diamond ownership — and with it cut authority — follows ERC-173 via `OwnershipFacet` and is held by the governance Timelock after handover, so upgrades are delayed, reviewable actions.

The pattern is load-bearing rather than stylistic. The EVM's 24,576-byte runtime bytecode limit (EIP-170) makes a monolithic contract of this scope undeployable; the Diamond splits the surface into facets that are individually within the limit while preserving one address and one storage domain. It also makes upgrades modular: a fix replaces one facet's selectors under governance control instead of migrating state, and deploy-time guardrails verify that every compiled public function is routed, no selectors collide, and every facet is within the size limit before any broadcast.

### 3.2 Facet Layout

The Diamond currently cuts a substantially larger facet set than the original core. Grouped by domain:

| Domain | Facet | Role |
| --- | --- | --- |
| Diamond infrastructure | `DiamondCutFacet` / `DiamondLoupeFacet` / `OwnershipFacet` | EIP-2535 upgrade, introspection, and ERC-173 ownership surfaces |
| | `AccessControlFacet` | Role-based access control, atomic admin handover |
| | `AdminFacet` | Treasury address, swap-adapter registry, pause controls, protocol configuration |
| | `ConfigFacet` | Governance-tunable parameters and compile-time constant reads (fees, tiers, grace buckets, thresholds) |
| | `NumeraireConfigFacet` | Active numeraire / PAD and periodic-interest configuration |
| | `OracleAdminFacet` | Oracle configuration setters (feeds, overrides, cross-checks, secondary quorum) |
| | `LegalFacet` | On-chain Terms-of-Service acceptance records |
| | `ProfileFacet` | Per-user profile records |
| Offers | `OfferCreateFacet` / `OfferAcceptFacet` / `OfferCancelFacet` | Create, accept, and cancel lending and borrowing offers |
| | `OfferMutateFacet` | In-place offer edits without cancel-and-repost |
| | `OfferMatchFacet` | Permissionless range-order matching with bot-facing previews |
| | `OfferPreviewFacet` | Read-only accept-preview surface |
| | `OfferParallelSaleFacet` | Borrow-or-sell parallel marketplace sale of NFT collateral offers |
| | `SignedOfferFacet` | Gasless EIP-712 signed off-chain offers, materialized on fill |
| | `LenderIntentFacet` / `IntentConfigFacet` / `IntentDispatchFacet` | Standing lender intents (auto-lend), their configuration, and dispatch |
| Loan lifecycle | `LoanFacet` | Loan initiation and read-side queries; Health Factor and LTV admission checks |
| | `RepayFacet` / `RepayPeriodicFacet` | Full/partial repayment, late fees, periodic-interest settlement, NFT rental daily deduction |
| | `AddCollateralFacet` / `PartialWithdrawalFacet` | Collateral top-up; excess-collateral withdrawal under health constraints |
| | `PrecloseFacet` | Borrower early closure: direct preclose, obligation transfer, offset |
| | `RefinanceFacet` | Borrower switch to a new lender with original-lender protection |
| | `EarlyWithdrawalFacet` | Lender exit by selling the live position to a new lender |
| | `SwapToRepayFacet` / `SwapToRepayIntentFacet` | Atomic collateral-to-principal swap-and-repay, direct and intent-based |
| | `ClaimFacet` | Pull-based claim distribution for terminal loans |
| | `ConsolidationFacet` | Position consolidation to the current NFT holder |
| | `AutoLifecycleFacet` | Consent and caps for auto-lend / auto-refinance / auto-extend |
| Risk and default | `RiskFacet` | Risk parameters, LTV/Health-Factor math, HF-based liquidation |
| | `RiskSplitLiquidationFacet` / `RiskMatchLiquidationFacet` | Split-route liquidation; internal opposing-loan match liquidation |
| | `RiskAccessFacet` | Self-sovereign progressive risk-access tiers and consents |
| | `DefaultedFacet` | Time-based default after grace expiry |
| | `OracleFacet` | Chainlink-led pricing, liquidity classification, depth tiers |
| | `BackstopFacet` | Treasury backstop (counterparty of last resort), default-off |
| NFT prepay marketplace | `PrepayListingFacet` / `NFTPrepayListingFacet` / `NFTPrepayListingAtomicFacet` / `NFTPrepayDutchListingFacet` / `NFTPrepayAutoListFacet` | Pre-default marketplace sale of NFT collateral: listing, atomic match, Dutch decay, permissionless floor auto-list at grace |
| Vaults and positions | `VaultFactoryFacet` | Per-user vault proxy deployment, deposits/withdrawals, upgrades |
| | `VaipakamNFTFacet` | Mint/update/burn of position NFTs with on-chain metadata |
| | `EncumbranceMutateFacet` | Cross-facet entry for the vault encumbrance sub-ledger |
| | `ReceiverFacet` | ERC-721/1155 `onReceived` hooks for the Diamond |
| Treasury and tokenomics | `TreasuryFacet` | Fee accumulation and treasury claims |
| | `VPFITokenFacet` | VPFI token registration on the Diamond |
| | `VPFIDiscountFacet` / `VPFIDiscountAccumulatorFacet` | Fee-discount mechanics; time-weighted tier accumulator |
| | `InteractionRewardsFacet` | Platform-interaction reward claims |
| | `RewardReporterFacet` / `RewardAggregatorFacet` / `RewardRemittanceFacet` / `MirrorTierReceiverFacet` | Cross-chain reward accounting: per-chain reporting, Base-side aggregation, budget remittance, mirror tier-cache receipt |
| | `ProtocolBroadcastFacet` | Protocol-funded cross-chain broadcast budget |
| | `PayrollFacet` | Contributor salary streams |
| | `AggregatorAdapterFactoryFacet` | Per-aggregator swap-adapter provisioning and versioning |
| Analytics | `MetricsFacet` / `MetricsDashboardFacet` | Public protocol-wide analytics reads; bundled per-user dashboard reads |

### 3.3 Vaipakam Vaults

Each user's assets live in their own vault: an `ERC1967Proxy` deployed per user by `VaultFactoryFacet`, all pointing at one shared UUPS implementation, `VaipakamVaultImplementation`, which is owned by the Diamond. The vault holds the user's ERC-20 balances, pledged collateral, rental NFTs, and vaulted VPFI in full isolation from every other user. For rentals, the vault is also the protocol's stable ERC-4907-style wrapper: the rented NFT stays inside the owner's vault for the entire rental period while the vault assigns, revokes, or reassigns only temporary user rights, and third-party integrations query the vault for current user, expiry, and rented quantity.

The vault is the protocol's accounting boundary. For every user/token pair the protocol maintains a tracked-balance mirror (`protocolTrackedVaultBalance`) that increases only through the designated deposit paths, so unsolicited direct transfers into a vault can raise the raw token balance but never the balance the protocol trusts; balance display and utility decisions use the clamp `min(raw balance, tracked balance)`. On top of the tracked balance sits the encumbrance sub-ledger (`LibEncumbrance`): per-loan collateral liens created at loan initiation and offer-principal locks created at offer creation share one storage shape and one aggregate per user/asset/token-id. The withdraw guard in `VaultFactoryFacet` consults only the aggregate — it asks "is this amount free?" — so pledged collateral and escrowed offer principal can never leave through a side door while they back a live commitment, and the user-visible balance decomposes into Total, Locked, and Free. An attempted over-release surfaces loudly as a typed underflow error rather than saturating silently.

Upgrade authority over the shared implementation rests with the Diamond owner (the governance Timelock after handover). Upgrades are not pushed to existing vault proxies — that would impose network fees on every user; instead, when an implementation version is marked mandatory, the protocol blocks protected interactions through outdated vaults until the user submits their own vault-upgrade transaction. Non-critical upgrades are prompted, not enforced.

### 3.4 Position NFTs

`VaipakamNFTFacet` implements the position-NFT collection (`Vaipakam NFT`, symbol `VAIPAK`) as an ERC-721 with enumerable and metadata extensions, using diamond-safe namespaced storage (`LibERC721`) rather than inherited implementation storage. A lender-side NFT and a borrower-side NFT are minted when offers are created and track the position through its whole life: authorized facets update the status (created, matched, active, repaid, defaulted, liquidated, closed, fallback-pending) as protocol state changes.

Metadata is generated on-chain: `tokenURI()` returns a JSON document with the position's role, status, linked offer and loan IDs, assets, amounts, rate, duration, and whether the token currently governs claim rights, using realized live-state values rather than stale offer minima. Status- and side-keyed images (hosted on IPFS) let external marketplaces distinguish active from terminal positions rather than collapsing them into one generic state.

Claim rights follow the token, not the originating wallet: claims and role-gated strategic actions are authorized against the current `ownerOf` of the relevant side's NFT, so a transferred position carries its economic rights with it, and interfaces resolve visibility and permitted actions from the NFT holder. Transferability has deliberate limits. Keeper approvals never substitute for NFT ownership — a delegated keeper can initiate flows but never claim or receive funds. A lender position that is listed for sale is locked for the life of the listing, and settlement identity is consolidated to the current NFT holder at listing time so seller, payee, and proceeds vault are the same address. A loan's own current borrower cannot buy its lender position (that would make one party owe itself). If Vaipakam position NFTs later support ERC-4907-style `userOf`, that address would be only a temporary keeper-scoped operational delegate: `ownerOf` remains the economic owner, and claim rights never move to `userOf`.

### 3.5 Storage and Constants

All facets read and write one storage struct through `LibVaipakam` at a fixed ERC-7201 namespaced slot, derived from `keccak256("vaipakam.storage")` with the standard `-1` and low-byte-mask hardening against collisions with Solidity's default layout. Facet-local state that must not share that struct (for example the ERC-721 position-NFT state) lives in its own namespaced library storage. No facet declares contract-level storage variables, so facet upgrades can never shift the shared layout.

Two conventions run through all protocol math: rates, fees, and ratios are expressed in basis points (1/10,000, `BASIS_POINTS = 10000`), and Health Factor and value quantities are scaled to 1e18 (`HF_SCALE`).

Compile-time constants (fixed until a facet upgrade) include: `HF_LIQUIDATION_THRESHOLD` = 1e18 (liquidation triggers below HF 1.0); `TREASURY_FEE_BPS` = 100 (the 1% yield fee on interest); `RENTAL_BUFFER_BPS` = 500 (the 5% NFT-rental prepayment buffer); `VOLATILITY_LTV_THRESHOLD_BPS` = 11000 (the 110% LTV collapse threshold); `MAX_LIQUIDATION_SLIPPAGE_BPS` = 600 and `MAX_SWAP_TO_REPAY_SLIPPAGE_BPS` = 300 (slippage ceilings for liquidation swaps and borrower swap-to-repay); `LIQUIDATION_HANDLING_FEE_BPS` = 200; `MAX_LIQUIDATOR_INCENTIVE_BPS` = 300; and a 1-day minimum grace period floor.

Governance-tunable parameters are runtime storage values constrained by compile-time bounds. The loan-admission Health Factor floor defaults to `MIN_HEALTH_FACTOR` = 1.5e18 but is retunable within a hard band of [1.2e18, 2.0e18]; a retune applies only to future admissions, never to the liquidation trigger or to open loans. The same bounded-knob discipline covers liquidity-check slippage budgets, TWAP consistency windows, depth-tier probe sizes and per-tier LTV boxes (defaults 50%/60%/65% initial LTV for tiers 1–3, ceiling-capped at 80%), grace-bucket schedules, matcher fee share, oracle staleness and deviation bounds, and treasury-conversion thresholds. Every numeric setter validates against explicit minimum/maximum ranges and reverts through the shared typed `ParameterOutOfRange` error, so a misconfiguration is visible and auditable rather than silently accepted.

### 3.6 Rounding Doctrine

The protocol has an explicit, documented rounding convention (stated in the `LibVaipakam` storage library header; the functional specs govern dust handling at the flow level). All financial math uses integer division truncating toward zero, and for each formula the direction is chosen so that every wei of discrepancy favors a safe party. Any new division on a money path must document its direction, who it favors, and why that is safe; ceiling division is reserved for cases where rounding down would be actively dangerous (currently none).

The per-formula assignments are:

- **LTV** rounds down — under-reported by at most 1 BPS in the borrower's favor; the absolute error is sub-dust.
- **Health Factor** rounds down — slightly under-reported in the protocol's favor, so liquidation may trigger marginally earlier, never later.
- **Simple interest accrual** rounds down — the borrower is favored by at most 1 wei, the standard simple-interest convention.
- **Per-user daily reward splits** round down — the sum of shares never exceeds the daily half-pool, and the retained dust acts as an over-emission guard.
- **Liquidation bonus** rounds down — under-paid by at most 1 wei, in the treasury's favor.
- **Oracle value conversion** performs two sequential divides (feed decimals, then token decimals); the error stays sub-dust because values are 1e18-scaled.

Above wei-level rounding, the specs define flow-level dust rules with the same protective intent. Unsolicited dust transferred directly into a vault is excluded by the tracked-balance clamp and hidden from balance and utility reads. A range offer whose remaining capacity falls below its minimum fill is dust-closed rather than left as an unfillable stub, and standing-intent fills enforce minimum-slice and no-dust-remainder constraints. Partial liquidation applies a governance-configurable dust floor (off by default): a pre-existing dust position is not blocked from clearing, judged on its size before the slice so a keeper cannot manufacture a tiny leftover, while a routine partial may not carve a fresh dust residual out of a non-dust loan — it must use full liquidation so no un-liquidatable scrap is stranded active.

## 4. Asset Classification and Liquidity

Every asset that touches a Vaipakam loan is classified as **Liquid** or **Illiquid**, and the classification decides which risk machinery applies to it. Liquid assets participate in oracle-priced LTV and Health Factor mathematics and can be sold on-chain at liquidation. Illiquid assets are carried at a platform-assessed value of zero, are excluded from all valuation math, and resolve on default by in-kind transfer under explicit, informed consent from both parties. The classification is made per network, recorded per loan, and never subject to manual override.

### 4.1 Liquid vs. Illiquid — the Classification Test

An ERC-20 token is classified Liquid on a given network only when it passes **both** halves of a two-part test:

1. **A usable on-chain price path.** The asset must be priceable through the protocol's Chainlink-led oracle path on the active network — preferably through the configured PAD/numeraire path, with governance-vetted direct `asset/<numeraire>` feed overrides where explicitly configured. Where no direct feed exists, the protocol derives the price as `asset/ETH × ETH/<numeraire>`.
2. **A passing slippage-at-floor depth check.** Selling the governance-configured floor size — default `$5,000` in PAD terms (`floorSizePad`) — through the best configured route must execute no more than the configured slippage budget (default `2%`, bounded between `0.25%` and `10%`) below the trusted Chainlink-led spot price. The route search spans configured `asset/WETH`, `asset/USDC`, and `asset/USDT` pools across supported v3-style concentrated-liquidity factories (eligible fee tiers up to `0.3%`; a pool existing only at a deliberately excluded high-fee tier such as `1%` cannot qualify an asset by itself) and supported V2-fork factories. Depth is measured as executable size at bounded slippage, not as depth-at-current-tick, so a pool concentrated only at spot that cannot absorb a real floor-sized sell does not qualify.

Two anti-manipulation guards gate the depth check: the candidate pool's spot price must agree with the Chainlink-led oracle path, and where the pool exposes usable price history, its recent average must agree with the current pool price within a bounded governance band (default `3%` over a 30-minute window).

Everything else is Illiquid:

- **All ERC-721 and ERC-1155 NFTs** are always Illiquid for valuation and LTV purposes. The platform performs no NFT valuation; NFT collateral is assigned a value of zero, and the decision to lend against it rests entirely with the parties.
- **ERC-20 tokens that fail either half of the test** on the active network are Illiquid on that network.

**What the classification changes.** A Liquid asset participates fully in the risk framework: oracle pricing feeds LTV and Health Factor checks at loan admission and throughout the loan, and its collateral can be sold through the configured swap-adapter routes at liquidation. An Illiquid asset is valued at `$0`, contributes nothing to LTV or Health Factor, and on default resolves by transferring the entire collateral to the lender in-kind (section 4.3).

**The active network is the whole universe.** Liquidity is evaluated exclusively from the active network's own oracle and pool availability. Ethereum mainnet is never consulted as a reference or fallback for another network's classification: an asset that is deeply liquid on mainnet but thin on the network where the loan lives is Illiquid for that loan, and the protocol performs no second-pass mainnet verification to override that result. All legs of a loan — principal, collateral, and repayment — live on a single network in Phase 1.

**On-chain precedence and per-loan storage.** The interface performs a first-pass assessment, but when an offer involving an ERC-20 leg is created or accepted, the smart contract re-runs the classification on-chain, and the on-chain result overrides any frontend assessment. The final liquidity status of both the lending asset and the collateral asset is stored explicitly in the loan's on-chain record, so the loan's default-path semantics are fixed and auditable for its whole life.

### 4.2 Liquidity Depth Tiers

Above the binary Liquid/Illiquid gate, the oracle/risk surface exposes an **on-chain liquidity tier** for ERC-20 collateral: tier `0` means illiquid or untierable, and tiers `1` through `3` represent progressively deeper markets. Tier resolution reuses the same slippage machinery as the baseline gate at larger probe sizes:

| Probe | Default size (PAD) | Result when cleared |
| --- | --- | --- |
| Floor | `$5,000` | Liquid (baseline gate) |
| Tier 1 | `$50,000` | Tier 1 |
| Tier 2 | `$500,000` | Tier 2 |
| Tier 3 | `$5,000,000` | Tier 3 |

Every probe size is governance-configurable within bounded ranges (no probe below `1,000` PAD). Tier resolution searches the governance-configured quote assets — WETH and deep stablecoins for the active chain — across configured low-fee v3-style and V2-fork pools, and both anti-manipulation guards from section 4.1 (oracle-agreement and price-history agreement) gate tier resolution exactly as they gate the baseline classification.

**Effective tier.** The tier a loan actually uses is `min(onChainTier, keeperConfidenceTier)`. New assets default to keeper confidence tier `1`. A keeper can lower an asset's confidence tier immediately, but can promote it only up to the on-chain-measured tier, and only after off-chain aggregator checks have remained healthy — the keeper role can never raise an asset above what the on-chain route and manipulation guards validate. There is deliberately **no governance per-asset allowlist** that upgrades collateral into a higher tier: governance retains only remove-only safety levers (asset pause, blacklist, master-switch disable); tier authority comes from measurement.

**What tiers gate:**

- **Depth-tiered initiation LTV** (master switch, off by default). When enabled, new ERC-20 loans are capped at the smaller of the existing asset ceiling and the effective tier's current max-init-LTV. Governance-configured per-tier caps default to `50%`, `60%`, and `65%` for tiers 1–3; a permissionless refresh (`OracleFacet.refreshTierLtvCache()`) can derive data-driven values from peer lending-protocol configurations, valid for 14 days and bounded by per-tier constitutional safety boxes (Tier 1 `[37%, 55%]`, Tier 2 `[55%, 69%]`, Tier 3 `[69%, 82%]`; Tier 3 carries a default 5-percentage-point haircut). Out-of-box candidates are rejected, never clipped. Tier `0` collateral cannot support a new borrow. In this regime the loan-initiation Health Factor floor relaxes to `1.0`, because the tier ceiling becomes the binding buffer above liquidation; while the switch is disabled, admission follows the standard conservative behavior exactly (section 5.5).
- **Per-tier liquidation thresholds.** Liquidation thresholds are tier-specific rather than per-asset, with deeper tiers receiving higher thresholds, governance tuning bounded, and cross-tier ordering preserved. The threshold applied to a loan is snapshotted from the collateral's effective tier at initiation, so later tier degradation never retroactively changes an open loan's liquidation gate.
- **Per-tier liquidation discounts.** The optional liquidator-buys-at-discount path prices collateral at a tier-specific discount (defaults `7.7%` / `6.0%` / `5.0%` for tiers 1–3, each bounded by a safety box, monotonic across tiers).
- **Risk-premium pricing input.** When the optional rate model is registered, its collateral-risk premium is keyed on the collateral's liquidity tier — thinner liquidity prices higher.
- **Progressive risk access.** Where the (default-off) progressive risk-access gate is enabled, an asset's band is derived entirely from the protocol's own on-chain liquidity-depth assessment — an asset counts as blue-chip when it is part of the numeraire basket or independently reaches the deepest tier, a merely-Liquid asset is mid-band, and an unpriced or Illiquid asset is the riskiest band — never from an administrator-curated list of permitted assets.

Tier measurements also feed monitoring: the tier a loan's liquidation gate uses is snapshotted at initiation, so live tier reads inform new admissions and keeper confidence while open loans keep the terms they were admitted under.

### 4.3 Illiquid Treatment

Illiquid assets are handled by a deliberately simple, consent-first regime:

- **Zero valuation, no Health Factor math.** An Illiquid asset contributes `$0` to every LTV and Health Factor computation. A loan whose collateral is Illiquid has no meaningful LTV, so price-based liquidation does not apply to it; the only default trigger is time-based (non-repayment past the grace period).
- **Explicit dual consent.** Both parties must acknowledge the illiquid terms through the single mandatory risk-and-terms consent (section 5.4) before the offer can be created or accepted, and the acceptance confirmation must name each specific illiquid asset in the exact offer being accepted — a worthless asset can never hide behind a blanket consent.
- **In-kind transfer on default.** On default, the **entire** illiquid ERC-20 collateral is allocated to the lender. There is no auction, no DEX sale, and no LTV-proportional split; recovery may be materially less than the value lent, and the parties consented to exactly that. The transfer is realized through the standard position-NFT claim model rather than an automatic push: the holder of the lender-side position NFT claims the collateral (section 6.5).
- **NFT rentals.** A rented NFT never leaves vault custody, so it needs no liquidation path of its own: on rental default the borrower forfeits the ERC-20 prepayment — the rental-fee portion (net of the treasury share) goes to the lender, the 5% buffer goes to treasury — and the vaulted NFT returns to the lender through the settlement flow.

### 4.4 Same-Asset Guard and Fail-Closed Behavior

**Same-asset guard.** At offer creation, the lending asset and the collateral asset must not be the same asset. A loan collateralized by its own principal asset secures nothing — the invariant is enforced directly on-chain rather than through reference-asset workarounds, and it extends through the lifecycle flows: preclose, transfer, offset, and refinance paths must preserve the original loan's asset types, and standing lending intents reject self-collateralized pairs at registration.

**Fail-closed posture.** Whenever the machinery that supports a Liquid classification is unavailable, the protocol degrades toward the safest interpretation rather than guessing:

- If frontend-side assistance is unavailable, or the on-chain checks face temporary issues reaching the necessary validation data (oracle or pool lookups), the asset defaults to **Illiquid**. Full-collateral in-kind default terms then apply, and the user must consent to them. No manual override can classify an asset as Liquid when the checks fail or say otherwise.
- The pricing path itself is fail-closed. Chainlink is primary; where configured, secondary sources (Tellor, API3, DIA) apply a soft 2-of-N rule — if at least one available secondary agrees with Chainlink within the deviation bound, the price stands; if secondaries are available and none agree, pricing **reverts** for that asset. An optional per-chain Pyth feed cross-checks the Chainlink ETH/quote path: unset or unusable it soft-skips, but a configured feed diverging beyond its bounded threshold makes pricing revert with a typed cross-check-divergence error.
- At liquidation time the same posture holds: if a fair-value collateral split cannot be priced because a fresh oracle quorum is unavailable, the fallback settles through the full-collateral-to-lender branch (the same branch Illiquid collateral uses) rather than leaving the loan pinned open, and emits dedicated telemetry (section 6.5 and the liquidation chapter cover the fallback lifecycle in full).

## 5. The Offer Book

Vaipakam's market is a fully on-chain peer-to-peer order book. There is no pooled liquidity and no protocol-set interest curve: lenders and borrowers post offers at the terms they will accept, and the market rate emerges from the book. Every offer is backed by real escrowed assets in the creator's own isolated vault, represented by a position NFT, and governed by the same risk checks whether it is filled by a direct counterparty, a permissionless matcher, or a gasless signed fill.

### 5.1 Offer Creation

Offers come in two roles and two product legs:

- **Lender offers (ERC-20).** The lender specifies the lending asset and amount, the interest rate (expressed in basis points), the required collateral asset and amount — or a maximum LTV / minimum Health Factor requirement when the collateral is Liquid — and the loan duration. The lending principal is deposited into the lender's vault at creation.
- **Borrower offers (ERC-20).** The borrower specifies the desired asset and amount, the maximum acceptable rate, the offered collateral (type and amount), and the duration. The collateral is locked at offer submission.
- **NFT-rental offers.** An NFT owner lists an ERC-4907-compatible ERC-721/1155 NFT with a daily rental fee, the ERC-20 payment asset, and the rental duration; the NFT is deposited into the Vaipakam Vault at creation. A renter's offer locks the full prepayment — total rental fees plus a 5% buffer — in the payment ERC-20. The rented NFT never transfers to the renter; the vault assigns only temporary ERC-4907 `user` rights.

**The create-time escrow lock.** Escrowed offer assets are locked against withdrawal for as long as the offer is live. A lender cannot pull the escrowed principal — nor the unfilled remainder of a range offer — back out of their vault while the offer sits on the book, and a borrower cannot drain pledged ERC-20 collateral through any side door (including withdrawing a vault-held token balance that is simultaneously pledged as offer collateral). The lock is placed at create, drawn down slice-by-slice as a range offer is partially filled, and lifted in full on outright acceptance, cancellation, or the final dust-close. An offer's own refunds — a cancel, or a downward size edit — release their portion of the lock before the funds move, so an offer can always pay itself back; only unrelated withdrawals are refused. At acceptance, a borrower offer's collateral lock hands off in place to the resulting loan's collateral protection — the collateral never moves, it transitions from backing an open offer to backing a live loan.

**Offer shape and options.**

- **Fill mode.** Every offer carries a `fillMode` chosen at creation and immutable thereafter: `Partial` (the default — matchable at any size within its range, remainder stays on the book), `Aon` (all-or-nothing — exactly one full-size fill, requiring equal amount bounds at creation), or `Ioc` (partial-fillable only within a required expiry window, after which the remainder lapses). Changing fill mode mid-life would alter the economic contract counterparties evaluated, so the field cannot be edited.
- **Expiry.** Offers are good-till-cancelled by default. An optional `expiresAt` deadline (strictly future, at most one year out, immutable) makes the offer good-till-time: at and after the deadline it can no longer be accepted or matched, and anyone may clean it up via the same `cancelOffer` entry point — the cleaner pays gas, and the refund always flows back to the original creator, never to the cleaner. A no-deadline offer remains cancellable only by its creator.
- **In-place modification.** A creator may edit an unaccepted offer without taking it off the book — principal range, rate range, or collateral range, individually via `setOfferAmount` / `setOfferRate` / `setOfferCollateral` or atomically via `modifyOffer`. The post-modification offer must satisfy the same invariants creation enforces, vault balances and the escrow lock move in lock-step with each delta, the new ceiling can never drop below what live fills have already committed, and no Loan Initiation Fee is charged on a modify. Already-accepted offers are terminal and cannot be modified.

**Rates are human-set.** The interest rate on a manually-created offer is the rate its creator chooses, and it is binding: the protocol neither transforms nor overrides it, and Vaipakam's market rate emerges from this human-driven order book rather than from a protocol-imposed algorithmic curve. An optional governance-registered rate model may exist purely as a pricing aid — a non-binding suggestion in the app, and an anchor for automated offer creation where a user has opted into having their liquidity priced for them, clamped to a market-relative band so an automated offer never posts far off the prevailing market. With no model registered (the default), nothing changes, and a model never re-prices a matched or live loan: the rate is fixed at initiation for the life of the position.

**Position NFTs.** Creating an offer mints a Vaipakam position NFT (collection `Vaipakam NFT`, symbol `VAIPAK`) to the creator, recording role (Lender/Borrower), terms, and status (`OfferCreated`) in on-chain metadata that updates as the position progresses. The metadata follows standards-aligned JSON so third-party wallets and marketplaces can render role, status, linked offer/loan ids, assets, amounts, rates, and whether the token currently governs claim rights, without Vaipakam-specific parsing. These NFTs are not mere receipts: after loan initiation, claim rights follow their current owner (section 6.5).

**Two worked shapes.** A lender posting 1,000 USDC at 5% for 30 days against ETH collateral has the 1,000 USDC locked from her wallet into her vault at create, and receives a Lender position NFT at `OfferCreated`. A renter offering up to 15 USDC/day for a 7-day rental locks `7 × 15 × 1.05 = 110.25` USDC of prepayment (fees plus the 5% buffer) at create, and receives a Borrower position NFT.

### 5.2 Range Orders and Partial Fills

Range Orders let both sides express intent as canonical limit orders while keeping one-input-per-role ergonomics. A lender enters the maximum principal they will lend, the minimum rate they will accept, and the collateral they require; a borrower enters the minimum principal they need, the maximum rate they will pay, and the collateral they will lock. Each offer carries explicit positive lower and upper principal bounds (single-value offers use equal bounds), and borrower collateral ranges are likewise explicit. A lender range offer must escrow enough for its upper bound and satisfy the Health Factor floor at the worst-case fill; a borrower range offer may not request more principal than its posted collateral supports under the same risk math.

**Matching.** `matchOffers` is a permissionless matching engine, enabled behind a governance-staged master switch. Like liquidation, it is open to any caller because the caller has no discretion: it can only execute a match permitted by two live offers and the protocol's deterministic rules — asset continuity, **exact duration matching** (durations match as exact values; the standard creation buckets of 7/14/30/60/90/180/365 days exist to improve match density, not to introduce duration ranges), range overlap, midpoint rate computation, and a synthetic Health Factor check. The matcher earns a configured share of the Loan Initiation Fee flow (`lifMatcherFeeBps`, default 1%), read live from protocol configuration. A read-only match preview lets bots filter candidate pairs before spending gas, enforcing the same asset-continuity, duration, range-overlap, and synthetic Health Factor rules the live match enforces.

**Governance staging.** Matching ships behind its own master enable flag, independent of the offer book itself: offers can be created, accepted directly, and cancelled while matching is disabled, and `matchOffers` becomes permissionless only once governance enables the switch. The matcher fee share is likewise a live governance knob rather than a constant, so interfaces and bots read it from the protocol configuration bundle instead of assuming the default.

**Partial-fill semantics.** Both sides may fill across multiple matches. The protocol tracks filled principal per side (and filled collateral for borrower offers), keeps offer storage alive for already-created loans, and closes an offer only when remaining capacity falls below its minimum fill. Each match creates its own independent loan with its own lifecycle and claim accounting. Direct acceptance of a ranged offer is single-fill and role-aware: accepting a lender's ranged offer delivers the lender's upper amount at the lender's floor rate; accepting a borrower's ranged offer funds the borrower's lower amount at the borrower's ceiling rate, with any borrower collateral above the accepted floor returned rather than stranded. When partial-fill matching is enabled, zero-fill cancellations are briefly delayed after creation to blunt cancel-front-running, and cancellation of a partially-filled offer refunds only capacity not backing live loans.

### 5.3 Signed (Gasless) Offers

An offer may also be created without a transaction: the creator signs the binding offer terms once with an EIP-712 signature (ERC-1271 smart-contract wallets supported). The signed offer lives off-chain in the order book until a counterparty fills it; at fill it is materialized into an ordinary on-chain offer and accepted in the same transaction, so the resulting loan and every downstream rule — position NFTs, claims, liquidity classification, Health Factor gates — behave identically to an on-chain offer. The act of signing is the creator's risk-and-terms consent.

- **Vault-backed or wallet-backed stake.** The signer's stake comes either from free balance already in their own Vaipakam vault (checked and locked, nothing pulled) or from their wallet via a single Permit2 signature that authorizes the transfer and binds the offer terms together. Wallet-sourced signed offers are all-or-nothing. No funds are ever pooled; the stake stays in the signer's isolated vault until the fill instant.
- **On-chain remainder tracking.** A vault-backed signed offer may be partially filled across several keeper matches over time. The unfilled remainder is tracked **on-chain against the offer's order hash** — the same authoritative ledger that replay-protects the offer — so over-filling is prevented on-chain and each fill can never execute twice; off-chain order books only mirror the remainder for display. An all-or-nothing signed offer must be consumed in a single full match.
- **Cancellation.** The signer can cancel a specific signed offer on-chain, or batch-cancel every offer carrying a given nonce — the secure complement to a free off-chain delete.
- **Same safety checks.** Every signed match runs through the same matching engine — and therefore the same collateral and Health Factor safety checks — as an on-chain match. An under-collateralized signed match reverts rather than creating a bad loan. A keeper matching a signed offer against an on-chain counterpart earns the same matcher share as the on-chain matcher.

### 5.4 Mandatory Risk Consent

Before any offer is created or accepted, the party must give **one combined, mandatory Risk Disclosures and Vaipakam Terms acknowledgement** — a single required consent, not a stack of optional checkboxes. The disclosure states, in substance:

- if liquidation cannot execute safely, the lender may receive collateral in-kind instead of the lending asset;
- if oracle pricing is unavailable or either loan asset is Illiquid, the lender may receive **all** collateral regardless of market value;
- recovery may be materially less than the amount lent; and
- proceeding records a binding agreement for the life of the position.

For interest-bearing ERC-20 loans the disclosure also states the borrower's interest commitment accurately to the offer's interest mode — full-term (interest owed for the entire agreed term even on early repayment, adjusted where partial repayment is permitted) or pro-rata where the offer opted in; NFT-rental offers settle prepaid rental fees rather than interest on principal, so that line is omitted on rental flows. The transaction cannot proceed without the consent, and the consent is recorded on-chain for the offer and the resulting loan; a single combined accepted-by-both-parties consent state is stored, since neither side can proceed without agreeing. If a disclosure-driving field (interest mode, partial-repay flag, or asset type) changes on the create form after acknowledgement, the consent is cleared and re-confirmed against the updated text.

Acceptance additionally binds the acceptor to the **exact economic terms** of the offer, not an opaque offer reference plus a flag: the acceptor cryptographically confirms a typed, wallet-rendered statement of the terms — assets, role-correct amount and rate, duration, token ids and quantities, fee and repayment flags, and the consent — and the contract verifies, before any value moves, that the confirmed terms equal the stored offer. Any divergence refuses the acceptance, and any leg classified Illiquid on-chain must be named specifically in the confirmation. This is not a second consent; it is an anti-phishing binding of the one consent to the terms the user actually saw, so a cloned interface cannot substitute terms. The keeper matching path, which pairs two already-authored offers with no acceptor to phish, is exempt from the acceptance confirmation.

### 5.5 Offer Acceptance and Loan Initiation

A loan begins when a borrower accepts a lender's offer or a lender accepts a borrower's offer (the acceptor pays gas), or when the matching engine pairs two compatible offers. Before any state is committed, admission checks run:

- **Health Factor and LTV admission.** For Liquid collateral, the loan must clear the risk-adjusted Health Factor floor — HF = (collateral value × the collateral asset's liquidation threshold) / borrowed value — where the standard initiation floor is governance-tunable within `[1.2, 2.0]` and defaults to `1.5`. The liquidation threshold discounts the collateral to the fraction of its value the protocol trusts at liquidation, so the floor already prices in the collateral's risk profile: at a typical ~82% threshold, a $1,000 borrow needs roughly $1,830 of collateral to reach HF 1.5, where a raw 150% collateral ratio would fall short once the threshold is applied. When the optional depth-tiered LTV regime is enabled, the floor relaxes to `1.0` with the effective tier's max-init-LTV cap as the binding constraint (section 4.2). The floor applies at admission; the liquidation trigger is HF `< 1.0` and is never moved by an admission-floor retune, and a retune applies only to loans admitted after the change — open loans keep the terms they were admitted under.
- **On-chain liquidity verification** of both legs, with on-chain precedence and per-loan storage of the result (section 4.1).
- **Self-trade prevention.** No single address may end up as both lender and borrower on the same new loan — neither by directly accepting its own offer nor by a third-party matcher pairing two offers posted by the same wallet. The rejection names the colliding address, and previews surface it before a transaction is submitted.

On success, the contract locks the borrower's collateral (or confirms the rental prepayment), records all loan terms on-chain, updates the creator's position NFT to `LoanInitiated`, and mints a matching position NFT for the acceptor.

**Loan Initiation Fee.** At ERC-20 loan initiation, a Loan Initiation Fee of `{liveValue:loanInitiationFeeBps}`% of the lending-asset amount is charged to the borrower: the fee is deducted from the principal and routed to treasury before net proceeds are delivered, so a matched amount of 1,000 units delivers the net remainder to the borrower. The fee applies to loan initiation only — never to offer creation, modification, or cancellation — and the rate a loan pays is snapshotted at origination, so a later governance retune never changes an open loan's economics. A borrower may instead pay the full fee equivalent in VPFI up front, receiving 100% of the principal; that VPFI is held in protocol custody until settlement and may produce a rebate on proper close — the custody, forfeiture, and rebate mechanics are specified in the tokenomics section. When the loan is initiated by the permissionless matcher, the matcher's configured share is paid from the treasury-directed fee flow.

Before signing, a read-only acceptance preview exposes the resolved principal, rate, collateral requirement, fee treatment, any collateral refund, and — when acceptance is currently blocked — the exact blocker, while keeping projected economics visible so the user understands what needs to change.

## 6. Loan Lifecycle

### 6.1 Loan Terms

A Vaipakam loan is defined at initiation by its principal (asset and amount), collateral (asset, amount, and stored liquidity status), interest rate in basis points, duration in days, interest mode, and the fee rates snapshotted at origination. An NFT rental is the same lifecycle with a different economic leg: a daily rental rate and a locked prepayment (total fees plus the 5% buffer) in place of an APR on principal, with the rented NFT held in vault custody throughout.

- **Duration.** The launch product range is **1 to 365 days**, with the live maximum exposed through protocol configuration. The primary create flow presents standard buckets — 7, 14, 30, 60, 90, 180, and 365 days — because Range Orders match duration as an exact value, so bucketing improves match density without duration-range semantics; specialized flows (refinance, preclose) keep free-form entry. The 365-day product maximum is a product default, not a protocol invariant: the on-chain governance ceiling for the configurable maximum is approximately **4,385 days**, so longer-tenor products can be enabled later without a contract change. Both the interface and the on-chain initiation path enforce the live configured bound.
- **Interest modes.** The protocol default is **full-term interest**: the borrower commits to the interest for the entire agreed term, even if repaid early. An offer may opt into **pro-rata** interest, which accrues only for the days the loan is actually outstanding. The mode is fixed at the offer and disclosed in the mandatory consent (section 5.4).
- **Fixed maturity boundary.** Once initiated, the loan's maturity is fixed by its original start time and committed duration. Partial repayment, partial liquidation, swap-to-repay, or any other non-terminal principal reduction may re-stamp the interest-accrual basis for the remaining principal, but must never move the maturity, shorten the committed duration, change the grace-period slot, or restart the grace clock. Repeated small payments after maturity cannot roll the lender's default deadline forward — and symmetrically, no partial action can pull the borrower's default deadline earlier.
- **Origination-snapshotted fees.** Both fee rates a loan is subject to — the lender-side yield fee and the borrower-side initiation fee — are snapshotted onto the loan at creation. A later governance retune applies only to loans created afterward; an open loan settles at the rates it was originated under.

### 6.2 Interest and Late Fees

Interest is computed as:

> Interest = Principal × AnnualRate × EffectiveDaysOutstanding / DaysPerYear

with the rate held in basis points and `DAYS_PER_YEAR = 365`. The load-bearing term is **EffectiveDaysOutstanding**:

- For a **full-term-interest** loan (the default): `EffectiveDaysOutstanding = max(actual elapsed days, agreed term in days)`. Early repayment does not reduce the interest owed below the full-term amount; where the offer also permits partial repayment, partial principal reductions lower future interest on the reduced balance while the full-term floor still applies to whatever principal remains.
- For a **pro-rata** loan: interest accrues on the actual elapsed days throughout.

**Grace-window accrual.** In both modes, once a loan runs past its agreed term into the grace window, interest keeps accruing for every additional day the principal actually remains outstanding — the borrower owes time-value interest for the extra days, not only for the agreed term.

**Worked example.** A 30-day loan of 1,000 USDC at 5% APR (full-term mode), repaid on time, owes `1000 × 5% × 30 / 365 ≈ 4.11` USDC of interest. Repaid on day 20, it owes the same 4.11 USDC — `EffectiveDaysOutstanding` floors at the 30-day term. Repaid on day 33 (inside its grace window), it owes `1000 × 5% × 33 / 365 ≈ 4.52` USDC of interest **plus** the late fee below.

**Late fees are additive.** If repayment lands after the due date — within the grace window, or forced afterward — a late fee applies **in addition to** the continued grace-window interest; it never substitutes for that interest. The schedule: 1% of the outstanding principal (or overdue rental amount, for rentals) on the first day past due, increasing by 0.5 percentage points per further day, capped at 5% in total.

**The lender yield fee.** Treasury collects `{liveValue:treasuryFeeBps}`% of the amounts earned by the lender — and the fee base includes both interest and late fees (and rental fees, on the rental leg). The fee is deducted automatically when those amounts are settled or claimed, at the rate snapshotted onto the loan at origination.

### 6.3 Grace Periods

Every loan receives a grace period after maturity, assigned from a fixed **six-slot schedule** keyed to the loan's committed duration:

| Loan duration | Default grace period |
| --- | --- |
| under 1 week | 1 hour |
| under 1 month | 1 day |
| under 3 months | 3 days |
| under 6 months | 1 week |
| under 365 days | 2 weeks |
| 365 days or more (catch-all) | 30 days |

A loan of exactly 365 days — the full standard tenor — therefore receives the 30-day grace window, not the 2-week one. This is deliberate and borrower-friendly: the longest-tenor loans keep the longest grace period, and the catch-all row also covers any longer tenors a raised live maximum may later permit.

Governance may retune each row's duration boundary and grace length within per-slot safety bounds, subject to a global floor of **1 hour** and ceiling of **90 days**, but the schedule's shape is fixed at six rows — rows can be edited, never added or removed. Clearing the configured schedule reverts to the compile-time defaults. The grace slot is derived from the loan's committed duration at initiation and, per the fixed-maturity rule, is never re-derived mid-life.

### 6.4 Repayment

**Full repayment** may be submitted by the borrower **or by any third party** willing to pay on the borrower's behalf. Payment alone never grants rights: a third-party repayer is only the payment sender — the collateral remains claimable exclusively by the current holder of the borrower-side position NFT (section 6.5). A full repayment executes atomically:

- principal plus interest (plus any late fee) is collected;
- the settlement waterfall runs — the lender's entitlement is deposited for claim, treasury takes its yield-fee share, and borrower-side custody and reward state are settled;
- the collateral is released to the borrower-side claim; and
- the loan transitions to `Repaid`.

**Partial repayment** is available when the offer opted into it:

- When periodic-interest mode is enabled for the loan, a partial allocates interest-first before reducing principal, and the preview shows the same split settlement will apply.
- A partial that reduces principal recalculates future interest only for the reduced outstanding principal and remaining committed term — never touching maturity, grace slot, or default deadlines.
- A partial must leave a strictly positive remaining principal: a payment that would retire the full balance is rejected and routed through the full-repayment path, so a loan can never sit open at zero principal with its close-out stranded.
- A per-asset minimum partial size may be configured (default disabled) and is exposed through a read-only view for pre-flighting.

**Swap-to-repay** is an atomic repayment variant for ERC-20-on-ERC-20 loans: the current borrower-position holder swaps pledged collateral into the principal asset and applies the proceeds to the same repayment waterfall in one transaction, avoiding the withdraw/swap/redeposit/repay round-trip.

- It supports a full-close mode driving the loan to `Repaid`, and a partial-reduction mode only where the offer permits partial repayment (with the same no-full-retirement guard: proceeds that would retire the full balance must route through the full-close path).
- Routing reuses the governed swap-adapter failover set rather than introducing a new venue authority; if every supplied route fails, the whole transaction reverts and the vault is untouched.
- Borrower-facing slippage is capped by a dedicated knob that defaults tighter than the liquidation cap, because the borrower chooses when to act; the cap stays bounded by the protocol-wide ceiling.
- Favorable-quote surplus goes to the current borrower-position holder, and authority follows the current borrower-side position NFT owner.

**NFT-rental servicing.** Rental fees are deducted from the renter's locked prepayment day by day via `autoDeductDaily` — a permissionless, deterministic maintenance action with no caller discretion over pricing. On timely closure, the vault revokes the renter's ERC-4907 `user` status, the 5% buffer returns to the renter, and the accumulated rental fees (net of the treasury share) become claimable by the lender-side position holder.

**Periodic interest (dormant at launch).** A feature switch (`periodicInterestEnabled`, off by default) allows long-duration and large-principal ERC-20 loans to settle interest during the loan instead of only at maturity, on a cadence of `Monthly`, `Quarterly`, `SemiAnnual`, or `Annual`. It applies only when both legs are Liquid; loans longer than 365 days must use at least `Annual` cadence when the feature is on. Each checkpoint reuses the existing six-slot grace schedule (mapped by cadence length), a read-only preview (`previewPeriodicSettle`) exposes the period accounting, and a missed checkpoint past its grace window becomes settleable by any address — selling only enough collateral to cover the shortfall, under the same incentive, handling-charge, and slippage policy as ordinary liquidation. While the switch is off, offer creation rejects non-`None` cadences and settlement entry points do not execute.

**Repayer rights, restated.** Across every repayment variant, the wallet that pays is only the payment sender. Collateral release, surplus, and every other entitlement follow the position NFTs — never the payer.

### 6.5 Settlement and Claims

Vaipakam settles by **pull, not push**. Terminal transitions compute and record each side's entitlement; the assets are then collected through `ClaimFacet` (`claimAsLender` / `claimAsBorrower`) by presenting the corresponding position NFT.

- **Claim rights follow `ownerOf`.** Every claim path authorizes the **current holder** of the relevant position NFT — not the wallet that originally opened the position. Position NFTs are transferable, so a secondary-market holder claims exactly what the original party would have; payouts are delivered directly to the current holder's wallet, with any internal vault plumbing auto-provisioned on demand. Keeper approval, rental `userOf` status, or having funded a repayment never confer claim authority.
- **Lender side:** principal plus interest (net of the yield fee) after repayment; collateral or collateral-equivalent recovery after default or a failed-liquidation fallback; rental fees on the rental leg.
- **Borrower side:** the collateral back after full repayment; the prepayment buffer after proper rental closure; any surplus remaining after a liquidation covers all obligations; and, on the VPFI fee path, the rebate paid out atomically with the normal borrower claim.
- **Fallback claims.** For a loan in the failed-liquidation fallback state, the claim surface exposes a read-only fallback snapshot — the lender, treasury, and borrower collateral slices, the principal due, and the fallback's `active` / `retryAttempted` state — so interfaces can render the exact split before the lender claims. The lender may claim immediately (there is no separate post-failure waiting window), but until that claim actually executes the borrower may still cure the position by fully repaying or by adding enough collateral to restore the required thresholds; a completed cure cancels the fallback. During the lender's claim the protocol may attempt the liquidation once more; if that retry also fails, settlement is made in collateral units — the lender's entitlement plus a 3% premium, a 2% treasury handling entitlement, and any remainder attributable to the borrower — with the lender receiving the full remaining collateral instead when its value no longer covers the entitlement.
- **Position close-out.** Once both sides have claimed, the loan reaches `Settled` and the position NFTs are updated to their terminal status and burned.

### 6.6 Lifecycle State Machine

A loan occupies exactly one of six on-chain states, and every status write passes through a single audited allow-list of transitions — an edge not in the table reverts, so no code path can silently skip a lifecycle stage.

| State | Meaning |
| --- | --- |
| `Active` | Live loan; interest accruing; all lifecycle actions available. |
| `Repaid` | Fully repaid via repayment, swap-to-repay full-close, preclose, offset, or refinance; awaiting claims. |
| `Defaulted` | Closed by liquidation or time-based default (or by a lender claim finalizing a fallback); awaiting claims. |
| `FallbackPending` | A liquidation swap failed or breached the slippage ceiling; the lender may claim a collateral-equivalent recovery, while the borrower may still cure. |
| `InternalMatched` | Fully cleared against opposing distressed positions through the internal-liquidation match path; awaiting claims. |
| `Settled` | Terminal. Both sides' claims resolved; position NFTs retired. |

Permitted transitions:

| From | To | Trigger |
| --- | --- | --- |
| `Active` | `Repaid` | Full repayment / preclose / offset / refinance |
| `Active` | `Defaulted` | Liquidation or time-based default with a successful swap |
| `Active` | `FallbackPending` | Liquidation swap failed or slippage ceiling breached |
| `Active` | `InternalMatched` | Internal-liquidation match fully clears the loan |
| `Active` | `Settled` | Atomic collateral-sale fill (marketplace settlement pays all parties in one transaction, so no separate claim step exists) |
| `FallbackPending` | `Active` | Borrower cures by adding collateral (thresholds restored) |
| `FallbackPending` | `Repaid` | Borrower cures by full repayment |
| `FallbackPending` | `Defaulted` | Lender claim finalizes the fallback |
| `FallbackPending` | `InternalMatched` | Internal-match rescue fully clears the fallback leg |
| `Repaid` / `Defaulted` / `InternalMatched` | `Settled` | Both sides' claims complete |

`Settled` is terminal — it has no outgoing edges. Two position-level outcomes deliberately do **not** appear as loan states: a lender selling their position and a borrower transferring their obligation each rewrite a side of a still-`Active` loan (the loan itself continues unchanged), while a partial internal match, partial repayment, or partial liquidation leaves the loan `Active` with reduced balances. The position NFTs carry their own richer status track (`OfferCreated`, `LoanInitiated`, `LoanRepaid`, `LoanDefaulted`, `LoanLiquidated`, `LoanFallbackPending`, `LoanClosed`) so marketplaces can distinguish outcomes — including liquidation versus time-based default — that the loan-state machine folds together.

## 7. Risk Engine

The risk engine governs how much may be borrowed against a given collateral position, when a position becomes unsafe, and which corrective actions are available before liquidation. All valuation inputs come from the oracle infrastructure described in §9; both legs of every ratio are priced in the same active numeraire, so the ratios themselves are unit-agnostic.

### 7.1 LTV and Health Factor

The engine tracks two related but distinct measures for every ERC-20 loan whose principal and collateral are both liquid.

**Loan-to-Value (LTV)** is the raw debt-to-collateral ratio, expressed in basis points (10,000 = 100%):

> LTV = (borrowed value in the active numeraire) / (collateral value in the active numeraire)

**Health Factor (HF)** is risk-adjusted: the collateral value is first multiplied by the collateral asset's liquidation threshold before being compared against the debt. It is exposed by `RiskFacet.calculateHealthFactor` and scaled to 1e18 (so 1.5e18 represents an HF of 1.5):

> HF = (collateral value × collateral asset's liquidation threshold) / (borrowed value)

The borrowed value includes accrued interest, not just principal. Intermediate rounding is downward on both steps, so HF is marginally under-reported — the error direction is protocol-favourable (liquidation can only trigger marginally earlier than the theoretical value, never later).

Worked example: at a collateral asset with an approximately 82% liquidation threshold, roughly $1,830 of collateral supports a $1,000 borrow at HF ≈ 1.5 ($1,830 × 0.82 / $1,000 ≈ 1.5). A raw 150%-of-principal pledge ($1,500) would *not* meet a 1.5 floor once the liquidation threshold is applied — HF is deliberately not the naive collateral-over-borrow ratio.

The liquidation threshold used in HF is **per liquidity tier, not per asset**, and is **snapshotted onto the loan at initiation** (`liquidationLtvBpsAtInit`). Later tier degradation of the collateral asset never retroactively changes an open loan's liquidation gate. Governance may tune the per-tier thresholds only within a hard range of 50% to 95% (the ceiling preserves a bad-debt buffer below 100% LTV) and must preserve the cross-tier ordering constraint.

Key reference points:

| Quantity | Value | Notes |
| --- | --- | --- |
| HF scale | 1e18 (`HF_SCALE`) | 1.5e18 = HF 1.5 |
| LTV scale | basis points (10,000 = 100%) | |
| Standard initiation HF floor | 1.5 default | governance-tunable in [1.2, 2.0] |
| Tiered-regime initiation HF floor | 1.0 | fixed; applies only while depth-tiered LTV is on (§7.2) |
| Liquidation trigger | HF < 1.0 (1e18 scale) | never moved by any floor retune |
| Per-tier liquidation threshold bounds | [50%, 95%] | snapshotted per loan at initiation |

The standard (non-tiered) loan-admission floor is a runtime governance knob, range-bounded to [1.2, 2.0] and defaulting to 1.5. The retune is deliberately **branch-aware**: it moves only the standard admission floor — never the tiered-regime 1.0 floor and never the HF < 1.0 liquidation trigger — so a retune can never make an already-open loan liquidatable. It also applies only to loans admitted after the change; open loans keep the terms they were admitted under.

Every floor-consuming check in the protocol reads the **same runtime value**:

- loan admission at initiation;
- the collateral-top-up cure path (§7.3);
- partial collateral withdrawal (§7.4);
- the repay and swap-to-repay guards;
- the min-collateral / max-borrow previews interfaces quote from.

This single-source rule keeps the checks mutually consistent — a position that passes one cannot be rejected by another for a stale copy of the floor, and a preview can never quote an admission the contract would refuse.

Risk math is defined only for liquid legs. If either the principal or the collateral is classified illiquid, HF and LTV computations revert (`IlliquidLoanNoRiskMath`): illiquid ERC-20s and all NFTs carry a platform-assessed value of $0, so such positions are governed by the consent-based full-collateral default rules rather than by ratio checks.

### 7.2 Depth-Tiered LTV (Optional Regime)

Depth-tiered LTV is an optional admission regime controlled by a **master switch that deploys disabled**. While the switch is off, loan initiation follows the conservative baseline exactly: the standard HF floor (default 1.5) and the per-asset LTV ceiling.

When enabled, new ERC-20 loans are instead capped at the smaller of the existing per-asset ceiling and the current max-init-LTV of the collateral's **effective liquidity tier**, and the initiation HF floor relaxes to 1.0 — the tier ceiling becomes the binding buffer below liquidation. Tier 0 (illiquid or untierable) collateral cannot support a new borrow in this mode.

**Tier measurement.** Tiers 1 through 3 represent progressively deeper markets, measured by simulated sells of $5k, $50k, $500k, and $5M (PAD-denominated, each size governance-configurable within bounds) through the configured on-chain routes (§9.3). The effective tier is `min(onChainTier, keeperConfidenceTier)`: a new asset defaults to keeper tier 1; the keeper role can lower an asset's tier immediately but can promote it only up to the on-chain-measured tier, and can never raise an asset above what the on-chain route and manipulation guards validate. There is deliberately **no governance per-asset allowlist** that upgrades an asset into a higher tier — governance retains only remove-only safety levers.

**Peer-derived tier caps.** The tier-to-max-init-LTV mapping is data-derived rather than manually set. `OracleFacet.refreshTierLtvCache()` is permissionless and refreshes per-tier cached values from peer lending-protocol configurations (Aave V3 and Compound V3 reads normalized into basis points; not-listed or reverted reads return clean failure flags):

- A reference asset is accepted only when **at least two peers agree within 30 percentage points** (structural peer-configuration spreads of 20–30 points are normal on mid-cap assets, so a tighter band would wrongly reject valid references).
- A tier is accepted only when **at least two reference assets contribute**.
- The tier candidate is the resulting **median minus the tier haircut**.
- Per-tier **safety boxes** are the constitutional bounds on autonomous values: Tier 1 [37%, 55%], Tier 2 [55%, 69%], Tier 3 [69%, 82%]; haircuts default to 0, 0, and 5 percentage points respectively. A candidate outside its box is **rejected and emitted as a refresh-rejection reason, never clipped into range**.

Peer coverage at launch is Aave V3 and Compound V3; Morpho Blue is a planned follow-up (its market enumeration is per market rather than per asset).

**Cache lifecycle.** The cache is fresh for **14 days**. A stale-warning event fires once values are older than **7 days** but still usable. After 14 days, loan initiation falls back to the **governance-configured per-tier caps** (defaults 50%, 60%, and 65% for tiers 1, 2, and 3) — not to fixed library constants — so a cap governance has deliberately tightened remains in force even while the peer refresh is paused or stale.

`ConfigFacet.setTierLtvParams` updates all three (floor, ceiling, haircut) triples atomically, with validation enforcing:

- floor < ceiling and ceiling ≤ 100% per tier;
- haircut ≤ 10 percentage points per tier;
- no overlapping boxes (`tier1.ceiling ≤ tier2.floor`, `tier2.ceiling ≤ tier3.floor`);
- all-or-nothing application (a single invalid triple rejects the whole update).

Post-handover this setter is timelock-controlled. More broadly, every governance knob of the regime — baseline floor size, slippage budget, tier test sizes, safety boxes, haircuts, price-history window and agreement band, quote-asset list, keeper confidence tier, peer-protocol addresses, reference-asset lists, cache TTL, and the master switch — is bounded and auditable through the shared typed range-error pattern.

**Emergency levers** are remove-only or global: `pauseAsset`, `setDepthTieredLtvEnabled(false)`, and `autoPause`. The peer-protocol reads themselves are independently pausable; while paused, the platform falls back to its own governance-set per-tier caps. None of these levers can be used to *raise* an asset's tier or loosen a cap — the escalation direction is structurally unavailable to administrators.

### 7.3 Add Collateral

A borrower whose liquid collateral is declining in value can top up the position through `AddCollateralFacet` before it becomes liquidatable.

- **Who may top up:** only the borrower of the loan. Top-up is deliberately a party-only action — it is not on the keeper-initiable allowlist, so no third-party automation can add (or be tricked into adding) collateral on a borrower's behalf.
- **What may be added:** additional units of the same ERC-20 collateral asset already securing the loan, deposited into the borrower's own vault. The loan's recorded collateral amount and the encumbrance ledger (§7.4) are updated together.
- **Effect:** adding collateral strictly increases HF and reduces LTV, so no minimum threshold is enforced on the addition itself; the transaction reports the new HF and LTV in its event so interfaces and indexers track the position without a read-back.

**Cure path.** Top-up is also the recovery route for a loan that has entered the abnormal-market fallback state (§8.4). While a loan is fallback-pending and before the lender's claim execution starts, a collateral top-up that restores HF to the runtime admission floor cures the position: the collateral held on the protocol side is restored to the borrower's vault, the fallback snapshot is cleared, and the loan returns to `Active` (signalled by a dedicated `LoanCuredFromFallback` event). The cure check consumes the same runtime floor value as admission (§7.1).

### 7.4 Partial Collateral Withdrawal

If a borrower's liquid collateral has appreciated — or the position was over-collateralized at initiation — the borrower may withdraw the excess through `PartialWithdrawalFacet`, subject to risk checks:

- Only the borrower may withdraw; only liquid ERC-20 collateral qualifies (illiquid collateral is valued at $0, so no "excess" is computable).
- The withdrawal is simulated first: the **post-withdrawal HF must remain at or above the runtime admission floor** and the **post-withdrawal LTV must remain at or below the applicable maximum**. Either failing check reverts the withdrawal.
- A withdrawal is refused while a live lender-sale listing pins the position's terms for a pending buyer, so a buyer can never pay full principal for a silently under-collateralized loan.

**Collateral-protection invariant (platform-wide).** Collateral that backs a live ERC-20 loan must not be withdrawable from the borrower's vault through *any* path other than a protocol flow that first accounts for the reduction. The only collateral a borrower can move out is the genuinely free (un-pledged) balance. This invariant is enforced structurally by an **encumbrance sub-ledger** (`LibEncumbrance`): a per-loan collateral lien is created at loan initiation and is released, decremented, or re-keyed by every lifecycle flow that legitimately frees collateral — repayment, preclose, obligation transfer, refinance, liquidation, default, swap-to-repay, and the risk-checked withdrawal above. Offer-locked principal is tracked in the same ledger. Both categories roll up into one aggregate encumbered-amount map per user, asset, and token id, and the vault's withdraw guard answers a single question — *is this amount free?* — without needing to distinguish lien kinds.

The rule applies uniformly to unrelated exits: an asset that has its own vault-withdraw door (including the protocol's VPFI token when pledged as ERC-20 collateral) is withdrawable only down to the free balance while pledged; the pledged portion is released only by the loan's own lifecycle. A borrower can therefore never leave a loan under-collateralized by routing pledged collateral out a side door. The NFT-rental prepayment pool is intentionally exempt from lien accounting — it is drawn down by the rental mechanism itself — and, to keep it safe without that accounting, the rental prepayment asset must be a plain ERC-20 with no separate vault-withdraw exit (VPFI is disallowed as a rental prepayment asset for exactly this reason).

### 7.5 Volatility LTV Collapse

The engine recognizes a distinct "collateral value collapsed" condition for liquid positions whose collateral has fallen so far that a market sale no longer makes sense. `RiskFacet.isCollateralValueCollapsed` reports a position as collapsed when either:

- LTV exceeds the volatility collapse threshold — **110%** by default (`VOLATILITY_LTV_THRESHOLD_BPS` = 11000, governance-overridable), i.e. the debt exceeds the collateral's full market value by 10% or more; or
- HF is below 1.0.

The flag changes how a time-based default settles (§8.1): a defaulted loan whose liquid collateral is collapsed **skips the swap-based recovery path entirely** and settles through the same full-collateral in-kind transfer branch used for illiquid collateral. Once the debt exceeds the collateral by this margin, every unit of swap proceeds would belong to the lender anyway; transferring the collateral in kind avoids paying slippage and swap-execution risk out of an already-insufficient recovery. The corresponding fallback settlement paths are checked for consistency with the HF/LTV collapse flags by a dedicated invariant suite.

## 8. Liquidation and Default Settlement

### 8.1 Two Liquidation Paths

Distressed positions are closed through two independent, permissionless paths:

| | Path A — HF-based | Path B — time-based default |
| --- | --- | --- |
| Facet / entry | `RiskFacet.triggerLiquidation` | `DefaultedFacet.triggerDefault` |
| Trigger | Health Factor < 1.0 | grace period expired after non-repayment / non-return |
| Who may call | any address | any address |
| Depends on collateral health | yes (market-risk backstop) | no (calendar-risk backstop) |
| Liquid collateral | swap-failover sale | swap-failover sale (unless collapsed, §7.5) |
| Illiquid collateral | not applicable (no risk math) | full in-kind transfer to lender (consent-covered) |

**(a) HF-based liquidation — `RiskFacet`.** When a liquid-collateral loan's Health Factor falls below 1.0, any address may call `RiskFacet.triggerLiquidation`. The caller supplies a ranked try-list of swap routes (§8.2); there is no liquidator role gate and no whitelist — permissionless triggering is a protocol-safety property. A successful liquidation repays the lender from swap proceeds, pays the dynamic liquidator incentive and treasury charges (§8.3), and returns any surplus to the borrower. Liquidation applies only in-term or as configured; it is a market-risk backstop, independent of the repayment calendar.

Three permissionless variants extend the base path:

- **Partial liquidation** (`triggerPartialLiquidation`): for active, in-term, mildly underwater loans, a caller may liquidate a bounded fraction of collateral (launch bounds 2%–75%). Proceeds apply interest-first then principal; the loan stays `Active` and the interest clock restarts on the reduced principal. The call must strictly improve HF and restore it to at least 1.0, and a routine partial may not leave the position above a governance-set target ceiling (default HF 1.20) — over-liquidation is rejected — except for positions already deep underwater (at or below a default 0.95 threshold) or already-dust positions where governance has enabled dust handling. A partial never moves the loan's maturity, grace tier, or grace clock.
- **Split-route liquidation** (`RiskSplitLiquidationFacet.triggerLiquidationSplit`): the caller supplies `(route, amount)` legs summing exactly to the collateral, for sizes no single venue can absorb at acceptable slippage (§8.2).
- **Discounted liquidation** (`triggerLiquidationDiscounted`): behind an independent master switch that defaults off, a liquidator may pay the full debt in the principal asset and receive oracle-priced collateral at the collateral tier's configured discount (defaults 7.7% / 6.0% / 5.0% for tiers 1–3, each bounded by per-tier safety boxes with the monotonic invariant T1 ≥ T2 ≥ T3). The path enforces the ordinary borrower-protection gates — active loan, HF below 1.0, healthy sequencer, fresh oracle quorum for both assets — plus discount-specific gates (non-zero recipient; tier-classified collateral, since the discount schedule is per tier). Any borrower surplus stays in the borrower's vault, encumbered and claimable only by the current holder of the borrower-side position NFT. A standalone flash-loan receiver contract may fund discounted liquidations atomically (borrow, pay the debt through the Diamond before collateral leaves custody, swap the seized collateral, repay the flash loan) — the whole transaction reverts unless proceeds cover debt plus fees, and the Diamond entry point itself remains permissionless.

**(b) Time-based default — `DefaultedFacet`.** Independent of collateral health, a loan whose borrower has not repaid (or, for NFT rentals, not closed the rental) by the end of its grace period may be defaulted by any address via `DefaultedFacet.triggerDefault`. Grace windows come from the six-slot duration schedule (1 hour for sub-week loans up to 30 days for full-year and longer tenors, governance-editable per row within per-slot safety bounds and a global floor of 1 hour / ceiling of 90 days). The maturity and grace deadline are fixed by the loan's original start time and committed duration — no partial repayment, partial liquidation, or swap-to-repay ever moves them, so the lender's recovery deadline can neither be accelerated against the borrower nor rolled forward by repeated small payments. A read-only `isLoanDefaultable` view lets any caller confirm eligibility before submitting. Settlement branches on the collateral's live classification:

- **Liquid collateral, not collapsed:** the collateral is sold through the same swap-failover machinery as path (a) — no HF check is required, because non-repayment after grace is an independent default trigger. Proceeds settle principal, accrued interest, and late fees, with the same treasury charges; the lender bears any shortfall and the borrower receives any surplus as a recorded claim.
- **Illiquid collateral (with the recorded both-party consent), or liquid-but-collapsed collateral (§7.5):** the entire collateral is transferred in kind to the lender's side — no auction, no swap.
- **NFT rental default:** the borrower forfeits the ERC-20 prepayment. The rental-fee portion (net of the treasury fee on that portion) goes to the NFT owner; the 5% buffer goes to treasury; the vaulted NFT's temporary user rights are revoked and the NFT is returned to the owner through the settlement flow.

If the swap leg of a time-based default fails outright, the loan does not force-settle: it transitions to the curable fallback-pending state described in §8.4.

### 8.2 Swap Routing and Failover

All swap-based settlement flows route through one shared library, `LibSwap`, driving a governance-registered adapter set (production routing may include 0x Settler, 1inch v6, Uniswap V3, and Balancer V2).

**Failover (`swapWithFailover`).** The caller submits an already-ranked try-list — off-chain quoting sorts venues by expected output — as `(adapterIdx, data)` entries:

- adapter addresses are resolved **by index into governance storage**, never taken from calldata, so a caller can rank routes but cannot inject an arbitrary contract;
- the Diamond attempts each entry in order and commits on the first success; a venue that reverts, under-delivers, or has gone stale falls through to the next;
- an out-of-range index reverts immediately, so a keeper detects a de-registered adapter without burning the failover budget;
- a governance-paused venue is skipped rather than aborting the chain, so a compromised or illiquid adapter cannot block the remaining routes;
- if every entry fails, the call returns a clean total-failure result and the caller routes to the fallback path (§8.4).

**Exact-scope approvals.** For each attempt, the Diamond approves the adapter for exactly the input amount of that one attempt — setting the allowance to zero first (accommodating tokens that refuse non-zero-to-non-zero approvals), then to the exact amount — and **revokes the approval after the attempt regardless of success or failure**. Liquidation routing leaves no persistent DEX allowances behind.

**Oracle-anchored slippage floor.** The minimum acceptable output is derived on-chain from the oracle-expected proceeds minus the configured maximum liquidation slippage. This floor is authoritative: caller-supplied routing data and `minOut` values may only **tighten** it, never weaken it. The adapter side enforces the floor per attempt.

**Split routes (`swapWithSplit`).** For the split-route path, per-leg amounts must sum exactly to the total input, and the **combined** output is checked against the same oracle-derived floor. The split is atomic: any failed leg, or insufficient combined output, reverts the entire transaction — partial split settlement is not allowed.

### 8.3 Slippage, Incentives, and Charges

| Parameter | Value | Scope |
| --- | --- | --- |
| Maximum liquidation slippage | 6% (governance-configurable within a bounded range) | if exceeded, the swap must not execute → fallback (§8.4) |
| Liquidator incentive | dynamic: `6% − realized slippage`, capped at **3%** of proceeds | successful swap-path liquidations |
| Liquidation-handling charge | **2%** of liquidation proceeds, to treasury | successful swap-path liquidations |
| Treasury fee on recovered interest / late fees | 1% (rate snapshotted at loan origination) | applied to the interest/late-fee portion actually recovered |

The incentive and the slippage budget share one envelope: `slippage% + liquidator incentive% = 6%`, so a cleanly executed swap earns the liquidator more and a high-slippage one earns less, with the incentive capped at 3% of proceeds. The 2% handling charge is levied because the borrower failed to act before liquidation became necessary; it is separate from the liquidator incentive and separate from the ordinary treasury fee on interest. When recovered proceeds do not even cover principal, no treasury interest fee is taken — the lender is already absorbing a loss.

Distribution order on a successful liquidation:

1. the 2% handling charge is deducted from gross proceeds;
2. the lender is repaid principal plus recovered interest and late fees, net of the treasury fee on that interest/late portion;
3. any excess after all obligations is recorded as a borrower claim;
4. if proceeds are insufficient to cover the lender's due amount, the lender bears that loss.

Because the treasury-fee rate is snapshotted at origination (§7.1's terms-lock discipline applied to fees), a governance retune between origination and liquidation cannot change what an open loan's settlement takes from recovered interest.

### 8.4 Abnormal-Market Fallback

When collateral cannot be converted safely — every configured route failed, market conditions are abnormal, DEX liquidity is unavailable, execution fails technically, or the swap would exceed the 6% slippage ceiling — the protocol does **not** hand the lender the borrower's entire liquid collateral by default. Instead the loan transitions to a **FallbackPending** state and settles through an equivalent-collateral model:

- The collateral is held on the protocol side and the lender side resolves into a claimable, collateral-denominated entitlement. There is no extra grace window — the lender may claim immediately — but the state is **curable**: until lender-claim execution actually starts, the borrower may fully repay (cancelling the fallback; collateral is later reclaimed through the normal borrower flow) or add collateral to restore the position above the required thresholds (the loan continues as `Active`, per §7.3). Once claim execution starts, it is not interrupted or auto-revived in the same transaction.
- During the lender-claim step, the lender or a keeper may supply a fresh ranked try-list for **one more liquidation attempt**, and may attempt an **internal-match rescue** where a priceable opposing leg exists. A successful retry or match settles through the normal path and clears or reduces the fallback records.
- If all retry and rescue paths fail, the lender claims collateral equivalent to the lending-asset due plus accrued interest plus **3% of the lending-asset amount**, and treasury becomes entitled to collateral equivalent to **2% of the lending-asset amount** — the extra 5% premium exists because the borrower did not act before liquidation became necessary. If the remaining collateral value is below the lender entitlement, the lender receives the full remaining collateral and the borrower receives nothing from that position; otherwise the residual collateral value remains attributable to the borrower through the ordinary claim flow.
- The fair-value split requires fresh quorum prices for both assets. If either side lacks one at settlement time, the fallback must not pin the loan in `Active`: it settles through the full-collateral-to-lender branch used for illiquid collateral and emits dedicated telemetry (`LiquidationFallbackOracleUnavailable`).

**Internal-liquidation matching** is an optional pre-DEX clearing layer behind an independent kill switch (`internalMatchEnabled`, **default off**). When enabled, distressed loans with opposing asset directions can be cleared against each other at protocol-oracle prices through protocol-controlled custody — avoiding DEX slippage and aggregator fees entirely:

- a **two-loan match** clears one loan's principal with the other loan's collateral and vice versa; a **three-loan cycle** clears an asset loop where each loan's collateral is the next loan's principal asset;
- a configurable **priority window** (default a 2%-of-LTV band above the loan's snapshotted liquidation threshold) blocks ordinary external liquidation while a distressed loan is inside it, giving matchers time to find a counterparty; beyond the window the external path reopens, so bad-debt protection is never delayed indefinitely (an intentional partial liquidation defers to the same window);
- the **matcher incentive** is a bounded per-leg withholding from each matched notional (default 1%, hard cap 3% per leg) — deliberately below the external liquidation cost surface, and governance may zero it;
- a fully matched loan moves to a dedicated **internally-matched terminal state**, claim-eligible exactly like other terminal states while preserving the event trail that it closed internally; both sides then settle through the ordinary claim lanes, symmetric and order-independent;
- a **partial** match leaves the loan in its prior state with proportionally reduced records; residual borrower collateral (including any vault-held top-up, which never participates in the match itself) stays protected and claimable by the current borrower-position holder;
- **fallback-pending loans are eligible as rescue legs** where oracle pricing is available, with idempotent restoration of fallback-held collateral into the normal settlement path.

Disabling the switch immediately restores ordinary external liquidation behaviour; the switch is independent of both the discounted-liquidation switch and the depth-tiered-LTV switch.

### 8.5 Settlement as an Immutable Plan

Every settlement is computed before anything moves. `LibSettlement` separates the *what is owed* math (a pure computation phase) from the *move the assets* transfer phase: a facet first builds an immutable in-memory settlement plan — principal, interest, late fee, treasury share, lender share, and the lender's total due — and then every downstream side-effect (token transfers, recorded claims, and emitted events) consumes **exactly those numbers**. The plan is the single source of truth for the settlement: if it says treasury = X and lender = Y, no transfer or event may execute a different split. This rules out by construction the bug class where an event logs one split while the transfer executes another. The plan's fields satisfy exact identities (the treasury and lender shares sum precisely to interest plus late fee), and all fields derive from one shared entitlement library so the rounding model is identical across every settlement path.

The same discipline extends to claims. Terminal flows do not push assets to counterparties; they write per-loan claim records (asset, amount, asset type, token id, quantity) that the entitled party later draws against:

- claim authority follows the **current holder of the relevant Vaipakam position NFT**, not the original wallet — a wallet that merely funded a repayment gains no collateral rights, and a party who transferred their position away cannot drain proceeds the rightful holder is owed;
- recorded proceeds sitting in a vault remain **encumbered until claimed**, using the same encumbrance ledger as pledged collateral (§7.4), so no independent vault exit can move them first;
- the fallback path's claim records (§8.4) follow the same model — they are cleared or proportionally reduced when a cure, retry, or internal-match rescue supersedes them, but never silently recomputed at claim time.

Once recorded, a settlement split does not drift: later price movement, governance retunes, or position transfers change *who may claim*, never *what was computed*.

### 8.6 Adapter Registry

Swap venues participate in settlement only through the governance-controlled adapter registry:

- **Registration gate.** Adapters are registered, removed, re-ordered, and paused through role-gated `AdminFacet` entry points; duplicate registration is rejected. Pausing a venue is distinct from de-registering it: a paused venue is skipped by the failover loop and can be re-activated later, without disturbing the indices keepers rank against.
- **Zero-adapter deployments revert.** A deployment with no registered adapters **reverts swap-based liquidation attempts outright** (`NoSwapAdaptersConfigured`) — it does not fall through to the collateral fallback path. The distinction is deliberate: an empty *try-list* against a populated registry is a legitimate total-failure signal that routes to fallback, but an empty *registry* is an operator configuration error that must be fixed by registering an adapter, not silently absorbed as an in-kind transfer.
- **Permissionless triggering preserved.** The registry constrains *which contracts* may execute swaps, never *who* may trigger liquidation. Any address may still call the liquidation and default entry points once protocol conditions are met; callers supply only ranking and routing data, resolved against the registry.

## 9. Oracle Infrastructure

### 9.1 Price Sourcing and the Active Numeraire

Pricing is **Chainlink-led**. `OracleFacet.getAssetPrice` returns asset prices denominated in the **active protocol numeraire** — a governance-defined unit configured entirely through oracle-layer inputs: the Chainlink ETH/numeraire feed, the Feed Registry denominator for direct lookups, the numeraire symbol used for symbol-derived secondary-oracle queries, and the optional Pyth cross-check feed id. The post-deploy default numeraire is USD. Because LTV and HF are ratios, the numeraire unit cancels — risk math is unit-agnostic — while absolute-value comparisons compare numeraire-priced values against numeraire-denominated stored thresholds directly.

Retrieval is hybrid and layered:

- **Direct feed first.** The protocol prefers a direct Chainlink `asset/<numeraire>` feed and falls back to the composed `asset/ETH × ETH/<numeraire>` path only when no direct feed exists.
- **PAD pivot.** To avoid depending on sparsely covered non-USD feeds after a numeraire rotation, the primary path may pivot through a governance-configured **Predominantly Available Denominator** (PAD, default USD): read `asset/PAD` from Chainlink's dense feed set, then convert PAD to the active numeraire via a direct rate feed or a derived `ETH/<numeraire> ÷ ETH/PAD` rate. When PAD equals the numeraire the pivot collapses to the ordinary direct read. PAD is configured atomically through `setPredominantDenominator`.
- **Curated overrides.** Operators may opt individual assets into vetted direct `asset/<numeraire>` feed overrides via `setAssetNumeraireDirectFeedOverride` — an explicit governance-curated choice, never inferred from off-chain feed-rating metadata.
- **WETH special case.** WETH is priced directly from the `ETH/<numeraire>` feed and serves as the primary quote asset for liquidity routing; no circular WETH-against-WETH liquidity check is performed.

An optional single **Pyth cross-check** per chain sanity-checks the Chainlink ETH/quote feed on the primary path. It is a divergence check, not a numeraire selector: if the Pyth feed is unset, stale, low-confidence, or non-positive it soft-skips; if it is configured and diverges beyond the governance-bounded threshold, pricing reverts fail-closed with a typed divergence error. Every oracle knob — Pyth address, feed id, staleness, deviation, confidence, and the secondary-oracle bounds — is range-bounded and reverts through a shared typed `ParameterOutOfRange` error, so admin misconfiguration is visible and auditable.

### 9.2 Staleness and Quorum

Feed freshness is enforced with a **hybrid peg-aware staleness rule**:

| Feed answer age | Accepted? |
| --- | --- |
| ≤ 2 hours (volatile ceiling) | yes, unconditionally |
| 2–25 hours (stable ceiling) | only if the answer remains within tolerance of a recognized peg |
| > 25 hours | no — the read fails |

The peg test recognizes the implicit USD $1 peg for registered stables and governance-registered fiat/commodity references (such as EUR/USD, JPY/USD, or XAU/USD) — reflecting that low-volatility reference feeds have correspondingly long heartbeats, while a de-pegged answer old enough to hide a move is refused. Oracle admins may additionally set per-feed staleness budgets and minimum-valid-answer floors for critical aggregators; a configured override takes precedence over the global defaults and can be cleared by resetting it to zero.

On top of Chainlink, a **soft 2-of-N secondary quorum** guards against a single-source failure. Where configured, Tellor, API3, and DIA act as secondary price sources whose query keys are derived from the ERC-20 symbol (deliberately avoiding a per-asset governance mapping). The rule:

- if **every** secondary is unavailable, the Chainlink price is accepted (availability soft-skip);
- if **at least one** available secondary agrees with Chainlink within the configured deviation bound, the price is accepted;
- if one or more secondaries disagree **and none agree**, pricing **reverts** for that asset.

Secondary deviation and staleness bounds are themselves range-bounded governance knobs (deviation 100–2000 bps; staleness 60 seconds to 29 hours).

### 9.3 AMM Liquidity Verification

Liquidity classification asks the liquidation-relevant question directly: *how far below the oracle price would a sale of a given size execute?* A pure slippage library models Uniswap-V2-style pools exactly and approximates v3-style concentrated-liquidity pools from current notional reserves (exact tick-walking is left to off-chain keepers and audit tooling).

**Baseline liquid/illiquid gate.** An ERC-20 is liquid on a network only if it has a usable price path (§9.1) *and* passes the slippage-at-floor check: selling the governance-configured floor size (default $5,000 PAD value) through the best configured route must execute no more than the configured budget (default 2%) below the trusted Chainlink-led spot price. Route search spans configured `asset/WETH`, `asset/USDC`, and `asset/USDT` pools across **multiple supported V3-clone factories and V2-fork factories**, using eligible V3 fee tiers up to 0.3% — a pool existing only at a deliberately excluded dust-prone 1% tier cannot qualify an asset by itself. Judging by executable depth at the floor size (rather than depth-at-current-tick) rejects manipulated or concentrated-at-spot pools that cannot absorb a real sale, while letting deep V2 liquidity qualify an asset even with no V3 pool. Liquidity is judged **only on the active network** — Ethereum mainnet is never consulted as a fallback reference.

**Depth tiers.** The same machinery, probed at $5k / $50k / $500k / $5M sizes (each governance-configurable within bounds), produces the on-chain liquidity tier (0 = illiquid or untierable; 1–3 = progressively deeper markets) consumed by the depth-tiered LTV regime (§7.2), the per-tier liquidation thresholds (§7.1), and the per-tier liquidation discounts (§8.1).

**Anti-manipulation guards.** Two guards gate both baseline classification and tier resolution:

1. the pool's spot price must agree with the trusted Chainlink-led oracle path; and
2. where the pool exposes usable price history, its recent average must agree with the current pool price within a bounded governance band.

Together these prevent a momentarily inflated or single-block-manipulated pool from qualifying an asset as liquid or promoting its depth tier: a pool must be both consistent with the external oracle and internally stable over its own recent history.

### 9.4 L2 Sequencer Circuit Breaker

On L2 deployments, every price read is gated by the chain's Chainlink **sequencer-uptime feed**. If the sequencer is reported down, price reads revert (`SequencerDown`); after a recovery, prices remain untrusted for a **1-hour post-recovery grace period** (`SequencerGracePeriod`) before reads resume, so state built up during the outage cannot be acted on against pre-outage prices. The circuit breaker is enforced inside the primary pricing path itself — every consumer of `getAssetPrice` inherits it — and liquidation entry points independently require a healthy sequencer. The liquidity classifier degrades in the safe direction: while the sequencer is unhealthy, assets classify as illiquid rather than the check reverting. A non-reverting `sequencerHealthy()` view lets off-chain tooling and settlement code branch without catching reverts.

### 9.5 Fail-Closed Doctrine

The oracle layer resolves every ambiguity toward refusing new risk, consistent with the platform-wide fail-closed posture (§4):

- **Classification fails closed.** If frontend assistance is unavailable, or on-chain checks cannot reach the validation data they need (Chainlink reads, pool lookups), the asset defaults to **illiquid** — full-collateral-transfer terms apply on default and the parties must consent to them. **No manual override may classify an asset as liquid** when checks fail or indicate illiquidity.
- **Pricing fails closed.** Quorum disagreement (§9.2), cross-check divergence (§9.1), staleness beyond the applicable ceiling, and sequencer outages (§9.4) all make the price read revert rather than return a doubtful value.
- **Admission blocks.** Loan initiation, top-up-cure, withdrawal, and preview checks all require fresh prices for both legs; with pricing unavailable, no new liquid-classified position can be admitted and no risk-checked collateral can leave a vault.
- **Close-outs prefer safety over precision.** Existing positions are never trapped by a dead oracle: repayment stays open; time-based default still settles through the in-kind branches that need no price; and a failed-swap fallback that cannot obtain quorum prices settles through the full-collateral-to-lender branch with dedicated telemetry rather than pinning the loan in `Active` (§8.4). Settlement code uses a no-revert availability read (`OracleFacet.tryGetAssetPrice`) to choose between the fair-value split and the oracle-unavailable branch explicitly, instead of catching reverts.

The doctrine's asymmetry is deliberate: a stale or missing feed can prevent a *new* exposure from being created, but it can only ever push an *existing* distressed position toward the more conservative, consent-covered settlement branch.

## 10. NFT Rental

Vaipakam treats NFT lending as a rental transaction, not a custody transfer to the borrower. A lender (the NFT owner)
lists an ERC-4907-compatible ERC-721 or ERC-1155 NFT at a daily rental charge; a borrower (the renter) prepays the
rental cost and receives temporary usage rights. Only ERC-20 tokens may serve as the value-bearing prepayment asset
for a rental; no separate NFT collateral is required, because the rented NFT never leaves protocol custody and can be
returned to the owner directly at closure or default.

### 10.1 Custody and Usage Rights

- **Vault-held custody.** For the full rental period the NFT is held by the Vaipakam Vault contract. For ERC-721
  tokens, the token is transferred into the vault, giving the vault controller owner-level custody so it can assign,
  revoke, or reassign only the ERC-4907 `user` right. For ERC-1155 tokens, the tokens are likewise held in the vault,
  and the vault controller assigns ERC-4907-style user rights while the tokens remain vault-controlled.
- **Owner keeps ownership; renter gets usage.** The borrower receives only a temporary `user` assignment — never
  custody, never ownership, and never transfer authority over the underlying NFT. Ownership economics stay with the
  lender-side position throughout.
- **Stable integration surface.** The vault acts as the ERC-4907-style wrapper for vaulted rental positions. External
  applications query the vault (by underlying NFT contract and token id) for the current user, the user expiry, and —
  for ERC-1155 rentals — the active aggregate rented quantity for that token id within that vault. Where multiple
  active ERC-1155 rentals share a contract and token id in one vault, the reported expiry is the minimum (earliest)
  active rental expiry for the aggregated position. Integrators must not assume the underlying NFT contract itself
  exposes a uniform rental interface; the vault is the intended read surface.
- **Position transfers change assignment, not custody.** A borrower preclose or obligation transfer on a rental
  changes only the temporary user assignment; the custody model is untouched. The platform revokes the outgoing
  borrower's user rights and assigns rights to the incoming borrower for the remaining permitted term.

### 10.2 Prepayment and Buffer

- **Prepay-and-buffer model.** At rental initiation the borrower locks ERC-20 tokens covering the total rental fees
  for the agreed term plus a 5% buffer (`RENTAL_BUFFER_BPS = 500`). This entire amount is a prepayment; rentals are
  priced on this model rather than on APR interest against principal, and no loan-initiation fee is charged on the
  rental path.
- **Prepayment asset restrictions.** The rental prepayment pool is drawn down by the rental mechanism itself rather
  than being tracked as withheld collateral, so the prepayment asset must be a plain ERC-20 with no separate
  vault-withdrawal exit; the protocol's own VPFI token is not accepted as a rental prepayment asset.
- **Daily deductions.** Rental fees are deducted automatically from the prepayment as the rental runs. The
  daily-deduction entry point (`autoDeductDaily`) is permissionless — it is a deterministic maintenance action with no
  caller discretion over pricing or settlement terms — and each daily fee is paid to the current holder of the
  lender-side position NFT (`ownerOf(lenderTokenId)`), resolved at payment time, not to the wallet that originally
  listed the NFT.
- **Buffer disposition.** On a proper, on-time closure with all fees settled, the 5% buffer is refunded to the
  borrower. On default, the buffer is not refunded and is not paid to the lender: it is routed to the treasury (see
  §10.3).
- **Treasury share.** The treasury collects its standard fee (1%) on rental fees earned by the lender, and its share
  of any late fees, at settlement or claim time.

### 10.3 Rental Settlement and Default

- **Proper return.** When the borrower closes the rental on time, the vault revokes the borrower's `user` status, the
  accumulated rental fees (minus the treasury fee) become claimable by the current lender-position holder, and the 5%
  buffer is returned to the borrower. An early close (direct preclose of a rental) settles the full agreed rental: the
  lender receives the full-term rental fees minus the treasury fee, and the borrower recovers any undeducted
  prepayment remainder plus the buffer. Rental-side deductions at settlement are always drawn from the vault of the
  borrower of record — where the prepayment actually lives — never from the transaction caller's funds.
- **Late closure.** If rental closure is delayed past the agreed duration, late fees apply: 1% of the overdue rental
  amount on the first day after the due date, increasing by 0.5% daily, capped at 5% of the total rental amount, and
  subject to the treasury fee.
- **Default.** If the borrower fails to close the rental and settle fees by the end of the grace period, the borrower
  forfeits the full prepayment (total rental fees + 5% buffer). The split is fixed: the rental-fee portion goes to the
  lender minus the applicable treasury fee on that portion; the 5% buffer portion goes to the treasury — not to the
  lender.
- **`userOf` revocation and NFT return.** On default the platform revokes the borrower's `user` status. For ERC-721,
  the NFT remains in the vault until it is returned to the lender through the settlement flow; for ERC-1155, the
  vaulted tokens are returned to the lender. In both closure and default, the rental proceeds and the NFT itself reach
  the **current** lender-position holder through the `ownerOf`-gated claim path — never a departed lender whose
  position NFT has been transferred away.
- **Position status.** The lender- and borrower-side Vaipakam position NFTs are updated to the closed or defaulted
  state, and burned once all claims complete.

### 10.4 Prepay Listings

Prepay listings are the protocol's NFT-market exit for **ERC-20 loans secured by NFT collateral** (they are distinct
from the rental flow above, where the NFT is the lent asset): the borrower-side position holder may list the vaulted
NFT collateral on an external marketplace before default, so a sale can repay the loan from proceeds without weakening
the lender's default rights.

- **Opt-in and custody.** The lender offer must explicitly allow NFT collateral sale. The listed NFT never leaves the
  borrower's vault until a valid marketplace fill atomically pays the settlement waterfall and transfers the NFT to
  the buyer; the borrower never gains raw transfer authority merely by listing. Marketplace operator approvals are
  limited to governance-approved conduits.
- **Settlement floor.** A live listing must cover at least the lender settlement entitlement, treasury entitlement,
  and required marketplace fee legs; any excess belongs to the current borrower-position holder. In every listing mode
  the on-chain settlement floor remains authoritative — borrower-facing ask controls cannot underpay the lender or
  treasury. A successful fill is a proper loan close, not a default.
- **Listing modes.** Three discovery modes are supported (`NFTPrepayListingFacet`, `NFTPrepayDutchListingFacet`,
  `NFTPrepayListingAtomicFacet`): fixed-price listings; Dutch-decay listings, which must enforce a minimum auction
  window, end no later than the loan's grace boundary, and decay the total ask, fee legs, and borrower residual
  monotonically; and atomic external-market offer matches, where cancel, replacement, and bidder fill either all
  succeed or all leave the prior listing intact.
- **Auto-list-at-floor.** While a loan is inside its grace window, a permissionless entry point
  (`NFTPrepayAutoListFacet.autoListAtFloorOnGrace`) lets any caller — typically a keeper — either post a fresh
  fixed-price listing at the protocol-mandated floor or rotate a stale or aspirational listing down to that floor. The
  borrower can opt out (a sticky per-loan flag set by cancelling the listing during grace) and re-enable later; the
  trigger reads only on-chain state.
- **Holder consolidation before a listing binds.** Every listing-creation flow — fixed-price, Dutch-decay, atomic
  external-offer match, and the permissionless auto-list post — first consolidates a transferred borrower position to
  its current holder, so the marketplace order references the holder's vault and the position is never locked out of
  consolidation while a listing is live. Rotating an already-live listing needs no consolidation, because a live
  listing locks the borrower position NFT.
- **Lifecycle hygiene.** If a listed loan is repaid, precloses, refinances, offsets, defaults, or is liquidated
  through another valid path, the listing binding is cleared atomically with that terminal action so a stale
  marketplace signature can never move collateral later. Fills are blocked past the grace boundary, where default and
  liquidation recovery take precedence. ERC-1155 collateral listings are full-position sales only, and a loan may
  never carry two live marketplace listing flows competing for the same transfer approval.
- **Borrow-or-sell variant.** A borrower-side offer with NFT collateral and all-or-nothing fill mode may publish the
  same sale listing at offer-creation time, before any lender accepts. If a buyer fills first, the offer closes as
  sale-consumed and proceeds credit the borrower's vault; if a lender accepts first, the listing intent carries into
  the live loan and settles through the loan-level waterfall.

## 11. Strategic Position Management

Both sides of a Vaipakam loan hold transferable position NFTs, and both sides have structured exits that do not
require waiting for maturity. Every strategic flow shares two protections: the initiating authority follows the
**current** position-NFT holder (§11.4), and replacement positions must keep the original asset types unchanged
(§11.5). In every borrower-side path the original lender must not end up economically worse off than under the agreed
loan terms, and in every lender-side path the original borrower must not be made worse off.

### 11.1 Borrower Preclose

A borrower preclose flow is valid only while the loan status is `Active`; a loan already repaid, defaulted,
liquidated, sold, transferred, or settled cannot be preclosed. Three paths exist.

- **Direct preclose (`precloseDirect`).** The borrower pays out the remaining obligation early. For an ERC-20 loan the
  borrower pays the outstanding principal plus the interest owed under the loan's interest mode: a full-term-interest
  loan (the protocol default) settles the full-term interest for the remaining committed term even when closed early,
  while a loan whose offer opted into pro-rata interest settles only the interest accrued for the time outstanding.
  The lender becomes entitled to principal plus interest minus the treasury fee; the borrower reclaims the full
  eligible collateral. For an NFT rental, direct preclose settles the full agreed rental and returns the buffer and
  any unused prepayment (§10.3), revoking the borrower's `user` right while the NFT stays vaulted.
- **Obligation transfer (`transferObligationViaOffer`).** The original borrower exits by handing the debt to a new
  borrower, implemented as the original borrower accepting an already-existing compatible borrower offer. The incoming
  borrower's position must preserve exactly the same principal, payment, and collateral asset types; the incoming
  collateral amount must be greater than or equal to the required collateral at transfer time; and the new end date
  must be on or before the original maturity. Under those conditions no fresh LTV / Health Factor gate is required
  solely for the borrower handoff — the lender remains on the asset-risk profile established at initiation. The
  exiting borrower pays all interest accrued to the transfer time plus any lender-protection shortfall, `max(0,
  original remaining interest − new remaining interest)`; those amounts are held for the lender and preserved into
  final settlement. Position NFTs are updated: the exiting borrower's NFT closes, a new borrower NFT is minted, and
  the lender NFT reflects the new relationship.
- **Preclose-via-offset.** Available for active ERC-20 loans only (NFT rentals are not eligible), the borrower exits
  by becoming a lender: they fund and create a new lender offer linked to their original loan, paying the accrued
  interest owed so far plus the shortfall `max(0, original remaining interest − new offer expected interest)`. When a
  counterparty borrower accepts the linked offer, the offset completes atomically in the same transaction: the
  counterparty's collateral locks, the funded principal deploys, the original borrower's collateral is released, the
  original lender's position converts into a claimable settlement covering principal, accrued interest, and any
  shortfall (minus treasury fees), and the original loan is marked closed. The original loan is never marked repaid
  unless the original lender's full claimable value has been preserved. `completeOffset` remains exposed as a manual
  recovery hook for interrupted offsets; on the happy path completion is automatic.

Before signature the interface must state the path-specific interest implication: direct close per the loan's interest
mode, transfer requires accrued interest plus any protected-rate shortfall, and offset requires accrued interest plus
any rate shortfall and fresh principal for the offsetting offer.

### 11.2 Refinance

Refinance lets a borrower replace an active ERC-20 loan with a new loan from a new lender on better terms, without
disadvantaging the original lender. NFT rentals are not eligible.

- **Mechanism.** The borrower creates a borrower offer *tagged* with the target loan id. Tagged offers are
  single-purpose: they must preserve the original loan's principal, payment, and collateral asset types, and
  offer-consumption paths that cannot safely chain into the refinance must reject them. When a new lender accepts a
  valid tagged offer, acceptance chains into the old-loan payoff in the same transaction — the replacement loan and
  the old-loan close either both succeed or both revert. A standalone `refinanceLoan(oldLoanId, borrowerOfferId)` path
  remains for borrower-direct or keeper-orchestrated flows. If the old loan is on a periodic-interest cadence with an
  overdue period, that period must be settled first; the refinance reverts until the original lender is made whole for
  it.
- **Original lender settlement.** The exiting lender is repaid principal plus **full-term interest on the loan's
  remaining committed term** — their maximum possible earnings on that loan — which structurally satisfies the
  original-lender protection rule. No additional rate-shortfall top-up is charged on refinance: the shortfall mechanic
  applies only on the obligation-transfer / offset paths, where the lender *stays* on the loan at the new rate. This
  payoff rule applies regardless of the loan's interest mode; the pre-signature disclosure states it plainly.
- **Collateral carry-over vs. return.** A refinance is "same debt, same collateral, better lender," so an eligible
  refinance carries the existing collateral over **in place**: the collateral never leaves the borrower's vault, and
  the protocol's locked-balance ledger retags the lien from the old loan to the new one, so the borrower never
  momentarily locks double collateral. Carry-over eligibility is deliberately narrow, decided once at offer creation,
  and recorded on the offer: the refinancer must be the original borrower (position not transferred), the offer must
  pledge a single fixed collateral amount whose identity exactly matches the old loan (asset, type, amount, token id,
  quantity), and the target loan's lien must still be live. Everything else — transferred positions, ranged offers,
  collateral mismatches, no-lien targets, and every untagged direct refinance — takes the fresh-pledge path: a new
  collateral batch backs the replacement loan and the old collateral is returned to the current borrower-position
  holder. A carry-over offer's collateral is frozen after creation, a matched carry-over fill must be all-or-nothing
  and full-size, and a stale carry-over offer whose target lien migrated is rejected at accept rather than creating an
  unbacked lien.
- **Position consolidation at close-out.** Close-out accounting follows current holders, not origination wallets. On a
  refinance the exiting lender's position effects always consolidate to that position's current holder. The borrower
  side depends on the collateral path: with carry-over the borrower position is not consolidated (it is not closing
  out — it continues into the new loan); on the fresh-pledge path the old loan closes for the borrower too, so the
  borrower side is consolidated to its current holder before the old collateral is returned.
- **Risk gate.** When depth-tiered LTV is disabled, refinance validation uses the standard Health Factor and max-LTV
  checks; when enabled, the replacement loan must satisfy the same tier-aware initiation cap used for new loans, with
  a post-rollover Health Factor of at least 1.0, and untierable collateral cannot pass the tier-aware path.

### 11.3 Lender Early Withdrawal

Lenders may exit an active position before maturity by selling it. Lender early withdrawal applies to ERC-20 loans
only (NFT rental positions are not eligible), and in Phase 1 the listed sale vehicle is available only for loans with
ERC-20 collateral. The passive alternative is always to hold to maturity, where no sale discount or forfeiture applies
beyond normal repayment/default rules.

- **Direct sale.** The exiting lender accepts an existing compatible lender offer: the buyer funds the agreed purchase
  amount (typically the outstanding principal), which is transferred to the seller, and the loan's lender field
  updates to the buyer. Interest accrued to the sale time is forfeited by the seller and routed to the treasury —
  avoiding retroactive interest splitting across lenders — or applied first toward any rate-difference shortfall the
  seller owes when the buyer's replacement interest for the remaining term exceeds what the existing loan would
  produce. The flow prefers net settlement, deducting forfeitures and shortfalls from incoming proceeds.
- **Loan-sale listing (`createLoanSaleOffer` → `completeLoanSale`).** The seller lists the position as a
  protocol-authored sale-vehicle offer through the borrower-offer path. The vehicle posts no fresh collateral — the
  collateral securing the underlying live loan continues to back it — so a zero-collateral sale offer is accepted by
  design. At listing time the seller's position is consolidated to its current holder, so the party who lists, the
  party the buyer pays, the party charged for accrued-interest forfeiture or shortfall, and the vault receiving
  proceeds are all the same address. A buyer's acceptance auto-completes the sale in the same transaction;
  `completeLoanSale` remains a keeper-executable completion step for the non-atomic case.
- **Buyer protections and settlement identity.** The buyer's signed acceptance binds against the live loan's facts,
  never a listing-time snapshot: a principal that must equal the loan's *current* principal, a term equal to the
  loan's *original fixed* duration, and a collateral **floor** the live collateral must meet; only the seller's asking
  rate binds to the offer. A partial repayment that shrinks the principal forces the buyer to re-sign for the smaller
  position. While a listing is live, the same position cannot also be sold through the direct sale path, the seller
  cannot edit the sale terms, borrower-initiated collateral withdrawal on the underlying loan is refused, and the
  loan's own current borrower cannot buy the listing (that would make lender and borrower the same party). Accepting a
  listing is a secondary-market transfer, not a new origination — no fresh loan-initiation fee is charged and the
  seller receives the full sale price. A listing left dangling by the loan reaching a terminal state can be torn down
  permissionlessly.
- **Borrower impact.** In every sale variant the borrower's obligation, repayment schedule, and collateral position
  continue unchanged under the same live loan; only future lender-side claims move to the buyer. The replacement terms
  must not worsen the borrower's continuing obligation or collateral exposure.

### 11.4 Authority Model

- **`ownerOf`-gated initiation.** Every strategic flow — borrower preclose, obligation transfer, offset, refinance,
  lender early withdrawal — may be initiated only by the wallet that is the current `ownerOf` the relevant lender-side
  or borrower-side Vaipakam position NFT. Authority follows the current NFT holder, not the wallet that originally
  opened the position; a position sold on the secondary market carries its strategic control with it.
- **No structural locks.** The protocol does not move position NFTs into protocol custody during strategic flows and
  does not natively lock their transfers; completion authority is enforced by function-level role and state checks
  against the currently entitled NFT owner.
- **What is never sufficient.** A rented `userOf` address on a position NFT, or an arbitrary third-party helper, can
  never initiate a strategic flow. If position NFTs later support ERC-4907-style `userOf`, that address is treated
  only as a keeper-level operational delegate for the already-keeper-enabled function set — never a substitute owner,
  never a claim recipient, never a payout router.
- **Keepers by narrow grant only.** An approved (whitelisted) keeper may initiate a strategic flow only when the
  position holder has granted that keeper the matching narrow per-action permission bit for that specific flow
  (§15.4). The initiation executes within the granting party's role, bounded by that party's configured caps and the
  protocol kill-switches; proceeds, cancel rights, and claim rights still bind to the granting party, and the keeper
  can never become a loan party or route value to itself. Claims remain executable only by the current owner of the
  relevant position NFT.

### 11.5 Same-Asset-Type Continuity

Every replacement, transfer, offset, refinance, or sale flow must keep the original loan's **asset types** unchanged:
the principal/lending asset type, the payment/prepay asset type, and the collateral asset type of the replacement
position must be exactly those of the original active loan. Amounts may vary where the specific flow permits, but the
asset types themselves may not. This is a substitution-protection rule for the continuing party: an original lender
kept on a transferred or offset loan is never exposed to a different collateral or repayment asset than the one they
underwrote, and an original borrower under a sold loan is never re-denominated into a different obligation. Where a
preclose path deliberately relies on this continuity plus same-or-higher collateral sizing instead of a fresh
transfer-time LTV / Health Factor gate, that design choice is made explicit in both code and documentation.


## 12. VPFI Token and Tokenomics

VPFI is Vaipakam's protocol token. In Phase 1 it serves two live functions — fee-discount utility for vaulted holders and the settlement asset for platform interaction rewards — with protocol governance deferred to Phase 2. VPFI is not a deposit product: holding it in a Vaipakam Vault earns no issuer-paid yield. The supply model is a hard on-chain cap with a single controlled mint path, enforced globally across every supported chain through the cross-chain transport described in Section 14.

### 12.1 Token Parameters

| Parameter | Value | Notes |
| --- | --- | --- |
| Name | Vaipakam DeFi Token | Standard ERC-20 metadata |
| Symbol | `VPFI` | Identical on every supported chain |
| Decimals | 18 | Standard ERC-20 precision |
| Standard | ERC-20; UUPS-upgradeable implementation with an on-chain hard-cap extension | Cap enforced natively in the token's transfer/mint hook |
| Total supply cap | 230,000,000 VPFI | `TOTAL_SUPPLY_CAP`, immutable constant |
| Initial mint | 23,000,000 VPFI (exactly 10% of cap) | Minted once at initialization to a multisig-plus-timelock treasury structure, never to a plain externally owned account |
| Mint access | Single `minter` role — expected to be `TreasuryFacet` (or a dedicated distributor) behind the protocol's timelocked multisig | No direct EOA minting; minter rotation and contract upgrades are owner-only, where the owner is the timelock-gated multisig |
| Canonical chain | Base (`VPFIToken`) | The only chain where the canonical token and its supply cap live |
| Mirror chains | `VPFIMirrorToken` — a Chainlink CCIP Cross-Chain Token (CCT) | Mint/burn callable only by the chain's registered CCIP token pool; no admin mint surface (Section 14.3) |

Because the canonical token's pool locks (rather than burns) on outbound bridging, the 230M cap enforced on Base is the global cap for the whole mesh: one VPFI locked on the canonical chain backs exactly one mirror VPFI minted elsewhere.

### 12.2 Allocation

| Category | % | Amount (VPFI) | Notes |
| --- | ---: | ---: | --- |
| Founders | 6% | 13,800,000 | 12-mo cliff; 48-mo total linear vesting inclusive of cliff |
| Developers & Team | 12% | 27,600,000 | Same vesting as founders |
| Testers & Early Contributors | 6% | 13,800,000 | 6–12 mo cliff |
| Platform Admins | 3% | 6,900,000 | Timelock controlled |
| Security Auditors | 2% | 4,600,000 | One-time on delivery |
| Regulatory Compliance Pool | 1% | 2,300,000 | One-time |
| Bug Bounty | 2% | 4,600,000 | Multisig-held operational treasury bucket |
| Exchange / Market Making | 12% | 27,600,000 | 50% liquidity / 50% locked |
| Ecosystem / Community / Marketing | 2% | 4,600,000 | 0 cliff + ~12–18 mo linear |
| Reserve (pending reallocation) | 24% | 55,200,000 | The 24% pool freed by the #687 excision; disposition governance-pending |
| Platform Interaction Rewards | 30% | 69,000,000 | Usage-based daily emission |
| **Total** | **100%** | **230,000,000** | Equals `TOTAL_SUPPLY_CAP` |

**Reserve note.** The 24% Reserve is exactly the reward pool freed when the #687 legal-surface excision removed the former yield program. That excision also removed a separately earmarked 1% fixed-rate-sale slice; because the sale program no longer exists, its 1% is dropped from the table entirely rather than carried into the Reserve — which is what brings the allocation to exactly 100% of the 230M cap. The Reserve's final disposition (held, burned to reduce the cap, or reallocated) is a pending governance decision; until governance acts, it is simply never minted.

**Mint-headroom semantics.** The people-facing pools (Founders, Developers & Team, Testers & Early Contributors, Ecosystem) are reserved mint headroom, not pre-minted balances. The 230M figure is a ceiling, not a mandatory issuance: an under-used pool stays unminted, lowering realized circulating supply. None of the non-founder pools ever reverts to the founder; repurposing long-unused headroom is a governance decision directed to community uses, never a founder transfer.

**Vesting.** Founder and team grants use per-grantee vesting wallets with OpenZeppelin `VestingWallet` semantics (the protocol's `VaipakamVestingWallet`): a 12-month cliff inside a 48-month total linear-vesting window — the 48 months are inclusive of the cliff, not appended to it. Testers and early contributors carry a shorter 6–12-month cliff because their contribution is front-loaded. The Ecosystem pool has no cliff and an approximately 12–18-month linear release, held by an ops/governance multisig rather than any individual's wallet, so launch-window ecosystem spending is possible before fee revenue funds it from treasury.

### 12.3 Fee-Discount Tiers

Depositing VPFI into a user's Vaipakam Vault qualifies the user for tiered discounts on the two protocol fees:

- the lender-side Yield Fee of `{liveValue:treasuryFeeBps}`%, charged on lender interest **and** late fees at settlement (both are lender yield economically, so both are in the fee base); and
- the borrower-side Loan Initiation Fee of `{liveValue:loanInitiationFeeBps}`% of the lending-asset amount, charged at loan initiation.

The same tier table applies to both sides:

| Tier | Vaulted VPFI balance | Discount |
| --- | --- | ---: |
| Tier 1 | ≥ `{liveValue:tier1Min}` and < `{liveValue:tier2Min}` | `{liveValue:tier1DiscountBps}`% |
| Tier 2 | ≥ `{liveValue:tier2Min}` and < `{liveValue:tier3Min}` | `{liveValue:tier2DiscountBps}`% |
| Tier 3 | ≥ `{liveValue:tier3Min}` and ≤ `{liveValue:tier4Min}` | `{liveValue:tier3DiscountBps}`% |
| Tier 4 | > `{liveValue:tier4Min}` | `{liveValue:tier4DiscountBps}`% |

A balance below `{liveValue:tier1Min}` VPFI is Tier 0 and receives no discount. The effective fee on either side is the base fee multiplied by one minus the applicable discount — for example, the effective Yield Fee is `{liveValue:treasuryFeeBps}`% × (1 − discount), and the effective initiation-fee outcome is `{liveValue:loanInitiationFeeBps}`% × (1 − discount), delivered on the borrower side as a rebate (Section 12.5). Tier thresholds and per-tier discount percentages are governance-tunable; the setter enforces monotonicity, so a higher balance can never earn a smaller discount, and every change is versioned so cached tier data on other chains cannot keep applying a superseded table.

Three qualifying rules bound the tier basis:

1. **Protocol-tracked balance only.** The tier reads the vault balance the protocol itself has accounted, clamped to the actual token balance. Unsolicited direct token transfers into a vault do not raise the tier.
2. **Explicit consent.** The user must enable a single platform-level on-chain consent flag before vaulted VPFI is used for fee discounts. With consent disabled the effective discount is zero regardless of balance.
3. **Canonical resolution.** The effective tier is resolved on the canonical chain (Base) from the user's canonical vaulted balance and propagated to supported mirror chains as an authenticated, versioned, expiring tier cache; mirrors apply the cached values rather than recomputing tier math locally.

Vault-held VPFI is a special non-collateral asset: it never counts toward collateral value, Health Factor, loan-to-value support, or liquidation value. Its only balance-linked protocol function is discount-tier eligibility.

### 12.4 Time-Weighted Discount Accumulator

The discount actually applied at fee settlement is **time-weighted**, not a point-in-time tier lookup. The protocol maintains a per-user discount accumulator: every mutation of the user's protocol-tracked vaulted VPFI balance closes the running accrual period at the tier that was in force and re-stamps the accumulator at the **post-mutation** balance. Fee settlement then applies the time-weighted average discount over the relevant holding window — for a loan-linked discount, the average across the loan's lifetime — rather than whatever the balance happens to be in the settlement block.

Re-stamping at the post-mutation balance is the load-bearing anti-gaming choice. Stamping at the pre-mutation balance would let a user withdraw down to Tier 0 and keep accruing at their old high tier until the next balance change; stamping after the mutation means a withdrawal takes effect immediately for every open position's average. Symmetrically, a deposit made just before settlement contributes only for the sliver of time it was actually held, so briefly topping up to capture a full-tier discount gains approximately nothing.

The canonical tier calculator adds further gates with governance-bounded parameters: a bounded multi-day balance-history window with recency weighting, a minimum-history requirement before a new depositor's tier becomes effective at all (a balance that returns to zero resets the history), and a clamp to the minimum tier observed over the history window, which defeats dust-then-bulk deposit patterns. Mirror-chain tier caches are nonce-ordered (a stale push can never overwrite a fresher entry), carry an expiry and a maximum age, and are invalidated wholesale when governance bumps the tier-table version.

### 12.5 Borrower LIF and Rebate

When the lending asset is liquid under the active chain's oracle and risk checks, the borrower has fee-discount consent enabled, holds sufficient protocol-tracked VPFI, and the governance-configured VPFI discount pricing route is active, the Loan Initiation Fee is paid through the VPFI path:

1. **Up-front custody.** At loan acceptance the protocol deducts the **full, non-discounted** `{liveValue:loanInitiationFeeBps}`% fee equivalent in VPFI from the borrower's vault into Diamond custody — not to treasury. Because the fee is satisfied entirely in VPFI, the borrower receives 100% of the requested lending asset, with no principal haircut.
2. **Settlement split on proper close.** On normal repayment, borrower preclose, or refinance, the held VPFI is split: the borrower's rebate equals the held amount multiplied by their time-weighted average discount (in basis points, over the loan's lifetime — Section 12.4) divided by 10,000; the remainder is treasury's share. The rebate attaches to the borrower-side position NFT and is paid out atomically with the ordinary borrower claim (`claimAsBorrower`), so a secondary-market holder of the position receives it.
3. **Forfeiture on failure.** On default or Health-Factor liquidation the borrower receives no rebate and the entire held VPFI is forfeited to treasury. For a loan created by a permissionless matcher, the matcher's configured share of the fee flow is paid first and the net is forfeited.
4. **Refinance.** The old loan's rebate is credited at settlement — the borrower earned that window fairly — and the new loan opens a fresh, independent discount window.

If any precondition fails (illiquid lending asset, insufficient VPFI, consent disabled, or the pricing route unconfigured), the loan falls back to the ordinary path: the fee is deducted in the lending asset and the borrower receives the net amount. The Diamond holds the custody VPFI untouched for the life of the loan; there is no intermediate transfer between acceptance and the terminal settlement or forfeiture.

This design deliberately delivers the borrower discount as an earned, claim-based rebate rather than a reduced up-front fee: the discount is realized only if the loan closes properly, and its size reflects the borrower's vaulted VPFI over the loan's whole lifetime rather than at a single gameable instant.

### 12.6 Acquiring VPFI

The protocol does not sell VPFI. The former issuer fixed-rate purchase program — including its cross-chain buy adapter, receiver, and dedicated CCIP buy channel — was removed in the #687 legal-surface excision, and no protocol purchase surface exists in Phase 1. Users acquire VPFI on the open market through DEX liquidity (seeded from the Exchange / Market Making allocation in Section 12.2) or other external distribution routes, and may move it between supported chains themselves using the standard CCIP Cross-Chain Token transport described in Section 14.3.

Once acquired, VPFI becomes protocol-useful by depositing it into the user's Vaipakam Vault (single-signature Permit2 where supported, with classic approve-plus-deposit as fallback). Vaulted VPFI qualifies the holder for the fee-discount tiers of Section 12.3 and is the asset in which interaction rewards (Section 13) and borrower rebates (Section 12.5) are paid. Users may withdraw their free, protocol-tracked VPFI balance at any time, net of collateral liens, offer locks, and claim-protection reservations.

VPFI is a utility token for fee discounts and reward infrastructure, with governance planned for Phase 2. Holding it in a vault is not a deposit product and pays no issuer yield; the protocol's VPFI surfaces are framed as deposit, hold, and withdraw.

### 12.7 Treasury Recycling

VPFI received by treasury as fees (the treasury share of borrower LIF custody, forfeited custody, and VPFI-paid lender yield fees) is recycled through a **governance-configurable** conversion path rather than a hard-coded split. Governance sets an ordered list of conversion targets, each with a per-target allocation in basis points that must sum to 100%, plus global eligibility thresholds — a minimum value in the protocol's active numeraire and a maximum interval since the last conversion — that gate when a conversion may run and prevent dust-sized executions. The historical 38 / 38 / 24 (ETH / wBTC / retained-VPFI) split sometimes cited for this flow is illustrative only; the launch allocation is a deploy-time governance choice. Converted output remains in protocol-controlled treasury custody and is never a user reward push.

The 2%-of-supply Bug Bounty allocation is a plain multisig-held operational treasury bucket, administered by the operator; any disposal of a surplus in that bucket is a deliberate multisig treasury action, not protocol behaviour.

Treasury buyback of VPFI remains dormant in Phase 1: no buyback allowed-token, budget, or committed intent is configured, and turning a buyback program on is a deliberate, separately reviewed governance decision. Governance may additionally deploy idle treasury assets into approved external yield venues under per-token exposure caps, with external principal and in-protocol balances kept separately visible.

## 13. Interaction Rewards

### 13.1 Reward Design

Platform interaction rewards are the protocol's usage-based incentive: 30% of total supply — 69,000,000 VPFI, hard-capped for this category — emitted daily against real lending activity. Emissions follow a front-loaded decay schedule expressed as an annualized emission rate applied to the 23,000,000 VPFI initial mint:

| Period | Annualized emission rate | Approx. daily pool |
| --- | ---: | ---: |
| Months 0–6 | 32% | ~20,164 VPFI |
| Months 7–18 | 29% | ~18,274 VPFI |
| Months 19–30 | 24% | ~15,123 VPFI |
| Months 31–42 | 20% | ~12,603 VPFI |
| Months 43–54 | 15% | ~9,452 VPFI |
| Months 55–66 | 10% | ~6,301 VPFI |
| Months 67–78 | 5% | ~3,151 VPFI |
| Month 79 onward | 5% | ~3,151 VPFI, until the 69M category cap is exhausted |

Each day's pool is split **50 / 50 between the two sides of the market**: half to lenders, each in proportion to the interest they earned that day relative to protocol-wide lender interest earned; half to borrowers, each in proportion to the interest they paid that day relative to protocol-wide borrower interest paid. The two proportions use **separate per-side global denominators** — the day's total lender-side interest and total borrower-side interest across every supported chain — because a single combined figure cannot support the split. The first emission day (day 0) is excluded from reward calculation.

Per-user daily rewards on each side are capped at 500 VPFI per 1 ETH-equivalent of eligible interest (equivalently 0.5 VPFI per 0.001 ETH-equivalent), valued through the protocol's on-chain pricing path. Amounts above the cap are not redistributed to other users; the remainder stays in the reward allocation. Once the 69,000,000 VPFI category cap is exhausted, emissions stop.

Eligibility is settlement-gated:

- borrower-side rewards are earned only on clean, full repayment — a defaulted or liquidated loan forfeits the borrower's accrued share, though its interest still counted in the day's denominator;
- lender-side rewards remain locked while the loan is active;
- in practice both sides' rewards, though computed from daily accounting, become claimable only after the relevant loan has closed.

Distribution is strictly pull-based through `claimInteractionRewards()`; the protocol never pushes rewards to wallets.

### 13.2 Cross-Chain Reward Mesh

The reward formula's denominators are protocol-wide, but the lending protocol is deployed as independent single-chain instances (Section 14), each seeing only its local interest flow. Computing against a local denominator would give users on a quiet chain an outsized share and dilute users on a busy one, so the protocol runs a reporter/aggregator mesh:

- **Reporters.** Every non-canonical deployment reports at day-close (triggered lazily by the first interaction of the next UTC day, or by a permissionless day-close poke). The payload carries three fields: the day identifier, the chain's total lender interest **earned** for the day, and the chain's total borrower interest **paid** for the day. The lender-side and borrower-side figures travel **separately** — each side of the 50/50 split needs its own global denominator, and a single combined number cannot reconstruct the two.
- **Aggregator.** Base accumulates the per-chain reports into the day's global lender-side and borrower-side denominators, finalized together as one record.
- **Finalization rule.** A day finalizes once **all expected chains have reported, or after a 4-hour grace window** past the end of the day (UTC), whichever comes first. A late-arriving report is recorded for audit but **never reopens a finalized day** — claim determinism is preserved absolutely.
- **Idempotency.** Each (day, source-chain) pair is accepted once; duplicates are rejected on the Base side, and reporters guard against re-emission with a last-reported-day check. Chain identity is keyed by plain EVM chain id throughout.
- **Broadcast and funding.** Once finalized, Base broadcasts the per-side denominator pair back to every mirror, where it becomes the local claim denominator. Separately — and deliberately decoupled from finalization — Base computes each chain's proportional slice of the day's VPFI pool (that chain's interest over the global total) and remits it to the mirror over the CCIP token path in a permissioned, batched, retriable send, bounded so total remittances plus Base's own payouts can never exceed the 69M pool. A stuck lane or a single failed delivery therefore never blocks finalization or other chains' funding.

Failure modes resolve conservatively. A chain that misses the grace window (for example an RPC outage) is treated as zero interest for that day; the omission is recorded in a missed-chain report keyed by day and chain id, and any make-good is a deliberate, governance-approved treasury action that still never reopens the finalized day. A delayed cross-chain packet delays the affected claims — it never loses them. Day boundaries are fixed to UTC on-chain, with small cross-chain timestamp drift absorbed inside the grace window.

### 13.3 Claiming

Claims are **local to each chain**: a user claims on the chain where they lent or borrowed, drawing on that deployment's remitted VPFI balance, with no cross-chain hop in the claim path. A claim for a given day is refused until that day's global denominator has been broadcast to the local chain, and the claim cursor advances only over the contiguous prefix of finalized days — a still-pending day pauses catch-up without discarding earlier finalized days. Per-call catch-up is bounded, so a long-absent user may need more than one claim transaction; the cursor persists, and nothing is lost between calls. The Claim Center in the connected app is the canonical claim surface, showing pending, lifetime-claimed, and per-loan contribution context. There are no automatic transfers: every reward movement to a user is a transaction the user initiates.

## 14. Cross-Chain Infrastructure

Only VPFI itself, reward-accounting messages, discount-tier cache messages, and approved treasury remittances cross chains. The lending, borrowing, and rental core protocol is strictly single-chain per deployment: loans, offers, collateral, repayment, claims, and liquidation never leave the chain they were created on. Base is the canonical chain for the token, the reward aggregator, and discount-tier resolution.

### 14.1 Messenger Architecture

Cross-chain messaging follows a strict port/adapter split. `ICrossChainMessenger` is the provider-agnostic port: every type in it is a Vaipakam type, chain identity is the plain EVM chain id (never a provider-specific selector or endpoint id), and no provider SDK type appears in the interface. Domain contracts — the reward messenger and remittance receivers — depend only on this port.

`CcipMessenger` is the **single** provider-aware adapter behind the port, and the one contract in the codebase that imports Chainlink CCIP libraries. It implements the outbound port and the CCIP inbound receiver, translating between EVM chain ids and CCIP chain selectors at its own boundary. Logical conversations between matched pairs of domain contracts are organized as *channels*; one deployed adapter per chain carries every channel and dispatches inbound messages to the registered local handler for each.

The rationale for the seam is provider mobility with bounded blast radius: the protocol previously ran on a different messaging provider, and the migration to CCIP replaced the adapter while leaving the domain contracts untouched. Any future provider swap repeats that shape — one adapter re-implemented, zero domain changes.

### 14.2 CCIP Security Model

Chainlink CCIP secures every message with three independent layers operated by Chainlink: a committing DON that commits message batches, an executing DON that delivers them, and the **Risk Management Network** — an independent network with a separate codebase and separate operators that re-verifies every message before execution. This security stack is uniform for every integrator: there is no per-integrator verifier set to select or configure, and therefore no insecure default to mis-set. (Verifier-selection models in which an integrator can ship with a minimal or misconfigured verifier set were the structural shape of a major 2026 bridge exploit; that configuration surface simply does not exist here.)

Integrator-side security is confined to explicit registry configuration on each `CcipMessenger`: the EVM-chain-id-to-CCIP-selector mapping, an allowlist of remote messenger addresses (the inbound sender must exactly match the registered remote messenger for the source chain), and per-channel remote peers. Both ends of a channel must be configured before a message flows; anything outside the allowlists is rejected, never silently dropped. Chain-selector and channel-handler mappings are enforced one-to-one — an action that would map one local chain to multiple remote identities is rejected rather than silently replacing state.

### 14.3 Token Transport

VPFI moves between chains as a CCIP **Cross-Chain Token (CCT)**, a model that separates the token from its transport pool. On Base, the canonical `VPFIToken` pairs with a stock CCIP `LockReleaseTokenPool`: outbound transfers lock canonical VPFI; inbound transfers release it. On every mirror chain, `VPFIMirrorToken` pairs with a stock `BurnMintTokenPool`: inbound delivery mints, outbound sending burns. The registered pool is the **only** address that can mint or burn a mirror token — there is no administrative or EOA mint surface — so each mirror chain's supply equals exactly the VPFI bridged in, and the 230M cap enforced on the canonical token remains the global cap for the whole mesh.

Every lane carries a token-bucket **rate limit** — a hard value-per-time cap that bounds the blast radius of any worst-case failure. Rather than subclassing the audited CCIP pool, the protocol registers `VpfiPoolRateGovernor` as each pool's rate-limit admin: a bounds-checked governor that permits limit changes only within compile-time minimum/maximum bands and **refuses to disable a lane's limit** through the routine governance path (removing a limit entirely would require a deliberate break-glass action by the pool owner, the governance timelock). Starting values are a capacity of 50,000 VPFI with a refill rate of approximately 5.8 VPFI per second per lane; lanes left at unlimited deployment defaults are treated as not production-ready. Off-chain monitoring watches lane, pool, peer, and rate-limit state for drift, checks the canonical-locked-versus-sum-of-mirrors supply invariant, and alerts on oversized single-transaction flows.

The Phase 1 production scope pairs the canonical Base deployment with Ethereum mainnet, Arbitrum, Optimism, and Polygon.

### 14.4 Pause and Recovery

Every cross-chain contract — the messenger, the mirror token, the pools' governor, the reward messenger, and the remittance receivers — inherits `GuardianPausable`, a two-role emergency-pause pattern covering **both the send and the receive paths**. The owner (the timelock-gated governance multisig) can pause, unpause, and rotate the guardian, all through the full governance path. The guardian — a smaller incident-response multisig with **no timelock** — can only pause. This closes the detect-to-freeze gap a timelock would otherwise impose during an incident, while keeping unpause deliberately owner-only: a compromised or impatient guardian cannot race the incident team to re-enable a live contract, and recovery always goes through governance.

The pause interacts safely with in-flight traffic. An inbound CCIP delivery to a paused contract reverts; CCIP records it as a **failed message that remains manually re-executable** once the contract is unpaused. Nothing is lost or silently dropped — a pause converts live risk into a queue of recoverable messages, and delayed value (reward remittances, bridged VPFI) resumes exactly where it stopped.

### 14.5 Cross-Chain VPFI Buy

There is no protocol-operated cross-chain VPFI purchase flow in Phase 1. The earlier design — a source-chain buy adapter that collected payment and forwarded fixed-rate buy requests over a dedicated CCIP channel to a canonical-chain receiver, with a two-step release and refund, park, and reclaim safety valves — fronted the issuer fixed-rate sale, and it was removed together with that sale in the #687 legal-surface excision. The adapter, receiver, and buy channel are no longer part of the deployed system.

Users who want VPFI on a particular chain acquire it on the open market (Section 12.6) and, where needed, move it themselves across supported chains through the standard CCT transport of Section 14.3, under the same rate limits, pause levers, and supply invariants as every other VPFI transfer. Cross-chain watchdogs accordingly focus on lane health, token-pool state, tier-propagation freshness, reward denominator and funding messages, and canonical-versus-mirror supply invariants — not on any purchase lane.

## 15. MEV Protection and Keeper Authorization

### 15.1 Threat Model

The protocol assumes that public-mempool visibility can create front-running, back-running, griefing, and
value-extraction attempts around user-specific transitions — loan sales, obligation transfers, refinance, preclose,
and fallback claim flows. It equally assumes a structural design risk: a single broad "bots allowed" flag can
accidentally convert a consensual helper model into an adversarial public-execution model, where automation a user
opted into for convenience becomes an open invitation for arbitrary third parties to execute against their position.
The mitigation stance is therefore: keep permissionless execution only where protocol safety requires it (liquidation
and default), keep all other third-party execution default-off, and when a user does opt in, scope that opt-in to
explicit whitelisted keeper addresses (at most 5 per user) and to narrowly defined authorized actions — never a
blanket permission. Consent is logged and auditable at three levels: user default-preference, offer, and loan.

### 15.2 What Is Enforced On-Chain

- **Oracle-anchored slippage floors.** For liquidation and settlement swaps, the on-chain oracle-derived minimum
  output is authoritative; keeper- or frontend-supplied `minOut` values may be stricter but can never weaken the
  configured floor. Marketplace prepay listings likewise carry an authoritative on-chain settlement floor that
  ask-side controls cannot underpay (§10.4).
- **Exact-scope approvals.** Each liquidation swap attempt approves only the exact input amount needed for that
  adapter and revokes the approval afterwards, success or failure — no persistent DEX allowances are left behind.
- **Deadline and expiry fields.** Offers may carry an optional expiry (good-till-time); refinance-tagged offers expire
  on-chain so a forgotten request cannot be accepted later, and completion is bounded by the reviewed rate ceiling;
  Dutch prepay listings enforce a minimum auction window and end no later than the loan's grace boundary;
  auto-lifecycle caps carry expiries and go stale when the position NFT transfers.
- **Term-bound acceptance.** Accepting an offer commits the acceptor to the exact economic terms of that offer,
  verified on-chain against the stored offer before any value moves; a loan-sale buyer's signature binds against the
  live loan's current principal, original duration, and a collateral floor (§11.3), so an interface cannot make a user
  agree to terms different from what they saw.
- **Holder-gated initiation.** Strategic initiations are gated to the current position-NFT `ownerOf` (§11.4), and
  cancel-cooldown rules delay zero-fill offer cancellations briefly after creation to reduce cancel-front-run risk
  against in-flight matches.
- **Per-action keeper permission bits.** Keeper authority is a bitmask of narrow per-action grants (`KEEPER_ACTION_*`
  — including `KEEPER_ACTION_INIT_PRECLOSE`, `KEEPER_ACTION_REFINANCE`, `KEEPER_ACTION_INIT_EARLY_WITHDRAW`,
  `KEEPER_ACTION_COMPLETE_LOAN_SALE`, `KEEPER_ACTION_COMPLETE_OFFSET`, `KEEPER_ACTION_EXTEND`,
  `KEEPER_ACTION_SIGNED_FILL`, `KEEPER_ACTION_AUTO_ROLL`), checked on-chain per call, alongside the per-user keeper
  whitelist, per-party caps, and the governance kill-switches — including a global delegated-keeper pause that freezes
  all third-party keeper activity while leaving owner-direct actions and permissionless liquidation untouched.

### 15.3 What Is Not Enforced On-Chain

The protocol documents its non-guarantees explicitly rather than implying protections it does not have:

- **Transaction ordering and mempool privacy.** The protocol cannot control public-mempool visibility or block-builder
  ordering. Mitigations such as private relays are operational choices for the submitting party; the public keeper-bot
  documentation covers MEV-protection options as operator guidance, not protocol enforcement.
- **Timing of permissionless actions.** Once a loan meets the documented conditions, liquidation, default triggering,
  permissionless matching, daily rental deduction, and stale-listing teardown may be executed by anyone at any
  eligible moment. The protocol constrains what these calls can do (deterministic terms, no caller discretion over
  pricing), not who calls them or when.
- **Best-effort automation.** Auto-refinance caps and posted refinance offers do not guarantee that a compatible
  lender accepts before the grace boundary; borrowers remain responsible for monitoring and acting manually. The
  auto-lend consent marker carries no on-chain fill enforcement of its own — pausing genuinely stops fills by
  cancelling (de-listing) the standing intent, not merely by clearing a flag — and pre-grace and checkpoint warnings
  from keeper infrastructure are advisory only.
- **Keeper selection.** Whitelisting a keeper address is the user's trust decision. The protocol bounds what a
  whitelisted keeper can do (role scope, per-action bits, caps, kill-switches, the never-a-party invariant) but cannot
  vet the off-chain operator behind an address.

### 15.4 The Four Execution Classes

The protocol classifies execution rights at the function level — `permissionless`, `party-only`, `keeper-initiation`
(per-action opt-in), and `keeper-optional` — instead of using one broad MEV/bot flag.

| Class | Functions (Phase 1) | Rule |
| --- | --- | --- |
| Permissionless | `triggerLiquidation`, `triggerDefault`, `repayLoan` (full repayment), `autoDeductDaily`, `matchOffers` (when the matching switch is enabled) | Open to any caller because the action is a protocol-safety function or a deterministic action with no caller discretion; full repayment by a third party never transfers collateral or claim rights. |
| Party-only | `createOffer`, `acceptOffer`, `cancelOffer`, `addCollateral`, `repayPartial`, `claimAsLender`, `claimAsBorrower`; all admin, treasury, NFT-ownership, vault-upgrade, pause, oracle-admin, and role-management functions | Executable only by the entitled party (or the appropriate role-gated authority); never keeper-executable. |
| Keeper-initiation (per-action opt-in) | `precloseDirect`, `transferObligationViaOffer` (including the offset variant it settles), `refinanceLoan`, `createLoanSaleOffer` (sale-listing initiation) | A whitelisted keeper may initiate on the consenting party's behalf only when that party has granted the matching narrow `KEEPER_ACTION_*` permission bit — one bit per flow, never a blanket grant. Without the bit, each function behaves as party-only. `addCollateral` deliberately stays party-only and is not keeper-initiable. |
| Keeper-optional (completion) | `completeLoanSale`, `completeOffset`, `extendLoanInPlace` (only when auto-extend is enabled and both current position-NFT holders have active, non-stale caps permitting the proposed terms) | Deterministic, already-authorized, non-discretionary completion steps. Any future keeper-enabled function must be explicitly documented as meeting that bar before joining this list. |

Cross-cutting invariants:

- **Keeper never a party.** Every keeper initiation executes strictly within the granting party's role, bounded by
  that party's configured caps and the protocol kill-switches, and can never make the keeper a loan party nor route
  funds, collateral, or claim rights to the keeper itself. Keepers are role-scoped delegates: a lender-approved keeper
  may execute only lender-side keeper-enabled actions, and a borrower-approved keeper only borrower-side ones; keeper
  approval never grants claim, withdrawal, or ownership rights — claims belong solely to the current position-NFT
  owner.
- **Liquidation is outside the model.** Liquidation remains fully permissionless for all users and never depends on
  keeper whitelists.
- **Not broadened.** Claims, offer creation/acceptance/cancellation (other than the specific keeper-initiation flows
  above), collateral top-ups, partial repayment, admin/treasury/upgrade functions, and any action changing terms,
  ownership, claim rights, or asset routing stay closed to keepers unless the acting wallet is the entitled party or
  holds that party's explicit narrow per-action grant for exactly that flow.
- **Disclosure requirement.** The frontend and documentation must clearly disclose, per function, whether it is
  permissionless, party-only, keeper-initiation (per-action opt-in), or keeper-optional, and logs must make clear
  which external address executed each action and under which consent path.

### 15.5 Auto-Lifecycle Consent

Auto-lend, auto-refinance, and auto-extend are convenience surfaces layered on the offer, refinance, and
keeper-authority model. All three **default off for every user, every loan, and every fresh deployment**, and each is
governed by an independent admin/governance kill switch; users can always revoke their own consent even while a
feature is globally disabled.

- **Auto-lend** is a per-user standing lender intent on a `(lending asset, collateral asset)` pair with lender-set
  bounds (maximum exposure, minimum fill, minimum rate, maximum initial LTV, maximum term). Enabling is an ordered,
  resumable sequence in which consent is recorded first and capital is funded last, so capital is never fillable
  before the required keeper delegation exists; pausing cancels the standing intent so fills genuinely stop, with
  un-lent capital resumable or withdrawable. Auto-lend is opt-in, best-effort, and never guaranteed execution.
- **Auto-refinance** caps are borrower-controlled terms. Default-cap copying into new loans is disabled for illiquid
  ERC-20 collateral and NFT-collateral loans — those may be enrolled only by explicit per-loan borrower action,
  because a failed match can end in full in-kind collateral transfer. A keeper-driven refinance may proceed only when
  the replacement offer is explicitly tagged with the target loan id, the cap setter is still the current
  borrower-position NFT holder, and the terms satisfy the capped rate and expiry; all old-loan fund flows route
  through the current borrower-position holder, never the keeper.
- **Auto-extend** is two-sided: the borrower-position and lender-position NFT holders must each enable extend caps,
  the proposed rate and expiry must fit the intersection of both sides' caps, and either NFT transferring makes that
  side's caps stale until the new holder resets them. On a valid extension, accrued interest settles first (treasury
  share plus lender remainder), borrower-side funds come from the current borrower-position holder's vault, and the
  keeper may receive only the configured gas-based reward.

## 16. Governance, Security, and Operations

### 16.1 Role Topology

Privileged authority over each Diamond deployment is split across three holders by blast radius:

| Holder | Authority | Character |
| --- | --- | --- |
| **Governance Safe** | `DEFAULT_ADMIN_ROLE` — the only actor that can grant or revoke roles | Multisig; proposes timelocked actions |
| **Admin Timelock** (`TimelockController`) | Delayed-action roles — `ADMIN_ROLE`, the oracle / risk / vault admin roles, `UNPAUSER_ROLE` — plus ERC-173 Diamond ownership | Every configuration change and upgrade waits out the delay in public |
| **Pauser / Guardian Safe** | `PAUSER_ROLE`, held directly with no delay | Fast incident lever only |

The split is asymmetric by design: the guardian can freeze the protocol immediately, but cannot
unfreeze it — `UNPAUSER_ROLE` sits behind the timelock, so a compromised or mistaken fast-pauser
cannot undo a freeze without the configured review delay. Role-gated surfaces are never keeper-
executable: all admin, treasury, NFT-ownership, vault-upgrade, pause, oracle- admin, and role-
management functions remain role-gated or owner-gated, and third-party keepers hold no Diamond role.

Key-rotation posture. The deploying hot key exists only to bootstrap: after handover it must
renounce every privileged role, and `DeployerZeroRolesTest` enforces "deployer holds zero roles" as
a cutover invariant. `AccessControlFacet.transferAdmin` provides a single-transaction role-and-
ownership handoff that relinquishes `DEFAULT_ADMIN_ROLE` last and rejects zero-address or self-
transfer targets. Handover preflight refuses to grant roles until bytecode is verified at the
configured Governance Safe, Pauser / Guardian Safe, and Timelock addresses — on mainnet, an
undeployed privileged recipient is a hard stop, because granting admin power to an empty address
after deployer renounce can make recovery impossible. Worker-side signing keys and API credentials
live in an account-level secret store, bound per Worker with least privilege, so each can be rotated
centrally and independently.

### 16.2 Pause Surface

**Global pause.** `PAUSER_ROLE` can freeze the protocol with a single boolean consulted by every
`whenNotPaused` entry point. The freeze is deliberately total for user-facing state changes: offer
creation and acceptance, loan initiation, repayment, claims, preclose, refinance, early withdrawal,
collateral changes, liquidation, and default triggering are all held (the gated set is pinned by
`PauseGatingTest`, which asserts the `EnforcedPause` branch across the lifecycle facets). What stays
available under global pause is the machinery needed to diagnose and recover: role management,
Diamond upgrades, oracle administration, vault-implementation upgrade administration, the pause /
unpause surface itself, and all view functions carry no pause gate. Unpause routes through
`UNPAUSER_ROLE` behind the timelock (Section 16.1); watcher-triggered `autoPause` paths are write-
only incident levers with no unpause authority. Fresh deployments are **born paused**: no user entry
point can execute while a multi-cut deployment is only partially wired, and automation unpauses only
after every cut, initializer, selector assertion, and verification phase has succeeded.

**Per-asset pause.** `pauseAsset` is the finer-grained, remove-only emergency lever. Pausing an
asset refuses new exposure — offer creation and acceptance involving that asset revert — while
close-out and claim paths for in-flight loans remain available, so counterparties are never trapped
in a position they can no longer exit. The `PerAssetPause` invariant suite asserts that a paused
asset blocks new create / accept across all flows, and pause tests cover the asymmetric role split
at the per-asset level too: the fast pauser cannot un- pause an asset any more than it can un-pause
the protocol.

**Cross-chain pause.** Every cross-chain contract with a runtime send or receive path carries
`GuardianPausable` — guardian-or-owner pause, owner-only (timelock) unpause — as described in
Section 14.

### 16.3 Timelock and Change Control

The timelock's default minimum delay is 48 hours (`DeployTimelock` deploys the `TimelockController`
with a 172,800-second default, overridable per deployment). Everything with lasting effect routes
through it once handover completes:

- **Facet cuts and upgrades** — ERC-173 Diamond ownership is timelock-held, so `diamondCut` is a
  scheduled, publicly visible action.
- **Configuration setters** — after handover, oracle, reward-reporter, NFT- URI, and swap-adapter
  configuration changes must be composed as timelock `schedule` / `execute` batches proposed by the
  Governance Safe rather than broadcast by an admin EOA.
- **Treasury and fee parameters** — treasury configuration and the fee, risk, and threshold knobs
  sit under `ADMIN_ROLE` and the risk-admin roles, which are timelock-held.
- **Swap-adapter registration** — production `addSwapAdapter` is a timelock- governed action after
  handover.

Deliberate exceptions stay off the delayed path: `PAUSER_ROLE` (a pause behind a 48-hour delay is
useless in a live exploit) and narrowly scoped operational roles whose blast radius is bounded, such
as the notification-biller role, which is separated from pause authority precisely so either can be
rotated independently.

**Bounded-range setter discipline.** Every mutable numeric knob has an explicit minimum / maximum
enforced on-chain through a shared typed range error — there is no unbounded governance setter.
Examples from the specification: risk parameters (`maxLtvBps` bounded to 10–100%, liquidation
threshold 15–100% and strictly above max LTV, reserve factor at most 50%), reward grace windows (5
minutes to 30 days), interaction caps, oracle staleness and deviation bounds, the loan-admission
health-factor floor (range- bounded to `[1.2, 2.0]`), and the six-slot grace schedule, whose setter
rejects wrong row counts, non-monotonic rows, and out-of-bounds values. Multi- value setters such as
the tier-LTV parameters and the numeraire rotation apply all-or-nothing, so no intermediate state
can mix inconsistent values. The `ConfigBounds` invariant suite exercises the bounded surface.

### 16.4 Compliance Posture

Wallets interacting with the protocol are screened against an on-chain sanctions oracle; flagged
wallets cannot open new positions. Close-out paths stay open regardless of either party's status, so
an unflagged counterparty can always be made whole.

### 16.5 Off-Chain Operations

Three Cloudflare Workers run alongside the protocol, split by duty so no surface holds more
credentials than its job needs:

- **Indexer** (`indexer.vaipakam.com`) — chain-to-archive ingestion. Scans the allow-listed Diamond
  event set from safe blocks, maintains a D1-backed projection of offers, loans, activity, and
  claimability, and serves read APIs. It holds RPC credentials only — no signing keys.
- **Keeper** (`keeper.vaipakam.com`) — autonomous write actions. Health-factor sweeps, alert
  dispatch, and (operator-enabled, off by default) permissionless liquidation submission and
  delegated auto-lend fills; the only Worker holding a transaction-signing key, and that key maps to
  no protocol role.
- **Agent** (`agent.vaipakam.com`) — read / index APIs, diagnostics endpoints, and the alert-
  subscription handshake.

Alerting is event-driven: borrowers can subscribe to per-loan health-factor thresholds, delivered
through a user-facing Telegram bot and Push Protocol. A separate ops-internal bot token serves
private operator alerts — cross-chain lane-configuration drift, rate-limit drift, supply imbalance,
oversized single-transaction flows, and nightly archive-backup outcomes — so a user-bot compromise
cannot spoof ops signals and vice versa. A public reference keeper bot is maintained for third-party
operators, who run their own keys and RPC endpoints.

None of this infrastructure is load-bearing for safety. The Workers are projections and conveniences
over on-chain state: money-moving decisions verify against the chain, liquidation is permissionless
for any caller, and every user action can be performed against the contracts directly. An outage
degrades freshness and convenience, not solvency or access.

### 16.6 Deployment Gates

A deployment must pass through layered gates before value can route through it:

1. **Pre-deploy check** — `predeploy-check.sh` runs the build, the deploy- sanity suite (Section
   18.1), shell-script lint, and a committed-ABI-versus- compiler parity check. It is wired as a
   preflight step inside every deploy script, so a deploy cannot proceed past a failing check.
2. **Full regression** — the complete Foundry suite runs before any testnet deployment; the mainnet
   path runs the pre-deploy gate in `--full` (regression-inclusive) mode, and a dedicated `mainnet-
   gate` CI workflow runs the same full gate.
3. **Born-paused wiring** — contracts deploy paused; unpause happens only after facet cuts,
   initializers, facet-count and selector-ownership assertions, and verification phases all succeed
   (Section 16.2). Post-deploy verification compares the live facet count to the recorded count
   exactly and resolves every routed selector back to its owning facet.
4. **Adapter registration** — a mainnet deployment must register at least one swap adapter before
   liquidation settlement can operate; with zero adapters, swap-based liquidation reverts outright
   rather than falling through to the collateral fallback path.
5. **Cross-chain cutover** — CCIP lanes enabled and each messenger's registry configured (chain-
   selector mappings, remote messengers, channel peers, token pools); per-lane rate limits set on
   every VPFI token pool through the bounds-checked rate-limit governor, which refuses to disable a
   lane's limit; and the Cross-Chain Token admin entry plus every cross-chain contract's ownership
   rotated to the governance path before real value routes.
6. **Admin handover** — the three-role topology installed with bytecode- verified recipients, the
   deployer's roles renounced, and `DeployerZeroRolesTest` green (Section 16.1).

Redeploy is guarded too: deployment phases refuse to overwrite an existing deployment by default,
mainnet redeploys require explicit purge and orphan- state confirmations after checking live offer /
loan counts, and every broadcasting phase re-runs its critical preflights (expected-chain
verification; hardware-signer attestation on mainnet) rather than trusting a stale marker.

As of July 2026 the protocol is deployed on testnets and local development networks only. Production
networks are gated behind the third-party audit described in Section 18.2.

## 17. Product Interfaces

### 17.1 Public Website and Connected App

The frontend is two surfaces with a deliberate boundary. The **public website** (`vaipakam.com`) is
the chain-free marketing and documentation surface: protocol education, FAQs and risk education, the
whitepaper and docs, the public VPFI utility page, public Terms and Privacy routes, and links into
the transparency surfaces. It loads no wallet context, no active-chain state, and no per-user
lookups; any "verify on chain" affordance hands off to the connected app's public transparency
route. The **connected app** (`defi.vaipakam.com`) hosts wallet-connected actions — dashboard, offer
book, offer creation, loan details, claim center, activity, VPFI vault, rewards, allowances, and
alerts — plus public-read shells (analytics, NFT verifier, protocol console) that work without
connecting a wallet. The app ships in ten locales with a Basic / Advanced mode toggle that controls
visibility and density, never policy. The technical whitepaper itself is maintained in English only;
long-form legal and guide content shows a clear English-only notice in other locales until locale-
matched source text exists.

### 17.2 Frontend as a Safety Layer

The frontend adds a safety layer on top of the contracts, but the contract layer never depends on
it: every consent the frontend collects is advisory UX except where the protocol itself enforces the
check on-chain, and every protocol action remains available to direct callers. Within that
principle, the interface is built to make risk legible before commitment:

- **Risk consent surfaces.** Offer creation and acceptance require one single mandatory combined
  Risk Disclosures and Terms acknowledgement covering abnormal-market fallback terms and illiquid
  full-collateral-in-kind terms together — and a ticked acknowledgement is void the moment any term
  of the offer changes, requiring a fresh one. Auto-lifecycle features (auto-lend, auto-refinance)
  require a two-step acknowledgement and keep a persistent best-effort warning while enabled.
- **Liquidity and settlement warnings.** Illiquid legs get an explicit warning above the consent
  block; the NFT verifier and loan details disclose whether an active loan would settle in-kind on
  default, resolved from the collateral's live on-chain liquidity rather than a stale init-time
  snapshot.
- **Simulation previews (advisory).** Before signing, supported flows simulate the pending
  transaction against the active chain and show simulated-OK, would-revert-with-reason, or preview-
  unavailable. The preview is a gas- safety aid that never blocks signing by itself; the wallet
  transaction and mined receipt remain the source of truth, and the copy avoids false-safe states
  before a real result arrives.
- **Fail-closed Terms gate.** Connected wallets may be required to accept the current Terms version
  and content hash before app routes open; while the acceptance check is loading the gated routes
  show a neutral verification state, and a failed read keeps the routes closed with a retry — a read
  failure is never treated as accepted. A disabled-gate state exists for testnet operation.
- **Counterparty and status warnings.** Repaying a loan from a wallet that is not the borrower shows
  a prominent warning before confirmation, and money- moving actions are gated by live on-chain loan
  status rather than the indexed row — the repay path re-checks status before any approval or wallet
  prompt.

### 17.3 Transaction Safety

Every write is wallet-approval centric: the app composes transactions, the user's wallet authorizes
them, and nothing signs on the user's behalf. For supported ERC-20 actions the app uses the
Permit2-first pattern — EIP-712 signatures against the canonical Permit2 deployment, 30-minute
expiry, exact asset / amount / spender scope — presented as a convenience that reduces wallet
popups, with automatic fallback to the classic approve-plus-action path when Permit2 is unavailable;
it is never a requirement to use the protocol. Success is receipt-confirmed: a mined transaction
with receipt status `0` is a failure, inclusion in a block is not a success signal, and receipt
parsing distinguishes semantically different outcomes of the same call. Failures decode into
readable revert reasons where possible, and a structured journey log records step start / success /
failure events across action paths so a support report can reconstruct exactly what happened; the
log is user- downloadable and user-clearable.

### 17.4 Transparency Surfaces

- **Public analytics dashboard.** No wallet required. A combined all-chains headline row (TVL with
  24h/7d change, active loans, lifetime volume and interest, NFTs rented) sits above chain-specific
  drill-downs behind a visible chain selector. Every metric derives from on-chain contract state or
  raw event logs — no PII and no off-chain warehousing — and each important number is traceable back
  to contract view calls, event logs, or explorer links, with CSV / JSON exports stamped with
  snapshot timestamp, contract addresses, and block number for verifiable provenance.
- **NFT verifier.** A public page where anyone — including a prospective secondary-market buyer —
  can check a position NFT: valid-live versus burned versus never-minted (with a chain-specific
  explanation when the token exists on a different chain), the position's side and terms, and the
  settlement-on- default caveat for in-kind positions.
- **Protocol console.** A read surface for live protocol configuration — fees, thresholds, tier
  tables, kill-switch states — read from the contracts' bundled config views rather than hardcoded
  copy, so a governance change appears on next page load. Admin cards compose Safe transactions
  rather than signing from the app; its public documentation lives on the marketing site.
- **Data-freshness indicators.** A top-bar freshness badge compares the chain's safe head against
  the freshest block reached by the indexer or the page's own RPC tail scan, distinguishing `Live`,
  `Live updating`, `Catching up`, `Behind`, and direct-RPC fallback states, with a per-lane operator
  breakdown in the diagnostics drawer. Tables link assets and NFTs to the active chain's explorer,
  and footer resource links land on the analytics transparency section listing deployed contract
  addresses.

## 18. Verification and Testing

### 18.1 Test Footprint

The contracts are tested with Foundry: 182 test files across the top-level facet suites and the
`deploy/`, `fork/`, `invariants/`, `scenarios/`, `seaport/`, and `token/` subdirectories, compiled
with the same `viaIR` + optimizer settings as production bytecode (Solidity 0.8.29, optimizer at 200
runs).

- **Unit and fuzz suites** cover each facet's lifecycle, the libraries, the vault implementation,
  the cross-chain messenger stack, and governance surfaces (access control, handover, pause gating,
  per-asset pause, config bounds, deployer-zero-roles). Fuzz tests run 1,000 runs per test.
- **Invariant suites** (19, at 100 runs each) assert protocol-wide properties under randomized call
  sequences: funds conservation, vault solvency and uniqueness, claim exclusivity, offer–loan
  linkage, loan-status and collateral monotonicity, self-dealing prevention, NFT owner authority and
  count parity, per-asset pause, the VPFI supply cap, and liquidation minimum- output caller
  insulation.
- **Deploy-sanity suite** (`test/deploy/`) — static guardrails that catch deploy-breaking mistakes
  in an ordinary test run: every facet's runtime bytecode within the EIP-170 24,576-byte limit,
  every external function actually cut into the Diamond with no 4-byte selector collisions, redeploy
  selector parity, and an integration test that runs the deploy script and loupe-asserts the built
  Diamond.
- **Scenario and fork suites** — eight end-to-end lifecycle scenarios (ERC-20 lending, NFT and
  ERC-1155 rental, illiquid collateral, early withdrawal, preclose, claim races) plus mainnet-fork
  tests for liquidation routing, oracle reads, the real canonical Permit2 deployment, and Seaport
  settlement.

CI runs in two lanes. The per-PR lane uses a narrow-scope compile profile (source, scripts, deploy-
sanity, scenarios) so every push is checked quickly; the full regression — the entire suite minus
the separately run invariant pass — is a pre-deploy gate, executed before any testnet deployment
and, together with the pre-deploy checks, by the dedicated mainnet-gate workflow (Section 16.6).
Static analysis with Slither runs in CI alongside the test lanes.

### 18.2 Review History and Audit Status

The protocol has been through repeated internal review rounds, tracked in `docs/FindingsAndFixes/`
and on the project board:

- **Internal adversarial security audit (July 2026).** An AI-assisted, pre- live adversarial audit
  of the full on-chain surface — roughly 80.5k lines across 156 Solidity source files: all facets,
  shared libraries, the per-user vault, the Diamond router, the cross-chain layer, swap adapters,
  and the token contracts — run as seven parallel domain audits against a shared trust model. It
  found no Critical issues; the crown-jewel surfaces (Diamond-cut authorization, upgrade gating,
  oracle staleness and scaling, cross-chain message authentication, token mint authorization, fee-
  custody flows) were verified sound, and the High / Medium / Low findings it did raise are tracked
  to resolution on the project board. Earlier internal rounds (April–July 2026) covered browser
  flows, naive-user UX, economic parameter modeling, and testnet reviews.
- **Spec-versus-code conformance.** The functional specifications in `docs/FunctionalSpecs/` are
  written as a code-independent test oracle — sourced from intent, never transcribed from the code —
  and `_CodeVsDocsAudit.md` is the living divergence log: every observed mismatch is recorded as
  either a candidate bug or a stale spec, and code-observed behaviour enters the spec only through
  an explicit owner intent-decision. A July 2026 conformance pass reconciled the tokenomics
  specification against the implementation, with the owner decisions recorded in the spec (dated
  2026-07-05).

These internal reviews are exactly that — internal. **They are not a substitute for an external
audit. A third-party security audit is required before mainnet launch on any network**, and current
deployments remain testnet and local only until that audit and launch approval are complete.

### 18.3 Responsible Disclosure

Security-sensitive reports go through the private channels in `SECURITY.md`: GitHub private security
advisories or encrypted email — never a public issue — with a 24-hour acknowledgement target and a
remediation ETA within 72 hours. A bug-bounty bucket exists as a multisig-held treasury allocation
(2% of VPFI supply), an operational funding reserve for the program whose public scope and reward
ranges are published separately.

## 19. References

1. EIP-2535: Diamonds, Multi-Facet Proxy — https://eips.ethereum.org/EIPS/eip-2535
2. ERC-20 Token Standard — https://eips.ethereum.org/EIPS/eip-20
3. ERC-721 Non-Fungible Token Standard — https://eips.ethereum.org/EIPS/eip-721
4. ERC-1155 Multi Token Standard — https://eips.ethereum.org/EIPS/eip-1155
5. ERC-4907 Rental NFT, an Extension of ERC-721 — https://eips.ethereum.org/EIPS/eip-4907
6. EIP-1967: Standard Proxy Storage Slots — https://eips.ethereum.org/EIPS/eip-1967
7. ERC-1822: Universal Upgradeable Proxy Standard (UUPS) — https://eips.ethereum.org/EIPS/eip-1822
8. Uniswap Permit2 — https://github.com/Uniswap/permit2
9. Chainlink Data Feeds — https://docs.chain.link/data-feeds
10. Chainlink CCIP (Cross-Chain Interoperability Protocol) — https://docs.chain.link/ccip
11. Adams, Zinsmeister, Salem, Keefer, Robinson: *Uniswap v3 Core* —
    https://uniswap.org/whitepaper-v3.pdf
12. 0x Protocol (Settler / AllowanceHolder) — https://0x.org/docs
13. Tellor — https://tellor.io/ ; API3 — https://api3.org/ ; DIA — https://www.diadata.org/
14. OpenZeppelin Contracts Upgradeable — https://github.com/OpenZeppelin/openzeppelin-contracts-
    upgradeable
15. Diamond-3 reference implementation (Mudgen) — https://github.com/mudgen/diamond-3-hardhat
16. Business Source License 1.1 — https://mariadb.com/bsl11/
17. Vaipakam repository documentation: `SECURITY.md`, `docs/FunctionalSpecs/`,
    `docs/TokenomicsTechSpec.md` — https://github.com/vaipakam/vaipakam (security reports:
    https://github.com/vaipakam/vaipakam/blob/main/SECURITY.md)

## License

The Vaipakam repository — the protocol codebase including the smart contracts, documentation, tests,
scripts, frontend code, and configuration — is licensed under the **Business Source License 1.1**
with Vaipakam as Licensor. The license grants the right to copy, modify, create derivative works,
redistribute, and make non-production use of the licensed work; production use beyond any Additional
Use Grant recorded in the `LICENSE` file requires a commercial license from the Licensor. On the
Change Date — five years after production deployment, or the fourth anniversary of the first
publicly available distribution of a given version, whichever comes first — the licensed work
converts to the **MIT** license. This whitepaper is part of the repository's documentation and ships
under the same terms; the `LICENSE` file at the repository root is authoritative.

