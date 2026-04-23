# Vaipakam | Decentralized P2P Lending, Borrowing and NFT Rental Platform (Phase 1)

## Technical Project Details for Developers

Vaipakam is a decentralized peer-to-peer (P2P) lending and borrowing platform built on Ethereum, and Layer 2 networks Polygon and Arbitrum. It facilitates lending and borrowing of ERC-20 tokens and rentable ERC-721/1155 NFTs, using any ERC-20 or NFT assets as collateral. The platform mints NFTs to represent offers and loans, ensuring transparency and traceability. This document outlines the technical architecture, smart contract interactions, and operational examples for Phase 1.

## 1. Supported Assets and Networks (Phase 1)

### Lending and Collateral Assets

**Lending Assets:**

- **ERC-20 Tokens:** Any ERC-20 token (e.g., USDC, ETH, WBTC) on Ethereum, Polygon, or Arbitrum.
- **Rentable ERC-721/1155 NFTs:** Unique NFTs that are ERC-4907 compliant (like NFTs from Warena and Axie Infinity) which can be rented (NFTs in which `setUser` and `userOf` functions can be called) with lender-specified daily rental charges.
  - For ERC-721 tokens, the token is transferred into the Vaipakam Escrow contract during the rental period. This gives the Vaipakam admin/escrow controller escrow-controlled owner/custody access so it can assign, revoke, or reassign only ERC-4907 `user` rights while keeping the borrower limited to temporary `user` access. The borrower never receives custody or ownership of the ERC-721 token itself.
  - For ERC-1155 tokens, the tokens will be held in the Vaipakam Escrow contract during the rental period. The Vaipakam admin/escrow controller assigns ERC-4907-style user rights to the borrower while the token remains escrow-controlled, so a borrower preclose or transfer changes only the temporary user assignment and not the underlying custody model.

**Collateral Assets:**

- Any ERC-20 tokens or ERC-721/1155 NFTs for ERC-20 Lending.
- Only ERC-20 tokens for NFT Lending/Renting.

**Supported Networks (Phase 1):**

- Ethereum Mainnet
- Polygon Network
- Arbitrum Network

_Note: For Phase 1, all lending, borrowing, and collateralization activities for a specific loan must occur on a single network (e.g., a loan initiated on Polygon must have its collateral and repayment on Polygon)._

### Asset Viability, Oracles, and Liquidity Determination

The platform distinguishes between liquid and illiquid assets, which affects how defaults and LTV calculations are handled.

- **Liquid Asset Criteria:** For Phase 1, an ERC-20 token is considered "Liquid" on a given network only if:
  1.  It has an active and reliable Chainlink Price Feed and corresponding usable DEX liquidity on that active network.
  2.  The protocol should require both reliable pricing and reliable market-liquidity evidence. For DEX liquidity, recognized on-chain DEX venues may be used, with 24 hour trading volume above $1M serving as a practical Phase 1 indicator.
  3.  Ethereum mainnet may still be used as a reference network for identifying whether the asset is broadly liquid in the ecosystem. However, if the asset is illiquid on the active network but liquid on Ethereum mainnet, the asset must not be transacted through that active-network deployment. In that case, the protocol/frontend should reject the transaction on the active network and instruct the user to transact that asset only through the Ethereum-mainnet deployment.
- **Illiquid Assets:**
  - All ERC-721 and ERC-721 NFTs are considered "Illiquid" by the platform for valuation and LTV purposes. Their platform-assessed value is $0.
  - ERC-20 tokens that do not meet both criteria for a Liquid Asset are considered "Illiquid".
- **NFT Valuation for Collateral (Lender's Discretion):**
  - The Vaipakam platform does not perform any valuation for NFT collateral due to their volatile and auction-driven nature. For LTV calculations and systematic risk assessment, NFTs used as collateral are assigned a value of zero.
  - Lenders can still specify an NFT as required collateral. The decision to accept such terms rests entirely with the borrower.
- **Oracle Usage:**
  - **Chainlink Price Feeds:** Used to provide real-time pricing for Liquid ERC-20 assets. This is crucial for LTV calculations and liquidation processes for loans with Liquid collateral.
- **Liquidity Determination Process & On-Chain Record:**
  1.  **Frontend Assessment:** The frontend interface will attempt to assess asset liquidity by checking both sides of the Phase 1 safety model: reliable pricing data (such as Chainlink feeds) and reliable market liquidity signals (such as DEX or market-data APIs), with 24-hour trading volume above $1M used as a practical indicator. The frontend should first assess the active network. Ethereum mainnet may be consulted as a reference network for identifying whether the asset is broadly liquid, but if the active network itself fails the liquidity test, the frontend must not allow the user to proceed there and should instead direct the user to Ethereum mainnet for transactions involving that asset.
  2.  **User Acceptance (Frontend - Illiquid):** If the frontend flags an asset as potentially illiquid, or if the asset is an NFT, the user (lender creating the offer or borrower providing collateral) will be presented with terms stating that the asset will be treated as illiquid (i.e., full collateral transfer on default, no LTV-based liquidation). The user must accept these terms. This acceptance is recorded.
  3.  **On-Chain Verification (Smart Contract):**
      - When an offer involving an ERC-20 asset (as a lending asset or collateral) is being created or accepted, and the frontend has _not_ marked it as illiquid, the smart contract will perform an on-chain check.
      - For Phase 1, this check should confirm both: a reliable price-validation path and a reliable market-liquidity path for the asset on the active network where the transaction is being attempted.
      - Ethereum mainnet may be used as a reference network to identify whether the asset is broadly liquid in the market, but it must not be used to authorize an active-network transaction when the active network itself fails the liquidity check.
      - In practice, that means a valid Chainlink price feed and a recognized DEX liquidity pool with sufficient usable liquidity should both be confirmed on the active network before the asset is treated as liquid for transactions on that network.
      - A later protocol phase may split these concepts more explicitly into separate statuses such as "priceable" and "liquidatable", but Phase 1 should use the stricter combined rule for safety.
      - If the active network fails this check but Ethereum mainnet passes it, the protocol should block the transaction on the active network and require the user to use Ethereum mainnet for that asset instead.
      - **On-Chain Precedence:** If the on-chain check determines the asset is illiquid (e.g., missing price feed or DEX pool), this on-chain determination overrides any prior assessment by the frontend. The user will then be required to accept the terms for illiquid assets (full collateral transfer on default).
  4.  **Explicit Storage:** For every loan, the liquidity status (Liquid or Illiquid, based on the on-chain verification and user acceptance flow) of the lending asset and collateral asset is explicitly stored in the loan's on-chain data.
  5.  **API Unavailability:** If external APIs required by the frontend for initial assessment are unavailable, or if on-chain checks face temporary issues in accessing necessary validation data (e.g., registry lookups for Chainlink), the asset will default to being treated as "Illiquid" to ensure safety. In such cases, full collateral transfer terms on default will apply, and the user must consent. No manual overrides are permitted to classify an asset as liquid if checks fail or indicate illiquidity.
- **Handling of Illiquid Assets on Default:**
  - **ERC-20 Lending with Illiquid Collateral:** If the borrower defaults, the entire illiquid ERC-20 collateral is transferred to the lender. There is no auction or DEX-based liquidation process for these assets.
  - **NFT Lending/Renting:** If the borrower defaults (e.g., fails to close the rental, before expiry), then prepaid (total rental fees + 5% buffer) ERC-20 collateral provided by the borrower is transferred to the NFT owner (lender). The original ERC-721 or ERC-1155 NFT held in Vaipakam Escrow is returned to the owner and the full buffer (5% extra) will be sent to treasury.
- **Frontend Warnings for Illiquid Assets:**
  - A clear, static warning message will be displayed in the frontend whenever a user selects or provides an asset that is determined to be illiquid (either by frontend assessment, because it's an NFT, or by on-chain verification). This warning will explicitly state that in case of default, the entire collateral will be transferred to the lender without a traditional liquidation process.
- **Prepayment for NFT Renting:**
  - For NFT renting, the borrower must lock ERC-20 tokens as collateral. This collateral will cover the total rental amount plus a 5% buffer. This entire amount is considered a prepayment. The 5% buffer is refunded to the borrower upon successful and timely rental closure of the NFT and payment of all rental fees.

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
  - Lock the collateral in the Vaipakam smart contract upon offer submission.
- **For Rentable NFTs (ERC-721/1155):**
  - Specify the desired NFT (or type of NFT), maximum acceptable daily rental charge, the ERC-20 token to be used for prepayment (rental fees + 5% buffer), and rental duration.
  - Lock the prepayment (total rental fee + 5% buffer) in ERC-20 tokens in the Vaipakam smart contract upon offer submission. Rental payments will be deducted from this prepayment.

### Process:

- Offers are created through a React-based web interface.
- All offer details are recorded on-chain for transparency and immutability.

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

- **Full Collateral Transfer for Illiquid Assets:** Users are explicitly warned that if they use or accept illiquid assets/collateral, default by the borrower will result in the full transfer of that collateral to the lender, without any LTV-based liquidation auction.
- **Full Collateral Transfer for Liquid Asset during Abnormal Periods:** When liquid assets are not able to liquidated due to any of the following conditions, then borrower's full collateral will be transferred to Lender
  - any market condition (too volatile or heavy crash)
  - any unavailability of liquid assets in the DEX pool
  - any technical issues in liquidating the assets
  - if liquidation slippage would exceed 6%; in that case the collateral-to-lending-asset conversion must not execute and the protocol must follow the full collateral transfer procedure instead
  - in this abnormal-period fallback path, the lender's economic entitlement becomes the full collateral asset through the Vaipakam NFT claim flow; the protocol does not need to push the collateral automatically in the same liquidation transaction, and the lender may later claim the collateral by presenting the Vaipakam lender NFT
- **Collateral for NFT Renting:** The collateral for NFT renting is a prepayment of total rental fees + a 5% buffer, denominated in ERC-20 tokens.

## 4. Offer Book Display

### Frontend Implementation

- **Tabs:** Separate views for ERC-20 loan offers and NFT rental offers.
- **Sorting:**
  - ERC-20 offers: Sortable by interest rate (lowest for borrowers, highest for lenders), amount, duration.
  - NFT rental offers: Sortable by daily rental rate (lowest for renters, highest for owners), duration.
- **Guidance:** Display data from the last accepted offer with similar parameters (e.g., asset type, duration) to provide users with an indication of current market rates on Vaipakam.
- **Filters:** Users can filter offers by asset type, collateral requirements (if applicable), loan/rental duration, and amount.
- **Auto-Matching (Suggestion Engine):** The frontend can suggest potentially compatible offers to users based on their currently defined preferences or draft offers.

## 5. Loan Initiation

### Initiation:

- A borrower accepts a lender’s offer, or a lender accepts a borrower’s offer, via the Vaipakam interface.
- The accepting party pays the network gas fee for the transaction that initiates the loan.

### Smart Contract Actions:

- **Collateral Locking:**
  - For ERC-20 Loans: The borrower’s collateral is locked in an escrow contract.
  - For NFT Renting: The borrower’s prepayment (total rental fees + 5% buffer in ERC-20 tokens) is confirmed as locked.
- **Asset Transfer/NFT User Assignment:**
  - For ERC-20 Loans: The principal loan amount is transferred from the lender or lender's locked funds (in the Escrow) to the borrower.
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
- 1000 USDC is transferred to Bob.
- Alice's "Vaipakam NFT" status (with lender role) is updated as "Loan Initiated".
- A new "Vaipakam NFT" is minted for Bob (status: "Loan Initiated" and role: "Borrower").

## 6. Loan Closure & Repayment

### Repayment Logic

**ERC-20 Lending:**

- Borrower repays: `Principal + Interest`.
- Interest Formula: `Interest = (Principal * AnnualInterestRate * LoanDurationInDays) / (100 * 365)`. (Note: Using 100 for rate, ensure consistent precision, e.g., rate stored as basis points).
- Late fees apply if repayment occurs after the due date but within the grace period, or if repayment is forced post-grace period.

**NFT Lending (Renting):**

- Borrower's Obligation: Ensure the NFT can be 'returned' (user status revoked by the platform) and all rental fees are paid.
- Rental Fee Payment: Rental fees are automatically deducted from the borrower's initial prepayment.
- If borrower closes rental term for NFT on time:
  - The Vaipakam Escrow contract revokes the borrower's 'user' status for the NFT.
  - The 5% buffer from the prepayment is returned to the borrower.
- The accumulated rental fees (minus the `Yield Fee`) are made available for the lender to claim.
- Late fees apply if the NFT 'rental closure' (user status revocation) is delayed beyond the agreed duration.

### Late Fees

- A late fee of 1% of the outstanding principal (for ERC-20 loans) or overdue rental amount (for NFT renting) is applied on the first day after the due date.
- The late fee increases by an additional 0.5% daily.
- The total late fee is capped at 5% of the outstanding principal or total rental amount.
- Late fees are collected along with the repayment and are subject to treasury fee rules.

### Treasury Fees

- The Vaipakam platform treasury collects the `Yield Fee`, equal to 1% of any interest earned by lenders or rental fees earned by NFT owners.
- The treasury also collects late fees paid.
- These fees are automatically deducted by the smart contract before funds are made available to the lender/NFT owner.

### Claiming Funds/Assets

- **Lender/NFT Owner:** To claim their principal + interest (for ERC-20 loans) or rental fees (for NFT renting), the lender/NFT owner must interact with the platform and present their "Vaipakam NFT" to prove ownership and authorize the withdrawal of funds due to them.
- **Borrower:** To claim back their collateral (for ERC-20 loans, after full repayment) or their prepayment buffer (for NFT renting, after proper return and fee settlement), or after liquidation (if any remaining asset after covering total repayment and fees) the borrower must interact with the platform and present their "Vaipakam NFT" to claim thier funds.

### NFT Status Updates on Closure

- Upon successful repayment and claiming of all assets/funds by respective parties, the status of the relevant Vaipakam NFTs (both lender's and borrower's) is updated to "Loan Closed" and burned (after claiming all funds). The Loan status is updated to "Loan Repaid."

### Example: ERC-20 Repayment

- Bob (Borrower) took a 30-day loan of 1000 USDC from Alice (Lender) at 5% APR.
- Interest due: `(1000 * 5 * 30) / (100 * 365) = 4.11 USDC` (approx).
- Bob repays 1004.11 USDC.
- Treasury fee: `1% of 4.11 USDC = 0.0411 USDC`.
- Alice, upon presenting her Vaipakam NFT, can claim `1000 (principal) + 4.11 (interest) - 0.0411 (Yield Fee) = 1004.0689 USDC`.
- Bob's ETH collateral is released to him upon presenting his Vaipakam NFT.
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

- **Liquidation:** The borrower's collateral is liquidated (sold via the configured on-chain swap-aggregator proxy) to recover the outstanding loan amount (principal + accrued interest + late fees + liquidation penalty/fee).
- **Slippage Protection:** If the liquidation swap would incur slippage greater than 6%, the collateral conversion must not happen. In that case, the liquidation flow must stop using the DEX conversion path and must follow the same full collateral transfer procedure used for abnormal liquidation-failure conditions.
- **Fallback Claim Model:** When the DEX liquidation path is abandoned because the swap fails, market conditions are abnormal, liquidity is unavailable, technical execution fails, or the 6% slippage threshold would be exceeded, the protocol should resolve the lender side into a claimable full-collateral position. In that branch, the lender later claims the collateral asset by presenting the Vaipakam lender NFT, instead of requiring the protocol to auto-transfer the collateral during the same liquidation transaction.
- **Proceeds Distribution:**
  - Lender is repaid.
  - Treasury fees are collected.
  - Any excess funds remaining after covering all obligations are returned to the borrower.
  - If proceeds are insufficient to cover the lender's due amount, the lender bears that loss (unless specific undercollateralized loan insurance is a future feature).

**ERC-20 Lending with Illiquid Collateral:**

- **Full Collateral Transfer:** Upon default (non-repayment after grace period), the _entire_ illiquid ERC-20 collateral is allocated to the lender. No LTV calculations or liquidation auctions occur.
- **Claim Procedure:** In Phase 1, this full-collateral-transfer result may be implemented through the protocol’s normal Vaipakam NFT claim model rather than by requiring an immediate automatic push transfer. The lender’s Vaipakam lender NFT must authorize the collateral claim.

**NFT Lending (Renting) Default:**

- **Collateral Forfeiture:** The borrower’s full ERC-20 prepayment (which includes total rental fees + 5% buffer) is transferred to the NFT owner (lender), after deducting the applicable `Yield Fee` from the rental portion.
- **NFT Return:**
  - For ERC-721: The borrower's 'user' status is revoked by the platform. The NFT remains in Vaipakam Escrow until it is returned to the lender through the normal rental/default settlement flow.
  - For ERC-1155: The NFT held in the Vaipakam Escrow is returned to the lender. The borrower's 'user' status is revoked.

### NFT Status Updates on Default/Liquidation

- The status of the relevant Vaipakam NFTs is updated to "Loan Defaulted" or "Loan Liquidated."

### Example: ERC-20 Liquidation (Liquid Collateral)

- Bob borrowed 1000 USDC against 0.5 WETH. WETH price drops, and his LTV exceeds 90%.
- The liquidation process is triggered. Bob's 0.5 WETH is sold.
- Assume sale yields 1020 USDC. Alice is owed 1004.11 USDC (principal + interest). After the `Yield Fee` on interest, Alice receives her due. Remaining amount (e.g., $1020 - ~$1004.11 - liquidation costs) is returned to Bob.

### Example: NFT Renting Default

- Bob rents a CryptoPunk for 7 days (total rental fee 70 USDC, prepayment 73.5 USDC including buffer).
- Bob fails to 'return' the NFT or there's an issue with fee settlement by the end of the grace period.
- The full 73.5 USDC prepayment is claimed by Alice (the lender), minus the `Yield Fee` on the 70 USDC rental portion. Alice's CryptoPunk 'user' status for Bob is revoked, and the escrowed NFT can be returned to Alice under the rental settlement rules.

## 8. Preclosing by Borrower (Early Repayment Options) (step by step more details are provided at end)

Borrowers have options to close their loans earlier than the scheduled maturity date.

### Option 1: Standard Early Repayment

- **Process:** The borrower repays the full outstanding principal _plus the full interest that would have been due for the original entire loan term_.
- This uses the same repayment logic as a normal loan closure.
- **Outcome:** The loan is closed, collateral is returned to the borrower, and Vaipakam NFTs are updated.

### Option 2: Loan Transfer to Another Borrower

The original borrower can transfer their loan obligation to a new borrower. In Phase 1, this option is handled by the original borrower accepting an already existing compatible "Borrower Offer" from the new borrower. The platform ensures the lender is not adversely affected.

- **Process:**
  1.  Original Borrower (Alice) has an active loan from Lender (Liam).
  2.  New Borrower (Ben) wishes to take over Alice's loan and has an active compatible "Borrower Offer".
  3.  Alice accepts that already existing Borrower Offer so the obligation can move to Ben under the allowed conditions.
- **Conditions for Transfer:**
  - **Collateral Requirement:** The new borrower (Ben) must provide collateral of the _same type_ as Alice's original collateral. The _amount_ of Ben's collateral must be greater than or equal to the amount of Alice's original collateral at the time of transfer. (Note: If original collateral was Liquid, LTV rules still apply based on current prices for Ben's position).
  - **Offer Compatibility Rule:** The already existing Borrower Offer that Alice accepts must preserve the same principal/lending asset type, payment/prepay asset type, and collateral asset type as the original loan.
  - **Favorability Rule for Original Lender:** The selected replacement offer must favor Liam, the original lender. This means the replacement duration, collateral amount, and lending amount must not reduce Liam's protection or expected economics versus the original remaining position. If any selected offer would otherwise be less favorable to Liam, Alice must cover the resulting shortfall or top-up required to keep Liam economically whole.
  - **Interest Rate & Income Protection for Lender (Liam):**
    - The interest rate for the new borrower (Ben) can differ from Alice's original rate.
    - Alice (original borrower) _must cover any shortfall_ in the total interest Lender Liam would receive by the end of the original loan term.
    - Shortfall Calculation: `(Original Interest Amount for Remaining Term) - (New Interest Amount for Remaining Term based on Ben's rate)`. Alice pays this shortfall to an escrow, which is eventually routed to Liam.
    - Alice must also pay all interest accrued on her loan up to the date of transfer. This accrued interest is also routed to Liam after the `Yield Fee`.
  - **Loan Term Duration:** The new loan term for Ben must end on or before the original loan's maturity date.
- **Smart Contract Actions:**
  - Ben locks his collateral.
  - Alice's original collateral is released to her.
  - Alice pays any accrued interest and the calculated interest shortfall.
  - The loan obligation (principal repayment to Liam) is transferred from Alice to Ben.
  - Vaipakam NFTs are updated: Alice's Borrower NFT is closed. A new Borrower NFT is minted for Ben. Liam's Lender NFT is updated to reflect Ben as the borrower.
- **Funds Flow:** Any payments from Alice (accrued interest, shortfall) are held in an escrow (`heldForLender` field associated with Liam's loan) and become part of Liam's claimable amount at loan maturity or if Ben repays early.

### Option 3: Offset with a New Lender Offer (Original Borrower Becomes a Lender)

The original borrower can effectively preclose their loan by taking a new lender-side position that offsets the original borrower obligation. In Phase 1, this option is handled by the original borrower creating a new lender offer and is available only for active ERC-20 loans. NFT rental loans and other non-ERC20 loan/rental positions are not eligible for borrower preclose Option 3 and must use standard rental repayment/preclose, transfer, default, or maturity flows. This borrower preclose path is not a refinance flow.

- **Process:**
  1.  Original Borrower (Alice) has an active loan from Lender (Liam).
  2.  Alice wishes to preclose and deposits assets equivalent to her outstanding loan principal to create a new "Lender Offer" on Vaipakam.
  3.  The new offsetting position must use the same principal/lending asset type, payment/prepay asset type, and collateral asset type as Alice’s original loan, while amounts may vary if otherwise permitted by the flow.
  4.  The interest rate and duration for the offsetting position are determined by the new offer terms. The duration must not exceed the remaining term of Alice’s original loan with Liam, and the selected duration must favor Liam, the original lender, or else Alice must fund any resulting shortfall.
  5.  The selected lending amount and collateral amount must also favor Liam. The amounts may vary, but they must not reduce Liam's expected protection or economics relative to the original remaining loan position unless Alice fully compensates the difference.
  6.  The new lender offer is then matched through the standard offer-acceptance flow.
- **Clarification:** This borrower preclose mechanism is achieved by the original borrower taking a new lender-side position through an offsetting offer flow. It should not be described as refinancing the original loan.
- **Interest Handling for Original Lender (Liam):**
  - Alice must ensure Liam receives the full interest he was expecting.
  - If the interest Alice would earn from her new Lender Offer (if accepted and repaid) over the remaining term is _less than_ the remaining interest owed to Liam, Alice must pay this difference to an escrow for Liam at the time her new Lender Offer is accepted.
  - Alice also pays all interest accrued on her loan to Liam up to this point.
  - **Example:** Alice's loan from Liam: $10,000 USDC principal, 5% interest, 6 months remaining (expected $250 interest for Liam). Alice creates a new Lender Offer (with her $10,000 USDC) at 3% for 6 months (would earn $150 interest). Alice must pay Liam the $100 difference ($250 - $150) plus any interest accrued to date on her original loan.
- **Outcome when the Offsetting Offer is Matched:**
  - A new borrower (Charlie) locks collateral and accepts Alice's lender offer.
  - The principal funded by Alice is transferred into the new offsetting loan.
  - Alice's original collateral from her loan with Liam is released to her.
  - Alice's obligation to Liam is effectively covered and Liam’s old position is settled under the offset rules.
  - Vaipakam NFTs are updated accordingly. Alice becomes lender in the new offsetting loan, and her borrower position with Liam is closed.

## 9. Early Withdrawal by Lender (step by step more details are provided at end)

Lenders may wish to exit their loan positions before maturity.

For Phase 1, lender early withdrawal applies only to active ERC-20 loans. NFT rental loans and other non-ERC20 loan/rental positions are not eligible for lender early withdrawal and must follow their normal rental repayment, preclose, default, or maturity flows.

### Option 1: Sell the Loan to Another Lender

The original lender can sell their active loan to a new lender. In Phase 1, this option is handled by the original lender accepting an already existing compatible "Lender Offer" from the new lender.

- **Process:**
  1.  Original Lender (Liam) has an active loan to Borrower (Alice).
  2.  New Lender (Noah) wants to take over Liam's loan position and has an active compatible "Lender Offer" that preserves the same principal/lending asset type, payment/prepay asset type, and collateral asset type as the original live loan.
  3.  Liam accepts that already existing Lender Offer so the lender-side position can move to Noah under the allowed conditions.
- **Interest Handling & Principal Recovery:**
  - **Accrued Interest:** Any interest accrued on the loan up to the point of sale is _forfeited by the original lender (Liam) and sent to the Vaipakam platform's treasury_. This is an incentive for lenders to hold loans to maturity and protects the borrower and platform from complex interest recalculations during transfers.
  - **Principal Transfer:** The new lender (Noah) pays the outstanding principal amount of the loan. This principal is transferred to the original lender (Liam).
  - **Interest Rate Discrepancy:**
    - If the interest rate on the offer Noah is providing (or the rate Liam sets for his sale) results in a different overall return compared to the original loan terms for the remaining duration:
      - The original lender (Liam) might need to cover a shortfall or might find the terms unattractive.
      - Specifically, if Liam accepts a "Lender Offer" from Noah that has a higher interest rate than his current loan to Alice, Liam must pay the interest difference for the remaining term. This amount is offset by any accrued interest on Liam's loan (which would have gone to treasury). If accrued interest is insufficient, Liam pays the remainder. If accrued interest exceeds this shortfall, the excess of the accrued interest (after covering the shortfall) goes to treasury.
      - **Example:** Liam's loan to Alice is at 5%. Noah's offer is to lend at 7%. Liam wants to sell his loan by 'fulfilling' Noah's offer. Liam would need to cover the 2% interest difference for the remaining term. If Liam's loan had $50 accrued interest (normally for treasury) and the shortfall was $20, then $20 of accrued interest covers this, and $30 goes to treasury. If shortfall was $60, Liam would use the $50 accrued interest and pay an additional $10.
  - **Frontend Warnings:** The frontend will display how much the original lender (Liam) will net after accounting for forfeited accrued interest and any potential shortfall payments if they proceed with the sale.
- **Smart Contract Actions:**
  - Noah deposits the principal amount.
  - Principal is transferred to Liam.
  - Accrued interest (or its adjusted part) goes to treasury. Liam might pay a shortfall.
  - The loan rights (future principal and interest payments from Borrower Alice) are transferred to Noah.
  - Vaipakam NFTs are updated: Liam's Lender NFT is closed/marked sold. A new Lender NFT is minted for Noah, linked to Alice's existing Borrower NFT.
- **Borrower's Perspective:** Borrower Alice continues to make payments as per the original terms, but these payments now go to Noah.

### Option 2: Create a New Offer (Original Lender Acts Through a Borrower-Style Offer)

- **Process:** The original lender (Liam) may initiate early withdrawal by creating a new offer using the protocol’s borrower-offer path. The replacement flow must preserve the same principal/lending asset type, payment/prepay asset type, and collateral asset type as the original active loan, while allowing the amount and economic terms to vary if permitted by the flow. The selected replacement offer must favor Alice, the original borrower. This means the replacement duration, collateral amount, and lending amount must not make Alice's continuing live-loan position worse than under the original loan terms. If the created offer would otherwise be less favorable to Alice, that offer should not be used for this early-withdrawal path.
- **Mechanism:** This is not a separate direct-sale primitive. Instead, lender early withdrawal Option 2 is implemented through an offsetting offer flow in which the original lender becomes the borrower-side participant and the incoming counterparty takes the new lender-side position.
- **Interest Handling:** Similar to Option 1. Liam forfeits accrued interest to the treasury. If the selected offsetting offer implies a less favorable outcome for the incoming lender than the original loan, Liam may recover less than principal or may need to subsidize the difference, depending on the final transfer terms.
- **Outcome:** If the offsetting offer is successfully matched, the protocol uses that offer acceptance flow to transition the lender-side economic position. Liam receives the agreed lender-exit proceeds, and the lender relationship on the live loan is updated according to the protocol rules.

### Option 3: Wait for Loan Maturity

- **Condition:** If the lender cannot find a suitable offer to sell their loan or chooses not to sell, they must wait until the loan reaches its full term.
- **Process:** The loan continues as per the original agreement. At maturity, the borrower repays principal and full interest (or defaults), and funds are distributed according to the standard loan closure or default process. The lender claims their dues by presenting their Vaipakam NFT.

## 10. Governance (Phase 2)

Governance is planned for Phase 2 and is not part of the required Phase 1 deliverable. The following describes the intended later-stage direction for community-led governance over key platform parameters and treasury usage.

### Voting Mechanism

- **Governance Token (VNGK):** A native governance token (e.g., VNGK) will be used for voting. Token holders can create proposals and vote on them.
- **Proposal Scope:** Proposals can cover:
  - Adjustments to `Yield Fee` percentages.
  - Changes to late fee structures and caps.
  - Modifications to LTV thresholds for liquid collateral.
  - Grace period durations.
  - Allocations of funds from the treasury for development, security audits, liquidity mining programs, etc.
  - Upgrades to smart contracts (see Security and Upgradability).
- **Process:** Vaipakam will use OpenZeppelin's Governor module or a similar battle-tested framework.
  - **Proposal Submission:** Requires a minimum VNGK holding.
  - **Voting Period:** A defined period during which VNGK holders can cast their votes.
  - **Quorum:** A minimum percentage of the total VNGK token supply (or staked VNGK) must participate in a vote for it to be valid (e.g., 20%).
  - **Majority Threshold:** A minimum percentage of votes cast must be in favor for a proposal to pass (e.g., 51%).
- **Implementation:** Passed proposals are implemented automatically by the governance contract interacting with other platform contracts, or by a multi-sig controlled by the DAO executing the changes.

### Treasury and Revenue Sharing

- **Treasury Collection:** As defined (`Yield Fee` on interest/rental fees, plus 1% of late fees).
- **Revenue Distribution:** 50% of the fees collected by the treasury will be distributed monthly to VNGK token holders who actively stake their tokens in the platform's staking contract.
- **Treasury Dashboard:** A public dashboard (e.g., built with Dune Analytics or similar tools, integrated into the Vaipakam frontend) will display real-time treasury data:
  - Total income from fees.
  - The 50% portion allocated for distribution to VNGK stakers.
  - Historical fee data and distribution amounts.
  - This ensures full transparency regarding platform finances.

### VNGK Token Distribution

The VNGK governance token will be distributed to align incentives and encourage platform participation.

- **Proposed Allocation:**
  - Founders: 10%
  - Developers & Team: 15%
  - Testers & Early Contributors: 5%
  - Platform Admins/Operational Roles (e.g., initial multi-sig holders): 5%
  - Security Auditors: 2%
  - Regulatory Compliance Pool (if needed): 1%
  - Bug Bounty Programs: 2%
  - Exchange Listings & Market Making: 10%
  - **Platform Interaction Rewards: 30%**
    - Earned by users (lenders and borrowers) based on their activity (e.g., proportional to interest/rental fees generated/paid).
    - For borrowers, tokens are claimable only after proper loan repayment (not on liquidation or default).
    - Lenders receive their interaction rewards irrespective of borrower repayment status, based on the loan being active.
  - **Staking Rewards: 20%**
    - Distributed over time to users who stake their VNGK tokens in the platform's staking contract.
    - This allocation will contribute to an annual inflation rate for the VNGK token (e.g., a target of 2% of the staking rewards pool distributed annually) to incentivize staking.
- **Distribution Mechanism:** Rewards (Platform Interaction, Staking) will generally follow a pull model, where users claim their earned tokens via the Vaipakam dashboard. Initial distributions (e.g., for team, founders) may have vesting schedules.

## 11. Notifications (Phase 1: SMS/Email)

Effective communication is key for user experience and risk management. For Phase 1, Vaipakam will use SMS and Email notifications.

### Implementation

- **Mechanism:** An off-chain service will monitor key smart contract events. When a relevant event occurs, this service will trigger SMS/Email notifications to the concerned users.
- **Providers:** The platform will use established third-party APIs for sending SMS (e.g., Twilio) and Emails (e.g., SendGrid).
- **User Registration:** Users will need to provide and verify their phone number and/or email address in their Vaipakam profile to receive notifications. Opt-in/opt-out preferences for non-critical notifications can be managed.
- **Funding:** The cost of sending these SMS/Email notifications will be covered by the Vaipakam platform, funded from its treasury.
- **Criticality:** Notifications will be primarily for critical events to avoid alert fatigue.
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
- **VNGK Token Management (Phase 2):** View VNGK balance, claimable rewards, and staking/unstaking tools after the governance token and staking system are launched.
- **Notification Settings:** Manage preferences for SMS/Email alerts.
- **Analytics:** Basic analytics on lending/borrowing performance.
- **Data Refresh:** The dashboard will update periodically (e.g., every minute or on user action) to reflect on-chain changes.

## 13. Technical Details

### Blockchain and Networks (Phase 1)

- **Supported Networks:** Ethereum, Polygon, Arbitrum.
- **Intra-Network Operations:** All aspects of a single loan (offer, acceptance, collateral, repayment) occur on the _same chosen network_.

### Smart Contracts

- **Language:** Solidity (latest stable version, e.g., 0.8.x, specify version like 0.8.29 if decided).
- **Core Contracts (Examples):**
  - `VaipakamOfferManagement.sol`: Handles creation, cancellation, and matching of lender/borrower offers.
  - `VaipakamLoanManagement.sol`: Manages active loans, repayments, defaults, and liquidations.
  - `VaipakamEscrow.sol`: Holds collateral, ERC-721/1155 rental NFTs, and funds during various stages.
  - `VaipakamNFT.sol`: The ERC-721 contract responsible for minting and managing Vaipakam NFTs.
  - `VaipakamGovernance.sol` (Phase 2): Manages proposals and voting.
  - `VaipakamTreasury.sol`: Collects and manages platform fees.
  - `VaipakamStaking.sol` (Phase 2): Manages VNGK token staking and reward distribution.
- **Libraries:**
  - OpenZeppelin Contracts: For robust implementations of ERC-20, ERC-721, ERC-1155 (if Vaipakam mints its own utility NFTs beyond offer/loan representations), AccessControl, ReentrancyGuard, and potentially Governor.
- **Security Considerations:**
  - **Audits:** Smart contracts will undergo thorough security audits by reputable third-party firms before mainnet deployment on each network.
  - **Upgradeable Proxies:** Utilize UUPS (Universal Upgradeable Proxy Standard) proxies for core contracts to allow for future upgrades and bug fixes without disrupting ongoing operations or requiring data migration. Governance-controlled upgrades are planned for Phase 2; Phase 1 upgrades are controlled by the initial admin/multi-sig model described in the security policy.
  - **Escrow Upgrade Policy:** User escrows must not continue to be usable on outdated mandatory versions. If an escrow implementation upgrade is classified as required, user interactions through an older escrow version must be blocked by the protocol until that escrow is upgraded. Escrow upgrades are not intended to be pushed automatically to every existing user escrow because that would create significant network-fee overhead. Instead, the frontend must detect outdated escrows and require the user to submit their own escrow-upgrade transaction before any further protected interaction is allowed. For non-critical upgrades, the frontend may still prompt users to upgrade, but blocking behavior should only be enforced when the upgrade is marked mandatory.
  - **Reentrancy Guards:** Applied to all functions involving external calls or asset transfers.
  - **Access Control:** Granular roles (e.g., `LOAN_MANAGER_ROLE`, `OFFER_MANAGER_ROLE`, `TREASURY_ADMIN_ROLE`) managed via OpenZeppelin's AccessControl. Roles will be assigned initially by the contract deployer/owner, with plans to transition control to governance in Phase 2 where appropriate.
  - **Batch Processing:** Support for batch processing of certain operations where feasible to optimize gas costs. Staking reward batch processing is Phase 2 scope.

### Frontend

- **Framework:** React with Web3.js or Ethers.js for blockchain interaction.
- **State Management:** Robust state management solution (e.g., Redux, Zustand).
- **Languages:** Initial launch in English, with plans for multilingual support (e.g., Spanish, Mandarin) in subsequent updates.
- **API Standards:** Frontend will interact with smart contracts using standardized data formats (e.g., JSON-like structs or arrays returned by view functions).

## 14. Initial Deployment and Configuration (Phase 1)

- **Networks:** Ethereum, Polygon, Arbitrum. Network-specific optimizations (e.g., gas limits, contract deployment strategies) will be considered.
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

- **KYC/AML Integration:**
  - The platform will integrate with decentralized KYC/AML solutions (e.g., Civic, Verite, ComplyCube, KYC-Chain, or Trust Node by ComplyAdvantage).
  - **Tiered Approach:**
    - **Tier 0 (No KYC/AML):** For transactions where the principal loan amount (for ERC-20 loans using liquid assets valued in USDC) or total rental value (for NFT renting, valued in USDC) is less than $1,000 USD.
    - **Tier 1 (Limited KYC):** For transaction values between $1,000 and $9,999 USD. This might involve basic identity verification.
    - **Tier 2 (Full KYC/AML):** For transaction values of $10,000 USD or more. This will require more comprehensive identity verification and AML checks.
  - **Valuation for KYC Thresholds:**
    - **ERC-20 Loans:** The USDC equivalent value of the _principal amount being lent_ (if liquid) determines the transaction value. If the principal asset is illiquid, or if collateral is illiquid/NFT, these are considered $0 for this specific calculation, relying on the value of the liquid component.
    - **NFT Renting:** The _total rental value_ (daily rate \* duration, converted to USDC equivalent) determines the transaction value.
    - The platform will use Chainlink oracles for converting liquid asset values to USDC for these threshold checks.
- **Implementation Timing:** KYC/AML measures will be part of the initial launch.
- **Ongoing Monitoring:** The platform will monitor regulatory developments during Phase 1. Governance proposals to update compliance measures are Phase 2 scope after governance is launched.

## Summary (Phase 1)

Vaipakam (Phase 1) is a decentralized P2P lending and Borrowing platform supporting ERC-20 tokens and rentable NFTs on Ethereum, Polygon, and Arbitrum (operating independently on each network). It leverages unique NFTs for transparent offer and loan tracking. Key features include distinct handling of liquid vs. illiquid assets, platform-funded SMS/Email notifications, and robust options for early loan closure and withdrawal. VNGK-token community governance is planned for Phase 2. The integrated NFT verification tool enhances transparency.

## Further Notes on Key Topics (Phase 1 Focus)

### NFT Metadata and Status Updates

- **Metadata:** NFTs minted by Vaipakam (Vaipakam NFTs) store key details on-chain (e.g., asset, collateral, rate, duration, status). The `tokenURI` function dynamically generates this metadata, including pointers to IPFS-hosted images reflecting the NFT's role and status.
- **Status Updates:** Loan and Offer NFTs track statuses like "Offer Created," "Loan Active," "Repaid," "Defaulted," "Closed." These updates are performed by authorized smart contract roles (e.g., `VaipakamLoanManagement.sol`, `VaipakamOfferManagement.sol`).
- **Event Emission:** Detailed events are emitted for each state change, ensuring transparency and facilitating easier frontend tracking and off-chain service integration (like the notification system).
- **Claiming Funds/Assets/Collateral:** Users must present their relevant Vaipakam-minted NFT (e.g., Lender's Vaipakam NFT to claim repayment, Borrower's Vaipakam NFT to claim collateral back) to the platform's smart contracts. This acts as a proof of ownership and authorization for the claim.

### Liquidation and Collateral Handling (Recap)

- **Liquid ERC-20 Collateral:** Subject to LTV monitoring and DEX-based liquidation or auctions if LTV breaches thresholds or on default post-grace period. Excess proceeds return to the borrower.
- **Illiquid ERC-20 Collateral / All NFT Collateral:** Not subject to LTV-based liquidation. On default post-grace period, the full collateral is transferred to the lender. Users are explicitly warned and must agree to these terms if dealing with illiquid assets.
- **Illiquid Asset Warnings:** The frontend prominently displays warnings when users interact with assets identified as illiquid. Smart contracts enforce illiquid handling based on on-chain verification and recorded user consent.

### Governance and Treasury (Phase 2 Recap)

- **Governance (Phase 2):** OpenZeppelin Governor module (or similar) for VNGK token-based voting on parameters and treasury use.
- **Treasury:** Phase 1 treasury collection is limited to platform fees such as the `Yield Fee` on interest/rental fees and 1% of late fees. VNGK-staker revenue sharing, including any 50% treasury-income distribution model, is Phase 2 scope. A public dashboard can provide transparency across phases.

### User Experience and Frontend

- **Clear Indicators:** The React-based frontend will use clear indicators for network selection, asset liquidity status, and potential risks.
- **Information Icons & Tooltips:** Information icons next to key fields and terms will provide tooltips with concise explanations. Links to more detailed documentation or FAQs will be available.
- **Critical Notifications:** SMS/Email notifications are concise, actionable, and platform-funded, focusing on essential events. Users manage their contact details for these alerts.

### Security and Upgradability

- **Access Control:** Granular roles via OpenZeppelin's AccessControl, initially set by the deployer/admin or multi-sig, with governance transfer planned for Phase 2.
- **Reentrancy Guards:** Standard on relevant functions.
- **Upgradability (UUPS Proxies):** Core contracts use UUPS proxies. Phase 1 upgrades are controlled by the initial admin/multi-sig model; community governance via VNGK voting is Phase 2 scope.
- **Emergency Updates:** For critical security vulnerabilities posing an immediate threat to user funds or platform integrity, emergency updates can be fast-tracked. These actions will require approval from a multi-signature (multi-sig) wallet, with the signers initially being core team members or trusted parties, and potentially transitioning to DAO-elected signers later. These emergency powers are strictly limited to critical patches.

### Testing and Auditing

- **Testing:** Comprehensive test suites (unit, integration, end-to-end) covering all functionalities, including positive/negative flows, edge cases, metadata/event checks, and various asset handling scenarios.
- **Internal Audits:** Use of static analysis tools (e.g., Slither, MythX) and thorough internal code reviews.
- **Fuzz Testing**: for math (e.g., interest calculations) and simulation of defaults/LTV breaches.
- **Open-Source Tests:** Test cases will be made open-source on GitHub post-mainnet deployment for community review.
- **External Auditing:** Mandatory third-party security audits by reputable firms before mainnet launch. Audit reports will be publicly available.

### Development Tools

- **Smart Contracts:** Foundry for development and testing.
- **Frontend:** React, Ethers.js for blockchain interaction.

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
- **Process:**
  1.  The borrower (Alice) has an existing active ERC-20 loan from Lender A. NFT rental loans and other non-ERC20 loan/rental positions must be rejected from this refinance flow.
  2.  Alice finds or creates a new "Borrower Offer" with her desired terms.
  3.  A new Lender (Lender B) accepts Alice's Borrower Offer.
  4.  The principal amount from Lender B is used to instantly repay Alice's original loan to Lender A (principal + any full-term interest due to Lender A as per early repayment rules; any governance-approved alternative refinancing interest policy is Phase 2 scope).
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
- An ERC-20 token is illiquid for a given Phase 1 network deployment if the protocol cannot confirm both a valid Chainlink feed and a recognized DEX liquidity pool with sufficient usable liquidity on that active network. Ethereum mainnet may still show that the asset is broadly liquid in the ecosystem, but that does not permit the asset to be transacted on an active network where it fails the local liquidity check. In that case, the user must be directed to the Ethereum-mainnet deployment for that asset instead. Illiquid ERC-20s also have a $0 platform-assessed value for LTV. For KYC, if the _lent/borrowed asset itself_ is illiquid, it's $0, and KYC is based on other liquid components if any. If the collateral is illiquid, it doesn't add to the transaction value for KYC if the primary lent/borrowed asset is liquid.

## New features

- **Partial Lending and Borrowing:** Allowing users to accept offers with Partial lending amount, so that one offer may have more than one loan realated to it.
- **Flexible Interest:** Allowing lenders to earn flexible interest by using duration of the loan to 1 day and full filling the loan everyday at maximum interest rates in the list of available offers with same asset and collateral.

## Developement Approach

The Diamond Standard (EIP-2535) need to be followed for smart contract developement

# Special Note

## Security Note:

- The offers from users will be listed to only those users who are in the respective countries that can trade between themselves. This is done as there can be sactions between the countries.
  - For trading sanctions, we just can't have a status saying some country is sanctioned, we need to know, which countries have got sanctioned or whitelisted to that particular country. we can't single out a country saying that it got sanctioned and no other country can trade with it. so we need to have a many to many type of mapping to check whether we can show the offer or to allow the offer acceptance (or loan initiation).
- No common escrow account and only seperate Escrow account for each users (via clone factory for gas efficiency) would implemented which will then be managed by Vaipakam App. This is to avoid commingling of funds.
- Existing user escrows should not be silently mass-upgraded by the protocol because that would create unnecessary network-fee overhead. Instead, when an escrow upgrade is marked as mandatory, interactions using older escrow versions must be blocked and the frontend must require the user to upgrade their own escrow before continuing. If an upgrade is not critical, the frontend may leave the upgrade optional and simply prompt the user.
- Use Reentrancygaurd and pausable from Openzeppelin wherever needed.

## Other Notes:

- Keep cross chain functionality, governance, partial loan, flexible interest and multi collateral (or mixed collateral) asset for later development (for phase 2) and complete other features first.
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

# More Detailed step by step process and details for Preclosing by Borrower and Early Withdrawal by Lender

## 8. Preclosing by Borrower (Early Repayment Options)

Borrowers may close or transfer their obligations before the originally scheduled maturity date. For Phase 1, three borrower-side preclose paths are supported. In all cases, the platform must ensure that the original lender is not economically disadvantaged compared to the agreed loan terms, except where the borrower explicitly defaults under the normal default flow.

### General Rules for All Borrower Preclose Options

- Only the current borrower of an active loan may initiate a borrower preclose flow.
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
   - `Yield Fee` on the lender’s interest or rental earnings
3. The borrower pays the required repayment amount.
4. The platform allocates:
   - lender claimable amount
   - borrower claimable collateral or refund amount
   - `Yield Fee` amount
5. The loan is marked as repaid and both parties may claim their respective assets using their Vaipakam NFTs.

#### ERC-20 Loan Outcome

- The borrower pays:
  - full principal
  - full contractual interest for the original duration
- The lender becomes entitled to:
  - principal
  - interest minus `Yield Fee`
- The borrower becomes entitled to:
  - full eligible collateral return
- The treasury receives:
  - `Yield Fee` on the interest portion
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
- If the collateral is liquid, the resulting transferred loan must still satisfy all applicable risk checks, including maximum LTV and minimum health factor requirements.
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
6. Risk validation is performed on the transferred position when required.
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

#### Two-Step Flow

##### Step 1: Enter the Offsetting Lender Position

1. Alice deposits principal-equivalent assets.
2. Alice creates a new lender offer.
3. Alice pays:
   - accrued interest owed to Liam so far
   - any shortfall owed to Liam
4. These amounts are reserved for Liam and tracked separately until the offset completes.

##### Step 2: Complete Offset After the Offsetting Offer Is Matched

1. The selected offsetting offer is successfully matched through the standard offer flow.
2. The counterparty borrower locks the required collateral.
3. Alice’s funded principal is transferred under the new loan.
4. Alice’s original borrower-side collateral is released from her old loan with Liam.
5. Liam’s original position is converted into a claimable settlement position under the offset rules.
6. Alice’s original borrower loan is marked repaid or offset-closed.
7. Alice now holds the lender position in the new offsetting loan.

#### Required Settlement Result

When the offset completes, Liam must have a valid claim path for the full value owed under the old loan, including:

- original principal owed to Liam
- accrued interest owed up to offset time
- any shortfall paid by Alice
- minus the applicable `Yield Fee`

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

#### Smart Contract Actions

1. Noah funds the purchase.
2. Liam receives the agreed principal recovery amount.
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

---

## Recommended Note to Add After These Sections

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
