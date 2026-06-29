# Basic User UX Simplification Plan

## Purpose

Vaipakam has powerful protocol features, but a first-time user should not have
to understand the protocol before they can use the product. This plan describes
a Basic-mode product direction for a non-expert user who arrives with one simple
intent: borrow, lend, rent an NFT, or manage an existing position.

The goal is not to remove advanced functionality. The goal is to route new users
through plain-language, intent-first workflows while preserving the same
underlying protocol safety rules.

## Product Principle

Basic mode should be intent-first and progressively disclosed:

1. Ask what the user wants to do.
2. Show only the inputs needed for that job.
3. Explain obligations before signing.
4. Keep advanced protocol controls available, but folded away.
5. After the transaction, tell the user what happened and what to watch next.

A user should be able to complete a basic borrow/lend/rental lifecycle without
learning terms such as matcher share, canonical tier cache, standing intent,
keeper bitmask, fallback snapshot, or protocol-tracked balance. Those concepts
can appear in Advanced mode, details panels, support views, and audit-facing
screens.

## First-Run App Shape

After wallet connect, the primary app screen should emphasize four jobs:

| Job | Primary wording | Destination |
| --- | --- | --- |
| Borrow | `Borrow assets` | Guided borrow path |
| Lend | `Earn by lending` | Guided lend path |
| NFT rental | `Rent or lend an NFT` | Guided NFT rental path |
| Manage | `Manage my positions` | Dashboard / Loan Details |

Secondary destinations such as VPFI Vault, Keepers, Recovery, NFT Verifier,
Analytics, and Protocol Console should remain reachable, but should not compete
with the first-run choices.

## Navigation Model

Basic mode navigation should be short and task-oriented:

- Dashboard
- Borrow
- Lend
- NFT Rental
- Offer Book
- Claim Center
- VPFI Vault
- Settings / Help

Advanced-only or advanced-disclosure navigation:

- Keepers
- Recovery
- NFT Verifier
- Protocol Console
- Diagnostics
- Standing intents / Auto-lend controls
- Advanced liquidation / swap-to-repay controls

The navigation should not imply that hidden advanced routes are disabled. They
are simply deeper tools, available when the user switches to Advanced mode or
opens an explicit advanced disclosure.

## Guided Flow Pattern

Every Basic-mode write flow should follow the same shape.

### Step 1: Intent

Ask the user what they are trying to do in plain words.

Examples:

- `I want to borrow`
- `I want to lend`
- `I want to rent out my NFT`
- `I want to repay or claim`

### Step 2: Inputs

Collect only the necessary inputs for the selected job. Basic mode should prefer
recommended defaults and hide protocol-native lower/upper bound fields unless an
advanced panel is opened.

Examples:

- Borrow: desired asset, amount, collateral asset, duration.
- Lend: asset to lend, amount, minimum return, accepted collateral.
- NFT rental: NFT, rental price, duration, prepay asset.
- Manage: select loan, then show the one or two actions available now.

### Step 3: Eligibility And Safety

Before signing, show whether the flow is currently possible:

- wallet connected
- active chain supported
- wallet has enough token balance
- allowance/Permit2 readiness
- collateral is enough for required safety
- sanctions/Terms gate status
- asset liquidity class and default consequence
- protocol pause or asset pause status

The user should see problems as fixable checklist items rather than opaque
transaction failures.

### Step 4: Review Receipt

Every transaction review should show a receipt with the same structure:

| Receipt field | Meaning |
| --- | --- |
| `You receive` | Asset or right the user gets immediately or after completion. |
| `You lock` | Asset, collateral, prepay, NFT, or VPFI that enters protocol custody. |
| `You may owe` | Repayment, interest, rental fees, late fees, or future obligations. |
| `You can lose` | Collateral, NFT rights, VPFI rebate, or prepay buffer in adverse cases. |
| `Fees` | Protocol fees and estimated network gas as separate concepts. |
| `When this ends` | Claim, repayment, default, expiry, or next action. |

The receipt is the main trust surface. It should be short, stable, and repeated
across create, accept, repay, claim, preclose, refinance, VPFI deposit/withdraw,
and rental flows.

### Step 5: Confirmation And Next Step

After a confirmed transaction, show:

- what changed
- where the user can see the position
- what action may be needed next
- whether the indexer is still catching up
- a single primary next action

Examples:

- `Loan opened. View loan details.`
- `Offer posted. View active offers.`
- `Repayment confirmed. Claim collateral.`
- `Claim complete. Back to Dashboard.`

## Basic Borrow Flow

Basic borrow should hide raw offer-construction complexity.

Recommended shape:

1. User selects `Borrow assets`.
2. User enters desired asset, amount, duration, and collateral.
3. App explains whether they are matching an existing lender offer or posting a
   borrower request.
4. App shows a plain-language collateral safety indicator:
   - `Healthy`
   - `Close to limit`
   - `Not enough collateral`
5. App shows the review receipt.
6. User signs.
7. App routes to Loan Details or active offer status.

Basic copy should say:

- `You are locking collateral.`
- `If you do not repay, the lender can receive this collateral.`
- `If the collateral is liquid, price drops can trigger liquidation.`
- `If the collateral is illiquid, default can transfer the whole collateral.`

## Basic Lend Flow

Basic lend should explain that the lender is choosing risk, not just yield.

Recommended shape:

1. User selects `Earn by lending`.
2. User chooses asset, amount, desired return, duration, and accepted collateral.
3. App shows borrower-side collateral requirement in plain words.
4. App warns when collateral is illiquid or cannot be liquidated by price.
5. App shows expected earning and protocol fee separately.
6. User posts offer or funds a borrower offer.
7. App routes to active offer or Loan Details.

Basic copy should avoid making yield look guaranteed. Use wording such as:

- `Expected interest if the borrower repays on time.`
- `If the borrower defaults, your recovery depends on the collateral type.`

## Basic NFT Rental Flow

NFT rental should be separated from debt lending in Basic mode.

Recommended shape:

1. User chooses `Rent or lend an NFT`.
2. App asks whether they own an NFT to lend or want to rent one.
3. App explains that rental NFTs stay in vault custody and the renter receives
   temporary use rights, not ownership.
4. App shows daily fee, duration, prepay, buffer, and what happens at expiry.
5. App shows the review receipt.
6. User signs.
7. App routes to rental Loan Details.

## Manage Position Flow

Loan Details should be the command center for users who already have positions.

Basic mode should answer five questions at the top of the page:

1. What is my role?
2. Is the position healthy?
3. What is locked?
4. What can I do now?
5. What happens if I do nothing?

Only the most relevant current action should be primary. Other available actions
can be secondary or advanced.

Examples:

| State | Primary action | Secondary actions |
| --- | --- | --- |
| Borrower, active healthy loan | `Repay` | Add collateral, view risk |
| Borrower, risk rising | `Add collateral` | Repay, view liquidation details |
| Lender, active loan | `View status` | Sell position, keeper settings |
| Repaid loan with claim | `Claim` | View details |
| Claim complete | `Back to Dashboard` | View activity |

## VPFI In Basic Mode

VPFI should be presented as optional fee utility, not as a prerequisite for using
Vaipakam.

Basic wording:

- `Optional: hold VPFI in your vault to reduce protocol fees.`
- `Your VPFI discount does not reduce network gas.`
- `Withdrawing VPFI can lower future fee discounts.`

Basic mode should not surface canonical tier cache, mirror expiry, tier-poke, or
cross-chain supply mechanics unless the user opens details.

## Error And Empty-State Principles

Errors should be written as next steps:

| Technical state | Basic-mode wording |
| --- | --- |
| Wallet not connected | `Connect a wallet to continue.` |
| Unsupported chain | `Switch to a supported Vaipakam network.` |
| Insufficient balance | `You need more {asset} to continue.` |
| Allowance missing | `Approve {asset} so Vaipakam can use it for this action.` |
| HF too low | `This collateral is not enough for a safe loan.` |
| Oracle unavailable | `Vaipakam cannot price this asset right now.` |
| Illiquid collateral | `This collateral cannot be automatically sold if you default.` |
| Indexer lag | `Transaction confirmed. Updating the app view now.` |

Empty states should show a single action, not a lecture.

Examples:

- No loans: `No active loans yet. Borrow or lend to get started.`
- No offers: `No matching offers right now. Create your own request.`
- No claimables: `Nothing to claim right now.`
- No rewards: `No rewards yet. Rewards appear after lending or borrowing activity.`

## Advanced Mode Boundary

Advanced mode should expose power tools without changing the protocol rules:

- range orders
- partial repay controls
- add/withdraw collateral details
- keeper configuration
- auto-lend and standing intents
- refinance caps and auto-lifecycle controls
- swap-to-repay
- recovery and diagnostics
- raw HF/LTV/oracle/liquidity details
- cross-chain VPFI tier status

Basic mode may show compact summaries of these when they affect safety, but the
controls themselves should live behind Advanced mode or explicit disclosures.

## Implementation Notes

- Prefer one shared `mode` value in app context; the concrete storage choice (React context, store, URL, and persistence) belongs to the frontend architecture implementation, but the product requirement is one source of truth that every page reads consistently.
- Avoid duplicate Basic and Advanced page trees.
- Use shared review-receipt components across write flows.
- Use shared eligibility/checklist components before transaction submission.
- Use live protocol config for fee, duration, tier, and threshold copy.
- Preserve deep links and anchors when switching modes.
- Keep Basic-mode copy localized through the existing user-guide/content system.

## Acceptance Criteria

These criteria are product outcomes. `docs/TestScopes/BasicUserJourneyMap.md` defines the corresponding testable screen-level checks.

A Basic-mode implementation should be considered successful when:

- a first-time borrower can open or request a loan without understanding offer
  internals
- a first-time lender can post or fund a loan while seeing collateral/default
  risk plainly
- an NFT owner can understand the difference between lending money and renting
  an NFT
- every write transaction has a consistent review receipt
- Loan Details always shows the user’s current role, state, primary action, and
  consequence of inaction
- VPFI is optional and never blocks the main borrow/lend/rental journey
- advanced controls do not distract from first-run tasks, but remain available
  when intentionally requested
