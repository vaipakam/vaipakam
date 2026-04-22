# Vaipakam For All Users

This guide explains Vaipakam in plain language first, then adds the deeper details advanced users care about.

If you read only one user-facing document about the protocol, this should be it.

---

## 1. What Vaipakam Is

Vaipakam is a decentralized peer-to-peer lending and renting protocol.

In Phase 1, it supports two main product types:

- `ERC-20 lending`: one user lends fungible tokens like USDC, ETH, or WBTC to another user against collateral.
- `NFT renting`: one user rents out a rentable NFT, while the renter prepays the rental fees plus a buffer.

Vaipakam is not a pooled lending market. It is an offer-based protocol:

- users create offers
- other users accept them
- the protocol escrows the assets
- special Vaipakam NFTs represent the live positions and claim rights

---

## 2. The Two Most Important Mental Models

### ERC-20 Loan

Think of this like a collateralized private loan:

- lender provides the lending asset
- borrower provides collateral
- borrower repays principal plus interest
- lender claims repayment with their Vaipakam lender NFT
- borrower claims collateral back with their Vaipakam borrower NFT

### NFT Rental

Think of this like a prepaid usage license:

- lender deposits the NFT into escrow
- borrower does not receive ownership of the NFT
- borrower only receives temporary user rights
- borrower prepays the rental fees plus a 5% buffer in ERC-20
- after proper rental closure, lender gets rental income and borrower gets the buffer back

For NFT renting, the NFT stays escrow-controlled during the rental.

---

## 3. Your Vaipakam NFT Is Extremely Important

Each side of a live position is represented by a Vaipakam NFT.

- The lender-side NFT controls lender-side claims.
- The borrower-side NFT controls borrower-side claims.

This means:

- if you transfer the NFT, you transfer the claim rights
- if someone else holds the NFT, they hold the claim rights
- repayment alone does not give someone collateral rights

Practical rule:

- the current holder of the relevant Vaipakam NFT is the one who can claim

---

## 4. What Assets Are Supported

### Lending Assets

- ERC-20 tokens
- rentable ERC-721 / ERC-1155 NFTs for rental-style lending

### Collateral Assets

- for ERC-20 loans: ERC-20 or ERC-721 / ERC-1155 collateral
- for NFT renting: only ERC-20 prepayment plus 5% buffer

### Important NFT Renting Rule

NFT renting does not require separate NFT collateral in Phase 1.

Why:

- the rented NFT remains in escrow
- the borrower gets temporary user rights only
- the ERC-20 prepayment and buffer cover the payment obligation

---

## 5. Networks

Phase 1 supports:

- Ethereum Mainnet
- Polygon
- Arbitrum

Each loan or rental stays on one network from start to finish.

---

## 6. Liquid vs Illiquid Assets

This is one of the most important concepts in Vaipakam.

### Liquid Assets

Liquid ERC-20 assets are assets the protocol can both:

- price reliably
- liquidate through usable market liquidity on the active network

Liquid assets can use:

- LTV monitoring
- Health Factor monitoring
- liquidation flows

### Illiquid Assets

Illiquid assets include:

- NFTs used as collateral
- ERC-20s that fail the protocol’s liquidity checks

Illiquid assets are treated much more conservatively:

- the protocol does not rely on LTV-based liquidation for them
- on default, the lender may receive the full collateral

Simple beginner takeaway:

- liquid collateral can be monitored and liquidated
- illiquid collateral is much harsher on default

---

## 7. Core Terms You Should Know

### Principal

The amount being lent.

### Collateral

The asset the borrower locks to secure an ERC-20 loan.

### Interest

The extra amount owed on top of principal.

### Prepayment

For NFT rentals, the renter prepays the rental fee.

### Buffer

For NFT rentals, the renter adds a 5% extra buffer.

### LTV

Loan-to-Value.

In simple terms:

- how large the debt is compared with the value of the collateral

### Health Factor

A safety ratio for liquid-collateral loans.

In simple terms:

- higher is safer
- lower is riskier

### Grace Period

An extra short period after the due date before full default handling applies.

---

## 8. What a User Can Do in Vaipakam

Users can:

- create lender offers
- create borrower offers
- accept offers
- repay loans
- add collateral
- claim funds or collateral using Vaipakam NFTs
- refinance
- preclose early
- transfer borrower obligations in supported cases
- sell lender positions in supported cases
- manage trusted keeper addresses if they are advanced users

---

## 9. Basic Flow: ERC-20 Loan

### Step 1: Offer Creation

One side creates an offer.

For example:

- lender offers 1000 USDC for 30 days
- borrower must provide a chosen collateral asset and amount

### Step 2: Offer Acceptance

The matching counterparty accepts the offer.

At that point:

- principal is provided to the borrower
- collateral is escrowed
- Vaipakam NFTs are minted / updated for both sides
- the live loan begins

### Step 3: During the Loan

The borrower may:

- repay in full
- in some cases repay partially
- add collateral
- use supported preclose or refinance flows

### Step 4: Repayment

When repaid successfully:

- lender-side value becomes claimable to the lender-side NFT holder
- borrower-side collateral becomes claimable to the borrower-side NFT holder

### Step 5: Claims

Each side claims through the protocol using the relevant Vaipakam NFT.

---

## 10. Basic Flow: NFT Rental

### Step 1: Offer Creation

An NFT owner or renter creates an offer.

### Step 2: Escrow and Prepayment

- the NFT goes to escrow
- the renter prepays the rental amount plus 5% buffer in ERC-20

### Step 3: User Rights

The renter receives temporary user rights, not ownership.

### Step 4: Rental Closure

At proper closure:

- user rights are revoked
- lender gets rental proceeds
- borrower gets the refundable buffer back

---

## 11. Who Can Repay

For ERC-20 loans, full repayment may be submitted by:

- the borrower
- or any third party willing to pay on the borrower’s behalf

But this is critical:

- repaying the loan does not give the repayer any collateral rights
- collateral remains claimable only by the current holder of the borrower-side Vaipakam NFT

Simple rule:

- payment sender and collateral claimant can be different people

---

## 12. Claims and Ownership

Claims are NFT-controlled.

### Lender Claim

The holder of the lender-side Vaipakam NFT can claim:

- principal
- interest
- rental proceeds
- default or fallback entitlement, depending on the situation

### Borrower Claim

The holder of the borrower-side Vaipakam NFT can claim:

- returned collateral after successful repayment
- refunded rental buffer
- residual value after certain liquidation/default paths, where applicable

---

## 13. What Happens If Things Go Wrong

### A. Late Repayment

Late fees can apply after the due date.

### B. Default

If the borrower does not meet obligations by the end of the grace period:

- default handling starts

### C. Liquid Collateral Loans

If a liquid-collateral ERC-20 loan becomes unsafe:

- liquidation can be triggered

### D. Illiquid Collateral Loans

If collateral is illiquid:

- there is no normal market liquidation path
- the lender may receive the full collateral on default

### E. NFT Rental Default

If the renter does not close properly or obligations are not met:

- rental settlement happens through the prepaid ERC-20 path
- the NFT remains under protocol-controlled custody and is returned according to the rental/default flow

---

## 14. Permissionless Liquidation

Liquidation is permissionless.

This means:

- anyone can trigger liquidation if protocol conditions are met

This is intentional. It is a protocol-safety feature, not theft.

Vaipakam keeps liquidation permissionless even if broader third-party execution is disabled.

---

## 15. Failed Liquidation and Fallback

Sometimes a liquid-collateral liquidation cannot complete normally.

This can happen because of:

- market stress
- technical failure
- lack of usable liquidity
- slippage above the protocol threshold

In that case:

- the lender may claim immediately after failed liquidation
- before lender claim finishes, the borrower may still:
  - repay in full
  - or add collateral to cure the position
- if lender claim starts, that claim path is final for that transaction
- at lender claim time, the protocol may try liquidation one more time

If that retry still fails:

- settlement may happen in collateral units instead of swapped lending-asset units
- lender gets the documented fallback entitlement
- treasury gets its documented fallback share
- remaining value, if any, stays attributable to the borrower

---

## 16. Early Exit and Advanced Position Management

Vaipakam supports more than simple “borrow and repay” flows.

Advanced users may use:

- early repayment / preclose
- refinance
- borrower obligation transfer
- lender early withdrawal / sale flows

Important principle:

- these flows are designed so the original counterparty should not be made worse off than the original agreed protection and economics, except under normal default risk

---

## 17. Keepers, Bots, and MEV Policy

Vaipakam does not treat “open MEV bots everywhere” as a feature.

Instead, it separates protocol-safety actions from optional third-party execution.

### Default Rule

Non-liquidation third-party execution is off by default.

### Permissionless Exception

These remain permissionless where the protocol requires it:

- liquidation
- default triggering when protocol conditions are met
- full repayment
- deterministic rental-maintenance actions where applicable

### Advanced User Keeper Model

Advanced users may opt in to trusted keepers.

Rules:

- each user can whitelist up to 5 keeper addresses
- for a keeper to act on a live loan, that keeper must be approved by both lender and borrower where required by the protocol flow
- keeper access applies only to narrowly allowed actions

Vaipakam does not intend to grant broad “bots allowed” access outside those rules.

---

## 18. Which Actions Are Permissionless, Party-Only, or Keeper-Optional

### Permissionless

- liquidation
- default trigger
- full repayment
- some deterministic rental-maintenance execution

### Party-Only

- create offer
- accept offer
- cancel offer
- add collateral
- partial repay
- claims
- refinance initiation
- borrower-side preclose initiation
- lender sale-offer creation
- admin / treasury / upgrade actions

### Keeper-Optional

Only narrow, deterministic completion flows that the protocol explicitly allows.

Phase 1 examples:

- complete loan sale
- complete offset

---

## 19. KYC and Country Rules

Vaipakam uses compliance tiers and country checks.

High-level user version:

- small activity may require less verification
- larger activity may require more verification
- some country combinations may not be allowed to trade with each other through the protocol

Users should expect:

- country checks
- KYC thresholds
- blocked flows if the compliance rules are not satisfied

---

## 20. Fees

Users should expect:

- lender interest or rental fees
- `Yield Fee` on certain earnings
- late fees where applicable
- liquidation or fallback consequences if obligations are not met

The exact economics depend on the flow being used.

---

## 21. Beginner Safety Checklist

Before accepting or creating anything, check:

- Am I using the correct network?
- Am I the lender or the borrower?
- What exactly am I lending, borrowing, or renting?
- Is my collateral liquid or illiquid?
- What happens if I am late?
- What NFT will I receive, and what rights does it control?
- If someone else repays, do I understand that collateral rights still stay with the borrower-side NFT?

---

## 22. Beginner vs Advanced Mode

### Basic Mode

Best for:

- first-time users
- simple lending / borrowing
- simple rental flows
- users who want guided UI and fewer decisions

### Advanced Mode

Best for:

- users managing keepers
- users using preclose, refinance, or loan sale flows
- users who want deeper protocol controls and diagnostics

If you are unsure, start in Basic Mode.

---

## 23. Troubleshooting

The Vaipakam frontend is expected to help users understand what happened when something fails.

Users should expect:

- clear error messages
- step-by-step diagnostics for important actions
- wallet / chain / contract error capture
- support-friendly diagnostics export

If a transaction fails:

- check wallet connection
- check network
- check token approval / escrow readiness
- check whether the action is allowed for your NFT role
- check whether keeper permissions or whitelist rules are relevant

---

## 24. What Advanced Users Should Pay Attention To

Advanced users should understand:

- keeper whitelists and mutual keeper approval
- liquidation and fallback behavior
- preclose / refinance / lender sale economics
- NFT-based claim rights
- liquid vs illiquid collateral treatment
- cross-network restrictions
- escrow upgrade requirements if a mandatory upgrade is introduced

---

## 25. Final Practical Rules

- Your Vaipakam NFT controls your claim rights.
- Repayment does not automatically transfer collateral rights.
- Liquidation is permissionless.
- Illiquid collateral is harsher on default.
- NFT rentals give temporary use rights, not ownership.
- Advanced keeper access is opt-in and whitelist-based.
- If you do not understand a flow, use Basic Mode and do not rush into Advanced actions.

---

## 26. One-Sentence Summary

Vaipakam lets users create peer-to-peer token loans and NFT rentals with on-chain escrow, NFT-based claim rights, permissionless safety liquidation, and optional advanced controls for experienced users.
