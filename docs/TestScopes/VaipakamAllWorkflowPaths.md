# Vaipakam All Workflow Paths

This document is a README-aligned catalog of Vaipakam workflow paths. It is intended to be the implementation and QA map for Phase 1 behavior, while clearly marking Phase 2 items as future scope.

## Source Of Truth

- The source of truth is `/README.md`.
- Phase 1 loans are single-network flows.
- Cross-chain lending, VNGK governance, staking, and VNGK reward distribution are Phase 2.
- ERC721 and ERC1155 rental NFTs are escrow-custodied during active rental positions. Borrowers receive only temporary user rights and never receive custody or ownership of the underlying NFT.
- Borrower preclose flows must preserve the same principal/lending asset type, payment/prepay asset type, and collateral asset type as the original loan.
- Phase 1 borrower preclose Option 3, lender early-withdrawal, and refinance flows apply only to active ERC20 loans. NFT rental loans and other non-ERC20 loan/rental positions must be rejected from those flows.

## Phase 1 Workflow Map

| Area | Path | Phase 1 Scope |
| --- | --- | --- |
| Offer creation | ERC20 lender offer | Supported |
| Offer creation | ERC20 borrower offer | Supported |
| Offer creation | NFT rental lender offer | Supported with ERC721/ERC1155 escrow custody |
| Offer creation | NFT rental borrower offer | Supported with ERC20 prepayment and lender NFT escrow on acceptance |
| Offer management | Offer cancellation | Supported while offer is not accepted |
| Loan initiation | ERC20 loan | Supported |
| Loan initiation | Partial lending / borrowing | Supported where offer terms allow partial acceptance |
| Loan initiation | NFT rental | Supported |
| Repayment | ERC20 full repayment | Supported |
| Repayment | NFT rental close / return | Supported |
| Repayment | NFT rental daily deduction | Supported |
| Default | Liquid ERC20 collateral liquidation | Supported |
| Default | Illiquid ERC20 collateral default transfer | Supported |
| Default | NFT rental default | Supported |
| Borrower preclose | Option 1, standard early repayment | Supported |
| Borrower preclose | Option 2, accept existing borrower offer | Supported |
| Borrower preclose | Option 3, create new lender offer offset | Supported for active ERC20 loans only |
| Lender early withdrawal | Option 1, accept existing lender offer | Supported for active ERC20 loans only |
| Lender early withdrawal | Option 2, create borrower-style offer | Supported for active ERC20 loans only |
| Lender early withdrawal | Option 3, wait to maturity | Supported |
| Refinance | Borrower-offer-led refinance | Supported for active ERC20 loans only |
| Collateral management | Add collateral | Supported |
| Collateral management | Partial collateral withdrawal | Supported when health factor remains safe |
| Escrow upgrades | Mandatory user-triggered upgrade | Supported by policy |
| Governance | VNGK proposals and voting | Phase 2 |
| Staking | VNGK staking and revenue sharing | Phase 2 |
| Cross-chain lending | Bridged loan flows | Phase 2 |

## Global Rules

### Asset Type Consistency

For borrower preclose, lender early withdrawal, and refinance, the replacement, transfer, offset, or refinance flow must preserve:

- the same principal/lending asset type
- the same payment/prepay asset type
- the same collateral asset type

Amounts and economic terms may vary only where the specific flow permits them. Asset types must not vary.

### Illiquid Assets

- Liquid ERC20 assets are evaluated through oracle and liquidity rules.
- Illiquid ERC20 collateral is not liquidated through LTV-based liquidation. On default, the whole illiquid collateral is transferred to the lender according to the README default rules.
- NFTs are treated as illiquid for collateral valuation and LTV purposes.
- Users must explicitly consent when interacting with illiquid assets.

### KYC And Sanctions

Normal loan initiation checks apply whenever a new counterparty enters a position. This includes:

- jurisdiction compatibility
- sanctions restrictions
- KYC threshold checks
- asset eligibility
- illiquid-asset consent checks

### Vaipakam NFT Claim Model

Lender-side and borrower-side claims are gated by ownership of the relevant Vaipakam position NFT.

- Lenders claim principal, interest, rental fees, and returned rental NFTs through the lender Vaipakam NFT.
- Borrowers claim returned collateral, refunds, and liquidation surplus through the borrower Vaipakam NFT.
- Position NFTs move to claimable or closed state before final burn/settlement.

## Offer Creation Paths

### ERC20 Lender Offer

1. Lender selects principal/lending ERC20 asset, amount, interest rate, duration, collateral asset, and collateral amount.
2. Lender escrows the principal amount.
3. Platform mints a Vaipakam offer NFT for the lender.
4. Borrower can accept the offer by locking compatible collateral.

### ERC20 Borrower Offer

1. Borrower selects desired principal/lending ERC20 asset, amount, interest rate, duration, collateral asset, and collateral amount.
2. Borrower escrows the collateral.
3. Platform mints a Vaipakam offer NFT for the borrower.
4. Lender can accept the offer by funding the principal.

### NFT Rental Lender Offer

1. Lender selects the rentable ERC721 or ERC1155 asset, token ID, quantity if ERC1155, daily rental fee, duration, and ERC20 prepay asset.
2. Lender escrows the ERC721 or ERC1155 token in the lender's Vaipakam Escrow.
3. Platform mints a Vaipakam offer NFT for the lender.
4. Borrower can accept by locking ERC20 prepayment equal to rental fees plus the 5 percent buffer.

### NFT Rental Borrower Offer

1. Borrower selects desired NFT rental terms, maximum daily fee, duration, and ERC20 prepay asset.
2. Borrower escrows ERC20 prepayment equal to rental fees plus the 5 percent buffer.
3. Platform mints a Vaipakam offer NFT for the borrower.
4. Lender can accept by escrowing the matching ERC721 or ERC1155 rental NFT.
5. Borrower receives only temporary user rights.

## Offer Management Paths

### Offer Cancellation

1. Offer creator cancels an unaccepted offer.
2. Escrowed principal, collateral, NFT rental asset, or prepayment is returned to the offer creator according to offer type.
3. Offer status is updated to cancelled.
4. Offer position NFT is updated or burned according to the protocol status model.
5. Accepted offers cannot be cancelled.

## Loan Initiation Paths

### ERC20 Loan Initiation

1. A compatible ERC20 lender or borrower offer is accepted.
2. Principal is transferred to the borrower.
3. Borrower collateral is locked in the borrower's escrow.
4. Loan status becomes active.
5. Vaipakam NFTs are minted or updated for both lender and borrower.

### Partial Lending And Borrowing

1. A user accepts only part of an eligible offer amount.
2. Protocol validates that the partial amount is permitted by the offer rules.
3. Principal, collateral, duration, rate, and risk checks are calculated for the accepted partial amount.
4. One accepted offer may create more than one related loan if the offer has remaining available amount.
5. Escrow accounting must prevent over-acceptance and must keep each loan's collateral and claim accounting independent.

### NFT Rental Initiation

1. A compatible NFT rental offer is accepted.
2. Rental NFT remains escrow-custodied in the lender's Vaipakam Escrow.
3. Borrower ERC20 prepayment and buffer are locked.
4. Escrow assigns temporary user rights to the borrower until expiry.
5. Loan status becomes active.
6. Vaipakam NFTs are minted or updated for lender and borrower.

## Repayment And Closure Paths

### ERC20 Full Repayment

1. Borrower repays principal, interest, and any late fees before the grace period ends.
2. Treasury fee is deducted from interest and late fees according to the README.
3. Lender claim is created for principal plus lender share.
4. Borrower claim is created for collateral return.
5. Vaipakam NFTs move to claimable state.
6. Lender and borrower claim by presenting their position NFTs.
7. Loan settles after claims are complete.

### NFT Rental Close

1. Borrower closes the rental before or within the allowed period.
2. Rental user rights are revoked.
3. Rental fees are allocated to the lender after the `Yield Fee`.
4. Borrower receives refundable unused prepayment and buffer according to the README rules.
5. Escrowed ERC721 or ERC1155 is returned to the lender through the lender NFT-gated claim path.
6. Vaipakam NFTs move to claimable/closed state and are burned after final claim.

### NFT Daily Deduction

1. A daily deduction can occur only after the daily interval has elapsed.
2. The daily rental fee is deducted from borrower prepayment.
3. Lender share and treasury share are allocated.
4. Remaining rental duration and user-right expiry are updated.
5. When the duration reaches zero, the rental moves to claimable/closed state and the lender can reclaim the escrowed NFT through the lender claim path.

## Default And Liquidation Paths

### Liquid ERC20 Collateral Liquidation

1. Loan becomes liquidatable after health factor or post-grace checks.
2. Collateral is swapped or liquidated.
3. Liquidator bonus and applicable protocol fees are handled according to protocol rules.
4. Lender receives claimable value up to the debt owed.
5. Borrower receives any surplus after repayment, fees, and liquidation bonus.
6. Vaipakam NFTs move to claimable or liquidated state.

### Illiquid ERC20 Collateral Default

1. Loan passes the default grace period.
2. Since collateral is illiquid, no DEX liquidation is attempted.
3. Whole illiquid collateral is claimable by or transferred to the lender according to the default model.
4. Any separately tracked payment-asset top-ups must remain claimable through the Vaipakam NFT model.
5. Vaipakam NFTs move to default/claimable state.

### NFT Rental Default

1. Borrower fails to close the rental by the end of the grace period.
2. Borrower user rights are revoked.
3. Rental prepayment is allocated to the lender, with the `Yield Fee` on rental earnings.
4. The 5 percent buffer is routed to treasury.
5. Escrowed ERC721 or ERC1155 is returned to the lender through the lender NFT-gated claim/default settlement path.
6. No borrower refund is expected on default unless the README later defines one.

## Borrower Preclose Paths

### Option 1: Standard Early Repayment

1. Borrower initiates early repayment on an active loan.
2. Borrower pays full principal plus full contractual interest for the original agreed term.
3. Treasury fee is deducted from lender earnings.
4. Lender receives a claimable amount.
5. Borrower receives claimable collateral or refund.
6. For NFT rentals, user rights are revoked and the escrowed NFT remains with or is returned to the lender through the rental settlement path.

### Option 2: Accept Existing Borrower Offer

1. Original borrower selects an existing compatible borrower offer.
2. Offer must preserve principal/lending asset type, payment/prepay asset type, and collateral asset type.
3. New borrower terms must favor the original lender or the original borrower must fully compensate any shortfall.
4. New borrower collateral or prepayment must already be escrowed through offer creation.
5. Original borrower pays accrued interest and any shortfall.
6. Original borrower collateral or refund becomes claimable.
7. Live loan borrower is updated to the new borrower.
8. For NFT rentals, original borrower user rights are revoked and equivalent user rights are assigned to the new borrower. The underlying NFT remains escrow-custodied.
9. Vaipakam borrower NFT is burned/replaced and lender NFT is updated.

### Option 3: Create New Lender Offer Offset

Phase 1 borrower preclose Option 3 is ERC20-only. NFT rentals and other non-ERC20 loan/rental positions are not eligible for this offset path and must use standard rental repayment/preclose, transfer, default, or maturity flows.

1. Original borrower has an active ERC20 loan.
2. Original borrower creates and funds a new lender offer.
3. New lender offer must preserve principal/lending asset type, payment/prepay asset type, and collateral asset type.
4. Duration and amounts must favor the original lender unless the original borrower compensates shortfall.
5. Original borrower pays accrued interest, principal owed, and any shortfall needed to keep the original lender whole.
6. When a new borrower accepts the offsetting lender offer, a new offsetting loan is created.
7. Original borrower position is closed only after the original lender's settlement value is preserved.
8. Original borrower becomes lender in the new offsetting loan.
9. Vaipakam NFTs are updated for the original loan and the new offsetting loan.

## Lender Early-Withdrawal Paths

Phase 1 lender early withdrawal is ERC20-only. NFT rentals and other non-ERC20 positions are not eligible.

### Option 1: Accept Existing Lender Offer

1. Original lender selects an existing compatible lender offer from the new lender.
2. Offer must preserve principal/lending asset type, payment/prepay asset type, and collateral asset type.
3. Offer terms must favor the original borrower.
4. New lender's principal funds are used to pay the original lender's exit proceeds.
5. Original lender forfeits accrued interest to treasury, with shortfall handling according to the README.
6. Live loan lender changes to the new lender.
7. Original lender NFT is burned/closed and a new lender NFT is minted for the new lender.
8. Borrower position remains unchanged.

### Option 2: Create Borrower-Style Offer

1. Original lender creates a borrower-style offer to initiate the early-withdrawal transition.
2. Offer must preserve principal/lending asset type, payment/prepay asset type, and collateral asset type.
3. Offer terms must favor the original borrower.
4. Incoming lender accepts the borrower-style offer.
5. Principal payment and shortfall handling are settled according to the README.
6. Any temporary offer-acceptance state is cleaned up.
7. Live loan lender changes to the incoming lender.
8. Original borrower remains borrower on the live loan.

### Option 3: Wait To Maturity

1. Lender takes no early-withdrawal action.
2. Loan continues under existing terms.
3. Borrower repays, precloses through a supported borrower path, or defaults/liquidates.
4. Lender claims through the normal Vaipakam NFT claim path.

## Refinance Path: ERC20 Loans Only

Phase 1 refinance is ERC20-only. NFT rentals and other non-ERC20 positions are not eligible.

1. Borrower has an active ERC20 loan.
2. Borrower creates or finds a borrower offer with better or desired terms.
3. New lender accepts the borrower offer, creating a new loan.
4. Refinance offer must preserve principal/lending asset type, payment/prepay asset type, and collateral asset type.
5. Borrower uses the new principal to repay the old lender, including principal, interest policy amount, and any shortfall.
6. Old lender receives a claimable settlement through the old lender NFT.
7. Borrower collateral from the old loan is released or replaced with same-type collateral for the new loan as required.
8. Old borrower NFT is closed/burned and new loan NFTs represent the new position.

## Collateral Management Paths

### Add Collateral

1. Borrower adds collateral to an active ERC20 loan.
2. Added collateral must match the collateral rules for the loan.
3. Health factor improves or remains safe.
4. Loan collateral amount is updated.

### Withdraw Excess Collateral

1. Borrower requests withdrawal of a specific collateral amount.
2. Protocol checks post-withdrawal health factor.
3. If safe, collateral is released.
4. If unsafe, withdrawal is rejected.

## Escrow Upgrade Path

1. Admin marks an escrow implementation version as mandatory when required.
2. Protocol blocks protected interactions for users on older mandatory escrow versions.
3. Frontend detects the user's outdated escrow.
4. User submits their own escrow-upgrade transaction.
5. After upgrade, protected interactions resume.
6. Non-critical upgrades may be shown as optional prompts instead of hard blocks.

## Phase 2 Paths

The following are retained as Phase 2 planning paths and are not Phase 1 implementation requirements:

- cross-chain loan origination, repayment, default, and settlement
- VNGK governance proposals and voting
- VNGK staking and revenue sharing
- governance-controlled upgrades
- governance-controlled treasury revenue distribution
