# Vaipakam: Technical Whitepaper

**Version:** `2.0`

## Abstract

Vaipakam is a decentralized peer-to-peer protocol for overcollateralized ERC-20 lending, borrowing, and escrow-mediated NFT rentals across Ethereum-compatible networks. It is built around separate Diamond deployments on `Ethereum mainnet`, `Base`, `Polygon`, `Arbitrum` and `Optimism` with each loan, offer, collateral position, repayment, claim, refinance, and liquidation remaining local to a single chain. The protocol combines bilateral offer negotiation, per-user escrow isolation, tokenized lender and borrower position rights, strict liquidity-aware risk logic, and an integrated VPFI utility layer for fee discounts, escrow-based staking, and locally claimable rewards. This whitepaper describes the architecture, lifecycle flows, liquidation and fallback rules, VPFI token utility, frontend safety model, and compliance posture.

## 1. Introduction

Most large DeFi credit systems optimize for pooled liquidity, standardized assets, and uniform market parameters. That approach is efficient for deep, fungible markets, but it is poorly suited to negotiated bilateral credit, long-tail collateral, and NFT utility flows. Vaipakam takes a different path: it keeps lending bilateral, makes rights explicit through position NFTs, and treats the frontend as part of the protocol’s safety layer rather than as a thin wrapper over contracts.

Vaipakam focuses on:

- bilateral ERC-20 lending and borrowing
- escrow-mediated ERC-721 and ERC-1155 rentals
- per-user isolated escrow accounts
- liquidity-aware asset classification
- permissionless liquidation for liquid collateral
- structured fallback settlement when liquidation cannot execute safely
- VPFI-based fee discounts, escrow staking, and reward claiming
- public transparency surfaces such as analytics, NFT verification, claims, rewards, and activity tracking

The protocol is non-custodial. Users negotiate terms directly through on-chain offers, while Vaipakam enforces custody, repayment, default, liquidation, and claim rights through smart contracts.

## 2. System Model

Vaipakam should be understood as a chain-local credit marketplace with a cross-chain utility token.

### 2.1 Chain Model

- Vaipakam core protocol state is deployed as a separate Diamond on each supported chain.
- Loans, offers, collateral, repayments, liquidations, claims, preclose flows, refinance flows, and keeper actions are local to the chain where the position originated.
- There is no cross-chain loan state machine.
- VPFI is the only protocol component intended to be cross-chain.

### 2.2 Core Features

Vaipakam includes:

- ERC-20 lending and borrowing
- NFT renting using escrow-controlled custody plus ERC-4907-style user-right assignment
- lender-side and borrower-side position NFTs
- borrower preclose, lender early withdrawal, refinance, claim center, NFT verifier, public analytics, rewards, and in-app activity
- VPFI fixed-rate purchase, escrow deposit, fee discounts, staking rewards, and interaction rewards

## 3. System Architecture

### 3.1 Diamond-Based Core

Vaipakam uses the Diamond Standard (`EIP-2535`). Shared protocol state lives in a common storage layout, while business logic is partitioned into facets such as offer creation, loan initiation, repayment, claims, liquidation, treasury accounting, VPFI utility, and analytics-oriented views.

This architecture supports:

- modular protocol composition
- append-only storage evolution
- isolated feature development without state migration
- a single protocol address per chain for user-facing integration

### 3.2 Per-User Escrow

Every user interacts through a dedicated escrow account rather than a pooled treasury-style vault.

Escrow design goals:

- no commingling of user funds
- clear custody boundaries
- support for ERC-20 collateral and prepayment assets
- support for escrow-controlled NFT rentals
- support for non-collateral VPFI balances used for fee utility and staking

Escrow upgrades are not intended to be silently forced in bulk. If a mandatory upgrade is introduced, user interactions should block until the user upgrades their own escrow.

### 3.3 Position NFTs

Vaipakam mints position NFTs to represent active protocol rights.

- the lender-side NFT governs lender claim rights
- the borrower-side NFT governs borrower claim rights
- rights follow the current NFT holder, not necessarily the original initiating wallet

This allows secondary transfer of economic positions without rewriting the underlying loan.

## 4. Supported Assets and Product Types

### 4.1 ERC-20 Lending

In an ERC-20 loan:

- the lender provides fungible principal
- the borrower provides collateral
- collateral may be ERC-20, ERC-721, or ERC-1155
- principal, collateral, duration, rate, liquidity classification, and claim rights are recorded on-chain

Borrower-side ERC-20 loan initiation also carries a protocol `Loan Initiation Fee`, with a discounted VPFI path available when eligible.

### 4.2 NFT Rentals

In a rental flow:

- the lender escrows the NFT
- the borrower prepays the rental obligation in ERC-20
- the borrower also posts a `5%` buffer above prepaid rental value
- the borrower receives temporary usage rights, not custody
- the escrow remains the owner / control surface for the rented NFT

Vaipakam does not require separate NFT collateral for NFT rentals because custody remains escrow-controlled throughout the rental lifecycle.

### 4.3 ERC-1155 Rental Read Semantics

For ERC-1155 integrations, the escrow is the intended rental-state read surface. Third-party apps should be able to query:

- active rented quantity for a given `(contract, tokenId)` in that escrow
- the minimum active expiry among those rented units

This conservative model prevents external integrations from overstating duration or usability.

## 5. Liquidity Classification and Risk Model

### 5.1 Liquid vs. Illiquid Assets

Vaipakam treats an ERC-20 as liquid only if the **active chain** can validate both:

- a usable on-chain pricing path, preferably direct `asset/USD`, or otherwise `asset/ETH × ETH/USD`
- sufficiently deep Uniswap v3 `asset/WETH` liquidity on that same chain

Key rule:

- Ethereum mainnet must not be used as a fallback reference when classifying liquidity for another chain

If the active chain cannot validate both priceability and executable liquidity, the asset is treated as illiquid on that chain.

### 5.2 Illiquid Assets

Vaipakam treats the following as illiquid for protocol valuation and liquidation purposes:

- all ERC-721 assets
- all ERC-1155 assets
- ERC-20s that fail active-chain oracle or liquidity requirements

For LTV and collateral-value purposes, illiquid assets are effectively treated as having protocol-assessed value of `$0`.

### 5.3 Health Factor and LTV

For liquid collateral, Vaipakam exposes:

- Loan-to-Value (`LTV`)
- Health Factor (`HF`)

These metrics drive liquidation eligibility and collateral-management flows. For illiquid assets, those metrics should not be treated as meaningful in the same way, because the protocol does not assign auction-style or oracle-style value to those assets for safety.

## 6. Offer Creation and Loan Initiation

Vaipakam supports both lender-created and borrower-created offers.

An offer can define:

- lending asset or rentable NFT
- collateral or prepay asset
- amount
- duration
- interest rate or rental fee
- asset-type details
- the creator’s mandatory combined fallback consent

When an offer is accepted:

- counterparties are resolved
- the acceptor must also provide the same mandatory combined fallback consent
- assets are escrowed or rights are assigned
- the loan is initialized
- position NFTs are updated or minted

### 6.1 Combined Mandatory Risk Consent

Before create-offer and accept-offer flows proceed, the frontend must require one combined risk acknowledgement covering:

- abnormal-market fallback for normally liquid collateral
- full-collateral-in-kind default path for loans with illiquid assets

The consent is mandatory for both sides and is captured for the offer and resulting loan. It is acceptable for the loan to store only the combined accepted-by-both-parties state.

## 7. Repayment, Claims, Preclose, Refinance, and Early Withdrawal

Vaipakam supports more than simple lend-and-wait flows.

### 7.1 Repayment and Claims

- repayment may be initiated by the borrower or by a permitted third party
- repayment does not transfer collateral rights to the payer
- lender and borrower claims remain tied to the corresponding position NFT
- claim authority follows the current NFT holder

### 7.2 Borrower Preclose

Vaipakam supports borrower-side early closure patterns, including direct repayment and offset-style paths where compatible offers are used to neutralize the borrower’s live position.

### 7.3 Refinance

Refinance is supported for active ERC-20 loans only. The replacement loan already exists by the time refinance executes; the refinance transaction itself is the atomic settlement step that protects the original lender while closing the original loan.

### 7.4 Lender Early Withdrawal

Lender exit is supported through sale-based pathways and passive wait-to-maturity fallback for ERC-20 loans. Claim rights continue to follow the lender-side NFT.

## 8. Liquidation and Fallback Settlement

### 8.1 Permissionless Liquidation

When a liquid-collateral loan crosses its risk threshold, liquidation is permissionless. Any address may trigger it; liquidation is treated as a protocol-safety function rather than an opt-in privileged action.

Normal successful liquidations follow a bounded execution model:

- `slippage + liquidator incentive = 6%`
- liquidator incentive is capped at `3%`
- treasury also receives a separate `2%` liquidation-handling charge

### 8.2 Abnormal-Market Fallback

If liquidation cannot execute safely, for example because slippage exceeds `6%`, liquidity disappears, or the swap fails, Vaipakam does **not** force a bad market sale.

Instead, Vaipakam follows the abnormal-market fallback path:

- the lender claims collateral in collateral-asset form rather than receiving the lending asset
- if collateral value is below the amount due, the lender receives the full remaining collateral
- if collateral value is above the amount due, the lender receives only the equivalent collateral amount
- the borrower remains entitled to any residual collateral value after charges
- treasury becomes entitled to the documented fallback-side charge

This path is intentionally explicit so users understand that liquidation risk is not always equivalent to “collateral will be sold cleanly into the borrowed asset.”

### 8.3 Illiquid-Asset Default Path

For loans with illiquid assets on either the lending side or collateral side, the protocol does not rely on normal DEX liquidation. On default, the lender takes the collateral in-kind under the documented full-collateral-transfer path.

## 9. VPFI Utility

VPFI is the protocol utility-token layer. It does not replace the bilateral lending model; it augments it.

### 9.1 Core Parameters

- token name: `Vaipakam Finance Token`
- symbol: `VPFI`
- hard cap: `230,000,000`
- initial mint: `23,000,000`
- canonical issuance chain: canonical `Base` environment for the active deployment context

### 9.2 Fee Utility

Protocol fees include:

- `1%` Yield Fee on lender yield / rental-fee earnings
- `0.1%` Loan Initiation Fee on ERC-20 borrowing when paid in the lending asset

Both lender and borrower may receive discounted fee treatment when:

- they hold sufficient VPFI in escrow on the relevant lending chain
- their platform-level VPFI discount consent is enabled
- the fee path is otherwise eligible under the documented protocol rules

### 9.3 Tiered Discount Model

Current VPFI tiers are:

| Tier | Escrowed VPFI on that chain | Discount |
| ---- | --------------------------: | -------: |
| 1    |      `>= 100` and `< 1,000` |    `10%` |
| 2    |    `>= 1,000` and `< 5,000` |    `15%` |
| 3    |  `>= 5,000` and `<= 20,000` |    `20%` |
| 4    |                  `> 20,000` |    `24%` |

Important constraints:

- tiers are chain-local
- escrowed / staked VPFI on one chain counts only for loans initiated on that same chain
- the user manages one platform-level consent in `Dashboard`; there is no separate per-offer or per-loan VPFI discount toggle

### 9.4 Buy VPFI Flow

Vaipakam includes a fixed-rate early purchase program:

- `1 VPFI = 0.001 ETH`
- global allocation cap: `2,300,000 VPFI`
- user cap: `30,000 VPFI` per wallet **per chain** unless reconfigured by admin

User-facing flow:

1. the user buys from their preferred supported chain
2. purchased VPFI lands in the user’s wallet on that same chain
3. the user explicitly deposits VPFI from wallet into personal escrow

The page must not require a manual switch to the canonical chain. Any canonical-chain or bridge complexity is abstracted away from the user-facing purchase flow.

## 10. Escrow-Based Staking and Rewards

### 10.1 Staking Rewards

Any VPFI held in user escrow on a lending chain is treated as staked.

- staking APR: `5%`
- reward model: pull-based
- claim path: local to the user’s current lending chain

Unstaking is modeled as moving VPFI out of escrow back to the wallet on that same chain.

### 10.2 Platform Interaction Rewards

The tokenomics model also allocates VPFI for platform interaction rewards.

Key properties:

- rewards are calculated from daily lender-interest-earned and borrower-interest-paid activity
- the first reward day (`day 0`) is excluded
- rewards are computed daily but claimability is gated by loan closure
- borrower rewards unlock only after repayment closes the loan
- lender rewards also unlock only after the loan is closed
- claims are local to the lending chain once the denominator for that day has been finalized and broadcast

### 10.3 Cross-Chain Denominator, Local Claims

Loans remain chain-local, but the interaction reward denominator is protocol-wide. Vaipakam handles this by:

- aggregating daily chain totals to the canonical reward chain
- finalizing a global denominator there
- broadcasting the finalized denominator back to mirror chains
- allowing users to claim locally on their own lending chain after finalization and loan closure

This preserves one protocol-wide reward curve without forcing users to bridge or change chains during the claim flow itself.

## 11. Frontend as a Safety Layer

The website and connected app are critical parts of protocol usability and risk communication.

### 11.1 Public Website

The public surface should include:

- homepage education
- public `Buy VPFI`
- public analytics dashboard
- FAQs
- clear risk and non-custodial messaging

### 11.2 Connected App

The connected app should include:

- dashboard
- offer book
- create-offer flow
- loan details
- claim center
- rewards page
- activity page
- NFT verifier
- advanced keeper settings

### 11.3 Public Analytics

The public analytics dashboard is a no-wallet-required transparency surface built from on-chain contract state and event logs.

- the top row provides combined all-chain headline totals
- lower sections are chain-specific
- a visible chain selector switches the detailed analytics sections
- no personal user data or KYC data appears on this dashboard

### 11.4 Activity and Review Surfaces

The product surface also includes:

- an in-app `Activity` page for recent session-local protocol actions
- transaction review surfaces for risky flows
- dedicated warnings before create-offer and accept-offer submission
- chain-aware VPFI discount visibility
- reward claim and unstake confirmations

## 12. Security and Compliance Posture

### 12.1 Security Principles

Protocol security relies on:

- isolated per-user escrow
- global diamond-level reentrancy protection
- pausable emergency controls
- explicit role-gated admin actions
- append-only shared storage discipline
- chain-local liquidity checks

### 12.2 Keeper Model

Liquidation remains permissionless. Broader keeper execution is treated as an advanced, scoped, role-specific capability rather than a blanket “bots allowed” model.

### 12.3 Compliance Posture

The compliance posture is intentionally lightweight:

- no effective KYC blocking in normal operation
- no country-pair restrictions at the protocol level
- no KYC requirement for website or app access
- users remain responsible for their own regulatory compliance

The codebase may retain KYC and sanctions scaffolding, but it is not intended to block normal user flows.

## 13. Conclusion

Vaipakam is a bilateral, chain-local credit and rental protocol with explicit rights, isolated escrow, and a utility layer built around VPFI. Its defining properties are not pooled capital efficiency or abstract credit aggregation, but negotiated terms, transparent state transitions, strict liquidity-aware handling of collateral, and clear user-facing risk consent. ERC-20 loans, NFT rentals, tokenized claim rights, fixed-rate VPFI access, escrow-based staking, locally claimable rewards, and public analytics together form the complete product surface.

## References

1. `EIP-2535` Diamond Standard
2. `ERC-20`, `ERC-721`, `ERC-1155`, and `ERC-4907` standards
3. Chainlink price feeds
4. Uniswap v3 liquidity model
5. Vaipakam `README.md`
6. `docs/BorrowerVPFIDiscountMechanism.md`
7. `docs/TokenomicsTechSpec.md`
8. `docs/WebsiteReadme.md`
