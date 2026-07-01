# Vaipakam DeFi Whitepaper

**Date:** July 2026
**Status:** Production-oriented protocol design; current live protocol deployments are testnet and local only pending third-party audit and mainnet launch approval.

---

## Abstract

Vaipakam is a decentralized peer-to-peer lending, borrowing, NFT rental, and collateral-management protocol for Ethereum-compatible networks. The protocol lets users negotiate bilateral terms, lock assets through isolated Vaipakam Vaults, represent lender and borrower rights with Vaipakam position NFTs, claim proceeds through wallet-controlled transactions, and inspect public protocol state without relying on a private account system.

The connected app at defi.vaipakam.com is the user-facing transaction surface. The public site at vaipakam.com provides education, documentation, and this canonical whitepaper. Vaipakam is non-custodial at the user-action layer: users submit transactions through their own wallets, and claim authority follows the current holder of the relevant Vaipakam position NFT.

This document describes the product and protocol behavior currently represented by the repository and connected-app surfaces. It avoids roadmap language and limits itself to product surfaces that are represented in the current repository and connected-app experience.

---

## 1. Overview

Vaipakam is built around negotiated credit rather than pooled credit. Lenders and borrowers create offers with explicit terms, counterparties accept compatible offers, and loans progress through repayment, default, liquidation, or claimable terminal states according to protocol rules.

The core commitments are:

- Bilateral terms: users define asset pairs, amounts, rates, duration, collateral, and relevant risk acknowledgements.
- Wallet-controlled execution: every user action is submitted through the connected wallet or an explicitly authorized flow.
- Isolated vault accounting: user assets and protocol-tracked balances are accounted through each user's Vaipakam Vault rather than a shared user pool.
- Tokenized rights: lender and borrower rights are represented by Vaipakam position NFTs, and claim authority follows current NFT ownership.
- Active-network risk checks: liquidity and oracle assumptions are evaluated against the selected network, not borrowed from another network.
- Explicit risk communication: offer creation, offer acceptance, liquidation, claims, VPFI utility, vault accounting, sanctions state, and data-rights surfaces are visible to users.

---

## 2. Product Surfaces

The connected app currently exposes the following user surfaces:

- Dashboard for wallet-owned loans, offers, claim shortcuts, VPFI status, fee-discount consent, and auto-lifecycle settings where available.
- Offer Book for browsing lender and borrower offers, filtering market inventory, reviewing active user offers, and accepting valid offers.
- Create Offer for lender offers, borrower offers, ERC-20 collateral, NFT collateral, NFT rental terms, duration buckets, interest-mode choices, periodic-interest settings where supported, and risk acknowledgement.
- Loan Details for repayment, collateral additions, health-factor and LTV views where applicable, liquidation visibility, lifecycle timelines, keeper controls, prepayment listings, swap-to-repay surfaces, and position-specific actions.
- Claim Center for lender claims, borrower claims, VPFI interaction rewards, loan-linked claim rows, and claim transaction feedback.
- VPFI Vault for depositing and withdrawing free VPFI, viewing protocol-tracked VPFI balances, fee-discount tier status, and token transparency.
- Your Vaipakam Vault for protocol-tracked balances, locked versus free asset state, and vault-level inspection.
- Risk Access for user-controlled vault risk tiers and strict-mode controls where the active deployment exposes them.
- Alerts for loan and health-factor notification preferences where enabled.
- Allowances for reviewing token approvals relevant to app actions.
- Keeper Settings for advanced delegated-execution controls.
- Activity for wallet-specific protocol history.
- Data Rights for browser-storage export and deletion tools.
- Public Analytics for no-wallet aggregated protocol data.
- NFT Verifier for public inspection of Vaipakam position NFTs.
- Protocol Console for public and admin-facing protocol configuration visibility where the active wallet has the required authority.

---

## 3. Network Model

Vaipakam is structured as separate protocol deployments per network. Loans, offers, collateral, repayment, liquidation, preclose, refinance, keeper actions, and claims remain local to the selected network. Users should treat each network as its own local protocol instance.

The app registry includes entries for Ethereum, Base, Polygon zkEVM, Arbitrum One, Optimism, BNB Chain, Sepolia, Base Sepolia, Polygon zkEVM Cardona, Arbitrum Sepolia, Optimism Sepolia, BNB Testnet, and local Anvil development networks.

Only networks with deployed protocol addresses are treated as live protocol targets by the app. Unsupported-chain wallet connections are allowed, but the app shows switch-network guidance before money-moving actions.

Current deploy state as of July 1, 2026: live protocol deployments are testnet and local only. Mainnet registry entries are supported targets in the app and documentation, not a statement that mainnet deployments are live. Third-party audit remains required before mainnet launch.

---

## 4. Offers and Market Mechanics

Vaipakam separates offer creation from loan initiation.

An offer records proposed terms: side, asset pair, amount, rate, duration, collateral, asset type, interest mode, and relevant acknowledgements. A loan begins only when an offer is accepted or a valid match is executed and the required protocol checks pass.

The app supports:

- Lender-side and borrower-side offers.
- ERC-20 principal assets.
- ERC-20, ERC-721, and ERC-1155 collateral handling where supported by the active deployment.
- NFT rental offers using vault custody and temporary user-right assignment.
- Duration validation within the supported range exposed by protocol configuration.
- Market-rate context from recent accepted offers where available.
- Active, filled, and cancelled user-offer views.
- Offer cancellation for eligible active offers.
- Direct accept review with fee, risk, and transaction-preview information.
- Partial-fill, fill-mode, expiry, and matcher-aware display where the deployment provides those fields.

Offer creation and acceptance should present risk disclosures before submission. Users must understand that collateral recovery can be affected by liquidity, oracle availability, market stress, asset type, and fallback settlement rules.

---

## 5. Loan Lifecycle

A Vaipakam loan tracks agreed principal, collateral, rate, duration, interest mode, parties, position NFTs, and state. Loan Details is the canonical surface for inspecting and acting on a live or terminal position.

The current app supports:

- Full repayment.
- Partial repayment when allowed by the loan.
- Collateral additions.
- Health-factor and LTV display for liquid loans.
- Clear handling for illiquid loans where standard risk math is not meaningful.
- Borrower preclose paths.
- Lender early-withdrawal paths.
- Refinance flows.
- Route-based liquidation actions for eligible undercollateralized active loans.
- Claim actions after repayment, default, liquidation, or other terminal settlement.
- Timeline and activity views that reconstruct important lifecycle events.
- Interest-mode display so users can distinguish full-term and pro-rata behavior where relevant.
- Periodic-interest checkpoint visibility where configured.
- Warnings when a third party repays a loan without receiving collateral rights.

Repayment does not grant collateral rights to the payer unless the payer also holds the borrower-side Vaipakam position NFT. Claim rights follow current position-NFT ownership.

---

## 6. Vaipakam Vaults

Each user can operate through a Vaipakam Vault. A vault is the protocol accounting boundary for tracked balances, locked assets, VPFI utility balances, claimable proceeds, and reservations.

The app exposes:

- Protocol-tracked asset balances.
- Locked and free balances.
- VPFI utility balances.
- Asset rows that distinguish withdrawable funds from funds locked by offers, loans, intents, claims, or reservations.
- Recovery tooling for protocol-untracked, self-sent stuck ERC-20 tokens through a deliberately hidden advanced route.

The recovery route is not a dust-cleanup tool for unsolicited third-party tokens. Users should not recover tokens they did not send themselves. The route asks the user to declare the source address and warns that a sanctioned declared source can lock the user's vault.

---

## 7. Position NFTs

Vaipakam position NFTs represent economic rights in offers and loans. Lender-side and borrower-side NFTs let the protocol and app determine who can claim, who can act for a role, and how rights move after a transfer.

This means:

- Claim authority follows the current position-NFT owner, not necessarily the original wallet.
- Loan Details and Claim Center should distinguish stored loan parties from live position holders where that distinction matters.
- Third-party repayment can close a debt but does not transfer collateral rights.
- Strategic flows can constrain transferability while an in-progress path is open.
- Public verification tools can help secondary-market participants inspect a Vaipakam position NFT before relying on it.

---

## 8. NFT Rental Model

Vaipakam supports NFT rental flows for eligible NFTs. In a rental, the NFT remains under vault-controlled custody and the borrower receives temporary usage rights. The borrower does not receive ownership custody of the NFT itself.

NFT rentals use ERC-20 prepayment or collateral rules to cover the rental obligation and buffer. When the rental closes properly, the protocol returns the NFT owner and renter to the settlement state defined by the loan terms. On default, the protocol can settle the locked payment assets according to the rental rules.

The app includes NFT-aware creation, loan detail, collateral, prepayment, and verifier surfaces so users can inspect the position before and after entering a rental.

---

## 9. Collateral, Liquidity, and Risk

Vaipakam distinguishes liquid assets from illiquid assets.

Liquid ERC-20 assets depend on active-network oracle and liquidity conditions. The app and protocol should evaluate the selected network rather than assuming liquidity from another chain. For liquid loans, the app can surface health factor, LTV, liquidation projections, and collateral-risk indicators.

Illiquid assets include NFTs and ERC-20 assets that do not satisfy the active liquidity and oracle checks. Illiquid loans do not have ordinary health-factor math in the same way liquid ERC-20 loans do. In stressed or illiquid conditions, lender recovery may occur in-kind rather than through a market sale.

The user-facing risk model includes:

- Combined risk and terms acknowledgement during offer creation and acceptance.
- Liquidity preflight warnings.
- Progressive risk-access tiers where enabled.
- Strict-mode acknowledgement for users who want stronger per-pair controls.
- Sanctions and terms gates where configured.
- Transaction simulation previews that can report whether a transaction appears likely to succeed, revert, or be unavailable for preview.

---

## 10. Liquidation and Fallback Settlement

Liquidation handling in the connected app is route-based. The review surface can quote available liquidation routes, submit the liquidation transaction, and show fallback settlement visibility where the deployment exposes it. The app does not present every protocol-level liquidation branch as a user-selectable action.

When ordinary liquidation cannot execute safely, the protocol can move into fallback settlement behavior according to the loan state, collateral type, oracle availability, and risk rules. Users should not assume that collateral will always be converted into the lending asset. Lenders may receive collateral in kind, and the recovered value can be materially lower than the asset lent.

---

## 11. VPFI Utility

VPFI is the Vaipakam protocol token used by the connected app for fee utility and interaction rewards.

The active app surfaces support:

- Depositing VPFI into the user's Vaipakam Vault.
- Withdrawing free VPFI from the vault.
- Viewing wallet and vault VPFI balances.
- Viewing fee-discount tier status.
- Enabling a shared platform-level setting that permits vault-held VPFI to be used for fee discounts.
- Viewing VPFI token transparency information.
- Claiming platform interaction rewards through Claim Center when earned and claimable.

The current product surface treats VPFI as fee utility and claimable reward infrastructure. Vault-held VPFI is not described as a passive yield deposit product.

Borrower fee-discount handling is shown as an up-front fee path with any earned rebate becoming claimable through the loan's settlement flow when protocol conditions are satisfied.

---

## 12. Interaction Rewards

Vaipakam rewards eligible lending and borrowing activity through platform interaction rewards. The connected app exposes the reward claim surface in Claim Center alongside ordinary per-loan claims.

The claim UI can show:

- Pending claimable VPFI.
- Lifetime claimed VPFI reconstructed from events.
- Contributing loan rows.
- Waiting states when required reward accounting is not yet available on the active chain.
- Successful claim transaction feedback.

Interaction rewards are pull-based: users claim when rewards are available instead of receiving automatic transfers.

---

## 13. Wallets, Permissions, and Transaction Safety

The connected app supports browser wallets, mobile wallet flows, WalletConnect-style connections, Coinbase Wallet, injected wallets, and Safe app embedding where configured.

The app is designed around explicit wallet approval:

- Users connect a wallet before account-specific actions.
- Writes are submitted through the connected wallet.
- ERC-20 flows can use Permit2 where supported, with a classic approval fallback.
- Review surfaces show important transaction context before submission.
- Simulations are advisory and do not replace the mined transaction receipt.
- Success states are based on transaction receipt confirmation.
- Errors are decoded where possible and recorded in a local journey log for issue reporting.

Keeper settings are advanced delegated-execution controls. Keepers are role managers, not asset claimants. Claim authority remains tied to the current owner of the relevant Vaipakam position NFT.

---

## 14. Compliance, Terms, Privacy, and Data Rights

The app includes user-facing gates and notices for legal and operational safety:

- Terms acceptance can be required before connected-app routes open.
- Terms reads fail closed rather than silently allowing protected actions when acceptance status cannot be verified.
- Sanctions banners appear for affected connected wallets or counterparties where a sanctions oracle is configured.
- Flagged wallets can be blocked from new risky activity while close-out paths may remain available to protect clean counterparties.
- Proceeds owed to a flagged wallet can be described as locked in that wallet's Vaipakam Vault until the flag clears.
- Cookie consent, language, theme, and privacy controls are available across the app experience.
- Data Rights tools let users export or delete Vaipakam-namespaced browser storage, while making clear that public on-chain state cannot be erased by frontend action.

Vaipakam is decentralized protocol software. Users remain responsible for understanding the assets they use, the jurisdictions they operate in, and the risks of lending, borrowing, renting, collateral, liquidation, and smart-contract interaction.

Security-sensitive reports should use Vaipakam's private disclosure channel at [GitHub Security Advisories](https://github.com/vaipakam/vaipakam/security/advisories/new) or the repository [SECURITY.md](https://github.com/vaipakam/vaipakam/blob/main/SECURITY.md), not public GitHub issues. Incident-response procedures are documented in the [Incident Runbook](https://github.com/vaipakam/vaipakam/blob/main/docs/ops/IncidentRunbook.md).

---

## 15. Transparency and Operations

Vaipakam exposes public-read surfaces for transparency:

- Public Analytics for aggregate protocol metrics.
- NFT Verifier for independent inspection of position NFTs.
- Protocol Console for configuration and admin visibility.
- Explorer links from transaction and asset rows.
- Data freshness indicators that distinguish indexed data, direct chain reads, fallback reads, and catching-up states.
- Issue-report tooling that captures redacted frontend, chain, wallet, and indexer context.

Advanced users can inspect keeper settings, risk-access state, allowances, vault locks, loan timelines, and activity history without relying on private support intervention.

---

## 16. Boundaries

The connected app is the interactive surface. It does not replace user judgement and does not guarantee a counterparty, successful match, profitable liquidation, available liquidity, oracle coverage, successful notification delivery, uninterrupted indexer availability, or uninterrupted third-party infrastructure.

Vaipakam does not promise that collateral will retain value, that liquidation routes will always be available, or that illiquid assets can be converted into the lending asset. Users should create and accept only terms they are willing to hold through stressed market conditions.

The app presents the currently available Vaipakam product surfaces: lending, borrowing, NFT rental, offer management, loan management, claims, VPFI fee utility, interaction rewards, vault accounting, risk access, alerts, public analytics, NFT verification, and protocol-console visibility.
