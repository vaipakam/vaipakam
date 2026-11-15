# Every lender payout goes through the position claim — design

**Status:** owner direction and approval, 2026-11-15. Card #3629. Ready to build after the Auto-lend PRs (#3618 / #3619, #3626).
**Scope:** payments owed to a lender position while its loan is still open. Payments that end a loan are already claim-only and are not changed.
**Related:** `AutoLendLendUntilDesign.md` section 9 (partial repayment on intent loans), `IdleLiquidityMatchingDesign.md`, the vault outflow policy (#3205), the protected-mode delay (#3206), the position lock (#3318).

## 1. The rule

Every amount owed to a lender position is held for that position in a vault and leaves only by a claim made by the holder of the position NFT. No path pays a lender's wallet directly.

Why (owner, 2026-11-15): one payout rule for the whole platform; every lender payout passes the vault outflow policy, so nothing reaches a wallet except by a vault withdrawal, which is where a protected account's delay applies, and an incident can be answered before money has left; and the money stays with the position until its holder asks for it.

## 2. What happens today (scouted 2026-11-15)

**Already claim-only.** Every terminal close (full repayment, preclose, refinance, swap-to-repay, default, liquidation, internal match) pays the lender's due into the stored lender's vault under a reservation, and `claimAsLender` releases it through the vault outflow policy into the vault of the holder of the lender NFT (created if the holder has none) as free balance. The holder then withdraws to a wallet, and that withdrawal is the step a protected account's delay gates. A claim never pays a wallet.

**Paid to a wallet directly.** Payments made while the loan stays open go through three helpers in `LibCloseoutFreeze` (hosted on `EncumbranceMutateFacet`), which for a holder who is not sanctions-frozen pay the current holder of the lender NFT at once:

| Payment | Caller | Funds come from |
| --- | --- | --- |
| Partial repayment (ERC-20 loan) | `RepayFacet` | the payer's wallet |
| Partial rental payment (NFT rental) | `RepayFacet` | the renter's prepay vault |
| Rental payment inside a rental preclose step | `PrecloseFacet` | the renter's prepay vault |
| Periodic interest payment | `RepayPeriodicFacet` | the borrower's vault |
| Periodic forced sale proceeds | `ForcedSaleFacet` | the Diamond (just swapped) |
| Partial liquidation proceeds | `RiskFacet` | the Diamond (just swapped) |

The functional spec records this as intended ("paths that pay the lender's wallet directly (partial repayment, periodic-interest shortfall)"), so this design is an intent change and the spec changes with it.

**The other branch already exists.** For a frozen holder the same three helpers park the payment instead: it is deposited into the stored lender's vault, credited to the per-loan held-for-lender ledger (`heldForLender`), reserved against the stored lender's spending (`LibEncumbrance.encumberActiveHeld`), and its interest part is recorded in the interest ledger as held, not paid. That held amount already moves with the position on a sale or a consolidation, and the final lender claim already pays it out. The same ledger also carries preclose top-ups and partial internal-match proceeds.

**Three gaps this design must close.**

1. The lender claim is terminal-only: it requires a lender-claimable loan status. A held amount on an open loan cannot be claimed until the loan ends.
2. `rollIntentLoan` refuses any loan that carries a held amount (`LenderIntentLoanNotRollable`), because the roll would otherwise strand it.
3. The direct branch stamps a "value just left this position" time (`markLoanValueOut`) so a sale of the position cannot fill right after a payment emptied it.

## 3. Design

### 3.1 One route for a payment on an open loan

In each of the three helpers the frozen test and the direct branch are removed. Every payment:

1. pays open sold-interest claims first, into each seller's vault (unchanged);
2. deposits the rest into the stored lender's vault, measured (what arrived is what is credited);
3. credits `heldForLender[loanId]` and reserves it with `encumberActiveHeld`;
4. records its interest part in the interest ledger as held;
5. writes the frozen-claimant marker only if the holder is frozen. The marker writer already does nothing for a clean holder, so the call stays where it is.

The deposit step differs by source, as it does today: from a payer's wallet, from a party's vault, or from the Diamond. The custody vault is the STORED lender's, who is not always the holder: a rental's lender NFT can be transferred without the stored lender changing (rentals are excluded from consolidation), and the stored lender may later be flagged while the holder is clean. So the deposit entry is chosen from the custody owner's state, separately from the holder's: the sanctioned-lock deposit (which carries the receive-side exemption) is used whenever the stored lender or the holder must be frozen, and the ordinary deposit only when both are clean. A flagged stored lender must never block a borrower or renter from servicing the loan. The frozen-claimant marker still keys on the holder alone. The builder confirms the two deposit entries leave identical balances and tracked-holding records, so that an amount parked while clean and claimed after a freeze, or the reverse, is accounted the same.

`markLoanValueOut` is no longer called by these payments: the value has not left the position. Every step that takes held value out of a position that can still be sold stamps it instead: the mid-loan claim (3.2; the position-holder outflow route already stamps it) and both intent re-commit steps (3.3).

### 3.2 Claiming on an open loan

A new entry, `claimHeldForLender(loanId)`, callable by the holder of the lender NFT while the loan is open:

- same caller rule and sanctions rule as the lender claim (a flagged holder is refused; nothing is released to them);
- splits with open seller claims first (`LibInterestLedger` / `SellerClaimFacet`), exactly as the final claim does for the interest part of the held amount, and reports the holder's interest to the ledger as paid;
- releases the reservation and moves the held amount from the stored lender's vault into the holder's own vault through `LibVaultOutflow.toPositionHolder` with the claim reason, as free balance, exactly as the final claim does. This step is not delayed for a protected account; the delay applies when the holder withdraws that balance to a wallet. Delaying the claim itself would be a change to the outflow policy and is not proposed;
- sets `heldForLender[loanId]` to zero (the outflow route stamps `markLoanValueOut`), emits an event that states the loan, the holder, the asset and the amount;
- does not touch the loan's status, its NFTs, the intent exposure counter or the loan's terminal claim row.

The final lender claim keeps folding any unclaimed held amount, as today. One internal function pays a held amount, called by both entries, so the split and the outflow cannot differ between them.

Placement: `ClaimFacet` is the natural home; check its room with the deploy-sanity size test and, if it does not fit, host the entry beside the park helpers on `EncumbranceMutateFacet` or split along that seam. Do not trim.

No keeper pass is owed: a claim is the holder's own act. The entry has a caller gate, so it needs no row in `permissionless-steps.json`.

### 3.3 Standing intent loans (Auto-lend)

`rollIntentLoan` stops refusing a loan with a held amount. When the intent's owner still holds the position (the roll already requires it), the roll re-commits the held amount together with the final proceeds: it releases the active-held reservation, liens the measured total behind the intent slot the loan was filled from, and zeroes the held ledger. If seller claims exist the roll still refuses, as today. The roll ends the position, so no cooldown stamp is needed there.

A second, optional step lets held money go back to work before the loan ends: `recommitHeldToIntent(loanId)`, callable by the intent's owner or a keeper holding the owner's auto-roll permission, under the same checks as the roll (owner still holds the position, intent active, not past its lend-until date, no seller claims). It moves the held amount from the loan's held ledger to the intent's capital lien and stamps `markLoanValueOut`, because it takes value out of a position that can still be sold or transferred: without the stamp a holder could re-commit just before a pending purchase of the position fills, and the buyer would receive a position emptied of what they reviewed. The intent exposure counter is not changed by it, because the counter releases the loan's original fill amount at its terminal close (stated in `AutoLendLendUntilDesign.md` section 9). This is what makes a partial repayment on a pro-rata intent loan lendable again; with it, the sentence in that document saying such a payment "leaves Auto-lend" is retired.

This step is keeper-backed and state-changing, so it gets a row in `permissionless-steps.json` and a keeper pass that ships disarmed.

### 3.4 What a held amount is and is not

- It belongs to the position, with one existing rule kept: interest earned before a sale is the seller's. On a sale of the position the existing sale step (`LibInterestLedger.recordSale`, `SellerClaimFacet.settleParkedInterestAtSale`) takes the parked interest out of the held amount and reserves it for the seller; the held principal, and everything paid after the sale, goes to the buyer. That step was written for the rare frozen-holder park and now runs on every sale of a position with unclaimed interest, so it is in this build's scope: its accounting, its refusal when a recorded frozen claimant is still blocked, and its tests are re-verified for the common case. A plain transfer (no sale) splits nothing and carries the whole held amount; consolidation moves it with the position (existing behaviour).
- It is not the stored lender's spendable balance: the reservation keeps it out of offers, intents, withdrawals and the Ready balance until claimed or re-committed.
- It earns nothing while held. The app says so and shows the claim.
- Fee tier: a held VPFI amount on an open loan stays outside the tier exclusion, as today (the reason recorded in `LibCloseoutFreeze` still holds: the position can move before the claim).
- Lender fee discount and rewards: the interest ledger now records mid-loan interest as held until claimed. The builder lists every reader of "paid to the holder" (`LibInterestLedger.holderPaid` consumers, the reward accrual, the lender-discount settlement) and confirms each still sees the interest exactly once; any that would change is reported to the owner, not decided silently.

### 3.5 Funds statement

For each payment the events state: who paid, how much went to sellers, how much was held for the position and in whose vault. For each claim or re-commit: the loan, the holder or intent, the asset, the measured amount. No surface shows a held amount as received.

## 4. Spec and app

- `ProjectDetailsREADME.md`: replace the "paths that pay the lender's wallet directly" sentence and state the rule in section 1; state the mid-loan claim and the intent re-commit. Record the change of intent with this decision's date, as the docs-versus-code rule requires.
- App (alpha05): each lender position shows "ready to claim" with the amount; one action claims across positions; the copy says the claim moves the money into the holder's vault and that a withdrawal to the wallet follows the account's usual rules, including a protected account's delay. Borrower and renter screens stop saying a payment "goes to the lender's wallet". The indexer handles the new events (the event-coverage guard will require it).
- Keeper bot ABIs and frontend ABIs re-exported.

## 5. Reach

Fund-moving paths change and the six callers, the host, the claim and the roll must move together, so this reaches a chain by fresh deploy with the rest of the queue. No storage layout change is expected (the held ledger and the active-held reservation exist); confirm with the storage-layout guard. Because loans opened before the change could have received direct payments, nothing needs migrating: a held amount of zero is simply correct for them, but the platform is prelive and every chain is deployed fresh anyway.

## 6. Tests

1. For each of the six payment paths: nothing reaches the holder's wallet; the vault balance, the held ledger and the reservation each rise by what arrived; the stored lender cannot withdraw, lend or list it.
2. Mid-loan claim: the holder receives exactly the held amount once; a non-holder is refused; a flagged holder is refused; a second claim finds nothing; the loan stays open and unchanged.
3. Protected account: the mid-loan claim credits the holder's vault at once; the withdrawal of that balance to the wallet waits the delay.
4. Seller claims: a position sold mid-loan, then a payment, then a claim: sellers are paid first and the holder's interest is reported once.
5. The position is sold with an unclaimed held amount: the interest earned before the sale is reserved for the seller and the buyer can claim the rest (held principal and later payments), each exactly once; a plain transfer carries the whole amount. A sale or transfer cannot go through inside the cooldown after a mid-loan claim or after `recommitHeldToIntent`, including in the same block.
6. Final settlement folds an unclaimed held amount into the terminal claim exactly once; a loan claimed mid-loan and then settled pays nothing twice.
7. Intent loan: the roll re-commits final proceeds plus the held amount to the originating slot; `recommitHeldToIntent` moves a held partial repayment behind the intent, the exposure counter is unchanged, and a later fill can draw on it; both refuse when the position was sold or seller claims exist.
8. A fee-on-transfer or short-delivering token: what is held is what arrived.
9. A frozen holder behaves as today, including a freeze that begins after an amount was parked while clean. A rental whose lender NFT moved to a clean holder and whose stored lender is then flagged: the renter's payment still goes through, is held in the stored lender's vault under the lock, and the clean holder can claim it.
10. Invariant: for every open loan, the sum of held amounts per vault and asset equals the active-held reservations for them.

## 7. Alternatives considered

1. **Keep direct wallet payment.** One transaction fewer for the lender. Rejected: the payment bypasses the outflow policy and the protected-mode delay, needs its own delivery checks and a sale-versus-payment guard, and leaves two payout rules.
2. **Credit the current holder's own vault as free balance, with no claim.** Rejected: it would create a vault for whoever happens to hold the NFT at payment time (a marketplace escrow) without their act, the money would stop following the position on a sale or transfer, and it is a second rule beside the claim. The claim reaches the same place (the holder's vault) but only when the holder asks.
3. **Claim-only for protected accounts only.** Rejected: two behaviours for one payment depending on a setting of the receiver, read by every payer path.
4. **Open the full lender claim on an active loan instead of a separate entry.** Rejected: that function closes the position (status, NFT, intent release). A narrow entry that shares the one pay-held function is safer than branching the terminal claim.
5. **Automatic claim by a keeper.** Rejected: a payout nobody asked for at that moment, to a wallet, is what the rule removes. Auto-lend's re-commit covers the case where the money should keep working.

## 8. Recommendation

Build sections 3.1 to 3.3 as one contract PR with the spec text, ABI exports, indexer handlers and tests, after #3618 / #3619 and #3626. Run an adversarial self-review before the first review round: this is a fund-moving change. The keeper pass for the re-commit and the app screens follow in their threads.

## 9. Open items for the builder to raise, not decide silently

- Any reader of "interest paid to the holder" whose result would change (3.4).
- Whether a rental's held payments should be claimable mid-rental exactly like an ERC-20 loan's (this design says yes; the prepay asset is the held asset).
- Whether `recommitHeldToIntent` should also be offered for an amount held from a periodic interest payment (this design says yes: the same ledger, the same step).
