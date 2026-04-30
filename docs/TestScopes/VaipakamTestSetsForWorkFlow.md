# Vaipakam Lending Platform Test Workflows

This document provides detailed Phase 1 test workflows for the Vaipakam decentralized P2P lending, borrowing and NFT rental platform. These scenarios cover ERC20 lending, NFT lending/renting, illiquid collateral, lender early withdrawal, and borrower preclose. They follow the README as the source of truth: Phase 1 loans are single-network flows; governance, staking, cross-chain bridging, and VNGK rewards are Phase 2; ERC721 and ERC1155 rental NFTs are escrow-custodied; borrowers receive only temporary user rights; preclose flows must preserve principal/lending asset type, payment/prepay asset type, and collateral asset type; and lender early-withdrawal plus refinance flows apply only to active ERC20 loans.

---

## Table of Contents

- [Vaipakam Lending Platform Test Workflows](#vaipakam-lending-platform-test-workflows)
  - [Table of Contents](#table-of-contents)
  - [Scenario 1: ERC20 Lending with ERC20 Lender Asset and ERC20 Borrower Collateral](#scenario-1-erc20-lending-with-erc20-lender-asset-and-erc20-borrower-collateral)
    - [Sub-Scenario 1a: Borrower Proper Repayment](#sub-scenario-1a-borrower-proper-repayment)
    - [Sub-Scenario 1b: Borrower Defaults](#sub-scenario-1b-borrower-defaults)
  - [Scenario 2: NFT Lending (Renting) with ERC20 Collateral](#scenario-2-nft-lending-renting-with-erc20-collateral)
    - [Sub-Scenario 2a: Lending with ERC-721 NFT](#sub-scenario-2a-lending-with-erc-721-nft)
    - [Sub-Scenario 2b: Lending with ERC-1155 NFT](#sub-scenario-2b-lending-with-erc-1155-nft)
  - [Scenario 4: Lending with Illiquid Collateral](#scenario-4-lending-with-illiquid-collateral)
    - [Sub-Scenario 4a: Borrower Defaults with Illiquid ERC20 Collateral](#sub-scenario-4a-borrower-defaults-with-illiquid-erc20-collateral)
    - [Sub-Scenario 4b: NFT Lending with Illiquid NFT Collateral (Phase 2 / Non-Baseline)](#sub-scenario-4b-nft-lending-with-illiquid-nft-collateral-phase-2--non-baseline)
  - [Scenario 7: Loan Sales by Lender](#scenario-7-loan-sales-by-lender)
    - [Sub-Scenario 7a: Lender Sells Loan by Accepting Another Lender’s Offer (ERC-20)](#sub-scenario-7a-lender-sells-loan-by-accepting-another-lenders-offer-erc-20)
    - [Sub-Scenario 7b: Lender Sells Loan by Creating a Borrower-Style Offer (ERC-20)](#sub-scenario-7b-lender-sells-loan-by-creating-a-borrower-style-offer-erc-20)
  - [Scenario 8: Loan Transfers by Borrower](#scenario-8-loan-transfers-by-borrower)
    - [Sub-Scenario 8a: Borrower Transfers Loan by Accepting Another Borrower’s Offer (ERC-20)](#sub-scenario-8a-borrower-transfers-loan-by-accepting-another-borrowers-offer-erc-20)
    - [Sub-Scenario 8b: Borrower Offsets Loan by Creating a Lender Offer (ERC-20)](#sub-scenario-8b-borrower-offsets-loan-by-creating-a-lender-offer-erc-20)

---

## Scenario 1: ERC20 Lending with ERC20 Lender Asset and ERC20 Borrower Collateral

This scenario involves a lender offering ERC20 tokens (e.g., USDC) to lend, with the borrower providing another ERC20 token (e.g., WETH) as collateral. We test two sub-scenarios: proper repayment and borrower default.

### Sub-Scenario 1a: Borrower Proper Repayment

**Objective**: Verify that a borrower can successfully repay an ERC20 loan, releasing collateral and transferring funds correctly.

**Workflow**:

1. **Setup**:
   - Deploy mock ERC20 tokens: USDC (lender asset) and WETH (borrower collateral).
   - Mint 10,000 USDC to the lender and 5 WETH to the borrower.
   - Deploy Vaipakam contracts (e.g., `VaipakamCreateAndCancelOffer`, `VaipakamAcceptOfferAndInitiateLoan`, `VaipakamRepayLoan`, `VaipakamEscrow`).

2. **Offer Creation**:
   - As the lender, approve 1,000 USDC to the escrow contract.
   - Create a lending offer with:
     - Lender asset: 1,000 USDC.
     - Borrower collateral: 1 WETH.
     - Loan terms: 5% interest (50 USDC), 30-day duration.
   - Record the offer ID.

3. **Loan Initiation**:
   - As the borrower, approve 1 WETH to the escrow contract.
   - Accept the offer using the offer ID.
   - Verify:
     - Loan status is `Active`.
     - 1,000 USDC is transferred to the borrower.
     - 1 WETH is locked in escrow.

4. **Repayment**:
   - Warp time forward 15 days (within the 30-day duration).
   - As the borrower, approve 1,050 USDC (principal + interest) to the escrow.
   - Call `repayLoan` with the loan ID.
   - Verify:
     - Loan status changes to `Repaid`.
     - 1 WETH is returned to the borrower.
     - 1,050 USDC is transferred to the lender.

5. **Assertions**:
   - Borrower’s WETH balance: 5 WETH (initial balance restored).
   - Lender’s USDC balance: 10,050 USDC (10,000 - 1,000 + 1,050).
   - Borrower’s USDC balance: 8,950 USDC (assuming borrower started with 10,000 USDC).

### Sub-Scenario 1b: Borrower Defaults

**Objective**: Ensure that if the borrower fails to repay, the lender can liquidate the loan and claim the collateral.

**Workflow**:

1. **Setup**:
   - Same as Sub-Scenario 1a.

2. **Offer Creation**:
   - Same as Sub-Scenario 1a.

3. **Loan Initiation**:
   - Same as Sub-Scenario 1a.

4. **Default**:
   - Warp time forward 31 days (past the 30-day duration).
   - As the lender, call `defaultOrLiquidateLoan` on the `VaipakamLiquidationAndDefault` contract with the loan ID.
   - Verify:
     - Loan status changes to `Liquidated`.
     - 1 WETH is transferred to the lender.

5. **Assertions**:
   - Lender’s WETH balance: 1 WETH.
   - Borrower’s WETH balance: 4 WETH (5 - 1).
   - Lender’s USDC balance: 9,000 USDC (10,000 - 1,000 lent).
   - Borrower’s USDC balance: 11,000 USDC (10,000 + 1,000 borrowed).

---

## Scenario 2: NFT Lending (Renting) with ERC20 Collateral

This scenario involves a lender offering an NFT for rent, with the borrower providing ERC20 tokens (e.g., USDC) as collateral. We test renting with proper NFT return for both ERC-721 and ERC-1155 token standards.

### Sub-Scenario 2a: Lending with ERC-721 NFT

**Objective**: Confirm that an ERC-721 NFT can be rented, returned properly, and fees are transferred correctly.

**Workflow**:

1. **Setup**:
   - Deploy an ERC-721 mock contract and mint token ID 1 to the lender.
   - Mint 10,000 USDC to the borrower.
   - Deploy Vaipakam contracts.

2. **Offer Creation**:
   - As the lender, approve ERC-721 token ID 1 to the escrow contract.
   - Create a lending offer with:
     - Lender asset: ERC-721 token ID 1.
     - Borrower collateral: 1,500 USDC (rental fee + buffer).
     - Loan terms: 10 USDC/day rental rate, 30-day duration (300 USDC total).
   - Record the offer ID.

3. **Loan Initiation**:
   - As the borrower, approve 1,500 USDC to the escrow contract.
   - Accept the offer using the offer ID.
   - Verify:
     - Loan status is `Active`.
     - ERC-721 token ID 1 remains in the lender’s Vaipakam Escrow.
     - Borrower receives only temporary ERC-4907 `user` rights.
     - 1,500 USDC is locked in escrow.

4. **Return**:
   - Warp time forward 15 days (within duration).
   - As the borrower, call `repayLoan` (returning the NFT).
   - Verify:
     - Loan status changes to `Repaid`.
     - Borrower user rights are revoked.
     - ERC-721 token ID 1 is claimable/returnable to the lender from escrow.
     - 300 USDC (rental fee) is transferred to the lender.
     - 1,200 USDC (buffer) is returned to the borrower.

5. **Assertions**:
   - NFT owner/custodian before lender claim: lender’s Vaipakam Escrow.
   - NFT owner after lender claim: Lender.
   - Lender’s USDC balance: 300 USDC.
   - Borrower’s USDC balance: 9,700 USDC (10,000 - 1,500 + 1,200).

### Sub-Scenario 2b: Lending with ERC-1155 NFT

**Objective**: Validate renting and returning an ERC-1155 NFT with multiple tokens.

**Workflow**:

1. **Setup**:
   - Deploy an ERC-1155 mock contract and mint 10 tokens of ID 1 to the lender.
   - Mint 10,000 USDC to the borrower.

2. **Offer Creation**:
   - As the lender, approve all ERC-1155 tokens to the escrow contract.
   - Create a lending offer with:
     - Lender asset: 5 tokens of ERC-1155 ID 1.
     - Borrower collateral: 1,500 USDC (based on 5 tokens).
     - Loan terms: 10 USDC/day per token, 30-day duration (1,500 USDC total).
   - Record the offer ID.

3. **Loan Initiation**:
   - As the borrower, approve 1,500 USDC to the escrow.
   - Accept the offer.
   - Verify:
     - Loan status is `Active`.
     - 5 ERC-1155 tokens (ID 1) remain in the lender’s Vaipakam Escrow.
     - Borrower receives only temporary user rights.
     - 1,500 USDC is locked in escrow.

4. **Return**:
   - Warp time forward 15 days.
   - As the borrower, call `repayLoan`.
   - Verify:
     - Loan status changes to `Repaid`.
     - Borrower user rights are revoked.
     - 5 ERC-1155 tokens are claimable/returnable to the lender from escrow.
     - 1,500 USDC is transferred to the lender (no buffer in this case).

5. **Assertions**:
   - Lender’s ERC-1155 balance (ID 1): 10 tokens.
   - Borrower’s ERC-1155 balance (ID 1): 0 tokens throughout the rental.
   - Lender’s USDC balance: 1,500 USDC.
   - Borrower’s USDC balance: 8,500 USDC (10,000 - 1,500).

---

## Scenario 4: Lending with Illiquid Collateral

This scenario tests lending where the borrower provides illiquid collateral (e.g., low-liquidity ERC20 or NFT), focusing on default cases where collateral is transferred to the lender.

### Sub-Scenario 4a: Borrower Defaults with Illiquid ERC20 Collateral

**Objective**: Ensure that illiquid ERC20 collateral is fully transferred to the lender upon default.

**Workflow**:

1. **Setup**:
   - Deploy an illiquid ERC20 mock (e.g., USDC7674) and mint 10,000 tokens to the borrower.
   - Mint 10,000 USDC to the lender.

2. **Offer Creation**:
   - As the lender, approve 1,000 USDC to the escrow.
   - Create a lending offer with:
     - Lender asset: 1,000 USDC.
     - Borrower collateral: 1,500 USDC7674 (illiquid).
     - Loan terms: 5% interest, 30-day duration.
   - Record the offer ID.

3. **Loan Initiation**:
   - As the borrower, approve 1,500 USDC7674 to the escrow.
   - Accept the offer.
   - Verify:
     - Loan status is `Active`.
     - 1,000 USDC is transferred to the borrower.
     - 1,500 USDC7674 is locked in escrow.

4. **Default**:
   - Warp time forward 31 days.
   - As the lender, call `defaultOrLiquidateLoan`.
   - Verify:
     - Loan status changes to `Defaulted`.
     - 1,500 USDC7674 is transferred to the lender.

5. **Assertions**:
   - Lender’s USDC7674 balance: 1,500 tokens.
   - Borrower’s USDC7674 balance: 8,500 tokens (10,000 - 1,500).
   - Lender’s USDC balance: 9,000 USDC (10,000 - 1,000).
   - Borrower’s USDC balance: 11,000 USDC (10,000 + 1,000).

### Sub-Scenario 4b: NFT Lending with Illiquid NFT Collateral (Phase 2 / Non-Baseline)

**Objective**: Document a future/non-baseline test. In Phase 1 NFT rentals use ERC20 prepayment plus buffer as the borrower-side collateral model; NFT-as-collateral edge cases are illiquid and require explicit consent handling.

**Workflow**:

1. **Setup**:
   - Deploy an ERC-721 mock and mint token ID 2 to the borrower and token ID 1 to the lender.

2. **Offer Creation**:
   - As the lender, approve ERC-721 token ID 1 to the escrow.
   - Create a lending offer with:
     - Lender asset: ERC-721 token ID 1.
     - Borrower collateral: ERC-721 token ID 2 (illiquid).
     - Loan terms: 300 USDC rental fee, 30-day duration.
   - Record the offer ID.

3. **Loan Initiation**:
   - As the borrower, approve ERC-721 token ID 2 to the escrow.
   - Accept the offer.
   - Verify:
     - Loan status is `Active`.
     - ERC-721 token ID 1 remains in the lender’s Vaipakam Escrow.
     - Borrower receives only temporary user rights.
     - ERC-721 token ID 2 is locked in escrow.

4. **Default**:
   - Warp time forward 31 days.
   - As the lender, call `defaultOrLiquidateLoan`.
   - Verify:
     - Loan status changes to `Defaulted`.
     - ERC-721 token ID 2 is transferred to the lender.

5. **Assertions**:
   - Owner of token ID 1: Lender (returned due to default handling).
   - Owner of token ID 2: Lender.
   - Borrower’s NFT holdings: None.

---

## Scenario 7: Loan Sales by Lender

This scenario covers lender early withdrawal for active ERC20 loans only. Per the README, NFT rental loans and other non-ERC20 loan/rental positions are not eligible for lender early withdrawal in Phase 1. Each Phase 1 ERC20 early-withdrawal option has one path: Option 1 accepts an existing compatible lender offer, and Option 2 creates a new borrower-style offer. The principal/lending asset type, payment/prepay asset type, and collateral asset type must match the original live loan, and the replacement terms must not make the original borrower worse off.

### Sub-Scenario 7a: Lender Sells Loan by Accepting Another Lender’s Offer (ERC-20)

**Objective**: Verify that a lender can sell their loan by accepting another lender’s offer, transferring the loan position to the new lender.

**Workflow**:

1. **Setup**:
   - Create an initial loan with the lender offering 1,000 USDC and the borrower providing 1 WETH as collateral.
   - Record the initial loan ID.

2. **New Lender Offer Creation**:
   - As the new lender, approve 1,000 USDC to the escrow contract.
   - Create a compatible lender offer:
     - Lender asset: 1,000 USDC.
     - Borrower collateral: 1 WETH.
     - Loan terms: duration not longer than the remaining live-loan duration and terms that do not worsen the original borrower’s position.

3. **Loan Sale**:
   - As the original lender, accept the new lender’s offer to sell the loan.
   - Verify:
     - The live loan’s lender position is transferred to the new lender.
     - The original lender receives the principal (1,000 USDC).
     - The new lender’s offer is accepted, and they become the new lender.

4. **Assertions**:
   - Original loan status remains `Active`.
   - New lender owns the lender NFT for the live loan.
   - Original lender’s NFT is burned.
   - Borrower’s loan position remains unchanged.

### Sub-Scenario 7b: Lender Sells Loan by Creating a Borrower-Style Offer (ERC-20)

**Objective**: Ensure that a lender can early-withdraw by creating a borrower-style offer, allowing another lender to accept it and take over the live lender position.

**Workflow**:

1. **Setup**:
   - Create an initial loan with the lender offering 1,000 USDC and the borrower providing 1 WETH as collateral.
   - Record the initial loan ID.

2. **Borrower-Style Offer Creation**:
   - As the original lender, create a compatible borrower-style offer:
     - Lender asset: 1,000 USDC.
     - Borrower collateral: 1 WETH.
     - Loan terms: 5% interest (50 USDC), duration no longer than the original remaining duration.

3. **New Lender Accepts Offer**:
   - As the new lender, accept the borrower-style offer created by the original lender.
   - Verify:
     - Any temporary offer-acceptance loan is completed/cleaned up.
     - The original lender’s loan position is transferred.
     - The original lender receives the principal (1,000 USDC).
     - The new lender becomes the new lender of the loan.

4. **Assertions**:
   - Original live loan status remains `Active`.
   - New lender owns the lender NFT for the live loan.
   - Original lender’s NFT is burned.
   - Borrower’s loan position remains unchanged.

---

## Scenario 8: Loan Transfers by Borrower

This scenario covers borrower preclose. Per the README, Option 2 accepts an existing compatible borrower offer, while Option 3 creates a new lender offer as an offsetting position. The principal/lending asset type, payment/prepay asset type, and collateral asset type must match the original active loan, and the replacement terms must not make the original lender worse off unless the original borrower compensates the shortfall.

### Sub-Scenario 8a: Borrower Transfers Loan by Accepting Another Borrower’s Offer (ERC-20)

**Objective**: Verify that a borrower can transfer their loan by accepting another borrower’s offer, shifting the loan obligation to the new borrower.

**Workflow**:

1. **Setup**:
   - Create an initial loan with the lender offering 1,000 USDC and the borrower providing 1 WETH as collateral.
   - Record the initial loan ID.

2. **New Borrower Offer Creation**:
   - As the new borrower, approve 1 WETH to the escrow contract.
   - Create a compatible borrower offer:
     - Lender asset: 1,000 USDC.
     - Borrower collateral: 1 WETH.
     - Loan terms: duration not longer than the remaining original term and terms that preserve or improve the original lender’s economics/protection.

3. **Loan Transfer**:
   - As the original borrower, accept the new borrower’s offer to transfer the loan.
   - Verify:
     - The live loan borrower changes to the new borrower.
     - The original borrower’s collateral (1 WETH) is released.
     - The new borrower’s collateral (1 WETH) is locked in escrow.

4. **Assertions**:
   - Original/live loan status remains `Active`.
   - New borrower owns the borrower NFT for the live loan.
   - Original borrower’s NFT is burned.
   - Lender’s loan position remains unchanged.

### Sub-Scenario 8b: Borrower Offsets Loan by Creating a Lender Offer (ERC-20)

**Objective**: Ensure that a borrower can preclose by creating a new lender offer, allowing another borrower to accept the new offsetting offer while the original lender is made whole.

**Workflow**:

1. **Setup**:
   - Create an initial loan with the lender offering 1,000 USDC and the borrower providing 1 WETH as collateral.
   - Record the initial loan ID.

2. **Offsetting Lender Offer Creation**:
   - As the original borrower, create a lender offer with compatible terms:
     - Lender asset: 1,000 USDC.
     - Borrower collateral: 1 WETH.
     - Loan terms: duration not longer than the remaining original term and terms that preserve or improve the original lender’s economics/protection.

3. **New Borrower Accepts Offer**:
   - As the new borrower, accept the lender offer created by the original borrower.
   - Verify:
     - A new offsetting loan is created with the original borrower as lender.
     - The original borrower’s old loan is completed/closed only after the offset completion step preserves the original lender’s full claimable value.
     - The original borrower’s collateral (1 WETH) is released after offset completion.
     - The new borrower’s collateral (1 WETH) is locked in escrow.

4. **Assertions**:
   - New offsetting loan status is `Active`.
   - New borrower owns the borrower NFT for the new offsetting loan.
   - Original borrower’s old borrower NFT is closed/burned after offset completion.
   - Original lender has a preserved claim path for principal, accrued interest, and any shortfall.

---
