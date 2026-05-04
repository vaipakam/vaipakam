# Vaipakam Workflow Document

This document outlines the key Phase 1 workflows for the Vaipakam decentralized peer-to-peer (P2P) lending platform, built on Ethereum with Layer 2 deployments on Polygon and Arbitrum. Vaipakam facilitates lending and borrowing of ERC20 tokens and rentable ERC-721/1155 NFTs, using Vaipakam-minted NFTs to represent offers and loans for transparency. Phase 1 loans are single-network workflows: the principal/lending asset, payment/prepay asset, and collateral asset for a given loan stay on the same network and must preserve their asset types during borrower preclose. Phase 1 lender early-withdrawal and refinance flows apply only to active ERC20 loans, not NFT rental or other non-ERC20 loan/rental positions. Cross-chain workflows, governance, staking, and VNGK reward distribution are Phase 2 scope.

---

## Table of Contents

- [Vaipakam Workflow Document](#vanki-workflow-document)
  - [Table of Contents](#table-of-contents)
  - [Scenario 1: ERC20 Lending with ERC20 Lender Asset and ERC20 Borrower Collateral](#scenario-1-erc20-lending-with-erc20-lender-asset-and-erc20-borrower-collateral)
    - [Sub Scenario 1a: Borrower Proper Repayment](#sub-scenario-1a-borrower-proper-repayment)
    - [Sub Scenario 1b: Borrower Defaults](#sub-scenario-1b-borrower-defaults)
  - [Scenario 2: NFT Lending (Renting) with ERC20 Collateral](#scenario-2-nft-lending-renting-with-erc20-collateral)
    - [Sub Scenario 2a: Lending with ERC-721 NFT](#sub-scenario-2a-lending-with-erc-721-nft)
      - [Overview](#overview)
      - [Proper Return of NFT (ERC-721)](#proper-return-of-nft-erc-721)
      - [Borrower Fails to Return NFT (ERC-721)](#borrower-fails-to-return-nft-erc-721)
    - [Sub Scenario 2b: Lending with ERC-1155 NFT](#sub-scenario-2b-lending-with-erc-1155-nft)
      - [Overview](#overview-1)
      - [Proper Return of NFT (ERC-1155)](#proper-return-of-nft-erc-1155)
      - [Borrower Fails to Return NFT (ERC-1155)](#borrower-fails-to-return-nft-erc-1155)
  - [Scenario 3: Cross-Chain ERC20 Lending (Phase 2)](#scenario-3-cross-chain-erc20-lending-phase-2)
    - [Sub Scenario 3a: Proper Repayment](#sub-scenario-3a-proper-repayment)
    - [Sub Scenario 3b: Borrower Defaults](#sub-scenario-3b-borrower-defaults)
  - [Scenario 4: Lending with Illiquid Collateral](#scenario-4-lending-with-illiquid-collateral)
    - [Sub Scenario 4a: Borrower Defaults with Illiquid ERC20 Collateral](#sub-scenario-4a-borrower-defaults-with-illiquid-erc20-collateral)
    - [Sub Scenario 4b-i: Loan with both illiquid ERC20 lender asset and illiquid ERC20 borrower collateral](#sub-scenario-4b-i-loan-with-both-illiquid-erc20-lender-asset-and-illiquid-erc20-borrower-collateral)
    - [Sub Scenario 4b-ii: Loan with illiquid ERC20 lender asset and liquid ERC20 borrower collateral](#sub-scenario-4b-ii-loan-with-illiquid-erc20-lender-asset-and-liquid-erc20-borrower-collateral)
    - [Sub Scenario 4b: NFT Lending with Illiquid NFT Collateral](#sub-scenario-4b-nft-lending-with-illiquid-nft-collateral)
  - [Scenario 5: Governance Proposal and Voting (Phase 2)](#scenario-5-governance-proposal-and-voting-phase-2)
  - [Scenario 6: Treasury Distribution (Phase 2)](#scenario-6-treasury-distribution-phase-2)
  - [Scenario 7: Loan Sales by Lender](#scenario-7-loan-sales-by-lender)
    - [Sub Scenario 7a: Lender Sells Loan by Accepting Another Lender’s Offer](#sub-scenario-7a-lender-sells-loan-by-accepting-another-lenders-offer)
    - [Sub Scenario 7b: Lender Sells Loan by Creating a Borrower Offer](#sub-scenario-7b-lender-sells-loan-by-creating-a-borrower-offer)
  - [Scenario 8: Loan Transfer by Borrower](#scenario-8-loan-transfer-by-borrower)
    - [Sub Scenario 8a: Borrower Transfers Loan by Accepting Another Borrower’s Offer](#sub-scenario-8a-borrower-transfers-loan-by-accepting-another-borrowers-offer)
    - [Sub Scenario 8b: Borrower Transfers Loan by Creating a Lender Offer](#sub-scenario-8b-borrower-transfers-loan-by-creating-a-lender-offer)
  - [Notes](#notes)

---

## Scenario 1: ERC20 Lending with ERC20 Lender Asset and ERC20 Borrower Collateral

This scenario involves a lender offering an ERC20 token (e.g., USDC) to lend, with the borrower providing another ERC20 token (e.g., WETH) as collateral.

### Sub Scenario 1a: Borrower Proper Repayment

1. **Lender Creates Offer**
   - The lender specifies the lending asset (e.g., 1000 USDC), required collateral type (e.g., WETH), minimum collateral amount (e.g., 0.5 WETH), interest rate (e.g., 5%), and loan duration (e.g., 30 days).
   - The lender deposits 1000 USDC into the smart contract.
   - The platform mints an offer NFT for the lender with status "Offer Created."

2. **Borrower Accepts the Offer**
   - The borrower reviews and accepts the offer via the React-based frontend.
   - The borrower locks 0.5 WETH as collateral into the smart contract and pays the gas fee for acceptance.
   - The smart contract transfers 1000 USDC to the borrower.
   - The platform mints an acceptor NFT for the borrower with status "Loan Initiated."

3. **Borrower Repays the Loan**
   - Before the 1-year duration ends, the borrower calculates the repayment: principal + interest (e.g., 1000 USDC + 5% interest = 1050 USDC, adjusted for exact days).
   - The borrower transfers 1050 USDC to the smart contract.
   - The smart contract updates the loan status to "Repaid" and allocates the `Yield Fee` of 1% (0.5 USDC) of the interest to the treasury.

4. **Lender Claims the Amount**
   - The lender presents their Lender NFT to claim the repayment.
   - The smart contract transfers 1049.5 USDC (principal + interest minus `Yield Fee`) to the lender.
   - The borrower’s 0.5 WETH collateral is released back to the borrower.
   - Both NFTs are updated to status "Closed."

### Sub Scenario 1b: Borrower Defaults

1. **Lender Creates Offer**
   - Same as in Sub Scenario 1a.

2. **Borrower Accepts the Offer**
   - Same as in Sub Scenario 1a.

3. **Borrower Defaults**
   - The borrower fails to repay the loan after the 30-day duration and the grace period (e.g., 1 day for a 30-day loan).
   - The smart contract marks the loan as "Defaulted" if Loan-to-Value (LTV) > 90% (via Chainlink) or post-grace period.

4. **Lender (or Platform) Liquidates the Defaulted Loan**
   - The platform initiates liquidation since both assets are liquid ERC20 tokens.
   - The 0.5 WETH collateral is sold (via the configured on-chain swap-aggregator proxy) to recover the principal + interest (1050 USDC).
   - Proceeds are held in the smart contract.

5. **Lender Claims the Amount**
   - The lender presents their Lender NFT to claim the repayment.
   - The smart contract transfers up to 1049.5 USDC (after the `Yield Fee`) from liquidation proceeds to the lender.

6. **Borrower Claims the Remaining Amount (if available)**
   - If liquidation proceeds exceed 1050 USDC, the excess is returned to the borrower upon claiming.

---

## Scenario 2: NFT Lending (Renting) with ERC20 Collateral

This scenario involves a lender offering an NFT for rent, with the borrower providing ERC20 tokens (e.g., USDC) as collateral. The process differs based on the NFT standard: ERC-721 or ERC-1155.

### Sub Scenario 2a: Lending with ERC-721 NFT

#### Overview

- **NFT Location:** The ERC-721 NFT is transferred into the lender’s Vaipakam Escrow during the rental period.
- **Access Control:** The borrower receives only temporary ERC-4907 `user` rights. Vaipakam Escrow remains the custodian/owner while the NFT is rented, and the borrower never receives custody or ownership of the NFT.
- **Collateral/Prepayment:** The borrower locks ERC20 prepayment equal to rental fees plus the 5% buffer. The buffer is returned on successful rental closure and forfeited to treasury on default.

#### Proper Return of NFT (ERC-721)

1. **Lender Creates the Offer**
   - The lender lists their ERC-721 NFT (e.g., Axie #1234), specifying:
     - Daily rental fee: 10 USDC/day
     - Rental duration: 7 days
     - Collateral type: USDC
   - The lender approves the ERC-721 token and the NFT is transferred into the lender’s Vaipakam Escrow when the offer is created.
   - The platform mints an "Offer NFT" for the lender with status "Offer Created."

2. **Borrower Accepts the Offer**
   - The borrower locks ERC20 prepayment: 70 USDC (rental fees) + 3.5 USDC (5% buffer) = 73.5 USDC.
   - The NFT remains in Vaipakam Escrow, and the smart contract calls `setUser` to assign the borrower as the NFT’s user for 7 days.
   - The platform mints an "Acceptor NFT" for the borrower with status "Loan Initiated."

3. **Borrower Returns the NFT**
   - The borrower calls the repay function before the rental period ends.
   - The smart contract revokes the borrower’s user status via `setUser` and updates the rental to a claimable/closed state.

4. **Lender Claims Fees**
   - The lender presents their Vaipakam Lender NFT to claim 69.3 USDC (70 USDC minus the `Yield Fee`) and reclaim the escrowed ERC-721 NFT.
   - The borrower receives the 3.5 USDC buffer back.
   - Both NFTs are updated to "Closed."

#### Borrower Fails to Return NFT (ERC-721)

1. **Borrower Defaults**
   - The borrower does not return the NFT within the rental period.
   - The loan is marked as "Defaulted" after the grace period.
   - The lender claims the rental fees/prepayment according to default rules, and the 5% buffer is routed to treasury.
   - The escrowed ERC-721 NFT is returned to the lender through the Vaipakam NFT-gated claim/default settlement flow.
   - The smart contract revokes the borrower’s user status via `setUser` and updates the status to "Returned."

---

### Sub Scenario 2b: Lending with ERC-1155 NFT

#### Overview

- **NFT Location:** The ERC-1155 NFT is transferred to the Vaipakam Escrow during the rental period.
- **Access Control:** The borrower is assigned as the "user" for a specific quantity of tokens using `setUser`.
- **Prepayment:** The borrower locks ERC20 prepayment equal to rental fees plus the 5% buffer. The NFT remains escrow-custodied and is returned to the lender through the Vaipakam NFT-gated claim/default settlement flow.

#### Proper Return of NFT (ERC-1155)

1. **Lender Creates the Offer**
   - The lender lists their ERC-1155 NFT (e.g., tokenId #5, quantity 10), specifying:
     - Daily rental fee: 10 USDC/day per token
     - Rental duration: 7 days
     - Payment/prepay asset: USDC
   - The lender transfers 10 tokens to the Vaipakam Escrow.
   - The platform mints an "Offer NFT" for the lender with status "Offer Created."

2. **Borrower Accepts the Offer**
   - The borrower locks ERC20 prepayment: 700 USDC (rental fees) + 35 USDC (5% buffer) = 735 USDC.
   - The smart contract calls `setUser` to assign the borrower as the user for 10 tokens for 7 days.
   - The platform mints an "Acceptor NFT" for the borrower with status "Loan Initiated."

3. **Borrower Returns the NFT**
   - The borrower calls the return function before the rental period ends.
   - The smart contract revokes the borrower’s user status for the 10 tokens and updates the status to "Returned."

4. **Lender Claims Fees and NFT**
   - The lender presents their Offer NFT to claim 693 USDC (700 USDC minus the `Yield Fee`).
   - The borrower receives the 35 USDC buffer back.
   - The 10 ERC-1155 tokens are transferred back to the lender from the Escrow.
   - Both NFTs are updated to "Closed."

#### Borrower Fails to Return NFT (ERC-1155)

1. **Borrower Defaults**
   - The borrower does not return the NFT within the rental period.
   - The loan is marked as "Defaulted" after the grace period.
   - The lender claims the rental fees/prepayment according to default rules, and the 5% buffer is routed to treasury.
   - The 10 ERC-1155 tokens are returned to the lender from escrow through the Vaipakam NFT-gated claim/default settlement flow.

---

## Scenario 3: Cross-Chain ERC20 Lending (Phase 2)

This scenario is Phase 2 scope. Phase 1 loans are single-network workflows, so the steps below are retained only as future workflow notes and should not be treated as current Phase 1 implementation requirements.

### Sub Scenario 3a: Proper Repayment

1. **Lender Creates Offer on Ethereum**
   - The lender offers 1000 USDC with WETH as collateral, specifying terms (e.g., 5% interest, 30 days).
   - The lender deposits 1000 USDC into the Ethereum smart contract.
   - The platform mints an offer NFT on Ethereum.

2. **Borrower on Polygon Accepts the Offer**
   - The borrower locks 0.5 WETH on Polygon and pays bridging fees.
   - The smart contract bridges 1000 USDC from Ethereum to Polygon via the configured cross-chain bridge.
   - The platform mints an acceptor NFT on Polygon with status "Loan Initiated."

3. **Borrower Repays the Loan on Polygon**
   - The borrower transfers 1050 USDC to the Polygon smart contract before the 30-day duration ends.
   - The repayment is held on Polygon, with status updated to "Repaid."

4. **Lender Claims the Repayment**
   - The lender presents their Lender NFT on Ethereum to claim.
   - The smart contract bridges 1049.5 USDC (after the `Yield Fee`) from Polygon to Ethereum.
   - The borrower’s 0.5 WETH is released on Polygon.

### Sub Scenario 3b: Borrower Defaults

1. **Lender Creates Offer on Ethereum**
   - Same as in Sub Scenario 3a.

2. **Borrower on Polygon Accepts the Offer**
   - Same as in Sub Scenario 3a.

3. **Borrower Defaults**
   - The borrower fails to repay after the 30-day duration and grace period.
   - The smart contract marks the loan as "Defaulted."

4. **Lender Claims the Liquidation Proceeds**
   - The platform liquidates the 0.5 WETH on Polygon.
   - Proceeds (e.g., 1050 USDC) are bridged to Ethereum (after the `Yield Fee`, lender receives up to 1049.5 USDC).
   - The lender presents their Lender NFT to claim the proceeds.

---

## Scenario 4: Lending with Illiquid Collateral

This scenario addresses lending where collateral is illiquid (e.g., low-liquidity ERC20 or NFT).

### Sub Scenario 4a: Borrower Defaults with Illiquid ERC20 Collateral

1. **Lender Creates Offer**
   - The lender offers 1000 USDC with an illiquid ERC20 token (e.g., XYZ token, <$1M 24h volume) as collateral.
   - The frontend displays a warning about illiquidity.
   - The lender deposits 1000 USDC into the smart contract.

2. **Borrower Accepts the Offer**
   - The borrower locks the illiquid XYZ tokens into the smart contract.
   - The smart contract transfers 1000 USDC to the borrower.

3. **Borrower Defaults**
   - The borrower fails to repay after the loan duration and grace period.
   - The full XYZ token collateral is transferred to the lender (no liquidation, as it’s illiquid).

### Sub Scenario 4b-i: Loan with both illiquid ERC20 lender asset and illiquid ERC20 borrower collateral

    - Refer [Sub Scenario 4a: Borrower Defaults with Illiquid ERC20 Collateral](#sub-scenario-4a-borrower-defaults-with-illiquid-erc20-collateral)
    - Same workflow for this scenario too

### Sub Scenario 4b-ii: Loan with illiquid ERC20 lender asset and liquid ERC20 borrower collateral

    - Refer [Sub Scenario 4a: Borrower Defaults with Illiquid ERC20 Collateral](#sub-scenario-4a-borrower-defaults-with-illiquid-erc20-collateral)
    - Same workflow for this scenario too

---

### Sub Scenario 4b: NFT Lending with Illiquid NFT Collateral

1. **Lender Creates Offer for NFT Lending**
   - The lender offers an NFT (e.g., Axie #1234) for rent at 10 USDC/day, requiring an illiquid NFT as collateral.
   - The frontend warns about illiquidity.
   - The lender deposits the ERC-721 or ERC-1155 rental NFT into the lender’s Vaipakam Escrow.

2. **Borrower Accepts the Offer**
   - For Phase 1 NFT rentals, the borrower locks ERC20 prepayment rather than taking custody of the rental NFT. NFT-as-collateral edge cases are treated as illiquid and should follow the README’s illiquid-asset consent rules.
   - The smart contract assigns the borrower as the user of the lender’s NFT.

3. **Borrower Fails to Return the NFT**
   - The borrower does not return the NFT after the duration and grace period.
   - The borrower’s illiquid NFT collateral is transferred to the lender.

## Scenario 5: Governance Proposal and Voting (Phase 2)

Governance is planned for Phase 2 and is not part of the required Phase 1 workflow.

1. **Proposal Creation**
   - A user submits a proposal (e.g., adjust late fees) via the frontend.
   - The proposal is recorded on-chain using the OpenZeppelin Governor module.

2. **Voting**
   - VNGK token holders vote within the specified period.
   - If quorum (20% participation) and majority (51%) are met, the proposal is implemented.
   - The smart contract updates the platform parameters accordingly.

---

## Scenario 6: Treasury Distribution (Phase 2)

VNGK staking and revenue sharing are planned for Phase 2. Phase 1 treasury behavior is limited to platform fee collection and owner/admin or multi-sig withdrawal according to the security policy.

1. **Fee Collection**
   - The platform collects the `Yield Fee`, equal to 1% of interest/rental fees (e.g., 0.5 USDC from a 50 USDC interest payment), into the treasury.

2. **Distribution**
   - In Phase 2, if governance approves revenue sharing, a portion of treasury income may be distributed to VNGK token holders or stakers.
   - Users claim their share via the dashboard, with amounts tracked on-chain.

---

## Scenario 7: Loan Sales by Lender

This scenario involves a lender exiting an active loan early. In Phase 1, lender early withdrawal applies only to active ERC20 loans; NFT rental loans and other non-ERC20 loan/rental positions must follow their normal rental repayment, borrower preclose, default, or maturity flows. Each supported early-withdrawal option has one path: Option 1 accepts an existing compatible lender offer, and Option 2 creates a new borrower-style offer. In both paths the principal/lending asset type, payment/prepay asset type, and collateral asset type must match the original live loan. The selected terms must favor the original borrower; duration, lending amount, and collateral amount cannot make the borrower’s continuing position worse.

### Sub Scenario 7a: Lender Sells Loan by Accepting Another Lender’s Offer

1. **Loan Initiation**
   - A loan is active (e.g., lender Alice lent 1000 USDC to borrower Bob at 5% interest for 30 days, with 0.5 WETH collateral).
   - Alice holds a Lender NFT with status "Loan Initiated."

2. **Lender Reviews and Accepts Another Lender’s Offer**
   - Another lender, Charlie, has a compatible lender offer on the platform using the same principal/lending asset, payment/prepay asset, and collateral asset types as the original loan.
   - Alice reviews Charlie’s offer via the frontend, which displays a warning if there’s an interest shortfall (e.g., Alice’s loan earns $4.11 USDC interest, Charlie’s offer earns $5.75 USDC, shortfall = $1.64 USDC).
   - Alice accepts Charlie’s offer and pays the gas fee for acceptance.
   - If Alice’s accrued interest (e.g., $2 USDC after 15 days) is less than the shortfall, she pays the difference ($1.64 - $2 = -$0.36, so no additional payment; excess interest goes to treasury).

3. **Smart Contract Actions**
   - Charlie’s compatible lender offer already has the required principal funds escrowed.
   - The smart contract transfers 1000 USDC (Alice’s principal) to Alice.
   - Alice’s accrued interest (e.g., $2 USDC) is sent to the treasury.
   - The loan position is transferred to Charlie, updating the Lender NFT to reflect Charlie as the new lender with status "Loan Initiated."
   - Bob’s repayment obligation remains unchanged, but future payments go to Charlie.
   - Any lender shortfall/top-up is held in escrow and is claimable by Charlie through the Vaipakam Lender NFT when the live loan resolves.

4. **Notifications**
   - Alice receives a notification confirming the sale and principal recovery.
   - Charlie receives a notification confirming the loan acquisition.
   - Bob is notified of the new lender (Charlie) for future repayments.

5. **Loan Closure (Normal Repayment by Borrower)**
   - Bob repays 1050 USDC (principal + interest) to the smart contract before the 30-day duration ends.
   - The smart contract allocates the `Yield Fee`, equal to 1% of the interest (0.5 USDC), to the treasury.
   - Charlie presents the Lender NFT to claim 1049.5 USDC from the escrow.
   - Bob’s 0.5 WETH collateral is released.
   - Both Borrower and Lender NFTs are updated to status "Closed."

### Sub Scenario 7b: Lender Sells Loan by Creating a Borrower Offer

1. **Loan Initiation**
   - Same as Sub Scenario 7a (Alice lent 1000 USDC to Bob at 5% interest for 30 days, with 0.5 WETH collateral).

2. **Lender Creates a Borrower-Like Offer**
   - Alice creates a borrower-style offer, specifying:
     - Desired asset: 1000 USDC (to recover her principal).
     - Maximum interest rate: 7% (to attract a new lender).
     - Collateral type: 0.5 WETH (matching the original loan).
     - Duration: no longer than the remaining term and not worse for Bob, the original borrower.
   - The frontend warns Alice of the interest shortfall (e.g., $1.64 USDC if the new rate is 7%).
   - Alice does not post Bob’s collateral; Bob’s existing live-loan collateral remains the collateral context for the continuing loan.
   - The platform mints an Offer NFT for Alice with status "Offer Created."

3. **New Lender Accepts the Offer**
   - A new lender, Charlie, accepts Alice’s offer and deposits 1000 USDC into the smart contract.
   - Charlie pays the gas fee for acceptance.
   - The smart contract transfers 1000 USDC to Alice (her principal).
   - Alice’s accrued interest (e.g., $2 USDC) is sent to the treasury.
   - If there’s an interest shortfall (e.g., $1.64 USDC), it’s covered by the accrued interest or Alice pays the difference (none in this case).
     - In other words, If shortfall is $1.64 USDC and accrued is $2 USDC, she covers the shortfall from accrued, and the remaining $0.36 of accrued interest goes to treasury.

4. **Smart Contract Actions**
   - The loan position is transferred to Charlie, updating the Lender NFT to reflect Charlie as the new lender with status "Loan Initiated."
   - Bob’s repayment obligation remains unchanged, but future payments go to Charlie.
   - Any lender shortfall/top-up is held in escrow and claimable by Charlie through the Vaipakam Lender NFT when the live loan resolves.
   - The platform mints an Acceptor NFT for Charlie with status "Loan Initiated."

5. **Notifications**
   - Same as Sub Scenario 7a.

6. **Loan Closure (Normal Repayment by Borrower)**
   - Same as Sub Scenario 7a.

---

## Scenario 8: Loan Transfer by Borrower

This scenario involves borrower-side preclose. In Phase 1, Option 2 is loan transfer by accepting an existing compatible borrower offer, while Option 3 is offset by creating a new lender offer. In both paths the principal/lending asset type, payment/prepay asset type, and collateral asset type must match the original active loan. The selected terms must favor the original lender, or the original borrower must fully compensate any shortfall.

### Sub Scenario 8a: Borrower Transfers Loan by Accepting Another Borrower’s Offer

1. **Loan Initiation**
   - A loan is active (e.g., lender Alice lent 1000 USDC to borrower Bob at 5% interest for 30 days, with 0.5 WETH collateral).
   - Bob holds a Borrower NFT with status "Loan Initiated."

2. **Borrower Reviews and Accepts Another Borrower’s Offer**
   - Another borrower, Eve, has an offer on the platform (e.g., to borrow 1000 USDC at 3% interest for 30 days, offering 0.6 WETH collateral).
   - Bob reviews Eve’s offer via the frontend, which displays the interest shortfall (e.g., Bob’s loan requires $4.11 USDC interest, Eve’s offer yields $2.47 USDC, shortfall = $1.64 USDC).
   - Bob pays the accrued interest (e.g., $2 USDC after 15 days) and the shortfall ($1.64 USDC) to the smart contract (increment the heldForLender field with shortfall $1.64 USDC + $2 USDC accrued interest).
   - Bob pays the gas fee for acceptance.

3. **Smart Contract Actions**
   - Eve locks 0.6 WETH collateral (same type, equal or greater amount) into the smart contract.
   - The smart contract releases Bob’s 0.5 WETH collateral.
   - The loan obligation is transferred to Eve, updating the Borrower NFT to reflect Eve as the new borrower with status "Loan Initiated."
   - The live loan borrower changes to Eve. No new principal is sent out again from the original lender; Eve assumes the continuing repayment obligation under the transferred live loan.
   - Alice’s repayment (principal + interest) is now owed by Eve.
   - Funds are held in escrow (tracked by `heldForLender`) until Alice claims them at loan closure by presenting the Lender NFT.

4. **Notifications**
   - Bob receives a notification confirming the loan transfer and collateral release.
   - Eve receives a notification confirming the loan acquisition.
   - Alice is notified of the new borrower (Eve) for future repayments.

5. **Loan Closure (Normal Repayment by New Borrower)**
   - Eve repays 1050 USDC (principal + interest, adjusted for the original 5% rate) to the smart contract before the 30-day duration ends.
   - The smart contract allocates the `Yield Fee`, equal to 1% of the interest (0.5 USDC), to the treasury.
   - Alice presents the Lender NFT to claim 1049.5 USDC from the escrow.
   - Eve’s 0.6 WETH collateral is released.
   - Both Borrower and Lender NFTs are updated to status "Closed."

### Sub Scenario 8b: Borrower Offsets Loan by Creating a Lender Offer

1. **Loan Initiation**
   - Same as Sub Scenario 8a (Alice lent 1000 USDC to Bob at 5% interest for 30 days, with 0.5 WETH collateral).

2. **Borrower Creates a New Lender Offer**
   - Bob creates a new lender offer as an offsetting position, specifying:
     - Lending asset: 1000 USDC (matching the loan principal).
     - Interest rate: 3% (to attract a new borrower).
     - Collateral type: 0.6 WETH (same type, equal or greater amount).
     - Duration: not exceeding the remaining term and not worse for Alice, the original lender.
   - Bob deposits 1000 USDC (the principal he borrowed) into the smart contract.
   - The frontend warns Bob of the interest shortfall (e.g., $1.64 USDC).
   - Bob pays the accrued interest (e.g., $2 USDC) and the shortfall ($1.64 USDC) to the smart contract.
   - The platform mints an Offer NFT for Bob with status "Offer Created."

3. **New Borrower Accepts the Offer**
   - A new borrower, Eve, accepts Bob’s offer and locks 0.6 WETH collateral into the smart contract.
   - Eve pays the gas fee for acceptance.
   - The smart contract transfers 1000 USDC from Bob’s new lender offer to Eve as the borrower in the new offsetting loan.
   - Bob’s original 0.5 WETH collateral is released only when the offset is completed and Alice’s full old-lender settlement is preserved.

4. **Smart Contract Actions**
   - Bob’s original borrower position with Alice is closed or moved to settlement state.
   - Bob becomes lender in the new offsetting loan to Eve. Alice’s old lender-side value is preserved through the offset settlement claim path.
   - The platform mints an Acceptor NFT for Eve with status "Loan Initiated."
   - Funds are held in escrow (tracked by `heldForLender`) until Alice claims them at loan closure by presenting the Lender NFT.

5. **Notifications**
   - Same as Sub Scenario 8a.

6. **Loan Closure (Normal Repayment by New Borrower)**
   - Same as Sub Scenario 8a.

---

## Notes

- **Cross-Chain Considerations (Phase 2)**: Cross-chain loans and bridge integrations are Phase 2 scope. Phase 1 loans and preclose flows stay on a single network. Phase 1 lender early-withdrawal and refinance flows also stay on a single network and are limited to active ERC20 loans.
- **Illiquid Assets**: If the loan involves illiquid collateral (e.g., low-liquidity ERC-20 or NFT), the same rules from Scenario 4 apply. On default, the full collateral is transferred to the lender without liquidation.
- **NFT Updates**: All NFT metadata (Lender, Borrower, Offer, Acceptor) are updated on-chain to reflect status changes (e.g., "Loan Initiated," "Closed") during loan sales or transfers. Events are emitted for transparency.
- **Fee Management**: Notification fees (~0.001 ETH per alert) are paid by the party triggering the action (e.g., original lender for sale, original borrower for transfer). The `Yield Fee` (1% of accrued interest) applies to all repayments.
- **Governance Tokens (VNGK, Phase 2)**: VNGK rewards, staking, and governance distribution mechanics are Phase 2 scope, not Phase 1 workflow requirements.
