# Vaipakam All Workflow Test Sets

This document is the README-aligned test-set catalog for all Vaipakam workflow paths in `docs/VaipakamAllWorkflowPaths.md`.

## Test Scope Rules

- `/README.md` is the source of truth.
- Phase 1 tests run on single-network assumptions.
- Governance, staking, VNGK reward distribution, and cross-chain lending are Phase 2 test scopes unless explicitly stubbed as documentation-only tests.
- ERC721 and ERC1155 rental NFTs must remain escrow-custodied during active rentals.
- Borrowers must receive only temporary user rights for NFT rentals.
- Borrower preclose tests must enforce same principal/lending asset type, same payment/prepay asset type, and same collateral asset type.
- Borrower preclose Option 3, lender early-withdrawal, and refinance tests must reject NFT rentals and other non-ERC20 positions in Phase 1.

## Common Fixtures

- Deploy mock ERC20 principal asset, collateral asset, illiquid ERC20 asset, and prepay asset.
- Deploy mock ERC721 and ERC1155 rental assets that support temporary user rights.
- Deploy Vaipakam diamond/facets, Vaipakam NFT, escrow factory, escrow implementation, oracle/risk configuration, treasury, and admin controls.
- Create users for lender, borrower, new lender, new borrower, liquidator, treasury, admin, sanctioned user, and KYC-threshold user.
- Create user escrows through the protocol.
- Configure risk params for liquid ERC20 assets.
- Configure illiquid ERC20 or oracle-missing assets.
- Configure KYC/country profile data for compliant and blocked users.

## Offer Creation Tests

### ERC20 Lender Offer

Objective: verify a lender can create an ERC20 lender offer and escrow principal.

Steps:

1. Mint principal ERC20 to lender.
2. Approve the protocol.
3. Create lender offer with ERC20 principal, ERC20 collateral, amount, rate, and duration.
4. Verify offer fields.
5. Verify principal is escrowed.
6. Verify Vaipakam offer NFT is minted to lender with offer-created status.

Assertions:

- Offer type is lender.
- Offer is not accepted.
- Escrow balance increased by principal amount.
- Offer NFT owner is lender.

### ERC20 Borrower Offer

Objective: verify a borrower can create an ERC20 borrower offer and escrow collateral.

Steps:

1. Mint collateral ERC20 to borrower.
2. Approve the protocol.
3. Create borrower offer with ERC20 principal, ERC20 collateral, amount, rate, duration, and collateral amount.
4. Verify offer fields.
5. Verify collateral is escrowed.
6. Verify Vaipakam offer NFT is minted to borrower.

Assertions:

- Offer type is borrower.
- Collateral asset and amount match input.
- Escrow balance increased by collateral amount.
- Offer NFT owner is borrower.

### NFT Rental Lender Offer

Objective: verify an NFT owner can create an NFT rental lender offer with escrow custody.

Steps:

1. Mint ERC721 or ERC1155 to lender.
2. Approve transfer to the protocol.
3. Create lender offer with NFT asset, token ID, quantity if ERC1155, daily rental fee, duration, and prepay asset.
4. Verify the NFT is transferred into lender escrow.
5. Verify offer NFT is minted.

Assertions:

- Underlying NFT custodian is lender escrow.
- Borrower has no ownership or custody.
- Offer prepay asset is set.
- Offer NFT owner is lender.

### NFT Rental Borrower Offer

Objective: verify a renter can create a borrower offer by locking ERC20 prepayment.

Steps:

1. Mint ERC20 prepay asset to borrower.
2. Approve the protocol.
3. Create borrower offer for NFT rental terms.
4. Verify total prepay equals rental fee times duration plus 5 percent buffer.
5. Verify total prepay is escrowed.
6. Verify offer NFT is minted to borrower.

Assertions:

- Offer type is borrower.
- Escrowed prepay amount equals expected total.
- Borrower owns offer NFT.

## Offer Management Tests

### Offer Cancellation

Objective: verify an unaccepted offer can be cancelled and escrowed assets are returned.

Steps:

1. Create ERC20 lender offer, ERC20 borrower offer, NFT rental lender offer, and NFT rental borrower offer.
2. Cancel each offer as its creator before acceptance.
3. Verify escrowed ERC20 funds, collateral, rental NFT, or prepayment are returned to the creator.
4. Verify offer status and offer NFT status.
5. Attempt to cancel an already accepted offer.

Assertions:

- Only the offer creator can cancel.
- Unaccepted offer assets are returned correctly.
- Accepted offer cancellation reverts.
- Cancelled offers cannot be accepted.

## Loan Initiation Tests

### ERC20 Lender Offer Acceptance

Objective: verify borrower accepts a lender offer.

Steps:

1. Create ERC20 lender offer.
2. Borrower approves collateral.
3. Borrower accepts offer.
4. Verify loan is active.
5. Verify principal transferred to borrower.
6. Verify borrower collateral escrowed.
7. Verify lender and borrower Vaipakam NFTs.

Assertions:

- Loan lender is offer creator.
- Loan borrower is acceptor.
- Loan principal and collateral fields match offer.
- Offer is accepted.

### ERC20 Borrower Offer Acceptance

Objective: verify lender accepts a borrower offer.

Steps:

1. Create ERC20 borrower offer.
2. Lender approves principal.
3. Lender accepts offer.
4. Verify loan is active.
5. Verify principal transferred to borrower.
6. Verify existing borrower collateral remains escrowed.

Assertions:

- Loan lender is acceptor.
- Loan borrower is offer creator.
- Offer is accepted.
- Position NFTs are minted/updated correctly.

### Partial Lending And Borrowing

Objective: verify one offer can support partial acceptance when allowed.

Steps:

1. Create an eligible ERC20 lender or borrower offer with an amount larger than the requested partial amount.
2. Accept a valid partial amount.
3. Verify loan principal and collateral are calculated from the partial amount.
4. Verify remaining offer availability.
5. Accept a second valid partial amount if remaining availability allows it.
6. Attempt to accept more than the remaining amount.

Assertions:

- Each partial acceptance creates an independent loan record.
- Escrow accounting prevents over-acceptance.
- Claims, collateral, lender NFTs, and borrower NFTs remain isolated per loan.
- Over-acceptance reverts.

### NFT Rental Lender Offer Acceptance

Objective: verify borrower accepts an NFT rental lender offer.

Steps:

1. Create NFT rental lender offer with escrowed ERC721 or ERC1155.
2. Borrower approves prepay asset.
3. Borrower accepts offer.
4. Verify prepay and buffer are locked.
5. Verify borrower temporary user rights are assigned.

Assertions:

- Underlying NFT remains in lender escrow.
- Borrower is temporary user until expected expiry.
- Borrower has no ownership/custody.
- Loan prepay and buffer fields are set.

### NFT Rental Borrower Offer Acceptance

Objective: verify lender accepts a borrower-created NFT rental offer.

Steps:

1. Borrower creates NFT rental borrower offer with ERC20 prepayment locked.
2. Lender approves matching ERC721 or ERC1155.
3. Lender accepts offer.
4. Verify lender NFT is transferred to lender escrow.
5. Verify borrower temporary user rights are assigned.

Assertions:

- Underlying NFT custodian is lender escrow.
- Borrower is temporary user.
- Loan is active.
- Prepay and buffer accounting match offer.

## Repayment And Closure Tests

### ERC20 Full Repayment

Objective: verify ERC20 loan repayment and claim lifecycle.

Steps:

1. Create and accept an ERC20 loan.
2. Advance time within due period.
3. Borrower repays principal plus interest.
4. Verify `Yield Fee`.
5. Verify lender claim exists.
6. Verify borrower collateral claim exists.
7. Lender claims using lender NFT.
8. Borrower claims using borrower NFT.

Assertions:

- Loan status becomes repaid, then settled after claims.
- Lender receives principal plus lender share.
- Borrower receives collateral.
- Position NFTs are burned after claim.

### NFT Rental Close

Objective: verify NFT rental close revokes user rights and creates claims.

Steps:

1. Create and accept NFT rental loan.
2. Borrower closes rental before or within grace.
3. Verify user rights are revoked.
4. Verify lender rental fee claim exists.
5. Verify borrower refund/buffer claim exists.
6. Lender claims rental fee and escrowed NFT.
7. Borrower claims refund.

Assertions:

- Underlying NFT returns to lender only through the lender NFT-gated claim/default path.
- Borrower user rights are cleared.
- Loan settles after both claims where applicable.

### NFT Daily Deduction

Objective: verify daily rental deduction and final close behavior.

Steps:

1. Create and accept NFT rental loan.
2. Advance one day.
3. Call daily deduction.
4. Verify lender and treasury allocations.
5. Repeat until duration reaches zero.
6. Verify claimable/closed state is created.
7. Verify lender can reclaim escrowed NFT through lender claim path.

Assertions:

- Deduction cannot occur before the daily interval.
- Prepay decreases by daily fee.
- Duration decreases by one per deduction.
- Final state creates lender NFT-return path and borrower buffer refund path.

## Default And Liquidation Tests

### Liquid ERC20 Collateral Liquidation

Objective: verify liquidation distributes proceeds according to README.

Steps:

1. Create ERC20 loan with liquid collateral.
2. Manipulate price or time to make loan liquidatable/defaulted.
3. Trigger liquidation.
4. Verify lender proceeds.
5. Verify liquidator bonus if applicable.
6. Verify borrower surplus claim if proceeds exceed debt.

Assertions:

- Lender claim is capped at debt/proceeds rules.
- Borrower surplus is claimable.
- Loan status moves to liquidated or defaulted as expected.

### Illiquid ERC20 Collateral Default

Objective: verify whole illiquid collateral transfers or becomes claimable to lender.

Steps:

1. Create loan with illiquid ERC20 collateral and required consents.
2. Advance beyond due date and grace period.
3. Trigger default.
4. Verify whole illiquid collateral is allocated to lender.
5. Verify any payment-asset top-up remains claimable through the lender NFT model.

Assertions:

- No DEX liquidation path is used.
- Borrower has no collateral surplus claim unless README later defines one.
- Lender claim uses correct asset accounting.

### NFT Rental Default

Objective: verify NFT rental default behavior.

Steps:

1. Create and accept NFT rental loan.
2. Advance beyond duration and grace period.
3. Trigger default.
4. Verify user rights are revoked.
5. Verify rental fees/prepayment allocated to lender.
6. Verify buffer routed to treasury.
7. Verify escrowed NFT is claimable/returnable to lender.

Assertions:

- Borrower user rights are cleared.
- Lender can recover rental fee and NFT via lender NFT-gated claim path.
- Borrower receives no default refund unless README changes.

## Borrower Preclose Tests

### Option 1: Standard Early Repayment

Objective: verify direct preclose charges full contractual interest and closes the loan.

Steps:

1. Create active loan.
2. Borrower calls direct preclose.
3. Verify full-term interest calculation.
4. Verify `Yield Fee`.
5. Verify lender claim.
6. Verify borrower collateral/refund claim.
7. Verify NFT rental user rights are revoked when applicable.

Assertions:

- Loan becomes repaid/claimable.
- Lender and borrower can claim with Vaipakam NFTs.
- NFT rentals keep the underlying NFT escrow-custodied until lender claim.

### Option 2: Accept Existing Borrower Offer

Objective: verify borrower transfers obligation by accepting an existing compatible borrower offer.

Steps:

1. Create active loan.
2. New borrower creates compatible borrower offer.
3. Original borrower accepts that borrower offer.
4. Verify same principal/lending asset type, payment/prepay asset type, and collateral asset type are enforced.
5. Verify new terms favor original lender or original borrower pays shortfall.
6. Verify original borrower collateral/refund is released or claimable.
7. Verify live loan borrower changes to new borrower.
8. For NFT rental, verify old user rights are revoked and new user rights are assigned.

Assertions:

- Direct parameter transfer path is not used.
- New borrower owns borrower NFT for live loan.
- Original borrower NFT is burned/closed.
- Lender NFT remains tied to the live loan.

### Option 3: Create New Lender Offer Offset

Objective: verify borrower offsets an old active ERC20 obligation by creating a new lender offer.

Steps:

1. Create active ERC20 loan.
2. Original borrower creates compatible lender offer.
3. Verify same principal/lending asset type, payment/prepay asset type, and collateral asset type.
4. Verify duration and amounts favor original lender or require shortfall compensation.
5. New borrower accepts the offsetting lender offer.
6. Verify original lender settlement value is preserved.
7. Verify original borrower collateral release and old loan closure.
8. Verify original borrower becomes lender in the new offsetting loan.

Assertions:

- Old loan is not closed before original lender settlement is preserved.
- Original lender has a valid claim path for principal, accrued interest, and any shortfall.
- New offsetting loan has correct lender and borrower NFTs.

### Option 3 Non-ERC20 Rejection

Objective: verify borrower preclose Option 3 rejects NFT rentals and other non-ERC20 positions.

Steps:

1. Create NFT rental loan.
2. Attempt borrower preclose Option 3 by creating a new lender-offer offset.

Assertions:

- Option 3 offset reverts.
- NFT rental state remains unchanged.
- NFT rental can still use standard rental repayment/preclose, transfer, default, or maturity flows.

## Lender Early-Withdrawal Tests

### ERC20-Only Rejection

Objective: verify lender early withdrawal rejects non-ERC20 loans.

Steps:

1. Create NFT rental loan.
2. Attempt early-withdrawal Option 1.
3. Attempt early-withdrawal Option 2.

Assertions:

- Both attempts revert.
- NFT rental state remains unchanged.
- Rental can still use normal repayment, borrower preclose, default, or maturity flows.

### Option 1: Accept Existing Lender Offer

Objective: verify original lender exits by accepting an existing compatible lender offer.

Steps:

1. Create active ERC20 loan.
2. New lender creates compatible lender offer.
3. Original lender accepts the new lender offer.
4. Verify same asset types.
5. Verify borrower-favorability checks.
6. Verify principal recovery to original lender.
7. Verify accrued interest forfeiture and shortfall handling.
8. Verify live loan lender changes to new lender.

Assertions:

- Borrower position remains unchanged.
- New lender owns live loan lender NFT.
- Original lender offer/NFT artifacts are closed or burned as expected.
- Excess offer funds are refunded or not stranded.

### Option 2: Create Borrower-Style Offer

Objective: verify original lender exits by creating a borrower-style offer.

Steps:

1. Create active ERC20 loan.
2. Original lender creates borrower-style offer.
3. Incoming lender accepts the offer.
4. Verify sale completion is atomic with offer acceptance where required.
5. Verify same asset types and borrower-favorability checks.
6. Verify original lender receives agreed proceeds.
7. Verify live loan lender changes to incoming lender.
8. Verify temporary offer-acceptance loan state is cleaned up.

Assertions:

- Live borrower remains unchanged.
- New lender owns lender NFT for live loan.
- Temporary NFTs are burned/cleaned.
- Temporary claims cannot become stuck artifacts.

### Option 3: Wait To Maturity

Objective: verify no early-withdrawal action keeps the original loan behavior.

Steps:

1. Create active ERC20 loan.
2. Take no early-withdrawal action.
3. Borrower repays or defaults.
4. Lender claims normally.

Assertions:

- Original lender remains lender.
- No sale discount or early-withdrawal forfeiture applies.

## Refinance Tests: ERC20 Loans Only

### ERC20 Refinance

Objective: verify borrower-offer-led refinance for active ERC20 loans.

Steps:

1. Create active ERC20 loan with old lender.
2. Borrower creates borrower offer with refinance terms.
3. New lender accepts borrower offer, creating a new ERC20 loan.
4. Borrower calls refinance on old loan using the accepted borrower offer.
5. Verify same principal/lending asset type, payment/prepay asset type, and collateral asset type.
6. Verify old lender receives principal, interest-policy amount, and any shortfall.
7. Verify old collateral release or replacement behavior.
8. Verify new loan health factor and LTV checks.
9. Verify old borrower NFT closes and old lender NFT becomes claimable.

Assertions:

- Old loan status becomes repaid/claimable.
- New loan remains active.
- Old lender has claimable settlement.
- Borrower has the new borrower position.

### Refinance Non-ERC20 Rejection

Objective: verify refinance rejects NFT rentals and other non-ERC20 positions.

Steps:

1. Create NFT rental loan.
2. Attempt refinance.

Assertions:

- Refinance reverts.
- NFT rental remains active and usable through normal rental paths.

## Collateral Management Tests

### Add Collateral

Objective: verify borrower can add collateral to an active ERC20 loan.

Steps:

1. Create active ERC20 loan.
2. Borrower approves additional collateral.
3. Borrower adds collateral.
4. Verify collateral amount increases.
5. Verify health factor improves or remains safe.

Assertions:

- Loan remains active.
- Escrow receives added collateral.

### Withdraw Excess Collateral

Objective: verify borrower can withdraw only safe excess collateral.

Steps:

1. Create active ERC20 loan.
2. Add enough collateral to create excess.
3. Request safe withdrawal.
4. Verify withdrawal succeeds.
5. Request unsafe withdrawal.

Assertions:

- Safe withdrawal transfers collateral to borrower.
- Unsafe withdrawal reverts.
- Health factor never falls below required threshold.

## Escrow Upgrade Tests

### Mandatory Upgrade Gate

Objective: verify old mandatory escrow versions are blocked until user upgrade.

Steps:

1. Create user escrow on old implementation version.
2. Admin marks a newer implementation version as mandatory.
3. User attempts protected interaction.
4. Verify interaction is blocked.
5. User upgrades their escrow through the user-triggered path.
6. Retry protected interaction.

Assertions:

- Old mandatory version is blocked.
- User-triggered upgrade succeeds.
- Interaction resumes after upgrade.
- Non-critical upgrades can be represented as frontend prompts rather than hard protocol blocks.

## Compliance Tests

### Sanctions And Country Compatibility

Objective: verify blocked counterparties cannot enter new positions.

Steps:

1. Configure incompatible or sanctioned profile data.
2. Attempt normal offer acceptance.
3. Attempt borrower preclose Option 2 with a new borrower.
4. Attempt lender early-withdrawal with a new lender.

Assertions:

- Blocked normal acceptance reverts.
- Blocked counterparty-change flows revert.

### KYC Thresholds

Objective: verify KYC requirements are based on README transaction-value rules.

Steps:

1. Configure a below-threshold transaction.
2. Configure transactions between Tier 1 and Tier 2 thresholds.
3. Configure transaction above full KYC threshold.
4. Include NFT rental transaction-value tests based on total rental value.

Assertions:

- Below-threshold path does not require extra KYC.
- Tiered threshold checks are enforced.
- NFT rental KYC value is based on rental value, not NFT collateral valuation.

## Phase 2 Test Placeholders

These are documentation placeholders only until Phase 2 is implemented:

- cross-chain loan origination and bridge settlement
- cross-chain repayment
- cross-chain liquidation/default
- VNGK governance proposal creation
- VNGK voting and execution
- VNGK staking and reward distribution
- governance-controlled treasury distribution
- governance-controlled upgrades
