# Vaipakam DeFi | Decentralized P2P Lending, Borrowing and NFT Rental Platform (Phase 1)

## Technical Project Details for Developers

Vaipakam is a decentralized peer-to-peer (P2P) lending and borrowing platform built for separate per-network deployments on Base, Polygon, Arbitrum, Optimism, and Ethereum mainnet. It facilitates lending and borrowing of ERC-20 tokens and rentable ERC-721/1155 NFTs, using any ERC-20 or NFT assets as collateral. The platform mints NFTs to represent offers and loans, ensuring transparency and traceability. This document outlines the technical architecture, smart contract interactions, and operational examples for Phase 1.

## Table of Contents

- [1. Supported Assets and Networks (Phase 1)](#1-supported-assets-and-networks-phase-1)
- [2. Loan Durations and Flexibility](#2-loan-durations-and-flexibility)
- [3. Offer Creation](#3-offer-creation)
- [4. Offer Book Display](#4-offer-book-display)
- [5. Loan Initiation](#5-loan-initiation)
- [6. Loan Closure & Repayment](#6-loan-closure--repayment)
- [7. Liquidation and Default](#7-liquidation-and-default)
- [8. Preclosing by Borrower (Early Repayment Options)](#8-preclosing-by-borrower-early-repayment-options)
- [9. Early Withdrawal by Lender](#9-early-withdrawal-by-lender)
- [10. Governance and VPFI Token Rollout](#10-governance-and-vpfi-token-rollout)
- [11. Notifications and Alerts](#11-notifications-and-alerts)
- [12. User Dashboard](#12-user-dashboard)
- [13. Technical Details](#13-technical-details)
- [14. Initial Deployment and Configuration (Phase 1)](#14-initial-deployment-and-configuration-phase-1)
- [15. NFT Verification Tool](#15-nft-verification-tool)
- [16. Regulatory Compliance Considerations](#16-regulatory-compliance-considerations)
- [Summary (Phase 1)](#summary-phase-1)
- [Phase 1 Additions: Borrower Collateral Management & Refinancing](#phase-1-additions-borrower-collateral-management--refinancing)
- [New features](#new-features)
- [Developement Approach](#developement-approach)
- [Security Note:](#security-note)
- [Other Notes:](#other-notes)
- [License](#license)

## 1. Supported Assets and Networks (Phase 1)

### Lending and Collateral Assets

**Lending Assets:**

- **ERC-20 Tokens:** Any ERC-20 token (e.g., USDC, ETH, WBTC) on Base, Polygon, Arbitrum, Optimism, or Ethereum mainnet.
- **Rentable ERC-721/1155 NFTs:** Unique NFTs that are ERC-4907 compliant (like NFTs from Warena and Axie Infinity) which can be rented (NFTs in which `setUser` and `userOf` functions can be called) with lender-specified daily rental charges.
  - For ERC-721 tokens, the token is transferred into the Vaipakam Escrow contract during the rental period. This gives the Vaipakam admin/escrow controller escrow-controlled owner/custody access so it can assign, revoke, or reassign only ERC-4907 `user` rights while keeping the borrower limited to temporary `user` access. The borrower never receives custody or ownership of the ERC-721 token itself.
  - For ERC-1155 tokens, the tokens will be held in the Vaipakam Escrow contract during the rental period. The Vaipakam admin/escrow controller assigns ERC-4907-style user rights to the borrower while the token remains escrow-controlled, so a borrower preclose or transfer changes only the temporary user assignment and not the underlying custody model.
- For third-party integrations, Vaipakam Escrow should act as the stable ERC-4907-style wrapper / adapter for escrowed rental positions. External apps may query the escrow contract with the underlying NFT contract address and token ID to retrieve the current user, user expiry, and, for ERC-1155 rentals, the active aggregate rented quantity for that same token ID within that same ERC-1155 NFT contract under the queried escrow. If more than one active rental exists for the same ERC-1155 contract and token ID within that escrow, the reported expiry should be the minimum (earliest) active rental expiry for that aggregated position. This means integrations should not assume the underlying NFT contract itself exposes a uniform rental interface for both ERC-721 and ERC-1155 in the same way; the escrow contract is the intended integration surface for rental-state reads.

**Collateral Assets:**

- Any ERC-20 tokens or ERC-721/1155 NFTs for ERC-20 Lending.
- Only ERC-20 tokens for NFT Lending/Renting.
  - Rationale: NFT lending in Phase 1 is a rental-style transaction, not a custody transfer to the borrower. The rented NFT remains inside Vaipakam Escrow for the full rental period, and the borrower receives only temporary ERC-4907-style user rights. Because the NFT itself remains escrow-controlled and can be returned to the lender directly at rental closure or default, an additional NFT collateral layer is not required for NFT renting.

**Supported Networks (Phase 1):**

- Ethereum Mainnet
- Base Network
- Polygon Network
- Arbitrum Network
- Optimism Network

_Note: For Phase 1, all lending, borrowing, and collateralization activities for a specific loan must occur on a single network (e.g., a loan initiated on Polygon must have its collateral and repayment on Polygon)._

### Asset Viability, Oracles, and Liquidity Determination

The platform distinguishes between liquid and illiquid assets, which affects how defaults and LTV calculations are handled.

- **Liquid Asset Criteria:** For Phase 1, an ERC-20 token is considered "Liquid" on a given network only if:
  1.  It has a usable on-chain price path on the active network: preferably a direct Chainlink `asset/USD` feed, and only if that is unavailable a fallback `asset/ETH × ETH/USD` path.
  2.  It has sufficient on-chain DEX liquidity on the active network through at least one configured v3-style concentrated-liquidity AMM factory for `asset/WETH`. The deploy-time factory set may include Uniswap V3, PancakeSwap V3, and SushiSwap V3, and the check treats those venues with OR logic: one sufficiently deep venue is enough.
  3.  The protocol converts the pool's raw liquidity to USD using the active network's Chainlink `ETH/USD` feed and requires at least the configured minimum depth threshold before the asset is treated as liquid.
  4.  Liquidity must be judged only from the current active network's own oracle and pool availability. Ethereum mainnet must not be consulted as a reference or fallback network for this decision. If the active network fails the liquidity check, the asset is treated as illiquid on that network and the protocol must not perform any additional mainnet verification to override that result.
- **Illiquid Assets:**
  - All ERC-721 and ERC-1155 NFTs are considered "Illiquid" by the platform for valuation and LTV purposes. Their platform-assessed value is $0.
  - ERC-20 tokens that do not meet both criteria for a Liquid Asset are considered "Illiquid".
- **NFT Valuation for Collateral (Lender's Discretion):**
  - The Vaipakam platform does not perform any valuation for NFT collateral due to their volatile and auction-driven nature. For LTV calculations and systematic risk assessment, NFTs used as collateral are assigned a value of zero.
  - Lenders can still specify an NFT as required collateral. The decision to accept such terms rests entirely with the borrower.
- **Oracle Usage:**
  - **Chainlink Price Feeds:** Used to provide real-time pricing for Liquid ERC-20 assets. This is crucial for LTV calculations and liquidation processes for loans with Liquid collateral.
  - **Hybrid Price Retrieval:** For ERC-20 pricing the protocol prefers a direct Chainlink `asset/USD` feed. Only when no direct USD feed exists does it fall back to `asset/ETH × ETH/USD`.
  - **Per-Feed Overrides:** Oracle admins may configure a per-feed staleness budget and minimum-valid-answer floor for critical Chainlink aggregators. A configured override takes precedence over the global freshness defaults and can be cleared by setting the override staleness back to zero.
  - **Secondary Oracle Quorum:** Chainlink remains the primary pricing path. Where configured, Tellor, API3, and DIA act as symbol-derived secondary price sources. The protocol applies a Soft 2-of-N rule: if every secondary is unavailable, Chainlink is accepted; if at least one available secondary agrees with Chainlink within the configured deviation bound, Chainlink is accepted; if one or more secondaries disagree and none agree, pricing reverts for that asset.
  - **No Per-Asset Secondary Oracle Mapping:** Tellor, API3, and DIA keys are derived from the ERC-20 symbol where possible, avoiding secondary-oracle configuration that would require one governance mapping entry per asset.
  - **ETH as Reference Asset:** ETH is the protocol's quote and reference asset for liquidity classification. In practice the DEX sees WETH, so the protocol checks `asset/WETH` pools while using the Chainlink `ETH/USD` feed to convert that depth into USD.
  - **WETH Special Case:** WETH itself is priced directly from `ETH/USD` and is treated as the quote asset for liquidity purposes; the protocol does not perform a circular `WETH/WETH` liquidity check.
  - **Peg-Aware Stable Staleness:** Stable and reference feeds may remain valid out to the protocol's longer stable staleness ceiling only when the reported price remains within tolerance of either the implicit USD `$1` peg or a governance-registered fiat / commodity reference such as `EUR/USD`, `JPY/USD`, or `XAU/USD`.
- **Liquidity Determination Process & On-Chain Record:**
  1.  **Frontend Assessment:** The frontend interface should attempt to assess asset liquidity by checking the active network only: a valid price path and the presence of a sufficiently deep configured v3-style concentrated-liquidity AMM `asset/WETH` pool. If the active network fails the liquidity test, the frontend must treat the asset as illiquid on that network and stop there; it must not perform any Ethereum-mainnet fallback verification and must not redirect the user to another network.
  2.  **User Acceptance (Frontend - Risk Consent):** Before a user creates or accepts an offer, the frontend must require one combined warning-and-consent acknowledgement. That single mandatory acknowledgement should read in substance: `Abnormal-market & illiquid asset terms. For Liquid Assets, if liquidation cannot execute safely — for example because slippage exceeds the configured max liquidation threshold, liquidity disappears, or every configured swap route fails — the lender claims the collateral in collateral-asset form instead of receiving the lending asset. If collateral value has fallen below the amount due, the lender receives the full remaining collateral and nothing is left for the borrower. If collateral value is still above the amount due, the lender receives only the equivalent collateral amount and the remainder stays with the borrower after charges. The same fallback applies to loans with illiquid assets (lending asset and / or collateral asset) on default — the lender takes the full collateral in-kind. Proceeding confirms you agree to these terms.` The transaction must not proceed without this consent, and the consent must be recorded for the relevant offer and resulting loan. It is acceptable for the resulting loan to store the combined accepted-by-both-parties consent state rather than two separately stored per-party consent fields, because the consent is mandatory for both lender and borrower.
  3.  **On-Chain Verification (Smart Contract):**
      - When an offer involving an ERC-20 asset (as a lending asset or collateral) is being created or accepted, and the frontend has _not_ marked it as illiquid, the smart contract will perform an on-chain check.
      - For Phase 1, this check should confirm both: a reliable price-validation path and at least one reliable `asset/WETH` v3-style concentrated-liquidity AMM liquidity path for the asset on the active network where the transaction is being attempted.
      - Ethereum mainnet must not be consulted as a reference or fallback network. The on-chain check uses only the active network's Chainlink registry / direct feeds and v3-style concentrated-liquidity AMM pools.
      - In practice, that means a valid Chainlink-led price path and at least one recognized v3-style concentrated-liquidity AMM `asset/WETH` pool with sufficient usable liquidity should both be confirmed on the active network before the asset is treated as liquid for transactions on that network. The supported v3 factory set may include Uniswap V3, PancakeSwap V3, and SushiSwap V3, with configured fee tiers checked across the active network.
      - A later protocol phase may split these concepts more explicitly into separate statuses such as "priceable" and "liquidatable", but Phase 1 should use the stricter combined rule for safety.
      - If the active network fails this check, the asset is classified as illiquid on that network. The protocol must not perform a second mainnet verification pass and must not use mainnet liquidity to authorize or reshape the active-network decision.
      - **On-Chain Precedence:** If the on-chain check determines the asset is illiquid (e.g., missing price feed or DEX pool), this on-chain determination overrides any prior assessment by the frontend. The user will then be required to accept the same single mandatory risk-consent acknowledgement, which in this case must also cover the full-collateral-transfer illiquid path.
  4.  **Explicit Storage:** For every loan, the liquidity status (Liquid or Illiquid, based on the on-chain verification and user acceptance flow) of the lending asset and collateral asset is explicitly stored in the loan's on-chain data.
  5.  **API Unavailability / Fail-Closed Behavior:** If frontend-side assistance is unavailable, or if on-chain checks face temporary issues in accessing necessary validation data (e.g., Chainlink or pool lookups), the asset will default to being treated as "Illiquid" to ensure safety. In such cases, full collateral transfer terms on default will apply, and the user must consent. No manual overrides are permitted to classify an asset as liquid if checks fail or indicate illiquidity.
  6.  **Same-Asset Guard:** At offer creation, the lending asset and collateral asset must not be the same asset. This invariant is enforced directly rather than by relying on reference-asset hacks.
- **Handling of Illiquid Assets on Default:**
  - **ERC-20 Lending with Illiquid Collateral:** If the borrower defaults, the entire illiquid ERC-20 collateral is transferred to the lender. There is no auction or DEX-based liquidation process for these assets.
  - **NFT Lending/Renting:** If the borrower defaults (e.g., fails to close the rental, before expiry), then prepaid (total rental fees + 5% buffer) ERC-20 collateral provided by the borrower is transferred to the NFT owner (lender). The original ERC-721 or ERC-1155 NFT held in Vaipakam Escrow is returned to the owner and the full buffer (5% extra) will be sent to treasury.
- **Frontend Warnings for Illiquid Assets:**
  - A clear, static combined warning message will be displayed in the frontend whenever a user creates or accepts an offer. For illiquid assets, that same message must make clear that on default the lender takes the full collateral in-kind rather than through a traditional liquidation process.
  - This illiquid path does not use a separate optional toggle or a second consent. It is covered by the same single mandatory combined warning-and-consent acknowledgement used for offer creation and offer acceptance.
- **Prepayment for NFT Renting:**
  - For NFT renting, the borrower must lock ERC-20 tokens as collateral. This collateral will cover the total rental amount plus a 5% buffer. This entire amount is considered a prepayment. The 5% buffer is refunded to the borrower upon successful and timely rental closure of the NFT and payment of all rental fees.
  - No separate NFT collateral is required for NFT renting in Phase 1. The escrow-controlled custody model already protects return-of-asset risk, while the ERC-20 prepayment and buffer cover the rental-payment obligation.

## 2. Loan Durations and Flexibility

### Loan Terms

- **Durations:** Configurable from 1 day to 1 year.
- **Grace Periods:** Automatically and strictly assigned based on loan duration:
  - < 1 week: 1 hour
  - < 1 month: 1 day
  - < 3 months: 3 days
  - < 6 months: 1 week
  - \le 1 year: 2 weeks

## 3. Offer Creation

### Lenders:

- **For ERC-20 Tokens:**
  - Specify the lending asset (e.g., 1000 USDC), loan amount, interest rate (e.g., 5% APR), required collateral type (e.g., WETH) and amount (or maximum LTV or minimum Health Factor requirement if collateral is Liquid), and loan duration.
    - LTV = Borrowed Value / Collateral Value
    - Helath Factor = Collateral Value / Borrowed Value
  - Deposit the lending asset into the Vaipakam smart contract when creating the offer.
- **For Rentable NFTs (ERC-721/1155):**
  - Specify the NFT (e.g., Axie #1234), daily rental fee (e.g., 10 USDC/day), the ERC-20 token for rental payment and collateral (e.g., USDC), and rental duration (e.g., 7 days).
  - For ERC-721 NFTs: Deposit the NFT into the Vaipakam Escrow contract when creating the offer so Vaipakam has escrow-controlled owner/custody access for user-right assignment.
  - For ERC-1155 NFTs: Deposit the NFT into the Vaipakam Escrow contract when creating the offer.

### Borrowers:

- **For ERC-20 Tokens:**
  - Specify the desired ERC-20 asset and amount, maximum acceptable interest rate, offered collateral (type and amount), and loan duration.
  - The frontend must clearly disclose that when an ERC-20 loan is actually initiated, a `Loan Initiation Fee` equal to `0.1%` of the lending-asset amount will be charged to treasury before the lending asset is delivered to the borrower. In other words, if the matched lending amount is `1000 USDC`, the borrower receives `999 USDC` and `1 USDC` is routed to treasury at initiation.
  - If the borrower uses the VPFI fee path, the borrower receives `100%` of the requested lending asset and pays the full `0.1%` fee equivalent in VPFI up front. That VPFI is held by the protocol until settlement and may produce a time-weighted borrower rebate on proper close, as defined in `docs/BorrowerVPFIDiscountMechanism.md`.
  - Lock the collateral in the Vaipakam smart contract upon offer submission.
- **For Rentable NFTs (ERC-721/1155):**
  - Specify the desired NFT (or type of NFT), maximum acceptable daily rental charge, the ERC-20 token to be used for prepayment (rental fees + 5% buffer), and rental duration.
  - Lock the prepayment (total rental fee + 5% buffer) in ERC-20 tokens in the Vaipakam smart contract upon offer submission. Rental payments will be deducted from this prepayment.

### Process:

- Offers are created through a React-based web interface.
- For common ERC-20 flows, the app may offer a Uniswap Permit2 single-signature path instead of the classic approve-then-action path. Supported actions include creating an offer, accepting an offer, and depositing VPFI to escrow. Wallets or users that do not use Permit2 should fall back to the explicit approval flow without changing protocol semantics.
- Permit2 signatures should be EIP-712 signatures with short expiries and high-entropy nonces. Permit2 must live alongside the legacy allowance path; it must not silently replace token-level approvals for users who choose the classic flow.
- All offer details are recorded on-chain for transparency and immutability.
- Wherever the frontend lets a borrower create an offer or accept an offer for ERC-20 borrowing, it must communicate the `Loan Initiation Fee` in plain language before submission. The disclosure should make clear that the fee is charged in the lending asset at loan initiation and is deducted before net proceeds reach the borrower.
- Wherever the frontend lets a user create or accept an offer, it must require a single mandatory combined warning-and-consent acknowledgement before submission. That acknowledgement must use the combined `Abnormal-market & illiquid asset terms` substance described above and must cover both the liquid-asset abnormal-market fallback and, when applicable, the illiquid full-collateral-in-kind path. If the consent is not given, the transaction must revert / not proceed.

### NFT Minting for Offers

Vaipakam mints unique NFTs to represent offers, enhancing traceability and user ownership of their financial positions.

**NFT Metadata:**

- **On-Chain Data:** Key offer details are stored directly on-chain as part of the NFT's metadata. This includes asset types, amounts, rates, duration, and status (e.g., "Offer Created," "Offer Cancelled," "Offer Matched"). The status is updated by authorized smart contract roles (e.g., `VaipakamOfferManagement.sol`) as the offer progresses.
- **`tokenURI()` Implementation:** The platform's NFT contract will implement a `tokenURI()` function that dynamically generates a JSON string containing all relevant loan information. This JSON can be consumed by third-party NFT marketplaces to display offer details.
- **Off-Chain Image Storage (IPFS):** Four distinct images representing different states/roles will be stored in IPFS:
  - `LenderActive.png`
  - `LenderClosed.png`
  - `BorrowerActive.png`
  - `BorrowerClosed.png`
    - The dynamically generated `tokenURI()` will point to the appropriate IPFS image URL based on who created the offer (Lender of Borrower) and its current status.
- **Metadata Updates:** The NFT metadata (specifically the status and potentially the image URL pointer) is updated by authorized smart contract roles (e.g., `VaipakamOfferManagement.sol`) when an offer or loan state changes (e.g., accepted, cancelled).
- **Standardized Metadata for Third-Party NFT Platforms:** The metadata for Vaipakam NFTs should follow a stable, standards-aligned JSON structure so that third-party NFT websites, wallets, marketplaces, and portfolio viewers can read and display meaningful information about the position without requiring Vaipakam-specific custom parsing as the only path.
  - The metadata should remain compatible with common NFT metadata expectations used by ERC-721 and ERC-1155 indexers and hosting platforms.
  - The metadata should expose standardized high-signal fields such as role (`Lender` / `Borrower`), protocol position status, linked offer ID, linked loan ID, principal or rental asset, collateral or prepay asset, amount, interest rate / rental rate, duration, network context, and whether the NFT currently governs claim rights.
  - The metadata should also include human-readable descriptive fields and structured attributes so that third-party websites can display both a readable summary and machine-parseable trait data.
  - Where relevant, metadata should clearly distinguish between offer-state NFTs and active-loan / resolved-loan position NFTs so external platforms do not misrepresent a stale offer as a live claim-bearing loan position.
  - Position metadata should be updated promptly when the protocol state changes so external platforms that refresh token metadata can reflect the current role, status, and claim relevance of the Vaipakam NFT.
- **Event Emission:** Detailed events are emitted for each relevant state change to support frontend tracking and off-chain services such as notifications and analytics.
  - Where a protocol action is represented through an intermediate or repurposed offer flow, the protocol should emit an explicit linking event so indexers and frontends do not need to infer the relationship through traces alone.
  - In particular, lender loan-sale / early-withdrawal flows should emit a first-class event that links the live loan ID to the generated sale or transition offer ID.

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

- **Single Mandatory Risk Consent:** The frontend must use one combined mandatory warning-and-consent acknowledgement, not separate warning blocks or optional checkboxes, for the offer-create and offer-accept flows. That one consent must be required from both sides and must cover the full `Abnormal-market & illiquid asset terms` shown in the flow. For loan storage, a single combined `consentFromBoth` style flag is acceptable because neither side is allowed to proceed without agreeing.
- implementation note for the `Offer Book` accept-review modal: the page may additionally show one extra informational illiquid-leg warning above the combined warning-and-consent block when the selected offer contains an illiquid lending asset or collateral asset, so long as that extra warning does not introduce a second consent or a second required acknowledgement

- **Full Collateral Transfer for Illiquid Assets:** Users are explicitly warned that if they use or accept illiquid assets/collateral, default by the borrower will result in the full transfer of that collateral to the lender, without any LTV-based liquidation auction.
- **Equivalent Collateral Transfer for Liquid Asset during Abnormal Periods:** When liquid assets cannot be liquidated due to any of the following conditions, the protocol must not automatically give the lender the borrower's entire liquid collateral balance. Instead, the lender should become entitled only to the collateral-equivalent amount needed to satisfy the lender-side recovery amount, measured in collateral units against the lending-asset obligation.
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
  - The project is not planning to move Vaipakam position NFTs into protocol escrow during borrower preclose, borrower refinance, or lender early-withdrawal flows, and is not planning to natively lock transfers for those flows through `_beforeTokenTransfer`.
  - Instead, completion authority for strategic flows should be enforced by function-level role and state checks against the currently entitled Vaipakam NFT owner, rather than by first moving the NFT into protocol escrow or by relying on a native transfer hook lock.
  - Ownership-sensitive logic for Vaipakam position authority should rely on the current `ownerOf(tokenId)` result for the relevant lender-side or borrower-side Vaipakam NFT unless a future protocol phase explicitly defines a different ownership-delegation model.
  - In other words, the protocol should use a function-by-function role-authority model over a single loan-wide shared-keeper model, so opt-in does not become broad public execution by accident and does not unnecessarily force one side to approve the other side's automation.
  - Liquidation remains the exception: any address may trigger liquidation whenever the protocol liquidation conditions are met, for both basic users and advanced users. Liquidation must not depend on keeper whitelists.
  - The protocol should distinguish between `permissionless`, `party-only`, and `keeper-optional` execution classes at the function level rather than using a single broad MEV / bot flag.
  - **Permissionless state-changing functions (Phase 1):**
    - `triggerLiquidation`: always permissionless because it is a protocol-safety action
    - `triggerDefault`: permissionless once the documented default conditions are met
    - `repayLoan`: permissionless full repayment is allowed, but repayment does not transfer collateral rights; collateral remains tied to the borrower-side Vaipakam NFT
    - `autoDeductDaily`: may remain permissionless because it is a deterministic rental-maintenance action with no caller discretion over pricing or settlement terms
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
    - all admin, treasury, NFT-ownership, escrow-upgrade, pause, oracle-admin, and role-management functions must remain role-gated / owner-gated rather than keeper-executable
  - **Keeper-optional state-changing functions (Phase 1):**
    - `completeLoanSale`
    - `completeOffset`
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
- **Collateral for NFT Renting:** The collateral for NFT renting is a prepayment of total rental fees + a 5% buffer, denominated in ERC-20 tokens.
  - This is intentionally different from ERC-20 lending. For NFT renting, the rented NFT itself stays in escrow custody and is returned by the protocol at rental closure/default, so the borrower does not need to post separate NFT collateral on top of the ERC-20 prepayment model.

## 4. Offer Book Display

### Frontend Implementation

- **Tabs:** Separate views for ERC-20 loan offers and NFT rental offers.
- **Sorting:**
  - ERC-20 offers: Sortable by interest rate (lowest for borrowers, highest for lenders), amount, duration.
  - NFT rental offers: Sortable by daily rental rate (lowest for renters, highest for owners), duration.
- **Guidance:** Display data from the last accepted offer with similar parameters (e.g., asset type, duration) to provide users with an indication of current market rates on Vaipakam.
- **Filters:** Users can filter offers by asset type, collateral requirements (if applicable), loan/rental duration, and amount.
- **Auto-Matching (Suggestion Engine):** The frontend can suggest potentially compatible offers to users based on their currently defined preferences or draft offers.
- **Clear Indicators:** The frontend will use clear indicators for network selection, asset liquidity status, and potential risks.
- **Information Icons & Tooltips:** Key fields and terms should include concise helper text, tooltips, and links to deeper documentation or FAQs where appropriate.

## 5. Loan Initiation

### Initiation:

- A borrower accepts a lender’s offer, or a lender accepts a borrower’s offer, via the Vaipakam interface.
- The accepting party pays the network gas fee for the transaction that initiates the loan.

### Smart Contract Actions:

- **Collateral Locking:**
  - For ERC-20 Loans: The borrower’s collateral is locked in an escrow contract.
  - For NFT Renting: The borrower’s prepayment (total rental fees + 5% buffer in ERC-20 tokens) is confirmed as locked.
- **Asset Transfer/NFT User Assignment:**
  - For ERC-20 Loans: Before the lending asset is delivered to the borrower, the protocol deducts a `Loan Initiation Fee` equal to `0.1%` of the lending-asset amount and routes that fee to treasury. The remaining net lending amount is then transferred from the lender or lender's locked funds (in the Escrow) to the borrower.
  - For NFT Renting:
    - For ERC-721: The NFT is held in the Vaipakam Escrow contract. The Escrow contract calls `setUser` on the NFT contract to assign the borrower as the 'user' of the NFT for the agreed rental duration.
    - For ERC-1155: The NFT is already in the Vaipakam Escrow contract. The Escrow contract calls `setUser` on the NFT contract to assign the borrower as the 'user' of the specified quantity of tokens for the agreed rental duration.
- **Record Keeping:** All loan details (principal, interest rate/rental fee, duration, collateral details, parties involved, start/end dates, liquidity status of assets) are recorded on-chain.
- **NFT Updates & Minting:**
  - The original "Vaipakam NFT" (of the party who have created the offer and whose offer was accepted) is updated to "Loan Initiated" status.
  - A new "Vaipakam NFT" is minted for the offer acceptor, with "Loan Initiated" status.
  - "Vaipakam NFT" will have respective roles of the users (either as lender or borrower) with it.

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
- If a third party repays on behalf of the borrower, that third party does **not** gain any right to the collateral by making the payment alone.
- After repayment, the collateral remains claimable only by the holder of the Vaipakam borrower NFT for that loan. Repayers must be clearly warned in the frontend and product flow that repayment does not transfer collateral ownership or collateral-claim rights.
- Interest Formula: `Interest = (Principal * AnnualInterestRate * LoanDurationInDays) / (100 * DAYS_PER_YEAR)`. (Note: use standardized protocol constants such as `DAYS_PER_YEAR` and `SECONDS_PER_YEAR` rather than hard-coded literals like `365`, and ensure consistent precision, e.g., rate stored as basis points).
- Late fees apply if repayment occurs after the due date but within the grace period, or if repayment is forced post-grace period.

**NFT Lending (Renting):**

- Borrower's Obligation: Ensure the NFT can be 'returned' (user status revoked by the platform) and all rental fees are paid.
- Rental Fee Payment: Rental fees are automatically deducted from the borrower's initial prepayment.
- If borrower closes rental term for NFT on time:
  - The Vaipakam Escrow contract revokes the borrower's 'user' status for the NFT.
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

### Claiming Funds/Assets

- **Lender/NFT Owner:** To claim their principal + interest (for ERC-20 loans) or rental fees (for NFT renting), the lender/NFT owner must interact with the platform and present their "Vaipakam NFT" to prove ownership and authorize the withdrawal of funds due to them.
- **Borrower:** To claim back their collateral (for ERC-20 loans, after full repayment) or their prepayment buffer (for NFT renting, after proper return and fee settlement), or after liquidation (if any remaining asset after covering total repayment and fees) the borrower must interact with the platform and present their "Vaipakam NFT" to claim thier funds.
- **Third-Party Repayer Clarification:** A wallet that repays a loan without holding the borrower's Vaipakam NFT is treated only as the payment sender. That wallet must not receive the collateral automatically and must not gain collateral-claim rights merely because it funded the repayment. The collateral claim remains exclusively tied to the borrower-side Vaipakam NFT.
- **Liquidation-Fallback Claim Clarification:** For liquid-collateral loans whose initial liquidation fails, there is no borrower-only waiting window; the lender may claim immediately. Until that lender claim is actually executed, the borrower may still fully repay the loan or add enough collateral to restore the position above the required LTV / Health Factor thresholds. Full repayment cancels the fallback path and preserves normal borrower collateral-claim rights. A collateral top-up may keep the loan active again only if the protocol thresholds are again satisfied before lender claim execution finalizes. Once lender claim execution starts, that execution path should not be auto-reversed during the same claim transaction. During lender claim, the system may attempt liquidation one more time. If that retry also fails, settlement must be done in collateral units: collateral equivalent to `lending asset due + accrued interest + 3% of the lending asset amount` goes to the lender, collateral equivalent to `2% of the lending asset amount` goes to treasury, and the remaining collateral stays attributable to the borrower. If the remaining collateral value is below the lender-side fallback entitlement, then the lender receives the full remaining collateral instead.

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

- **LTV Breach:** If the Loan-to-Value (LTV) ratio exceeds a critical threshold (e.g., 90%), based on Chainlink price feeds for both the borrowed asset and the collateral.
- **Non-Repayment Post Grace Period:** If the borrower fails to repay the loan (principal + interest + any late fees) by the end of the grace period.

**ERC-20 Lending with Illiquid Collateral:**

- **Non-Repayment Post Grace Period:** If the borrower fails to repay the loan by the end of the grace period. LTV is not applicable as illiquid collateral has a platform-assessed value of $0 for this purpose.

**NFT Lending (Renting):**

- **Non-Return/Fee Default Post Grace Period:** If the borrower fails to 'close the rental' of the NFT (allow user status to be properly revoked) and settle all rental fees by the end of the grace period.

### Processes

**ERC-20 Lending with Liquid Collateral:**

- **Liquidation:** The borrower's collateral is liquidated through the configured swap-adapter failover path to recover the outstanding loan amount (principal + accrued interest + late fees + liquidation penalty/fee).
- **Swap Failover:** The liquidation caller supplies a ranked try-list of swap adapter calls. Production routing may include 0x Settler, 1inch v6, Uniswap V3, and Balancer V2. The Diamond tries routes in the submitted order and falls back to the next route if a venue reverts, returns insufficient output, or becomes stale.
- **Exact-Scope Adapter Approvals:** For each swap attempt, the Diamond approves only the exact input amount needed for that adapter and revokes the approval after the attempt, regardless of success or failure. There are no persistent DEX allowances left behind by liquidation routing.
- **Oracle-Anchored Slippage Floor:** The on-chain oracle-derived minimum output remains authoritative. Keeper- or frontend-supplied `minOut` values may be stricter but cannot weaken the configured liquidation slippage floor.
- **Adapter Registration:** Mainnet deployments must register at least one swap adapter before liquidation settlement can operate. A deployment with no registered adapters reverts swap-based liquidation attempts and therefore reaches the documented collateral fallback path.
- **Permissionless Triggering Preserved:** Any address may call liquidation/default triggers once protocol conditions are met. The caller supplies routing data; there is no new liquidator role gate.
- **Liquidation Handling Charge:** If liquidation succeeds through the normal swap path, treasury must receive an additional liquidation-handling charge equal to `2%` of liquidation proceeds because the borrower failed to act before liquidation. This handling charge is separate from the liquidator incentive and separate from any treasury fee that may still apply on recovered interest or late-fee amounts.
- **Slippage Protection:** If the liquidation swap would incur slippage greater than 6%, the collateral conversion must not happen. In that case, the liquidation flow must stop using the DEX conversion path and must follow the same equivalent-collateral fallback procedure used for abnormal liquidation-failure conditions.
- **Governance Configuration:** The maximum liquidation slippage threshold should be configurable by governance within an approved bounded range. The Phase 1 administrator for this setting is the multisig / timelock path.
- **Fallback Claim Model:** When the DEX liquidation path is abandoned because every configured swap route fails, market conditions are abnormal, liquidity is unavailable, technical execution fails, or the configured slippage threshold would be exceeded, the protocol should resolve the lender side into a claimable collateral-equivalent position rather than a claim to the borrower's full liquid collateral. There is no separate borrower grace period in that state; the lender may claim immediately after the failed liquidation. However, until the lender claim is actually executed, the borrower may still either fully repay the loan or add enough collateral to restore the loan above the required LTV / Health Factor thresholds. If full repayment finalizes first, the fallback path is canceled and the borrower later claims back the collateral through the ordinary repayment flow. If a collateral top-up finalizes first and the position is again healthy, the loan may continue as active. Once lender claim execution starts, that claim path should not be interrupted or auto-revived during the same transaction. In that lender-claim branch, the lender or a keeper may supply a fresh ranked try-list for one more liquidation attempt. If that retry succeeds, settlement follows the normal converted-proceeds path. If that retry also fails, the lender later claims only the amount of collateral asset needed to satisfy `lending asset due + accrued interest + 3% of the lending asset amount` by presenting the Vaipakam lender NFT, unless the remaining collateral value is lower than that fallback entitlement, in which case the lender receives the full remaining collateral. The treasury receives collateral equivalent to `2% of the lending asset amount`, and any excess liquid collateral value remains attributable to the borrower.
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
  - For ERC-721: The borrower's 'user' status is revoked by the platform. The NFT remains in Vaipakam Escrow until it is returned to the lender through the normal rental/default settlement flow.
  - For ERC-1155: The NFT held in the Vaipakam Escrow is returned to the lender. The borrower's 'user' status is revoked.

### NFT Status Updates on Default/Liquidation

- The status of the relevant Vaipakam NFTs is updated to "Loan Defaulted" or "Loan Liquidated."

### Example: ERC-20 Liquidation (Liquid Collateral)

- Bob borrowed 1000 USDC against 0.5 WETH. WETH price drops, and his LTV exceeds 90%.
- The liquidation process is triggered. Bob's 0.5 WETH is sold.
- Assume sale yields 1020 USDC. Alice is owed 1004.11 USDC (principal + interest). After treasury fees on interest, Alice receives her due. Remaining amount (e.g., $1020 - ~$1004.11 - liquidation costs) is returned to Bob.

### Example: NFT Renting Default

- Bob rents a CryptoPunk for 7 days (total rental fee 70 USDC, prepayment 73.5 USDC including buffer).
- Bob fails to 'return' the NFT or there's an issue with fee settlement by the end of the grace period.
- The full 70 USDC rental is claimed by Alice (the lender), minus treasury fees on the 70 USDC rental portion. Alice's CryptoPunk 'user' status for Bob is revoked, and the escrowed NFT can be returned to Alice under the rental settlement rules, extra buffere amount will also go to treasury.

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
- If the loan is an NFT rental, preclose changes user rights rather than transferring the underlying NFT to the borrower. For both ERC-721 and ERC-1155 rentals, the NFT must be held in the appropriate Vaipakam Escrow for that active rental position, with the Vaipakam admin/escrow controller as the escrow custodian/owner while escrowed. During preclose transfer, the platform revokes the original borrower’s temporary user rights and assigns temporary user rights to the new borrower only.
- The relevant Vaipakam NFTs must be updated to reflect the new state of the position.

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
- For ERC-721 rentals, the NFT itself remains in the appropriate Vaipakam Escrow under admin/escrow-controller custody; only the borrower’s ERC-4907 `user` access is removed.
- For ERC-1155 rentals, the NFT remains controlled by the appropriate Vaipakam Escrow under admin/escrow-controller custody; only the borrower’s temporary user right is removed.

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
8. If the transferred obligation is an NFT rental, the platform keeps or moves the ERC-721/1155 NFT into the appropriate Vaipakam Escrow for the continuing rental position, with the Vaipakam admin/escrow controller retaining escrow custody/owner control. Alice’s temporary user rights are revoked, and equivalent user rights are assigned to Ben for the remaining permitted rental term. Ben receives only ERC-4907-style user rights and never receives custody or ownership of the NFT itself.

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
- All normal offer-creation, offer-acceptance, sanctions, KYC, asset, escrow, and matching checks apply to the offsetting offer flow.

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
- who escrows or locks funds during offer creation
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
- escrow movements
- exact value owed to treasury
- exact lender claimable amount created
- exact borrower claimable amount created
- whether principal stays live in a new loan or becomes immediately claimable
- NFT state transitions
- revert conditions
- behavior if the linked offer is cancelled, expires, or is front-run by another state change
- whether duplicated sanctions / country / KYC / USD-valuation logic is sourced from a shared internal library rather than copied across facets
- whether temporary or transitional loan cleanup is sourced from a shared internal helper / library rather than manual repeated cleanup logic
- which standardized protocol constants are used for time and financial math instead of magic literals
- which custom errors are emitted for distinct failure cases so off-chain clients can diagnose failures cleanly
- whether a same-transaction collateral top-up path is supported when that is the only way to keep a transfer or offset flow above the required Health Factor, without weakening lender protections
- whether a given preclose path intentionally relies on same-asset-type continuity and same-or-higher collateral sizing instead of a fresh transfer-time LTV / Health Factor gate, and that choice is made explicit in both code and docs

## 10. Governance and VPFI Token Rollout

VPFI token deployment begins in Phase 1 through the token contract and minting path. VPFI-related fee-utility flows may also be integrated where explicitly described, while governance remains Phase 2 scope. The following section separates token deployment, fee utility, and later governance rollout details.

### Phase 1 Token Deployment and Minting

- **Token Contract (VPFI):** `VPFI` is the Vaipakam DeFi Token. In Phase 1, the token contract, cap, initial mint, and minting-control path may be deployed and wired, but governance usage remains deferred to Phase 2.
- **Core Token Parameters:**
  - Name: `Vaipakam DeFi Token`
  - Symbol: `VPFI`
  - Decimals: `18`
  - Hard supply cap: `230,000,000` VPFI
  - Initial mint: `23,000,000` VPFI (exactly 10% of the cap)
  - Minting authority: timelocked treasury / multi-sig controlled mint path only; no unrestricted EOA minting
- **Phase 1 Scope:** The Phase 1 token rollout is limited to deployment, registration, initial minting, future mint-cap transparency, and treasury / admin mint control where explicitly implemented.

### Governance (Phase 2)

- **Governance Token (VPFI):** VPFI becomes the governance and broader utility token in Phase 2.
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
- **Lender Yield Fee Discount:** Lenders who maintain sufficient VPFI in their user escrow on the respective lending chain are eligible for the tiered `Yield Fee` discount schedule defined by the tokenomics spec.
  - The lender discount is measured as a time-weighted average over the life of the loan, not from only the VPFI balance present at the final claim moment.
  - Escrow-held VPFI automatically counts as staked under the unified escrow-based staking model.
  - The active tier schedule is:
    | Tier | Escrowed VPFI Balance | Discount | Lender Effective Yield Fee |
    | ------ | -------------------------- | -------: | -------------------------: |
    | Tier 1 | `>= 100` and `< 1,000` | `10%` | `0.9%` |
    | Tier 2 | `>= 1,000` and `< 5,000` | `15%` | `0.85%` |
    | Tier 3 | `>= 5,000` and `<= 20,000` | `20%` | `0.8%` |
    | Tier 4 | `> 20,000` | `24%` | `0.76%` |

  - The lender must explicitly opt in through a single platform-level user setting that consents to using escrowed VPFI for protocol fee discounts.
  - In the frontend, this common fee-discount consent should be managed from the app-level user area, surfaced on the `Dashboard`, rather than being anchored to an individual offer, loan, or VPFI-purchase step.
  - This consent should be a common user preference rather than an offer-level or loan-level toggle.
  - Only when that platform-level consent is active and sufficient VPFI is available in escrow should the system automatically deduct the discounted fee amount in VPFI from escrow and transfer it to treasury.

- **Borrower Loan Initiation Fee Discount:** Borrowers who maintain sufficient VPFI in their user escrow on the respective lending chain are eligible for the tiered borrower-side `Loan Initiation Fee` discount schedule defined by the tokenomics spec.
  - Escrow-held VPFI also counts as staked under the unified escrow-based staking model.
  - The active tier schedule is:
    | Tier | Escrowed VPFI Balance | Discount | Borrower Effective Initiation Fee |
    | ------ | -------------------------- | -------: | --------------------------------: |
    | Tier 1 | `>= 100` and `< 1,000` | `10%` | `0.09%` |
    | Tier 2 | `>= 1,000` and `< 5,000` | `15%` | `0.085%` |
    | Tier 3 | `>= 5,000` and `<= 20,000` | `20%` | `0.08%` |
    | Tier 4 | `> 20,000` | `24%` | `0.076%` |

  - The borrower must explicitly opt in through that same single platform-level user setting consenting to the use of escrowed VPFI for protocol fee discounts.
  - Offer-level or loan-level consent is not required for the borrower discount once the platform-level setting has been enabled.
  - Only when that platform-level consent is active, the lending asset is liquid, and sufficient VPFI is available should the system deduct the full `0.1%` fee equivalent in VPFI from the borrower's escrow.
  - The deducted VPFI is held in protocol custody for the life of the loan rather than sent immediately to Treasury.
  - On proper close through normal repayment, borrower preclose, or refinance, the borrower earns a time-weighted rebate based on the discount tiers actually held during the loan window. The rebate is paid in VPFI alongside the ordinary borrower claim.
  - On default or HF-based liquidation, the rebate is forfeited and the full held VPFI becomes Treasury's share.
  - The borrower-side acquisition flow is described in the dedicated `docs/BorrowerVPFIDiscountMechanism.md` specification.

- **Borrower VPFI Acquisition Flow:** For the borrower-side discount path:
  - the frontend should provide a dedicated `Buy VPFI` page that works from the user's preferred supported chain
  - the user should not be required to manually switch to the canonical chain before buying
  - purchased VPFI should be delivered to the borrower's wallet on that same preferred chain, not auto-deposited into escrow
  - if canonical-chain or bridge infrastructure is used under the hood, that complexity should be abstracted from the user-facing purchase flow
  - if the purchase path settles through a Base-chain receiver, VPFI must be minted or released only after that receiver actually receives ETH, and the amount delivered must be based on actual received ETH rather than a quoted amount
  - moving VPFI from wallet to user escrow should remain an explicit user-initiated action, with the frontend facilitating that step after purchase
  - the Phase 1 `30,000 VPFI` wallet cap is a per-chain cap, not one shared global wallet cap across every chain
  - VPFI moved into user escrow on a given chain should count toward fee-discount eligibility only for loans initiated on that same chain
  - the shared platform-level consent for using escrowed VPFI toward `Yield Fee` and `Loan Initiation Fee` discounts should be shown in the app on `Dashboard`, so users can manage the setting independently of the `Buy VPFI` flow
- **Escrow-Based Staking:** Any VPFI held in a user's escrow on a lending chain should be treated as staked for tokenomics purposes and should accrue the escrow-based `5% APR` staking rewards defined in the tokenomics spec. That escrow balance also counts toward tiered fee discounts only for loans initiated on that same chain.
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
  - Exchange Listings & Market Making: `14%` (`32,200,000`)
  - **Early Fixed-Rate Purchase Program:** `1%` (`2,300,000`) sold at `1 VPFI = 0.001 ETH` under the capped purchase model
  - **Platform Interaction Rewards:** `30%` (`69,000,000`)
    - front-loaded emission schedule with annualized stages of `32%`, `29%`, `24%`, `20%`, `15%`, `10%`, then `5%` terminal rate
    - `50%` of each daily interaction pool goes to lenders, proportional to daily interest earned
    - `50%` goes to borrowers, proportional to daily interest paid
    - borrower-side interaction rewards are earned only on clean full repayment
    - the daily denominator is **protocol-wide global daily interest**, not local-chain-only interest
    - non-canonical chain deployments report their finalized daily interest totals to canonical `Base` via LayerZero messaging
    - canonical `Base` aggregates those reports into one `dailyGlobalInterestUSD` value and broadcasts the finalized denominator back to every supported chain
    - users still claim locally on their active lending chain; cross-chain messaging is used only to synchronize the global denominator and related reward funding, not to make the loan lifecycle cross-chain
    - once the `69,000,000` VPFI interaction-reward pool is exhausted, this category stops emitting
  - **Staking Rewards:** `24%` (`55,200,000`)
    - distributed through the staking contract using a pull model
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

- **Token Standard:** `LayerZero OFT V2` omnichain fungible token model.
- **Purpose:** Maintain one global VPFI supply cap across all supported chains rather than independent per-chain supply silos.
- **Primary Canonical Deployment Chain:** `Base`
- **Additional Phase 1 Rollout Chains:** `Arbitrum`, `Polygon`, `Optimism`, and `Ethereum mainnet`.
- **Deployment Flow:**
  1. Deploy `VPFIToken.sol` as the canonical OFT deployment on `Base`.
  2. Mint the initial `23,000,000` VPFI to the secure multi-sig and timelock-controlled treasury setup.
  3. Deploy connected peer contracts on the additional supported chains.
  4. Configure LayerZero peers so omnichain transfers preserve a single global supply model.
  5. Keep token symbol and metadata consistent as `VPFI` across supported chains.
- **Architecture Clarification:** `VPFI` is cross-chain, and the interaction-reward denominator / reward-funding path also uses cross-chain messaging so each chain can claim against one protocol-wide daily interest total. The Vaipakam lending / borrowing / rental core protocol itself still remains single-chain per deployment, with a separate Diamond deployment on each supported network. Loans, offers, collateral, repayment, liquidation, preclose, refinance, and keeper actions always remain local to the network of that specific Diamond instance.
- **Canonical Address Rule:** The Base deployment is the documented source of truth and should be published in `docs/` and surfaced through Vaipakam transparency / dashboard tooling.

## 11. Notifications and Alerts

Effective communication is key for user experience and risk management. Vaipakam supports event-driven notification surfaces and Health-Factor alerts for liquid loans.

### Implementation

- **Mechanism:** An off-chain service will monitor key smart contract events. When a relevant event occurs, this service will trigger SMS/Email notifications to the concerned users.
- **Providers:** The platform will use established third-party APIs for sending SMS (e.g., Twilio) and Emails (e.g., SendGrid).
- **User Registration:** Users will need to provide and verify their phone number and/or email address in their Vaipakam profile to receive notifications. Opt-in/opt-out preferences for non-critical notifications can be managed.
- **Health-Factor Alert Subscriptions:** Borrowers can subscribe to per-loan HF threshold alerts, such as `HF below 1.20`, for liquid loans they own. The watcher reprices subscribed loans on a timed sweep and sends an alert only when the configured threshold is newly crossed.
- **HF Alert Channels:** Telegram alerts are delivered through the official Vaipakam bot linked to the wallet. Push Protocol is supported as a decentralized opt-in channel; the send path may remain staged until the production Push channel is registered.
- **Autonomous Liquidation Watcher:** Operators may enable a keeper mode on the same watcher so it submits permissionless `triggerLiquidation` transactions when subscribed loans cross HF `1.0`. This mode is disabled by default and requires explicit worker secrets plus a funded keeper EOA per target chain.
- **Funding:** The cost of sending these SMS/Email notifications will be covered by the Vaipakam platform, funded from its treasury.
- **Criticality:** Notifications will be primarily for critical events to avoid alert fatigue.
- **Style:** Notifications should remain concise, actionable, and focused on essential events.
- **Types of Notifications (Examples):**
  - **Loan Initiation:** Offer accepted, loan now active.
  - **Repayment Reminders:** Sent a few days before the loan due date and at the start of the grace period. (Paid by platform)
  - **LTV Warnings (for Liquid Collateral):** Alerts when LTV approaches critical levels (e.g., 80%, 85%). (Paid by platform)
  - **Successful Repayment:** Confirmation that a loan has been repaid.
  - **Funds/Collateral Claimable:** Notification when repayment is made and funds/collateral are ready for the counterparty to claim. (Paid by platform)
  - **Liquidation/Default Events:** Notification of loan default or initiation of liquidation. (Paid by platform)
  - **Offer Matched/Expired/Cancelled.**
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
- **Transaction History:** Record of all platform interactions.
- **Activity Page:** A dedicated Activity page should be available inside the app so users can review recent platform interactions, lifecycle events, and account activity in one place.
- **Identity Labels:** Where wallet addresses appear in the dashboard, Activity, loan details, offer book, or profile chip, the frontend should resolve and display ENS / Basenames handles when available, while falling back silently to shortened addresses.
- **Liquidation Price View:** For liquid active loans, Loan Details should show the collateral-asset price at which HF reaches `1.0`, both as an absolute price and a percentage move from current price. This view should stay hidden for illiquid loans where no oracle-based liquidation price exists.
- **Approval Management:** Profile should include an Approvals surface listing ERC-20, ERC-721, and ERC-1155 allowances granted to the Vaipakam Diamond, grouped by principal-eligible, collateral-eligible, and prepay-eligible assets, with one-click revoke actions.
- **VPFI Token Management:** In Phase 1, this may include token address, supply, mint/transparency references, the dedicated `Buy VPFI` flow, wallet-to-escrow funding guidance, borrower discount eligibility views where exposed, and the shared fee-discount consent control surfaced in `Dashboard`. Governance and broader claimable-reward tools remain Phase 2 scope.
- **Notification Settings:** Manage preferences for SMS/Email alerts.
- **Analytics:** Basic analytics on lending/borrowing performance.
- **Data Refresh:** The dashboard will update periodically (e.g., every minute or on user action) to reflect on-chain changes.

## 13. Technical Details

### Blockchain and Networks (Phase 1)

- **Supported Networks:** The target Phase 1 per-network deployment set is Ethereum mainnet, Base, Polygon, Arbitrum, and Optimism. At present, the live Diamond deployment is only on Sepolia; the production-network Diamonds have not yet been deployed.
- **Intra-Network Operations:** All aspects of a single loan (offer, acceptance, collateral, repayment) occur on the _same chosen network_.
- **Deployment Model:** Vaipakam uses separate Diamond deployments on each supported network — each chain hosts its own independent protocol instance. There is no cross-chain loan lifecycle.

### Smart Contracts

- **Language:** Solidity (latest stable version, e.g., 0.8.x, specify version like 0.8.29 if decided).
- **Core Contracts (Examples):**
  - `VaipakamOfferManagement.sol`: Handles creation, cancellation, and matching of lender/borrower offers.
  - `VaipakamLoanManagement.sol`: Manages active loans, repayments, defaults, and liquidations.
  - `VaipakamEscrow.sol`: Holds collateral, ERC-721/1155 rental NFTs, and funds during various stages.
  - `VaipakamNFT.sol`: The ERC-721 contract responsible for minting and managing Vaipakam NFTs.
  - `VaipakamGovernance.sol` (Phase 2): Manages proposals and voting.
  - `VaipakamTreasury.sol`: Collects and manages platform fees.
  - `VaipakamStaking.sol` (Phase 2): Manages VPFI token staking and reward distribution.
- **Libraries:**
  - OpenZeppelin Contracts: For robust implementations of ERC-20, ERC-721, ERC-1155 (if Vaipakam mints its own utility NFTs beyond offer/loan representations), AccessControl, ReentrancyGuard, and potentially Governor.
- **Security Considerations:**
  - **Audits:** Smart contracts will undergo thorough security audits by reputable third-party firms before mainnet deployment on each network.
  - **Upgradeable Proxies:** Utilize UUPS (Universal Upgradeable Proxy Standard) proxies for core contracts to allow for future upgrades and bug fixes without disrupting ongoing operations or requiring data migration. Governance-controlled upgrades are planned for Phase 2, while Phase 1 upgrades remain available through the initial admin/multi-sig model described in the security policy.
  - **Escrow Upgrade Policy:** User escrows must not continue to be usable on outdated mandatory versions. If an escrow implementation upgrade is classified as required, user interactions through an older escrow version must be blocked by the protocol until that escrow is upgraded. Escrow upgrades are not intended to be pushed automatically to every existing user escrow because that would create significant network-fee overhead. Instead, the frontend must detect outdated escrows and require the user to submit their own escrow-upgrade transaction before any further protected interaction is allowed. For non-critical upgrades, the frontend may still prompt users to upgrade, but blocking behavior should only be enforced when the upgrade is marked mandatory.
  - **Reentrancy Guards:** Applied to all functions involving external calls or asset transfers.
  - **Access Control:** Granular roles (e.g., `LOAN_MANAGER_ROLE`, `OFFER_MANAGER_ROLE`, `TREASURY_ADMIN_ROLE`) managed via OpenZeppelin's AccessControl. Roles will be assigned initially by the contract deployer/owner, with plans to transition control to governance in Phase 2 where appropriate.
  - **Three-Role Governance Handover:** Privileged production surfaces should be split between a Governance Safe, a Guardian Safe, and KYC Ops. The Governance Safe controls slow admin surfaces through a 48-hour timelock. The Guardian Safe can pause quickly during incidents but cannot unpause. KYC Ops holds only the user-tier operational role where that role is active.
  - **OApp Guardian Pause:** LayerZero OApps and VPFI bridge-related contracts should allow Guardian or Owner pause, but unpause must remain Owner / Timelock controlled.
  - **Emergency Updates:** Critical security patches may be fast-tracked through the initial admin/multi-sig model when needed to protect user funds or protocol integrity, with those emergency powers limited to critical fixes.
  - **Batch Processing:** Support for batch processing of certain operations where feasible to optimize gas costs. Staking reward batch processing is Phase 2 scope.

### Frontend

- **Framework:** React with wagmi v2 and viem for wallet connection, contract reads/writes, multicall batching, and direct JSON-RPC control.
- **Wallet UX:** ConnectKit is the wallet picker layer on top of wagmi v2. Mobile wallet selections should open wallet apps directly through deep links, while QR pairing remains available for cross-device use.
- **Legacy Provider Policy:** The frontend should not retain ethers.js compatibility shims or ethers as a production dependency after the wagmi / viem migration.
- **State Management:** Robust state management solution (e.g., Redux, Zustand).
- **Languages:** Initial launch in English, with plans for multilingual support (e.g., Spanish, Mandarin) in subsequent updates.
- **API Standards:** Frontend will interact with smart contracts using standardized data formats (e.g., JSON-like structs or arrays returned by view functions).

### Public View Functions for Analytics, Transparency, and Integrations

Phase 1 should expose a clean public read-only surface for dashboards, DefiLlama-style trackers, portfolio apps, auditors, regulators, and other protocol integrations. These functions should be pure `view` functions, RPC-friendly, and easy to aggregate through multicall.

General design requirements:

- the analytics and transparency surface should remain read-only and should not require wallet connection just to fetch protocol-wide metrics
- the preferred implementation is to add lightweight public view helpers to existing facets where possible
- if a later phase needs a dedicated analytics-oriented facet, that surface should remain minimal, read-only, and composable
- values intended for dashboards, listings, and external analytics should be easy to verify against underlying on-chain state and events
- these helper functions add real value for DefiLlama-style TVL trackers, Dune-style analytics, portfolio applications, auditors, regulators, and other DeFi integrations
- these functions should be multicall-friendly so public dashboards can batch reads efficiently

#### 1. Protocol-Wide Metrics

Highest priority public metrics should include:

```solidity
function getProtocolTVL() external view returns (
    uint256 tvlInUSD,
    uint256 erc20CollateralTVL,
    uint256 nftCollateralTVL
);

function getProtocolStats() external view returns (
    uint256 totalUniqueUsers,
    uint256 activeLoansCount,
    uint256 activeOffersCount,
    uint256 totalLoansEverCreated,
    uint256 totalVolumeLentUSD,
    uint256 totalInterestEarnedUSD,
    uint256 defaultRateBps,           // e.g. 250 = 2.5%
    uint256 averageAPR
);

function getUserCount() external view returns (uint256);
function getActiveLoansCount() external view returns (uint256);
function getActiveOffersCount() external view returns (uint256);
function getTotalInterestEarnedUSD() external view returns (uint256);
```

These functions are intended to support the Vaipakam public analytics dashboard and external TVL / protocol-tracker integrations.

#### 2. Treasury and Revenue Metrics

Treasury, fee, and revenue views should include:

```solidity
function getTreasuryMetrics() external view returns (
    uint256 treasuryBalanceUSD,
    uint256 totalFeesCollectedUSD,    // 1% interest + 1% late fees
    uint256 feesLast24hUSD,
    uint256 feesLast7dUSD
);

function getRevenueStats(uint256 days) external view returns (uint256 totalRevenueUSD);
```

These functions are especially useful for treasury transparency, tokenomics reporting, listings, and public revenue dashboards.

#### 3. Lending and Offer Metrics

Loan and offer analytics helpers should include:

```solidity
function getLoanDetails(uint256 loanId) external view returns (/* full Loan struct */);
function getOfferDetails(uint256 offerId) external view returns (/* full Offer struct */);

function getActiveLoansPaginated(uint256 offset, uint256 limit) external view returns (uint256[] memory loanIds);
function getActiveOffersByAsset(address asset, uint256 offset, uint256 limit) external view returns (uint256[] memory offerIds);

function getLoanSummary() external view returns (
    uint256 totalActiveLoanValueUSD,
    uint256 averageLoanDuration,
    uint256 averageLTV
);
```

These functions help public dashboards, market pages, listing views, and research tools inspect protocol activity without forcing expensive full-history scans for every page load.

#### 4. NFT and Escrow Metrics

For ERC-4907-style rentals and escrow analytics, the protocol should expose:

```solidity
function getEscrowStats() external view returns (
    uint256 totalNFTsInEscrow,
    uint256 activeRentalsCount,
    uint256 totalRentalVolumeUSD
);

function getNFTRentalDetails(uint256 tokenId) external view returns (/* rental struct */);

function getTotalNFTsInEscrowByCollection(address collection) external view returns (uint256);
```

These functions support rental analytics, escrow transparency, and collection-level monitoring.

#### 5. Oracle and Risk Metrics

Risk and asset-support helpers should include:

```solidity
function getAssetRiskProfile(address token) external view returns (
    uint256 ltvBps,
    uint256 liquidationThresholdBps,
    uint256 currentPriceUSD,
    bool isLiquid,                    // true = sufficient DEX liquidity
    bool isSupported
);

function getIlliquidAssets() external view returns (address[] memory);
function isAssetSupported(address token) external view returns (bool);
```

These functions help external dashboards and integrations understand current support, liquidity classification, and collateral risk configuration on the active network.

Additional oracle-hardening views should expose active per-feed overrides and configured secondary-oracle settings where practical, including:

```solidity
function getFeedOverride(address feed) external view returns (
    uint256 maxStaleness,
    int256 minValidAnswer
);

function getSecondaryOracleConfig() external view returns (
    address tellorOracle,
    address api3ServerV1,
    address diaOracleV2,
    uint16 maxDeviationBps,
    uint40 maxStaleness
);
```

These readbacks let operators, auditors, and frontend safety surfaces verify that high-value assets are using the intended freshness floors and secondary-oracle deviation bounds.

#### 6. User-Specific Metrics

For portfolio tracking and wallet integrations, the protocol should expose:

```solidity
function getUserSummary(address user) external view returns (
    uint256 totalCollateralUSD,
    uint256 totalBorrowedUSD,
    uint256 availableToClaimUSD,
    uint256 healthFactor,             // >1 = safe
    uint256 activeLoanCount
);

function getUserActiveLoans(address user) external view returns (uint256[] memory loanIds);
function getUserActiveOffers(address user) external view returns (uint256[] memory offerIds);
function getUserNFTsInEscrow(address user) external view returns (uint256[] memory tokenIds);
```

These remain public view functions, but frontend and integration usage should still follow the broader privacy principle of not building public PII-style dashboards around individual identity.

#### 7. Compliance and Transparency Helpers

For auditors, regulators, researchers, and public transparency tooling, the protocol should also expose:

```solidity
function getProtocolHealth() external view returns (
    uint256 utilizationRateBps,
    uint256 totalCollateralUSD,
    uint256 totalDebtUSD,
    bool isPaused
);

function getBlockTimestamp() external view returns (uint256); // for freshness checks
```

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
- **Liquidation Invariants:** Tests must assert that liquidation swap calldata uses the protocol-computed oracle-derived minimum output and that callers cannot influence the slippage floor.
- **Oracle-Hardening Tests:** Tests should cover per-feed override admin gating, staleness override behavior, minimum-answer floor behavior, secondary-oracle agreement, divergence, stale secondary data, and missing secondary data.
- **Governance-Handover Tests:** Tests should verify that Timelock, Guardian, and KYC Ops roles are installed correctly and that the deployer EOA retains no residual privileged authority after handover.

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
- [contracts/test/LoanFacetTest.t.sol](contracts/test/LoanFacetTest.t.sol) — initiateLoan, getLoanDetails, hasFallbackConsent.
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
- [contracts/test/AdminFacetTest.t.sol](contracts/test/AdminFacetTest.t.sol) — treasury / 0x proxy / pause toggles.
- [contracts/test/TreasuryFacetTest.t.sol](contracts/test/TreasuryFacetTest.t.sol) — claimTreasuryFees.
- [contracts/test/TreasuryMintVPFITest.t.sol](contracts/test/TreasuryMintVPFITest.t.sol) — VPFI mint for treasury-funded flows.
- [contracts/test/EscrowFactoryFacetTest.t.sol](contracts/test/EscrowFactoryFacetTest.t.sol) — per-user escrow proxy creation, mandatory upgrade gating, versioned upgrade event.
- [contracts/test/VaipakamNFTFacetTest.t.sol](contracts/test/VaipakamNFTFacetTest.t.sol) — position NFT mint / update / burn lifecycle.
- [contracts/test/MetricsFacetTest.t.sol](contracts/test/MetricsFacetTest.t.sol) — read-only analytics getters.
- [contracts/test/AccessControlFacetTest.t.sol](contracts/test/AccessControlFacetTest.t.sol) — role grants / revocations / emergency revoke.
- [contracts/test/AdminFacetTest.t.sol](contracts/test/AdminFacetTest.t.sol) / [PerAssetPauseTest.t.sol](contracts/test/PerAssetPauseTest.t.sol) — per-asset pause ON → blocks, OFF → unblocks.
- [contracts/test/PauseGatingTest.t.sol](contracts/test/PauseGatingTest.t.sol) — whenNotPaused modifier coverage across 15+ facet entrypoints.
- [contracts/test/VPFIDiscountFacetTest.t.sol](contracts/test/VPFIDiscountFacetTest.t.sol) / [VPFIDiscountBoundariesTest.t.sol](contracts/test/VPFIDiscountBoundariesTest.t.sol) — tier table, escrow deposit / withdraw, fee discount application.
- [contracts/test/VPFITokenFacetTest.t.sol](contracts/test/VPFITokenFacetTest.t.sol) / [VPFIOFTRoundTripTest.t.sol](contracts/test/VPFIOFTRoundTripTest.t.sol) — canonical + bridged VPFI mechanics.
- [contracts/test/StakingAndInteractionRewardsTest.t.sol](contracts/test/StakingAndInteractionRewardsTest.t.sol) / [StakingRewardsCoverageTest.t.sol](contracts/test/StakingRewardsCoverageTest.t.sol) / [InteractionRewardsCoverageTest.t.sol](contracts/test/InteractionRewardsCoverageTest.t.sol) / [InteractionRewardCapTest.t.sol](contracts/test/InteractionRewardCapTest.t.sol) — 5% APR accrual, interaction rewards emission schedule, pool-cap truncation.
- [contracts/test/CrossChainRewardPlumbingTest.t.sol](contracts/test/CrossChainRewardPlumbingTest.t.sol) / [RewardOAppDeliveryTest.t.sol](contracts/test/RewardOAppDeliveryTest.t.sol) — canonical broadcast + mirror aggregate reporting.
- [contracts/test/GracePeriodTiersTest.t.sol](contracts/test/GracePeriodTiersTest.t.sol) — default grace-period tier transitions.
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
- [contracts/test/invariants/FundsConservation.invariant.t.sol](contracts/test/invariants/FundsConservation.invariant.t.sol) / [EscrowSolvency.invariant.t.sol](contracts/test/invariants/EscrowSolvency.invariant.t.sol) — no phantom funds, escrow balances conserved.
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
- [contracts/test/invariants/EscrowUniqueness.invariant.t.sol](contracts/test/invariants/EscrowUniqueness.invariant.t.sol) — one escrow per user, no dupes.
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
- **Loan Durations:** 1 day to 1 year.

## 15. NFT Verification Tool

### Purpose

A web-based tool, integrated as a dedicated page within the Vaipakam frontend, to allow anyone to track and validate the authenticity and status of NFTs minted by the Vaipakam platform (Vaipakam NFTs).

### Features

- **NFT Details Display:**
  - Input: Contract Address and Token ID of a Vaipakam NFT.
  - Output: Displays all associated on-chain metadata (e.g., offer ID, loan ID, involved assets, collateral details, interest rate/rental fee, duration, current status - "Offer Created," "Loan Active," "Repaid," "Defaulted," etc.).
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
    - **Tier 0 (No KYC/AML):** For transactions where the principal loan amount (for ERC-20 loans using liquid assets valued in USDC) or total rental value (for NFT renting, valued in USDC) is less than $1,000 USD.
    - **Tier 1 (Limited KYC):** For transaction values between $1,000 and $9,999 USD. This might involve basic identity verification.
    - **Tier 2 (Full KYC/AML):** For transaction values of $10,000 USD or more. This will require more comprehensive identity verification and AML checks.
  - **Valuation for KYC Thresholds:**
    - **ERC-20 Loans:** The USDC equivalent value of the _principal amount being lent_ (if liquid) determines the transaction value. If the principal asset is illiquid, or if collateral is illiquid/NFT, these are considered $0 for this specific calculation, relying on the value of the liquid component.
    - **NFT Renting:** The _total rental value_ (daily rate \* duration, converted to USDC equivalent) determines the transaction value.
    - The platform will use Chainlink oracles for converting liquid asset values to USDC for these threshold checks.
- **Implementation Timing:** Real KYC/AML enforcement is not part of the effective Phase 1 launch behavior. Phase 1 keeps KYC checks in pass-through mode under the Phase 1 flag, while later governance or admin decisions may choose to activate the retained KYC framework.
- **Address-Level Sanctions Screening:** Where a supported on-chain sanctions oracle is configured for the active chain, the protocol should screen new-business boundaries: offer creation checks the caller, and offer acceptance checks both the acceptor and the original offer creator. If a checked address is flagged, the transaction must revert. Wind-down actions such as repayment, claims, add-collateral, and other existing-loan exits should remain available so non-sanctioned counterparties are not trapped in open positions.
- **Sanctions Oracle Availability:** Sanctions oracle configuration is per chain and optional. Chains without a configured oracle should behave as no-op for this check. Oracle read failures should fail open rather than bricking all protocol actions during a vendor outage.
- **Terms Acceptance Gate:** App routes may be gated behind a versioned on-chain Terms of Service acceptance. `currentTosVersion == 0` represents a disabled/testnet state. Once activated, users must accept the current Terms version and content hash before using `/app` routes; version bumps or hash changes invalidate prior acceptances.
- **Privacy Policy and Data Rights:** Public `/terms` and `/privacy` pages should be available without a wallet. Browser-local Vaipakam diagnostic and consent data should support user download and deletion flows, while clearly explaining that public blockchain data cannot be deleted by frontend action.
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
  - Health Factor defined as: `(Value of Liquid Collateral in USDC) / (Value of Borrowed Amount in USDC)`
  - The minimum Health Factor (e.g., 150%) must be maintained post-withdrawal.
- **Process:** Borrower requests withdrawal of a specific amount of collateral. The system checks if the Health Factor remains above the threshold. If so, the excess collateral is released.

### Allow Borrower to Choose New Lender with Compatible Offer While Protecting the Original Lender (Refinance - ERC-20 Loans Only)

- **Purpose:** To enable a borrower to switch their existing loan to a new lender while preserving the original lender's expected economics and protection. The new lender's offer may still be attractive to the borrower (for example, lower interest rate or different collateral sizing), but the refinance path must not disadvantage the original lender.
- **Phase 1 Scope:** Refinance applies only to active ERC-20 loans. NFT rental loans and other non-ERC20 loan/rental positions are not eligible for refinance in Phase 1.
- **Borrower Position Authority:** The wallet that initiates refinance must be the current borrower and the current `ownerOf` the borrower-side Vaipakam NFT for that loan. A rented `userOf` address, approved keeper, or other third-party helper must not be sufficient to start a refinance flow unless a later protocol phase explicitly broadens that authority.
- **Atomic Refinance Clarification:** By the time the borrower calls `refinanceLoan(oldLoanId, borrowerOfferId)`, the replacement lender has already accepted the borrower's new borrower offer and the replacement loan already exists as a standalone live loan. The refinance transaction itself is then a single atomic settlement step that repays the old lender, releases the original collateral, updates the old-loan NFTs, and closes the old loan. Because there is no protocol waiting state between "refinance started" and "refinance completed," Phase 1 refinance does not require a borrower-side Vaipakam NFT transfer lock.
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
- If the new refinance offer implies lower lender-side economics for the original lender, the borrower must cover the resulting shortfall as part of the refinance transaction.
- The refinance path may improve the borrower's continuing terms with the new lender, but that improvement cannot be funded by taking value away from the original lender.

---

**Note on "Illiquid" Definition for LTV and KYC:**
For utmost clarity:

- Any NFT is considered illiquid with a $0 platform-assessed value for LTV and collateral valuation. For KYC, the _rental value in USDC_ is used for NFT renting.
- An ERC-20 token is illiquid for a given Phase 1 network deployment if the protocol cannot confirm both a valid active-network price path and a sufficiently deep v3-style concentrated-liquidity AMM `asset/WETH` liquidity pool on the current active network. Liquidity must be judged only from the current network's own oracle and pool availability. If the current network fails that check, the asset remains illiquid on that network; Ethereum mainnet must not be queried as a verification fallback, must not be treated as a substitute source of liquidity, and must not trigger any mainnet-redirect requirement for that asset. Illiquid ERC-20s also have a $0 platform-assessed value for LTV. For KYC, if the _lent/borrowed asset itself_ is illiquid, it's $0, and KYC is based on other liquid components if any. If the collateral is illiquid, it doesn't add to the transaction value for KYC if the primary lent/borrowed asset is liquid.

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
- No common escrow account and only seperate Escrow account for each users (via clone factory for gas efficiency) would implemented which will then be managed by Vaipakam App. This is to avoid commingling of funds.
- Existing user escrows should not be silently mass-upgraded by the protocol because that would create unnecessary network-fee overhead. Instead, when an escrow upgrade is marked as mandatory, interactions using older escrow versions must be blocked and the frontend must require the user to upgrade their own escrow before continuing. If an upgrade is not critical, the frontend may leave the upgrade optional and simply prompt the user.
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
