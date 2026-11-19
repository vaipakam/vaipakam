# Flash lending from Auto-lend slots — design

**Status:** owner asked for it on 2026-11-19 ("we can implement the flash loan part now itself"), to be built before the pre-audit refactor so the refactor does not reopen audited vault code later. Card #3748. Design first, no code yet. Reaches a chain by fresh deploy.
**Related:** `InstantMarketDesign.md`, `VaultOutflowPolicyDesign.md`, `PayoutDestinationRuleDesign.md`, `FeeLevelsDesign.md`, `TermsAcceptanceEnforcementDesign.md`, `FlashLoanLiquidationPath.md` (the platform as a *user* of flash loans, unchanged by this design).
**Base:** the route and names below were read on the batch branch of #3743 (`claude/project-thread-ijafuu` at `4b747f902`), where the instant market, the vault's outcome-judged swap (#3431) and the vault-only payout rule (#3710) are built. Main does not have them yet.

## 1. The question

Can the platform lend an asset for the length of one transaction, with no collateral, for a fee, and where does the money come from?

A flash loan is taken and repaid inside one transaction. If it is not repaid with its fee, the whole transaction reverts, so the lender ends either whole plus a fee or exactly where it started. The platform uses such loans today (the keeper's liquidator receiver funds a discounted liquidation with one). It does not provide them.

The platform holds no balance of its own to lend. Every user's assets sit in that user's own vault. So the question is which vault balances may be lent this way, on whose consent, and who checks that they came back.

## 2. The rule

1. **The source is un-lent Auto-lend capital, slot by slot, on the slot owner's own consent.** A slot's owner may add one standing consent, "lend for one transaction", with the fee the slot asks. Nothing else in a vault is ever lent this way: not free balance, not Ready balance, not collateral, not an offer's backing, not a reserve.
2. **Each vault checks its own outcome.** A vault that lends ends its own call holding at least what it held plus its fee, or the transaction reverts. The check is the vault's, on balances it measures, and does not depend on the Diamond being right ("check outcomes, not identities", owner decision 2026-11-09).
3. **Nothing is booked as lent.** No loan, no position token, no lien change, no change to the slot's capital or to the Declared, Available and Lent figures. The only lasting effect is the fee.
4. **The borrower cannot touch the platform during the loan.** The Diamond's guard is held for the whole call, so the borrowed money cannot be used on a platform step inside the same transaction.
5. **Off by default**, under its own master switch, and limited to the same top-tier assets as the instant market.

## 3. What exists today that this builds on

| Part | Where | Used for |
| --- | --- | --- |
| Auto-lend slots and their liened capital (`lenderIntent`, `lenderIntentCapital`) | `LenderIntentFacet` | The source and its amount |
| A slot's standing consents (`InstantSlot`: fills, renewal, takeover, `setAt`) and their setter | `InstantMarketFacet.setInstantSlot` | The place the fourth consent lives |
| One rule for whether a slot is live (owner unflagged, may open commitments, terms old enough) | `LibIntentFill`, #3443 | Which slots may be drawn |
| The vault's outcome-judged swap (`swapOut`): measure, call out, measure, refuse on the result | `VaipakamVaultImplementation`, #3431 | The model for the vault's flash call |
| The one fee host (`collectFeeFromVault`) | `TreasuryFeeFacet` | Booking the platform's share |
| The free-balance ledger | `LibDepositoryLedger` | Crediting the lender's share |
| The Diamond's one reentrancy guard | `LibReentrancyGuard` | Rule 4 |

## 4. Design

### 4.1 The lender's consent

`InstantSlot` gains two fields: `flash` (the consent) and `flashFeeBps` (the fee the slot asks, in basis points of the amount lent).

- Set through the existing slot setter, with the same conditions a consent has today: the slot is active, the owner is unflagged and may open commitments, the risk and terms consent is given, and the owner is current on the Terms.
- It does **not** need the instant-market "fills" consent or interest by time. A slot that makes only fixed full-term loans may still lend for one transaction.
- The lending asset must be flash-eligible (4.6). The collateral asset of the slot's pair is irrelevant to a flash loan and is not checked.
- `flashFeeBps` is bounded by governance (default range 1 to 100, so a fee is never zero). The app suggests a default.
- Setting the slot's terms again clears it, as it clears the other three. Turning it off is always open and takes effect at once.
- A draw waits the same minimum age from the consent as a fill does (#3443), so a consent cannot be set and used in one block.
- The backstop vault's slot may carry the consent by a governance call like any owner's. An aggregator adapter's slot may not in this version: its capital belongs to an outside principal, whose consent the adapter cannot give for it.

### 4.2 The borrower's call

A new facet, `FlashLoanFacet`, with one entry:

`flashLoan(asset, amount, maxFeeBps, sources[], data)`

- **The caller is the receiver.** The borrowed amount is sent to `msg.sender`, which must be a contract, and the callback is made on `msg.sender`. A loan can never be started on someone else's contract.
- **Sources** are slots named off-chain, cheapest first: `(owner, collateralAsset, slot)`. At most the instant market's fill bound (default 8, governed 2 to 16).
- **Each source lends at its own fee**, as an instant borrow fills each slot at its own price. A slot asking more than `maxFeeBps` is skipped.
- **A slot that is not live, or lacks the consent, is skipped and reported**, never reverted on. The amount taken from a slot is the least of what is still needed and the slot's un-lent capital. A slot left with less than its smallest fill to give is skipped.
- **The amount is exact.** If the sources together give less than `amount`, the call reverts. A flash borrower needs a known figure.
- **Screens:** the platform is not paused, the asset is not paused, the caller is unflagged (the new-business sanctions screen) and current on the Terms. The caller is never a source's owner (no self-lending).
- **The callback** is the borrower callback of the single-transaction lending standard (ERC-3156), so a contract written for that standard needs no change to its callback: the receiver is called with the initiator (itself), the asset, the total amount, the total fee and its own `data`, and must return the interface's fixed acknowledgement value. A wrong value reverts.
- **Repayment is pulled.** After the callback, the Diamond moves each source's amount plus fee from the receiver straight to that source's vault, on an allowance the receiver gave the Diamond for the total. Nothing rests in the Diamond.

Views: `flashFee(asset, amount, sources[])` and `maxFlashLoan(asset, sources[])`, computed by the same walk the entry runs, so a borrower can size a call from what the call would do.

### 4.3 What each vault does

A new vault entry, `flashOut(asset, amount, fee, receiver)`, callable by the Diamond only:

1. Refuse while a grant is open, a swap is running or another flash is running on this vault (a transient flag, as `swapOut` has). `transferOut`, `grantAllowance` and `swapOut` refuse while a flash is running.
2. Refuse a receiver that is this vault, the Diamond, the asset or not a contract. ERC-20 only.
3. Measure this vault's balance of the asset.
4. Send `amount` to the receiver.
5. Call the Diamond's continuation (4.4). The vault calls only its own Diamond, at the address recorded at its creation, and never an address a caller supplies.
6. Measure again. If the balance is below the first measure plus `fee`, revert.
7. Return what the balance rose by.

This is the whole of layer 2 for a flash loan. A faulty or hostile caller of `flashOut` gains nothing: the vault ends the call holding more than it started with, or the call never happened. The receiver's identity is not checked beyond step 2, because the outcome is.

One vault is called once per flash loan. Where two named slots have the same owner (and so the same vault), the facet sums them into one `flashOut` and keeps the per-slot split in its own bookkeeping.

### 4.4 How the calls nest

A vault cannot be made to "check later": once its call returns, nothing forces a second call. So the vaults are nested, each holding its check open around everything that follows.

1. `flashLoan` selects the sources and records the plan in transient storage.
2. It calls `flashOut` on the first vault.
3. That vault sends its part and calls the Diamond's `flashContinue()`.
4. `flashContinue` accepts a call only from the vault the plan expects next. While vaults remain, it calls `flashOut` on the next one. After the last, it calls the receiver's callback and then pulls each repayment.
5. The calls return in reverse order, and each vault runs its own check as its call ends.

`flashContinue` takes no guard of its own, because `flashLoan` holds the Diamond's guard for the whole call, as every self-called host does. It is refused outside an open plan.

### 4.5 The fee

- **Lender's part and the platform's part.** The platform takes the same share of a flash fee as it takes of interest (the yield fee, at the rate in force), through the one fee host, measured. No hold-tier discount applies, because there is no lender position whose entry standing could be read (#3562).
- **The lender's part lands in the lender's vault as free balance**, under the payout rule. It is not added to the slot's capital. The app shows it as a fee received.
- **Booking order, after the nested calls have returned:** raise the vault's tracked holding by what the vault measured; collect the platform's part from the vault through the fee host; credit the rest to the owner's free balance. A vault that received more than its fee (a donation during the call) keeps the surplus as its owner's free balance.
- **No reward, no integrator share, no inviter share.** A flash fee is not interest on a loan with a term, and a rewards entry here would pay for volume anyone can produce for the cost of gas.

### 4.6 Which assets

An asset is flash-eligible when it is in the top liquidity tier (the instant market's test) and is not the platform token. A token that takes a fee on transfer, or changes balances by itself, cannot pass the vault's check and is not top-tier in any case. The master switch and the eligibility rule are separate: governance cannot make an asset eligible by switching the feature on.

### 4.7 What is visible while a loan is out

For the length of the call a lending vault holds less of the asset than the platform's records say. No platform step can run then (rule 4). A read can: the receiver, or anything it calls, may read the platform's views.

- Every view that reports a vault's real balance of an asset, or a figure derived from it, reports the recorded figure while a flash is open on that vault, or refuses. The builder lists these views; the free-balance view is one.
- A view `flashOpen()` reports whether a flash loan is running, so another contract that reads this platform can refuse to act on a reading taken inside one.
- Declared, Available and Lent do not move during or after a flash loan.

### 4.8 Protected accounts and the payout rule

A flash loan is not a payout. Nothing is owed to anyone and the vault ends whole. It is therefore outside the payout gate and outside the "one door to a wallet" rule of `PayoutDestinationRuleDesign.md`, and is listed there as the one outflow that is neither the owner's Withdraw nor a position settlement.

- A locked, replaced or flagged owner's slot is not live and is never drawn (the existing liveness rule).
- The consent is the owner's own, per slot, and off by default in every preset.
- The consent needs no protected-mode delay: it cannot cause a balance to leave. The secured-vault builder may raise this (11).

### 4.9 Switches and limits

| Setting | Default | Range |
| --- | --- | --- |
| Master switch | off | on or off |
| Most sources in one call | the instant market's fill bound (8) | 2 to 16 |
| A slot's fee | set by the owner | 1 to 100 basis points, governed |
| Smallest amount from a slot | the slot's smallest fill | the slot's own |

Turning the master switch off stops new flash loans at once. There is nothing to wind down.

## 5. What a user sees

- **A lender** sees one more switch on an Auto-lend slot, "Also lend for a single transaction", with the fee asked, a plain statement that the amount returns in the same transaction or the transaction does not happen, and a running line of fees received.
- **A borrower** of this kind is a developer. The site gets a short integration page: the entry, the callback, the allowance, the fee and limit views, and the rule that the money cannot be used on the platform itself in the same transaction.
- **The public figures** show, per asset, the amount flash-lendable now and the fees paid over the last 7 and 30 days.

## 6. Tests

1. A loan from one slot returns amount plus fee; the lender's free balance rises by its part, the treasury by its part, and capital, liens, Declared, Available and Lent are unchanged.
2. A loan across the maximum number of slots, each at its own fee.
3. Two slots of one owner are drawn in one vault call, with the split booked per slot.
4. A receiver that repays one unit short reverts the whole call; every vault is unchanged.
5. A receiver that returns the wrong acknowledgement reverts.
6. A receiver that gives no allowance, or too little, reverts.
7. The receiver calling any guarded platform entry during the callback reverts.
8. The receiver calling `flashLoan` again during the callback reverts.
9. `flashContinue` called by anyone but the expected vault, or outside a plan, reverts.
10. `flashOut` called by anyone but the Diamond reverts.
11. A direct `flashOut` from a test Diamond that never repays reverts on the vault's own check (layer 2 without layer 1).
12. `transferOut`, `grantAllowance` and `swapOut` on a vault inside a flash revert.
13. A slot without the consent, with a consent younger than the minimum age, above the borrower's fee limit, of a locked, replaced or flagged owner, or of an aggregator adapter, is skipped and reported.
14. Sources that together fall short of the amount revert.
15. A caller that is flagged, not current on the Terms, not a contract, or a source's owner is refused.
16. A token that delivers less than it sends reverts at the vault.
17. A donation to a vault during the call ends as the owner's free balance.
18. The views of 4.7 report recorded figures during a flash, and `flashOpen()` reads true only inside one.
19. Master switch off refuses the entry and the consent setter's "on"; turning the consent off stays open.
20. Setting a slot's terms again clears the consent.
21. An invariant over random sequences: no flash loan lowers any vault's balance of any asset, and no flash loan changes any lien or any slot's capital.

## 7. Alternatives considered

1. **Lend from every vault's idle balance by default.** Rejected: the owner never chose it, and free balance is the owner's to withdraw at any moment.
2. **Lend only the reserve's or the treasury's own balance.** Simple, but small. Kept in a different form: the backstop vault's slot may carry the consent.
3. **Host the loan on the Diamond with the guard released for the callback**, so the money could be used on the platform. Rejected: it opens the whole platform to calls made in the middle of another call.
4. **Record the loan as an ordinary outflow and inflow through the outflow policy.** Rejected: the policy's classes name who is owed, and a flash loan owes no one. It would also move the tracked figures twice for no lasting change.
5. **The Diamond checks repayment, the vault trusts it.** Rejected: it would be the one outflow the vault does not verify, which is the gap #3431 closed.
6. **One fee for the whole platform, set by governance.** Rejected: every other price here is the lender's own.
7. **The receiver repays each vault itself inside the callback.** Rejected: up to sixteen transfers to addresses the borrower's contract must be told. The pull on one allowance asks the borrower for one approval.
8. **A separate lending contract that holds deposits for flash loans.** Rejected: it holds users' funds together.

## 8. Recommendation

Build it as designed: one consent on a slot, one borrower entry, one outcome-checked vault call, nested, with the fee split through the existing fee host. Keep it off until the instant market is live on a chain.

## 9. Build notes

- **Order:** (1) the vault's `flashOut` and its transient flag, with test 11; (2) the slot fields and setter; (3) `FlashLoanFacet` with `flashLoan`, `flashContinue` and the views; (4) fee booking; (5) the views of 4.7; (6) indexer events and the app's switch.
- **New facet:** every registration in the "When you add a facet" list of `CLAUDE.md`.
- **Events:** one per flash loan (caller, asset, amount, total fee, sources used), one per source (owner, pair, slot, amount, the lender's part, the platform's part), one from the vault (asset, receiver, amount, gained). The indexer handles or allowlists each.
- **Checks:** `flashLoan` is open to any caller, so it needs a row in `contracts/permissionless-steps.json` (no keeper pass is owed: it is the caller's own action). The storage-layout golden file is rewritten for the new fields. The raw-payout check lists `flashOut` as the vault's one unbooked outflow.
- **Spec lines** to add with the build: the lender consent and the borrower entry in `ProjectDetailsREADME.md` beside the instant market; the vault call in `VaultOperations.md`; none in `KeeperOperations.md`.
- **Wording:** a "fee", never yield or income. Never "pool".

## 10. What this does not do

- It does not let a liquidator use a platform flash loan for a platform liquidation. That needs the borrower's contract to call the platform during the loan, and is a separate question.
- It does not lend NFTs.
- It does not lend across networks.

## 11. Open items for the builder to raise, not decide silently

1. Whether setting the consent on a protected account should wait the account's delay even though no balance can leave (4.8).
2. Whether the flash borrower must be current on the Terms (designed: yes), given that a borrower is a contract that must then make the acceptance call itself.
3. The complete list of balance-derived views for 4.7.
4. Whether the consent should also be written on the vault's own record, so the vault refuses a `flashOut` its owner never consented to. Designed: no, because the outcome check already bounds the result; the builder may show a case where it does not.
