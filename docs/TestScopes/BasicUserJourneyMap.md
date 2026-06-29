# Basic User Journey Map

This document converts the Basic User UX Simplification Plan into testable
screen-by-screen journeys. It is intended to feed frontend tasks, Playwright
coverage, seeded-state fixtures, and contract-positive tests where a journey
also changes on-chain state.

Related docs:

- `docs/DesignsAndPlans/BasicUserUXSimplification.md`
- `docs/TestScopes/PositiveFlowCoverage.md`
- `docs/FunctionalSpecs/WebsiteReadme.md`
- `apps/www/src/content/userguide/Basic.en.md`

## Test Shape

Every Basic journey should be testable in three layers:

| Layer | Purpose |
| --- | --- |
| Product walkthrough | Human-readable screen sequence for design/product review. |
| App E2E | Browser-level test for copy, navigation, state, and review receipts. |
| Protocol positive | Foundry test or script for on-chain state change when the journey writes. |

The same journey may use several `PF-###` IDs from
`docs/TestScopes/PositiveFlowCoverage.md`.

## Shared Acceptance Rules

All Basic journeys should satisfy these rules:

1. The first visible choice is the user intent, not protocol jargon.
2. The user can proceed with recommended defaults where safe.
3. Advanced-only inputs are hidden by default.
4. Before signing, the review receipt shows `You receive`, `You lock`,
   `You may owe`, `You can lose`, `Fees`, and `When this ends`.
5. Protocol fees and network gas are shown separately.
6. If the action cannot proceed, the UI shows a fixable checklist item.
7. After confirmation, the UI shows one primary next action.
8. The matching help link opens the Basic guide anchor for that card or flow.

## Journey B1: First-Time Borrower Uses Existing Lender Offer

Flow IDs: PF-001, PF-002, PF-003, PF-004, PF-023, PF-090, PF-024, PF-110,
PF-113.

### User goal

The user wants to borrow an asset and is willing to lock collateral.

### Screen sequence

1. User connects wallet.
2. App shows first-run actions: `Borrow assets`, `Earn by lending`,
   `Rent or lend an NFT`, `Manage my positions`.
3. User selects `Borrow assets`.
4. App asks for desired asset, amount, duration, and collateral asset.
5. App shows matching lender offers in plain language.
6. User chooses an offer.
7. Eligibility checklist passes:
   - supported chain
   - wallet balance sufficient for collateral
   - Terms accepted
   - clean sanctions status where oracle is configured
   - collateral meets safety requirement
8. Review receipt appears.
9. User approves/signs.
10. App shows `Loan opened` and routes to Loan Details.
11. Loan Details shows role `Borrower`, locked collateral, owed amount, health
    state, and primary action `Repay`.
12. User repays.
13. App shows `Claim collateral` as next action.
14. User claims collateral.
15. Dashboard shows no active borrower obligation for that loan.

### Required Basic copy

- `You are borrowing {amount} {asset}.`
- `You are locking {amount} {collateral}.`
- `If you do not repay, the lender can receive your collateral.`
- `Network gas is separate from Vaipakam protocol fees.`

### Acceptance checks

- No raw range-order or matcher terminology appears in Basic mode.
- The user sees the collateral consequence before signing.
- Loan Details primary action changes from `Repay` to `Claim collateral` after
  repayment.
- Help links target Basic guide anchors.

Lender-side claim PF-112 is intentionally not part of this borrower-centric journey; it is the symmetric claim step in Journey L1.

## Journey B2: First-Time Borrower Posts A Request

Flow IDs: PF-001, PF-002, PF-003, PF-004, PF-041, PF-046, PF-023, PF-091, PF-024.

### User goal

The user wants to borrow, but no existing lender offer fits.

### Screen sequence

1. User selects `Borrow assets`.
2. App shows no suitable lender offers and offers `Create a borrow request`.
3. User enters desired asset, amount, duration, maximum rate, and collateral.
4. App explains that collateral is locked now and funds arrive only when a lender
   accepts.
5. Review receipt appears.
6. User signs.
7. App shows `Borrow request posted` and a link to `Your active offers`.
8. When a lender accepts, Dashboard shows an active loan.

Cancellation branch: PF-046 covers cancelling the posted borrow request before acceptance, releasing locked collateral and updating the offer row.

### Acceptance checks

- Empty offer state leads to one clear action.
- The user is not told funds are received until acceptance happens.
- The active offer is cancellable before acceptance, subject to protocol rules.

## Journey L1: First-Time Lender Funds Existing Borrower Offer

Flow IDs: PF-001, PF-002, PF-003, PF-004, PF-023, PF-091, PF-024, PF-112.

### User goal

The user wants to lend and earn interest without building an offer from scratch.

### Screen sequence

1. User selects `Earn by lending`.
2. App shows borrower requests with plain-language summaries.
3. User selects a borrower offer.
4. App explains expected interest, protocol yield fee, collateral type, and
   default outcome.
5. Eligibility checklist passes.
6. Review receipt appears.
7. User signs.
8. Loan Details opens with role `Lender` and status `Active`.
9. After borrower repayment/default, Claim Center shows claimable funds.
10. User claims.

### Required Basic copy

- `Expected interest if the borrower repays on time.`
- `If the borrower defaults, recovery depends on the collateral type.`

### Acceptance checks

- Expected interest is not presented as guaranteed.
- Illiquid collateral has a plain default warning.
- Claim Center deep-links back to Loan Details.

## Journey L2: First-Time Lender Posts A Lending Offer

Flow IDs: PF-001, PF-002, PF-003, PF-004, PF-040, PF-045, PF-090.

### User goal

The user wants to make funds available for borrowers.

### Screen sequence

1. User selects `Earn by lending`.
2. App offers `Fund a borrower request` and `Create a lending offer`.
3. User chooses `Create a lending offer`.
4. App collects asset, amount, desired return, duration, and accepted collateral.
5. App explains that the lent asset is locked until the offer is accepted or
   cancelled.
6. Review receipt appears.
7. User signs.
8. App shows `Lending offer posted`.
9. User can cancel before acceptance or wait for borrower acceptance (PF-045 covers the cancellation branch).

### Acceptance checks

- Basic mode does not expose raw lower/upper amount/rate range fields by
  default.
- Cancellation state returns the locked principal and updates the offer row.

## Journey N1: NFT Owner Rents Out An NFT

Flow IDs: PF-001, PF-002, PF-003, PF-004, PF-042, PF-043, PF-140, PF-141, PF-142, PF-143.

### User goal

The user owns a rentable NFT and wants to earn rental fees.

### Screen sequence

1. User selects `Rent or lend an NFT`.
2. App asks `I own an NFT` or `I want to rent one`.
3. User chooses `I own an NFT`.
4. App collects NFT, token id / quantity, daily fee, duration, and prepay asset.
5. App explains that the NFT stays in vault custody and the renter gets
   temporary rights only.
6. Review receipt appears.
7. User signs.
8. App shows active rental offer.
9. When renter accepts, Loan Details shows rental state and daily fee status.
10. On normal close, lender reclaims NFT and earned fees.

### Acceptance checks

- The app does not describe NFT rental as a debt loan.
- Ownership vs temporary user rights is clear before signing.
- The configured rental buffer is shown as prepay protection, not hidden in fees.

## Journey N2: User Rents An NFT

Flow IDs: PF-001, PF-002, PF-003, PF-004, PF-023, PF-140, PF-143, PF-144.

### User goal

The user wants temporary use of an NFT.

### Screen sequence

1. User selects `Rent or lend an NFT`.
2. User chooses `I want to rent one`.
3. App shows available rental offers.
4. User selects a rental.
5. App shows daily fee, total prepay, configured buffer, duration, and end behavior.
6. Review receipt appears.
7. User signs.
8. Loan Details shows active rental, remaining time, and close action.
9. User closes rental normally (PF-143) or waits for expiry/default behavior (PF-144).

Expiry/default branch: PF-144 covers the case where the renter does nothing and rights must reset through the rental expiry/default path.

### Acceptance checks

- The user sees total prepay before signing.
- The app says the user receives temporary use rights, not ownership.
- Close/expiry state resets rights and shows any claimable amount.

## Journey M1: Borrower Manages A Healthy Loan

Flow IDs: PF-024, PF-110, PF-113, PF-160.

### User goal

The user already has a loan and wants to know what to do.

### Screen sequence

1. Dashboard shows active loan row.
2. User opens Loan Details.
3. Top summary answers:
   - role: borrower
   - state: healthy
   - locked collateral
   - current owed amount
   - primary action: repay
4. User may repay or add collateral.
5. After repayment, primary action changes to claim collateral.

### Acceptance checks

- Loan Details does not require interpreting raw enum/status codes.
- `What happens if I do nothing?` is visible or one click away.
- Repay and claim are visually distinct steps.

## Journey M2: Borrower Handles A Risky Loan

Flow IDs: PF-024, PF-160, PF-180, PF-182.

### User goal

The user sees their loan becoming risky and wants to avoid liquidation/default.

### Screen sequence

1. Dashboard marks the loan as `Needs attention` or `At risk`.
2. Loan Details shows why: collateral value, health state, and how much time is left to act.
3. Primary action is `Add collateral` or `Repay`, depending on state.
4. App explains liquidation/default consequence in plain language.
5. User adds collateral or repays.
6. App confirms the loan is healthier or closed.

### Acceptance checks

- Health state uses human labels plus optional numbers.
- Liquid vs illiquid collateral consequence is explicit.
- The user is not encouraged to take an action that is unavailable in the
  current state.

## Journey C1: User Claims Funds Or Assets

Flow IDs: PF-025, PF-112, PF-113, PF-120, PF-121, PF-259.

### User goal

The user wants to collect money, collateral, NFT, surplus, or rewards.

### Screen sequence

1. User opens Claim Center.
2. Claim Center groups loan claims and interaction rewards.
3. Each claim row says what will be received and why it is claimable.
4. User opens details or claims directly where safe.
5. After claim, row clears or moves to completed state.

### Acceptance checks

- Empty state says `Nothing to claim right now`.
- Rewards and loan claims are separate enough not to confuse source of funds.
- Claim rows link to Loan Details for context.

## Journey V1: Optional VPFI Fee Discount

Flow IDs: PF-250, PF-251, PF-252, PF-253, PF-254, PF-259.

### User goal

The user wants to reduce Vaipakam protocol fees, not learn token mechanics.

### Screen sequence

1. User opens the Dashboard fee-discount card and sees that VPFI fee discounts are optional.
2. User follows the `Deposit VPFI` path to the VPFI Vault.
3. App explains `Optional: hold VPFI in your vault to reduce protocol fees`.
4. User deposits externally acquired VPFI.
5. User returns to the Dashboard-owned fee-discount control and enables consent.
6. App shows current tier and whether it is active or pending.
7. User can withdraw free VPFI later from the VPFI Vault, with a warning about fee impact.
8. Claim Center shows interaction rewards separately.

### Acceptance checks

- Basic mode does not imply Vaipakam sells VPFI or pays staking yield.
- Network gas is not described as discountable.
- Withdraw confirmation warns about future fee-discount impact.

## Journey H1: Help And Mode Switching

Flow IDs: PF-022.

### User goal

The user needs an explanation without losing place.

### Screen sequence

1. User clicks an info icon on a card.
2. App opens the Basic guide anchor for the current card.
3. User switches to Advanced mode from settings.
4. The same page remains open and reveals advanced controls/details.
5. Info links now point to Advanced guide anchors.
6. User switches back to Basic mode and returns to the simpler view.

### Acceptance checks

- Mode switch preserves in-progress form field values.
- Deep links preserve the relevant guide anchor.
- Advanced-only controls hide again when Basic mode resumes.

## Playwright Fixture Suggestions

Create reusable seeded states for app E2E tests:

| Fixture | Journeys supported |
| --- | --- |
| Fresh wallet with no vault | B1, L1, N1 first-run states |
| Wallet with posted offer | B2, L2 |
| Wallet with active healthy borrower loan | M1 |
| Wallet with risky borrower loan | M2 |
| Wallet with repaid claimable loan | C1 |
| Wallet with active NFT rental | N1, N2 |
| Wallet with VPFI wallet/vault balance | V1 |
| Wallet with zero rewards and claimables | C1 empty states |

## Implementation Backlog Seeds

These can become frontend cards:

1. Build shared first-run intent panel.
2. Build shared transaction review receipt component.
3. Build shared eligibility checklist component.
4. Convert Borrow and Lend entry points into guided Basic flows.
5. Separate NFT Rental from debt-loan flows in Basic mode.
6. Rework Loan Details Basic header around role, health, locked asset, primary
   action, and consequence of inaction.
7. Add Basic-mode copy tests for VPFI optionality and no staking/sale language.
8. Add Playwright journeys B1, L1, N1, M1, C1, and V1 as the first regression
   pack.
