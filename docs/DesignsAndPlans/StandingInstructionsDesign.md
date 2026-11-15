# Standing instructions from your own vault — design

**Status:** owner approved the feature on 2026-11-15, before the feature freeze. Card #3681. Design for review before build.
**Related:** `AutoExtendReserveDesign.md` (#2814, the reserve this generalises), `BorrowerAutoProtectDesign.md` (#1206, whose collateral top-up this replaces), `VaultOutflowPolicyDesign.md`, `EncumbranceLifecycleMap.md`, the protected-mode Ready balance (#3344), `LoanSettingsSnapshotDesign.md` (#3437).

## 1. Why

A borrower today has to be present for three things, and missing any of them costs money:

- a falling health factor ends in a liquidation with its charges, although the borrower may hold more of the collateral asset;
- a periodic interest payment that is missed is collected by a forced sale of collateral, with a handling fee and a settler bonus;
- a loan not repaid by its due date pays a late fee and then defaults.

Banks solve this with a standing order: the customer authorises, once and within limits, a payment out of their own account. Nothing like it exists here. Scouting the code on 2026-11-15 found:

- Adding collateral and repaying both pull from the caller's **wallet**. A keeper cannot run them for a borrower without a standing token approval, which the platform has been removing everywhere (#1558).
- The only "pay from my vault later" route is the extension reserve (#2814): a per-loan deposit in the lending asset that an automatic extension draws its charge from.
- The periodic settlement has a free path when the period is already paid, and a collateral sale when it is not. Nothing pays the period from the borrower's own money on their behalf.
- An earlier design (#1206) proposed a keeper-run collateral top-up under a new keeper permission. It was never built.

## 2. What the user gets

For each loan, the holder of the borrower position may fund a **loan reserve** in their own vault and switch on up to three instructions:

1. **Keep my loan healthy.** When the health factor falls below a level I choose, move collateral from my reserve into the loan until it is back at my target.
2. **Pay my interest.** When a periodic interest payment falls due, pay it from my reserve.
3. **Repay at the due date.** Shortly before the due date, repay the loan in full from my reserve.

The reserve is the limit. An instruction can never spend anything the user did not put in that loan's reserve, and it can spend it on that loan only. Money moves from the user's own vault into their own loan: to the collateral lien for instruction 1, to the lender as a payment the user already owes for instructions 2 and 3.

## 3. The loan reserve

One reserve per loan and depositor, holding up to two balances:

| Balance | Asset | Used by |
| --- | --- | --- |
| Payment reserve | the loan's lending asset | interest payments, the due-date repayment, and the charge of an automatic extension (today's extension reserve) |
| Collateral reserve | the loan's collateral asset | collateral top-up |

The extension reserve of #2814 becomes the payment reserve: same record, wider use. The platform is prelive and the next deploy is fresh, so the old name and entry points are replaced, not kept beside the new ones.

Rules carried over from #2814 unchanged:

- The reserve sits in the depositor's own vault, recorded in the shared encumbrance total, so the withdrawal guard treats it as not free and no offer, intent or claim can take it. One library writes it.
- Funding goes through the vault's deposit route, which records the tracked balance and refuses a short arrival. Only the current holder of the borrower position may fund. Funding is refused for a loan that is not Active, for a paused asset, and for a sanctioned wallet.
- **The reserve follows the depositor, not the position.** If the borrower position moves, the old holder withdraws their reserve and the new holder funds their own. An instruction runs only while the position's holder is the wallet that set the instruction and owns the reserve; otherwise it is skipped and says why.
- The depositor may withdraw unused reserve at any time, whatever the loan's state. The withdrawal is an ordinary vault payout under the outflow policy.
- Nothing else takes the reserve. Repayment by another route, default and liquidation never touch it. The collateral reserve is **not** collateral: a liquidation cannot seize it, and it counts for nothing in the loan's health factor until an instruction moves it into the lien.

New rules:

- The collateral reserve is offered only for an ERC-20 collateral that is liquid and priced, since instruction 1 has no trigger without a health factor.
- **Protected accounts.** A deposit from the wallet is new money and is instant. Moving existing protected balance into a reserve waits the account's delay, the same as moving it into the Ready balance (#3344). A withdrawal returns to the protected balance and leaves by the normal delayed payout. A lock or a replacement freezes the reserve and every instruction.

## 4. The three instructions

Each instruction is a per-loan setting written by the current borrower-position holder (or that holder's protected-account manager), and cleared by the same wallet at any time. Setting one is refused where the matching manual action could not run on that loan.

### 4.1 Keep my loan healthy

Settings: a trigger health factor and a target health factor. Bounds, as governed settings: the trigger between 1.05 and 1.45, the target above the trigger by a margin and no higher than 2.0.

Execution, callable by anyone:

- Runs only when the loan is Active, liquid, and its health factor is below the trigger at the block it runs in.
- The amount is computed on-chain: the least collateral that brings the health factor to the target, or the whole collateral reserve if that is less. The caller supplies no number.
- The amount moves from the collateral reserve into the loan's collateral lien, in the same vault. It does not leave the vault.
- A minimum interval between two top-ups on one loan (a governed setting, starting at one hour) stops thrashing.
- The event states the amount, the health factor before and after, and what is left in the reserve.

A top-up is the user's own collateral, returned with the rest when the loan is repaid. A caller who triggers one early gains nothing and cannot change the amount, which is why no keeper permission is needed.

### 4.2 Pay my interest

Offered on a loan with a periodic interest cadence.

Execution, callable by anyone once the period's end is reached:

- Pays the period's unpaid interest from the payment reserve to the lender through the existing interest-payment path, with the same treasury share, the same ledger entries and the same events as a payment the borrower makes by hand.
- If the reserve covers only part, it pays that part. The periodic settlement then sells collateral for the remainder only, as it already does after a partial voluntary payment.
- When the period is fully paid, the same call stamps the period closed through the settlement's free path.

### 4.3 Repay at the due date

Settings: on or off, and how long before the due date to run (a governed bound, from zero to 24 hours, default one hour).

Execution, callable by anyone from that moment until the grace period ends:

- Repays the loan in full from the payment reserve through the existing repayment path, as if the borrower had paid by hand: same amounts, same late fee if run after the due date, same collateral release to the borrower.
- All or nothing. If the reserve is short of the full amount it does nothing and says how much is missing. A partial repayment at maturity would leave the loan to default anyway.
- **One plan for the due date.** A loan may carry this instruction or the borrower's automatic-extension or automatic-refinance limits, not both. Whichever is set second is refused until the first is cleared.

### 4.4 When an instruction does not run

An instruction is skipped, with an event naming the reason, when: the position holder is no longer the wallet that set it; the reserve is empty or short (4.3); a preclose offset, a sale listing, a refinance or a fallback is live on the loan; the price is missing or distrusted (4.1); the asset or the platform is paused. A skip changes nothing and can be retried. An instruction is a convenience the user must still watch: the app says so, and the alerts in section 6 tell them when one could not run.

## 5. Who may run it, and why no keeper permission

All three executors are permissionless. Every input is fixed by the loan, the user's setting and the reserve; the caller chooses nothing and receives nothing. This differs from #1206, which proposed a new keeper permission bit. A permission would tie the user's protection to one named keeper being alive, and it guards nothing here because there is no discretion to guard.

Sanctions follow the manual action each instruction stands in for: funding is refused for a flagged wallet; paying interest and repaying stay open, as repayment does today, so the lender is made whole.

Per the platform rule, every permissionless step is keeper-backed: one new keeper pass with a separate arming flag per instruction, each shipped unset. Each step gets a row in `contracts/permissionless-steps.json`.

## 6. Keeper and app

- **Keeper.** The pass reads loans with an instruction set, and submits the top-up when the health factor is under the trigger, the interest payment at the period end, and the repayment at the configured time. It pays gas only. It alerts the borrower through the existing borrower alerts when a reserve is too low for the next payment, when a top-up ran, and when an instruction was skipped.
- **Who runs it is stated.** A switch the borrower turns on is their authorisation; it is not a promise that someone will act. Each deployment's keeper may have any of the three steps armed or not. The keeper publishes which steps it is running, and the panel shows, per instruction, both the borrower's setting and whether this deployment's keeper is currently running that step. Where it is not, the panel and the confirmation review say so in plain words: "No automatic runner is active for this instruction here. It will run only if you or someone else submits it." The same line appears when the state cannot be read.
- **App.** Loan details gain a "Reserve and instructions" panel: the two balances, fund and withdraw, the three switches with their settings, a line stating the most each can spend (the reserve), and the history of runs and skips. The review for 4.1 states that the collateral reserve is not counted in the loan's health until it is moved. The review for 4.3 shows the amount due at the due date and whether the reserve covers it. Views return, per loan: both balances, each instruction's setting, the amount each would move now, and the shortfall against the next interest payment and the full repayment.

## 7. Contract changes

| Where | Change |
| --- | --- |
| Reserve record and its one writer | The extension reserve becomes the payment reserve; a collateral reserve is added beside it. Fund, withdraw and view take the reserve kind. |
| New facet for the instructions | Settings, the three executors, the views. Its own facet from the start; the repay, periodic and collateral facets are all near the size limit. |
| Collateral top-up | A vault-internal move from the collateral reserve to the loan's lien, reached only from executor 4.1. It reuses the lien bookkeeping of the manual add-collateral path, not a copy. |
| Interest payment and full repayment | The existing paths gain a payer source of "the holder's payment reserve", reached only from executors 4.2 and 4.3 by self-call. The amounts, splits and events are the existing ones. |
| Automatic extension | Draws its charge from the payment reserve as today. |
| Loan settings | Executors read prices and health through the loan's stamped settings (#3437). |
| Pre-deploy checks | Rows in the permissionless-steps ledger; storage-layout guard `write`; facet sizes with the deploy-sanity suite. |

The swap mode of #1206 (sell part of the pledged collateral to pay down the debt) is not part of this design. It stays on #1206 for after the audit.

## 8. Tests

1. Reserve: fund, withdraw, both kinds; refusals; encumbrance (an offer, an intent, a claim or a payout cannot take reserved balance); the reserve survives repayment, default and liquidation and is withdrawable after each.
2. Top-up: trigger and target bounds; amount equals the least needed, clamped by the reserve; the collateral reserve is absent from the health factor before the move and present after; interval; illiquid loan refused at setting.
3. Interest: full and partial payment from the reserve; the following settlement sells only the remainder; identical splits and ledger entries to a manual payment.
4. Repayment: at the configured time, at the due date, inside grace with the late fee; short reserve does nothing; identical outcome to a manual repayment; the one-plan rule against extension and refinance limits.
5. Position transfer: the old holder's instruction is skipped; the old holder withdraws; the new holder's reserve and setting work.
6. Skips: each reason in 4.4 emits and changes nothing.
7. Protected account: delayed funding from protected balance, instant from the wallet, freeze on lock.
8. Callers: any address may run each executor and none gains from it; a sanctioned depositor cannot fund; payment paths stay open.

## 9. Alternatives considered

1. **Pull from the wallet when the time comes.** Needs a standing token approval to the platform, the pattern #1558 removed. Rejected.
2. **A keeper permission per instruction (#1206).** Adds a grant the user must manage and a dependency on one keeper, and protects nothing because the caller has no discretion. Rejected in favour of open execution.
3. **Spend any free balance in the vault, not a named reserve.** Makes the limit unclear and lets one loan's instruction spend money the user meant for another. Rejected: the reserve is the limit.
4. **One reserve per user across all loans.** Fewer deposits, but one failing loan could drain protection the user intended for another, and position transfers become ambiguous. Rejected for now; the per-loan reserve is the simpler promise.
5. **Count the collateral reserve as collateral.** Then it would be pledged from the start and the user could simply post more collateral. The reserve exists for the user who wants the money free unless needed.
6. **Leave it to the app (reminders only).** The status quo. It does not help a user who is asleep or travelling when the price moves.

## 10. Recommendation

Build the per-loan reserve with the three instructions and open execution, as sections 3 to 5. It reuses the reserve the platform already has, adds no standing approval and no keeper permission, and every unit it spends was placed there by the user for that loan.

## 11. Open items for the builder to raise, not decide silently

- Whether the top-up's minimum interval and bounds should sit per asset tier or platform-wide.
- Whether instruction 4.2 should also run a little before the period end, as 4.3 does, or only at it.
- Confirm against the code that a reserve-sourced payment needs no new outflow reason, or name the new one.
