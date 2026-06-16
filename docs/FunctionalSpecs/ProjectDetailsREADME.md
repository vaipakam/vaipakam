# Vaipakam DeFi | Decentralized P2P Lending, Borrowing and NFT Rental Platform (Phase 1)

## Technical Project Details for Developers

Vaipakam is a decentralized peer-to-peer (P2P) lending and borrowing platform built for separate per-network deployments on Base, Polygon, Arbitrum, Optimism, and Ethereum mainnet. It facilitates lending and borrowing of ERC-20 tokens and rentable ERC-721/1155 NFTs, using any ERC-20 or NFT assets as collateral. The platform mints NFTs to represent offers and loans, ensuring transparency and traceability. This document outlines the technical architecture, smart contract interactions, and operational examples for Phase 1.

## Table of Contents

- [Vaipakam DeFi | Decentralized P2P Lending, Borrowing and NFT Rental Platform (Phase 1)](#vaipakam-defi--decentralized-p2p-lending-borrowing-and-nft-rental-platform-phase-1)
  - [Technical Project Details for Developers](#technical-project-details-for-developers)
  - [Table of Contents](#table-of-contents)
  - [1. Supported Assets and Networks (Phase 1)](#1-supported-assets-and-networks-phase-1)
    - [Lending and Collateral Assets](#lending-and-collateral-assets)
    - [Asset Viability, Oracles, and Liquidity Determination](#asset-viability-oracles-and-liquidity-determination)
  - [2. Loan Durations and Flexibility](#2-loan-durations-and-flexibility)
    - [Loan Terms](#loan-terms)
  - [3. Offer Creation](#3-offer-creation)
    - [Lenders:](#lenders)
    - [Borrowers:](#borrowers)
    - [Process:](#process)
    - [NFT Minting for Offers](#nft-minting-for-offers)
    - [Example:](#example)
    - [Frontend Warnings (Reiteration)](#frontend-warnings-reiteration)
  - [4. Offer Book Display](#4-offer-book-display)
    - [Frontend Implementation](#frontend-implementation)
    - [Range Orders and Permissionless Matching](#range-orders-and-permissionless-matching)
  - [5. Loan Initiation](#5-loan-initiation)
    - [Initiation:](#initiation)
    - [Smart Contract Actions:](#smart-contract-actions)
    - [Example:](#example-1)
  - [6. Loan Closure \& Repayment](#6-loan-closure--repayment)
    - [Repayment Logic](#repayment-logic)
    - [Late Fees](#late-fees)
    - [Treasury Fees](#treasury-fees)
    - [Claiming Funds/Assets](#claiming-fundsassets)
    - [NFT Status Updates on Closure](#nft-status-updates-on-closure)
    - [Example: ERC-20 Repayment](#example-erc-20-repayment)
  - [7. Liquidation and Default](#7-liquidation-and-default)
    - [Triggers](#triggers)
    - [Processes](#processes)
    - [NFT Status Updates on Default/Liquidation](#nft-status-updates-on-defaultliquidation)
    - [Example: ERC-20 Liquidation (Liquid Collateral)](#example-erc-20-liquidation-liquid-collateral)
    - [Example: NFT Renting Default](#example-nft-renting-default)
  - [8. Preclosing by Borrower (Early Repayment Options)](#8-preclosing-by-borrower-early-repayment-options)
    - [General Rules for All Borrower Preclose Options](#general-rules-for-all-borrower-preclose-options)
    - [Option 1: Standard Early Repayment](#option-1-standard-early-repayment)
      - [Process](#process-1)
      - [ERC-20 Loan Outcome](#erc-20-loan-outcome)
      - [NFT Rental Outcome](#nft-rental-outcome)
      - [NFT and Status Updates](#nft-and-status-updates)
    - [Option 2: Loan Transfer to Another Borrower](#option-2-loan-transfer-to-another-borrower)
      - [Participants](#participants)
      - [Purpose](#purpose)
      - [Preconditions](#preconditions)
      - [Economic Protection for the Original Lender](#economic-protection-for-the-original-lender)
      - [Shortfall Formula](#shortfall-formula)
      - [Smart Contract Actions](#smart-contract-actions-1)
      - [Funds Flow](#funds-flow)
      - [Final Outcome](#final-outcome)
    - [Option 3: Offset with a New Lender Offer (Original Borrower Becomes a Lender)](#option-3-offset-with-a-new-lender-offer-original-borrower-becomes-a-lender)
      - [Participants](#participants-1)
      - [Purpose](#purpose-1)
      - [Preconditions](#preconditions-1)
      - [Economic Protection for the Original Lender](#economic-protection-for-the-original-lender-1)
      - [Shortfall Formula](#shortfall-formula-1)
      - [Flow (atomic on match)](#flow-atomic-on-match)
        - [Step 1: Enter the Offsetting Lender Position](#step-1-enter-the-offsetting-lender-position)
        - [Step 2: Atomic offset completion when the offsetting offer is accepted](#step-2-atomic-offset-completion-when-the-offsetting-offer-is-accepted)
      - [Required Settlement Result](#required-settlement-result)
      - [NFT and State Updates](#nft-and-state-updates)
      - [Final Outcome](#final-outcome-1)
  - [9. Early Withdrawal by Lender](#9-early-withdrawal-by-lender)
    - [General Rules for All Lender Early Withdrawal Options](#general-rules-for-all-lender-early-withdrawal-options)
    - [Option 1: Sell the Loan to Another Lender](#option-1-sell-the-loan-to-another-lender)
      - [Participants](#participants-2)
      - [Purpose](#purpose-2)
      - [Preconditions](#preconditions-2)
      - [Economic Treatment](#economic-treatment)
        - [Accrued Interest](#accrued-interest)
        - [Principal Recovery](#principal-recovery)
        - [Rate Difference / Shortfall Handling](#rate-difference--shortfall-handling)
        - [Frontend Warning](#frontend-warning)
      - [Smart Contract Actions](#smart-contract-actions-2)
      - [Borrower Impact](#borrower-impact)
    - [Option 2: Create a New Offer Through the Borrower-Offer Path](#option-2-create-a-new-offer-through-the-borrower-offer-path)
      - [Purpose](#purpose-3)
      - [Offer Characteristics](#offer-characteristics)
      - [Required Documentation in the Protocol](#required-documentation-in-the-protocol)
      - [Intended Economic Result](#intended-economic-result)
      - [Acceptance Outcome](#acceptance-outcome)
    - [Option 3: Wait for Loan Maturity](#option-3-wait-for-loan-maturity)
      - [Process](#process-2)
      - [Outcome](#outcome)
    - [Implementation Checklist for Preclose and Early-Withdrawal Flows](#implementation-checklist-for-preclose-and-early-withdrawal-flows)
  - [10. Governance and VPFI Token Rollout](#10-governance-and-vpfi-token-rollout)
    - [Phase 1 Token Deployment and Minting](#phase-1-token-deployment-and-minting)
    - [Governance (Phase 2)](#governance-phase-2)
    - [Treasury and Revenue Sharing](#treasury-and-revenue-sharing)
    - [VPFI Token Distribution](#vpfi-token-distribution)
    - [VPFI Multi-Chain Deployment](#vpfi-multi-chain-deployment)
  - [11. Notifications and Alerts](#11-notifications-and-alerts)
    - [Implementation](#implementation)
  - [12. User Dashboard](#12-user-dashboard)
    - [Features](#features)
  - [13. Technical Details](#13-technical-details)
    - [Blockchain and Networks (Phase 1)](#blockchain-and-networks-phase-1)
    - [Smart Contracts](#smart-contracts)
    - [Frontend](#frontend)
    - [Public View Functions for Analytics, Transparency, and Integrations](#public-view-functions-for-analytics-transparency-and-integrations)
      - [1. Protocol-Wide Metrics](#1-protocol-wide-metrics)
      - [1a. Protocol Configuration and Constants](#1a-protocol-configuration-and-constants)
      - [2. Treasury and Revenue Metrics](#2-treasury-and-revenue-metrics)
      - [3. Lending and Offer Metrics](#3-lending-and-offer-metrics)
      - [4. NFT and Vault Metrics](#4-nft-and-vault-metrics)
      - [5. Oracle and Risk Metrics](#5-oracle-and-risk-metrics)
      - [6. User-Specific Metrics](#6-user-specific-metrics)
      - [7. Compliance and Transparency Helpers](#7-compliance-and-transparency-helpers)
      - [Why these view functions add real value](#why-these-view-functions-add-real-value)
    - [Testing and Auditing](#testing-and-auditing)
      - [Positive-flow coverage map](#positive-flow-coverage-map)
  - [14. Initial Deployment and Configuration (Phase 1)](#14-initial-deployment-and-configuration-phase-1)
  - [15. NFT Verification Tool](#15-nft-verification-tool)
    - [Purpose](#purpose-4)
    - [Features](#features-1)
    - [Implementation](#implementation-1)
  - [16. Regulatory Compliance Considerations](#16-regulatory-compliance-considerations)
    - [Measures for Phase 1](#measures-for-phase-1)
  - [Summary (Phase 1)](#summary-phase-1)
  - [Phase 1 Additions: Borrower Collateral Management \& Refinancing](#phase-1-additions-borrower-collateral-management--refinancing)
    - [Allow Borrower to Add Collateral](#allow-borrower-to-add-collateral)
    - [Allow Borrower to Withdraw Excess Collateral (Health Factor)](#allow-borrower-to-withdraw-excess-collateral-health-factor)
    - [Allow Borrower to Choose New Lender with Compatible Offer While Protecting the Original Lender (Refinance - ERC-20 Loans Only)](#allow-borrower-to-choose-new-lender-with-compatible-offer-while-protecting-the-original-lender-refinance---erc-20-loans-only)
      - [Original Lender Protection Rule for Refinance](#original-lender-protection-rule-for-refinance)
  - [New features](#new-features)
  - [Developement Approach](#developement-approach)
- [Special Note](#special-note)
  - [Security Note:](#security-note)
  - [Other Notes:](#other-notes)
  - [License](#license)

## 1. Supported Assets and Networks (Phase 1)

### Lending and Collateral Assets

**Lending Assets:**

- **ERC-20 Tokens:** Any ERC-20 token (e.g., USDC, ETH, WBTC) on Base, Polygon, Arbitrum, Optimism, or Ethereum mainnet.
- **Rentable ERC-721/1155 NFTs:** Unique NFTs that are ERC-4907 compliant (like NFTs from Warena and Axie Infinity) which can be rented (NFTs in which `setUser` and `userOf` functions can be called) with lender-specified daily rental charges.
  - For ERC-721 tokens, the token is transferred into the Vaipakam Vault contract during the rental period. This gives the Vaipakam admin/vault controller vault-controlled owner/custody access so it can assign, revoke, or reassign only ERC-4907 `user` rights while keeping the borrower limited to temporary `user` access. The borrower never receives custody or ownership of the ERC-721 token itself.
  - For ERC-1155 tokens, the tokens will be held in the Vaipakam Vault contract during the rental period. The Vaipakam admin/vault controller assigns ERC-4907-style user rights to the borrower while the token remains vault-controlled, so a borrower preclose or transfer changes only the temporary user assignment and not the underlying custody model.
- For third-party integrations, Vaipakam Vault should act as the stable ERC-4907-style wrapper / adapter for vaulted rental positions. External apps may query the vault contract with the underlying NFT contract address and token ID to retrieve the current user, user expiry, and, for ERC-1155 rentals, the active aggregate rented quantity for that same token ID within that same ERC-1155 NFT contract under the queried vault. If more than one active rental exists for the same ERC-1155 contract and token ID within that vault, the reported expiry should be the minimum (earliest) active rental expiry for that aggregated position. This means integrations should not assume the underlying NFT contract itself exposes a uniform rental interface for both ERC-721 and ERC-1155 in the same way; the vault contract is the intended integration surface for rental-state reads.

**Collateral Assets:**

- Any ERC-20 tokens or ERC-721/1155 NFTs for ERC-20 Lending.
- Only ERC-20 tokens for NFT Lending/Renting.
  - Rationale: NFT lending in Phase 1 is a rental-style transaction, not a custody transfer to the borrower. The rented NFT remains inside Vaipakam Vault for the full rental period, and the borrower receives only temporary ERC-4907-style user rights. Because the NFT itself remains vault-controlled and can be returned to the lender directly at rental closure or default, an additional NFT collateral layer is not required for NFT renting.

**Supported Networks (Phase 1):**

- Ethereum Mainnet
- Base Network
- Polygon Network
- Arbitrum Network
- Optimism Network

_Note: For Phase 1, all lending, borrowing, and collateralization activities for a specific loan must occur on a single network (e.g., a loan initiated on Polygon must have its collateral and repayment on Polygon)._

The chain-indexer and public analytics support layer may also fan out across the broader configured mainnet and testnet chain lists used by deployment metadata. A chain is active for indexing only when it is included in the explicit deployment allow-list, has an exported deployment artifact, and has the required Worker RPC secret configured. Retired or non-allow-listed chain folders may be skipped without breaking other chains, but an allow-listed chain missing its RPC secret is an operator configuration error that deployment preflight should hard-fail.

### Asset Viability, Oracles, and Liquidity Determination

The platform distinguishes between liquid and illiquid assets, which affects how defaults and LTV calculations are handled.

- **Liquid Asset Criteria:** For Phase 1, an ERC-20 token is considered "Liquid" on a given network only if:
  1.  It has a usable on-chain price path on the active network: preferably through the configured PAD / numeraire oracle path, with direct vetted `asset/<numeraire>` overrides allowed where governance has explicitly configured them.
  2.  It can pass the active-chain slippage-at-floor liquidity check: selling the governance-configured floor size (default `$5,000` PAD value) through the best configured route must not execute more than the configured slippage budget (default `2%`) below the trusted Chainlink-led spot price.
  3.  The route search should consider configured `asset/WETH`, `asset/USDC`, and `asset/USDT` pools across supported V3-clone factories and V2-fork factories, using eligible V3 fee tiers up to `0.3%`. A pool that exists only at a deliberately excluded high-fee / dust-prone tier such as `1%` must not qualify an asset as liquid by itself.
  4.  Liquidity must be judged only from the current active network's own oracle and pool availability. Ethereum mainnet must not be consulted as a reference or fallback network for this decision. If the active network fails the liquidity check, the asset is treated as illiquid on that network and the protocol must not perform any additional mainnet verification to override that result.
- **Illiquid Assets:**
  - All ERC-721 and ERC-1155 NFTs are considered "Illiquid" by the platform for valuation and LTV purposes. Their platform-assessed value is $0.
  - ERC-20 tokens that do not meet both criteria for a Liquid Asset are considered "Illiquid".
- **NFT Valuation for Collateral (Lender's Discretion):**
  - The Vaipakam platform does not perform any valuation for NFT collateral due to their volatile and auction-driven nature. For LTV calculations and systematic risk assessment, NFTs used as collateral are assigned a value of zero.
  - Lenders can still specify an NFT as required collateral. The decision to accept such terms rests entirely with the borrower.
- **Oracle Usage:**
  - **Chainlink Price Feeds:** Used to provide real-time pricing for Liquid ERC-20 assets in the active protocol numeraire. This is crucial for LTV calculations, liquidation processes, KYC threshold checks, and governance-denominated comparisons.
  - **Hybrid Price Retrieval:** For ERC-20 pricing the protocol prefers a direct Chainlink `asset/<numeraire>` feed. Only when no direct feed exists does it fall back to `asset/ETH × ETH/<numeraire>`.
  - **Per-Feed Overrides:** Oracle admins may configure a per-feed staleness budget and minimum-valid-answer floor for critical Chainlink aggregators. A configured override takes precedence over the global freshness defaults and can be cleared by setting the override staleness back to zero.
  - **Secondary Oracle Quorum:** Chainlink remains the primary pricing path. Where configured, Tellor, API3, and DIA act as symbol-derived secondary price sources. The protocol applies a Soft 2-of-N rule: if every secondary is unavailable, Chainlink is accepted; if at least one available secondary agrees with Chainlink within the configured deviation bound, Chainlink is accepted; if one or more secondaries disagree and none agree, pricing reverts for that asset.
  - **No Per-Asset Secondary Oracle Mapping:** Tellor, API3, and DIA keys are derived from the ERC-20 symbol where possible, avoiding secondary-oracle configuration that would require one governance mapping entry per asset.
  - **Quote Assets for Liquidity Classification:** WETH remains the primary route asset for liquidity checks, and the protocol may also use configured deep stablecoin quote assets such as USDC and USDT. WETH routes use the configured Chainlink `ETH/<numeraire>` feed where conversion is needed; stablecoin routes use the active PAD / numeraire path and the same manipulation guards.
  - **WETH Special Case:** WETH itself is priced directly from `ETH/<numeraire>` and is treated as the quote asset for liquidity purposes; the protocol does not perform a circular `WETH/WETH` liquidity check.
  - **Pyth Cross-Check Redundancy:** A single Pyth feed per chain may sanity-check the Chainlink ETH / quote-asset feed used by the primary path. This feed is a cross-oracle divergence check, not the protocol's governance numeraire selector. If the Pyth feed is unset, stale, low-confidence, or non-positive it soft-skips; if it is configured and diverges beyond the governance-bounded threshold, pricing must revert fail-closed with a typed cross-check-divergence error.
  - **Oracle-Layer Governance Numeraire:** The active protocol numeraire is defined by oracle-layer inputs: `ethNumeraireFeed` for Chainlink ETH/<numeraire>, `numeraireChainlinkDenominator` for Feed Registry direct lookups, `numeraireSymbol` for symbol-derived Tellor / API3 / DIA queries, and `pythCrossCheckFeedId` for the optional Pyth ETH/<numeraire> cross-check. Empty `numeraireSymbol` falls back to `usd` so existing USD deployments behave unchanged.
  - **Predominantly Available Denominator (PAD):** To avoid silently relying on sparsely covered or lower-rated non-USD Chainlink feeds after a non-USD numeraire rotation, the primary oracle path may pivot through a governance-configured PAD. The post-deploy default PAD is USD. When PAD equals the active numeraire, pricing collapses to the ordinary direct `asset/<numeraire>` read. When PAD differs, the protocol should read `asset/PAD` using Chainlink's dense feed set, then convert PAD to the active numeraire through either a direct `PAD/<numeraire>` feed or a derived `ETH/<numeraire> ÷ ETH/PAD` rate.
  - **PAD Configuration:** PAD is configured atomically through `setPredominantDenominator(newDenominator, newSymbol, newEthPadFeed, newPadNumeraireRateFeed)`. `predominantDenominator`, `predominantDenominatorSymbol`, and `ethPadFeed` are load-bearing; `padNumeraireRateFeed` is optional because the protocol can derive the FX rate when the direct feed is unavailable. Deploy scripts should configure PAD before opening offers.
  - **Direct Numeraire Feed Overrides:** Operators may opt a specific asset into a vetted direct `asset/<numeraire>` Chainlink feed through `setAssetNumeraireDirectFeedOverride(asset, feed)`. This is an explicit governance-curated override; the protocol does not infer feed quality from off-chain Chainlink rating metadata.
  - **Comparison Unit Policy:** `OracleFacet.getAssetPrice` should return prices in the active numeraire. LTV / HF math is ratio-based, so the chosen unit cancels out. Absolute-value comparison sites such as KYC threshold checks compare numeraire-priced asset values against numeraire-denominated stored thresholds directly. A separate `INumeraireOracle` / `numeraireToUsdRate1e18()` boundary-conversion interface is not part of the active design.
  - **Secondary Oracle Query Numeraire:** Tellor, API3, and DIA secondary checks should query consistently with the configured price path and symbol helpers rather than hardcoding `asset/USD`. PAD-side secondary-query enrichment may be extended in a follow-up; unavailable secondaries continue to soft-skip according to the existing quorum rule.
  - **USD-Specific Stable Peg Check:** Stablecoin peg validation may remain USD-bound for assets explicitly registered as USD stables because the safety question is whether the asset still tracks `$1`. This is separate from the protocol-wide numeraire used for ordinary asset pricing.
  - **Bounded Oracle Knobs:** Pyth oracle address, Pyth cross-check feed id, Pyth staleness, Pyth cross-check deviation, Pyth confidence, secondary-oracle staleness, and secondary-oracle deviation setters must be range-bounded. Invalid values should revert through the shared `ParameterOutOfRange(bytes32 name, uint256 value, uint256 min, uint256 max)` error so admin misconfiguration is visible and easy to audit.
    - `pythOracle`: non-zero contract address, or zero to disable.
    - `pythCrossCheckFeedId`: non-zero feed id, or zero to disable.
    - `pythMaxStalenessSeconds`: 60 to 3600 seconds, default 300.
    - `pythCrossCheckMaxDeviationBps`: 100 to 2000 bps, default 500.
    - `pythConfidenceMaxBps`: 50 to 500 bps, default 100.
    - `secondaryOracleMaxDeviationBps`: 100 to 2000 bps.
    - `secondaryOracleMaxStaleness`: 60 seconds to 29 hours.
    - `predominantDenominator`: non-zero Chainlink Feed Registry denomination.
    - `ethPadFeed`: non-zero Chainlink ETH/<PAD> feed.
  - **Peg-Aware Stable Staleness:** Stable and reference feeds may remain valid out to the protocol's longer stable staleness ceiling only when the reported price remains within tolerance of either the implicit USD `$1` peg or a governance-registered fiat / commodity reference such as `EUR/USD`, `JPY/USD`, or `XAU/USD`.
- **Slippage and Depth-Tiered LTV Risk Model:**
  - The detailed autonomous-LTV design rationale and peer-protocol comparison lives in `docs/DesignsAndPlans/AutonomousLtvAndOracleFallback.md`; this functional spec captures the product and protocol requirements that implementation surfaces must satisfy.
  - The protocol should maintain a pure slippage calculation library that answers the liquidation-relevant question: how far below the oracle price a sale of a given PAD-denominated size would execute against a candidate pool. Uniswap-V2-style pools should be modeled exactly; Uniswap-V3-style pools may use the pool's current notional reserves as a cheap on-chain approximation, with exact tick-walking left to off-chain keepers and audit tooling.
  - The baseline liquid / illiquid gate must use that same slippage machinery at the configured floor size rather than a depth-at-current-tick metric. This rejects manipulated or concentrated-at-spot pools that cannot absorb a real floor-sized sell, while allowing deep V2 liquidity to qualify assets even when no V3 pool exists.
  - The oracle / risk surface should expose an on-chain liquidity tier for ERC-20 collateral where `0` means illiquid or untierable and tiers `1` through `3` represent progressively deeper markets. Default tier probes are `$5k`, `$50k`, `$500k`, and `$5M` PAD-sized sells, with every test size governance-configurable within bounded ranges.
  - Tier resolution should search over governance-configured predominantly available quote assets, including WETH and deep stablecoins for the active chain, across configured low-fee V3-style pools and supported V2-fork pools.
  - Two anti-manipulation guards must gate both baseline liquidity classification and tier resolution: the pool spot price must agree with the trusted Chainlink-led oracle path, and, where the pool exposes usable price history, its recent average must agree with the current pool price within a bounded governance band.
  - There must be no governance per-asset allowlist that upgrades a collateral asset into a higher tier. Governance may pause or blacklist assets through existing remove-only safety levers, but tier authority comes from the on-chain measurement plus the keeper confidence floor below.
  - The effective tier is `min(onChainTier, keeperConfidenceTier)`. New assets default to keeper tier `1`; a keeper can lower an asset immediately and can promote only up to the on-chain-measured tier after off-chain aggregator checks have remained healthy. The keeper role must not be able to raise an asset above what the on-chain route and manipulation guards validate.
  - Depth-tiered LTV is controlled by a master enable switch that deploys disabled. While disabled, loan initiation must follow the existing conservative LTV / Health Factor behavior exactly.
  - When the switch is enabled, new ERC-20 loans are capped at the smaller of the existing asset ceiling and the effective tier's current max-init-LTV value. Tier `0` collateral cannot support a new borrow. In this mode the loan-initiation Health Factor floor may be relaxed from `1.5` to `1.0` because the tier ceiling becomes the binding buffer below liquidation.
  - The tier-to-LTV mapping is data-derived rather than manually set per asset. `OracleFacet.refreshTierLtvCache()` should be permissionless and should refresh per-tier cached max-init-LTV values from peer lending protocol configurations. The cache is fresh for `14 days`; after that, loan initiation falls back to library defaults of `50%`, `62%`, and `73%` for tiers `1`, `2`, and `3`, respectively. A cache-stale-warning event should fire when values are older than `7 days` but still usable.
  - Peer LTV reads should normalize Aave V3 and Compound V3 values into BPS through low-level staticcalls that return clean `ok = false` flags for not-listed or reverted reads. Aave reserves must be active and not frozen; Compound asset info must match the queried asset. Morpho Blue support is a planned follow-up because market-id enumeration is per market rather than per asset.
  - Each tier refresh should read configured reference assets against configured peer protocols, accept a reference asset only when at least two peers agree within `15` percentage points, then accept a tier only when at least two reference assets contribute. The tier candidate is the resulting median minus the tier haircut.
  - Per-tier safety boxes are the constitutional bounds for autonomous LTV values. Defaults are Tier 1 `[37%, 55%]`, Tier 2 `[55%, 69%]`, and Tier 3 `[69%, 82%]`; Tier 1 and Tier 2 default to `0` haircut, Tier 3 defaults to a `5` percentage-point haircut. A candidate outside its tier's box must be rejected and emitted as a refresh-rejection reason rather than clipped into range.
  - `ConfigFacet.setTierLtvParams` may update all three `(floor, ceiling, haircut)` triples atomically. Validation must enforce floor < ceiling, ceiling <= 100%, haircut <= 10 percentage points, no overlapping boxes (`tier1.ceiling <= tier2.floor`, `tier2.ceiling <= tier3.floor`), and all-or-nothing application. Post-handover this setter is Timelock-controlled.
  - Governance knobs for baseline floor size, slippage budget, tier test sizes, tier safety boxes, tier haircuts, price-history window, price-history agreement band, predominantly available asset list, keeper confidence tier, peer protocol addresses, reference asset lists, cache TTL, and the master switch must be bounded and auditable through the shared typed range-error pattern. Emergency levers remain remove-only or global: `pauseAsset`, `setDepthTieredLtvEnabled(false)`, and `autoPause`.
- **Liquidity Determination Process & On-Chain Record:**
  1.  **Frontend Assessment:** The frontend interface should attempt to assess asset liquidity by checking the active network only: a valid price path and the protocol's slippage-at-floor liquidity result across configured quote assets and V2 / V3 pool families. If the active network fails the liquidity test, the frontend must treat the asset as illiquid on that network and stop there; it must not perform any Ethereum-mainnet fallback verification and must not redirect the user to another network.
  2.  **User Acceptance (Frontend - Risk and Terms Consent):** Before a user creates or accepts an offer, the frontend must require one combined Risk Disclosures and Vaipakam Terms acknowledgement. The disclosure should be compact and should state in substance that if liquidation cannot execute safely, the lender may receive collateral in-kind instead of the lending asset; if oracle pricing is unavailable or either loan asset is illiquid, the lender may receive all collateral regardless of market value; recovery may be materially less than the asset lent; and proceeding records a binding agreement for the life of the position. Detailed fallback branch mechanics should be explained in the Advanced User Guide and FAQ rather than embedded in the consent text. The transaction must not proceed without this consent, and the consent must be recorded for the relevant offer and resulting loan. It is acceptable for the resulting loan to store the combined accepted-by-both-parties consent state rather than two separately stored per-party consent fields, because the consent is mandatory for both lender and borrower.
  3.  **On-Chain Verification (Smart Contract):**
      - When an offer involving an ERC-20 asset (as a lending asset or collateral) is being created or accepted, and the frontend has _not_ marked it as illiquid, the smart contract will perform an on-chain check.
      - For Phase 1, this check should confirm both: a reliable price-validation path and a successful active-chain slippage-at-floor route over the configured V2 / V3 pool families and quote assets.
      - Ethereum mainnet must not be consulted as a reference or fallback network. The on-chain check uses only the active network's Chainlink registry / direct feeds and configured active-network pool factories.
      - In practice, that means a valid Chainlink-led price path, a manipulation-guarded pool price, and at least one route whose simulated floor-sized sell remains within the configured slippage budget before the asset is treated as liquid for transactions on that network.
      - A later protocol phase may split these concepts more explicitly into separate statuses such as "priceable" and "liquidatable", but Phase 1 should use the stricter combined rule for safety.
      - If the active network fails this check, the asset is classified as illiquid on that network. The protocol must not perform a second mainnet verification pass and must not use mainnet liquidity to authorize or reshape the active-network decision.
      - **On-Chain Precedence:** If the on-chain check determines the asset is illiquid (e.g., missing price feed or DEX pool), this on-chain determination overrides any prior assessment by the frontend. The user will then be required to accept the same single mandatory risk-consent acknowledgement, which in this case must also cover the full-collateral-transfer illiquid path.
  4.  **Explicit Storage:** For every loan, the liquidity status (Liquid or Illiquid, based on the on-chain verification and user acceptance flow) of the lending asset and collateral asset is explicitly stored in the loan's on-chain data.
  5.  **API Unavailability / Fail-Closed Behavior:** If frontend-side assistance is unavailable, or if on-chain checks face temporary issues in accessing necessary validation data (e.g., Chainlink or pool lookups), the asset will default to being treated as "Illiquid" to ensure safety. In such cases, full collateral transfer terms on default will apply, and the user must consent. No manual overrides are permitted to classify an asset as liquid if checks fail or indicate illiquidity.
  6.  **Same-Asset Guard:** At offer creation, the lending asset and collateral asset must not be the same asset. This invariant is enforced directly rather than by relying on reference-asset hacks.
- **Handling of Illiquid Assets on Default:**
  - **ERC-20 Lending with Illiquid Collateral:** If the borrower defaults, the entire illiquid ERC-20 collateral is transferred to the lender. There is no auction or DEX-based liquidation process for these assets.
  - **NFT Lending/Renting:** If the borrower defaults (e.g., fails to close the rental, before expiry), then prepaid (total rental fees + 5% buffer) ERC-20 collateral provided by the borrower is transferred to the NFT owner (lender). The original ERC-721 or ERC-1155 NFT held in Vaipakam Vault is returned to the owner and the full buffer (5% extra) will be sent to treasury.
- **Frontend Warnings for Illiquid Assets:**
  - A clear, static combined warning message will be displayed in the frontend whenever a user creates or accepts an offer. For illiquid assets, that same message must make clear that on default the lender takes the full collateral in-kind rather than through a traditional liquidation process.
  - This illiquid path does not use a separate optional toggle or a second consent. It is covered by the same single mandatory combined warning-and-consent acknowledgement used for offer creation and offer acceptance.
- **Prepayment for NFT Renting:**
  - For NFT renting, the borrower must lock ERC-20 tokens as collateral. This collateral will cover the total rental amount plus a 5% buffer. This entire amount is considered a prepayment. The 5% buffer is refunded to the borrower upon successful and timely rental closure of the NFT and payment of all rental fees.
  - No separate NFT collateral is required for NFT renting in Phase 1. The vault-controlled custody model already protects return-of-asset risk, while the ERC-20 prepayment and buffer cover the rental-payment obligation.

## 2. Loan Durations and Flexibility

### Loan Terms

- **Durations:** Configurable from 1 day to 1 year (`1–365` days), with the live maximum exposed through protocol configuration. Frontend validation must enforce this range, and the on-chain offer / loan initiation path should enforce the same upper bound so external callers cannot bypass the UI.
- **Creation Buckets:** The primary Create Offer flow should present standard duration buckets (`7`, `14`, `30`, `60`, `90`, `180`, and `365` days) rather than a free-form number input. Range Orders still match duration as an exact value, so bucketed durations improve match density without introducing duration-range semantics. Specialized follow-on flows such as refinance or borrower preclose may keep free-form duration entry where preserving a remaining loan tail is more important than marketplace matchability.
- **Grace Periods:** Assigned from a fixed six-slot duration schedule that can be configured by admin / governance within per-slot safety bounds:
  - < 1 week: 1 hour
  - < 1 month: 1 day
  - < 3 months: 3 days
  - < 6 months: 1 week
  - \le 1 year: 2 weeks
  - > 1 year / catch-all: 30 days
  - The first five defaults preserve the original Phase 1 behavior, and the sixth default covers year-plus loans if a later live maximum duration permits them.
  - The schedule shape is fixed at six rows. Governance may edit each row's `maxDurationDays` and `graceSeconds` within that row's allowed bounds, but must not add or remove rows.
  - A global grace floor of 1 hour and ceiling of 90 days applies in addition to row-level bounds. The catch-all row must use `maxDurationDays = 0`.
  - Clearing the configured schedule reverts to the compile-time defaults.

## 3. Offer Creation

### Creation modes — on-chain and gasless signed offers (v0.5)

An offer may be created two ways, both reaching the same on-chain offer state:

- **On-chain offer** (the original mode) — the creator sends a transaction that
  deposits/locks their stake and records the offer immediately.
- **Signed off-chain offer (gasless)** — the creator signs the binding offer
  terms once with an EIP-712 signature (no transaction, no gas). The offer lives
  off-chain (front-end / indexer order book) until a counterparty fills it. At
  fill, the signed offer is materialized into an ordinary on-chain offer and
  accepted in the same transaction, so the resulting loan and every downstream
  rule (position NFTs, claims, VPFI discount, sanctions screening, liquidity and
  health-factor gates) behave identically to an on-chain offer. The act of
  signing is the creator's risk-and-terms consent.

  The signer's stake is sourced either from **free balance already in their
  Vaipakam vault** (checked and locked, nothing pulled) or **from their wallet
  via a single Permit2 signature** that authorizes the token transfer and binds
  the offer terms together (wallet-sourced signed offers are all-or-nothing).
  No funds are ever pooled — the stake stays in the signer's own isolated vault
  until the fill instant.

  Signed offers are replay-protected (each fill is recorded against the offer's
  order hash and can never be filled twice) and cancellable: the signer can
  cancel a specific offer on-chain, or batch-cancel every offer carrying a given
  nonce (the secure complement to a free off-chain delete). Smart-contract
  wallets can sign (ERC-1271). v0.5 supports direct, full acceptance of ERC-20
  lender-principal and ERC-20-collateral borrower offers; partial fills, the
  programmatic lender-intent vault, and aggregator adapters are later phases,
  and NFT-collateral / refinance-tagged signed offers are out of v0.5 scope.

### Lenders:

- **For ERC-20 Tokens:**
  - Specify the lending asset (e.g., 1000 USDC), loan amount, interest rate (e.g., 5% APR), required collateral type (e.g., WETH) and amount (or maximum LTV or minimum Health Factor requirement if collateral is Liquid), and loan duration.
    - LTV = Borrowed Value / Collateral Value
    - Helath Factor = Collateral Value / Borrowed Value
  - Deposit the lending asset into the Vaipakam smart contract when creating the offer.
  - The deposited principal is **locked against withdrawal for as long as the offer is live**. The creator cannot pull the escrowed principal — or the unfilled remainder of a range offer — back out of their vault while the offer stays open on the book. The lock is placed at create, lifted in full when the offer is accepted outright or cancelled, drawn down slice-by-slice as a range offer is partially filled by the matching engine, and lifted on the final dust-close. An offer's **own** refunds — cancelling, or a downward size edit — release their portion of the lock *before* the funds move, so an offer can always pay itself back; only unrelated / cross-purpose withdrawals are refused. This is the lender-side counterpart of the §2207 collateral-protection invariant: escrowed offer principal, like pledged collateral, is never withdrawable out a side door while it backs a live commitment.
- **For Rentable NFTs (ERC-721/1155):**
  - Specify the NFT (e.g., Axie #1234), daily rental fee (e.g., 10 USDC/day), the ERC-20 token for rental payment and collateral (e.g., USDC), and rental duration (e.g., 7 days).
  - For ERC-721 NFTs: Deposit the NFT into the Vaipakam Vault contract when creating the offer so Vaipakam has vault-controlled owner/custody access for user-right assignment.
  - For ERC-1155 NFTs: Deposit the NFT into the Vaipakam Vault contract when creating the offer.

### Borrowers:

- **For ERC-20 Tokens:**
  - Specify the desired ERC-20 asset and amount, maximum acceptable interest rate, offered collateral (type and amount), and loan duration.
  - The frontend must clearly disclose that when an ERC-20 loan is actually initiated, a `Loan Initiation Fee` equal to `0.1%` of the lending-asset amount will be charged to treasury before the lending asset is delivered to the borrower. In other words, if the matched lending amount is `1000 USDC`, the borrower receives `999 USDC` and `1 USDC` is routed to treasury at initiation.
  - If the borrower uses the VPFI fee path, the borrower receives `100%` of the requested lending asset and pays the full `0.1%` fee equivalent in VPFI up front. That VPFI is held by the protocol until settlement and may produce an effective-tier borrower rebate on proper close, as defined in `docs/FunctionalSpecs/TokenomicsTechSpec.md`.
  - Lock the collateral in the Vaipakam smart contract upon offer submission.
  - For ERC-20 collateral, that escrowed collateral is **locked against withdrawal for as long as the offer is live** — the borrower-side counterpart of the lender principal lock (§3 Lenders / ERC-20). The borrower cannot pull the pledged collateral (or the unfilled remainder of a range offer) back out of their vault while the offer stays open, including via a side door such as unstaking VPFI that is simultaneously pledged as collateral. This closes the pre-acceptance drain that would otherwise let a borrower post an offer, withdraw the pledged collateral, and have a lender accept into a loan that is under-collateralized from birth. At acceptance the lock is **handed off** to the loan's own collateral protection (the collateral never moves — it transitions from "committed to an open offer" to "backing a live loan"); on cancel, on a downward collateral-size edit, and on the unused-collateral refund at acceptance, the relevant portion is released before the funds move, so an offer can always return its own collateral. NFT collateral is held in custody (the token itself, no fungible drain door) and is out of scope. This is the §2207 collateral-protection invariant extended into the pre-loan offer window.
- **For Rentable NFTs (ERC-721/1155):**
  - Specify the desired NFT (or type of NFT), maximum acceptable daily rental charge, the ERC-20 token to be used for prepayment (rental fees + 5% buffer), and rental duration.
  - Lock the prepayment (total rental fee + 5% buffer) in ERC-20 tokens in the Vaipakam smart contract upon offer submission. Rental payments will be deducted from this prepayment.

### Offer fill modes (DEX-style flavours)

- Every offer carries a `fillMode` flavour the creator picks at
  create time. Three modes are supported:
  - **`Partial`** (default): the offer is matchable at any size in
    `[amount, amountMax]`; the remainder stays on the book until
    fully filled or cancelled. Today's behaviour, preserved exactly
    for every existing offer.
  - **`Aon`** ("All-or-Nothing"): the offer admits exactly one
    full-size fill, sized to `offer.amount`. Requires `amount ==
    amountMax` at create (an amount range under AON is structurally
    meaningless — only the full fill is reachable). A matcher
    attempting a partial fill against an AON offer reverts with a
    typed `AonRequiresFullFill` error carrying the offending offer
    id, the required full size, and the would-be partial size.
  - **`Ioc`** ("Immediate-or-Cancel"): the offer is partial-fillable
    inside a required time window (`expiresAt > 0`); past the
    deadline the offer lapses via the same lazy-expiry path GTT
    offers use, and the unmatched remainder is cleanable by any
    caller via `cancelOffer` with the refund routed to the creator.
- `fillMode` is **immutable for the offer's lifetime**. The
  in-place offer modification surface (`OfferMutateFacet`) does not
  touch this field — changing fill mode mid-life would alter the
  offer's economic contract that the acceptor agreed to at
  inspection time.
- `FOK`, `POST`, and `Iceberg` modes were considered and not
  shipped. `POST` is a no-op for Vaipakam (every offer is
  structurally a maker; the acceptor is always the caller of
  `acceptOffer` or the matcher bot, never another offer). `FOK`
  is strictly stricter than `Aon` (same-block fill or revert) and
  fits poorly with P2P lending's slower match cadence. `Iceberg`
  is deferred post-mainnet pending a real demand signal.
- See `docs/DesignsAndPlans/OfferFillModesDesign.md` for the full
  matrix, alternatives table, and failure-mode coverage.

### Offer modification — in-place edit without cancel-and-re-post

- A creator may modify their own **unaccepted** offer's principal
  range (`amount` / `amountMax`), rate range
  (`interestRateBps` / `interestRateBpsMax`), or collateral range
  (`collateralAmount` / `collateralAmountMax`) without taking the
  offer off the book.
- The three field clusters can be updated individually via
  `setOfferAmount` / `setOfferRate` / `setOfferCollateral`, or all
  in one transaction via `modifyOffer` (atomic combined helper).
- The post-modification offer must satisfy the **same invariants**
  `createOffer` enforces: positive amount / collateral, range
  ordering (`amountMax >= amount`, etc.), `interestRateBpsMax <=
  MAX_INTEREST_BPS`, lender single-value collateral
  (`collateralAmountMax == collateralAmount`), per-asset pause, and
  sanctions screening on the creator.
- Partial-fill bound: the new ceiling cannot fall below the portion
  already committed to live loans — `amountMax >= amountFilled` and
  `collateralAmountMax >= collateralAmountFilled`. The remaining
  unfilled capacity stays the difference between these two.
- Vault deltas: shrinking `amountMax` on a lender ERC-20 offer
  refunds the unused portion to the creator's wallet; growing it
  pulls the additional principal. Symmetric for `collateralAmountMax`
  on a borrower ERC-20 offer (vs. `collateralAsset`). Borrower
  NFT-rental offers see the delta in `prepayAsset` when `amount`
  changes (prepay = amount × durationDays × (1 + buffer)). Other
  offer shapes update storage with no vault movement.
- Principal-lock tracking: a lender ERC-20 offer's principal lock
  (§3) moves in lock-step with each `amountMax` delta — a downward
  edit releases the refunded portion **before** the refund leaves
  the vault (so the refund is never blocked by the offer's own
  lock), and an upward edit grows the lock by exactly the extra
  principal pulled in. The post-edit remainder stays locked.
- **No Loan Initiation Fee** is charged on a modify; LIF applies to
  loan initiation only.
- Already-accepted offers are terminal — modification reverts.
- See `docs/DesignsAndPlans/OfferModificationDesign.md` for the
  delta matrix, alternatives table, and failure-mode coverage.

### Offer expiry (GTT) — optional time-bound offers

- An offer is **Good-Till-Cancelled (GTC) by default**: it stays open
  on the order book indefinitely until its creator cancels it.
- An offer **may optionally carry an absolute deadline** (`expiresAt`
  unix-seconds), in which case it behaves as a **Good-Till-Time (GTT)**
  offer: at and after the deadline the offer can no longer be
  accepted or matched. Direct accepts, matchOffers calls, previewAccept
  classifiers, and previewMatch classifiers all refuse expired offers
  before any state change.
- The optional deadline must lie strictly in the future when the offer
  is created, and must lie within one year from creation. Out-of-bounds
  values are rejected by the create call. The chosen value is immutable
  for the life of the offer.
- A GTT offer that has lapsed is **cleanable by anyone** via the same
  `cancelOffer` entry point. The cleaner pays gas; the refund (locked
  principal for a lender offer, locked collateral or rental prepay
  for a borrower offer) always flows back to the original creator,
  never to the cleaner. The cleaner gets no protocol-level kickback —
  the only economic incentive is the SSTORE-clear gas-refund discount
  on their own transaction, which is bounded by EIP-3529.
- A GTC offer (`expiresAt == 0`) is cancellable **only** by its
  creator, exactly as before. The widened access gate applies only
  to expired GTT offers.
- The frontend may surface the expiry as quick presets (Never / 1 day
  / 7 days / 30 days / custom) on the create form, and render an
  "expires in …" / "expired — anyone can clean up" decoration on
  open-book rows where `expiresAt > 0`.
- See `docs/DesignsAndPlans/OfferExpiryGTTDesign.md` for the full
  rationale, alternatives table, and failure-mode coverage.

### Process:

- Offers are created through a React-based web interface.
- For common ERC-20 flows, the app may offer a Uniswap Permit2 single-signature path instead of the classic approve-then-action path. Supported actions include creating an offer, accepting an offer, and depositing VPFI to vault. Wallets or users that do not use Permit2 should fall back to the explicit approval flow without changing protocol semantics.
- Permit2 should use Uniswap's canonical EVM deployment at `0x000000000022D473030F116dDEE9F6B43aC78BA3`. Permit signatures should be EIP-712 signatures with a 30-minute expiry, high-entropy nonces, and exact asset / amount / spender scope. Permit2 must live alongside the legacy allowance path; it must not silently replace token-level approvals for users who choose the classic flow.
- All offer details are recorded on-chain for transparency and immutability.
- Wherever the frontend lets a borrower create an offer or accept an offer for ERC-20 borrowing, it must communicate the `Loan Initiation Fee` in plain language before submission. The disclosure should make clear that the fee is charged in the lending asset at loan initiation and is deducted before net proceeds reach the borrower.
- Wherever the frontend lets a user create or accept an offer, it must require a single mandatory Risk Disclosures and Vaipakam Terms acknowledgement before submission. That acknowledgement must cover both the liquid-asset abnormal-market fallback and, when applicable, the illiquid full-collateral-in-kind path. If the consent is not given, the transaction must revert / not proceed.

### NFT Minting for Offers

Vaipakam mints unique NFTs to represent offers, enhancing traceability and user ownership of their financial positions.

**NFT Metadata:**

- **Collection Identity:** The position NFT collection should initialize as `Vaipakam NFT` with symbol `VAIPAK`. Name and symbol are contract identity and should remain one-shot initialization values rather than mutable admin-set fields.
- **On-Chain Data:** Key offer details are stored directly on-chain as part of the NFT's metadata. This includes asset types, amounts, rates, duration, and status (e.g., "Offer Created," "Offer Cancelled," "Offer Matched"). The status is updated by authorized smart contract roles (e.g., `VaipakamOfferManagement.sol`) as the offer progresses.
- **`tokenURI()` Implementation:** The platform's NFT contract will implement a `tokenURI()` function that dynamically generates a JSON string containing all relevant loan information. This JSON can be consumed by third-party NFT marketplaces to display offer details.
- **Off-Chain Image Storage (IPFS):** Four distinct images representing different states/roles will be stored in IPFS:
  - `LenderActive.png`
  - `LenderClosed.png`
  - `BorrowerActive.png`
  - `BorrowerClosed.png`
    - The dynamically generated `tokenURI()` will point to the appropriate IPFS image URL based on who created the offer (Lender of Borrower) and its current status.
- **Status-Keyed Image Scheme:** The four-slot image model should be treated as the fallback baseline. The live metadata system should support status-specific image URLs keyed by position status and side, with per-side defaults and a collection-level fallback. This lets marketplaces distinguish active, repaid, defaulted, liquidated, closed, and fallback-pending positions rather than collapsing every terminal state into one generic closed image.
- **Marketplace Metadata Polish:** `tokenURI()` should expose realized live-state values for loan positions rather than stale offer minima, including principal, rate, collateral, locked collateral, claimable lanes, borrower VPFI rebate state, and creation time. Numeric amounts should be decimal-formatted with token symbols when metadata reads are available, interest rates should use marketplace-friendly percentage display semantics, and metadata may include `background_color` plus an `external_url` that deep-links to the Vaipakam app for the relevant loan or token.
- **Metadata Updates:** The NFT metadata (specifically the status and potentially the image URL pointer) is updated by authorized smart contract roles (e.g., `VaipakamOfferManagement.sol`) when an offer or loan state changes (e.g., accepted, cancelled).
- **Standardized Metadata for Third-Party NFT Platforms:** The metadata for Vaipakam NFTs should follow a stable, standards-aligned JSON structure so that third-party NFT websites, wallets, marketplaces, and portfolio viewers can read and display meaningful information about the position without requiring Vaipakam-specific custom parsing as the only path.
  - The metadata should remain compatible with common NFT metadata expectations used by ERC-721 and ERC-1155 indexers and hosting platforms.
  - The metadata should expose standardized high-signal fields such as role (`Lender` / `Borrower`), protocol position status, linked offer ID, linked loan ID, principal or rental asset, collateral or prepay asset, amount, interest rate / rental rate, duration, network context, and whether the NFT currently governs claim rights.
  - The metadata should also include human-readable descriptive fields and structured attributes so that third-party websites can display both a readable summary and machine-parseable trait data.
  - Where relevant, metadata should clearly distinguish between offer-state NFTs and active-loan / resolved-loan position NFTs so external platforms do not misrepresent a stale offer as a live claim-bearing loan position.
  - Position metadata should be updated promptly when the protocol state changes so external platforms that refresh token metadata can reflect the current role, status, and claim relevance of the Vaipakam NFT.
- **Event Emission:** Detailed events are emitted for each relevant state change to support frontend tracking and off-chain services such as notifications and analytics.
  - Where a protocol action is represented through an intermediate or repurposed offer flow, the protocol should emit an explicit linking event so indexers and frontends do not need to infer the relationship through traces alone.
  - Before mainnet, event payloads that drive high-traffic dashboards and archive rows should be audited for completeness. Where the gas cost is justified, lifecycle events should include enough immutable row data for the watcher and browser live-tail to avoid redundant `getOfferDetails` / `getLoanDetails` fetches.
  - In particular, lender loan-sale / early-withdrawal flows should emit a first-class event that links the live loan ID to the generated sale or transition offer ID.
  - Offer acceptance events should expose the resulting loan ID so filled-offer rows and Activity surfaces can deep-link from `Offer #X` to `Loan #Y`.
  - Offer cancellation should emit both the existing identity event and a richer companion event containing the cancelled offer's terms before storage is deleted, so dashboards can reconstruct cancelled-offer rows from on-chain history without relying only on browser-local snapshots.

### Example:

**Lender Offer (ERC-20):**

- Alice offers 1000 USDC at 5% interest for 30 days, requiring $1500 (150% Health Factor) worth of ETH as collateral (assuming ETH is liquid).
- Platform locks Alice's 1000 USDC from her wallet into the offer contract.
- Platform mints an "Vaipakam NFT" for Alice, detailing her offer terms and status as "Offer Created" and with role as "Lender"

**Borrower Offer (NFT Renting):**

- Bob wants to rent a specific CryptoPunk for 7 days and is willing to pay up to 15 USDC/day. He offers USDC as prepayment.
- Bob locks (7 days \* 15 USDC/day) + 5% buffer = 105 USDC + 5.25 USDC = 110.25 USDC into the offer contract.
- Platform mints an "Vaipakam NFT" for Bob, detailing his request and status "Offer Created" with "Borrower" role.

### Frontend Warnings (Reiteration)

- **Single Mandatory Risk and Terms Consent:** The frontend must use one combined mandatory acknowledgement, not separate warning blocks or optional checkboxes, for the offer-create and offer-accept flows. That one consent must be required from both sides and must cover the Risk Disclosures and Vaipakam Terms shown in the flow. The checkbox label should read: `I understand and agree to the Risk Disclosures and Vaipakam Terms.` The Terms text should be an inline link. For loan storage, a single combined accepted-by-both-parties consent state is acceptable because neither side is allowed to proceed without agreeing.
- implementation note for the `Offer Book` accept-review modal: the page may additionally show one extra informational illiquid-leg warning above the combined warning-and-consent block when the selected offer contains an illiquid lending asset or collateral asset, so long as that extra warning does not introduce a second consent or a second required acknowledgement

- **Full Collateral Transfer for Illiquid Assets:** Users are explicitly warned that if they use or accept illiquid assets or collateral, default by the borrower can result in the full transfer of that collateral to the lender, without any LTV-based liquidation auction.
- **Fallback Mechanics Education for Liquid Assets:** The consent surface should stay concise. The Advanced User Guide and FAQ should explain that when liquid assets cannot be liquidated safely, the protocol first distinguishes whether oracle quorum pricing is available. With quorum pricing and enough collateral value, the lender receives a collateral-equivalent recovery and borrower surplus remains attributable to the borrower after charges. With quorum pricing but insufficient collateral value, the lender receives all collateral. Without quorum pricing, the lender receives all collateral because fair-value split math cannot be applied.
- **Equivalent Collateral Transfer for Liquid Asset during Abnormal Periods:** When liquid assets cannot be liquidated due to any of the following conditions, the protocol must not automatically give the lender the borrower's entire liquid collateral balance unless the fair-value split cannot be calculated or collateral value is insufficient. Instead, where oracle pricing is available and collateral value covers the entitlement, the lender should become entitled only to the collateral-equivalent amount needed to satisfy the lender-side recovery amount, measured in collateral units against the lending-asset obligation.
  - for normal successful liquidations, the liquidator incentive must be dynamic and must satisfy: `slippage% + liquidator incentive% = 6%`, with the liquidator incentive therefore calculated as `6% - realized slippage%` and capped at a maximum of `3%` of liquidation proceeds
  - the `6%` max liquidation slippage value should be governance-configurable within a bounded safe range; in Phase 1, configuration is controlled through the multisig / timelock admin path
  - for normal successful liquidations, an additional liquidation-handling charge equal to `2%` of liquidation proceeds must be routed to treasury because the borrower did not act before liquidation became necessary
  - this `2%` liquidation-handling charge is separate from, and may exist in addition to, any other treasury fees that are otherwise applicable under the protocol (such as fees on recovered interest, late fees, rental fees, or fallback settlement entitlements)
  - any market condition (too volatile or heavy crash)
  - any unavailability of liquid assets in the DEX pool
  - any technical issues in liquidating the assets
  - if liquidation slippage would exceed 6%; in that case the collateral-to-lending-asset conversion must not execute and the protocol must follow the equivalent-collateral fallback procedure instead
  - in this abnormal-period fallback path, the protocol may defer final settlement to the lender-claim step rather than pushing collateral automatically in the same liquidation transaction
  - there is no extra grace window or reserved waiting period after failed liquidation; the lender may claim immediately after the failed liquidation because the risk remains on the lender side
  - before the lender claim is actually executed, the borrower may still either add collateral or fully repay the loan (including accrued interest and applicable late fees) in order to cure the position and avoid the extra 5% fallback liquidation charges
  - if the borrower fully repays before lender claim execution finalizes, the fallback path is canceled and the borrower later claims back the collateral through the normal borrower-side claim flow
  - if the borrower adds collateral before lender claim execution finalizes and the loan again satisfies the required LTV and Health Factor thresholds, the loan may continue as an active loan
  - once lender claim execution starts, that claim path is final for that transaction and the system must not auto-revive or interrupt that lender claim mid-execution
  - during the lender-claim step, the system may try once more to liquidate the relevant collateral into the lending asset
  - if that lender-claim liquidation retry also fails, the lender becomes entitled to collateral equivalent to: `lending asset due + accrued interest + 3% of the lending asset amount`
  - if the remaining collateral value at that retry-failed stage is below `lending asset due + accrued interest + 3% of the lending asset amount`, then the lender receives the full remaining collateral and the borrower receives nothing from that collateral position
  - in that same retry-failed branch, the treasury becomes entitled to collateral equivalent to `2% of the lending asset amount`
  - the extra 5% fallback premium (3% to lender and 2% to treasury) exists because the borrower did not act before liquidation became necessary
  - any remaining liquid collateral beyond the lender entitlement and treasury entitlement must remain attributable to the borrower through the borrower-side accounting / claim flow
  - the user-facing warning copy for this path should state in plain language: if liquidation cannot execute safely, for example because slippage exceeds the configured max liquidation threshold, liquidity disappears, or the swap fails, the lender claims collateral in collateral-asset form instead of receiving the lending asset; if the collateral value has fallen below the amount due, the lender receives the full remaining collateral and nothing is left for the borrower; if the collateral value is still above the amount due, the lender receives only the equivalent collateral amount and the remainder stays with the borrower after charges
- **Permissionless Liquidation / Authorized Keepers / Third-Party Execution Allowed:**
  - Vaipakam should disable all non-liquidation MEV-style or third-party execution interactions by default.
  - Permissionless liquidation remains allowed even when broader MEV or keeper access is turned off, because liquidation is a protocol-safety function and must remain executable when a loan becomes default-eligible.
  - Any broader bot, keeper, or third-party execution access must be an explicit user opt-in and must never be assumed by default.
  - User consent for such access must be logged and auditable at three levels: user profile/default-preference level, offer level, and loan level.
  - If such access is enabled in a later phase, it must be restricted to narrowly defined authorized actions instead of a blanket "bots allowed" permission.
  - Product and frontend language should frame this policy using terms such as "permissionless liquidation", "authorized keepers", and "third-party execution allowed", rather than broadly describing it as open MEV-bot access.
  - For advanced users who opt in to keeper / third-party execution, the protocol should support a whitelist of explicitly approved external keeper addresses. Outside of liquidation and other explicitly permissionless safety actions, third-party execution must be allowed only from those whitelisted addresses rather than from arbitrary bots.
  - The whitelist should be intentionally small and auditable. In Phase 1, each user may whitelist at most `5` external keeper addresses.
  - Outside of liquidation, keeper authority should be role-scoped rather than globally shared wherever possible. A lender-approved keeper should be able to perform only lender-entitled keeper-enabled actions, and a borrower-approved keeper should be able to perform only borrower-entitled keeper-enabled actions.
  - In practice, a keeper should be treated as a delegated role-manager for the consenting lender or borrower. Keeper approval means that the delegating party has authorized that external address to act only within that party's allowed protocol role boundaries for the keeper-enabled functions.
  - The protocol should not require mutual lender-and-borrower keeper approval for non-liquidation keeper execution. Keeper authorization should instead follow the role that is actually entitled to perform the action.
  - Claim-related authority should follow the current owner of the relevant Vaipakam NFT, because claim rights themselves follow the Vaipakam lender NFT or borrower NFT rather than the original initiating wallet.
  - Keeper approval must not by itself grant claim authority, withdrawal authority, or asset-ownership rights. Claims may be executed only by the current owner of the relevant Vaipakam NFT unless a future protocol phase introduces a separate, explicit NFT-owner claim-delegation model.
  - If Vaipakam position NFTs later support ERC-4907-style `userOf`, that rented `userOf` address should be treated only as a keeper-level operational delegate for the same narrow keeper-enabled function set already allowed by the protocol. The rented `userOf` address must not become a substitute owner, must not receive claim rights, must not receive payout-routing authority, and must not receive general strategic control over the position.
  - Under that model, `ownerOf` remains the economic owner and strategic controller of the Vaipakam position NFT, while `userOf` remains a temporary execution delegate with only keeper-scoped operational rights.
  - The project is not planning to move Vaipakam position NFTs into protocol vault during borrower preclose, borrower refinance, or lender early-withdrawal flows, and is not planning to natively lock transfers for those flows through `_beforeTokenTransfer`.
  - Instead, completion authority for strategic flows should be enforced by function-level role and state checks against the currently entitled Vaipakam NFT owner, rather than by first moving the NFT into protocol vault or by relying on a native transfer hook lock.
  - Ownership-sensitive logic for Vaipakam position authority should rely on the current `ownerOf(tokenId)` result for the relevant lender-side or borrower-side Vaipakam NFT unless a future protocol phase explicitly defines a different ownership-delegation model.
  - In other words, the protocol should use a function-by-function role-authority model over a single loan-wide shared-keeper model, so opt-in does not become broad public execution by accident and does not unnecessarily force one side to approve the other side's automation.
  - Liquidation remains the exception: any address may trigger liquidation whenever the protocol liquidation conditions are met, for both basic users and advanced users. Liquidation must not depend on keeper whitelists.
  - The protocol should distinguish between `permissionless`, `party-only`, and `keeper-optional` execution classes at the function level rather than using a single broad MEV / bot flag.
  - **Permissionless state-changing functions (Phase 1):**
    - `triggerLiquidation`: always permissionless because it is a protocol-safety action
    - `triggerDefault`: permissionless once the documented default conditions are met
    - `repayLoan`: permissionless full repayment is allowed, but repayment does not transfer collateral rights; collateral remains tied to the borrower-side Vaipakam NFT
    - `autoDeductDaily`: may remain permissionless because it is a deterministic rental-maintenance action with no caller discretion over pricing or settlement terms
    - `matchOffers`: permissionless when the Range Orders matching kill-switch is enabled, because the function can only execute a valid match between two consenting on-chain offers and pays a configured matcher fee to the caller
  - **Party-only state-changing functions (Phase 1):**
    - `createOffer`
    - `acceptOffer`
    - `cancelOffer`
    - `addCollateral`
    - `repayPartial`
    - `claimAsLender`
    - `claimAsBorrower`
    - `precloseDirect`
    - `transferObligationViaOffer`
    - `refinanceLoan`
    - `createLoanSaleOffer`
    - all admin, treasury, NFT-ownership, vault-upgrade, pause, oracle-admin, and role-management functions must remain role-gated / owner-gated rather than keeper-executable
  - **Keeper-optional state-changing functions (Phase 1):**
    - `completeLoanSale`
    - `completeOffset`
    - `extendLoanInPlace`, only when the auto-extend feature is enabled and both current position-NFT holders have active, non-stale caps that permit the proposed terms
    - any future keeper-enabled function must be explicitly documented as deterministic, already-authorized, and non-discretionary before it is added to this list
  - **Role-scoped keeper rule for Phase 1:**
    - keepers are delegated role-managers for the consenting lender-side or borrower-side role
    - lender-approved keepers may execute only lender-side keeper-enabled actions
    - borrower-approved keepers may execute only borrower-side keeper-enabled actions
    - if Vaipakam position NFTs later support ERC-4907-style `userOf`, that rented `userOf` address should be treated the same way as a keeper only for these already-keeper-enabled operational functions, and not for broader position management
    - keepers do not gain claim rights merely because they are approved as keepers
    - claims may be executed only by the current owner of the relevant Vaipakam NFT
    - claim-related keeper authority, if enabled in a future phase, must come from a separate explicit authorization path controlled by the current owner of the relevant Vaipakam NFT
    - liquidation remains fully permissionless and is not part of this role-scoped keeper restriction model
  - **Functions that should not be broadened to keeper execution in Phase 1:**
    - claims
    - offer creation / acceptance / cancellation
    - borrower collateral top-ups
    - borrower refinance / preclose initiation
    - partial repayment
    - admin / treasury / upgrade functions
    - any action that changes terms, ownership, claim rights, or asset routing unless the acting wallet is already the entitled party
  - **Stricter MEV / keeper threat model:**
    - The project should assume that public mempool visibility can create front-running, back-running, griefing, and value-extraction attempts around user-specific transitions such as loan sales, obligation transfers, refinance, preclose, and fallback claim flows.
    - The project should also assume that a broad keeper flag can accidentally convert a consensual helper model into an adversarial public-bot model.
    - Therefore the mitigation stack should be:
      - liquidation and default execution stay permissionless only where protocol safety requires it
      - non-liquidation third-party execution stays default-off
      - advanced-user third-party execution uses explicit whitelisted keeper addresses instead of arbitrary public bots
      - keeper-enabled functions stay on a narrow allowlist of deterministic completion flows
      - keeper permissions should be scoped to the consenting lender-side or borrower-side role wherever the function can be safely isolated to one side
      - claim authority should remain tied to the current Vaipakam NFT owner rather than to the original loan creator or a broad shared keeper permission
      - delegated keepers should be understood as role-managers, not as substitute asset claimants or substitute position owners
      - full repayment stays open to any payer, but payment alone never grants collateral or claim rights
      - frontend and docs must clearly disclose whether a function is permissionless, party-only, or keeper-optional
      - logs and audit trails should make it clear which external address executed the action and under which consent path it was allowed
- **Auto-Lifecycle Consent and Keeper Actions:**
  - Auto-lend, auto-refinance, and auto-extend are opt-in convenience surfaces layered on top of the existing offer, refinance, and keeper-authority model. They must default off for every user, loan, and fresh deployment.
  - Auto-lend is a per-user dapp preference for lender-offer posting. When enabled and the admin kill switch is on, the dapp may create standing offers from user intent, and ordinary permissionless offer matching can fill those offers. Auto-lend does not grant a new keeper execution path by itself and should not be described as guaranteed lending execution.
  - Auto-refinance caps are borrower-controlled offer-posting terms. A borrower may set default caps that are copied into new loans, or set per-loan caps directly. Default cap copying must remain disabled for illiquid ERC-20 collateral and NFT-collateral loans; those positions may be enrolled only through explicit per-loan borrower action because failure to find a match can transfer the full collateral in-kind. Keeper-driven refinance may proceed only when the replacement borrower offer is explicitly tagged with the target loan id, the cap setter is still the current borrower-position NFT holder, and the replacement terms satisfy the capped rate and expiry before the offer can be accepted.
  - Auto-refinance is best-effort. Caps and posted offers do not guarantee that a compatible lender will accept before the grace boundary, so borrowers remain responsible for monitoring the loan and repaying or refinancing manually when needed.
  - Borrower-direct refinance remains available without auto-refinance caps because the borrower-position NFT holder is acting directly for their own position.
  - Keeper-driven refinance must route all old-loan fund flows through the current borrower-position NFT holder, not through the keeper. The keeper is the transaction sender only; it must not receive released collateral or borrower-routed funds. The canonical refinance payment source remains the borrower's wallet allowance to the Diamond; standing approval enables automatic keeper submission without a new wallet popup at execution time. Vault-first refinance netting requires a separate locked-balance / encumbrance design before it can replace the wallet-pull path.
  - Accepting a refinance-tagged replacement offer should chain into the old-loan refinance in the same transaction. This atomic accept-and-refinance path must preserve the pre-accept cap checks, close the race between offer acceptance and refinance completion, and work for both direct offer acceptance and matched borrower-offer flows.
  - **Collateral carry-over (refinance-tagged offers).** A refinance is "same debt, same collateral, better lender/rate," so a refinance-tagged offer should carry the existing collateral over **in place** rather than make the borrower pledge a second batch. When carry-over applies, the collateral never leaves the borrower's vault; the protocol's locked-balance ledger simply **retags** the lien from the old loan to the new loan (same owner, asset, and amount — the locked-balance total is unchanged across the refinance), so the borrower no longer momentarily locks 2× collateral. The post-refinance health-factor and LTV checks run against the carried collateral. Changing the collateral as part of a refinance is out of scope (the carried collateral identity must match the old loan's exactly — asset, type, amount, token id, and quantity — or the refinance is rejected); adjusting collateral uses the dedicated add/remove-collateral flow. (Principal-side netting stays wallet-pull — see the note above — only the collateral side carries over.)
    - **Carry-over eligibility is deliberately narrow, decided once, and remembered.** Carry-over applies only when ALL of the following hold for the tagged offer: the refinancer is the **original borrower** (the borrower position has **not** been transferred), the offer pledges a **single, fixed** collateral amount (no borrower range), the collateral identity matches the targeted loan exactly (asset, type, amount, token id, quantity), and the targeted loan still carries a **live collateral lien**. This decision is computed **once, at offer creation**, and **recorded on the offer**; every later step (the create-time deposit skip, loan-init lien skip, cancel refund skip, and the refinance retag-vs-fresh-pledge fork) reads that recorded decision rather than re-deriving it. Re-deriving later would be unsafe: the targeted loan's borrower can change (obligation transfer) and its lien can be released between offer creation and those later steps, which would flip a re-derived decision and desync it from what was physically deposited — a carry-over offer deposited nothing, so a flipped "not carry-over" reading could try to refund or settle collateral that never existed.
    - **Anything not carry-over takes the legacy fresh-pledge path.** A tagged offer that is **transferred**, **ranged**, **collateral-mismatched**, or points at a **no-lien** loan — and every **untagged** direct refinance — pledges a fresh collateral batch at creation; at refinance the old loan's collateral is released and returned to the current borrower-position holder. This keeps carry-over to the case the retag machinery handles end-to-end and never skips a deposit the protocol didn't receive. The dedicated consolidate-to-current-holder model that would let a transferred position also carry over (by moving the collateral into the new holder's vault) is tracked as a separate design item.
    - **A refinance-tagged offer's collateral is frozen after creation.** Because the carry-over decision is fixed at creation from the offer's collateral fields, the collateral cannot be changed through the offer-collateral mutators afterward (its principal and rate terms can still be adjusted). A borrower who needs different collateral cancels the tagged offer and posts a new one.
    - **A stale carry-over offer is rejected at accept if the target loan migrated.** Because the carry-over decision is recorded once and the actual collateral lien lives on the target loan, the accept-time refinance performs the lien hand-off ONLY as an exact same-key retag (same owner, asset, token id, amount, kind). If the target obligation was transferred to a different borrower after the offer was created (which moved the lien to that new borrower and returned the original collateral), the keys no longer match and the refinance is rejected rather than silently creating a fresh, unbacked lien. This holds even if the borrower position is later transferred back to the original creator so the ownership check would otherwise pass.
    - **A refinance-tagged offer is single-purpose — consumable only by accept-and-refinance.** It must be filled by a lender directly accepting it (which atomically chains into the refinance), and **no other offer-consumption path may consume it**. Concretely: the range-order matcher rejects it (it can neither guarantee the collateral retag fires atomically with the replacement-loan creation nor preserve the fixed carried collateral against its own midpoint sizing); the pre-loan **parallel sale** (#358 borrow-OR-sell) opt-in is forbidden on it at creation (otherwise a buyer could buy the target loan's already-encumbered collateral before the refinance accept); and the **obligation-transfer** path rejects it (consuming a deposit-skipped offer for an unrelated transfer would double-lien the one collateral). The reason is structural: a carry-over offer advertises collateral it never re-deposited (the collateral is the target loan's, already liened), so any path that assumes the offer's collateral is freshly present would move or re-lien collateral that isn't there. Re-admitting tagged offers to the matcher (or any other path) with a carry-over-aware design is a separate design item.
    - **Liquidation/default of the target loan is safe against an open carry-over offer.** Liquidation and time-based default act on loans, never on offers, and they release the target loan's collateral lien. If the target loan is liquidated or defaulted while a carry-over offer pointing at it is still open, accepting that offer reverts (the target is no longer Active, and the carry-over retag independently requires a live lien), and cancelling it reads the recorded "carry-over" decision and refunds nothing (it deposited nothing) — so there is no double-spend or stuck offer.
  - Keeper / worker infrastructure may run a pre-grace watcher for loans with refinance caps enabled. The watcher should warn subscribed borrowers when a loan approaches grace expiry and no compatible lender offer appears available, throttle repeated warnings, and suppress warnings when a viable counterparty is already visible in the offer book. These warnings are advisory and do not relax the borrower's repayment responsibility.
  - Auto-extend caps are two-sided. The borrower-position NFT holder and lender-position NFT holder must each enable extend caps, and the proposed new rate and expiry must fit inside the intersection of both sides' caps. If either NFT transfers, that side's caps become stale until the new holder sets them again.
  - `extendLoanInPlace` extends an active loan without minting new position NFTs and without creating a new offer. It must be blocked when the auto-extend kill switch is off, when the loan is inactive, when the extension would not extend the loan, when the loan is too recent, when the loan is past the permitted grace boundary, when periodic-interest cadence requires settlement first, or when the asset type is unsupported.
  - On a valid auto-extend, accrued interest from the old loan window is settled first: treasury receives the configured yield-fee share and the lender receives the remainder. The borrower-side funds are sourced from the current borrower-position holder's vault, and the keeper may receive only the configured gas-based keeper reward.
  - Sanctions screening applies to auto-lifecycle setters and keeper-driven execution. For auto-extend, the keeper, current borrower-position holder, and current lender-position holder must all pass sanctions screening.
  - Admin / governance kill switches must independently control auto-lend opt-in, keeper-driven auto-refinance, and auto-extend. Users must always be able to revoke their own consent even while a feature is disabled.
- **Collateral for NFT Renting:** The collateral for NFT renting is a prepayment of total rental fees + a 5% buffer, denominated in ERC-20 tokens.
  - This is intentionally different from ERC-20 lending. For NFT renting, the rented NFT itself stays in vault custody and is returned by the protocol at rental closure/default, so the borrower does not need to post separate NFT collateral on top of the ERC-20 prepayment model.

### NFT collateral sale before default

For ERC-20 loans secured by ERC-721 or ERC-1155 collateral, Vaipakam may
let the borrower-side position holder opt the collateral into an
OpenSea-compatible marketplace listing before default. This feature is
intended to let a borrower realize NFT equity and repay the loan from
sale proceeds, without weakening the lender's default rights.

- The listing path is opt-in. A lender offer must explicitly allow NFT
  collateral sale, and borrower-side listing controls remain unavailable
  unless that permission is present on the resulting offer or loan.
- The listed NFT must remain in the borrower's Vaipakam Vault until a
  valid marketplace fill atomically pays the settlement waterfall and
  transfers the NFT to the buyer. The borrower must never receive raw
  transfer authority over the vaulted collateral merely because they
  asked to list it.
- Marketplace operator approval must be limited to governance-approved
  conduits or equivalent marketplace transfer agents. Approval to an
  arbitrary wallet or unapproved conduit is not an acceptable listing
  path.
- A live listing must cover at least the lender settlement entitlement,
  treasury entitlement, and any required marketplace fee legs. The
  borrower may ask for more; the excess belongs to the current borrower
  position holder after the lender and treasury are satisfied.
- Settlement recipients must follow the current Vaipakam position NFT
  owners at fill time, not only the original lender and borrower
  wallets. This preserves secondary-transfer semantics for both
  lender-side and borrower-side position NFTs.
  - As a consequence, when a terminal path deposits lender proceeds into
    the **stored** lender's vault but owes them to the **current** holder
    via a claim, and the principal asset is one with a user-facing
    tracked-balance exit (VPFI, via its unstake/withdraw path), those
    proceeds must be reserved against that exit the moment they land — so
    the stored lender cannot withdraw them before the current holder
    claims — and released exactly when the holder claims. This applies on
    every **terminal** close that produces a deferred lender claim, where the
    lender of record is fixed between the deposit and the claim: full
    repayment, swap-to-repay, time-based default, borrower preclose (direct),
    refinance, health-factor liquidation, and internal matching. Principal
    assets with no tracked exit need no such reservation. Paths that pay the
    lender's wallet directly (partial repayment, periodic-interest shortfall)
    are not in scope — there is no tracked vault balance to drain. The
    held-for-lender accruals (preclose offset / obligation transfer) land on
    a still-active loan whose lender of record can change before the claim,
    so reserving them safely requires re-keying the reservation across every
    lender-change path and is handled separately.
- A successful marketplace fill is a proper loan close, not a default.
  It must settle the lender, treasury, borrower residual, position NFT
  lock, and borrower VPFI rebate / forfeiture state consistently with
  other proper-close paths.
- If the listing remains unfilled through the loan's grace boundary,
  the ordinary default or liquidation path resumes. The listing must
  not keep a defaultable loan stuck or require a separate borrower action
  before lender recovery can proceed.
- ERC-1155 collateral listings are full-position sales only in the
  initial design. Partial ERC-1155 collateral sales must not be allowed
  to close the loan with partial payment.
- A borrower may update or cancel their live listing before the
  grace-boundary cutoff when they still hold the borrower-side position
  NFT. Cancellation releases only the listing lock; it does not repay
  the loan or change the ordinary loan obligations.
- When a listed loan is repaid, defaulted, liquidated, refinanced, or
  otherwise reaches a terminal state through another valid path, the
  listing binding must be cleared so a stale marketplace fill cannot
  later move collateral that no longer belongs in that listing flow.
- Direct sale fills must be blocked when the borrower has become
  sanctioned between listing and fill, where an active sanctions oracle
  is configured.
- Listings may support fixed-price, Dutch-decay, or OpenSea-offer
  assisted English-style discovery. In every mode, the on-chain
  settlement floor remains authoritative and the borrower-facing ask
  controls must not be able to underpay the lender or treasury.

Borrow-or-sell offers may also list the NFT collateral at offer
creation time, before any lender has accepted. If a buyer fills first,
the offer is consumed by sale, the offer position closes, and the
borrower receives the sale proceeds through their Vault. If a lender
accepts first, the same listing intent can carry into the live loan and
continues to settle through the loan-level waterfall. Acceptance, offer
matching, offer cancellation, and offer modification must all recognize
this terminal or locked state so a lender cannot accept an offer whose
collateral has already been sold, and a borrower cannot mutate
settlement-floor terms while a fillable listing still depends on the
old terms.
- Borrow-or-sell eligibility is intentionally narrower than ordinary
  offer creation: only borrower-side offers with NFT collateral and an
  all-or-nothing fill mode may publish a parallel sale listing. This
  keeps a single marketplace fill from conflicting with partial loan
  fills or multiple child loans.
- If a buyer fills the parallel sale before loan acceptance, the offer
  must move to a dedicated sale-consumed terminal state, its position
  NFT should be retired, sale proceeds should be credited to the
  borrower's Vault, and all executor / vault order bindings must clear.
- If a lender accepts first, the listing lock carries to the resulting
  loan. Later release or cancellation authority follows the current
  borrower-position NFT owner, not only the original borrower address.
- Marketplace fills must be blocked after the loan's grace boundary.
  Past that boundary, default and liquidation recovery take precedence
  over keeping an old listing fillable.
- Listing callbacks that record sale proceeds, mark offers consumed by
  sale, or assert sanctions state must be reentrancy-safe against
  malicious token transfer hooks re-entering offer acceptance or other
  lifecycle entry points.
- A loan may not have two live marketplace listing flows that compete
  for the same NFT transfer approval. Loan-keyed prepay listings must
  not overwrite an active parallel-sale approval slot, and a borrower
  should cancel any open preclose-offset offer before a parallel sale
  can settle.
- Prepay-listing modes may include fixed-price, Dutch-decay, and
  OpenSea-offer match flows. Dutch listings must enforce a minimum
  auction window, end no later than the loan grace boundary, and ensure
  total ask, fee legs, and borrower residual decay monotonically. OpenSea
  offer matching should use an atomic match path so cancel, replacement,
  and bidder fill either all succeed or all leave the prior listing
  intact.
- Fee-enforced collections that require marketplace fulfillment data
  should fail closed until the proxy has fetched the canonical Seaport
  parameters, bidder signature, extra data, and criteria resolvers
  needed for a valid match. The dapp should surface that as an
  unsupported-or-loading state, not route a known-doomed transaction.
- When a listed loan is repaid, preclosed directly, refinanced, offset,
  defaulted, liquidated, or otherwise closed outside the marketplace
  fill path, listing cleanup must be atomic with that terminal action:
  vault orderHash bindings, executor order context, and borrower-position
  locks clear in the same transaction so stale marketplace signatures
  cannot move collateral later.

## 4. Offer Book Display

### Frontend Implementation

- **Tabs:** Separate views for ERC-20 loan offers and NFT rental offers.
- **Sorting:**
  - ERC-20 offers: Sortable by interest rate (lowest for borrowers, highest for lenders), amount, duration.
  - NFT rental offers: Sortable by daily rental rate (lowest for renters, highest for owners), duration.
- **Guidance:** Display data from the last accepted offer with similar parameters (e.g., asset type, duration) to provide users with an indication of current market rates on Vaipakam.
- **Market-Rate Shortcut Widget:** Once a borrowing pair is fully specified, Offer Book should expose a small `Lend at market rate` / `Borrow at market rate` panel. The user enters the lending amount, the widget estimates the minimum collateral required from the same Health Factor / LTV rules enforced by the protocol with a small safety buffer, and the actions deep-link into `Create Offer` with the known fields pre-filled. The shortcut must not create or accept an offer directly and must not skip the full Create Offer review step. If the asset is thin, unsupported, or lacks a price on the connected chain, the widget may still deep-link but should leave unavailable collateral / rate fields unset and let Create Offer show the cautionary risk banner.
- **Filters:** Users can filter offers by asset type, collateral requirements (if applicable), loan/rental duration, and amount.
- **Auto-Matching (Suggestion Engine):** The frontend can suggest potentially compatible offers to users based on their currently defined preferences or draft offers.
- **Clear Indicators:** The frontend will use clear indicators for network selection, asset liquidity status, and potential risks.
- **Information Icons & Tooltips:** Key fields and terms should include concise helper text, tooltips, and links to deeper documentation or FAQs where appropriate.
- **Closed Offer Navigation:** Filled / closed offer rows should show the resulting loan link when the accepted-offer event maps that offer to a loan.
- **Market-Anchor Cache:** Frontend log-index caches that already contain accepted-offer events should be able to hydrate recent accepted-offer IDs from cached events without forcing a full rescan; when new event topics are added to the index allow-list, the cache key should be bumped so historical logs are captured once.
- **Live Offer Index:** The shared event-backed loan / offer index should subscribe to offer-affecting Diamond events (`OfferCreated`, `OfferAccepted`, `OfferCanceled`, and `OfferMatched`) and trigger a debounced incremental rescan when any of them lands on-chain. The Offer Book should then refresh from the updated ID set without requiring a manual `Rescan chain` click, while preserving the manual button as a failsafe.
- **Accept Preview:** Before a user signs a direct offer acceptance, the app should show a protocol-derived preview of the resulting principal, interest rate, collateral requirement, Loan Initiation Fee treatment, any borrower collateral refund, and any recoverable blocker such as missing risk consent, KYC tier, paused asset, sanctions state, or expired offer. The preview should keep useful projected economics visible even when an acceptance is currently blocked, so the user can understand what needs to change.

### Range Orders and Permissionless Matching

Range Orders let users express lender and borrower intent as canonical limit orders while preserving a simple one-input-per-role creation experience.

- **Canonical User Inputs:** Lenders enter the maximum principal they are willing to lend, the minimum acceptable rate, and the collateral they require. Borrowers enter the minimum principal they want, the maximum rate they will accept, and the collateral they are willing to lock. The product should explain these as role-specific limits rather than exposing raw floor / ceiling storage fields.
- **Explicit Bounds:** Each offer must carry a positive lower and upper principal bound where the upper bound is at least the lower bound. Single-value offers are represented by equal bounds rather than by an implicit blank upper bound. Borrower collateral ranges must likewise be explicit when the borrower is willing to lock more than the floor collateral.
- **Range Offer Bounds:** Lender range offers must vault enough lending asset for the upper amount bound and must satisfy the Health Factor floor at the worst-case fill. Borrower range offers must not request more principal than their posted collateral can support under the same risk math.
- **Bot-Facing Preview:** Matching bots should use the read-only match preview to filter candidate lender / borrower pairs before submitting a transaction. Preview should enforce asset continuity, duration compatibility, range overlap, midpoint term calculation, and a synthetic Health Factor check.
- **Permissionless Match Execution:** `matchOffers` is intentionally open to any caller when enabled. It is analogous to liquidation in that the caller cannot steal funds or set arbitrary terms; it can only execute a match allowed by two live offers and the protocol's deterministic matching rules.
- **Matcher Economics:** The caller of `matchOffers` receives the configured matcher share of the Loan Initiation Fee. The default is `1%` of the LIF treasury flow, but governance may tune this through live protocol configuration (`lifMatcherFeeBps`) within the documented safety cap (`MAX_FEE_BPS = 5000`, or 50%). Frontend and bot surfaces should read the live value from `getProtocolConfigBundle()` rather than assuming the default.
- **Keeper Worker Pass:** The production `apps/keeper` scheduled worker may run the Range Orders matcher as a third pass alongside liquidation monitoring and daily oracle snapshots. This pass must remain separately gated by the matching master flag and deployment runbook, because it signs transactions. It should reuse the bot-facing match preview and submit only deterministic protocol-valid matches.
- **Symmetric Partial-Fill Semantics:** Lender and borrower offers may both fill over multiple permissionless matches. The protocol tracks filled principal for each side and filled collateral for borrower offers, preserves offer storage for already-created loans, and closes an offer only when the remaining usable capacity falls below that offer's minimum fill. Each match creates its own loan, so borrower rewards, claim rights, and lifecycle accounting remain per loan rather than shared across the parent offer.
- **Direct-Accept Semantics:** Direct acceptance of a ranged offer is single-fill and role-aware. A borrower accepting a lender's ranged offer receives the lender's upper principal amount at the lender's floor rate. A lender accepting a borrower's ranged offer funds the borrower's lower principal amount at the borrower's ceiling rate. Direct accept should mark the offer terminal without using the progressive fill accumulator, and any borrower collateral above the accepted floor must be returned to the borrower rather than stranded.
- **Cancel Cooldown and Refunds:** When partial-fill matching is enabled, zero-fill cancellations are delayed briefly after offer creation to reduce cancel-front-run risk against an in-flight match. Once an offer has been partially filled, cancellation must preserve the storage needed by already-created loans and refund only the unfilled principal or borrower collateral that is not backing live loans.
- **Matching Surface Split:** The matching surface may live in a dedicated facet separate from ordinary create / accept / cancel offer management so the Diamond remains deployable under the EIP-170 runtime bytecode limit while keeping bot-facing matching semantics isolated.

## 5. Loan Initiation

### Initiation:

- A borrower accepts a lender’s offer, or a lender accepts a borrower’s offer, via the Vaipakam interface.
- The accepting party pays the network gas fee for the transaction that initiates the loan.

### Smart Contract Actions:

- **Collateral Locking:**
  - For ERC-20 Loans: The borrower’s collateral is locked in an vault contract.
  - For NFT Renting: The borrower’s prepayment (total rental fees + 5% buffer in ERC-20 tokens) is confirmed as locked.
- **Asset Transfer/NFT User Assignment:**
  - For ERC-20 Loans: Before the lending asset is delivered to the borrower, the protocol deducts a `Loan Initiation Fee` equal to `0.1%` of the lending-asset amount and routes that fee to treasury. The remaining net lending amount is then transferred from the lender or lender's locked funds (in the Vault) to the borrower.
    - For direct acceptance of ranged ERC-20 offers, the accepted principal and rate must be resolved from the role of the offer creator rather than from whichever raw field happens to be smallest. This prevents a ranged order's safety floor from becoming the loan's unintended economic value.
    - For loans initiated through a permissionless Range Orders match, the deterministic matched amount, midpoint rate, required collateral, actual counterparty, and matcher address are used instead of raw caller context. This prevents the bot / relayer from being treated as the lender or borrower while still paying that caller the configured matcher share of the LIF flow.
    - If a borrower pre-vaulted more collateral than a direct-accept loan actually locks, the unused collateral must be returned as part of the acceptance flow. Match-based fills continue to retain only the collateral needed for live child loans and refund the unfilled remainder at close or cancellation.
  - For NFT Renting:
    - For ERC-721: The NFT is held in the Vaipakam Vault contract. The Vault contract calls `setUser` on the NFT contract to assign the borrower as the 'user' of the NFT for the agreed rental duration.
    - For ERC-1155: The NFT is already in the Vaipakam Vault contract. The Vault contract calls `setUser` on the NFT contract to assign the borrower as the 'user' of the specified quantity of tokens for the agreed rental duration.
- **Record Keeping:** All loan details (principal, interest rate/rental fee, duration, collateral details, parties involved, start/end dates, liquidity status of assets) are recorded on-chain.
- **NFT Updates & Minting:**
  - The original "Vaipakam NFT" (of the party who have created the offer and whose offer was accepted) is updated to "Loan Initiated" status.
  - A new "Vaipakam NFT" is minted for the offer acceptor, with "Loan Initiated" status.
  - "Vaipakam NFT" will have respective roles of the users (either as lender or borrower) with it.

### Self-trade prevention

No single address may occupy both sides of a loan at initiation. The protocol rejects any acceptance whose resulting loan would have the same address as both lender and borrower:

- A user cannot directly accept their own lender or borrower offer from the same wallet.
- A bot (or any third-party submitter) cannot match a lender offer and a borrower offer that were both posted by the same wallet — the resulting loan would collapse the two sides onto one address.

The acceptance should fail with a clear, machine-readable reason that names the colliding address. Off-chain matchers should be able to detect the condition during preview before submitting an on-chain transaction.

Multi-wallet self-dealing is outside the protocol's on-chain identity model and should be treated as an analytics / abuse-monitoring concern. The hard invariant here is narrower: one address must not become both lender and borrower on the same new loan.

The policy closes three risks: (1) a user paying themselves the matcher kickback portion of the Loan Initiation Fee, (2) a user pumping their share of the cross-chain reward denominator with manufactured activity, and (3) the protocol's active-loan analytics being polluted by positions a single user already owns. Legitimate position-rebalancing flows go through the dedicated Preclose and Refinance entry points, which are unaffected.

The check applies to all direct acceptance and permissionless matching paths.

### Direct-Accept Preview

Before a user accepts an offer directly, the protocol and frontend should expose a preview of the acceptance outcome without changing state. The preview should show the effective principal, interest rate, required collateral, Loan Initiation Fee estimate, residual collateral refund, and the exact reason acceptance is currently blocked when a blocker exists.

The preview should preserve the resolved economic terms even when acceptance is blocked, provided those terms can be shown safely. This lets the frontend explain whether the user needs a higher verification tier, whether the offer has expired, whether legal or sanctions checks block the action, whether protocol pause state applies, or whether the requested country / asset combination is incompatible.

### Example:

**ERC-20 Loan Initiation:**

- Bob (Borrower) accepts Alice's (Lender) offer for 1000 USDC.
- Bob locks his required ETH collateral. Gas fees for this acceptance transaction are paid by Bob.
- A `Loan Initiation Fee` of `0.1%` of the lending asset is charged at initiation, so `1 USDC` is routed to treasury and `999 USDC` is transferred to Bob.
- Alice's "Vaipakam NFT" status (with lender role) is updated as "Loan Initiated".
- A new "Vaipakam NFT" is minted for Bob (status: "Loan Initiated" and role: "Borrower").

## 6. Loan Closure & Repayment

### Repayment Logic

**ERC-20 Lending:**

- A loan repayment transaction may be submitted by the borrower or by any third party willing to pay on the borrower's behalf.
- For ERC-20 loans, the repayment amount remains: `Principal + Interest`.
- Partial repayments must allocate interest-first before reducing principal when periodic-interest mode is enabled for the loan. The preview path should show the same split the settlement path will apply, so borrowers can see how much of a proposed payment covers the current period's accrued interest and how much reduces principal.
- If a third party repays on behalf of the borrower, that third party does **not** gain any right to the collateral by making the payment alone.
- After repayment, the collateral remains claimable only by the holder of the Vaipakam borrower NFT for that loan. Repayers must be clearly warned in the frontend and product flow that repayment does not transfer collateral ownership or collateral-claim rights.
- Borrower-initiated swap-to-repay is an atomic repayment variant for
  ERC-20-on-ERC-20 loans. The current borrower-position NFT holder may
  swap pledged collateral into the principal asset and apply the proceeds
  to the same repayment waterfall in one transaction, avoiding the
  withdraw / external swap / redeposit / repay sequence.
- Swap-to-repay supports a full-close mode that drives the loan to
  `Repaid` and a partial-reduction mode only when the original offer
  opted into partial repayment. Partial mode must not be used when the
  swap proceeds would retire the full remaining principal; that case
  should route through the full-close path so close housekeeping, reward
  closure, and NFT status changes all fire.
- Swap-to-repay must reuse the existing governed swap-adapter failover
  path and configured venue set rather than introducing a new DEX
  authority surface. If every supplied adapter route reverts, the whole
  transaction reverts and the borrower can retry with better routing.
- Borrower-facing swap-to-repay slippage is capped by a dedicated
  protocol knob that defaults tighter than the liquidation cap because
  the borrower chooses when to act. The cap remains bounded by the
  protocol-wide slippage ceiling.
- Authority follows the current borrower-position NFT owner. A lender
  or current lender-position NFT holder must be blocked by the same
  lender-self-repay guard used by ordinary repayment.
- Full-close settlement mirrors ordinary repayment: lender entitlement
  is deposited to the lender vault, treasury receives its fee share,
  borrower LIF rebate / reward close handling runs, any prepay listing
  is cleared, and unused pledged collateral becomes borrower-claimable.
  Favorable-quote surplus principal should transfer directly to the
  current borrower-position NFT holder's wallet.
- Interest Formula: `Interest = (Principal * AnnualInterestRate * LoanDurationInDays) / (100 * DAYS_PER_YEAR)`. (Note: use standardized protocol constants such as `DAYS_PER_YEAR` and `SECONDS_PER_YEAR` rather than hard-coded literals like `365`, and ensure consistent precision, e.g., rate stored as basis points).
- Late fees apply if repayment occurs after the due date but within the grace period, or if repayment is forced post-grace period.

**NFT Lending (Renting):**

- Borrower's Obligation: Ensure the NFT can be 'returned' (user status revoked by the platform) and all rental fees are paid.
- Rental Fee Payment: Rental fees are automatically deducted from the borrower's initial prepayment.
- If borrower closes rental term for NFT on time:
  - The Vaipakam Vault contract revokes the borrower's 'user' status for the NFT.
  - The 5% buffer from the prepayment is returned to the borrower.
  - The accumulated rental fees (minus treasury fee) are made available for the lender to claim.
- Late fees apply if the NFT 'rental closure' (user status revocation) is delayed beyond the agreed duration.

### Late Fees

- A late fee of 1% of the outstanding principal (for ERC-20 loans) or overdue rental amount (for NFT renting) is applied on the first day after the due date.
- The late fee increases by an additional 0.5% daily.
- The total late fee is capped at 5% of the outstanding principal or total rental amount.
- Late fees are collected along with the repayment and are subject to treasury fees.

### Treasury Fees

- For ERC-20 loan initiation, the Vaipakam platform treasury collects a `Loan Initiation Fee` equal to `0.1%` of the lending-asset amount before net loan proceeds are delivered to the borrower.
- The Vaipakam platform treasury collects a fee of 1% of any interest earned by lenders or rental fees earned by NFT owners.
- The treasury also collects late fees paid.
- These fees are automatically deducted by the smart contract at the relevant stage of the lifecycle: the `Loan Initiation Fee` at ERC-20 loan start, and the treasury share on interest, rental fees, and late fees when those amounts are settled or claimed.

### Periodic Interest Payments

Periodic interest payment is a dormant Phase 1 feature controlled by `periodicInterestEnabled`. When disabled, offer creation must reject non-`None` cadences, settlement entry points must not execute, and the frontend should hide cadence-related controls.

Purpose:

- reduce lender exposure on long-duration and large-principal ERC-20 loans by requiring interest to be settled during the loan instead of only at maturity
- make missed interest obligations visible before final default
- reuse the existing liquidation and default-grace infrastructure rather than creating a parallel enforcement model

Eligibility:

- applies only to ERC-20 loans where both the lending asset and collateral asset are liquid under the active-chain oracle / liquidity checks
- if either side is illiquid, cadence must be `None`; multi-year illiquid loans do not receive a mandatory annual checkpoint because the protocol cannot safely auto-sell collateral
- cadence intervals must be shorter than the loan duration; a checkpoint at or after maturity adds no value because terminal repayment already covers all owed interest

Cadence rules:

- supported cadence enum: `None`, `Monthly`, `Quarterly`, `SemiAnnual`, `Annual`
- loans longer than 365 days must use at least `Annual` cadence when the feature is enabled and both legs are liquid
- lenders may choose finer cadence for large-principal loans when principal value meets the configured threshold
- the principal threshold is denominated in the active protocol numeraire, USD by default
- `setNumeraire(ethNumeraireFeed, numeraireChainlinkDenominator, numeraireSymbol, pythCrossCheckFeedId, minPrincipalForFinerCadence, notificationFee, kycTier0Threshold, kycTier1Threshold)` must update the oracle-side numeraire inputs and all numeraire-denominated stored values atomically; within-numeraire tuning uses the per-knob setters
- cross-numeraire changes are additionally gated by `numeraireSwapEnabled`, default `false`

Cadence-to-grace mapping:

- the existing six-slot default-grace schedule is reused; no separate grace schedule is introduced for periodic interest
- Monthly maps to the short-loan bucket, Quarterly to the 90-day bucket, SemiAnnual to the 180-day bucket, and Annual to the 365-day bucket
- if the borrower has not paid the expected interest by the checkpoint plus the mapped grace window, any address may settle the period

Settlement:

- `previewPeriodicSettle(loanId)` should expose cadence, period end, grace end, expected interest, amount paid by borrower, shortfall, and whether settlement is currently callable
- if shortfall is zero, settlement only stamps the checkpoint forward and resets period accounting
- if shortfall is positive after grace, a permissionless settler may submit the normal liquidation adapter try-list to sell only enough collateral to cover the shortfall plus configured buffers
- settler bonus, treasury handling charge, slippage ceiling, and fallback behavior reuse the existing liquidation policy: dynamic liquidator / settler incentive from the remaining slippage budget capped at 3%, 2% treasury handling charge, and the configured max liquidation slippage threshold as the single shared lever
- failed or over-slippage swap attempts should follow the same collateral-equivalent fallback principles used by ordinary liquidation

Repayment and refinance interaction:

- `repayPartial` accrues the interest portion into `interestPaidSinceLastPeriod`; if a payment covers the expected period interest after the period has ended, the checkpoint may advance in the same transaction
- refinance must settle the old loan's overdue periodic-interest period first. If the old period is past grace, `refinanceLoan` should revert until `settlePeriodicInterest` makes the original lender whole.

Watcher and notification support:

- the operations Worker should extend its scheduled loan-monitoring lane to pre-notify both borrower and lender before the next periodic-interest checkpoint
- `preNotifyDays` is a shared bounded knob for maturity reminders and periodic-interest checkpoint reminders; default 3 days, allowed range 1 to 14 days
- checkpoint notification de-duplication should be keyed to the exact checkpoint timestamp so retries do not spam users

### Claiming Funds/Assets

- **Lender/NFT Owner:** To claim their principal + interest (for ERC-20 loans) or rental fees (for NFT renting), the lender/NFT owner must interact with the platform and present their "Vaipakam NFT" to prove ownership and authorize the withdrawal of funds due to them.
- **Borrower:** To claim back their collateral (for ERC-20 loans, after full repayment) or their prepayment buffer (for NFT renting, after proper return and fee settlement), or after liquidation (if any remaining asset after covering total repayment and fees) the borrower must interact with the platform and present their "Vaipakam NFT" to claim thier funds.
- **Third-Party Repayer Clarification:** A wallet that repays a loan without holding the borrower's Vaipakam NFT is treated only as the payment sender. That wallet must not receive the collateral automatically and must not gain collateral-claim rights merely because it funded the repayment. The collateral claim remains exclusively tied to the borrower-side Vaipakam NFT.
- **Current NFT Holder Claim Authority:** Every lender-side or borrower-side claim path must authorize the current holder of the corresponding Vaipakam position NFT, not merely the original loan party recorded at loan creation. Claim payouts should be delivered directly to the current NFT holder's wallet so a secondary-market recipient can claim without first having a Vaipakam Vault. Where an internal vault withdrawal needs the original party's vault to exist, the protocol may auto-provision that vault on demand as plumbing, but claim rights and payout routing remain tied to the current position-NFT holder.
- **Liquidation-Fallback Claim Clarification:** For liquid-collateral loans whose initial liquidation fails, there is no borrower-only waiting window; the lender may claim immediately. Until that lender claim is actually executed, the borrower may still fully repay the loan or add enough collateral to restore the position above the required LTV / Health Factor thresholds. Full repayment cancels the fallback path and preserves normal borrower collateral-claim rights. A collateral top-up may keep the loan active again only if the protocol thresholds are again satisfied before lender claim execution finalizes. Once lender claim execution starts, that execution path should not be auto-reversed during the same claim transaction. During lender claim, the system may attempt liquidation one more time. If that retry also fails, settlement must be done in collateral units: collateral equivalent to `lending asset due + accrued interest + 3% of the lending asset amount` goes to the lender, collateral equivalent to `2% of the lending asset amount` goes to treasury, and the remaining collateral stays attributable to the borrower. If the remaining collateral value is below the lender-side fallback entitlement, then the lender receives the full remaining collateral instead.
- **Fallback Snapshot View:** The claim surface should expose a read-only fallback snapshot for each loan, including lender / treasury / borrower collateral slices, principal-due figures, `active`, and `retryAttempted` state. Frontends should use this view when fallback breakdown data comes from storage rather than from the lifecycle event stream.

### NFT Status Updates on Closure

- Upon successful repayment and claiming of all assets/funds by respective parties, the status of the relevant Vaipakam NFTs (both lender's and borrower's) is updated to "Loan Closed" and burned (after claiming all funds). The Loan status is updated to "Loan Repaid."

### Example: ERC-20 Repayment

- Bob (Borrower) took a 30-day loan of 1000 USDC from Alice (Lender) at 5% APR.
- Interest due: `(1000 * 5 * 30) / (100 * 365) = 4.11 USDC` (approx).
- Bob, or any third party acting on Bob's behalf, repays 1004.11 USDC.
- Treasury fee: `1% of 4.11 USDC = 0.0411 USDC`.
- Alice, upon presenting her Vaipakam NFT, can claim `1000 (principal) + 4.11 (interest) - 0.0411 (treasury fee) = 1004.0689 USDC`.
- Bob's ETH collateral is released only to the holder of the borrower-side Vaipakam NFT upon presenting that NFT. A third-party repayer does not receive Bob's collateral merely by funding the repayment.
- Both Alice's and Bob's Vaipakam NFTs are updated to "Loan Closed" and burned.

## 7. Liquidation and Default

### Triggers

**ERC-20 Lending with Liquid Collateral:**

- **LTV Breach:** If the Loan-to-Value (LTV) ratio exceeds the loan's snapshotted liquidation threshold, based on fresh oracle pricing for both the borrowed asset and the collateral. For tiered-liquidation deployments, the threshold is selected from the collateral's effective liquidity tier at loan initiation and is stored with the loan so later tier degradation does not retroactively change that loan's liquidation gate.
- **Non-Repayment Post Grace Period:** If the borrower fails to repay the loan (principal + interest + any late fees) by the end of the grace period.

**ERC-20 Lending with Illiquid Collateral:**

- **Non-Repayment Post Grace Period:** If the borrower fails to repay the loan by the end of the grace period. LTV is not applicable as illiquid collateral has a platform-assessed value of $0 for this purpose.

**NFT Lending (Renting):**

- **Non-Return/Fee Default Post Grace Period:** If the borrower fails to 'close the rental' of the NFT (allow user status to be properly revoked) and settle all rental fees by the end of the grace period.

### Processes

**ERC-20 Lending with Liquid Collateral:**

- **Liquidation:** The borrower's collateral is liquidated through the configured swap-adapter failover path to recover the outstanding loan amount (principal + accrued interest + late fees + liquidation penalty/fee).
- **Internal-Liquidation Matching:** When enabled, the liquidation path should first try to clear distressed loans against other distressed loans with opposing asset directions before using external aggregators. Eligible legs include active distressed loans and fallback-pending loans when the relevant assets can be priced by the oracle. A two-loan match can clear one loan's principal with the other loan's collateral and vice versa through protocol-controlled custody. A three-loan cycle may also clear an asset loop where each loan's collateral is the next loan's principal asset. This path avoids DEX slippage and aggregator fees because both legs are priced by the protocol oracle and settled internally.
- **Internal-Match Priority Window:** Internal matching has a configurable priority window above the snapshotted liquidation threshold. While a distressed loan is inside that window, ordinary external liquidation should be blocked when the internal-match switch is enabled, giving keepers time to find a matching counterparty. Once LTV rises beyond the priority window, the external liquidation path reopens so bad-debt protection is not delayed indefinitely.
- **Internal-Match Incentive and Surplus Handling:** The internal matcher may receive a bounded per-leg incentive from each matched notional amount. The incentive must be lower than the typical external liquidation cost surface and must be range-bounded by governance. Any residual borrower collateral after a partial internal match remains claimable through the ordinary borrower claim path. Likewise, a **full** internal-match close of an over-collateralized loan (where the match consumes less collateral than the borrower pledged) must leave the over-collateralization residual **protected** — its collateral protection retained (not torn down and freed) — and recorded as claimable through the ordinary borrower claim path, owed to the current holder of the borrower position. The residual must not be freely withdrawable by the stored loan record's original borrower once the position has been transferred away (the same transferred-position drain protection that governs proper closes — see §2207). This applies to both the active-loan full-close and the fallback-rescue full-close. Retrieving this residual is a **borrower-side** action: it closes the borrower position but does not by itself settle the loan, which remains in the internally-matched terminal state until the lender side also closes. The lender side of an internal match closes through the **ordinary lender claim path**: the lender's matched proceeds are recorded as a lender claim owed to the **current** holder of the lender position (which matters once that position has been transferred away — the proceeds sit in protocol-controlled custody and are not freely withdrawable by the stored loan record's original lender). Claiming pays the current holder, closes the lender position record, and settles the loan once **both** sides have cleared. The two claims are symmetric and order-independent: a borrower residual claim alone does not settle the loan while the lender proceeds are still unclaimed, and a lender claim alone does not settle it while a borrower residual is still owed; an exactly-collateralized (zero-residual) match has no borrower residual, so it settles on the lender claim alone. A fallback-pending loan that has received an extra collateral top-up while awaiting cure is **eligible** for internal matching, settled with top-up-aware accounting. Such a loan's collateral is split — the original sits in protocol custody (moved there at fallback) while the top-up sits in the borrower's own vault under a collateral lock — and internal-match settlement always draws the moved collateral from protocol custody. Only the **custody-held portion** participates in a match; the vault-held top-up never does. Sizing each leg's matchable contribution against its custody-held portion only keeps the draw bounded by what the protocol actually holds, so it never over-draws into custody belonging to other loans parked in the same asset. The vault-held top-up stays where it is, locked in the borrower's vault, and is folded into the borrower's residual claim so it is returned to the **current** borrower-position holder (never a stale original borrower if the position was transferred away). On a full match the loan settles to the internally-matched terminal state and the whole remaining collateral — the custody residual plus the untouched top-up — becomes claimable by that holder; on a partial match the loan stays fallback-pending and its fallback snapshot is scaled against the custody portion only, leaving the top-up lock intact for a later match or in-kind payout; an exactly-collateralized match (custody portion fully consumed) settles with only the top-up returned to the holder. The same custody-portion-only rule governs the speculative collateral re-swap a fallback claim may attempt, so that path is likewise bounded for topped-up loans. (Earlier in the rollout these loans were excluded from internal matching altogether, before the accounting that reconciles a vault-held top-up against the custody draw existed; that exclusion has been replaced by the top-up-aware accounting described here.)
- **Internal-Matched Terminal State:** A fully internally matched loan should transition from active to a terminal internally matched state. That state must be treated as claim-eligible for the same claim-center and NFT-rights purposes as other terminal loan states, while preserving event and timeline detail that the loan closed through internal matching rather than external swap liquidation.
- **Fallback-Pending Internal-Match Rescue:** A fallback-pending loan may be used as an internal-match leg if oracle pricing is available for the assets being compared. Because the loan has already crossed into fallback handling, the ordinary active-loan LTV eligibility gate is not relevant for that leg. Before settlement, the protocol must restore any fallback-held collateral into the normal settlement path in an idempotent way so the same custody and accounting rules apply. A full fallback-pending match should replace the collateral-denominated at-fallback claim records with the principal-asset matched proceeds recorded as a lender claim (owed to the current lender-position holder), move the loan to the internally matched terminal state, forfeit any treasury entitlement that existed only because the loan was in fallback, and leave any borrower residual in the ordinary borrower claim lane. A partial fallback-pending match should leave the loan fallback-pending, proportionally reduce the recorded fallback snapshot and claim records to the remaining residual, and allow later matches or fallback claims to use that reduced state.
- **Swap Failover:** The liquidation caller supplies a ranked try-list of swap adapter calls. Production routing may include 0x Settler, 1inch v6, Uniswap V3, and Balancer V2. The Diamond tries routes in the submitted order and falls back to the next route if a venue reverts, returns insufficient output, or becomes stale.
- **Split-Route Liquidation:** The protocol may expose a permissionless split-route liquidation entry point where the caller supplies a list of `(route, collateralAmount)` legs whose amounts sum exactly to the loan's total collateral. The Diamond executes the legs sequentially and accepts the transaction only if the combined output clears the same oracle-derived floor required for a single-route liquidation. Any failed leg or insufficient combined output must revert the whole transaction; partial split settlement is not allowed.
- **Liquidator-Buys-at-Discount Path:** The protocol may also expose `RiskFacet.triggerLiquidationDiscounted(loanId, recipient, extraData)` as an optional permissionless liquidation path. In this path the liquidator pays the full debt in the principal asset and receives oracle-priced collateral at the effective tier discount, delivered to `recipient`. Any borrower collateral surplus stays in the borrower's Vaipakam Vault but remains **encumbered and claimable only by the current holder of the borrower-side Vaipakam position NFT** (through the standard borrower claim path) — it is not freely withdrawable by the original loan wallet. This is the §2207 collateral-protection invariant + §895 current-NFT-holder claim authority applied to this path: a borrower who has transferred their position away cannot drain the surplus before the rightful holder claims it. (Resolves divergence D-α — the earlier "ordinary withdrawable balance" wording predated the transferred-position drain analysis; see `docs/DesignsAndPlans/CollateralLienLifecycle.md` §6.) The loan transitions through the same terminal liquidation state and NFT status handling as the atomic-swap path, and borrower-side VPFI LIF custody is forfeited to Treasury on liquidation.
- **Discount Path Gates:** The discounted path is controlled by an independent `discountPathEnabled` master switch that defaults off. It must also enforce the ordinary borrower-protection gates: active loan, Health Factor below `1.0`, sequencer healthy, sanctions / compliance checks where configured, and fresh oracle quorum for both principal and collateral. Discount-specific gates include non-zero recipient and tier-classified collateral; Tier `0` / untierable collateral must revert because the discount schedule is per tier.
- **Per-Tier Discount Bounds:** The effective liquidation discount should be tier-specific, with defaults of `7.7%`, `6.0%`, and `5.0%` for tiers `1`, `2`, and `3`. Admin configuration through `ConfigFacet.setTierLiqDiscountBps(t1, t2, t3)` must be atomic across all three tiers and bounded by safety boxes: Tier 1 `[3%, 15%]`, Tier 2 `[3%, 10%]`, and Tier 3 `[2%, 8%]`, with the cross-tier monotonic invariant `T1 >= T2 >= T3`.
- **Flash-Loan Receiver Support:** A standalone flash-loan liquidator receiver may support Aave V3 and Balancer V2 callbacks for keeper-bot funded discounted liquidations. The receiver should initiate a flash loan, pay the distressed position through the Diamond before any collateral leaves protocol custody, swap seized collateral back to principal through off-chain-supplied DEX-direct calldata, and revert the whole transaction unless proceeds cover debt plus flash-loan fee and configured gas/profit headroom. The keeper bot should not hold user funds between transactions; either the atomic liquidation repays the flash loan successfully or all state changes revert. Owner-gated receiver entry points are keeper operational controls only; the Diamond discounted liquidation entry point remains permissionless.
- **Per-Tier Liquidation Thresholds:** Liquidation thresholds should be tier-specific rather than per-asset. Defaults should preserve a risk gradient across tiers, with deeper assets receiving higher liquidation thresholds and thinner assets receiving lower thresholds. Governance may tune the tier thresholds only within bounded ranges and must preserve cross-tier ordering so Tier 1 remains at least as conservative as Tier 2, and Tier 2 at least as conservative as Tier 3.
- **Internal-Match Kill Switch:** Internal matching must default off on fresh deployments and must be independently controllable from the discounted-liquidation path and the depth-tiered-LTV switch. Disabling the internal-match switch should immediately restore the ordinary external liquidation behavior.
- **Exact-Scope Adapter Approvals:** For each swap attempt, the Diamond approves only the exact input amount needed for that adapter and revokes the approval after the attempt, regardless of success or failure. There are no persistent DEX allowances left behind by liquidation routing.
- **Oracle-Anchored Slippage Floor:** The on-chain oracle-derived minimum output remains authoritative. Keeper- or frontend-supplied `minOut` values may be stricter but cannot weaken the configured liquidation slippage floor.
- **Adapter Registration:** Mainnet deployments must register at least one swap adapter before liquidation settlement can operate. A deployment with no registered adapters reverts swap-based liquidation attempts and therefore reaches the documented collateral fallback path.
- **Permissionless Triggering Preserved:** Any address may call liquidation/default triggers once protocol conditions are met. The caller supplies routing data; there is no new liquidator role gate.
- **Liquidation Handling Charge:** If liquidation succeeds through the normal swap path, treasury must receive an additional liquidation-handling charge equal to `2%` of liquidation proceeds because the borrower failed to act before liquidation. This handling charge is separate from the liquidator incentive and separate from any treasury fee that may still apply on recovered interest or late-fee amounts.
- **Slippage Protection:** If the liquidation swap would incur slippage greater than 6%, the collateral conversion must not happen. In that case, the liquidation flow must stop using the DEX conversion path and must follow the same equivalent-collateral fallback procedure used for abnormal liquidation-failure conditions.
- **Governance Configuration:** The maximum liquidation slippage threshold should be configurable by governance within an approved bounded range. The Phase 1 administrator for this setting is the multisig / timelock path.
- **Fallback Claim Model:** When the DEX liquidation path is abandoned because every configured swap route fails, market conditions are abnormal, liquidity is unavailable, technical execution fails, or the configured slippage threshold would be exceeded, the protocol should resolve the lender side into a claimable collateral-equivalent position rather than automatically giving the lender the borrower's full liquid collateral. There is no separate borrower grace period in that state; the lender may claim immediately after the failed liquidation. However, until the lender claim is actually executed, the borrower may still either fully repay the loan or add enough collateral to restore the loan above the required LTV / Health Factor thresholds. If full repayment finalizes first, the fallback path is canceled and the borrower later claims back the collateral through the ordinary repayment flow. If a collateral top-up finalizes first and the position is again healthy, the loan may continue as active. Once lender claim execution starts, that claim path should not be interrupted or auto-revived during the same transaction. In that lender-claim branch, the lender or a keeper may supply a fresh ranked try-list for one more liquidation attempt and may also attempt an internal-match rescue where a priceable opposing leg exists. If a retry or internal match succeeds, settlement follows the successful path and the fallback claim records are cleared or reduced accordingly. If all retry and rescue paths fail, the lender later claims only the amount of collateral asset needed to satisfy the lender-side fallback entitlement by presenting the Vaipakam lender NFT, unless the remaining collateral value is lower than that fallback entitlement or oracle quorum pricing is unavailable, in which case the lender receives the full remaining collateral. The treasury receives the configured fallback handling entitlement where applicable, and any excess liquid collateral value remains attributable to the borrower.
- **Oracle-Unavailable Fallback Branch:** The collateral-equivalent fair-value split requires fresh prices for both collateral and principal from the multi-source oracle quorum. If either side lacks a fresh quorum price when the failed-swap fallback is settling, the fallback must not leave the distressed loan pinned in `Active`; it should settle through the full-collateral-to-lender branch used for illiquid collateral and emit `LiquidationFallbackOracleUnavailable` or equivalent dedicated telemetry. `OracleFacet.tryGetAssetPrice` should expose a no-revert availability read so settlement code can choose between the fair-value split and the oracle-unavailable branch without catching a revert from the ordinary price reader.
- **Partial Liquidation:** For active, in-term loans that are only mildly underwater, a keeper may liquidate a bounded fraction of collateral instead of closing the whole position. The proceeds are applied interest-first and then principal, the loan remains `Active`, maturity is preserved, and the interest clock restarts on the reduced principal from the partial-liquidation timestamp. The call must strictly improve Health Factor and restore it to at least `1.0`; otherwise it reverts and the keeper must choose a larger fraction or fall back to full liquidation.
- **Partial Liquidation Bounds and Sizing:** Governance controls the minimum and maximum partial fraction within bounded ranges. The keeper should compute the smallest feasible fraction that restores Health Factor above the configured target buffer, using the collateral asset's liquidation threshold from `getAssetRiskProfile`, the on-chain Health Factor formula, the protocol's effective liquidation deductions, and an extra swap-slippage safety margin. The launch bounds are `2%` minimum and `75%` maximum, with the common eligibility band defaulting to `[0.95, 1.0)`. If the computed fraction is outside bounds, the read needed for the calculation fails, the loan is after maturity, or the partial would close all remaining principal, the keeper should fall back to the prior safe path: fixed-fraction partial only where still valid, split-route, or ordinary full liquidation. Full liquidation remains preferred once the computed fraction is effectively closing the loan because it produces the terminal event and refunds borrower surplus explicitly.
- **Partial Liquidation Atomicity:** Partial liquidation has no soft fallback. If every supplied adapter leg fails or the post-mutation Health Factor gate cannot be satisfied, the transaction reverts and the borrower vault remains untouched. Repeated partial liquidations are allowed only when each call independently passes the same in-term, fraction, output, and Health Factor gates, and each successful call must emit a non-terminal event for indexers.
- **Proceeds Distribution:**
  - Lender is repaid.
  - Treasury receives the `2%` liquidation-handling charge on successful liquidation.
  - Treasury fees are collected.
  - Any excess funds remaining after covering all obligations are returned to the borrower.
  - If proceeds are insufficient to cover the lender's due amount, the lender bears that loss (unless specific undercollateralized loan insurance is a future feature).

**ERC-20 Lending with Illiquid Collateral:**

- **Full Collateral Transfer:** Upon default (non-repayment after grace period), the _entire_ illiquid ERC-20 collateral is allocated to the lender. No LTV calculations or liquidation auctions occur.
- **Claim Procedure:** In Phase 1, this full-collateral-transfer result may be implemented through the protocol’s normal Vaipakam NFT claim model rather than by requiring an immediate automatic push transfer. The lender’s Vaipakam lender NFT must authorize the collateral claim.

**NFT Lending (Renting) Default:**

- **Collateral Forfeiture:** The borrower’s full ERC-20 prepayment (which includes total rental fees + 5% buffer) is transferred to the NFT owner (lender), after deducting applicable treasury fees from the rental portion.
- **NFT Return:**
  - For ERC-721: The borrower's 'user' status is revoked by the platform. The NFT remains in Vaipakam Vault until it is returned to the lender through the normal rental/default settlement flow.
  - For ERC-1155: The NFT held in the Vaipakam Vault is returned to the lender. The borrower's 'user' status is revoked.

### NFT Status Updates on Default/Liquidation

- The status of the relevant Vaipakam NFTs is updated to "Loan Defaulted" or "Loan Liquidated."

### Example: ERC-20 Liquidation (Liquid Collateral)

- Bob borrowed 1000 USDC against 0.5 WETH. WETH price drops, and his LTV exceeds 90%.
- The liquidation process is triggered. Bob's 0.5 WETH is sold.
- Assume sale yields 1020 USDC. Alice is owed 1004.11 USDC (principal + interest). After treasury fees on interest, Alice receives her due. Remaining amount (e.g., $1020 - ~$1004.11 - liquidation costs) is returned to Bob.

### Example: NFT Renting Default

- Bob rents a CryptoPunk for 7 days (total rental fee 70 USDC, prepayment 73.5 USDC including buffer).
- Bob fails to 'return' the NFT or there's an issue with fee settlement by the end of the grace period.
- The full 70 USDC rental is claimed by Alice (the lender), minus treasury fees on the 70 USDC rental portion. Alice's CryptoPunk 'user' status for Bob is revoked, and the vaulted NFT can be returned to Alice under the rental settlement rules, extra buffere amount will also go to treasury.

## 8. Preclosing by Borrower (Early Repayment Options)

Borrowers may close or transfer their obligations before the originally scheduled maturity date. For Phase 1, three borrower-side preclose paths are supported. In all cases, the platform must ensure that the original lender is not economically disadvantaged compared to the agreed loan terms, except where the borrower explicitly defaults under the normal default flow.

### General Rules for All Borrower Preclose Options

- Only the current borrower of an active loan may initiate a borrower preclose flow.
- The wallet that initiates a borrower preclose flow must also be the current `ownerOf` the borrower-side Vaipakam NFT for that loan. Strategic borrower-side actions must follow the borrower position NFT holder, not merely the original borrower wallet if the NFT has been transferred.
- A rented `userOf` address, approved keeper, or third-party helper must not be sufficient to start a new borrower preclose flow. Such delegated roles may be allowed only on explicitly documented keeper-enabled completion functions.
- A borrower preclose flow is only valid while the loan status is `Active`.
- If the loan has already been repaid, defaulted, liquidated, sold, transferred, or settled, borrower preclose is not allowed.
- During borrower preclose flows, the principal/lending asset type, payment/prepay asset type, and collateral asset type used for the replacement, transfer, or offset flow must remain the same as the original active loan. The amount of the principal/lending asset, payment/prepay asset, or collateral asset may vary if permitted by the specific option, but the asset types themselves must not change. The platform must not allow a different principal/lending asset type, payment/prepay asset type, or collateral asset type in these flows, so that the original lender is not exposed to unexpected asset-substitution risk.
- During borrower preclose flows, any newly created offer or any already existing offer that is accepted must favor the original lender. In practice, the replacement duration, lending amount, and collateral amount must not leave the original lender in a worse position than the original remaining loan economics and protection. If the selected offer is otherwise less favorable, the borrower must cover the shortfall or provide whatever top-up is required so that the original lender remains economically whole.
- Treasury fees continue to apply according to the platform’s standard rules unless explicitly stated otherwise.
- All claimable funds created during preclose must follow the same claim model used elsewhere in the protocol:
  - lender-side value becomes claimable by the lender against the lender’s Vaipakam NFT
  - borrower-side returned collateral or refunds become claimable by the borrower against the borrower’s Vaipakam NFT
- Funds the borrower posted up front — the rental prepay, the collateral — are always drawn from the **borrower of record's** vault when a close settles, regardless of who triggers that close. A close may be initiated by the borrower, by an authorised keeper, or by a transferred borrower-position holder, but the rental fees and treasury cut taken at an NFT-rental preclose (and any collateral movement on any close) must come from where the borrower's funds actually live — the original borrower's vault — never from the caller's own funds. Keying any such deduction on the transaction caller is incorrect: it would either fail when the caller holds no such funds, or wrongly pull the caller's personal funds.
- If the loan is an NFT rental, preclose changes user rights rather than transferring the underlying NFT to the borrower. For both ERC-721 and ERC-1155 rentals, the NFT must be held in the appropriate Vaipakam Vault for that active rental position, with the Vaipakam admin/vault controller as the vault custodian/owner while vaulted. During preclose transfer, the platform revokes the original borrower’s temporary user rights and assigns temporary user rights to the new borrower only.
- The relevant Vaipakam NFTs must be updated to reflect the new state of the position.
- Before the borrower signs any preclose transaction, the frontend should show a path-specific interest implication warning: direct close requires full-term interest, transfer requires accrued interest plus any protected-rate shortfall, and offset requires accrued interest plus any rate shortfall and fresh principal collateral for the offsetting offer.

### Option 1: Standard Early Repayment

The borrower may close the loan early by repaying the full outstanding principal plus the full interest that would have been due for the original agreed loan term.

#### Process

1. The borrower initiates early repayment on an active loan.
2. The platform calculates:
   - principal outstanding
   - full contractual interest for the originally agreed loan term
   - any additional fees that are still applicable under the platform rules
   - treasury fee on the lender’s interest or rental earnings
3. The borrower pays the required repayment amount.
4. The platform allocates:
   - lender claimable amount
   - borrower claimable collateral or refund amount
   - treasury fee amount
5. The loan is marked as repaid and both parties may claim their respective assets using their Vaipakam NFTs.

#### ERC-20 Loan Outcome

- The borrower pays:
  - full principal
  - full contractual interest for the original duration
- The lender becomes entitled to:
  - principal
  - interest minus treasury fee
- The borrower becomes entitled to:
  - full eligible collateral return
- The treasury receives:
  - treasury fee on the interest portion
  - any other applicable platform fees

#### NFT Rental Outcome

- The borrower closes the rental before scheduled maturity.
- The lender becomes entitled to the rental fees due under the applicable early-close rule.
- The borrower becomes entitled to any refundable unused prepayment and the buffer amount, subject to platform rules.
- The borrower’s NFT `user` right is revoked.
- For ERC-721 rentals, the NFT itself remains in the appropriate Vaipakam Vault under admin/vault-controller custody; only the borrower’s ERC-4907 `user` access is removed.
- For ERC-1155 rentals, the NFT remains controlled by the appropriate Vaipakam Vault under admin/vault-controller custody; only the borrower’s temporary user right is removed.

#### NFT and Status Updates

- Borrower and lender Vaipakam NFTs are updated from active status to a claimable or closed state.
- After both sides complete their claims, the NFTs may be burned and the loan moves to its final settled state.

---

### Option 2: Loan Transfer to Another Borrower

The original borrower may transfer the repayment obligation to a new borrower, provided that the original lender’s expected economics are protected.

#### Participants

- Original borrower: Alice
- New borrower: Ben
- Original lender: Liam

#### Purpose

This option allows Alice to exit her borrower position while Ben takes over the debt obligation for the remaining permitted term. In Phase 1, this option is specifically handled by Alice accepting an already existing compatible borrower offer created by Ben.

#### Preconditions

- The original loan must be active.
- Ben must be a valid new borrower address.
- The principal/lending asset type, payment/prepay asset type, and collateral asset type of Ben’s transferred position must be exactly the same as the principal/lending asset type, payment/prepay asset type, and collateral asset type of Alice’s original loan.
- Ben must provide collateral of the same asset type as Alice’s original collateral.
- Ben’s collateral amount must be greater than or equal to Alice’s required collateral amount at the time of transfer.
- The already existing borrower offer that Alice accepts must also preserve the same principal/lending asset type, payment/prepay asset type, and collateral asset type as the original loan.
- The selected transfer offer terms must favor Liam, the original lender. The replacement duration, lending amount, and collateral amount may vary only to the extent they do not reduce Liam's protection or expected economics. If they do, Alice must cover the difference.
- For `transferObligationViaOffer`, the protocol does not need to perform a fresh LTV or Health Factor gate solely because the borrower identity is changing, as long as the principal/lending asset type, payment/prepay asset type, and collateral asset type remain the same and the replacement collateral amount is not lower than the original collateral amount. Under that design choice, the original lender is treated as remaining on the same asset-risk profile established at loan initiation rather than being exposed to a new asset-substitution risk.
- Ben’s new loan end date must be on or before the original loan’s maturity date.
- Any jurisdiction, sanctions, KYC, and asset-eligibility rules that apply to normal loan initiation must also apply to the transfer.

#### Economic Protection for the Original Lender

Alice must ensure Liam is not disadvantaged by the transfer.

Alice must pay:

- all interest accrued on her loan up to the transfer time
- any shortfall between:
  - the interest Liam would have earned for the remaining term under Alice’s original loan
  - and the interest Liam is expected to earn for the remaining term under Ben’s transferred loan terms

#### Shortfall Formula

`Shortfall = max(0, Original Remaining Interest - New Remaining Interest)`

Where:

- `Original Remaining Interest` is calculated using the original loan principal, original rate, and remaining permitted duration
- `New Remaining Interest` is calculated using the transferred loan principal, Ben’s new rate, and Ben’s new duration

#### Smart Contract Actions

1. Ben locks eligible collateral.
2. Alice’s original collateral is released from her borrower position.
3. Alice pays:
   - accrued interest up to transfer time
   - any lender protection shortfall
4. These lender-protection funds are held for Liam and must become part of Liam’s claimable amount at final settlement or earlier valid claim points.
5. The active loan record is updated so that:
   - borrower becomes Ben
   - collateral amount and duration become Ben’s transferred terms
   - other transferred loan parameters are updated as applicable
6. No additional transfer-time LTV / Health Factor gate is required solely for the borrower handoff in `transferObligationViaOffer` when the transferred position preserves the same principal/lending asset type, payment/prepay asset type, and collateral asset type, and the replacement collateral amount is at least the original collateral amount.
7. NFT records are updated:
   - Alice’s borrower NFT is closed or burned
   - a new borrower NFT is minted for Ben
   - Liam’s lender NFT is updated to reflect the new borrower relationship
8. If the transferred obligation is an NFT rental, the platform keeps or moves the ERC-721/1155 NFT into the appropriate Vaipakam Vault for the continuing rental position, with the Vaipakam admin/vault controller retaining vault custody/owner control. Alice’s temporary user rights are revoked, and equivalent user rights are assigned to Ben for the remaining permitted rental term. Ben receives only ERC-4907-style user rights and never receives custody or ownership of the NFT itself.

#### Funds Flow

- Liam’s ultimate principal claim remains tied to the transferred live loan.
- Alice’s accrued-interest and shortfall payments are separately tracked for Liam and must not be lost or overwritten by later repayment flows.
- Ben becomes responsible for future repayment obligations going forward.

#### Final Outcome

- Alice exits the borrower position.
- Ben becomes the active borrower.
- Liam remains the lender on the same economic position, with lender-protection amounts preserved.

---

### Option 3: Offset with a New Lender Offer (Original Borrower Becomes a Lender)

The original borrower may exit her borrower position by taking a new lender-side position that offsets her original obligation. In Phase 1, this is handled by the original borrower creating a new lender offer and is available only for active ERC-20 loans. NFT rental loans and other non-ERC20 loan/rental positions are not eligible for borrower preclose Option 3 and must use standard rental repayment/preclose, transfer, default, or maturity flows. This is not a refinance flow.

#### Participants

- Original borrower: Alice
- Original lender: Liam
- New borrower on the offsetting offer: Charlie

#### Purpose

This option allows Alice to stop being Liam’s borrower by becoming a lender in a new loan of her own. The mechanism is an offsetting offer flow in which Alice becomes the lender on a new position through a lender offer she creates. It is not a refinance of the existing loan.

#### Preconditions

- Alice must have an active loan as borrower.
- Alice’s original loan must be an ERC-20 loan. NFT rental loans and other non-ERC20 loan/rental positions must be rejected from this Option 3 offset flow.
- Alice must fund the principal-equivalent lending asset required to take the new lender-side position.
- The new lender offer created by Alice must use the exact same principal/lending asset type, payment/prepay asset type, and collateral asset type as Alice’s original active loan.
- The amount of the principal/lending asset, payment/prepay asset, and collateral asset may vary if otherwise permitted by the flow, but the asset types themselves must not change.
- The duration of the offsetting position must not exceed the remaining term of Alice’s original loan and must favor Liam, the original lender, unless Alice fully compensates any resulting shortfall.
- The lending amount and collateral amount used in the offsetting offer may vary, but they must also favor Liam, the original lender. If the selected offer amounts reduce Liam's protection or economics, Alice must provide the compensating top-up needed to keep Liam whole.
- All normal offer-creation, offer-acceptance, sanctions, KYC, asset, vault, and matching checks apply to the offsetting offer flow.

#### Economic Protection for the Original Lender

Alice must ensure Liam receives the value he is still entitled to under the original loan.

Alice must pay:

- all accrued interest owed to Liam up to the time of offset processing
- any shortfall between:
  - Liam’s expected remaining interest under the original loan
  - and the interest Alice is expected to earn under the new lender offer over the permitted offset term

#### Shortfall Formula

`Shortfall = max(0, Original Remaining Interest - New Offer Expected Interest)`

Where:

- `Original Remaining Interest` is based on Liam’s original borrower loan to Alice
- `New Offer Expected Interest` is based on the selected offsetting offer terms and permitted duration

Example:

- If Liam is still entitled to $250 of protected remaining interest under Alice’s original loan and Alice’s new offsetting lender offer would only generate $150 over the same permitted term, Alice must cover the $100 shortfall, plus any accrued interest already owed up to offset time.

#### Flow (atomic on match)

##### Step 1: Enter the Offsetting Lender Position

1. Alice deposits principal-equivalent assets.
2. Alice creates a new lender offer (linked to her original borrower loan with Liam).
3. Alice pays:
   - accrued interest owed to Liam so far
   - any shortfall owed to Liam
4. These amounts are reserved for Liam and tracked separately until the counterparty matches the offer.

##### Step 2: Atomic offset completion when the offsetting offer is accepted

When the counterparty borrower accepts the linked offsetting offer, the Diamond finalises the offset in the same transaction as acceptance — Alice does not click a separate "Complete Offset" button on the happy path. Inside that single transaction:

1. The offsetting offer is matched through the standard offer flow.
2. The counterparty borrower locks the required collateral.
3. Alice's funded principal is transferred under the new loan.
4. Alice's original borrower-side collateral is released from her old loan with Liam.
5. Liam's original position is converted into a claimable settlement position under the offset rules.
6. Alice's original borrower loan is marked repaid or offset-closed.
7. Alice now holds the lender position in the new offsetting loan.

`PrecloseFacet.completeOffset(originalLoanId)` remains exposed as a manual recovery hook — for example, to rescue a loan whose offsetting offer was accepted before the auto-completion path was introduced, or to be driven by a keeper if the atomic completion ever needs to be re-attempted. Under normal operation this entry point is not called directly from the UI.

#### Required Settlement Result

When the offset completes, Liam must have a valid claim path for the full value owed under the old loan, including:

- original principal owed to Liam
- accrued interest owed up to offset time
- any shortfall paid by Alice
- minus applicable treasury fees

The protocol must not mark the original loan as repaid unless Liam’s full lender-side claimable value has been preserved.

#### NFT and State Updates

- Alice’s original borrower NFT is closed or moved to claimable/settlement state
- Liam’s lender NFT is updated to reflect closure of the original borrower relationship
- Alice receives or retains the correct lender NFT for the new offsetting loan
- The counterparty borrower receives the borrower NFT for the new offsetting loan

#### Final Outcome

- Alice exits her old borrower obligation to Liam
- Alice becomes lender in the new offsetting loan
- Liam’s old loan is settled through the offset path without loss of principal or expected protected value

---

## 9. Early Withdrawal by Lender

Lenders may exit or attempt to exit their positions before maturity. For Phase 1, lender-side early withdrawal supports sale-based exits and the passive wait-to-maturity fallback for ERC-20 loans only. NFT rental loans and other non-ERC20 loan/rental positions are not eligible for lender early withdrawal in Phase 1.

### General Rules for All Lender Early Withdrawal Options

- Only the current lender of an active loan may initiate a lender-side early withdrawal flow.
- The wallet that initiates lender-side early withdrawal must also be the current `ownerOf` the lender-side Vaipakam NFT for that loan. Strategic lender-side exit decisions must remain with the lender position NFT holder.
- A rented `userOf` address, approved keeper, or third-party helper must not be sufficient to start a new lender early-withdrawal flow. Such delegated roles may be allowed only on explicitly documented keeper-enabled completion functions.
- The loan must be in `Active` status.
- The loan must be an ERC-20 loan. NFT rental loans and other non-ERC20 loan/rental positions must be rejected from lender early-withdrawal flows.
- During lender early-withdrawal flows, the principal/lending asset type, payment/prepay asset type, and collateral asset type of the replacement or sale flow must remain the same as the original active loan. The amount of the principal/lending asset, payment/prepay asset, or collateral asset may vary if permitted by the specific option, but the asset types themselves must not change. The platform must not allow a different principal/lending asset type, payment/prepay asset type, or collateral asset type in these flows, so that the original borrower is not exposed to unexpected asset-substitution risk.
- During lender early-withdrawal flows, any newly created offer or any already existing offer that is accepted must favor the original borrower. In practice, the replacement duration, lending amount, and collateral amount must not make the original borrower worse off than under the existing live-loan position. If a candidate offer would worsen the original borrower's position, that offer must not be used for lender early withdrawal.
- Jurisdiction, sanctions, KYC, liquidity, and asset-validity checks continue to apply wherever a new counterparty enters the position.
- The borrower’s payment obligations under the live loan must remain well defined after the lender exit.
- NFT ownership and claim rights must move consistently with the economic position.

### Option 1: Sell the Loan to Another Lender

The original lender may transfer the active lender position to a new lender.

#### Participants

- Original lender: Liam
- Borrower: Alice
- New lender: Noah

#### Purpose

This option allows Liam to recover principal early by selling his lender position. In Phase 1, this option is specifically handled by Liam accepting an already existing compatible lender offer created by Noah.

#### Preconditions

- Liam must be the active lender on the loan.
- Noah must provide funds equal to the agreed purchase amount, typically the outstanding principal.
- Noah’s replacement lender position must preserve the same principal/lending asset type, payment/prepay asset type, and collateral asset type as the original live loan. The amount may vary if otherwise permitted by the transfer flow, but the asset types themselves must not change.
- Noah’s selected replacement offer terms must favor Alice, the original borrower. The replacement duration, lending amount, and collateral amount may vary only to the extent they do not worsen Alice's continuing obligation or collateral exposure.
- The sale structure must comply with the platform’s active offer and acceptance rules.

#### Economic Treatment

##### Accrued Interest

- Any interest accrued up to the time of sale is forfeited by Liam and routed to treasury, subject to the platform’s sale rules.
- This avoids complex retroactive splitting of interest across multiple lenders.

##### Principal Recovery

- Noah pays the agreed amount, typically equal to the outstanding principal.
- That amount is transferred to Liam.

##### Rate Difference / Shortfall Handling

If Noah’s replacement terms imply that the remaining lender-side economics differ from Liam’s original position, Liam may need to cover a shortfall.

Example rule:

- if Noah’s replacement yield for the remaining duration is higher than what Alice’s existing loan would produce, Liam must cover the difference
- forfeited accrued interest may first be applied toward that difference
- any remaining excess forfeited accrued interest goes to treasury
- if forfeited accrued interest is insufficient, Liam pays the remainder directly

##### Frontend Warning

- The frontend should display how much the original lender will net after accounting for forfeited accrued interest and any required shortfall payment before the sale is confirmed.
- The confirmation step should explicitly state that selling the lender position forfeits interest accrued so far, with forfeited interest routed to treasury or applied toward a rate shortfall before any remainder is handled under the sale rules.

#### Smart Contract Actions

1. Noah funds the purchase.
2. Liam receives the agreed principal recovery amount. Where possible, the sale flow should prefer net settlement so protocol-defined forfeitures or shortfalls can be deducted directly from the incoming proceeds instead of requiring Liam to source separate wallet liquidity in the same asset.
3. Accrued interest is forfeited and routed according to treasury rules.
4. Any required shortfall is paid by Liam.
5. The lender field on the loan is updated from Liam to Noah.
6. NFT updates occur:
   - Liam’s lender NFT is closed, burned, or marked sold
   - Noah receives the replacement lender NFT
   - Alice’s borrower NFT remains tied to the continuing live loan

#### Borrower Impact

- Alice remains borrower on the same loan obligation unless explicitly changed by another feature.
- Alice’s repayment schedule and collateral position continue under the loan, but future lender-side claims belong to Noah.

---

### Option 2: Create a New Offer Through the Borrower-Offer Path

The original lender may initiate early withdrawal through an offsetting offer flow. In Phase 1, this is handled by creating a new offer through the protocol’s borrower-offer path.

#### Purpose

This option allows Liam to initiate lender early withdrawal without relying only on an immediate direct buyer path. Instead of a separate direct-sale listing primitive, Liam exits through an offsetting offer flow in which he becomes the borrower-side participant and a new lender takes the lender-side position.

#### Offer Characteristics

The offsetting offer flow should represent:

- the outstanding principal exposure Liam wants to transition
- the same principal/lending asset as the original live loan
- the collateral context securing the underlying borrower loan
- the same collateral asset as the original live loan
- the same payment/prepay asset as the original live loan, if a separate payment asset is used
- the remaining duration
- the economic terms Liam is willing to accept for the transition
- duration, lending amount, and collateral amount that continue to favor Alice, the original borrower

This option is implemented through standard offer flows rather than through a separate specialized sale-offer primitive. In Phase 1, Liam uses the borrower-style offer creation path.

#### Required Documentation in the Protocol

For this option to be implementation-ready, the following must be explicit:

- how the borrower-offer path is being used for lender early withdrawal
- who vaults or locks funds during offer creation
- what exact amount the buyer pays when accepting
- whether the buyer must fund principal only or principal plus another negotiated amount
- how accrued interest forfeiture is handled
- how rate shortfalls are handled
- how the newly created offer links to the underlying live loan
- what happens if the borrower repays while the sale offer is still open
- how NFTs are updated on listing, acceptance, cancellation, and expiry
- how any temporary or internal-only loan created for the transition is atomically terminated and cleaned up so future implementation changes cannot leave inconsistent residual state

#### Intended Economic Result

- Liam typically aims to recover principal early.
- Accrued interest is still forfeited to treasury according to the lender-exit rules.
- If Liam selects or creates an offsetting offer on economically less favorable terms, Liam may recover less than full principal or may need to subsidize the transition.

#### Acceptance Outcome

When the offsetting offer is successfully matched:

1. the buyer pays the agreed amount
2. Liam receives the agreed lender-exit proceeds
3. the live loan’s lender rights transfer to the buyer
4. borrower obligations continue against the new lender
5. NFTs and claim rights are updated accordingly

---

### Option 3: Wait for Loan Maturity

If the lender does not find a suitable exit path, the lender may simply keep the position until the normal end of the loan.

#### Process

- The loan continues under the original terms.
- The borrower eventually:
  - repays normally
  - prepays through a supported borrower-side flow
  - or defaults/liquidates under the normal risk process
- The lender claims funds using the standard Vaipakam NFT-based claim process.

#### Outcome

- No transfer of lender rights occurs.
- No sale discount, sale shortfall, or accrued-interest forfeiture applies beyond the platform’s normal repayment/default rules.

### Implementation Checklist for Preclose and Early-Withdrawal Flows

For clarity and implementation consistency, every preclose or early-withdrawal option must define all of the following before coding:

- initiator
- counterparties
- required preconditions
- vault movements
- exact value owed to treasury
- exact lender claimable amount created
- exact borrower claimable amount created
- whether principal stays live in a new loan or becomes immediately claimable
- NFT state transitions
- revert conditions
- behavior if the linked offer is cancelled, expires, or is front-run by another state change
- whether duplicated sanctions / country / KYC / numeraire-valuation logic is sourced from a shared internal library rather than copied across facets
- whether temporary or transitional loan cleanup is sourced from a shared internal helper / library rather than manual repeated cleanup logic
- which standardized protocol constants are used for time and financial math instead of magic literals
- which custom errors are emitted for distinct failure cases so off-chain clients can diagnose failures cleanly
- whether a same-transaction collateral top-up path is supported when that is the only way to keep a transfer or offset flow above the required Health Factor, without weakening lender protections
- whether a given preclose path intentionally relies on same-asset-type continuity and same-or-higher collateral sizing instead of a fresh transfer-time LTV / Health Factor gate, and that choice is made explicit in both code and docs

## 10. Governance and VPFI Token Rollout

VPFI token deployment begins in Phase 1 through the token contract and minting path. VPFI-related fee-utility flows may also be integrated where explicitly described, while governance remains Phase 2 scope. The following section separates token deployment, fee utility, and later governance rollout details.

### Phase 1 Token Deployment and Minting

- **Token Contract (VPFI):** `VPFI` is Vaipakam's protocol token. In Phase 1, the token contract, cap, initial mint, and minting-control path may be deployed and wired, but governance usage remains deferred to Phase 2.
- **Core Token Parameters:**
  - Name: `Vaipakam DeFi Token`
  - Symbol: `VPFI`
  - Decimals: `18`
  - Hard supply cap: `230,000,000` VPFI
  - Initial mint: `23,000,000` VPFI (exactly 10% of the cap)
  - Minting authority: timelocked treasury / multi-sig controlled mint path only; no unrestricted EOA minting
- **Phase 1 Scope:** The Phase 1 token rollout is limited to deployment, registration, initial minting, future mint-cap transparency, and treasury / admin mint control where explicitly implemented.

### Governance (Phase 2)

- **Governance Token (VPFI):** VPFI becomes the governance and broader protocol token in Phase 2.
- **Proposal Scope:** Proposals can cover:
  - Adjustments to treasury fee percentages.
  - Changes to late fee structures and caps.
  - Modifications to LTV thresholds for liquid collateral.
  - Grace period durations.
  - Allocations of treasury-controlled funds for development, security audits, liquidity programs, buybacks, and token-incentive policy.
  - Upgrades to smart contracts (see Security and Upgradability).
- **Process:** Vaipakam will use OpenZeppelin's Governor module or a similar battle-tested framework.
  - **Proposal Submission:** Requires a minimum VPFI holding.
  - **Voting Period:** A defined period during which VPFI holders can cast their votes.
  - **Quorum:** A minimum percentage of the total VPFI token supply (or staked VPFI) must participate in a vote for it to be valid (e.g., 20%).
  - **Majority Threshold:** A minimum percentage of votes cast must be in favor for a proposal to pass (e.g., 51%).
- **Implementation:** Passed proposals are implemented automatically by the governance contract interacting with other platform contracts, or by a multi-sig controlled by the DAO executing the changes.

### Treasury and Revenue Sharing

- **Treasury Collection:** Treasury continues to collect protocol fees according to the live protocol rules, including the `0.1%` `Loan Initiation Fee` on ERC-20 loans, the `Yield Fee` on accrued interest / rental-fee earnings, the `1%` late-fee intake, and any other explicitly documented treasury charges such as liquidation-handling or fallback treasury entitlements.
- **Lender Yield Fee Discount:** Lenders who maintain sufficient canonical VPFI stake are eligible for the tiered `Yield Fee` discount schedule defined by the tokenomics spec.
  - The lender discount applied at settlement is the current effective discount: Base resolves it from the canonical TWA tier accumulator, while mirror chains read the authenticated mirror cache.
  - Vault-held VPFI automatically counts as staked under the unified vault-based staking model.
  - The active tier schedule is:
    | Tier | Vaulted VPFI Balance | Discount | Lender Effective Yield Fee |
    | ------ | -------------------------- | -------: | -------------------------: |
    | Tier 1 | `>= 100` and `< 1,000` | `10%` | `0.9%` |
    | Tier 2 | `>= 1,000` and `< 5,000` | `15%` | `0.85%` |
    | Tier 3 | `>= 5,000` and `<= 20,000` | `20%` | `0.8%` |
    | Tier 4 | `> 20,000` | `24%` | `0.76%` |

  - The lender must explicitly opt in through a single platform-level user setting that consents to using vaulted VPFI for protocol fee discounts.
  - In the frontend, this common fee-discount consent should be managed from the app-level user area, surfaced on the `Dashboard`, rather than being anchored to an individual offer, loan, or VPFI-purchase step.
  - This consent should be a common user preference rather than an offer-level or loan-level toggle.
  - Only when that platform-level consent is active and sufficient VPFI is available in vault should the system automatically deduct the discounted fee amount in VPFI from vault and transfer it to treasury.

- **Borrower Loan Initiation Fee Discount:** Borrowers who maintain sufficient canonical VPFI stake for tier eligibility and sufficient protocol-tracked VPFI on the settlement chain to pay the full up-front fee are eligible for the tiered borrower-side `Loan Initiation Fee` discount schedule defined by the tokenomics spec.
  - Vault-held VPFI also counts as staked under the unified vault-based staking model.
  - The active tier schedule is:
    | Tier | Vaulted VPFI Balance | Discount | Borrower Effective Initiation Fee |
    | ------ | -------------------------- | -------: | --------------------------------: |
    | Tier 1 | `>= 100` and `< 1,000` | `10%` | `0.09%` |
    | Tier 2 | `>= 1,000` and `< 5,000` | `15%` | `0.085%` |
    | Tier 3 | `>= 5,000` and `<= 20,000` | `20%` | `0.08%` |
    | Tier 4 | `> 20,000` | `24%` | `0.076%` |

  - The borrower must explicitly opt in through that same single platform-level user setting consenting to the use of vaulted VPFI for protocol fee discounts.
  - Offer-level or loan-level consent is not required for the borrower discount once the platform-level setting has been enabled.
  - Only when that platform-level consent is active, the lending asset is liquid, the effective tier is available from Base or the active mirror cache, and sufficient spendable protocol-tracked VPFI is available on the settlement chain should the system deduct the full `0.1%` fee equivalent in VPFI from the borrower's local vault.
  - The deducted VPFI is held in protocol custody for the life of the loan rather than sent immediately to Treasury.
  - On proper close through normal repayment, borrower preclose, or refinance, the borrower earns an effective-tier rebate based on the current Base tier or active mirror cache at settlement. The rebate is paid in VPFI alongside the ordinary borrower claim.
  - On default or HF-based liquidation, the rebate is forfeited and the full held VPFI becomes Treasury's share.
  - The borrower-side acquisition and rebate flow is defined in `docs/TokenomicsTechSpec.md`.

- **Borrower VPFI Acquisition Flow:** For the borrower-side discount path:
  - public `/buy-vpfi` should be a no-wallet marketing / education surface for VPFI, explaining the protocol token, tiered fee discount, staking yield, and how the app flow works
  - wallet-bearing buy, deposit / stake, withdraw / unstake, and staking-reward claim controls should live inside the connected app at `/app/buy-vpfi`
  - public CTAs should route users into `/app/buy-vpfi` when they choose to transact, while the public site itself remains informational and wallet-free
  - the user should not be required to manually switch to the canonical chain before buying
  - purchased VPFI should be delivered to the borrower's wallet on that same preferred chain, not auto-deposited into vault
  - if canonical-chain or bridge infrastructure is used under the hood, that complexity should be abstracted from the user-facing purchase flow
  - if the purchase path settles through a Base-chain receiver, VPFI must be minted or released only after that receiver actually receives ETH, and the amount delivered must be based on actual received ETH rather than a quoted amount
  - moving VPFI from wallet to user vault should remain an explicit user-initiated action, with the connected app facilitating that step after purchase
  - that vault action should be presented as `Deposit / Stake VPFI`, because vault-held VPFI earns the staking APR as well as feeding the canonical fee-discount tier model
  - staking is open to any VPFI holder; an existing loan is not required, and the user's vault can be created on first deposit
  - the Phase 1 `30,000 VPFI` wallet cap is a per-chain buy cap, not one shared global wallet cap across every chain
  - fee-discount eligibility is based on canonical Base staking state and mirror-cache propagation, not on independent local discount tiers per lending chain
  - the shared platform-level consent for using vaulted VPFI toward `Yield Fee` and `Loan Initiation Fee` discounts should be shown in the app on `Dashboard`, so users can manage the setting independently of the `Buy VPFI` flow
- **Vault-Based Staking:** VPFI held in the user's canonical Vaipakam Vault should be treated as staked for tokenomics purposes and should accrue the vault-based `5% APR` staking rewards defined in the tokenomics spec. That canonical stake is also the source for Base-resolved fee-discount tiers that can apply on mirrors after propagation.
- **Reward Claim Surfaces:** Staking rewards should be claimed from the `Buy VPFI` staking card, platform-interaction rewards should be claimed from `Claim Center`, and `Dashboard` may summarize both streams without becoming the canonical claim route for either one.
- **VPFI Received From Protocol-Fee Flows:** VPFI received through protocol-fee utility paths should be handled as:
  - `38%` converted into ETH through the configured on-chain swap-aggregator proxy
  - `38%` converted into wBTC through the approved treasury recycling path
  - `24%` retained as VPFI
- **Surplus Rule:** If the Insurance / Bug Bounty pool grows above `2%` of total VPFI supply, the excess VPFI should be recycled using the same `38 / 38 / 24` Treasury Recycling Rule. This is a treasury-strengthening conversion, not a token burn.
- **Revenue Distribution:** Treasury-controlled tokenomics flows should support pull-based staking and reward claims rather than automatic periodic token pushes once the broader tokenomics system is live.
- **Treasury Dashboard:** A public dashboard (e.g., built with Dune Analytics or similar tools, integrated into the Vaipakam frontend) will display real-time treasury data:
  - Total income from fees.
  - Treasury balance and historical fee data.
  - Reward-pool balances, claimable amounts, and active emission state for VPFI tokenomics.
  - Buyback-routing / treasury-strengthening flows where applicable.
  - Historical fee data and distribution amounts.
  - This ensures full transparency regarding platform finances.

### VPFI Token Distribution

The VPFI governance token will be distributed to align incentives and encourage platform participation.

- **Proposed Allocation:**
  - Founders: `6%` (`13,800,000`)
  - Developers & Team: `12%` (`27,600,000`)
  - Testers & Early Contributors: `6%` (`13,800,000`)
  - Platform Admins/Operational Roles (e.g., initial multi-sig holders): `3%` (`6,900,000`)
  - Security Auditors: 2%
  - Regulatory Compliance Pool: 1%
  - Bug Bounty Programs: 2%
  - Exchange Listings & Market Making: `12%` (`27,600,000`)
  - Ecosystem / Community / Marketing: `2%` (`4,600,000`) for launch-window ecosystem and marketing activity, held by an operations / governance multisig rather than the founder
  - **Early Fixed-Rate Purchase Program:** `1%` (`2,300,000`) sold at `1 VPFI = 0.001 ETH` under the capped purchase model
  - **Platform Interaction Rewards:** `30%` (`69,000,000`)
    - front-loaded emission schedule with annualized stages of `32%`, `29%`, `24%`, `20%`, `15%`, `10%`, then `5%` terminal rate
    - `50%` of each daily interaction pool goes to lenders, proportional to daily interest earned
    - `50%` goes to borrowers, proportional to daily interest paid
    - borrower-side interaction rewards are earned only on clean full repayment
    - the daily denominator is **protocol-wide global daily interest**, not local-chain-only interest
    - non-canonical chain deployments report their finalized daily interest totals to canonical `Base` through the approved cross-chain messenger
    - canonical `Base` aggregates those reports into one `dailyGlobalInterestNumeraire` value and broadcasts the finalized denominator back to every supported chain
    - users still claim locally on their active lending chain; cross-chain messaging is used only to synchronize the global denominator and related reward funding, not to make the loan lifecycle cross-chain
    - once the `69,000,000` VPFI interaction-reward pool is exhausted, this category stops emitting
  - **Staking Rewards:** `24%` (`55,200,000`)
    - distributed through vault-based staking reward accounting using a pull model; no separate staking contract is required
    - aligned to the same `5%` terminal inflation profile used in the later interaction-reward schedule
- **Distribution Mechanism:** Rewards follow a pull model through explicit claim functions such as `claimInteractionRewards()` and `claimStakingRewards()`. Initial minted and reserved allocations should be held through secure multi-sig, timelock, and vesting-wallet structures where appropriate.
- **Representative Vesting / Release Rules:**
  - founders: `12`-month cliff plus `36`-month linear vesting
  - developers & team: same as founders
  - testers & early contributors: `6`-month cliff
  - operational/admin allocations: timelock-controlled release
  - auditors / compliance pool: one-time allocations when applicable
  - exchange / market-making bucket: `50%` immediate liquidity allocation and `50%` locked market-making allocation

### VPFI Multi-Chain Deployment

- **Token Standard:** Chainlink Cross-Chain Token using CCIP.
- **Purpose:** Maintain one global VPFI supply cap across all supported chains rather than independent per-chain supply silos.
- **Primary Canonical Deployment Chain:** `Base`
- **Additional Phase 1 Rollout Chains:** `Arbitrum`, `Polygon`, `Optimism`, and `Ethereum mainnet`.
- **Deployment Flow:**
  1. Deploy the canonical VPFI token on `Base`.
  2. Mint the initial `23,000,000` VPFI to the secure multi-sig and timelock-controlled treasury setup.
  3. Deploy connected mirror-token, token-pool, adapter, and messenger contracts on the additional supported chains.
  4. Configure CCIP lanes, remote messengers, channel peers, token pools, and rate limits so cross-chain transfers preserve a single global supply model.
  5. Keep token symbol and metadata consistent as `VPFI` across supported chains.
- **Architecture Clarification:** `VPFI` is cross-chain, and the interaction-reward denominator / reward-funding path also uses cross-chain messaging so each chain can claim against one protocol-wide daily interest total. The Vaipakam lending / borrowing / rental core protocol itself still remains single-chain per deployment, with a separate Diamond deployment on each supported network. Loans, offers, collateral, repayment, liquidation, preclose, refinance, and keeper actions always remain local to the network of that specific Diamond instance.
- **Canonical Address Rule:** The Base deployment is the documented source of truth and should be published in `docs/` and surfaced through Vaipakam transparency / dashboard tooling.
- **Cross-Chain Messenger Boundary:** Domain contracts should depend on a provider-neutral messenger abstraction. Provider-specific CCIP behavior should stay inside the approved messenger adapter so future provider changes remain localized.
- **CCIP Lane Hardening:** Messenger configuration should allow only approved source chains, remote messengers, channel peers, and token pools. Chain-selector and channel-handler mappings must remain one-to-one, and conflicting operator assignments must be rejected rather than overwritten.
- **Default Cross-Chain Settings:** Buy-adapter deployment scripts should configure sane default CCIP lane, fee, and execution settings inline at deploy time so a freshly deployed adapter can quote and execute buys before any optional post-deploy tuning.
- **BuyAdapter Rate-Limit Verification:** Mirror-chain `VPFIBuyAdapter` contracts should expose `getRateLimits()` as a symmetric public read for the configured per-request and rolling daily caps. Testnet and mainnet deploy health checks must fail readiness if a live mirror adapter remains at the unlimited default caps after the rate-limit ceremony.
- **Buy-Flow Settlement:** Cross-chain fixed-rate buys should return purchased VPFI through the approved source-chain buy adapter, not directly to an arbitrary buyer wallet. The adapter must cross-check the delivery against local pending buy state before forwarding VPFI to the recorded buyer; forged or replayed arrivals should be marked as stuck VPFI and recoverable only through owner / governance controls.
- **Buy Fee Refunds:** If a buyer overpays the quoted cross-chain execution fee, the buy path should forward only the required fee and refund the surplus to the buyer.
- **Buy Reconciliation Watchdog:** The private ops watcher should cross-check canonical-chain processed buy events against matching source-chain buy requests by request id, buyer, amount, and EVM chain id. The receiver should expose an owner-controlled reconciliation-watchdog enable flag for planned ceremonies; mismatch detection should alert operators, while automatic pausing remains a later operational policy choice.
- **Private CCIP Watcher:** Cross-chain VPFI operations should have an internal Cloudflare Worker or equivalent monitor that checks CCIP lane configuration, token-pool configuration, rate-limit drift, cross-chain supply balance, and oversized VPFI transfers. This monitor is private ops infrastructure and should remain separate from the public HF watcher / liquidation keeper reference.

## 11. Notifications and Alerts

Effective communication is key for user experience and risk management. Vaipakam supports event-driven notification surfaces and Health-Factor alerts for liquid loans.

### Implementation

- **Mechanism:** An off-chain service will monitor key smart contract events. When a relevant event occurs, this service will trigger SMS/Email notifications to the concerned users.
- **Providers:** The platform will use established third-party APIs for sending SMS (e.g., Twilio) and Emails (e.g., SendGrid).
- **User Registration:** Users will need to provide and verify their phone number and/or email address in their Vaipakam profile to receive notifications. Opt-in/opt-out preferences for non-critical notifications can be managed.
- **Health-Factor Alert Subscriptions:** Borrowers can subscribe to per-loan HF threshold alerts, such as `HF below 1.20`, for liquid loans they own. The watcher reprices subscribed loans on a timed sweep and sends an alert only when the configured threshold is newly crossed.
- **HF Alert Channels:** Telegram alerts are delivered through the official Vaipakam bot linked to the wallet. Push Protocol is supported as a decentralized opt-in channel; the send path may remain staged until the production Push channel is registered.
- **Paid Push Event Notifications:** Beyond compulsory HF-threshold alerts, users may opt into paid Push notifications for loan lifecycle events. Supported event categories should include claim available, loan settled / defaulted, cross-chain VPFI buy received, offer matched into a loan, loan maturity approaching, and partial repayment received. New subscribers should default these event toggles on while allowing individual opt-out.
- **Notification Fee Model:** Telegram alerts remain free. Push delivery may charge a flat numeraire-denominated fee, governance-tunable through protocol config, deducted in VPFI from the relevant user's vault on the first paid Push notification per loan side. Billing must be idempotent per `(loanId, side)`, should transfer directly from user vault to treasury, and should not introduce a Diamond custody window because notification fees have no rebate or terminal split. The notification-fee conversion should use the active `ETH/<numeraire>` oracle-layer price and the fixed Phase 1 VPFI-per-ETH rate; it must not carry a separate per-fee oracle slot.
- **Notification Billing Role:** The off-chain notification worker should call a narrowly scoped on-chain billing entry point using a dedicated notification-biller role rather than reusing watcher / pause authority. This keeps false-billing risk separate from auto-pause risk and allows either role to be rotated independently.
- **Autonomous Liquidation Watcher:** Operators may enable a keeper mode on the same watcher so it submits permissionless `triggerLiquidation` transactions when subscribed loans cross HF `1.0`. This mode is disabled by default and requires explicit worker secrets plus a funded keeper EOA per target chain.
- **Public Keeper-Bot Reference:** Vaipakam should maintain a standalone keeper-bot reference implementation for third-party operators. The bot should be able to page through active loans, read Health Factor, quote 0x / 1inch / UniV3 / Balancer routes, rank them, and submit permissionless liquidations from the operator's own EOA.
- **CCIP Ops Watcher:** Cross-chain VPFI and reward plumbing should also have a private ops watcher, separate from the public HF watcher / keeper, that checks lane configuration drift, token-pool configuration drift, cross-chain supply imbalance, rate-limit changes, and oversized single-transaction VPFI flows. Alerts should go to private operator channels rather than public user channels.
- **Funding:** The cost of sending these SMS/Email notifications will be covered by the Vaipakam platform, funded from its treasury.
- **Criticality:** Notifications will be primarily for critical events to avoid alert fatigue.
- **Style:** Notifications should remain concise, actionable, and focused on essential events.
- **Types of Notifications (Examples):**
  - **Loan Initiation:** Offer accepted, loan now active.
  - **Repayment Reminders:** Sent a few days before the loan due date and at the start of the grace period. (Paid by platform)
  - **LTV Warnings (for Liquid Collateral):** Alerts when LTV approaches critical levels (e.g., 80%, 85%). (Paid by platform)
  - **Successful Repayment:** Confirmation that a loan has been repaid.
  - **Funds/Collateral Claimable:** Notification when repayment is made and funds/collateral are ready for the counterparty to claim.
  - **Liquidation/Default Events:** Notification of loan default or initiation of liquidation.
  - **Offer Matched/Expired/Cancelled.**
  - **Cross-chain VPFI Buy Received:** Confirmation when a cross-chain buy is received and fulfilled.
  - **Partial Repayment Received:** Lender-side reconciliation notice when a borrower partially repays.
  - **Governance Alerts (Phase 2):** New proposals, voting period starting/ending after governance is launched.

## 12. User Dashboard

A comprehensive user dashboard is essential for managing activities on Vaipakam.

### Features

- **Overview:** Summary of active loans (as lender and borrower), open offers, total value locked/borrowed.
- **Loan Management:** Detailed view of each loan:
  - Principal, interest rate/rental fee, duration, due dates.
  - Collateral details (type, amount, current value if liquid, LTV if applicable).
  - Repayment schedule and history.
  - Options to repay, preclose, or manage collateral (if applicable).
- **Offer Management:** View and manage created offers (active, matched, cancelled, expired).
- **NFT Portfolio:** Display of Vaipakam-minted NFTs (Vaipakam NFTs) held by the user, along with their status and associated loan/offer details.
- **Claim Center:** Clear interface to claim pending funds (repayments, rental fees) or collateral.
- **Claim Center Rewards:** Platform-interaction rewards should live in Claim Center rather than a standalone Rewards page. The card should show pending VPFI, lifetime claimed VPFI reconstructed from `InteractionRewardsClaimed` events, and an expandable contributing-loans list with links back to Loan Details.
- **Offer-Grouped Loan View:** When one parent offer creates multiple child loans through range matching or partial fills, Dashboard should show an offer-grouped summary above the flat loan table. Each group should link back to the parent offer, show total filled principal in the native principal asset, weighted-average rate by filled amount, minimum Health Factor across active children, collateral bucketed by asset, child-status counts, and an expandable child-loan list. Single-child offers should remain only in the ordinary flat loan table to avoid duplicate rows.
- **Internal-Match Claim Support:** Claim Center and Loan Details must treat internally matched loans as terminal and claim-eligible. Borrowers should see any residual collateral from a partial internal match, and lenders should see their settled claim lane with a timeline explanation that the loan resolved by protocol-internal matching.
- **Fallback-Pending Rescue Support:** Claim Center and Loan Details should explain when a fallback-pending lender claim can still attempt a fresh safe liquidation route or protocol-internal match before the lender receives in-kind collateral. If a full rescue succeeds, the claim lane should move to the internally matched or successful liquidation outcome. If a partial rescue succeeds, the screen should show the reduced fallback residual rather than the original snapshot.
- **Transaction History:** Record of all platform interactions.
- **Activity Page:** A dedicated Activity page should be available inside the app so users can review recent platform interactions, lifecycle events, and account activity in one place. Loan references should render as clickable `Loan #X` pills that deep-link to the matching Loan Details page.
- **Identity Labels:** Where wallet addresses appear in the dashboard, Activity, loan details, offer book, or profile chip, the frontend should resolve and display ENS / Basenames handles when available, while falling back silently to shortened addresses.
- **Liquidation Price View:** For liquid active loans, Loan Details should show the collateral-asset price at which HF reaches `1.0`, both as an absolute price and a percentage move from current price. This view should stay hidden for illiquid loans where no oracle-based liquidation price exists.
- **Near Internal-Match Warning:** Borrower-side dashboard and Loan Details rows should show a clear warning when the current LTV is close to, but still below, the loan's snapshotted internal-match liquidation threshold. The warning should be informational only until the threshold is actually crossed, and it should explain that the borrower can repay or add collateral to avoid entering the internal-match race window.
- **Approval Management:** Profile should include an Approvals surface listing ERC-20, ERC-721, and ERC-1155 allowances granted to the Vaipakam Diamond, grouped by principal-eligible, collateral-eligible, and prepay-eligible assets, with one-click revoke actions.
- **VPFI Token Management:** In Phase 1, this is split across public education and connected app execution: public `/buy-vpfi` explains VPFI and links into the app, while `/app/buy-vpfi` hosts wallet-to-vault funding guidance, staking / unstaking, staking-rewards claim surfaces, borrower discount eligibility views where exposed, and chain-level token transparency. The shared fee-discount consent control remains surfaced in `Dashboard`.
- **Dashboard Table Polish:** The user's loan table should show both principal and collateral columns using the same asset / NFT renderer, so users can review collateral without opening every loan detail page.
- **Claim Center Navigation:** Claim Center rows should deep-link each `Loan #N` label to the matching Loan Details page so users can review full timeline and risk context before claiming.
- **Copyable Address UX:** Redacted addresses on loan parties, offer creator rows, keeper lists, timeline participant rows, and analytics asset-distribution rows should expose a copy affordance for the full address without crowding explorer-link surfaces.
- **Your Loans Table:** The dashboard should keep the user's loan history scannable with Role and Status filters, a per-page selector, sortable columns, and a default most-recent-first sort by loan ID. LTV and Health Factor sorting should use batched reads over the filtered result set and keep illiquid or unavailable values from appearing as misleading best results.
- **Claimable-Loan CTA:** Terminal-state loans with unclaimed funds should show a visible `Claim` action that opens Loan Details, where the claim action bar can present the exact lender / borrower payout.
- **Loan Details Timeline:** Each Loan Details page should include a chronological event timeline sourced from the frontend log index, with per-event breakdowns for initiation, repayment, settlement, fallback collateral splits, swap retries, collateral additions, VPFI rebates, and final claims.
- **Staking Rewards Surface:** Staking rewards should be claimed from the `Buy VPFI` Step 2 stake card, with a compact Dashboard mirror. The former combined in-app Rewards route is retired unless a later design explicitly restores it.
- **Notification Settings:** Manage preferences for SMS/Email alerts.
- **Analytics:** Basic analytics on lending/borrowing performance.
- **Data Refresh:** The dashboard will update periodically (e.g., every minute or on user action) to reflect on-chain changes.

## 13. Technical Details

### Blockchain and Networks (Phase 1)

- **Supported Networks:** The target Phase 1 production deployment set is Ethereum mainnet, Base, Polygon, Arbitrum, and Optimism. Production-network Diamonds have not yet been deployed.
- **Current Testnets:** The active testnet mesh should be defined by the deployment artifacts exported through the explicit active-chain allow-list, with Base Sepolia acting as the canonical testnet where applicable and mirror testnets such as Sepolia, Arb Sepolia, or OP Sepolia joining only when their deployment folders, RPC secrets, and peer wiring are current. A chain may be temporarily retired from the exported bundle while its artifacts remain on disk for forensics. Fresh testnet redeploys should be preferred over in-place upgrades when unreleased changes include storage struct shape changes and no testnet state needs preserving.
- **Intra-Network Operations:** All aspects of a single loan (offer, acceptance, collateral, repayment) occur on the _same chosen network_.
- **Deployment Model:** Vaipakam uses separate Diamond deployments on each supported network — each chain hosts its own independent protocol instance. There is no cross-chain loan lifecycle.
- **Deployment Tooling:** Deployment scripts and runbooks should remain chain-parameterized so the same controlled process can deploy, wire, verify, and post-check Base, Polygon, Arbitrum, Optimism, Ethereum mainnet, and their testnet equivalents without one-off per-chain drift. The supported operator entrypoints are the legacy all-in-one rehearsal script (`contracts/script/deploy-chain.sh`), the phase-mirrored testnet ceremony (`contracts/script/deploy-testnet.sh`), and the mainnet ceremony (`contracts/script/deploy-mainnet.sh`). Scripts that require post-handover powers should read `ADMIN_PRIVATE_KEY` or the documented role-specific key and pre-flight the broadcaster's owner / `ADMIN_ROLE` status before broadcasting.
- **Private-Key Environment Naming:** Deployment and script environments should avoid a bare `PRIVATE_KEY` variable. Use role-explicit names such as `DEPLOYER_PRIVATE_KEY`, `ADMIN_PRIVATE_KEY`, `KEEPER_PRIVATE_KEY`, `VPFI_OWNER_PRIVATE_KEY`, and `REWARD_OWNER_PRIVATE_KEY`, preserving role-prefixed sibling names verbatim. `DEPLOYER_PRIVATE_KEY` is the default deployer / owner-key slot paired with `DEPLOYER_ADDRESS`.
- **Deployment Artifact Sync:** Per-chain `contracts/deployments/<chain>/addresses.json` files are the source of truth for deployed contract addresses. After a redeploy, operators should run the export phases that merge those artifacts into committed typed deployment JSON for the connected app, marketing app, keeper, indexer, and agent surfaces under `apps/{defi,www,keeper,indexer,agent}`. Frontend `.env.local` and Worker secrets should keep only operator-specific values such as RPC URLs, WalletConnect IDs, feature flags, tuning knobs, and API credentials; deployed Diamond / facet / adapter addresses should not be hand-copied into local env files or Worker vars.
- **Canonical Deployment Artifacts:** Operator runbooks and scripts should read deployed Diamond, messenger, token-pool, and adapter addresses from `contracts/deployments/<chain>/addresses.json` or exported package artifacts, not from ad hoc `.env` Diamond variables. Environment files may carry convenience variables for manual calls, but stale env addresses must not override deployment artifacts or mislead authority checks.
- **CCIP Deploy and Wire Flow:** Cross-chain deployment should be split into a per-chain deploy pass and a deliberate topology-wiring pass. The deploy pass creates the local messenger, token pool, rate-limit governor, reward messenger, and the canonical or mirror buy components according to the chain's own EVM chain id. The wiring pass should run only after all participating chains have deployment artifacts, then configure chain selectors, remote messengers, buy and reward channels, token-pool rate limits, and Cross-Chain Token registration from those artifacts.
- **CCIP Verification:** Deploy verification should confirm that each token pool is controlled by the configured rate-limit governor, that every lane / pool / channel points at the intended peer, and that buy, reward, and token-transfer paths have the configured rate limits and authorities before the chain is considered cross-chain ready.
- **Diamond Deployability Guardrails:** A deployment is not ready unless every Diamond facet is within the EVM runtime-size limit, every externally reachable function is routed by the Diamond, and no function selector is routed to the wrong facet. These checks should run during the normal contract test cycle and again as part of pre-deploy readiness, so an undeployable or partially routed Diamond is caught before any testnet or mainnet broadcast.
- **Facet Count Verification:** Deployment artifacts should record the facet count applied by the Diamond deployment itself. Post-deploy verification must compare the live Diamond facet count to that recorded value exactly, failing on either missing or unexpected facets rather than using a stale minimum threshold.
- **Selector Ownership Verification:** After the Diamond is cut, every selector in the deployed routing table should resolve back to the facet that owns it. A mismatch must fail the deploy before follow-on initialization or user-facing configuration can proceed.
- **ABI Completeness Gate:** Consumer-facing ABI exports must be complete as well as current. Pre-deploy checks should fail when a required frontend ABI is missing entirely, and should warn for any missing separately deployed keeper-bot ABI according to the keeper deployment policy.
- **Broadcast Preflight Gate:** Every phase that can broadcast on-chain transactions must re-run the critical preflight checks at the top of the phase, not rely on a stale "preflight already ran" marker. At minimum, scripts should verify that the configured RPC serves the expected chain before each broadcast; mainnet broadcasts should also require the configured hardware-signer attestation each time.
- **Fresh Redeploy Guardrails:** If `addresses.json` already contains a Diamond for a chain, contract deployment phases should refuse by default. Testnet redeploys may proceed only with `--fresh`; mainnet redeploys require both `--fresh` and an explicit mainnet-purge confirmation flag. Before wiping live deployment state, scripts should archive prior `addresses.json`, `deployment_source.json`, `.markers/`, `.history/`, and rehearsal sidecars into a timestamped `.archive/` folder for forensics. Before archiving a prior Diamond, scripts must read active-offer and active-loan counts and refuse if either is non-zero unless the operator passes an explicit orphan-state confirmation flag. Mainnet bypass requires the fresh flag, the mainnet purge confirmation, and the orphan-state confirmation because off-chain artifact replacement cannot erase prior on-chain state. Fresh testnet deploy flows should purge the active chain's D1 rows even if the previous `addresses.json` was already archived, so stale rows from a prior Diamond cannot pollute the new rehearsal.
- **Handover Preflight:** The handover phase must verify bytecode exists at the configured Governance Safe, Pauser / Guardian Safe, and Timelock addresses before granting roles or renouncing the deployer. On mainnet, zero bytecode at any privileged recipient is a hard stop because granting admin power to an undeployed address can make recovery impossible after deployer renounce.
- **CCIP Handover:** Production handover must rotate the full CCIP stack to governance, including the messenger, VPFI token pool, rate-limit governor, reward messenger, mirror token where present, buy adapter or receiver, and the Cross-Chain Token administrator entry. The Timelock should own upgrade and lane-configuration authority after handover, while guardian pause remains available for fast incident response.
- **Cloudflare Surface Separation:** Public hosted infrastructure should keep read-only, read/index, write/act, and ingestion duties separated. The current split is `vaipakam.com` for the marketing / docs surface with no chain credentials, `defi.vaipakam.com` for the connected app surface, `agent.vaipakam.com` for read/index APIs and diagnostics endpoints, `keeper.vaipakam.com` for autonomous write actions with signing and aggregator credentials, and `indexer.vaipakam.com` for chain-to-archive ingestion with database write credentials. Shared archive storage such as the `vaipakam-archive` D1 database should be accessed with least-privilege credentials per Worker, and Worker bindings should grant only the read or write capability each surface needs. Deployment scripts should expose per-surface Cloudflare phases (`cf-defi`, `cf-www`, `cf-keeper`, `cf-indexer`, `cf-agent`) plus an all-Cloudflare skip alias for rehearsals that do not need hosted-app redeploys.
- **Worker Secret Management:** Shared Worker secrets should be stored in an account-level secret store and bound only into Workers that need them, so provider keys, per-chain RPC URLs, Telegram credentials, swap-aggregator keys, and push-channel signing keys can be rotated centrally. Workers should resolve their bound secrets once at request / scheduled-entry boundaries, fail with operator-visible configuration errors when required secrets are unavailable, and keep non-secret configuration as ordinary Worker config.
- **Marketing Domain Canonicalization:** `vaipakam.com` is the canonical marketing origin. `www.vaipakam.com` should redirect to the apex while preserving path and query string, and metadata / sitemap / hreflang helpers should emit apex-rooted URLs even if a legacy host is still bound during transition. The source package and Worker should use the `www` naming convention (`apps/www`, `@vaipakam/www`, `vaipakam-www`) for contributor clarity, while the public canonical hostname remains apex.
- **BNB Testnet Gas Policy:** BNB Smart Chain Testnet forge deployments should pass an explicit gas price (currently at least `5gwei`) and keep a nonce-replacement recovery path ready, because forge auto-detection has returned 1 wei gas in prior deploys and the network silently dropped those transactions.

### Smart Contracts

- **Language:** Solidity (latest stable version, e.g., 0.8.x, specify version like 0.8.29 if decided).
- **Core Contracts (Examples):**
  - `VaipakamOfferManagement.sol`: Handles creation, cancellation, and matching of lender/borrower offers.
  - `OfferMatchFacet` or equivalent matching facet: Hosts bot-facing Range Orders preview / match entrypoints when needed to keep the offer-management facet under the EIP-170 runtime bytecode ceiling. Range Orders pushed ordinary offer management past the real-chain bytecode limit, so matching and ordinary create / accept / cancel logic should remain split where necessary for deployability.
  - `VaipakamLoanManagement.sol`: Manages active loans, repayments, defaults, and liquidations.
  - `VaipakamVault.sol`: Holds collateral, ERC-721/1155 rental NFTs, and funds during various stages.
  - `VaipakamNFT.sol`: The ERC-721 contract responsible for minting and managing Vaipakam NFTs.
  - `VaipakamGovernance.sol` (Phase 2): Manages proposals and voting.
  - `VaipakamTreasury.sol`: Collects and manages platform fees.
  - `StakingRewardsFacet` / VPFI tokenomics facets (Phase 1): Manage vault-based VPFI staking rewards and reward claims without a separate staking contract.
  - `ConfigFacet`: Exposes mutable governance configuration and compile-time protocol constants that the frontend uses for live copy, tier tables, thresholds, and tooltips.
  - `OracleAdminFacet`: Exposes oracle-admin setters and getters, including Pyth cross-check, secondary-oracle, PAD, and direct-feed override configuration used by protocol-console tooling.
  - `RewardReporterFacet`: Exposes cross-chain reward reporting and grace-window configuration used by tokenomics accounting and protocol-console tooling.
  - `ClaimFacet`: Exposes claimable positions and fallback-settlement snapshots used by Loan Details, Claim Center, and claim readiness surfaces.
- **Libraries:**
  - OpenZeppelin Contracts: For robust implementations of ERC-20, ERC-721, ERC-1155 (if Vaipakam mints its own utility NFTs beyond offer/loan representations), AccessControl, ReentrancyGuard, and potentially Governor.
- **Security Considerations:**
  - **Audits:** Smart contracts will undergo thorough security audits by reputable third-party firms before mainnet deployment on each network.
  - **Dependency Hygiene:** Off-chain application and CI dependencies should be monitored through automated dependency-update checks, with updates grouped to reduce review noise and never auto-merged. CI workflow actions should be pinned to immutable commit SHAs while still carrying enough version metadata for update tooling. Solidity dependencies that affect audited bytecode should remain manually bumped and re-audited rather than automatically updated.
  - **Upgradeable Proxies:** Utilize UUPS (Universal Upgradeable Proxy Standard) proxies for core contracts to allow for future upgrades and bug fixes without disrupting ongoing operations or requiring data migration. Governance-controlled upgrades are planned for Phase 2, while Phase 1 upgrades remain available through the initial admin/multi-sig model described in the security policy.
  - **Born-Paused Deploy Safety:** Fresh Diamond deployments should be initialized in a paused state so no user-facing `whenNotPaused` entry point can execute while a split multi-cut deployment is still only partially wired. Deployment automation should explicitly unpause only after every facet cut, initializer, post-cut selector / facet-count assertion, and verify phase required for that environment has succeeded. Mainnet operators may intentionally leave the protocol paused after deploy for multi-party review and unpause through the documented Safe / Timelock ceremony.
  - **Diamond Size Discipline:** Large functional surfaces may be split across multiple facets when needed to keep each deployed facet within the EVM runtime-size limit. Such splits should preserve user-facing behavior, events, errors, and external integration expectations while changing only where the behavior is hosted inside the Diamond.
  - **Selector Coverage Discipline:** A function that exists on a facet is not considered live until the Diamond routes to it. Deployment guardrails should compare the compiled facet surface to the deployed Diamond routing table and fail when any public function is missing, duplicated through a selector collision, or owned by the wrong facet.
  - **Vault Upgrade Policy:** User vaults must not continue to be usable on outdated mandatory versions. If an vault implementation upgrade is classified as required, user interactions through an older vault version must be blocked by the protocol until that vault is upgraded. Vault upgrades are not intended to be pushed automatically to every existing user vault because that would create significant network-fee overhead. Instead, the frontend must detect outdated vaults and require the user to submit their own vault-upgrade transaction before any further protected interaction is allowed. For non-critical upgrades, the frontend may still prompt users to upgrade, but blocking behavior should only be enforced when the upgrade is marked mandatory.
  - **Protocol-Tracked Vault Balances:** For every user/token pair, `protocolTrackedVaultBalance[user][token]` is the protocol-managed balance mirror. All production ERC-20 deposit paths must flow through `VaultFactoryFacet.vaultDepositERC20`, `vaultDepositERC20From`, or `recordVaultDepositERC20`, and normal withdrawals / protocol fee deductions must decrement that tracked balance alongside the token movement. Direct unsolicited transfers into a user vault can increase raw token `balanceOf` but must not increase the protocol-tracked counter.
  - **Tracked-Balance Display and Utility Rule:** User-facing Asset Viewer and balance surfaces should display `min(IERC20.balanceOf(userVault, token), protocolTrackedVaultBalance[user][token])` for protocol-managed ERC-20 assets so unsolicited dust is hidden. Staking rewards, VPFI discount tiers, and other protocol utility decisions must also use the tracked clamp rather than trusting raw vault balance alone.
  - **Stuck ERC-20 Recovery:** `recoverStuckERC20(token, declaredSource, amount, deadline, signature)` may recover only `max(0, balanceOf(userVault, token) - protocolTrackedVaultBalance[user][token])` and sends recovered tokens only to the user's own EOA. The flow requires an EIP-712 acknowledgement, nonce, deadline, and canonical warning hash. `disown(token)` is an event-only declaration and must not mutate balances or protocol accounting.
  - **Sanctions-Aware Stuck-Token Recovery:** Stuck-token recovery checks the user-declared source address through the configured sanctions oracle. Clean source checks allow recovery, flagged source checks leave tokens in the vault, record the banned source marker, and emit the ban event while returning successfully; oracle unset / unavailable / reverting states fail safe by reverting. A recorded banned source should unlock automatically when the source is no longer flagged by the current oracle.
  - **Direct Transfer Custody Policy:** Principal, repayment, refinance, preclose, and lender-sale settlement flows should avoid transient `wallet -> Diamond -> vault` or `vault -> Diamond -> vault` hops when the same result can be achieved with a direct `transferFrom` or vault withdrawal to the final recipient. The Diamond should hold user assets only for intentionally staged protocol custody such as borrower VPFI LIF custody and liquidation swap output routing; ordinary repayment / settlement assets should move directly to the counterparty vault or treasury with accounting updated alongside the direct transfer.
  - **Swap Adapter Allowance Boundary:** Keeper-driven swap adapters must distinguish the ERC-20 allowance target from the swap-call destination. The allowance target should be immutable per adapter deployment, while the callable swap destinations should be owner-managed allowlist entries. The adapter should approve only the immutable allowance target, reject unallowlisted destinations, and refuse to remove the final destination entry so operators cannot accidentally brick a live adapter. This supports 0x's AllowanceHolder / Settler split while still constraining 1inch-style routes where the same upstream address may currently serve both roles.
  - **External Dependency Modularity:** Safety-critical external dependencies should remain swappable at the lowest practical layer. Oracle providers, sanctions providers, swap aggregators, and off-chain risk-data sources should be configurable or isolated behind narrow provider modules where possible. Deep-integrated dependencies such as the chosen cross-chain messaging stack and hosting platform should have explicit resilience or migration plans rather than being treated as ordinary configuration.
  - **Testnet Swap Venue Policy:** Mainnet swap adapters must use canonical upstream venues and allowance targets. Testnets that lack a canonical 0x AllowanceHolder or real DEX liquidity may deploy chain-guarded mock 0x plumbing for configuration and interface rehearsal, but keeper liquidation swap adapters should remain parked behind the governance / Timelock ceremony until a meaningful venue and liquidity path exists.
  - **Swap Adapter Cutover Authority:** Production swap-adapter registration is a Timelock-governed action after handover. `DeploySwapAdapters` may deploy adapter contracts, but `AdminFacet.addSwapAdapter` must be scheduled and executed through the Governance Safe / Timelock path once `ADMIN_ROLE` and Diamond ownership are Timelock-held. Testnet rehearsals may park this phase when canonical allowance targets or real aggregator liquidity are unavailable; mainnet cutover should run the deployment and governance batches with current upstream addresses.
  - **Reentrancy Guards:** Applied to all functions involving external calls or asset transfers.
  - **Access Control:** Granular roles (e.g., `LOAN_MANAGER_ROLE`, `OFFER_MANAGER_ROLE`, `TREASURY_ADMIN_ROLE`) managed via OpenZeppelin's AccessControl. Roles will be assigned initially by the contract deployer/owner, with plans to transition control to governance in Phase 2 where appropriate.
  - **Asymmetric Pause / Unpause Roles:** `PAUSER_ROLE` is the fast incident lever for global and per-asset pause actions. Unpause authority must be separated into `UNPAUSER_ROLE`, held behind the Timelock after handover, so a compromised or mistaken fast-pauser cannot undo a freeze without the configured review delay. `autoPause()` / watcher-triggered pause paths remain write-only incident levers; recovery flows must route through the unpauser surface.
  - **Production Governance Handover:** Privileged production surfaces should be split by blast radius. Governance Safe holds `DEFAULT_ADMIN_ROLE` directly, Timelock holds delayed-action roles such as `ADMIN_ROLE`, `KYC_ADMIN_ROLE`, oracle / risk / vault admin roles, `UNPAUSER_ROLE`, and ERC-173 Diamond ownership, and the Pauser / Guardian Safe holds `PAUSER_ROLE` directly for fast incident response. The deployer/admin must renounce every privileged role after the grants and ownership transfers are confirmed.
  - **Atomic Admin Transfer:** `AccessControlFacet.transferAdmin(newAdmin)` should provide a single-transaction role and ERC-173 ownership handoff for the initial deployer/admin. It should grant all grantable roles to the new admin, transfer contract ownership, then revoke the caller's roles in reverse order so `DEFAULT_ADMIN_ROLE` is relinquished last. The function must be `DEFAULT_ADMIN_ROLE` gated and reject zero-address or self-transfer targets. Any later split of `PAUSER_ROLE`, `KYC_ADMIN_ROLE`, or other ops roles to dedicated Safes should happen after this atomic handoff through the normal governance / timelock role-management path.
  - **Bounded Governance Knobs:** Mutable numeric configuration surfaces must have explicit min / max ranges and use a shared typed range error. This includes reward grace windows, interaction caps, staking APR, liquidation and LTV risk parameters, reserve factor, KYC tier thresholds, oracle staleness, oracle deviation bounds, periodic-interest principal threshold, and periodic / maturity pre-notify lead time. Admin runbooks should list each knob, owner role, default, and permitted range.
    - `setRewardGraceSeconds`: 5 minutes to 30 days.
    - `setInteractionCapVpfiPerEth`: 1 to 1,000,000, while preserving documented sentinel values for reset / emergency-disable behavior.
    - `setStakingApr`: no more than 20% APR.
    - `updateRiskParams.maxLtvBps`: 10% to 100%.
    - `updateRiskParams.liqThresholdBps`: 15% to 100%, and still strictly greater than `maxLtvBps`.
    - `updateRiskParams.reserveFactorBps`: no more than 50%.
    - `updateKYCThresholds`: each threshold 100 to 1,000,000 in the active numeraire, with tier ordering still enforced.
    - `setMinPrincipalForFinerCadence`: active-numeraire principal threshold from 1,000 to 10,000,000, default 100,000.
    - `setPreNotifyDays`: 1 to 14 days, default 3 days.
    - `setNotificationFee`: active-numeraire fee floor / ceiling from the notification-fee policy constants.
  - **Periodic Interest Configuration:** `ConfigFacet` should expose `periodicInterestEnabled`, `numeraireSwapEnabled`, `numeraireSymbol`, `ethNumeraireFeed`, `minPrincipalForFinerCadence`, `notificationFee`, KYC tier thresholds, and `preNotifyDays` through individual getters and admin-gated setters where applicable. `periodicInterestEnabled` and `numeraireSwapEnabled` default to `false`, so the feature and cross-numeraire rotation ship dormant until governance intentionally enables them.
  - **Complete Diamond Selector Registration:** Deploy and facet-replacement scripts must register every external / public protocol-console selector exposed by `ConfigFacet`, `OracleAdminFacet`, and `RewardReporterFacet`; source-level getters or setters are not considered live until the Diamond selector arrays include them. Fresh deploy and replace scripts should be audited whenever a configuration facet gains a function so read-only admin cards do not fail with missing-selector fallbacks.
  - **Atomic Numeraire Setter:** `setNumeraire(ethNumeraireFeed, numeraireChainlinkDenominator, numeraireSymbol, pythCrossCheckFeedId, minPrincipalForFinerCadence, notificationFee, kycTier0Threshold, kycTier1Threshold)` is the only path to rotate the active numeraire. It must update every oracle-side input that produces numeraire-quoted prices and every numeraire-denominated stored value together so no intermediate state can compare a threshold or fee denominated in one numeraire against prices quoted in another. The load-bearing Chainlink feed, Feed Registry denominator, and symbol inputs must be non-zero / non-empty; `pythCrossCheckFeedId` may be zero to disable the Pyth cross-check. Zero values for value knobs should follow the protocol's reset-to-default convention, while each non-zero value remains subject to its own bounded validator.
  - **Within-Numeraire Tuning:** `setMinPrincipalForFinerCadence`, `setNotificationFee`, and `updateKYCThresholds` remain available for ordinary tuning within the current numeraire and should not require `numeraireSwapEnabled`. Cross-numeraire rotation through `setNumeraire` does require the kill switch to be enabled.
  - **PAD Configuration:** `OracleAdminFacet` or the relevant admin facet should expose `setPredominantDenominator`, `getPredominantDenominator`, `getPredominantDenominatorSymbol`, `getEthPadFeed`, `getPadNumeraireRateFeed`, and per-asset direct-feed override read/write helpers. PAD settings should be set atomically per chain and should be part of deployment pre-flight before the market opens.
  - **Atomic Configure Spell:** Post-deploy Diamond configuration should be available through a compositional `DiamondConfigSpell` that sequences oracle, reward-reporter, fixed-rate buy, and NFT-image-URI configuration in one deterministic operator action. Chain-specific branches must skip canonical-only configuration, such as VPFI buy receiver setup, on mirror chains while continuing the remaining configure steps. CCIP lane, pool, and messenger configuration remains a separate phase because it uses cross-chain-surface authority and targets messenger / token-pool contracts rather than Diamond admin setters.
  - **Post-Handover Configure Path:** The configure spell is the pre-handover bootstrap path. Once `ADMIN_ROLE` is held only by the Timelock, oracle, reward-reporter, VPFI-buy, NFT-URI, and swap-adapter configuration changes must be composed as Timelock `schedule` / `execute` batches through the Governance Safe rather than broadcast directly by an admin EOA.
  - **Admin-Configurable Default Grace Schedule:** `ConfigFacet` should expose the six-slot grace-bucket table, per-slot bounds, `setGraceBuckets`, and `clearGraceBuckets`. `setGraceBuckets` must reject wrong row counts, non-zero catch-all duration, non-monotonic duration rows, and values outside the per-slot or global bounds through typed range errors where applicable. Frontend admin tooling should show whether compile-time defaults are currently in force and compose Safe transactions rather than signing directly from the app.
  - **Cross-Chain Guardian Pause:** VPFI cross-chain messenger, token-pool, and bridge-related contracts should allow Guardian or Owner pause, but unpause must remain Owner / Timelock controlled.
  - **Cross-Chain Payload Sanity:** Reward and buy messages should validate expected payload shape before processing; malformed, undersized, oversized, duplicate-token, or wrong-chain messages must revert with clear typed telemetry so off-chain monitoring can correlate the incident with cross-chain traces.
  - **Emergency Updates:** Critical security patches may be fast-tracked through the initial admin/multi-sig model when needed to protect user funds or protocol integrity, with those emergency powers limited to critical fixes.
  - **Batch Processing:** Support for batch processing of certain operations where feasible to optimize gas costs, without weakening pull-based reward and claim semantics.

### Frontend

- **Framework:** React with wagmi v2 and viem for wallet connection, contract reads/writes, multicall batching, and direct JSON-RPC control.
- **Wallet UX:** ConnectKit is the wallet picker layer on top of wagmi v2. Mobile wallet selections should open wallet apps directly through deep links, while QR pairing remains available for cross-device use. Vaipakam should explicitly opt out of ConnectKit's a major DeFi protocol-account default so the connect modal does not show a competing-protocol `Continue with a major DeFi protocol` call to action unless the operator intentionally restores it.
- **Mobile Wallet Connect Flow:** Mobile wallet connectors should be tested by tapping from a phone browser, approving inside the wallet app, and returning to the dApp. MetaMask should stay available as a featured wallet while using a mobile-aware deep-link path; Coinbase Wallet may use the default SDK connector unless mainnet testing proves the approval screen is unreliable, in which case the WalletConnect deep-link fallback is acceptable. A touch-only connecting banner should distinguish "pick a wallet" from "approval in progress", survive app-switch suspension, and hide when the picker is dismissed before any deep-link.
- **PWA Support:** The frontend should ship a web app manifest and production-only service worker so the dApp can be installed on iOS / Android through browser home-screen install flows. The service worker may cache only the static app shell; navigational HTML should be network-first so new deployments replace stale PWA-controlled bundles promptly. Dynamic RPC, subgraph, worker API responses, and transaction-preview responses must bypass service-worker caching so chain state is never served stale.
- **Farcaster Frame Surface:** Public read-only growth surfaces may include a Farcaster Frame such as `/frames/active-loans` that accepts a wallet address, reads active loans across supported chains, shows total active-loan count / lowest HF / per-chain breakdown, and deep-links into the public NFT Verifier for detail.
- **Legacy Provider Policy:** The frontend should not retain ethers.js compatibility shims or ethers as a production dependency after the wagmi / viem migration.
- **State Management:** Robust state management solution (e.g., Redux, Zustand).
- **Languages:** The frontend supports 10 app locales: English, Spanish, French, German, Japanese, Simplified Chinese, Korean, Hindi, Tamil, and Arabic. Locale-aware public routes, hreflang metadata, sitemap entries, number/date/duration formatting, and Arabic RTL layout should remain part of the launch surface. Legal and long-form guide content may show an English-only notice until the locale-matched source text exists.
- **Cross-Subdomain Preferences:** Theme and language preferences should sync across Vaipakam subdomains through parent-domain functionality cookies (`vaipakam_theme` and `vaipakam_lang`). The cookie value should override stale origin-scoped localStorage on initialization, and the shared helper should live in the workspace library so the marketing surface and connected app cannot drift.
- **Marketing SEO Stage A:** The marketing app should generate `robots.txt` and a locale-aware sitemap at build time, and each public route should set localized title, description, canonical, and `hreflang` alternate metadata. Canonical URLs should use `https://vaipakam.com` rather than `window.location.origin` so `www` or legacy-host visits cannot split search ranking signals.
- **Marketing/App Boundary:** The marketing app should not carry wallet, active-chain, vault, diagnostics, or address-book modules. Chain verification and transparency links from the marketing surface should hand users to the connected app's public transparency route.
- **User Guide Locales:** Basic and Advanced user-guide markdown should be maintained for all 10 supported locales with card-link anchors preserved verbatim, so every in-app `(i)` card-title link opens the matching localized guide section.
- **API Standards:** Frontend will interact with smart contracts using standardized data formats (e.g., JSON-like structs or arrays returned by view functions).
- **Pre-Sign Transaction Preview:** Before a user signs a supported transaction, the app should simulate the pending transaction directly against the active chain and show an advisory preview state: simulated OK, would revert with a readable reason when available, or preview unavailable. This preview is a gas-safety aid, not a security-vendor verdict, and must never block signing by itself. Third-party risk scanners may still be used for token, NFT, address, approval, or counterparty risk surfaces, but ordinary Vaipakam transaction preview should not require a vendor proxy or API key.
- **ABI Sync:** After any contract release that changes selectors, structs, events, or frontend-consumed ABIs, run the ABI export phase after `forge build` so `@vaipakam/contracts/abis`, app-local provenance files, and every consumer bundle match the deployed contract build and carry the source commit hash. When keeper-bot-consumed facets change, run the keeper-bot ABI export as well so bot JSONs and provenance stay aligned with the monorepo build.
- **Worker ABI Sync:** Agent, keeper, indexer, and watcher-style workers must import generated JSON ABI bundles from the same compiled contract artifacts as the frontend and keeper-bot ABIs. Hand-typed selector strings or positional tuples for structs such as `Offer` or `Loan` are not acceptable because a renamed selector or inserted field can silently break production reads. Deploy scripts should run worker ABI exports alongside other ABI exports, and worker bundles should carry provenance stamps.
- **Live Protocol Config:** Frontend copy that displays protocol fees, liquidation thresholds, rental buffer, staking APR, VPFI tier thresholds, pool caps, and minimum Health Factor should read from `getProtocolConfigBundle()` and `getProtocolConstants()` rather than hardcoded locale strings. Token-unit formatting for VPFI should use the token contract's live `decimals()` value where available.
- **Internal-Match Config Visibility:** Frontend and operator surfaces should read internal-match enablement, per-tier liquidation thresholds, the external-liquidation priority window, the per-leg matcher incentive, and fallback-pending rescue readiness from live protocol configuration and indexed loan state. Hardcoded liquidation-threshold copy must not survive once the tiered threshold surface is active.
- **Transaction Receipt Truth:** Shared write helpers should treat a mined transaction with receipt status `0` as a failure and surface the revert path to the user. Inclusion in a block is not by itself a success signal.
- **Ready Diamond Read Helper:** Frontend hooks that read from the Diamond should use a shared ready-Diamond handle that returns null when the active chain has no Diamond address. Hooks must short-circuit in that state rather than calling `readContract`, multicall, or protocol-config reads against `ZERO_ADDRESS`.
- **App-Chain-Pinned Public Client:** Diamond reads should use a shared public-client wrapper pinned to the app-selected chain id, not bare `usePublicClient()` from wagmi, because the wallet chain and app read chain can diverge during switch flows. Lint or review rules should reject new direct wagmi `usePublicClient` imports outside the wrapper, with documented carve-outs only for intentionally cross-chain utilities that receive an explicit chain id.
- **Chain-Scoped Frontend Caches:** App-level caches for active offers, dashboard loans, dashboard offers, claimables, and protocol configuration must include `chainId` in their cache key. A wallet chain switch should naturally miss the old cache and refetch for the new chain without requiring a manual refresh click.
- **Shared Chain Indexer:** The public worker may maintain a D1-backed chain index for offers, loans, activity, and claimability hints. It should scan the full allow-listed Diamond event set once per cron tick per configured chain, persist one cursor per chain / Diamond source, and expose read APIs for active offers, active loans, wallet-filtered loans, activity, claimables, and offer stats. Browser hooks should report whether data came from the indexer or fallback path. History belongs in D1, while current ownership-sensitive state should still be read from the chain where appropriate; for example, lender / borrower loan lists and claimability discovery may live-filter with `ownerOf(tokenId)` so transferred Vaipakam position NFTs are reflected immediately. The event scan should be shared across domains on each tick so adding a new indexed domain does not multiply RPC scans, and one cursor per chain / Diamond source should advance atomically with the persisted rows.
- **Per-User Index Consumption:** User-keyed read paths should consume maintained per-user indexes rather than walking global active sets and filtering for matches. Dashboard loans, dashboard offers, loan summaries, and vaulted-NFT views should scale with the user's own result count. Test mutators and fixture helpers should maintain these indexes the same way production write hooks do so analytics getters are exercised under both ordinary and test paths.
- **API Origin:** Frontend and worker consumers should use a generic API-origin configuration such as `VITE_API_ORIGIN` once the Worker serves more than HF alerts. Legacy hostnames like `alerts.vaipakam.com` should not remain in code, env examples, built bundles, runbooks, or sibling bot repositories after the API domain cutover.
- **Indexer Stub Discipline:** Offer and loan event handlers should try to fetch canonical `getOfferDetails` / full `getLoanDetails` data inline before inserting D1 rows. If an RPC failure forces a placeholder insert, the row must be marked with an explicit `is_stub` flag and targeted by a stub-only refresh predicate until canonical data lands. Active non-stub rows should not be re-read on every cron tick merely to detect ordinary status or partial-fill changes.
- **Event-Driven Offer Updates:** Range Orders partial-fill and close state should update from emitted events where the payload carries enough data. `OfferMatched` should update filled amount from post-match remaining capacity without a read round-trip, and `OfferClosed` should map close reasons into the indexer's status model in a single update.
- **Round-Robin Chain Processing:** Worker cron processing should respect Cloudflare-style subrequest budgets by processing a bounded number of chains per tick, with a persisted round-robin cursor when needed. A one-minute cron that processes one active chain per invocation is acceptable; the resulting per-chain cadence should be explicit and scale with the active chain count rather than silently exhausting the worker budget.
- **Active Chain Allow-List:** Deployment metadata exports should support an explicit operator-maintained active-chain allow-list, such as `contracts/deployments/.active-chains`, so stale deployment folders remain available for forensics without being exported to the frontend chain picker or crawled by the watcher. If the allow-list is absent, exports may fall back to the legacy include-all behavior; deploy scripts should not auto-edit the allow-list.
- **Safe-Block Indexing:** Both the browser fallback log index and the worker D1 indexer should cursor from the chain's safe block tag, falling back to `latest - 32` where safe tags are unavailable. Initial load, tab refocus, manual rescan, watermark refresh, and worker cron scans should all share this safe-aligned cursor policy so events from reorg-prone unsafe blocks are never cached as durable truth.
- **Watermark Probe Singleton:** Frontend watermark / freshness probing should run through a single app-level provider per active `(chainId, diamondAddress)`. Individual hooks and components subscribe with their desired cadence tier; the provider schedules one timer at the fastest currently active tier, handles visibility / idle / pause behavior centrally, and broadcasts the shared snapshot. This prevents Dashboard, OfferBook, and layout-level badges from creating duplicate drifting RPC probe loops. If the chain is cold and both global offer / loan counters are zero, the provider should stretch to a bounded 30-second cadence even when a hot page is mounted, then wake subscribers within that window after first activity.
- **Data Freshness Registry:** Frontend hooks that know a data frontier or loading state should report into a shared data-freshness context keyed by the active chain. The badge and diagnostics panel should derive their page-data frontier from the maximum of the central indexer frontier and all mounted RPC tail-scan frontiers, and should treat any registered loading source as `Live updating` or `Loading` rather than a clean live state. The diagnostics panel should expose each mounted source lane separately so operators can tell whether the indexer, OfferBook / Dashboard tail scan, log index, or user-loan lane is behind.
- **Indexer-Stale Tail-Scan Fallback:** If the central indexer frontier has not advanced for a bounded wall-clock window while the chain safe head continues to move well beyond the freshest RPC tail scan, the freshness provider should bump a fallback version that re-runs tail-scan hooks without adding new probe RPCs. The trigger should be rate-limited by safe-block advancement so an indexer outage cannot turn into continuous browser rescanning.
- **Shared Refresh Controls:** Dashboard, Vaipakam Vault, Offer Book, Activity, and Claim Center should share a single rescan button component backed by the common cooldown state, plus a compact sync-status chip derived from the same freshness registry. Public Analytics should rely on automatic watermark / indexer refresh and show only the sync-status chip, not a manual refresh button.
- **App Render Error Boundary:** The connected app should wrap routed content in an error boundary that resets on navigation, records an `app-crash` entry in the journey log, and shows a recovery card instead of a blank page. The card should include enough component-stack and decoded React-error context for support triage while avoiding dependence on app chrome that may itself be the failing surface.
- **Deployment Block Semantics:** Deployment artifacts must record the chain-native block height that RPC `eth_getLogs` uses for the deployed Diamond. On Arbitrum-family chains, Solidity `block.number` returns an L1 block number, so deployment scripts must use `ArbSys(0x64).arbBlockNumber()` or an equivalent helper when writing `deployBlock`. A wrong deploy block can cause cold-start indexers to scan the wrong range and miss historical offers or loans.
- **Indexer Cursor Recovery:** When no D1 cursor exists, the indexer should naturally start from `deployBlock - 1` and scan forward. Fresh-deploy scripts should not automatically seed the cursor at current safe head because that can skip real events after a purge or partial rehearsal. Manual safe-head seeding may exist only as an explicit operator escape hatch for cases where skipping history is intentional and documented.
- **Log-Index Fallback:** The frontend log index remains the browser fallback and local history source when the worker origin is unset, unavailable, or stale. Event-topic allow-list additions that need historical browser data should bump the cache key; hydrate-only migrations are appropriate only when the relevant event data was already captured in older caches.

### Public View Functions for Analytics, Transparency, and Integrations

Phase 1 should expose a clean public read-only surface for dashboards, DefiLlama-style trackers, portfolio apps, auditors, regulators, and other protocol integrations. These functions should be pure `view` functions, RPC-friendly, and easy to aggregate through multicall.

General design requirements:

- the analytics and transparency surface should remain read-only and should not require wallet connection just to fetch protocol-wide metrics
- the preferred implementation is to add lightweight public view helpers to existing facets where possible
- if a later phase needs a dedicated analytics-oriented facet, that surface should remain minimal, read-only, and composable
- values intended for dashboards, listings, and external analytics should be easy to verify against underlying on-chain state and events
- these helper functions add real value for DefiLlama-style TVL trackers, Dune-style analytics, portfolio applications, auditors, regulators, and other DeFi integrations
- these functions should be multicall-friendly so public dashboards can batch reads efficiently
- user-facing frontend helpers should prefer one bundled config read for mutable values and one bundled constants read for compile-time values, so a governance change or redeploy updates visible protocol numbers on next page load
- the worker-backed indexer API may complement, but not replace, on-chain view verification. Expected REST surfaces include active offer lists and stats, offer lookup by id / creator, active loan lists, loan lookup by id / lender / borrower, filtered activity, and wallet claimability hints. These endpoints are cache / discovery surfaces; money-moving actions must still read directly from contracts or verify against the latest on-chain state.
- the worker-backed indexer API should also expose aggregate analytics endpoints for loan stats, recent loans, recent offers, and per-day loan time-series buckets so public Analytics can avoid per-loan multicall walks during healthy worker operation.
- active offer and active loan endpoints must support cursor pagination and frontend consumers must drain pages until the cursor is exhausted or a documented defensive cap is reached; single-page reads must not be treated as complete once active markets exceed the default limit.
- offer-book endpoints and contract views should support active-offer lookup by exact `(lendingAsset, collateralAsset)` pair, backed by an index maintained at offer create / accept / cancel edges; callers should not need to walk every active offer to apply both filters
- per-user offer APIs should support both id-only and struct-returning variants, so tables that need full rows can avoid a per-offer detail fan-out while lighter callers can keep using ids
- dashboard loan APIs should support a bundled per-user loan-row read where each row is tagged with the user's lender / borrower side and includes the row fields needed by the table
- worker cursor rows should use one canonical source kind for the Diamond-wide indexer, so status endpoints and route handlers read the same cursor key the scanner writes.
- offer and loan rows may carry an `is_stub` data-quality flag; API responses should either hide unresolved stub rows from user-facing lists where placeholder values would mislead users, or surface a clear loading / unavailable state instead of rendering sentinel addresses such as `0x`
- the worker-backed activity ledger should be append-only and shared across offers, loans, VPFI protocol events, claim events, and Vaipakam NFT `Transfer` events. This lets Activity, Loan Details timelines, dashboard history, and ownership-history views filter the same event source instead of each building a private log scan.
- the indexer event decoder should be generated from the compiler-emitted Diamond ABI bundle, deduped by canonical event signature, rather than maintained as hand-written `parseAbi` event strings. This prevents topic drift when contract events add fields or move between facets.
- the indexer should fetch raw address-filtered logs and decode them locally against the generated event ABI when provider topic-OR limits make large event allow-lists unreliable.
- loan and offer mutation events that drive D1 state should carry the primary key plus post-state values for every field they change. Companion events such as loan-initiation details should be rich enough for the indexer to build canonical rows without a `getLoanDetails` read-back on the hot path; read-back and stub insertion are fallback paths only.
- CI should include an event-coverage guardrail that fails when a contract event tagged as a loan or offer state mutation has neither an indexer handler nor an explicit allow-list reason. The indexer is a projection of on-chain state, so new state-changing events must be wired or consciously excluded.
- `offers`, `loans`, and `activity_events` should be keyed by chain as well as domain identifiers so one Worker can fan out across configured chains without schema changes. Future horizontal scaling to one Worker per chain should not require table-shape changes.
- loan rows should store immutable origination data from `LoanInitiated` and one-time bootstrapped loan details such as lender token id, borrower token id, interest rate, start time, partial-repay flag, periodic-interest cadence, and last settled periodic checkpoint. Current lender / borrower ownership should be maintained from Vaipakam position-NFT `Transfer` events in dedicated current-owner columns and verified with direct chain reads on money-relevant screens, not inferred from stale origination columns.
- offer rows should track the current owner of the offer position NFT in addition to the original creator so secondary-market recipients of open offer NFTs can be discovered without scanning every offer.
- current-holder worker endpoints should expose `/loans/by-current-holder/:addr` and `/offers/by-current-holder/:addr`, backed by D1 current-owner indexes. Dashboard and Claim Center discovery should prefer those endpoints over original lender / borrower / creator routes, with on-chain current-holder views as the outage fallback.
- periodic-interest events should land in the same append-only `activity_events` ledger as ordinary loan lifecycle events so Loan Details timelines, Activity, and watcher reconciliation all read one event source.
- internal-match liquidation events should land in the same append-only activity ledger. The indexer should update each matched leg's principal and collateral according to the protocol's match fraction, mark fully cleared legs as internally matched, and preserve a user-visible event row with the matcher as actor.
- active-loan discovery should include a paginated, current-state view for match-eligible loans while internal matching is enabled. This view should include active distressed loans and fallback-pending loans, filter active loans by current LTV against their snapshotted liquidation threshold, require oracle-priceability for fallback-pending legs, and return empty when the internal-match switch is off.
- internal-match candidate discovery should support exact asset-pair indexing so matchers can find reciprocal and cyclic candidates without scanning every loan. Fallback-pending loans should remain in the index until they are fully rescued, claimed, or otherwise terminally resolved.

#### 1. Protocol-Wide Metrics

Highest priority public metrics should include:

- total protocol value locked in the active numeraire, with separate ERC-20 collateral and NFT collateral breakdowns
- total unique users, active loan count, active offer count, lifetime loan count, lifetime lending volume in the active numeraire, total interest earned, default rate, and average APR
- lightweight headline counters for user count, active loans, active offers, and total interest earned

These functions are intended to support the Vaipakam public analytics dashboard and external TVL / protocol-tracker integrations.

#### 1a. Protocol Configuration and Constants

Config and constant views should include:

- one bundled read for governance-mutable protocol configuration values used by the frontend, keepers, dashboards, and operator tools
- one stable read for compile-time protocol constants, including minimum Health Factor, VPFI staking pool cap, VPFI interaction-reward pool cap, and the maximum interaction-reward claim window

`getProtocolConfigBundle()` is the source for governance-mutable values such as fees, slippage settings, rental buffer, staking APR, VPFI discount tiers, Range Orders master flags, matcher-fee BPS, and the live maximum offer duration. `getProtocolConstants()` is the source for compile-time constants such as `MIN_HEALTH_FACTOR`, VPFI pool caps, and the maximum interaction-reward claim window.
The config bundle should also expose the depth-tiered-LTV switch and frontend-needed risk knobs when present, including baseline liquidity floor size, tier test sizes, current tier max-init-LTV values, tier safety boxes, tier haircuts, slippage budget, keeper confidence tier metadata, tier-LTV cache timestamps, stale-cache warning threshold, peer protocol address presence, partial-liquidation fraction bounds, partial Health Factor target buffer, split-route improvement threshold, discount-path enabled state, and effective per-tier liquidation discounts.
The config bundle should also expose internal-match liquidation settings where present, including enablement state, per-tier liquidation thresholds, the external-liquidation priority window, and the per-leg matcher incentive.

#### 2. Treasury and Revenue Metrics

Treasury, fee, and revenue views should include:

- treasury balance in the active numeraire
- total fees collected in the active numeraire, including ordinary interest and late-fee revenue
- rolling fee totals for recent windows such as the last 24 hours and last 7 days
- configurable revenue-window totals for public reporting and tokenomics dashboards
- treasury reserve-allocation targets and last conversion status where public disclosure is approved
- funded contributor salary-stream obligations and vesting-wallet grant totals at an aggregate level, without exposing private payroll details

These functions are especially useful for treasury transparency, tokenomics reporting, listings, and public revenue dashboards.

#### 3. Lending and Offer Metrics

Loan and offer analytics helpers should include:

- full loan and full offer detail reads by identifier
- paginated active-loan and active-offer discovery for scalable public lists
- active-offer filtering by individual asset and by lending/collateral asset pair
- detailed per-user offer rows with pagination so user tables do not need one read per offer
- bundled per-user loan rows tagged with the connected user's lender or borrower side for dashboard use
- aggregate loan-summary values, including active-loan value in the active numeraire, average loan duration, and average LTV

These functions help public dashboards, market pages, listing views, and research tools inspect protocol activity without forcing expensive full-history scans for every page load.

#### 4. NFT and Vault Metrics

For ERC-4907-style rentals and vault analytics, the protocol should expose:

- vault-wide NFT counts, active rental counts, and total rental volume in the active numeraire
- NFT rental detail reads by token identifier
- collection-level vault counts for public collection transparency
- protocol-tracked ERC-20 vault balances for a user and token, so user-facing balances can ignore unsolicited dust
- stuck-token recovery metadata required to verify the user's recovery acknowledgement and replay protection

These functions support rental analytics, vault transparency, collection-level monitoring, tracked-balance display, and stuck-token recovery UX.

#### 5. Oracle and Risk Metrics

Risk and asset-support helpers should include:

- asset support status, liquidity classification, maximum LTV, liquidation threshold, and liquidation bonus
- raw liquidity tier and effective liquidity tier after keeper confidence limits are applied
- tier-specific maximum initiation LTV and tier-specific liquidation discount values
- tier-LTV cache values and freshness timestamps, plus a permissionless refresh path for the cache
- safe price-read status and active-numeraire price where available
- illiquid-asset enumeration and a simple asset-support check for integrations

These functions help external dashboards and integrations understand current support, liquidity classification, tiered collateral capacity, and collateral risk configuration on the active network. The risk profile helper does not return a live numeraire price; consumers that need pricing should use the dedicated oracle / price read surface instead of inferring it from this tuple.
The tier-LTV cache helpers let frontend, keepers, and operator tools distinguish fresh peer-derived tier caps from library fallback defaults.

Additional oracle-hardening views should expose active per-feed overrides and configured secondary-oracle settings where practical, including:

- per-feed override freshness and minimum-answer rules
- configured secondary oracle providers and their deviation / freshness limits
- active predominantly available denominator address, symbol, ETH/PAD feed, and PAD/numeraire feed
- per-asset direct numeraire feed overrides
- configured peer-protocol addresses used for tier-LTV comparison and cache refresh

These readbacks let operators, auditors, and frontend safety surfaces verify that high-value assets are using the intended freshness floors and secondary-oracle deviation bounds.

#### 6. User-Specific Metrics

For portfolio tracking and wallet integrations, the protocol should expose:

- user-level collateral, borrowed amount, claimable amount, Health Factor, and active-loan count
- active-loan and active-offer identifiers for a user
- loan and offer positions currently controlled by the user's Vaipakam position NFTs, including the relevant token identifiers
- NFT identifiers currently held in vault for the user

`getUserPositionLoans` and `getUserPositionOffers` should enumerate the connected user's current Vaipakam position NFTs and resolve them through loan / offer reverse maps. They are the preferred on-chain fallback for secondary-market recipients because they scale with the user's NFT count rather than with global protocol loan or offer counts.

These remain public view functions, but frontend and integration usage should still follow the broader privacy principle of not building public PII-style dashboards around individual identity.

#### 7. Compliance and Transparency Helpers

For auditors, regulators, researchers, and public transparency tooling, the protocol should also expose:

- protocol utilization, total collateral, total debt, and pause status
- a freshness timestamp that callers can compare against their own data snapshots

These helpers support data-freshness checks, exportable transparency views, and verifiable protocol-health reporting.

#### Why these view functions add real value

| Integration                | Value delivered                                                                 |
| -------------------------- | ------------------------------------------------------------------------------- |
| DefiLlama / TVL trackers   | instant TVL, asset breakdown, and historical data without custom indexers       |
| Dune Analytics / Nansen    | ready-made, SQL-friendly aggregates that cut down on event replay               |
| Wallets and portfolio apps | one-call user position summaries (collateral, debt, claims, health factor)      |
| Auditors and regulators    | verifiable, exportable protocol-health metrics for public oversight             |
| Other DeFi protocols       | easy composability — e.g. flash-loan providers can query risk profiles on-chain |

All functions are pure `view` functions (zero gas for callers when invoked via RPC) and multicall-friendly, so dashboards can batch reads in a single round-trip.

### Testing and Auditing

- **Testing:** Comprehensive test suites should cover unit, integration, and end-to-end flows, including positive/negative paths, edge cases, metadata/event checks, and various asset-handling scenarios.
- **Internal Audits:** Static analysis tools and internal code reviews should be part of the standard development process.
- **Fuzz Testing:** Financial math, defaults, and LTV / health-factor edge cases should be fuzz tested.
- **Open-Source Tests:** Test cases may be made open-source after mainnet deployment for community review.
- **External Auditing:** Mandatory third-party security audits should be completed before mainnet launch, with reports published where appropriate.
- **Bug Bounty:** A public bug bounty program should be defined before mainnet launch, including scope, severity levels, reward ranges, and a public reporting link. The website footer should link to that program once published.
- **Secret Hygiene:** Repository-tracked configuration must not contain private keys, even well-known local development keys; local Anvil or testnet keys should be supplied through local-only environment files or shell configuration outside committed allowlists.
- **Liquidation Invariants:** Tests must assert that liquidation swap calldata uses the protocol-computed oracle-derived minimum output and that callers cannot influence the slippage floor.
- **Oracle-Hardening Tests:** Tests should cover per-feed override admin gating, staleness override behavior, minimum-answer floor behavior, secondary-oracle agreement, divergence, stale secondary data, and missing secondary data.
- **Autonomous Tier-LTV Tests:** Tests should cover peer-read not-listed / reverted cases, peer plausibility bounds, peer disagreement filtering, insufficient readings, no-reference-assets rejection, out-of-band-low / out-of-band-high rejection, per-tier independent refresh behavior, cache TTL fallback to library defaults, stale-cache warning events, and loan-init / match-preview use of `effectiveTierMaxInitLtvBps`.
- **Tier Safety-Box Tests:** Tests should cover `setTierLtvParams` admin gating, floor / ceiling consistency, haircut bounds, cross-tier non-overlap, atomic all-tier updates, and zero-storage fallback to library constants.
- **Failed-Swap Fallback Tests:** Tests should cover failed liquidation with fresh oracle quorum using the fair-value collateral split, failed liquidation with stale or unavailable quorum using the full-collateral branch, and emission of the dedicated oracle-unavailable fallback event.
- **Discounted Liquidation Tests:** Tests should cover the discount-path master switch, zero recipient, inactive loan, sequencer unhealthy, Health Factor not liquidatable, untierable collateral, stale oracle quorum, happy-path tier settlement with exact debt / collateral seized / borrower surplus math, and event emission.
- **Discount Config Tests:** Tests should cover `setTierLiqDiscountBps` admin gating, per-tier floor / ceiling bounds, cross-tier monotonicity, zero-fallback behavior against library defaults, kill-switch toggling, and event emission.
- **Flash-Loan Receiver Tests:** Tests should cover constructor guards, owner-gated entry points, provider-not-configured branches, callback in-flight guards, unprofitable-trade reverts, swap-target-reverts, Aave and Balancer happy paths, and profit withdrawal / rescue flows.
- **Flash-Loan Atomicity Tests:** Tests and review should verify that keeper-funded flash-loan liquidation is atomic: the Diamond receives or pulls the principal repayment before collateral is released, the flash-loan callback reverts the whole transaction if debt plus fee cannot be repaid, and the keeper receiver does not retain custody of user funds between transactions.
- **Internal-Match Liquidation Tests:** Tests should cover internal-match enablement defaulting off, per-tier liquidation-threshold snapshots at loan initiation, two-loan reciprocal matches, three-loan cycle matches, priority-window blocking of external liquidation, reopening external liquidation after the window, per-leg incentive bounds, partial-match residual claimability, terminal-state claim behavior, lender-side claim of matched proceeds by the current (possibly transferred) lender-position holder, two-sided order-independent settlement (lender-first and borrower-first) including zero-residual settlement on the lender claim alone, the stored lender being unable to extract the proceeds after a position transfer, sanctions rejection of a flagged lender claimant, claim-time auto-dispatch paying the triggering holder, fallback-pending full rescue, fallback-pending partial residual scaling, oracle-unpriceable fallback-pending rejection, active-to-internally-matched and fallback-pending-to-internally-matched lifecycle edges, and event/indexer compatibility.
- **Offer-System Behaviour Tests:** Tests should cover fill-mode behaviour, offer expiry and cleanup, in-place offer modification without orphaning already-filled obligations, direct-accept preview parity with actual acceptance, and self-trade prevention across both direct acceptance and permissionless matching.
- **NFT Collateral Listing Tests:** Tests should cover borrower opt-in, lender-side permission, minimum sale-floor enforcement, approved marketplace transfer paths, full-position ERC-1155 sales, listing update and cancellation, marketplace-fill settlement order, grace-boundary expiry, default after an unfilled listing, proper close after a sale, stale-listing cleanup after other terminal paths, offer consumed by sale before lender acceptance, sale-versus-accept race handling, Dutch-decay monotonicity and auction-window bounds, atomic OpenSea-offer match rotation, fee-enforced collection fulfillment-data handling, sibling-listing approval isolation, current-borrower-holder release authority, and sanctions checks at fill time where sanctions screening is active.
- **Swap-to-Repay Tests:** Tests should cover full-close and partial-reduction modes, partial-mode rejection when the swap would close the loan, current borrower-position NFT authority, lender-self-repay rejection, all-routes-failed atomic revert, slippage-cap enforcement, settlement waterfall parity with ordinary repayment, borrower surplus principal delivery, unused collateral claim creation, prepay-listing cleanup, and event/indexer compatibility for Activity and Loan Details timelines.
- **Auto-Lifecycle Tests:** Tests should cover per-user auto-lend / offer-posting and auto-opt-in flags, default and per-loan auto-refinance caps, default-off behavior for illiquid and NFT-collateral loans, refinance-target offer tagging at create and accept time, atomic accept-and-refinance for direct and matched accept paths, stale-cap rejection after NFT transfer, keeper-driven refinance fund routing through the current borrower-position holder, wallet-approval source-of-funds expectations, auto-extend both-side cap intersection, kill-switch reverts, sanctions checks, periodic-interest settle-first protection, pre-grace watcher throttling / viable-counterparty suppression, and keeper reward behavior.
- **Production-Superset Test Harness:** Shared test scaffolding should route every production Diamond facet selector plus any explicit test-only helpers. A test should not pass by accidentally hitting a missing selector where production would route the call, especially for pause, legal, reward, oracle-admin, vault, and tokenomics surfaces.
- **Off-Chain Data-Flow Audit:** Before mainnet, the project should maintain a catalog of off-chain reads and writes used by the frontend, workers, indexer, keeper, and operator tools. Each entry should identify signer requirements, freshness or time-to-live assumptions, fail-open or fail-closed behavior, plausibility checks, and blast radius. External reads that influence money-moving decisions should have explicit stale-data handling, and keeper writes should remain bounded by on-chain checks.
- **Off-Chain Data Resilience:** Before mainnet, production off-chain data needed for usability and compliance should have an encrypted backup path outside the primary hosting account and billing boundary. The backup set should include indexed offer / loan data, diagnostics needed for support, legal-hold audit records, and legal-document storage. Operators should verify backup readability on a recurring schedule and maintain a documented restore path for a fresh hosting account.
- **Risk Sign-Off Package:** Before each mainnet launch or material risk-control activation, operators should archive a risk sign-off covering audit posture, parameter sanity, emergency controls, bot and external dependency readiness, chain-specific deployment readbacks, liquidation economics, sequencer and oracle outage behavior, and the exact scope being approved.
- **Release-Notes Discipline:** Behaviour-changing pull requests should carry their own unreleased release-note fragment so operator-facing change history lands atomically with the work. Daily or release-cut assembly may fold those fragments into dated release notes, and CI should warn when app or contract behaviour changes without a corresponding release-note entry.
- **Required CI Gate:** The protected main branch should require fast deploy-sanity, positive-flow, and workspace-validation checks, plus the change-detection gate that decides which checks are relevant for a pull request. Per-PR contracts CI should use the narrow `cifast` Foundry profile for the deploy-sanity and positive-flow surface so routine PRs stay within hosted-runner memory limits. Slow full-regression and gas-cost review checks are operator-local on ordinary pull requests, while release branches and version tags must run the full predeploy regression as a hard mainnet gate before cutover. The removed `contracts-full` and `gas-snapshot` jobs should not be referenced as live PR gates in FunctionalSpecs, runbooks, or comments.
- **Deploy Guardrails:** Deploy sanity coverage should fail before broadcast when a facet would exceed the EVM runtime-size limit, when a public selector is missing, duplicated, or routed to the wrong facet, when the expected facet count does not exactly match the deployed Diamond, or when committed ABI files are stale or missing. These checks protect deployability and consumer compatibility rather than changing user behavior.
- **Static-Analysis Closure:** Static-analysis findings should be triaged to zero open high-risk findings before mainnet readiness. Dismissed findings need written rationale, dependency findings should be filtered when they belong to unmodified audited libraries, and real dead-code findings should be removed instead of suppressed.
- **Generated Contract Documentation:** Public NatSpec documentation must describe the current Chainlink CCIP cross-chain architecture and avoid stale LayerZero / OApp wording. If generated public docs are known to be materially stale during a migration, the published site should visibly warn readers until the wording is corrected, and that warning should be retired once the docs are current.
- **Governance-Handover Tests:** Tests should verify that Governance Safe, Timelock, Pauser / Guardian Safe, and any KYC operator role are installed correctly, that `UNPAUSER_ROLE` is Timelock-held, that `PAUSER_ROLE` alone cannot unpause globally or per asset, and that the deployer EOA retains no residual privileged authority after handover.
- **Testnet E2E Baseline:** After a fresh testnet redeploy, operators should run the full positive-flow E2E suite on the canonical testnet and partial-flow E2Es on mirror testnets. The 2026-05-11 rehearsal baseline used Base Sepolia as canonical and Sepolia as the active mirror after retiring Arb Sepolia from the exported bundle until it is redeployed and re-wired; Base Sepolia completed preflight, fresh contracts, configure, verify, and full flow tests, while Sepolia completed preflight, fresh contracts, configure, and verify. The 2026-05-10 rehearsal baseline covered Base Sepolia, Arb Sepolia, and Sepolia with the phase-based deploy ceremony; Base Sepolia and Sepolia completed handover plus `DeployerZeroRolesTest`, while Arb Sepolia deliberately stopped before handover because Safe bytecode was absent at the configured addresses. Flow sweeps should preserve the same chain-agnostic signature as local Anvil: full PositiveFlows on canonical rehearsal chains and PartialFlows on mirror chains. The older 2026-04-30 baseline covered 15 lifecycle scenarios on Base Sepolia with 204 / 204 successful receipts, and left Sepolia + BNB Testnet in frontend-testable midpoint states.

#### Positive-flow coverage map

Every spec-mandated happy path has a dedicated test. Run from `contracts/`:
`forge test --match-contract <ContractName> -vv`. The list below mirrors the
flow list in the Phase-1 gap audit (see CHANGELOG `[Unreleased]`).

**End-to-end scenario suites** — full create / accept / resolve lifecycles:

- **ERC-20 lending lifecycle** — [contracts/test/Scenario1_ERC20LendingLifecycle.t.sol](contracts/test/Scenario1_ERC20LendingLifecycle.t.sol)
  - `test_Scenario1a_CreateOffer_Accept_Repay_Claims` — happy-path repay+claim.
  - `test_Scenario1b_CreateOffer_Accept_Default_LenderClaims` — default → lender claim.
  - `test_Scenario1c_ThirdPartyRepays_BorrowerClaimsCollateral` — non-borrower repayment, borrower reclaims collateral.
- **NFT rental (ERC-721)** — [contracts/test/Scenario2_NFTRentalLending.t.sol](contracts/test/Scenario2_NFTRentalLending.t.sol)
  - `test_Scenario2a_ERC721Rental_FullLifecycle` / `..._Default`.
- **NFT rental (ERC-1155)** — [contracts/test/Scenario2b_ERC1155RentalLending.t.sol](contracts/test/Scenario2b_ERC1155RentalLending.t.sol)
  - `test_Scenario2b_ERC1155Rental_FullLifecycle` / `..._Default`.
- **Illiquid collateral** — [contracts/test/Scenario4_IlliquidCollateral.t.sol](contracts/test/Scenario4_IlliquidCollateral.t.sol)
  - `test_Scenario4a_IlliquidCollateral_Default_FullTransferToLender`.
- **Lender early-withdrawal** — [contracts/test/Scenario7_LenderEarlyWithdrawal.t.sol](contracts/test/Scenario7_LenderEarlyWithdrawal.t.sol)
  - `test_Scenario7a_SellLoanViaBuyOffer` / `test_Scenario7b_CreateSaleOffer_NewLenderAccepts`.
- **Borrower preclose** — [contracts/test/Scenario8_BorrowerPreclose.t.sol](contracts/test/Scenario8_BorrowerPreclose.t.sol)
  - `test_Scenario8a_TransferObligationViaOffer` / `test_Scenario8b_OffsetWithNewOffer_ThenAccept`.
- **Fallback-claim race** — [contracts/test/scenarios/ScenarioFallbackClaimRace.t.sol](contracts/test/scenarios/ScenarioFallbackClaimRace.t.sol)
  - `test_ScenarioA_BorrowerRepaysBeforeLenderClaim` / `...B_AddsCollateralBeforeDefault` / `...C_PartialThenFullRepay`.

**Gap-filler positive tests** — spec-mandated flows that weren't covered by the scenarios:

- [contracts/test/PositiveFlowsGapFillers.t.sol](contracts/test/PositiveFlowsGapFillers.t.sol)
  - `test_Positive_CountryPairAllow_FullLifecycle` — explicit allow-path lifecycle (Flow 15).
  - `test_Positive_LoanInitiationFee_ExactDeduction` — asserts exact 0.1% fee to treasury (Flow 29).
  - `test_Positive_PartialRepay_TwoStep_CompletesWithNoDust` — partial-then-full repay with remaining-balance assertion (Flow 9).
  - `test_Positive_KeeperTwoLayerOptIn_StateRecorded` — profile-level + per-loan keeper flag ledger (Flow 25).

**Phase-1 compliance integration** — the load-bearing KYC gate:

- [contracts/test/KYCTierEnforcementIntegration.t.sol](contracts/test/KYCTierEnforcementIntegration.t.sol) — full Tier 0 / 1 / 2 matrix across OfferFacet.acceptOffer:
  - `test_Tier0_AllowedBelowTier0Threshold` (< $1k).
  - `test_Tier0_BlockedAboveTier0Threshold` (reverts `KYCRequired` above $1k).
  - `test_Tier1_AllowedInMiddleBand` (between $1k and $10k).
  - `test_Tier1_BlockedAboveTier1Threshold` (reverts above $10k).
  - `test_Tier2_AllowedAboveTier1Threshold` (any amount).
  - `test_EnforcementOff_Tier0AllowedAboveThreshold` — confirms the `AdminFacet.setKYCEnforcement(false)` bypass.

**Per-facet positive tests** — happy-path coverage of individual entrypoints (file per facet):

- [contracts/test/OfferFacetTest.t.sol](contracts/test/OfferFacetTest.t.sol) — createOffer / acceptOffer / cancelOffer positives.
- [contracts/test/LoanFacetTest.t.sol](contracts/test/LoanFacetTest.t.sol) — initiateLoan, getLoanDetails, and combined Risk Disclosures / Terms consent state.
- [contracts/test/RepayFacetTest.t.sol](contracts/test/RepayFacetTest.t.sol) — repayLoan, repayPartial, autoDeductDaily.
- [contracts/test/AddCollateralFacetTest.t.sol](contracts/test/AddCollateralFacetTest.t.sol) — addCollateral HF improvement.
- [contracts/test/ClaimFacetTest.t.sol](contracts/test/ClaimFacetTest.t.sol) — claimAsLender, claimAsBorrower.
- [contracts/test/DefaultedFacetTest.t.sol](contracts/test/DefaultedFacetTest.t.sol) — triggerDefault / triggerLiquidation, both liquid + illiquid paths.
- [contracts/test/PrecloseFacetTest.t.sol](contracts/test/PrecloseFacetTest.t.sol) — direct preclose, transfer-offer, offset-offer.
- [contracts/test/RefinanceFacetTest.t.sol](contracts/test/RefinanceFacetTest.t.sol) — refinanceLoan atomic settlement.
- [contracts/test/EarlyWithdrawalFacetTest.t.sol](contracts/test/EarlyWithdrawalFacetTest.t.sol) — sell-loan, buy-offer, wait-to-maturity.
- [contracts/test/PartialWithdrawalFacetTest.t.sol](contracts/test/PartialWithdrawalFacetTest.t.sol) — partial collateral withdrawal when HF allows.
- [contracts/test/ProfileFacetTest.t.sol](contracts/test/ProfileFacetTest.t.sol) — KYC tier updates, keeper opt-in/whitelist, country setting.
- [contracts/test/ConfigFacetTest.t.sol](contracts/test/ConfigFacetTest.t.sol) — all runtime-tunable setters + getters.
- [contracts/test/OracleFacetTest.t.sol](contracts/test/OracleFacetTest.t.sol) / [OracleAdminFacetTest.t.sol](contracts/test/OracleAdminFacetTest.t.sol) — price reads, sequencer uptime, staleness.
- [contracts/test/RiskFacetTest.t.sol](contracts/test/RiskFacetTest.t.sol) — LTV / HF calculation, liquid HF-based liquidation.
- [contracts/test/MetricsDashboardFacetTest.t.sol](contracts/test/MetricsDashboardFacetTest.t.sol) and related metrics suites — per-user indexed dashboard reads, active-offer asset-pair pagination, and struct-returning per-user offer rows should stay covered without walking global active sets.
- MetricsFacet tests should cover current-holder position views for secondary-market recipients: transfer lender, borrower, and offer position NFTs; assert `getUserPositionLoans` / `getUserPositionOffers` follow the current NFT owner; and assert the sum of resolved loan / offer positions matches the holder's Vaipakam position-NFT balance where appropriate.
- [contracts/test/AdminFacetTest.t.sol](contracts/test/AdminFacetTest.t.sol) — treasury / 0x proxy / pause toggles.
- [contracts/test/DiamondBornPausedTest.t.sol](contracts/test/DiamondBornPausedTest.t.sol) — fresh Diamonds start paused through constructor and remain paused until the explicit unpause step after facet cuts.
- [contracts/test/AccessControlTransferAdminTest.t.sol](contracts/test/AccessControlTransferAdminTest.t.sol) — atomic admin / role / ERC-173 ownership transfer and lockout of the former admin.
- [contracts/test/TreasuryFacetTest.t.sol](contracts/test/TreasuryFacetTest.t.sol) — claimTreasuryFees.
- [contracts/test/TreasuryMintVPFITest.t.sol](contracts/test/TreasuryMintVPFITest.t.sol) — VPFI mint for treasury-funded flows.
- [contracts/test/VaultFactoryFacetTest.t.sol](contracts/test/VaultFactoryFacetTest.t.sol) — per-user vault proxy creation, mandatory upgrade gating, versioned upgrade event.
- [contracts/test/VaultRecoveryTest.t.sol](contracts/test/VaultRecoveryTest.t.sol) — protocol-tracked ERC-20 balances, unsolicited dust clamp, EIP-712 stuck-token recovery, disown event, and sanctions-source outcomes.
- [contracts/test/VaipakamNFTFacetTest.t.sol](contracts/test/VaipakamNFTFacetTest.t.sol) — position NFT mint / update / burn lifecycle.
- [contracts/test/MetricsFacetTest.t.sol](contracts/test/MetricsFacetTest.t.sol) — read-only analytics getters.
- [contracts/test/AccessControlFacetTest.t.sol](contracts/test/AccessControlFacetTest.t.sol) — role grants / revocations / emergency revoke.
- [contracts/test/AdminFacetTest.t.sol](contracts/test/AdminFacetTest.t.sol) / [PerAssetPauseTest.t.sol](contracts/test/PerAssetPauseTest.t.sol) — per-asset pause ON → blocks, OFF → unblocks.
- pause tests should cover the asymmetric role split: `PAUSER_ROLE` can pause but cannot unpause, `UNPAUSER_ROLE` can unpause but cannot act as the fast pauser unless separately granted, and per-asset unpause follows the same separation as global unpause.
- [contracts/test/PauseGatingTest.t.sol](contracts/test/PauseGatingTest.t.sol) — whenNotPaused modifier coverage across 15+ facet entrypoints.
- [contracts/test/VPFIDiscountFacetTest.t.sol](contracts/test/VPFIDiscountFacetTest.t.sol) / [VPFIDiscountBoundariesTest.t.sol](contracts/test/VPFIDiscountBoundariesTest.t.sol) — tier table, vault deposit / withdraw, fee discount application.
- VPFI token tests should cover canonical + cross-chain mirror mechanics, including rate limits, allowed lanes, and source-chain identity checks.
- [contracts/test/VPFIBuyAdapterRateLimitsTest.t.sol](contracts/test/VPFIBuyAdapterRateLimitsTest.t.sol) — buy-adapter default caps, setter round-trip, and tuple getter parity with per-field getters.
- [contracts/test/StakingAndInteractionRewardsTest.t.sol](contracts/test/StakingAndInteractionRewardsTest.t.sol) / [StakingRewardsCoverageTest.t.sol](contracts/test/StakingRewardsCoverageTest.t.sol) / [InteractionRewardsCoverageTest.t.sol](contracts/test/InteractionRewardsCoverageTest.t.sol) / [InteractionRewardCapTest.t.sol](contracts/test/InteractionRewardCapTest.t.sol) — 5% APR accrual, interaction rewards emission schedule, pool-cap truncation.
- [contracts/test/Permit2IntegrationTest.t.sol](contracts/test/Permit2IntegrationTest.t.sol) / [contracts/test/fork/Permit2RealForkTest.t.sol](contracts/test/fork/Permit2RealForkTest.t.sol) — Permit2 integration against the local mock and real canonical Permit2 on a fork, including expired deadline, wrong amount, nonce reuse, and spender mismatch cases.
- Cross-chain reward plumbing tests should cover canonical broadcast + mirror aggregate reporting through the approved messenger and EVM chain-id model.
- swap-adapter tests should cover immutable allowance target approval, rejection of unallowlisted swap destinations, owner-gated allowlist edits, and protection against removing the last allowed destination.
- [contracts/test/GracePeriodTiersTest.t.sol](contracts/test/GracePeriodTiersTest.t.sol) — default grace-period tier transitions.
- [contracts/test/GraceBucketsTest.t.sol](contracts/test/GraceBucketsTest.t.sol) — admin-configurable six-slot grace schedule, bounds, defaults, event emission, and rollback to compile-time defaults.
- [contracts/test/PeriodicInterestCadenceTest.t.sol](contracts/test/PeriodicInterestCadenceTest.t.sol) / [contracts/test/PeriodicInterestSettleTest.t.sol](contracts/test/PeriodicInterestSettleTest.t.sol) — cadence eligibility, numeraire threshold validation, periodic settlement, interest-first partial repayments, auto-liquidation, and refinance settle-first protection.
- [contracts/test/VolatilityLTVTest.t.sol](contracts/test/VolatilityLTVTest.t.sol) — collapse-trigger (LTV > 110%) fallback path.
- [contracts/test/FallbackCureTest.t.sol](contracts/test/FallbackCureTest.t.sol) — borrower cures before fallback settlement.
- [contracts/test/StalenessHybridTest.t.sol](contracts/test/StalenessHybridTest.t.sol) — Chainlink hybrid staleness (peg tolerance).
- [contracts/test/SequencerUptimeCheckTest.t.sol](contracts/test/SequencerUptimeCheckTest.t.sol) — L2 sequencer circuit breaker.
- [contracts/test/EnumerationTest.t.sol](contracts/test/EnumerationTest.t.sol) — paginated offer / loan enumeration.
- [contracts/test/WorkflowComplianceAndRejection.t.sol](contracts/test/WorkflowComplianceAndRejection.t.sol) — full-stack sanctions / KYC rejection paths (5 tests `vm.skip`-marked for Phase 1, awaiting Phase-2 re-activation).
- [contracts/test/Create2DeploymentTest.t.sol](contracts/test/Create2DeploymentTest.t.sol) / [DeployerZeroRolesTest.t.sol](contracts/test/DeployerZeroRolesTest.t.sol) — deterministic address + post-handover role invariant.

**Property / invariant suites** — stateful fuzzing, 100 runs × 50k calls each:

- [contracts/test/invariants/ConfigBounds.invariant.t.sol](contracts/test/invariants/ConfigBounds.invariant.t.sol) — ConfigFacet setters never breach MAX_FEE / SLIPPAGE / INCENTIVE / DISCOUNT caps.
- [contracts/test/invariants/InterestMonotonicity.invariant.t.sol](contracts/test/invariants/InterestMonotonicity.invariant.t.sol) — amount-due non-decreasing as time advances.
- [contracts/test/invariants/PerAssetPause.invariant.t.sol](contracts/test/invariants/PerAssetPause.invariant.t.sol) — paused-asset blocks new create/accept across all flows.
- [contracts/test/invariants/OfferLoanLinkage.invariant.t.sol](contracts/test/invariants/OfferLoanLinkage.invariant.t.sol) — every loan points to an accepted offer.
- [contracts/test/invariants/StakingRewardMonotonicity.invariant.t.sol](contracts/test/invariants/StakingRewardMonotonicity.invariant.t.sol) — rewardPerTokenStored never decreases; per-user earned grows until claim.
- [contracts/test/invariants/DefaultTiming.invariant.t.sol](contracts/test/invariants/DefaultTiming.invariant.t.sol) — defaults only trigger after grace-period window.
- [contracts/test/invariants/FundsConservation.invariant.t.sol](contracts/test/invariants/FundsConservation.invariant.t.sol) / [VaultSolvency.invariant.t.sol](contracts/test/invariants/VaultSolvency.invariant.t.sol) — no phantom funds, vault balances conserved.
- [contracts/test/invariants/LoanStatusMonotonicity.invariant.t.sol](contracts/test/invariants/LoanStatusMonotonicity.invariant.t.sol) — loan status only moves forward.
- [contracts/test/invariants/ClaimExclusivity.invariant.t.sol](contracts/test/invariants/ClaimExclusivity.invariant.t.sol) — each party claims at most once per loan.
- [contracts/test/invariants/CollateralMonotonicity.invariant.t.sol](contracts/test/invariants/CollateralMonotonicity.invariant.t.sol) — collateral balance only grows during loan life (addCollateral-only).
- [contracts/test/invariants/FallbackSettlement.invariant.t.sol](contracts/test/invariants/FallbackSettlement.invariant.t.sol) — fallback settlement consistent with HF/LTV collapse flags.
- [contracts/test/invariants/InteractionRewards.invariant.t.sol](contracts/test/invariants/InteractionRewards.invariant.t.sol) — reward emission stays within schedule + per-user cap.
- [contracts/test/invariants/StakingBalances.invariant.t.sol](contracts/test/invariants/StakingBalances.invariant.t.sol) — sum(userStaked) == totalStaked, pool-cap respected.
- [contracts/test/invariants/VPFISupplyCap.invariant.t.sol](contracts/test/invariants/VPFISupplyCap.invariant.t.sol) — total VPFI supply never exceeds hard cap.
- [contracts/test/invariants/MetricsCountersParity.invariant.t.sol](contracts/test/invariants/MetricsCountersParity.invariant.t.sol) — MetricsFacet counters match raw storage.
- [contracts/test/invariants/NFTCountParity.invariant.t.sol](contracts/test/invariants/NFTCountParity.invariant.t.sol) / [NFTOwnerAuthority.invariant.t.sol](contracts/test/invariants/NFTOwnerAuthority.invariant.t.sol) — position-NFT count + authority correctness.
- [contracts/test/invariants/OfferAcceptanceIntegrity.invariant.t.sol](contracts/test/invariants/OfferAcceptanceIntegrity.invariant.t.sol) — accepted offers become loans; canceled offers never accept.
- [contracts/test/invariants/VaultUniqueness.invariant.t.sol](contracts/test/invariants/VaultUniqueness.invariant.t.sol) — one vault per user, no dupes.
- [contracts/test/invariants/SelfDealingPrevention.invariant.t.sol](contracts/test/invariants/SelfDealingPrevention.invariant.t.sol) — no lender == borrower loans.

Mainnet-cutover checklist: every `contracts/test/Scenario*.t.sol` + every
`contracts/test/invariants/*.invariant.t.sol` suite must be green on the
target network's fork before the `-mainnet-rc` tag is cut. See
[CHANGELOG.md](CHANGELOG.md).

## 14. Initial Deployment and Configuration (Phase 1)

- **Networks:** Ethereum mainnet, Base, Polygon, Arbitrum, and Optimism. Network-specific optimizations (e.g., gas limits, contract deployment strategies) will be considered.
- **Initially Supported Lending/Collateral Assets (Examples):**
  - **ERC-20 (Liquid):** USDC, USDT, DAI, WETH, WBTC.
  - (The platform will allow any ERC-20, but these will be prominently featured or have easier frontend selection initially).
- **Loan Durations:** 1 day to 1 year (`1–365` days), enforced consistently by frontend validation and the contract path.
- **Testnet Master Flags:** Testnet deployment automation may flip the Range Orders master flags for amount ranges, rate ranges, borrower collateral ranges, and partial-fill matching on after deployment so flow scripts can exercise the enabled feature surface. Mainnet deployment automation must not auto-flip these flags; production rollout remains governance-controlled through the Timelock / Safe path.
- **Canonical Limit-Order Enablement:** Fresh deployments intended to exercise canonical limit-order behavior should enable amount ranges, rate ranges, borrower collateral ranges, and partial-fill matching together after initialization. Mainnet may still stage that enablement through the governance path, but operators should treat the four switches as one product surface rather than enabling only one side of partial fills.
- **Phase-Based Deploy Ceremony:** `deploy-testnet.sh` should mirror `deploy-mainnet.sh` phase-for-phase so rehearsals exercise the same operator flow: preflight, contracts, mocks where applicable, CCIP lane / pool configuration, Diamond configure spell, handover, ABI sync, verification, and per-surface Cloudflare deploys. Testnet may additionally expose a `pause-rehearsal` phase; mainnet pause flows must remain standalone incident-response scripts, not ordinary deploy side effects.
- **Pre-Deploy Sanity Gate:** Every testnet and mainnet deployment should pass one consolidated pre-deploy sanity gate before any on-chain broadcast. The gate should cover successful build output, Diamond facet deployability, complete selector routing, deploy-shell sanity, absence of stale cross-chain migration leftovers, and ABI export freshness / completeness.
- **Deploy Integration Rehearsal:** The deploy-sanity suite should include an end-to-end Diamond deployment rehearsal that validates the deployed Diamond itself, not only static source lists. The rehearsal should prove that the deploy completes in both single-operator and handover-style authority modes, that every registered facet address is non-zero and deployed, that every live selector resolves to its intended facet, that the Diamond starts in the expected operational state, and that privileged roles are held only by the intended post-handover authority.
- **Pause Runbooks:** Production incident response should use a standalone `pause-all-chains.sh` or equivalent that prints Diamond and cross-chain-surface pause calldata for every deployed chain, records a timestamp for the five-minute response budget, supports state verification, and can print unpause calldata for cleanup. Mainnet unpause still routes through the Timelock-controlled unpauser path.
- **CCIP Authority Separation:** CCIP lane, token-pool, messenger, and adapter configuration should run under the documented owner for that surface, not the Diamond admin key by assumption. Handover scripts should read current on-chain authority first and skip with operator guidance when the signer does not own the target surface.
- **Cross-Chain Peer Wiring:** Cross-chain peer wiring must route each lane / pool / messenger update by the current on-chain owner of the source surface. During phased rehearsals this can mean some legs are direct admin-EOA broadcasts while other legs require Safe Transaction Builder batches. Runbooks should include decoded chain, peer, token-pool, and rate-limit review tables plus post-execute readback verification.
- **CCIP Security Model:** Mainnet cross-chain configuration should rely on CCIP's uniform security model rather than per-integrator verifier-policy selection. Deploy and verify phases should focus on lane allowlists, chain selector integrity, remote messenger peers, token-pool binding, and bounded rate limits.
- **Cross-Chain Guardian Coverage:** Every cross-chain contract with a runtime send or receive path should have the fast guardian pause surface wired during configuration. Pure rate-limit administration surfaces do not need that pause path when they have no runtime message flow of their own, but mirror-chain VPFI token contracts do because they participate directly in cross-chain token movement.
- **Buy-Adapter Rate Limits:** Mirror-chain fixed-rate buy adapters must have finite rate-limit caps before verification can pass. Canonical receiver deployments do not need the mirror adapter cap path, but every mirror lane should either set the caps during deployment or deliberately fail verification until configured.
- **Testnet Swap and Configure Parking:** Testnet phases that require Timelock governance batches, current external aggregator addresses, or real DEX liquidity may be deliberately parked when their rehearsal value is low. The parking decision should be explicit in runbooks, with mainnet cutover still required to source current addresses, deploy/register adapters, configure oracle and reward settings, and execute the Safe / Timelock schedule plus execute batches.
- **Peer Protocol Address Wiring:** Deploy and configure runbooks must set peer-protocol addresses per chain through `OracleAdminFacet.setPeerProtocolAddresses`, sourcing Aave V3, Compound V3, and future Morpho Blue addresses from official peer deployment registries. A zero address means the peer is unavailable on that chain and should be skipped by refresh logic. Peer-address provenance must be recorded before a chain is eligible for depth-tiered-LTV activation.
- **Tier-LTV Cache Refresh:** After peer addresses and reference asset lists are wired, operators or any community caller may call `OracleFacet.refreshTierLtvCache()`. Deployment should not require an admin-only LTV setter; fresh deployments use library fallback defaults until the permissionless cache refresh succeeds.
- **Slippage and Tier-LTV Census Workflow:** Before `depthTieredLtvEnabled` is flipped on a chain, operators should run the slippage census and pre-deploy tier-LTV census flows at three checkpoints: post-deploy, post-bake of the keeper liquidity-confidence relay, and immediately before the per-chain flip. CSV outputs, peer-address verification, and relay logs form the risk-committee / audit package. The census scripts are data generators only; they must not auto-broadcast the production flip.
- **V2 Factory Configuration:** Depth-tier route search has dormant V2-fork factory slots until each chain is explicitly configured. Operators should run the V2 factory configuration script per chain with canonical Uniswap / Sushi / Pancake-style factory addresses, or chain-specific overrides where the canonical registry differs, before relying on V2 routes in production depth classification.
- **Discounted-Liquidation Receiver Deployment:** Chains that use the flash-loan-funded discounted path must deploy `FlashLoanLiquidator` per chain with `KEEPER_BOT_OWNER` matching the keeper Worker signer and at least one configured Aave V3 Pool or Balancer V2 Vault. Deployment must write the receiver address into chain deployment artifacts and refresh the generated deployments bundle before keeper rollout.
- **Internal-Match Rollout:** Internal liquidation matching should default off after deployment. Operators must verify the default-off state, deploy and fund the keeper-bot path for the selected chain, enable the switch through the governed admin path only after audit sign-off, and monitor internal-match event volume plus matcher wallet balances before widening the priority window.
- **Per-Chain Flip Discipline:** `setDepthTieredLtvEnabled(true)`, `setDiscountPathEnabled(true)`, and internal-match enablement remain independent manual Timelock / Safe-governed rollouts per chain after audit sign-off. Operators may stage them separately. Emergency controls remain available through per-asset pause, master switch disable, discount-path disable, internal-match disable, keeper-side environment flag removal, and anomaly auto-pause.
- **Worker D1 Migrations:** Worker deployments should run idempotent D1 migrations as part of testnet and mainnet deploy flows so offer / loan / activity endpoints cannot fail because tables were not created. Already-applied migrations should be skipped by the migration tool rather than treated as errors. Fresh testnet redeploys should also clear rows scoped to the old active chain / Diamond before new indexing begins, including the case where the old deployment artifact was already moved into an archive folder.
- **RPC Secret Preflight:** Deployment scripts should check for the expected per-chain worker RPC secrets and hard-fail the watcher phase when any active chain's `RPC_<CHAIN>` secret is missing, printing the exact operator command to set it. Scripts must not auto-populate RPC secrets because those values may contain provider API keys, but they also must not silently complete a deploy while an active chain is invisible to the indexer.
- **ABI Export Phase:** Deploy scripts should export frontend, keeper-bot, and watcher ABIs after contract builds and before frontend / worker deployment so all consumer bundles decode the currently deployed contract surface.
- **Operations Export Phase:** Deploy scripts should export the subgraph event ABI / per-chain YAML, Tenderly alert YAML, and CCIP watcher secret snippets from the same deployment artifacts used by the apps. These exports prevent monitoring, indexing, and cross-chain watcher configuration from drifting away from the deployed Diamond, messenger, token-pool, and adapter addresses.
- **Tenderly Operations Setup:** Tenderly project configuration should live under `ops/tenderly/` with the account / project identifiers required for `tenderly actions deploy`. Contract tracking should not depend on unsupported bulk REST imports by address; contracts may auto-import from live traffic or be added individually through Tenderly's UI when first-traffic visibility is needed.
- **CCIP Watcher Scope:** The private CCIP watcher may remain mainnet-only until mainnet cutover. Testnet messenger, pool, or adapter addresses should not be stuffed into mainnet-shaped secrets because that produces misleading drift reports against the wrong chain ids and dashboards.
- **Active Chain Export Gate:** `contracts/deployments/.active-chains` or its successor should be the explicit source of truth for which deployment folders are exported into frontend / watcher metadata. Retired chain folders may remain on disk but should be skipped with operator-visible logs until re-added to the allow-list.
- **Frontend Build Runtime:** Deployment scripts that build the frontend must run under the Node major version required by the frontend toolchain and must propagate build failures as non-zero deploy failures. A successful contract deploy must not mask a failed Vite / Cloudflare frontend build.
- **CREATE2 Versioning:** Rehearsal and redeploy runbooks should treat CREATE2 salts / version strings as part of the deploy artifact. If a predicted CREATE2 address already has bytecode from a prior rehearsal, operators should bump the documented version salt and resume from the appropriate deploy phase rather than overwriting assumptions.
- **CREATE2 Idempotency:** CREATE2 deployment scripts should check both implementation and proxy predicted addresses before deployment and skip existing bytecode where the intended deterministic deployment already exists. Rehearsals should verify cross-chain reward component address parity across mirror chains when a shared salt is intended.
- **Indexer Cursor Seed Policy:** Fresh deploys should rely on the indexer's no-cursor fallback from `deployBlock - 1`; they should not automatically seed the worker cursor at safe head. A manual seed-at-safe-head helper may remain available only for an explicit operator choice to skip history.
- **Post-Deploy Watcher Verification:** Before announcing a deploy, operators should verify that the worker cursor advances within the expected round-robin cadence, D1 offer / loan row counts are present for every active chain, and D1 counts match on-chain event counts from direct log queries. A mismatch should send the operator to live Worker logs before user traffic relies on the cache.
- **RPC Estimate Staleness Mitigation:** Runbooks should document that load-balanced RPC providers can answer `eth_estimateGas` against a stale view immediately after a prior transaction lands. When broadcast failures show custom errors inconsistent with already-mined prerequisite transactions, operators should retry with the documented simulation mode that bypasses stale remote estimates rather than treating the symptom as a contract regression.
- **Chain-Agnostic Flow Sweeps:** Testnet validation should prefer chain-agnostic flow wrappers for positive, partial-midpoint, and negative sweeps once selectors are stable. Legacy chain-specific scripts may remain as building blocks, but the runbook should direct ordinary post-deploy sweeps through the wrappers.
- **Project Tracking Workflow:** Dated pending-task markdown files should not be the live tracker for actionable work. Release notes remain historical records, rough notes remain a temporary brain dump, and actionable work should be promoted to the GitHub project board as draft cards or issues.
- **Issue Hygiene:** New GitHub issues should use the shared label vocabulary and carry exactly one type label plus any applicable flag labels. Security disclosures should be routed through the private incident path rather than public blank issues. Both the main repository and keeper-bot repository should auto-add opened, reopened, or transferred issues to the shared project board.

## 15. NFT Verification Tool

### Purpose

A web-based tool, integrated as a dedicated page within the Vaipakam frontend, to allow anyone to track and validate the authenticity and status of NFTs minted by the Vaipakam platform (Vaipakam NFTs).

### Features

- **NFT Details Display:**
  - Input: Contract Address and Token ID of a Vaipakam NFT.
  - Output: Displays all associated on-chain metadata (e.g., offer ID, loan ID, involved assets, collateral details, interest rate/rental fee, duration, current status - "Offer Created," "Loan Active," "Repaid," "Defaulted," etc.).
  - Live metadata traits such as loan state, locked-in-vault amount, claimable-now amount, borrower VPFI rebate pending, and created-at timestamp should be surfaced when present and hidden gracefully for older metadata shapes.
- **Authenticity Validation:** Verifies if the NFT was indeed minted by the official VaipakamNFT contract.
- **Status Verification:** Shows the current, real-time status of the underlying offer or loan as recorded on the blockchain.

### Implementation

- **Smart Contract Interaction:** The tool will directly query the `VaipakamNFT.sol` contract's public view functions (like `tokenURI` and other specific getters for loan/offer data linked to an NFT) to fetch and display the on-chain data.

## 16. Regulatory Compliance Considerations

Vaipakam is committed to operating in a compliant manner within the evolving regulatory landscape for decentralized finance.

### Measures for Phase 1

- **Phase 1 KYC Pass-Through Flag:**
  - For Phase 1, all KYC-related protocol checks must pass through under an explicit Phase 1 flag or equivalent configuration path.
  - In effective Phase 1 behavior, KYC logic may remain present in the codebase for future-phase compatibility, but it must not block normal user flows such as offer creation, offer acceptance, loan initiation, repayment, preclose, refinance, or claims.
  - Any KYC helper, tier calculation, threshold check, or compliance-gating function that exists in Phase 1 should therefore behave as `allow` rather than `enforce` while the Phase 1 flag is active.
  - A later phase may activate real KYC enforcement through explicit configuration, governance, or admin control, but that must not be assumed during Phase 1.

- **KYC/AML Integration:**
  - The platform may later integrate with decentralized KYC/AML solutions (e.g., Civic, Verite, ComplyCube, KYC-Chain, or Trust Node by ComplyAdvantage).
  - **Tiered Approach:**
    - **Tier 0 (No KYC/AML):** For transactions where the principal loan amount (for ERC-20 loans using liquid assets valued through the Chainlink-led numeraire path) or total rental value (for NFT renting) is below the configured tier-0 threshold.
    - **Tier 1 (Limited KYC):** For transaction values between the configured tier-0 and tier-1 thresholds. This might involve basic identity verification.
    - **Tier 2 (Full KYC/AML):** For transaction values at or above the configured tier-1 threshold. This will require more comprehensive identity verification and AML checks.
  - **Valuation for KYC Thresholds:**
    - **ERC-20 Loans:** The active-numeraire value of the _principal amount being lent_ (if liquid) determines the transaction value. If the principal asset is illiquid, or if collateral is illiquid/NFT, these are considered zero for this specific calculation, relying on the value of the liquid component.
    - **NFT Renting:** The _total rental value_ (daily rate \* duration, converted through the same Chainlink-led numeraire path) determines the transaction value.
    - The platform stores KYC tier thresholds in active-numeraire units and compares them directly against active-numeraire asset values returned by `OracleFacet.getAssetPrice`.
- **Implementation Timing:** Real KYC/AML enforcement is not part of the effective Phase 1 launch behavior. Phase 1 keeps KYC checks in pass-through mode under the Phase 1 flag, while later governance or admin decisions may choose to activate the retained KYC framework.
- **Address-Level Sanctions Screening:** Where a supported on-chain sanctions oracle is configured for the active chain, the protocol should screen retail entry points as well as any future industrial deployment. Tier-1 actions that create fresh state for the caller, accept deposits, route new value, trigger protocol-funded broadcasts, or pay protocol incentives to the caller must revert for a flagged wallet. This includes vault creation, offer creation / acceptance, permissionless offer matching, VPFI buy / deposit / withdraw flows, user-initiated tier-poke broadcasts, liquidation initiation, loan-sale / obligation-transfer / refinance entry points, and claims by the flagged recipient.
- **Sanctions Wind-Down Carve-Out:** Debt-closing and safety paths required to protect an unflagged counterparty should remain available even when the target borrower is flagged. Repayment, time-based default, and HF-based liquidation against a flagged borrower are wind-down / recovery paths; they must not let the flagged actor receive fresh protocol value, but they should allow existing lender security interests to be made whole. If the lender or other recipient is flagged, their own claim path may still be blocked because the protocol would otherwise transfer value to a sanctioned wallet. Keeper housekeeping should also preserve liveness: when a sanctioned keeper would otherwise receive a VPFI reward, the reward should be skipped without reverting the housekeeping work.
- **Sanctions UX:** The frontend should surface sanctions messages only when the connected wallet or a relevant counterparty is flagged. Copy should clearly distinguish blocked actions, permitted close-out paths, and external recourse through the sanctions-data provider; clean wallets should not see general-purpose sanctions warnings on marketing or legal pages beyond the Terms prohibited-use clause.
- **Sanctions Oracle Availability:** Sanctions oracle configuration is per chain and optional. Chains without a configured oracle should behave as no-op for this check. Oracle read failures should fail open rather than bricking all protocol actions during a vendor outage.
- **Terms Acceptance Gate:** App routes may be gated behind a versioned on-chain Terms of Service acceptance. `currentTosVersion == 0` represents a disabled/testnet state. Once activated, users must accept the current Terms version and content hash before using `/app` routes; version bumps or hash changes invalidate prior acceptances.
- **Privacy Policy and Data Rights:** Public `/terms` and `/privacy` pages should be available without a wallet. Browser-local Vaipakam diagnostic and consent data should support user download and deletion flows through `/app/data-rights`, while clearly explaining that public blockchain data cannot be deleted by frontend action. The Privacy page should also describe the optional server-side diagnostics capture path, its redaction rules, retention period, legal basis, and deletion-request route. Server-side diagnostic error records should support wallet-signature authenticated erasure using a privacy-preserving wallet identity key rather than stored raw wallet addresses. Legal holds should be admin-gated, backed by a secured private document vault and append-only audit history, and should not alter the ordinary user's erasure response in a way that reveals whether a hold exists.
- **Ongoing Monitoring:** The platform will monitor regulatory developments during Phase 1. Governance proposals to update compliance measures are Phase 2 scope after governance is launched.

## Summary (Phase 1)

Vaipakam (Phase 1) is a decentralized P2P lending and borrowing platform supporting ERC-20 tokens and rentable NFTs on Base, Polygon, Arbitrum, Optimism, and Ethereum mainnet, with each network operating as its own independent Diamond deployment. It leverages unique NFTs for transparent offer and loan tracking. Key features include distinct handling of liquid vs. illiquid assets, platform-funded SMS/Email notifications, robust options for early loan closure and withdrawal, and the Phase 1 VPFI token deployment/minting foundation. The integrated NFT verification tool enhances transparency.

## Phase 1 Additions: Borrower Collateral Management & Refinancing

The following features are planned for Phase 1:

### Allow Borrower to Add Collateral

- **Purpose:** To allow borrowers with loans against liquid collateral to proactively add more collateral to reduce their LTV and avoid potential liquidation if the value of their existing collateral is declining.
- **Process:** Borrowers can deposit additional units of the same collateral asset type already securing their loan. The platform recalculates LTV.

### Allow Borrower to Withdraw Excess Collateral (Health Factor)

- **Purpose:** If a borrower's liquid collateral has significantly appreciated in value, or if they have over-collateralized initially, they may be able to withdraw some collateral.
- **Condition:** The withdrawal must not cause the loan's "Health Factor" to drop below a safe threshold (e.g., 150%).
  - Health Factor defined as: `(Value of Liquid Collateral in active numeraire) / (Value of Borrowed Amount in active numeraire)`
  - The minimum Health Factor (e.g., 150%) must be maintained post-withdrawal.
- **Process:** Borrower requests withdrawal of a specific amount of collateral. The system checks if the Health Factor remains above the threshold. If so, the excess collateral is released.
- **Collateral-protection invariant (binding across the whole platform):** Collateral that backs a live ERC-20 loan must NOT be withdrawable from the borrower's vault through ANY path other than a protocol flow that first accounts for the reduction. The only collateral a borrower can move out is their genuinely-free (un-pledged) balance. This applies uniformly — the risk-checked excess-withdrawal above, repayment, refinance, liquidation, default, swap-to-repay, and obligation transfer each reconcile the pledged amount; and unrelated exits (for example unstaking VPFI that is simultaneously pledged as ERC-20 collateral) must be refused down to the free balance. A borrower must never be able to leave a loan under-collateralized by routing pledged collateral out a side door.
- **VPFI as collateral:** VPFI is an eligible ERC-20 collateral asset (it is a liquid ERC-20; acceptance is at the lender's discretion, as with any collateral). Because VPFI also has a staking-unwind exit, that exit must observe the same collateral-protection invariant — the staked-but-pledged portion is not withdrawable until the loan's own lifecycle frees it.
- **NFT-rental prepayment is exempt and VPFI is disallowed for it:** The NFT-rental prepayment pool is intentionally not treated as withheld collateral — it is drawn down by the rental mechanism itself. To keep it safe without that accounting, the rental prepayment asset must be a plain ERC-20 with no separate unstake door; the platform's own VPFI token must NOT be accepted as an NFT-rental prepayment asset.

### Allow Borrower to Choose New Lender with Compatible Offer While Protecting the Original Lender (Refinance - ERC-20 Loans Only)

- **Purpose:** To enable a borrower to switch their existing loan to a new lender while preserving the original lender's expected economics and protection. The new lender's offer may still be attractive to the borrower (for example, lower interest rate or different collateral sizing), but the refinance path must not disadvantage the original lender.
- **Phase 1 Scope:** Refinance applies only to active ERC-20 loans. NFT rental loans and other non-ERC20 loan/rental positions are not eligible for refinance in Phase 1.
- **Borrower Position Authority:** The wallet that initiates refinance must be the current borrower and the current `ownerOf` the borrower-side Vaipakam NFT for that loan. A rented `userOf` address, approved keeper, or other third-party helper must not be sufficient to start a refinance flow unless a later protocol phase explicitly broadens that authority.
- **Atomic Refinance Clarification:** By the time the borrower calls `refinanceLoan(oldLoanId, borrowerOfferId)`, the replacement lender has already accepted the borrower's new borrower offer and the replacement loan already exists as a standalone live loan. The refinance transaction itself is then a single atomic settlement step that repays the old lender, releases the original collateral, updates the old-loan NFTs, and closes the old loan. Because there is no protocol waiting state between "refinance started" and "refinance completed," Phase 1 refinance does not require a borrower-side Vaipakam NFT transfer lock.
- **Tier-Aware Post-Rollover Gate:** When `depthTieredLtvEnabled` is off, refinance validation may continue to use the legacy Health Factor and max-LTV checks. When the switch is on, the replacement loan must satisfy the same tier-aware initiation cap used for new loans: `min(assetMaxLtvBps, effectiveTierMaxInitLtvBps(getAssetEffectiveLiquidityTier(collateral)))`, with a post-rollover Health Factor floor of at least `1.0`. Tier `0` / untierable collateral must not pass the tier-aware refinance path.
- **Frontend Warning:** Before signature, the refinance flow should tell the borrower that the old lender is repaid with principal plus full-term interest, not merely accrued-to-date interest. (Updated 2026-06-12 per [#411] / `RefinanceOldLenderOverpayFix.md`: the prior wording also required a rate-shortfall top-up; that addend has been DROPPED because full-term interest IS the lender's maximum entitlement on this loan and any additional shortfall over-compensates the exiting lender at borrower expense. The Original Lender Protection Rule below is structurally satisfied by full-term interest for an EXITING lender; the shortfall remains required only on the obligation-transfer / offset paths where the lender STAYS on the loan.)
- **Process:**
  1.  The borrower (Alice) has an existing active ERC-20 loan from Lender A. NFT rental loans and other non-ERC20 loan/rental positions must be rejected from this refinance flow.
  2.  Alice finds or creates a new "Borrower Offer" with her desired terms.
  3.  A new Lender (Lender B) accepts Alice's Borrower Offer, creating a new standalone live loan and placing the replacement principal in Alice's control before the refinance transaction is called.
  4.  Alice then calls `refinanceLoan(oldLoanId, borrowerOfferId)`. In that single transaction, the protocol uses the replacement-loan state that already exists to repay Alice's original loan to Lender A (principal + any full-term interest due to Lender A as per early repayment rules; any governance-approved alternative refinancing interest policy is Phase 2 scope), release Alice's original collateral, update the old-loan NFTs, and close the old loan.
  5.  The refinance offer must preserve the same principal/lending asset type, payment/prepay asset type, and collateral asset type as Alice's original loan. Amounts and economic terms may vary if permitted by the refinance rules, but the asset types themselves must not change.
  6.  Alice provides replacement collateral of the same collateral asset type as the original loan when she creates her refinance borrower offer; that newly posted collateral is what secures the new loan with Lender B. The original collateral held against Lender A's loan is released back to Alice (as a direct refund to her wallet) when the refinance executes, since only the new collateral backs the new position. The replacement amount may equal, exceed, or fall short of the original collateral as long as the new loan's LTV and Health Factor remain within the platform's risk thresholds.
  7.  The selected refinance offer must favor Lender A, the original lender, or else Alice must fund the difference needed to keep Lender A whole. In practice, the refinance must not reduce Lender A's protected principal recovery or expected lender-side economics versus the original agreed loan. If the new lender's terms would otherwise leave Lender A worse off, Alice must pay the shortfall or required top-up during the refinance transaction.
  8.  Vaipakam NFTs are updated: Loan with Lender A is closed. New loan with Lender B is initiated.

#### Original Lender Protection Rule for Refinance

- Refinance must not make the original lender economically worse off than the original agreed loan closure rules would allow.
- At minimum, the original lender must remain entitled to principal plus the interest amount owed under the protocol's refinance / early-repayment policy for the original loan.
- **(Updated 2026-06-12 per #411 / `RefinanceOldLenderOverpayFix.md`)** For an EXITING lender (the standard refinance path where `s.lenderClaims[oldLoanId]` is set and the old loan closes), full-term interest already satisfies this rule: full-term IS the maximum the lender could have earned on this loan, so paying `principal + full-term interest` makes them strictly whole at their ceiling. No additional rate-shortfall top-up is required (or paid) on refinance. The previous "borrower covers the shortfall" clause has been dropped here; it remains in force on the obligation-transfer / offset paths (`PrecloseFacet.transferObligationViaOffer`) where the lender STAYS on the loan and earns the new (possibly lower) rate going forward — there the shortfall genuinely bridges back up to the original full-term.
- The refinance path may improve the borrower's continuing terms with the new lender, but that improvement cannot be funded by taking value away from the original lender.

---

**Note on "Illiquid" Definition for LTV and KYC:**
For utmost clarity:

- Any NFT is considered illiquid with a $0 platform-assessed value for LTV and collateral valuation. For KYC, the _rental value in USDC_ is used for NFT renting.
- An ERC-20 token is illiquid for a given Phase 1 network deployment if the protocol cannot confirm both a valid active-network price path and a passing active-network slippage-at-floor liquidity route over the configured quote assets and V2 / V3 pool families. Liquidity must be judged only from the current network's own oracle and pool availability. If the current network fails that check, the asset remains illiquid on that network; Ethereum mainnet must not be queried as a verification fallback, must not be treated as a substitute source of liquidity, and must not trigger any mainnet-redirect requirement for that asset. Illiquid ERC-20s also have a $0 platform-assessed value for LTV. For KYC, if the _lent/borrowed asset itself_ is illiquid, it's $0, and KYC is based on other liquid components if any. If the collateral is illiquid, it doesn't add to the transaction value for KYC if the primary lent/borrowed asset is liquid.

## New features

- **Partial Lending and Borrowing:** Allowing users to accept offers with Partial lending amount, so that one offer may have more than one loan realated to it.
- **Flexible Interest:** Allowing lenders to earn flexible interest by using duration of the loan to 1 day and full filling the loan everyday at maximum interest rates in the list of available offers with same asset and collateral.

## Developement Approach

The Diamond Standard (EIP-2535) need to be followed for smart contract developement

- All facets must use the same `LibVaipakam.Storage` layout through the fixed diamond storage slot.
- Existing fields in the shared diamond storage layout must never be reordered or removed.
- New shared storage fields must only be appended at the end of the storage struct or other shared storage layouts.
- Proxy-style `__gap` arrays are not required inside the main diamond storage struct for this architecture; upgrade safety depends on disciplined append-only evolution of the shared diamond storage layout.
- Reentrancy protection in the diamond should use a shared guard state stored in common diamond storage rather than separate facet-local guard state.
- Cross-facet internal execution paths must be designed so intended `address(this)` / cross-facet calls do not fail due to false-positive reentrancy checks, while still preserving a single global reentrancy lock for true external-entry protection.

# Special Note

## Security Note:

- **Phase 1:** country-pair restrictions are **disabled at the protocol level** — any two users may transact regardless of the countries stored on their profiles. `LibVaipakam.canTradeBetween` always returns `true` in Phase 1. The `allowedTrades` many-to-many mapping and its governance setter `setTradeAllowance` are preserved so that pair-based sanctions can be re-activated in a Phase 2 upgrade without a storage migration.
  - The design rationale is retained here for future reactivation: a sanctions regime cannot be modeled as "country X is globally sanctioned"; it must be pairwise — for each (countryA, countryB) tuple, record whether trade is permitted between them. The existing many-to-many `allowedTrades` mapping supports this.
- No common vault account and only seperate Vault account for each users (via clone factory for gas efficiency) would implemented which will then be managed by Vaipakam App. This is to avoid commingling of funds.
- Existing user vaults should not be silently mass-upgraded by the protocol because that would create unnecessary network-fee overhead. Instead, when an vault upgrade is marked as mandatory, interactions using older vault versions must be blocked and the frontend must require the user to upgrade their own vault before continuing. If an upgrade is not critical, the frontend may leave the upgrade optional and simply prompt the user.
- Use Reentrancygaurd and pausable from Openzeppelin wherever needed.

## Other Notes:

- Keep governance, partial loan, flexible interest for later development (for phase 2) and complete other features first.
- Follow the coding standards, style conventions and develop code by following best practices approach and with proper nat comments
- Use Foundry for testing/fuzzing. Slither/Mythril for audits. Optimize: Batch claims, minimal storage.

## License

This project is intended to use the **Business Source License 1.1 (BUSL 1.1)** model with the following project-specific terms:

- **Licensor:** Vaipakam
- **Additional Use Grant:** Anyone can use the code for development, testing, and integration except if it is used to compete with this project or protocol.
- **Change Date:** 5 years after production deployment
- **Change License:** MIT

In other words, the code may be used for development, testing, and integration purposes under BUSL 1.1, but it must not be used to compete with the Vaipakam project or protocol before the Change Date. After the Change Date, the code converts to the MIT license.

---
