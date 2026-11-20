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
   Amended 2026-11-19 (#3811, `LendingBalanceDesign.md` 3.8): the source is a lender's **lending balance**, which replaces per-slot capital. The consent and its fee belong to the balance, one per lending asset, and a flash loan names lenders, each once. Where sections 3 and 4 below say a slot, its capital, its consent or its fee, read the lender's balance. Setting a slot's terms again no longer clears the consent, and no slot has to be active. The vault call, the nesting, the entry lock, the fee split and the eligible assets are unchanged.
2. **Each vault checks its own outcome.** A vault that lends ends its own call holding at least what it held plus its fee, or the transaction reverts. The check is the vault's, on balances it measures, and does not depend on the Diamond being right ("check outcomes, not identities", owner decision 2026-11-09).
3. **Nothing is booked as lent.** No loan, no position token, no lien change, no change to the slot's capital or to the Declared, Available and Lent figures. The only lasting effect is the fee.
4. **Nothing enters the platform during the loan.** A flash loan holds a lock at the Diamond's one entry point for the whole call, the kind of lock a limit-order fill holds today. While it is held the Diamond admits only its own self-calls and the lending vaults' continuation call. Every other entry is refused before it reaches a facet: a guarded entry, an unguarded one, a view, and a callback from a contract the platform trusts (4.4). So the borrowed money cannot be used on a platform step inside the same transaction, and no settlement can run while a vault is out of balance.
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
| The entry lock a limit-order fill holds, enforced in the Diamond's fallback before the selector lookup | `LibFillLock`, `VaipakamDiamond` | Rule 4 |
| The Diamond's one reentrancy guard | `LibReentrancyGuard` | The self-called hosts and the vault moves, which require it |

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
- **A slot may be named once.** The entry refuses a list that names the same slot twice, before it selects anything. A slot's un-lent capital is the most that one flash loan may take from that slot, and the sum taken from one owner's vault is never more than the sum of the un-lent capital of that owner's named slots, each counted once. Without this a repeated slot would be counted again and the loan would reach balances its owner never offered: free balance, collateral, a reserve.
- **Each source lends at its own fee**, as an instant borrow fills each slot at its own price. A slot asking more than `maxFeeBps` is skipped.
- **A slot that is not live, or lacks the consent, is skipped and reported**, never reverted on. The amount taken from a slot is the least of what is still needed and the slot's un-lent capital.
- **A slot's smallest fill does not apply to a flash draw.** That minimum exists so a slot is not broken into dust loans and dust positions. A flash draw opens no loan and no position, and is whole again when the call ends, so any amount may be drawn. The fee is rounded up to the asset's smallest unit and is never zero, so no draw is free.
- **The amount is exact.** If the sources together give less than `amount`, the call reverts. A flash borrower needs a known figure.
- **Screens:** the platform is not paused, the asset is not paused, the caller is unflagged (the new-business sanctions screen) and current on the Terms. The caller is never a source's owner (no self-lending).
- **The callback** is the borrower callback of the single-transaction lending standard (ERC-3156), so a contract written for that standard needs no change to its callback: the receiver is called with the initiator (itself), the asset, the total amount, the total fee and its own `data`, and must return the interface's fixed acknowledgement value. A wrong value reverts.
- **Repayment is pulled.** After the callback, the Diamond moves each source's amount plus fee from the receiver straight to that source's vault, on an allowance the receiver gave the Diamond for the total. Nothing rests in the Diamond.

Views: `flashFee(asset, amount, sources[])` and `maxFlashLoan(asset, sources[])`, computed by the same walk the entry runs, with the same refusal of a repeated slot, so a borrower can size a call from what the call would do. Like every view, they do not answer while a flash loan or a fill is open (4.7); a borrower reads them before the call.

### 4.3 What each vault does

A new vault entry, `flashOut(asset, amount, fee, receiver)`, callable by the Diamond only:

1. Refuse while a grant is open, a swap is running or another flash is running on this vault (a transient flag, as `swapOut` has). `transferOut`, `grantAllowance` and `swapOut` refuse while a flash is running.
2. Refuse a receiver that is this vault, the Diamond, the asset or not a contract. ERC-20 only.
3. Measure this vault's balance of the asset, and the receiver's.
4. Send `amount` to the receiver, and measure the receiver's balance again. If it rose by less than `amount`, revert. The callback tells the receiver it holds an exact amount, so the vault checks that it does. A token that takes a fee on transfer fails here, whatever the receiver would have paid back.
5. Call the Diamond's continuation (4.4). The vault calls only its own Diamond, at the address recorded at its creation, and never an address a caller supplies.
6. Measure this vault's balance again. If it is below the first measure plus `fee`, revert.
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

**The entry lock.** The reentrancy guard alone does not keep the platform closed during the callback. Some entries are made to run inside an action that already holds the guard: the collateral listing executor's settlement callbacks take the guard only when nothing holds it, and run inside the holder's otherwise. A receiver could fill a loan's marketplace listing during its callback, and the settlement would run in the middle of the flash loan, against vaults that are out of balance. So `flashLoan` also opens the entry lock, and the rule is enforced at the Diamond's fallback, before the selector lookup, where no facet has to remember it:

- While a flash loan is open, a call enters the Diamond only if it is the Diamond's own self-call, or `flashContinue`. `flashContinue` then accepts only the vault the plan expects next.
- Everything else is refused by name: mutators, views, multicall, the listing executor's callbacks, a limit-order pre-hook or post-hook, a cross-chain receiver's delivery. A refused cross-chain delivery stays re-executable, as under a pause.
- The two locks exclude each other. A flash loan cannot open inside a limit-order fill, and a fill cannot open inside a flash loan.
- The lock is transient, so a reverted call can never leave it set. The lock and the guard are both held to the end of `flashLoan`, through the vaults' closing checks and the fee booking, which need only self-calls.

Whether the flash lock shares the fill lock's transient slot (one read on every call, as today) or has its own is the builder's choice; the admitted set above is not.

### 4.5 The fee

- **Lender's part and the platform's part.** The platform takes the same share of a flash fee as it takes of interest (the yield fee, at the rate in force), through the one fee host, measured. No hold-tier discount applies, because there is no lender position whose entry standing could be read (#3562).
- **The lender's part lands in the lender's vault as free balance**, under the payout rule. It is not added to the slot's capital. The app shows it as a fee received.
- **Booking order, after the nested calls have returned:** raise the vault's tracked holding by what the vault measured; collect the platform's part from the vault through the fee host; credit the rest to the owner's free balance. A vault that received more than its fee (a plain token transfer to it during the call) keeps the surplus as its owner's free balance. No platform credit can arrive during the call, because nothing enters the platform (rule 4), so the rise a vault measures is never an amount some other step has also booked.
- **No reward, no integrator share, no inviter share.** A flash fee is not interest on a loan with a term, and a rewards entry here would pay for volume anyone can produce for the cost of gas.

### 4.6 Which assets

An asset is flash-eligible when it is in the top liquidity tier (the instant market's test) and is not the platform token. The master switch and the eligibility rule are separate: governance cannot make an asset eligible by switching the feature on.

The tier test measures market depth. It says nothing about how a token moves, so the transfer behaviour is checked where it happens, on every loan:

- **A token that takes a fee on transfer** fails the vault's delivery measure (4.3 step 4) and can never be flash-lent, even by a receiver willing to make up the difference.
- **A token whose balances change by themselves** is held to the vault's closing check like any other: a fall during the call reverts the loan, and a rise is the owner's.
- **A per-asset off switch** lets governance remove one eligible asset from flash lending without touching the instant market. It can only remove.

### 4.7 What is visible while a loan is out

For the length of the call a lending vault holds less of the asset than the platform's records say.

- **No view of the platform answers during a flash loan.** The entry lock refuses reads as it refuses writes, as it does during a fill. A contract that reads this platform inside someone's flash loan gets a named refusal and never a figure taken while a vault was out of balance. There is no list of "affected views" to keep complete.
- A token's own `balanceOf` for a vault address is outside the platform and reads low during the call. The integration page says so: another protocol must not value a Vaipakam vault from its raw token balance.
- Declared, Available and Lent do not move during or after a flash loan.

### 4.8 Protected accounts and the payout rule

A flash loan is not a payout. Nothing is owed to anyone and the vault ends whole. It is therefore outside the payout gate and outside the "one door to a wallet" rule of `PayoutDestinationRuleDesign.md`, and is listed there as the one outflow that is neither the owner's Withdraw nor a position settlement.

- A locked, replaced or flagged owner's slot is not live and is never drawn (the existing liveness rule).
- The consent is the owner's own, per slot, and stored only as the owner set it. Amended 2026-11-19 (#3761, `DefaultPathsDesign.md`): the Lend form pre-selects it where flash lending is on, shown on the review screen with its own switch and set in the transaction the owner signs. It was off in every preset before. No contract default gives it.
- The consent needs no protected-mode delay: it cannot cause a balance to leave. The secured-vault builder may raise this (11).

### 4.9 Switches and limits

| Setting | Default | Range |
| --- | --- | --- |
| Master switch | off | on or off |
| Most sources in one call | the instant market's fill bound (8) | 2 to 16 |
| A slot's fee | set by the owner | 1 to 100 basis points, governed |
| Smallest amount from a slot | none (4.2) | not a setting |
| Smallest fee on a draw | one unit of the asset, rounded up | not a setting |

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
7. The receiver calling any Diamond entry during the callback reverts with the lock's refusal: a guarded mutator, an unguarded one, a view, multicall.
8. The receiver calling `flashLoan` again during the callback reverts.
9. The receiver filling a loan's marketplace listing during the callback reverts when the executor's settlement callback reaches the Diamond, and the loan and its listing are unchanged.
10. A limit-order fill started inside the callback is refused at its pre-hook; `flashLoan` called inside a limit-order fill is refused.
11. After a flash loan that reverts, and after one that completes, the lock reads clear and the next call enters.
12. A list that names one slot twice is refused by the entry and by both views, including when the owner's vault holds other balances large enough to cover the repeated draw.
13. `flashContinue` called by anyone but the expected vault, or outside a plan, reverts.
14. `flashOut` called by anyone but the Diamond reverts.
15. A direct `flashOut` from a test Diamond that never repays reverts on the vault's own check (layer 2 without layer 1).
16. `transferOut`, `grantAllowance` and `swapOut` on a vault inside a flash revert.
17. A slot without the consent, with a consent younger than the minimum age, above the borrower's fee limit, of a locked, replaced or flagged owner, or of an aggregator adapter, is skipped and reported.
18. Sources that together fall short of the amount revert. A request below a slot's smallest fill, and a last remainder below it, are both drawn, and each pays a fee of at least one unit.
19. A caller that is flagged, not current on the Terms, not a contract, or a source's owner is refused.
20. A token that delivers less than it sends reverts at the vault's delivery measure, including when the receiver holds enough of its own to repay in full. An asset switched off for flash lending is refused while the instant market still lends it.
21. A donation to a vault during the call ends as the owner's free balance.
22. Every view called through the Diamond during a flash loan is refused, from the receiver and from a third contract it calls.
23. Master switch off refuses the entry and the consent setter's "on"; turning the consent off stays open.
24. Setting a slot's terms again clears the consent.
25. An invariant over random sequences: no flash loan lowers any vault's balance of any asset, no flash loan changes any lien or any slot's capital, and no flash loan takes more from a vault than the un-lent capital of the slots named for it.

## 7. Alternatives considered

1. **Lend from every vault's idle balance by default.** Rejected: the owner never chose it, and free balance is the owner's to withdraw at any moment.
2. **Lend only the reserve's or the treasury's own balance.** Simple, but small. Kept in a different form: the backstop vault's slot may carry the consent.
3. **Host the loan on the Diamond with the guard released for the callback**, so the money could be used on the platform. Rejected: it opens the whole platform to calls made in the middle of another call.
4. **Rely on the reentrancy guard alone to keep the platform closed.** Rejected: entries made for a trusted contract's callback run inside whichever action holds the guard, so the guard does not close them. Listing each such entry and adding a flash check to it would leave the next one unprotected. The lock at the entry point covers entries not yet written.
5. **Answer views with recorded figures during a flash loan**, from a list of affected views. Rejected: the list would have to stay complete for ever, and one missed view is a wrong figure handed to another contract.
6. **Record the loan as an ordinary outflow and inflow through the outflow policy.** Rejected: the policy's classes name who is owed, and a flash loan owes no one. It would also move the tracked figures twice for no lasting change.
7. **The Diamond checks repayment, the vault trusts it.** Rejected: it would be the one outflow the vault does not verify, which is the gap #3431 closed.
8. **One fee for the whole platform, set by governance.** Rejected: every other price here is the lender's own.
9. **The receiver repays each vault itself inside the callback.** Rejected: up to sixteen transfers to addresses the borrower's contract must be told. The pull on one allowance asks the borrower for one approval.
10. **A separate lending contract that holds deposits for flash loans.** Rejected: it holds users' funds together.

## 8. Recommendation

Build it as designed: one consent on a slot, one borrower entry, one outcome-checked vault call, nested, with the fee split through the existing fee host. Keep it off until the instant market is live on a chain. Since #3761 the launch configuration switches the instant market on from the first deploy, so this condition is met at launch once this build has passed its audit phase (`DefaultPathsDesign.md` section 5).

## 9. Build notes

- **Order:** (1) the vault's `flashOut` and its transient flag, with test 15; (2) the entry lock in the Diamond's fallback, with tests 7 to 11; (3) the slot fields and setter; (4) `FlashLoanFacet` with `flashLoan`, `flashContinue` and the views; (5) fee booking; (6) indexer events and the app's switch.
- **The Diamond contract itself changes** (its fallback), so this reaches a chain only with a new Diamond, as the fill lock did.
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
3. Whether any step of an ordinary flash borrower's flow needs a platform view inside the callback. Designed: none does, and all are refused (4.7).
4. Whether the consent should also be written on the vault's own record, so the vault refuses a `flashOut` its owner never consented to. Designed: no, because the outcome check already bounds the result; the builder may show a case where it does not.
