# Vaipakam DeFi Product Overview

Vaipakam is a decentralized peer-to-peer lending, borrowing, NFT rental, and collateral-management protocol. The connected application at defi.vaipakam.com gives users a wallet-controlled interface for creating offers, accepting offers, managing loans, claiming proceeds, using VPFI fee utility, and inspecting public protocol state.

Vaipakam is non-custodial at the user-action layer: protocol transactions are submitted through the connected wallet, and claim rights follow the Vaipakam position NFTs that represent lender and borrower roles. The app does not hold signing keys, does not custody user wallets, and does not hide protocol state behind a private account system.

This README is the product-facing overview. The canonical technical whitepaper rendered on the public website remains [apps/www/src/content/whitepaper/Whitepaper.en.md](apps/www/src/content/whitepaper/Whitepaper.en.md).

## Legacy README Section Reference Map

Older code comments, audit notes, and design docs may still cite `README §...` from the former technical whitepaper layout. Treat those citations as references to the canonical technical whitepaper and FunctionalSpecs sources below; the root README no longer carries those technical sections.

| Legacy citation area | Current source |
| --- | --- |
| README §1 Introduction and motivation | `apps/www/src/content/whitepaper/Whitepaper.en.md` §1 |
| README §2 System model, chain model, roles | `apps/www/src/content/whitepaper/Whitepaper.en.md` §2 |
| README §3 Diamond architecture, facets, vaults, position NFTs | `apps/www/src/content/whitepaper/Whitepaper.en.md` §3 and `docs/adr/` architecture records |
| README §4 Asset classification and active-network liquidity | `apps/www/src/content/whitepaper/Whitepaper.en.md` §4 and `docs/FunctionalSpecs/ProjectDetailsREADME.md` active-network liquidity rules |
| README §5 Offer and loan lifecycle | `apps/www/src/content/whitepaper/Whitepaper.en.md` §5 and `docs/FunctionalSpecs/` workflow specs |
| README §6 Risk engine | `apps/www/src/content/whitepaper/Whitepaper.en.md` §6 and `docs/DesignsAndPlans/ProgressiveRiskAccessDesign.md` |
| README §7 Liquidation and fallback settlement | `apps/www/src/content/whitepaper/Whitepaper.en.md` §7 and liquidation-focused design docs under `docs/DesignsAndPlans/` |
| README §8 Oracle stack | `apps/www/src/content/whitepaper/Whitepaper.en.md` §8 and `docs/DesignsAndPlans/OraclePolicy.md` |
| README §9 NFT rental subsystem | `apps/www/src/content/whitepaper/Whitepaper.en.md` §9 |
| README §10 Strategic flows | `apps/www/src/content/whitepaper/Whitepaper.en.md` §10 and matching `docs/FunctionalSpecs/` workflow coverage |
| README §11 VPFI token and tokenomics | `apps/www/src/content/whitepaper/Whitepaper.en.md` §11 and `docs/FunctionalSpecs/TokenomicsTechSpec.md` |
| README §12 Reward system | `apps/www/src/content/whitepaper/Whitepaper.en.md` §12 |
| README §13 Cross-chain surface | `apps/www/src/content/whitepaper/Whitepaper.en.md` §13 and cross-chain design docs under `docs/DesignsAndPlans/` |
| README §14 MEV protection | `apps/www/src/content/whitepaper/Whitepaper.en.md` §14 and `docs/DesignsAndPlans/MEVProtection.md` |
| README §15 Governance and operations | `apps/www/src/content/whitepaper/Whitepaper.en.md` §15 and `docs/ops/` runbooks |
| README §16 Frontend as safety layer | `apps/www/src/content/whitepaper/Whitepaper.en.md` §16 and `docs/FunctionalSpecs/WebsiteReadme.md` |
| README §17 Verification and testing | `apps/www/src/content/whitepaper/Whitepaper.en.md` §17 plus workflow/test-scope docs under `docs/TestScopes/` |
| README §18 References | `apps/www/src/content/whitepaper/Whitepaper.en.md` §18 |


## Product Overview

Vaipakam provides a two-sided market where lenders and borrowers define their own terms instead of borrowing from a pooled money market.

- Lenders can post offers to lend ERC-20 assets against ERC-20 or NFT collateral.
- Borrowers can post offers describing the asset they want to borrow and the collateral they are willing to provide.
- Counterparties can accept compatible offers directly through the Offer Book.
- Valid lender and borrower offers can be matched when protocol rules, collateral requirements, and risk checks are satisfied.
- NFT owners can rent eligible NFTs through vault-controlled rental flows where the borrower receives temporary usage rights rather than ownership custody.
- Active positions are represented by Vaipakam NFTs, so lender-side and borrower-side rights can be inspected and, where protocol rules allow, transferred.

The protocol is designed for transparent, asset-specific negotiation. Users choose terms, review risk, sign transactions, and later claim what the protocol owes them from terminal loan states.

## Supported User Surfaces

The connected app currently includes:

- Dashboard for wallet-owned loans, offers, claim shortcuts, VPFI status, fee-discount consent, and auto-lifecycle settings where available.
- Offer Book for browsing lender and borrower offers, filtering market inventory, reviewing active user offers, and accepting valid offers.
- Create Offer for lender offers, borrower offers, ERC-20 collateral, NFT collateral, NFT rental terms, duration buckets, interest-mode choices, periodic-interest settings where supported, and risk acknowledgement.
- Loan Details for repayment, collateral additions, health-factor and LTV views when applicable, liquidation visibility, lifecycle timelines, keeper controls, prepayment listings, swap-to-repay surfaces, and position-specific actions.
- Claim Center for lender and borrower claims, VPFI interaction rewards, loan-linked claim rows, and claim transaction feedback.
- VPFI Vault for depositing and withdrawing free VPFI, viewing protocol-tracked VPFI balances, fee-discount tier status, and token transparency.
- Your Vaipakam Vault for protocol-tracked balances, locked versus free asset state, and vault-level asset inspection.
- Risk Access for user-controlled vault risk tiers and strict-mode controls where the deployment exposes progressive risk access.
- Alerts for loan and health-factor notification preferences where enabled.
- Allowances for reviewing token approvals relevant to app actions.
- Keeper Settings for advanced delegation controls.
- Activity for wallet-specific protocol history.
- Data Rights for browser-storage export and deletion tools.
- Public Analytics for no-wallet aggregated protocol data.
- NFT Verifier for public inspection of Vaipakam position NFTs.
- Protocol Console for public and admin-facing protocol configuration visibility where the active wallet has the required authority.

## Market Mechanics

Vaipakam separates offer creation from loan initiation.

An offer describes proposed terms: side, asset pair, amount, rate, duration, collateral, asset type, interest mode, and relevant acknowledgements. A loan begins only when an offer is accepted or a valid match is executed and the protocol checks pass.

The app supports:

- Lender-side and borrower-side offers.
- ERC-20 principal assets.
- ERC-20, ERC-721, and ERC-1155 collateral handling where supported by the protocol.
- NFT rental offers using vault custody and temporary user-right assignment.
- Duration validation within the live supported range.
- Market-rate context from recent accepted offers where available.
- Active, filled, and cancelled user-offer views.
- Offer cancellation for eligible active offers.
- Direct accept review with fee, risk, and transaction preview information.
- Partial-fill, fill-mode, expiry, and matcher-aware display where the deployment provides those fields.

Every create or accept flow is expected to present risk disclosures before submission. Users must understand that collateral recovery can be affected by liquidity, oracle availability, market stress, and asset type.

## Loan Lifecycle

A Vaipakam loan tracks the agreed principal, collateral, rate, duration, interest mode, parties, role NFTs, and state. Loan Details is the canonical surface for inspecting and acting on a live or terminal position.

The coded app supports:

- Full repayment.
- Partial repayment when allowed by the loan.
- Add-collateral flows.
- Health-factor and LTV display for liquid loans.
- Clear handling for illiquid loans where standard risk math is not meaningful.
- Borrower preclose paths.
- Lender early-withdrawal paths.
- Refinance flows.
- Liquidation actions for undercollateralized active loans where permitted.
- Claim actions after repayment, default, liquidation, or other terminal settlement.
- Timeline and activity views that reconstruct important lifecycle events.
- Interest-mode display so users can distinguish full-term and pro-rata behavior where relevant.
- Periodic-interest checkpoint visibility where configured.
- Warnings when a third party repays a loan without receiving collateral rights.

Claim rights follow the current holder of the relevant Vaipakam position NFT. Repaying a loan does not automatically grant collateral rights to the payer unless the payer also holds the borrower-side position.

## Collateral, Risk, and Liquidation

Vaipakam distinguishes between liquid assets and illiquid assets.

Liquid ERC-20 assets depend on active-network oracle and liquidity conditions. The app and protocol should evaluate the selected network rather than assuming liquidity from another chain. For liquid loans, the app can surface health factor, LTV, liquidation projections, and collateral-risk indicators.

Illiquid assets include NFTs and ERC-20 assets that do not satisfy the active liquidity and oracle checks. Illiquid loans do not have ordinary health-factor math in the same way liquid ERC-20 loans do. In stressed or illiquid conditions, lender recovery may occur in-kind rather than through a market sale.

The user-facing risk model includes:

- Combined risk and terms acknowledgement during offer creation and acceptance.
- Liquidity preflight warnings.
- Progressive risk-access tiers where enabled.
- Strict-mode acknowledgement for users who want stronger per-pair controls.
- Sanctions and terms gates where configured.
- Transaction simulation previews that can report whether a transaction appears likely to succeed, revert, or be unavailable for preview.

Liquidation handling in the connected app is route-based: the review surface can quote available liquidation routes, submit the liquidation transaction, and show fallback settlement visibility where the deployment exposes it. The app does not present every protocol-level liquidation branch as a user-selectable action.

## NFT Rental Model

Vaipakam supports NFT rental flows for eligible NFTs. In a rental, the NFT remains under vault-controlled custody and the borrower receives temporary usage rights. The borrower does not receive ownership custody of the NFT itself.

NFT rentals use ERC-20 prepayment or collateral rules to cover the rental obligation and buffer. When the rental closes properly, the protocol returns the NFT owner and renter to the settlement state defined by the loan terms. On default, the protocol can settle the locked payment assets according to the rental rules.

The app includes NFT-aware creation, loan detail, collateral, prepayment, and verifier surfaces so users can inspect the position before and after entering a rental.

## Vaipakam Vaults

Each user can operate through a Vaipakam Vault. The vault is the protocol accounting boundary for tracked balances, locked assets, VPFI utility balances, claimable proceeds, and reserved amounts.

The app exposes:

- Protocol-tracked asset balances.
- Locked and free balances.
- VPFI utility balances.
- Asset rows that distinguish withdrawable funds from funds locked by offers, loans, intents, claims, or reservations.
- Recovery tooling for protocol-untracked, self-sent stuck ERC-20 tokens, available through a deliberately hidden advanced route.

The vault interface is meant to prevent users from mistaking locked protocol capital for withdrawable wallet balance.

## VPFI Utility

VPFI is the Vaipakam protocol token used by the connected app for fee utility and interaction rewards.

The active app surfaces support:

- Depositing VPFI into the user's Vaipakam Vault.
- Withdrawing free VPFI from the vault.
- Viewing wallet and vault VPFI balances.
- Viewing fee-discount tier status.
- Enabling a shared platform-level setting that permits vault-held VPFI to be used for fee discounts.
- Viewing VPFI token transparency information.
- Claiming platform interaction rewards through Claim Center when earned and claimable.

The current product surface does not present VPFI as a protocol fixed-rate sale and does not present vault-held VPFI as earning a staking APR. Vault-held VPFI is shown as fee utility and claimable reward infrastructure, not as a yield deposit product.

Borrower fee-discount handling is shown as an up-front fee path with any earned rebate becoming claimable through the loan's settlement flow when protocol conditions are satisfied.

## Interaction Rewards

Vaipakam rewards eligible lending and borrowing activity through platform interaction rewards. The connected app exposes the reward claim surface in Claim Center alongside ordinary per-loan claims.

The claim UI can show:

- Pending claimable VPFI.
- Lifetime claimed VPFI reconstructed from events.
- Contributing loan rows.
- Waiting states when required reward accounting is not yet available on the active chain.
- Successful claim transaction feedback.

Interaction rewards are pull-based: users claim when rewards are available instead of receiving automatic transfers.

## Network Model

The app is built for separate per-network protocol deployments. Loans, offers, collateral, repayment, liquidation, preclose, refinance, and keeper actions are local to the active network selected by the connected wallet.

The coded network registry includes mainnet and testnet entries for:

- Ethereum
- Base
- Polygon zkEVM
- Arbitrum One
- Optimism
- BNB Chain
- Sepolia
- Base Sepolia
- Polygon zkEVM Cardona
- Arbitrum Sepolia
- Optimism Sepolia
- BNB Testnet
- Local Anvil development network

Only networks with deployed protocol addresses are treated as live protocol targets by the production app. Unsupported-chain connections are allowed, but the app shows switch-network guidance before money-moving actions.

Current deploy state (July 1, 2026): live protocol deployments are testnet/local only. Mainnet network entries are supported targets in the app registry, not a statement that mainnet deployments are live. Third-party audit remains required before mainnet launch.

## Wallets and Transaction Safety

The connected app supports browser wallets, mobile wallet flows, WalletConnect-style connections, Coinbase Wallet, injected wallets, and Safe app embedding where configured.

The app is designed around explicit wallet approval:

- Users connect a wallet before account-specific actions.
- Writes are submitted through the connected wallet.
- ERC-20 flows can use Permit2 where supported, with a classic approval fallback.
- Review surfaces show important transaction context before submission.
- Simulations are advisory and do not replace the mined transaction receipt.
- Success states are based on transaction receipt confirmation.
- Errors are decoded where possible and recorded in a local journey log for issue reporting.

## Compliance, Terms, and Privacy

The app includes user-facing gates and notices for legal and operational safety:

- Terms acceptance can be required before connected-app routes open.
- Terms reads fail closed rather than silently allowing protected actions when acceptance status cannot be verified.
- Sanctions banners appear for affected connected wallets or counterparties where a sanctions oracle is configured.
- Flagged wallets can be blocked from new risky activity while close-out paths may remain available to protect clean counterparties.
- Proceeds owed to a flagged wallet can be described as locked in that wallet's Vaipakam Vault until the flag clears.
- Cookie consent, language, theme, and privacy controls are available across the app experience.
- Data Rights tools let users export or delete Vaipakam-namespaced browser storage, while making clear that public on-chain state cannot be erased by frontend action.

Vaipakam is decentralized protocol software. Users remain responsible for understanding the assets they use, the jurisdictions they operate in, and the risks of lending, borrowing, renting, collateral, liquidation, and smart-contract interaction.

Security-sensitive reports should use the private channels in [SECURITY.md](SECURITY.md), not public GitHub issues. Incident-response procedures are documented in [docs/ops/IncidentRunbook.md](docs/ops/IncidentRunbook.md).

## Transparency and Operations

Vaipakam exposes public-read surfaces for transparency:

- Public Analytics for aggregate protocol metrics.
- NFT Verifier for independent inspection of position NFTs.
- Protocol Console for configuration and admin visibility.
- Explorer links from transaction and asset rows.
- Data freshness indicators that distinguish indexed data, direct chain reads, fallback reads, and catching-up states.
- Issue-report tooling that captures redacted frontend, chain, wallet, and indexer context.

Advanced users can inspect keeper settings, risk-access state, allowances, vault locks, loan timelines, and activity history without relying on private support intervention.

## Boundaries

The connected app is the interactive surface. It does not replace user judgement and does not guarantee a counterparty, successful match, profitable liquidation, available liquidity, oracle coverage, or uninterrupted third-party infrastructure.

Vaipakam does not promise that collateral will retain value, that liquidation routes will always be available, or that illiquid assets can be converted into the lending asset. Users should create and accept only terms they are willing to hold through stressed market conditions.

The app presents the currently available Vaipakam product surfaces: lending, borrowing, NFT rental, offer management, loan management, claims, VPFI fee utility, interaction rewards, vault accounting, risk access, alerts, public analytics, NFT verification, and protocol-console visibility.
