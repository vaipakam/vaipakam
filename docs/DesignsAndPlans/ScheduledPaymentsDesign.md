# Scheduled payments from a protected account (design)

**Status:** owner approved the feature for design and build on 2026-11-19 (second review of the platform survey). Card #3776. Design first, no code yet. Reaches a chain by fresh deploy, because it adds to the vault code.
**Related:** `VaultOutflowPolicyDesign.md` (the one door, the two checks, protected mode held by the vault), `PayoutDestinationRuleDesign.md`, `StandingInstructionsDesign.md`, `RecoveryAddressClawbackDesign.md`, `DefaultPathsDesign.md` rule 7, `FeaturesOverExistingPartsDesign.md`.
**Base:** read on the batch branch of #3743 (`claude/project-thread-ijafuu`), and the design was checked against that code again after it was written: the vault's protected record and the code that writes it, the payout queue and its co-sign rule, the owner's withdrawal and the amount it may take, the vault's own check at its one door, and the outflow classes.

## 1. Why

A user who keeps money on the platform cannot pay anyone from it on a schedule. Rent, an allowance to a family member, a regular payment to a supplier: each needs the owner to be present, request a payout, wait the account's delay and release it, every time. So the money leaves the vault early and stops being lent.

Banks answer this with a payment the customer authorises once, within limits. The platform has the parts for the same thing, with stronger limits than a bank gives: an account in protected mode already has approved destinations that each waited a delay, signers who can stop a change, and a lock.

## 2. What the user gets

The owner of a protected account sets a **scheduled payment**: a fixed amount of one token, to one approved destination, every so many days, for a stated number of payments.

- Setting it waits the account's delay, once. After that each payment within its terms is paid when due, without a further wait.
- Each payment comes from the account's free balance. If the free balance is short on the day, that payment is not made. Nothing is taken from a loan, a reserve, a slot or a queued payout.
- The owner can lower it, pause it or end it at once. Any signer can end it at once. A lock ends every scheduled payment.
- Nobody can make a payment larger, earlier or more frequent than the owner set, and nobody but the named destination can receive it.

It is called a scheduled payment. It is never called a salary, payroll, a subscription, a standing order or a direct debit, and the app states no purpose for it.

## 3. The rule

1. **Protected accounts only, approved destinations only.** The owner decision of 2026-11-06 stands: without protected mode an owner-directed outflow pays only the owner's own wallet, and any other address needs protected mode's allowlist and its delay. A scheduled payment names a destination that is a finalized entry of the account's own allowlist, or the owner's own wallet.
2. **The terms are the owner's signed record, held by the vault.** The vault stores each scheduled payment in its protected record, written only on the owner's own call or signature, as every other protected setting is. The Diamond cannot write one, raise one or redirect one.
3. **Checked twice.** The Diamond checks that a payment is due and allowed, and that the amount is free. The vault then checks the same payment against its own record before anything moves, and records the payment itself. A fault in the Diamond cannot pay a destination the owner did not sign, more than the signed amount in a period, or a period twice. One thing the vault cannot check by itself is which part of its balance is free: that knowledge is the Diamond's (section 4.3 says what follows from it).
4. **A change that can pay more waits the delay. A change that can only pay less is immediate.** Setting one, raising the amount, shortening the interval, adding payments, an earlier start and a different destination or token all wait the delay. Lowering the amount, fewer payments, a pause and an end are immediate.
5. **One payment per period, never a catch-up.** A payment that was not made in its period lapses. A long pause or a long shortage is never followed by a burst.
6. **Anyone may send the transaction, and the caller receives nothing.** Every input is fixed by the record. Following `DefaultPathsDesign.md` rule 7, the app shows whether a runner is active for it on that network.

## 4. Design

### 4.1 The terms

| Term | Meaning | Bounds |
| --- | --- | --- |
| Destination | who is paid | a finalized entry of the account's allowlist, or the owner's wallet |
| Token | what is paid | an ERC-20 the vault holds; one token per scheduled payment |
| Amount | paid each period | above zero, in the token's own units; no price is read |
| Interval | the length of a period | 1 day to 366 days, in whole days |
| First payment | when the first period opens | not before the setting matures |
| Payments | how many periods | 1 to 60 |

- The periods are fixed when the setting is made: period *k* runs from `first + k × interval` for one interval. The last period ends at `first + payments × interval`, and the scheduled payment ends there.
- The most it can ever pay is `amount × payments`. The review shows that total, the date of the last period, and the account's delay.
- The app offers "every 7 days" and "every 30 days" and says exactly that. It does not say "weekly" or "monthly", because a period is a fixed number of days, not a calendar date.
- An account may hold at most five scheduled payments, waiting or live, the same number as its approved destinations.
- **A signer's signature at set-up.** Where the account has at least one signer, setting a scheduled payment, and every change that waits the delay, also needs one signer's signature, checked by the vault against its own signer list. Each payment then needs none. Today a queued payout needs a co-signature only where the account switched that requirement on or the destination has not verified itself. A scheduled payment is stricter on purpose: it is one approval for up to sixty payments that each skip the wait, so the account's guards see it once, whatever the destination. An account with no signer sets one on the owner's signature and the delay alone.

### 4.2 Setting, changing and ending

- **Set.** The owner signs the terms (a purpose of its own in the vault's protection code, with the per-key nonce and expiry every protected signature carries). The setting waits the account's delay, can be cancelled by the owner or any signer while it waits, and lapses if it is not finalized within one further delay after it matures, as an allowlist addition does.
- **Change upward** (rule 4): a new signed setting that waits the delay. Until it matures, the scheduled payment runs on its old terms.
- **Change downward** (lower amount, fewer payments), **pause**, **resume to the same or lower terms** and **end**: the owner, at once. Periods that pass during a pause lapse.
- **End by a signer:** any signer, at once. A signer cannot set, raise or resume one.
- **Lock.** A lock ends every scheduled payment, live or waiting, and an unlock does not bring them back. This is the rule the payout queue already follows: a payout queued before a lock is cancelled by it and is never revived by the unlock. After the unlock the owner sets the ones they still want, and each waits the delay again. Each scheduled payment records the account's lock count when it is set, and a higher count means it is ended, so the rule holds whether or not the platform has applied the lock yet.
- **A removed destination.** A removal ends that destination's scheduled payments at the moment it takes effect, and adding the same address again does not bring them back. Each scheduled payment records the generation of its destination's allowlist entry when it is set, as a queued payout does, and it is ended whenever the entry is inactive or carries another generation. So the rule does not depend on anyone running a check between the removal and the re-adding. A destination added again needs a new scheduled payment, with its own wait and its own signature.
- **Replacement, recovery, switch-off.** A replacement of the owner, a clawback to the recovery address, a claim by the recovery address and the switch-off of protected mode each end every scheduled payment. The new owner sets their own.

### 4.3 Running a payment

`runScheduledPayment(account, id)`, callable by anyone.

- Runs only when the platform and the token are not paused, the account is in protected mode and not locked, the scheduled payment is live and not paused, the current time is inside a period that has not been paid, and neither the owner nor the destination is flagged.
- It pays exactly the amount, from the account's free balance, through one outflow of a new class of its own. Free balance is exactly what the owner's own withdrawal could take at that moment, read from the same function: the owner's own holding in the vault (what they put in, and payments to them that stayed there), never more than the vault's tracked holding less every lien and every amount earmarked for a queued payout. A loan's collateral, a reserve, an offer's or a slot's committed capital and an earmarked payout are not in it. The payment is taken from the owner's own holding as a withdrawal is.
- **All or nothing.** If the free balance is short by any amount, the call is refused and nothing moves. A part payment would leave the destination guessing what it received.
- The vault checks, on its own record: the scheduled payment exists and is live, no lock has been taken since it was set, the period is open and unpaid, the amount and token are the record's, and the destination is the record's and is still the same finalized allowlist entry, by its generation, that the payment was set for (or the owner). Then it marks the period paid and counts the periods that lapsed since the last payment. Only then does the token move.
- **What the vault cannot check.** The vault knows its balance and not which part of it a loan holds: liens are the Diamond's record. So the free-balance test is the Diamond's alone, as it is for every withdrawal today. The worst a fault in the Diamond could do through this class is let a due payment be made from balance that was held for a loan: never to another destination, never more than the signed amount in a period, never more than the signed total. The design states this limit and does not claim more.
- **Where it lands.** The same place an approved payout to that destination lands today: the destination's wallet, or its own vault where the destination is itself a protected account.
- The delivery is measured. The event states the account, the id, the destination, the token, the amount, what the destination received, the period's number, the periods lapsed since the last payment, and the caller.
- A flagged destination's payment is not made and the period lapses with the others. Nothing is held for it.

`previewScheduledPayment(account, id)` returns whether a payment is due, the reason if it cannot run (locked, paused, short and by how much, flagged, ended), the period's number and end, and the time the next period opens. The keeper and the app read it.

### 4.4 What the caller can and cannot do

The caller chooses the moment inside the period, and nothing else. The destination has the plain reason to send the transaction itself, and may. A caller cannot change the amount, the token or the destination, cannot pay a period twice, and cannot pay a lapsed period.

### 4.5 Keeper, app, indexer

- **Keeper:** one new pass with its own arming flag, shipped unset. It reads the previews of live scheduled payments and submits the ones that are due and covered. It pays gas only. A row in `contracts/permissionless-steps.json`.
- **App,** in the protected account's page, a "Scheduled payments" panel: each one with its terms, the total it can still pay, the next period, whether the free balance covers the next payment, the runner's state on this network (running, not running, not known), and its history of payments and lapsed periods. Where no runner is active the panel says: "No automatic runner is active for scheduled payments here. A payment is made only if you, the destination or someone else sends it."
- **The review states:** the total, the last date, that each payment needs free balance on its day and that money in loans is not free, that a missed payment is not made up later, and that the platform does not know or check what the payment is for.
- **Alerts to the owner:** a payment made, a payment due in three days that the free balance does not cover, a period that lapsed and why, a setting about to mature, and the last payment approaching.
- **Indexer:** the set, changed, ended and paid events. The destination's page shows payments received, with the paying account.

## 5. What it cannot do

- It cannot pay from money that is in a loan. The owner keeps enough free, or the payment lapses.
- It does not promise the destination anything. The owner can end it at any moment, and the destination's page says so.
- It is not available to an account without protected mode.
- It is not paid during a pause, and the long-pause escape route does not run it. During a long pause the owner withdraws through that route as today.

## 6. Contract changes

| Where | Change |
| --- | --- |
| The vault's protected record | The scheduled payments (terms, state, the lock count at setting, the last period paid, the lapsed count), at the tail of the record. At most five. |
| The vault's protection code | A purpose and typehash for setting one (with the signer's signature where the account has a signer), and one for the immediate changes (lower, pause, resume, end) by the owner and the end by a signer. The delay, cancel and lapse rules of an allowlist addition. Lock, replacement, recovery and switch-off end them as 4.2 says. |
| The vault's one door | One new outflow class, appended, with its own vault-side check (4.3) and the write that marks the period paid. It passes no payout queue, because the setting already waited the delay. |
| The Diamond | A small facet of its own: `runScheduledPayment`, `previewScheduledPayment`, and the list view. It applies the pause and sanctions screens and the free-balance test, takes the amount from the owner's own holding, and builds the outflow. No storage of its own. |
| Pre-deploy checks | The storage-layout golden file rewritten, the permissionless-steps row, the facet in every registration place, the ABI exports and the keeper ABI sync. |

## 7. Tests

1. Set: waits the delay; cancelled by the owner or a signer while waiting; lapses if not finalized; refused for a destination that is not a finalized entry, for a sixth scheduled payment, and for terms outside the bounds; refused without a signer's signature where the account has a signer, for a verified destination too; accepted on the owner's signature alone where it has none.
2. Run: pays exactly the amount to the destination in an open period; refused before the first period, twice in one period, when short by one unit, while locked, while paused, and for a flagged owner or destination.
3. No catch-up: after three periods without a run, one run pays one amount and records two lapsed periods. The total paid never exceeds `amount × payments`.
4. Changes: an upward change waits the delay and the old terms run meanwhile; a downward change, a pause and an end are immediate; a signer can end and cannot set, raise or resume.
5. Lock: a lock ends every scheduled payment, live and waiting; none runs after the unlock; a lock the platform has not yet applied ends them all the same; one set after the unlock waits the delay.
6. Replacement, recovery and switch-off end every scheduled payment. A removed destination's scheduled payment cannot run, and it still cannot run after the same address is added again, whether or not anyone called a check in between.
7. Free balance: a payment cannot take a lien, a reserve, capital committed to an offer or a slot, or an earmarked payout, and it never exceeds what the owner's own withdrawal could take in the same block. The owner's own holding falls by the amount paid.
8. Two checks: a call that reaches the vault's door with a different destination, a larger amount, a different token, a paid period or a period that is not open is refused by the vault alone.
9. The caller receives nothing, and any address may run it.
10. A destination that is itself a protected account is paid into its vault.

## 8. Alternatives considered

1. **Leave it to the wallet.** The owner withdraws and pays from their wallet with any tool they like. This is today's state. The money leaves the vault early and stops being lent, and the account's protection no longer covers it.
2. **Offer it to every account, not only protected ones.** It would need a second list of approved destinations and a second delay for accounts that chose neither, which is protected mode under another name. It also reopens the owner decision that only the owner's own wallet is paid without protected mode. Not recommended now. An owner who wants scheduled payments switches protected mode on.
3. **Queue each payment as an ordinary payout that waits the delay.** No new vault code. But a payment due on the first of the period would arrive two to five days later every time, someone would have to request each one, and the owner would learn nothing from the wait that they did not approve at set-up.
4. **Set the whole total aside when it is set.** The destination would know the money is there. Rejected as the default: it holds back money that could be lent for the whole schedule. The owner can keep the amount free themselves, and the panel shows whether the next payment is covered.
5. **A continuous stream paid by the second.** It needs a running claim against the free balance at every moment, and it reads as pay for work. Rejected.
6. **Let the destination pull any amount up to a limit.** That gives the destination discretion over the amount. Rejected: every input is the owner's.
7. **Pay a lapsed period later.** Friendlier to the destination. Rejected: it turns a long pause or a long shortage into one large payment.
8. **Pause scheduled payments through a lock and resume them after the unlock.** Kinder to an owner who locked on a false alarm, who would not have to set them again. Rejected: a lock is the answer to a suspected stolen key, and a scheduled payment set by that key would start again by itself when the lock lifts. The payout queue already settles this the same way.
9. **Ask for a signer's signature only where a queued payout would need one.** That is where the account switched the requirement on, or the destination is unverified. Rejected: the account's own co-sign requirement is kept by the Diamond and not by the vault, so the vault could not enforce it alone, and one approval that covers up to sixty payments deserves the guards' eyes more than a single payout does.

## 9. Recommendation

Build it as sections 3 and 4: for protected accounts, to approved destinations, on the owner's signed terms held by the vault, checked twice, with no catch-up and no reward for the caller.

## 10. Open items for the builder to raise, not decide silently

1. Whether a matured setting needs its own finalizing call, as an allowlist addition does, or whether the first run finalizes it.
2. Whether the immediate changes share the allowlist-cancel nonce purpose or take one of their own.
3. The gas of one run, and whether the new code fits the size of the vault's protection code beside what is there.
4. Whether the destination's page needs a read of scheduled payments by destination, or the indexer serves it.
5. Whether the amount of this class can also be bounded on the vault's side once the vault-side lien checks planned for the outflow policy are built. Until then the limit in 4.3 is what the vault enforces.
