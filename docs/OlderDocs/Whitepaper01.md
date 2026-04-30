# Vaipakam Whitepaper 01

## Bilateral Lending, NFT Rental, and VPFI Utility Draft

### Expanded Draft for Technical Review

## Abstract

Vaipakam is a decentralized peer-to-peer protocol for chain-local ERC-20 lending, borrowing, and escrow-mediated NFT rentals across Ethereum-compatible networks. It is built around separate Diamond deployments per supported network, isolated per-user escrows, tokenized lender-side and borrower-side claim rights, active-network liquidity classification, structured abnormal-market fallback settlement, and a VPFI utility layer for fee discounts, escrow-based staking, and locally claimable rewards. Unlike pooled lending systems, Vaipakam preserves bilateral term-setting and individualized asset choice. Unlike NFT rental systems that depend entirely on collection-native rental support, Vaipakam uses escrow as the stable custody and user-rights surface. This document presents the design in a form suitable for technical discussion, audit preparation, and academic refinement.

## Keywords

Decentralized finance, peer-to-peer lending, NFT rental, Diamond Standard, escrow architecture, liquidation fallback, position NFTs, cross-chain utility token, on-chain risk management, chain-local credit.

## 1. Introduction

DeFi credit markets have largely favored pooled-liquidity architectures. These systems are capital efficient for deep and homogeneous markets, yet they inherently compress credit relationships into shared risk buckets. They are therefore less expressive when users want:

- custom rates
- chain-local asset choices
- bilateral lender-borrower negotiation
- non-standard collateral
- transferable claim rights
- rental-style NFT utility

Vaipakam takes a bilateral approach instead. Users post explicit offers, counterparties accept explicit terms, and the protocol enforces custody, liquidation, claims, and lifecycle transitions through a chain-local Diamond deployment.

The resulting system aims to combine:

- bilateral sovereignty over terms
- strong on-chain enforcement
- isolated custody through per-user escrow
- explicit lender-side and borrower-side rights through position NFTs
- liquidity-aware handling of collateral and defaults
- a utility-token layer that augments, rather than replaces, the core credit marketplace

## 2. Network and Token Model

### 2.1 Network Model

Protocol deployments target:

- `Base`
- `Polygon`
- `Arbitrum`
- `Optimism`
- `Ethereum mainnet`

Each network hosts its own Diamond instance. A loan opened on one chain remains entirely local to that chain for:

- offer creation and acceptance
- collateral posting
- repayment
- claim settlement
- preclose
- refinance
- early withdrawal
- liquidation
- keeper-enabled role actions

There is no cross-chain loan state machine.

### 2.2 Token Model

VPFI is the only protocol layer intended to be cross-chain. It is used for:

- borrower-side and lender-side fee discounts
- escrow-based staking rewards
- platform interaction rewards
- token transparency and treasury recycling


## 3. Core Design Goals

Vaipakam is designed to:

1. preserve bilateral negotiation instead of pooled credit abstraction
2. support both fungible lending and escrow-mediated NFT rentals
3. isolate user custody through dedicated escrow
4. distinguish liquid assets from illiquid assets using active-network checks only
5. keep claim rights explicit, transferable, and NFT-bound
6. treat frontend risk disclosure as part of protocol safety
7. give VPFI real operational utility without making it mandatory for ordinary credit usage

## 4. Architecture

### 4.1 Diamond Standard

Vaipakam uses `EIP-2535` Diamond architecture.

Implications:

- one protocol address per chain
- shared append-only storage layout
- facet-based separation of concerns
- modular growth without redeploying all protocol state

The Diamond model is especially useful here because Vaipakam’s lifecycle spans offers, loans, claims, treasury accounting, NFT rights, keeper controls, token utility, and analytics views.

### 4.2 Per-User Escrow

Per-user escrow is central to the protocol’s safety model.

Escrow responsibilities include:

- holding ERC-20 collateral
- holding NFT collateral
- holding rented NFTs in custody during rental periods
- holding prepaid rental funds plus the rental buffer
- holding VPFI balances that function as fee-discount balance and staked balance

This architecture prevents commingling of unrelated users’ assets and creates a clean surface for custody-sensitive flows.

### 4.3 Position NFTs

The protocol tokenizes role-specific position rights.

- lender-side NFTs govern lender claim authority
- borrower-side NFTs govern borrower claim authority

These NFTs are not decorative metadata wrappers. They function as the authoritative on-chain marker of who currently controls the economic rights for that side of the position.

## 5. Product Surface

### 5.1 ERC-20 Lending and Borrowing

ERC-20 lending allows:

- lender-created offers
- borrower-created offers
- ERC-20 principal
- ERC-20, ERC-721, or ERC-1155 collateral
- explicit duration and APR selection

For ERC-20 borrowing, the baseline initiation path charges a `0.1%` `Loan Initiation Fee` in the lending asset, unless the borrower qualifies for the VPFI fee-discount path.

### 5.2 NFT Rentals

NFT renting is modeled as escrow-controlled temporary usage rather than custody transfer.

The lender:

- escrows the NFT

The borrower:

- prepays the rental value in ERC-20
- posts a `5%` buffer
- receives temporary usage rights

The NFT itself remains inside escrow. That design is why Vaipakam does not require separate NFT collateral for the rental product.

## 6. Asset Classification and Risk

### 6.1 Liquid Assets

An ERC-20 is liquid on a chain only if the current active network can verify:

- a usable price path
- sufficient executable v3-style concentrated-liquidity AMM `asset/WETH` liquidity

The protocol must not use Ethereum mainnet as a substitute reference when assessing liquidity on another chain.

### 6.2 Illiquid Assets

Illiquid assets include:

- all ERC-721 assets
- all ERC-1155 assets
- ERC-20 assets that fail active-network priceability or liquidity checks

These assets receive no protocol-assessed value for LTV purposes.

### 6.3 Health Factor and LTV

For liquid collateral, Vaipakam uses standard risk indicators such as:

- LTV
- Health Factor

Those values matter for liquidation and collateral-management decisions. For illiquid assets, the protocol instead relies on the documented in-kind settlement rules rather than pretending to maintain robust oracle-based liquidation math.

## 7. Offer Creation and Acceptance

Offers in Vaipakam are on-chain intent objects, not informal order-book hints.

They can specify:

- lending asset
- collateral or prepay asset
- amount
- duration
- APR or rental fee
- asset-type details
- creator fallback consent

When an offer is accepted:

- the acceptor contributes their required assets or approvals
- the acceptor must provide the same mandatory combined fallback consent
- escrow transitions occur
- the loan becomes active
- position NFTs are minted or updated accordingly

## 8. Combined Risk Consent

One of Vaipakam’s most important design choices is that create-offer and accept-offer flows require a single combined mandatory acknowledgement covering:

- abnormal-market liquidation fallback for liquid assets
- full-collateral-in-kind default treatment for loans with illiquid assets

The rationale is straightforward:

- liquid collateral cannot always be sold safely in stressed markets
- illiquid assets cannot be treated as if normal DEX liquidation were available
- users must explicitly agree to these paths before capital is committed

The resulting loan may store only the combined accepted-by-both-parties state, because neither side may proceed without consent.

## 9. Repayment and Claims

### 9.1 Repayment

Repayment may be performed by the borrower or by a permitted third party. However, repayment does not automatically entitle the payer to collateral. Claim rights continue to follow the borrower-side position NFT.

### 9.2 Claims

Claims are role-specific:

- lender claims for principal, yield, rental value, or default-side recovery
- borrower claims for collateral return or residual value where applicable

Crucially, claim authority follows the current holder of the relevant Vaipakam NFT rather than the original wallet that opened the position.

## 10. Preclose, Refinance, and Early Withdrawal

Vaipakam includes several lifecycle flows beyond passive maturity.

### 10.1 Borrower Preclose

Borrowers may close positions early through supported early-settlement pathways, including offset-style flows where compatible offers are used to neutralize obligations.

### 10.2 Refinance

Refinance is available for active ERC-20 loans. The replacement loan is established before the atomic refinance settlement completes, ensuring that the original lender is protected during the transition.

### 10.3 Lender Early Withdrawal

Lenders may seek early exit through sale-based flows. These are distinct from simply transferring the lender NFT in that the protocol supports dedicated settlement pathways for live-position exits.

## 11. Liquidation and Default

### 11.1 Permissionless Liquidation

For liquid collateral, liquidation is permissionless once protocol conditions are met. This is a protocol-safety action and must remain executable by any address.

Normal successful liquidation follows a bounded execution model:

- total liquidation friction target of `6%`
- liquidator incentive derived from realized slippage
- incentive capped at `3%`
- treasury liquidation-handling charge of `2%`

### 11.2 Abnormal-Market Fallback

When liquidation cannot execute safely, Vaipakam does not force a bad swap. Instead it uses collateral-unit settlement.

Fallback logic, in substance:

- the lender claims collateral in collateral-asset form
- if collateral value is below the amount due, the lender receives the full remaining collateral
- if collateral value is above the amount due, the lender receives only the equivalent collateral amount
- the remainder stays attributable to the borrower after applicable charges

This is a central risk rule, not an edge-case afterthought.

### 11.3 Illiquid-Asset Default

For loans with illiquid assets, the lender takes the collateral in-kind on default. Vaipakam does not pretend there is a reliable liquidation market for these positions.

## 12. VPFI Utility

VPFI is the operational utility token.

### 12.1 Token Parameters

- symbol: `VPFI`
- hard cap: `230,000,000`
- initial mint: `23,000,000`
- canonical issuance chain: canonical `Base` environment

### 12.2 Fee Utility

VPFI is used to discount:

- the `Yield Fee` for lenders
- the `Loan Initiation Fee` for borrowers

Discounts are determined from escrowed VPFI on the relevant lending chain.

### 12.3 Tier Model

Current tiers:

| Tier | Escrowed VPFI on that chain | Discount |
| --- | ---: | ---: |
| 1 | `>= 100` and `< 1,000` | `10%` |
| 2 | `>= 1,000` and `< 5,000` | `15%` |
| 3 | `>= 5,000` and `<= 20,000` | `20%` |
| 4 | `> 20,000` | `24%` |

Core rules:

- balances are chain-local
- tiers are chain-local
- escrowed VPFI on one chain counts only for loans initiated on that same chain
- one shared platform-level consent controls whether escrowed VPFI may be used for fee discounts

### 12.4 Fixed-Rate Purchase Program

Vaipakam includes an early access purchase program:

- fixed rate: `1 VPFI = 0.001 ETH`
- allocation cap: `2,300,000 VPFI`
- user limit: `30,000 VPFI` per wallet per chain unless reconfigured

The intended user-facing flow is:

1. buy from the preferred supported chain
2. receive VPFI in wallet on that same chain
3. explicitly deposit into personal escrow

The page should abstract away any canonical-chain routing or bridge plumbing required behind the scenes.

## 13. Escrow-Based Staking and Rewards

### 13.1 Staking Rewards

Any VPFI held in user escrow is treated as staked on that chain.

- staking APR: `5%`
- no separate staking vault required
- rewards are claimed through a pull model on the current chain

### 13.2 Platform Interaction Rewards

Vaipakam also includes interaction rewards.

Important properties:

- rewards are computed from daily interest activity
- the first reward day is excluded
- rewards are earned daily but remain locked until the relevant loan closes
- borrower-side rewards unlock only after repayment closes the loan
- lender-side rewards also unlock only after loan closure

### 13.3 Cross-Chain Accounting, Local User Experience

Although loans are chain-local, the interaction reward denominator is protocol-wide. Vaipakam resolves this by:

- reporting local daily interest totals to a canonical aggregation path
- finalizing one protocol-wide denominator
- broadcasting finalized denominator values back to each lending chain
- allowing users to claim on their own lending chain once the denominator is known and the loan-close gate has been satisfied

Thus, the accounting is globally coherent while the user claim flow remains locally executable.

## 14. Frontend and User Experience as Protocol Surface

This whitepaper documents not just contract behavior, but also expected product surfaces.

### 14.1 Public Website

The public website should expose:

- protocol education
- FAQ
- public analytics dashboard
- public `Buy VPFI`
- non-custodial / no-KYC disclaimer

### 14.2 Connected App

The connected app should expose:

- dashboard
- offer book
- create-offer
- loan details
- claim center
- rewards page
- activity page
- NFT verifier
- advanced keeper settings

### 14.3 Dashboard and Analytics

The analytics dashboard is a public transparency surface:

- combined all-chain headline metrics at the top
- chain-specific detailed sections below
- visible chain selector for the lower analytics sections
- no wallet required for reading
- no PII or KYC data shown

### 14.4 Rewards and Activity

Vaipakam also includes dedicated user surfaces for:

- reward claiming
- unstaking
- session-local activity review
- chain-aware VPFI discount visibility
- explorer-linked transaction outcomes

## 15. Security and Role Model

### 15.1 Reentrancy and Pausability

Vaipakam relies on:

- global diamond-storage reentrancy protection
- pausability for emergency response
- role-gated administrative changes

### 15.2 Keeper Model

The protocol distinguishes between:

- permissionless safety actions such as liquidation
- party-only actions
- advanced keeper-enabled deterministic actions

This keeps automation possible without turning all position control into unrestricted third-party execution.

## 16. Compliance Posture

Vaipakam is intentionally non-restrictive in live operation.

- no effective KYC gating in ordinary flows
- no active country-pair restrictions at the protocol level
- no KYC requirement for website or app usage
- users are responsible for their own regulatory compliance

The codebase may retain compliance scaffolding, but the effective behavior is pass-through rather than restrictive enforcement.

## 17. Limitations and Tradeoffs

Vaipakam’s design makes several explicit tradeoffs.

### 17.1 Compared With Pooled Lending

Advantages:

- custom bilateral terms
- support for non-standard assets
- transferable role-specific claims
- clearer handling of illiquid collateral

Tradeoffs:

- higher product complexity
- more lifecycle branches
- less pooled-liquidity simplicity
- heavier dependence on explicit user comprehension and frontend review

### 17.2 Illiquid Assets

By refusing to assign optimistic protocol value to illiquid assets, the protocol is safer but also harsher. Users must understand that such assets can lead to in-kind transfer rather than market liquidation.

### 17.3 Chain-Local Positions

Vaipakam chooses clear chain-local loan logic over a more ambitious cross-chain loan state machine. This improves determinism and auditability at the cost of less cross-chain composability.

## 18. Conclusion

Vaipakam is best understood as a bilateral credit and rental marketplace rather than a pool-based money market. Its essential design choices are:

- explicit bilateral offers
- per-user isolated escrow
- NFT-bound claim rights
- active-network liquidity classification
- permissionless liquidation with structured abnormal-market fallback
- chain-local loan state
- cross-chain VPFI utility without cross-chain loan complexity

These choices create a product that is more expressive than conventional pooled DeFi lending while remaining disciplined about liquidation assumptions, collateral treatment, and user-visible risk disclosure.

## References

1. Vaipakam `README.md`
2. `docs/TokenomicsTechSpec.md`
3. `docs/WebsiteReadme.md`
4. `EIP-2535`
5. `ERC-20`
6. `ERC-721`
7. `ERC-1155`
8. `ERC-4907`
9. Chainlink documentation
10. v3-style concentrated-liquidity AMM documentation
