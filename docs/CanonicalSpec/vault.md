# Vaults (VLT)

A vault holds one owner's assets, and nothing leaves it except as these statements allow.
Figures are named by parameter id and are in the parameters table (`parameters.md`).
Sections 1 to 3 are entered. Sections 4 to 7 follow: deposits, the Ready balance and listing
escrows; protection; the protected account; recovery.

## Section 1: what may leave a vault

The platform's rules (PLT) apply throughout and are cited by id.

## 1.1 One way out, checked twice

### VLT-001 · rule

**Who:** the platform.
**When:** an asset is to leave a vault.

Every asset that leaves a vault leaves by one step of the platform.
That step states the movement's class, its reason and the position it belongs to.
The one exception is the loan for one transaction (VLT-043), which has its own check and record.

- **Tests owed:** the defaults for a rule, and a build check that no other step can move an asset.

### VLT-002 · never

**Who:** anyone.
**When:** at any time.

Nothing leaves a vault by any way other than the one of VLT-001 and the loan of VLT-043.
A vault has no other way out, and no caller but the platform can move an asset out of it.
That holds for the vault code in force
(VLT-220, VLT-222, VLT-223).

- **Against:** VLT-T01, VLT-T02, VLT-T03.
- **Watch:** every fall in a vault's balance of an asset has a record of VLT-003 or of VLT-043.
- **Tests owed:** the defaults for a never.

### VLT-003 · rule

**Who:** the platform.
**When:** a movement out of a vault is made, or an amount is released inside a vault.

One public record is made for each movement.
It states the owner, the vault, the asset and its token id, the amount, the payee, the class,
the reason and the position.
A release that moves nothing is recorded the same way, with nothing delivered outside the vault.
The loan for one transaction is recorded by its own record (VLT-043).

- **Tests owed:** the defaults for a rule, and one record counted on every path step that pays.

### VLT-004 · rule

**Who:** the platform, then the vault.
**When:** a movement out of a vault is made.

Two checks are made, and both must pass.
The platform checks what is intended against the state of the position.
The vault then checks the outcome against its own records.
Nothing the platform can change in the same transaction can alter what the vault checks against.

- **Tests owed:** the defaults for a rule, and for each class one test where only the first
  check is made to pass.

### VLT-005 · never

**Who:** the vault.
**When:** a repayment, a collection or a close-out that the platform's own rules allow is made.

A vault's own bound never refuses a step the platform's rules allow.
Each bound a vault holds is at or outside the platform's rule at every step of a loan's life.

- **Against:** VLT-T04.
- **Watch:** not watchable from chain data alone. A wrongly refused step leaves no record.
- **Tests owed:** the defaults for a never, on every step of the loan model.

### VLT-006 · refusal

**Who:** any caller.
**When:** a movement out of a vault is attempted while another action of the platform is running.

The movement is refused, and nothing moves.
A payee or a spender that is handed control during a movement cannot start a second one.
This is PLT-111 as a vault applies it.

- **Refused as:** an action is already running.
- **Tests owed:** the defaults for a refusal, with a payee that calls back.

## 1.2 How much may leave

### VLT-010 · rule

**Who:** the vault.
**When:** any movement is made.

A movement never exceeds the vault's tracked holding of that exact asset:
its kind, its contract and its token id.

- **Tests owed:** the defaults for a rule.

### VLT-011 · rule

**Who:** a vault's owner.
**When:** the free balance of an asset is read.

The free balance is what the owner deposited or adopted and what was credited to them,
less what they withdrew or spent,
and less everything that holds a balance, by the one list in the domain's outline.
It is never more than the vault's balance of the asset less everything held.

- **Tests owed:** the defaults for a rule, and the balance check on every path.

### VLT-012 · refusal

**Who:** a vault's owner.
**When:** a withdrawal asks for more than the free balance.

The withdrawal is refused, and nothing moves.

- **Refused as:** more than the free balance, with the amount asked and the amount free.
  What holds the rest is given by the read of VLT-013.
- **For the mistake:** VLT-M15, VLT-M18, VLT-M21 and VLT-M42, refuse.
- **Tests owed:** the defaults for a refusal.

### VLT-013 · rule

**Who:** anyone.
**When:** the balance of one asset in one vault is read.

A read states, for that asset, the free balance and each thing that holds the rest,
by the one list in the domain's outline.

- **Tests owed:** the defaults for a rule, and the read compared with the balance helper.

### VLT-014 · never

**Who:** a vault's owner.
**When:** at any time.

A balance that anything in the outline's list holds never leaves the vault by the owner's
withdrawal: a lien of any kind, an amount held for a position, a queued payout, the Ready
balance, or an open allowance's reservation.

- **Against:** VLT-T05.
- **Watch:** after every withdrawal, the vault's balance is at least the sum of everything held.
- **Tests owed:** the defaults for a never.

### VLT-015 · rule

**Who:** the vault.
**When:** a payment is made for the other side of a position.

The payment is drawn against the lien for that position and never exceeds it.
The lien falls by what was paid.

- **Tests owed:** the defaults for a rule.

### VLT-016 · rule

**Who:** the vault.
**When:** the most a loan can owe at a moment is worked out.

The most a loan can owe is the principal still owed,
plus the interest bound carried from before the principal last changed,
plus interest at the loan's highest rate over the real time since that change,
plus the largest late fee and the fees the signed terms allow.
Interest the lien has itself paid is subtracted once.
For a loan whose terms carry a full-term interest minimum, the interest since that change is
counted over the longer of the time elapsed and the whole signed term.

- **Tests owed:** the defaults for a rule, with worked examples at each edge and one after a
  part repayment.

### VLT-017 · never

**Who:** the platform.
**When:** collateral or its proceeds leave a collateral lien for the lender's side without the
owner's own authorization.

What leaves never exceeds the most the loan can owe at that moment (VLT-016).
Proceeds of a sale are counted as measured.
Collateral handed over in kind is valued once, by the vault's own reading of the price, at
the moment the split between the two sides is recorded (VLT-143).
A slice fixed then is not valued again when it is claimed or bought out, so a later rise in
the collateral's price never refuses it.

- **Against:** VLT-T06.
- **Watch:** for each close-out, what the lender's side received against the figure of VLT-016.
- **Tests owed:** the defaults for a never.

### VLT-018 · rule

**Who:** the vault.
**When:** collateral with no price is to be handed to the lender's side.

It is handed over only whole, and only at or after the lien's own date.

- **Tests owed:** the defaults for a rule.

### VLT-019 · rule

**Who:** the vault.
**When:** a lien is recorded, and when a payment is made from it to anyone but the other side.

Each lien carries a budget for each class of such payment:
the treasury and the reserve, the backstop, a non-party paid for running a step,
and the parts of that one loan's opening fee that go to an inviter, an integrator or an
invited user. Those parts are set once, when the lien is recorded.
Payments of a class are debited from its budget, and their sum never exceeds it.

- **Tests owed:** the defaults for a rule, with repeated payments against one lien.

### VLT-020 · rule

**Who:** a caller who pays a loan's debt at a liquidation.
**When:** that caller is paid collateral.

The caller is paid collateral only against the record of that repayment.
The collateral paid is worth no more than the repayment, by the vault's own reading of the
price, at the widest discount the settings allow [PRM-004].

- **Tests owed:** the defaults for a rule.

## 1.3 Who may be paid

### VLT-030 · rule

**Who:** a vault's owner.
**When:** the owner withdraws.

A withdrawal pays the owner's own wallet.
With protection on, it may instead pay a destination in force for that account (section 5).

- **Tests owed:** the defaults for a rule.

### VLT-031 · refusal

**Who:** a vault's owner.
**When:** a withdrawal names any address other than those of VLT-030.

The withdrawal is refused, and nothing moves.

- **Refused as:** not the owner's wallet, with both addresses.
- **For the mistake:** VLT-M16, refuse.
- **Tests owed:** the defaults for a refusal.

### VLT-032 · refusal

**Who:** anyone but the account's manager.
**When:** a withdrawal names that account.

The withdrawal is refused, and nothing moves.
The manager is the owner wallet, or the wallet that replaced it.

- **Refused as:** not the account's manager.
- **For the mistake:** VLT-M17, refuse.
- **Tests owed:** the defaults for a refusal, for each other kind of caller.

### VLT-033 · rule

**Who:** the vault.
**When:** a payment is made for a position.

The amount can reach only whoever holds that position's token when it is released.
The holder is read from the position token itself, which no lending step of the platform can
write.
Until it is released the amount rests in the vault recorded for that side of the position,
held for the position, or in the paying vault when it cannot be delivered there (VLT-072).
It is released to the holder's own vault, which must be a genuine vault (section 3) whose own
owner record names that holder.

- **Tests owed:** the defaults for a rule, with the first holder and with a later one.

### VLT-034 · rule

**Who:** anyone whose step pays a position on a live loan that they do not hold.
**When:** a repayment, a liquidation, a default or a periodic sale pays the other side.

The amount is held for the position, and its holder collects it.
No step creates a vault for a holder who did not ask for one.

- **Tests owed:** the defaults for a rule.

### VLT-035 · rule

**Who:** the holder of a position's token.
**When:** the holder's own step releases an amount: a cancel, a size-down, taking out surplus
collateral, taking back a reserve, or a collection.

The amount is released at once into the holder's vault as free balance.

- **Tests owed:** the defaults for a rule.

### VLT-037 · never

**Who:** the vault's owner, and the platform.
**When:** an amount is held for a position.

An amount held for a position leaves in one way only: to whoever holds that position's token
at that moment.
It becomes free balance in the same vault if that vault's owner is the holder, and is paid to
the holder's vault otherwise.
Neither the owner of the vault that holds it nor the platform can withdraw it, spend it or
send it anywhere else.

- **Against:** VLT-T07.
- **Watch:** every fall in an amount held for a position is matched by a payment to its holder.
- **Tests owed:** the defaults for a never.

### VLT-038 · rule

**Who:** the account an amount already belongs to.
**When:** an amount in that account's own vault, under a lien, is released to it.

The lien falls by exactly the amount, nothing moves, and the free balance rises by it.
The release is refused unless the vault then holds that amount free of every lien.

- **Tests owed:** the defaults for a rule.

### VLT-039 · rule

**Who:** the vault.
**When:** a payment is made to the treasury, the reserve or the backstop.

Each is paid only at the address fixed in the vault's own code (section 3).

- **Tests owed:** the defaults for a rule, and a deploy check of each address.

### VLT-040 · rule

**Who:** the vault.
**When:** any sale of an asset under a lien is made.

The vault makes the sale itself.
It takes no more than the lien from itself.
It measures what arrived, at itself or at the vault that receives it for the other side.
It refuses a sale that brings less than its own floor:
the price guard's value of what was sold, less the widest slippage the settings allow [PRM-003].

- **Tests owed:** the defaults for a rule, at the floor and one step below it.

### VLT-041 · rule

**Who:** a non-party paid for running a step, or an inviter.
**When:** the vault pays them at their wallet (PLT-003).

The vault cannot establish who a non-party is.
The payment is bounded by the lien's budget for that class (VLT-019), and by nothing else.

- **Tests owed:** the defaults for a rule.

### VLT-042 · never

**Who:** the platform.
**When:** at any time.

A vault pays the platform's own address for one purpose only:
a fee in the platform's own token, inside an authorization its owner gave.
No other asset and no other purpose reaches the platform's address from a vault.
The treasury is a separate address and is never the platform's own
(DPL owed: the treasury's address is never the platform's own).

- **Against:** VLT-T08.
- **Watch:** every arrival at the platform's address from a vault is in the platform's token.
- **Tests owed:** the defaults for a never.

### VLT-043 · rule

**Who:** the owner of an amount set aside to lend who allowed lending for one transaction.
**When:** such a loan is made from it.

Only the part that is not lent may go, and nothing else in the vault.
The vault measures its own balance before and after, and refuses any outcome in which it holds
less at the end than it started with plus its fee.
Nothing is booked as lent: the loan and its fee have a public record of their own.
The borrowing contract repays in that transaction, on an allowance it gave for that loan's total.
It is refused while the platform or the asset is paused, for a flagged caller, and for a caller
not current on the Terms. A lender who is flagged, locked or replaced is never drawn.

- **Tests owed:** the defaults for a rule, and a path where the amount is not returned.

### VLT-044 · rule

**Who:** a seller of a lender's position.
**When:** the seller's claim for interest earned before the sale is paid.

Only the seller that the sale's own terms record is paid, and no more than that claim.

- **Tests owed:** the defaults for a rule.

### VLT-045 · rule

**Who:** the platform.
**When:** a position has changed hands and its custody is moved.

The custody moves only to the vault of whoever holds that side's token now.
It stays under a lien there, and is not credited as free balance.

- **Tests owed:** the defaults for a rule.

## 1.4 The owner's own withdrawal

### VLT-050 · always possible

**Who:** a vault's owner.
**When:** the vault holds a free balance.

The owner can withdraw the free balance to their own wallet, without anyone else's help.

- **From:** a vault that is open.
- **By:** withdraw. While paused, the escape withdrawal.
- **Except under:** a pause, for no longer than the escape period (VLT-091);
  protection, for the account's own delay, and a lock for as long as it lasts (section 5);
  a flag on the wallet, for as long as it lasts (PLT-060);
  and an asset whose own code refuses the transfer.
  While a recovery address is in force, the escape withdrawal pays that address (VLT-091).
- **Tests owed:** the defaults for an always possible.

### VLT-051 · rule

**Who:** a party taking a step of their own.
**When:** the step is sent together with a withdrawal of what it credits.

The withdrawal takes the lesser of what that step credited to the party's vault and what is
withdrawable at that moment.
It gives no authority: every check of an ordinary withdrawal applies.
If the withdrawal is refused, the step still stands and the amount stays as free balance.

- **Tests owed:** the defaults for a rule, and a path where the withdrawal is refused.

### VLT-052 · rule

**Who:** a vault's owner.
**When:** a withdrawal is made.

A withdrawal names one asset, and only that asset leaves.
For a single NFT the amount is one, whatever amount is stated.

- **Tests owed:** the defaults for a rule.

### VLT-053 · rule

**Who:** a vault's owner.
**When:** a withdrawal the owner chose to make ends.

It ends in one of three ways, and says which: paid, queued, or refused.
It never succeeds while paying nothing and queuing nothing.

- **Tests owed:** the defaults for a rule, with a lock and with a full queue.

## 1.5 Allowances

### VLT-060 · never

**Who:** the vault.
**When:** an allowance is open.

An open allowance never exposes more than the one lien it was granted against.
While it is open the vault refuses every other movement (VLT-062), and anyone can close it
(VLT-064).

- **Against:** VLT-T09.
- **Watch:** no vault holds an open allowance at the end of any block. One that does is the
  sign of a fault in the step that opened it.
- **Tests owed:** the defaults for a never.

### VLT-061 · rule

**Who:** the vault.
**When:** a swap or a sale needs a spender to take an asset from the vault.

An allowance is granted only against a lien and never above it:
for a token an exact amount, and for a single NFT that one token.
Granting it reserves the amount and does not yet lower the lien.

- **Tests owed:** the defaults for a rule.

### VLT-062 · refusal

**Who:** any caller.
**When:** an allowance is open on a vault, and another movement or another allowance is asked.

It is refused, and nothing moves.
While the allowance is open the lien counts in full.

- **Refused as:** an allowance is open.
- **Tests owed:** the defaults for a refusal.

### VLT-063 · rule

**Who:** the vault.
**When:** an open allowance is closed.

The vault measures what the spender took from the allowance itself, not from its own balance:
for a token, the amount granted less the allowance that remains;
for a single NFT, the whole token if the vault no longer holds it, and nothing otherwise.
The lien falls by exactly that, and the allowance is cleared.
An allowance that was never used leaves the lien whole.

- **Tests owed:** the defaults for a rule, with tokens sent into the vault in between.

### VLT-064 · always possible

**Who:** anyone.
**When:** an allowance is open on a vault.

Anyone can close an open allowance.
Closing it can only reduce what the vault has exposed.

- **From:** an allowance that is open.
- **By:** close.
- **Except under:** nothing. Closing stays possible while the platform is paused.
- **Tests owed:** the defaults for an always possible.

### VLT-065 · never

**Who:** the vault.
**When:** at any time.

A vault never grants an approval over a whole collection.

- **Against:** VLT-T03, VLT-T10.
- **Watch:** no collection-wide approval is ever set with a vault as the owner.
- **Tests owed:** the defaults for a never.

### VLT-066 · rule

**Who:** the vault.
**When:** an outside marketplace or order book asks whether the vault signed an order.

The vault answers yes only for an order it recorded under its owner's commitment,
and only to the marketplace or order book that order names.
While the platform is paused every such order reads as unsigned.
A signature with no allowance moves nothing.

- **Tests owed:** the defaults for a rule, before, during and after a pause.

### VLT-067 · rule

**Who:** the vault.
**When:** an order is recorded for an asset under a lien.

The vault records an order only if its price is paid to this vault itself,
at or above the lowest price its owner committed,
never below the principal the lien records as owed,
and with its fees inside the lien's budgets.

- **Tests owed:** the defaults for a rule.

### VLT-068 · rule

**Who:** the platform.
**When:** a step opens an allowance.

The step that opens an allowance closes it before the step ends.
An allowance left open by a fault stays bounded by VLT-060 until someone closes it.

- **Tests owed:** the defaults for a rule, and a path where the closing is made to fail.

### Model: an allowance

**States:**

- None (start): no allowance has been open on the vault.
- Open: an allowance is granted and not yet closed.
- Closed (end): the last allowance was closed and cleared. Another may be granted.

**Steps:**

| From | Step | Who | Guarded by | To |
| --- | --- | --- | --- | --- |
| None | Grant | The platform, inside a swap or a sale | VLT-061, VLT-062 | Open |
| Closed | Grant | The platform, inside a swap or a sale | VLT-061, VLT-062 | Open |
| Open | Close | The step that opened it, or anyone | VLT-063, VLT-064, VLT-068 | Closed |

**Refusals out of state:**

| Step | Refused by |
| --- | --- |
| Grant | While one is open, VLT-062 |
| Close | With none open a close changes nothing. VLT-064 names its only state, an allowance that is open |

## 1.6 What arrives

### VLT-070 · rule

**Who:** the platform.
**When:** any movement is booked.

What is booked is what arrived at the payee, measured there, and never what was sent.

- **Tests owed:** the defaults for a rule, with a token that delivers less than it sends.

### VLT-071 · refusal

**Who:** a party who chose to start a step now.
**When:** any movement inside that step delivers less than it sent.

The whole step is refused, and nothing moves.
This holds at every hop: out of a vault, onward, and into the receiving vault.

- **Refused as:** less arrived than was sent, with both figures.
- **For the mistake:** VLT-M08, refuse.
- **Tests owed:** the defaults for a refusal, with the short delivery at each hop.

### VLT-072 · rule

**Who:** the paying vault.
**When:** a payment that must not fail cannot be delivered, because the token refuses it.

The amount is held in the paying vault for the position it is owed to.
That record is proof of payment, as a receipt in the receiving vault is.
A debt whose repayment is delivered or held in full is repaid, and the collateral returns
without waiting for the lender's side to collect.

- **Tests owed:** the defaults for a rule, with a token that blocks the payee.

### VLT-073 · refusal

**Who:** any caller.
**When:** a loan's opening payment, or the purchase of a lender's side, cannot be delivered.

The whole step is refused, and nothing moves. Such a payment is never held.

- **Refused as:** the payment could not be delivered.
- **Tests owed:** the defaults for a refusal.

## 1.7 What the owner must have committed

### VLT-080 · never

**Who:** the platform.
**When:** at any time.

By PLT-013 nothing leaves a vault unless its owner committed it. The vault adds its own check:
what was committed leaves only to a party the vault can establish itself,
within an amount the vault can bound itself.

- **Against:** VLT-T01, VLT-T11, VLT-T12.
- **Watch:** every movement's class and position name a commitment the vault holds.
- **Tests owed:** the defaults for a never.

### VLT-081 · never

**Who:** the platform.
**When:** an asset is taken from a wallet.

No step of the platform takes a token from a party's wallet on a standing approval.
A token is taken from a wallet only by the payer's own vault, under a permit the payer
signed for that purpose.
The permit is a signature under PLT-112: one amount, one purpose, used once, until its deadline.
An NFT is never taken from a wallet: its owner sends it. A contract may send a token (VLT-116).
A contract that borrows for one transaction is not a party's wallet: its return is VLT-043's.

- **Against:** VLT-T13. The replay of a permit is answered by PLT-112 (PLT-T14).
- **Watch:** no token leaves an account with the platform's address as the spender, outside the
  return of a recorded loan for one transaction.
- **Tests owed:** the defaults for a never.

### VLT-082 · rule

**Who:** the platform.
**When:** a vault's check passes.

What a vault does not check is stated here, and stays under the platform's own rules:
the rate and the term a loan is recorded at, and the interest due;
whether a priced loan may be liquidated now, and what it owes on the day;
who a budgeted non-party is;
and whether a payment is delivered or held.
The loss a fault in those could cause is bounded by the vault's floor (VLT-040),
the most a loan can owe (VLT-016) and the budgets (VLT-019).

- **Tests owed:** the defaults for a rule, one abuse case for each of the four.

## 1.8 Pause, lock and the escape route

### VLT-090 · refusal

**Who:** any caller.
**When:** the platform is paused, and a movement out of a vault is asked that is neither part
of a step PLT-041 keeps open nor the escape withdrawal of VLT-091.

The movement is refused, and nothing moves.

- **Refused as:** the platform is paused, with the time the escape route opens.
- **For the mistake:** VLT-M19, refuse.
- **Tests owed:** the defaults for a refusal, for every class.

### VLT-091 · rule

**Who:** a vault's owner.
**When:** an administrative pause has lasted, without a break, as long as the escape period
[PRM-001].

The owner may withdraw their own free assets from their own vault to their own wallet while
the pause lasts.
A payout the owner queued before the pause is released by the escape too.
While a recovery address is in force the escape pays that address, with protection on or off.
An automatic pause during the period does not start the count again.
The period that applies is the one in force when the pause began.
The time the escape route opens is readable from the start of the pause.

- **For the mistake:** VLT-M20, warn only. The rule is intended and must be findable.
- **Tests owed:** the defaults for a rule, and a path that changes the period during a pause.

### VLT-092 · never

**Who:** a vault's owner.
**When:** protection is on, a destination list is set, or the vault is locked.

A vault's protection never delays, redirects or blocks a payment a lien owes to another party.
A payment owed to a locked owner stays in the vault and does not stop the step that pays it.

- **Against:** VLT-T14.
- **Watch:** no repayment, default or liquidation is refused for the state of a party's protection.
- **Tests owed:** the defaults for a never, with each protection setting on each side.

## Outcome under each condition of the platform (section 1)

A cell names the statement that decides it. "Open" means the condition does not refuse the step.

| Movement | Paused | Asset paused | Caller flagged | Payee flagged | Screen cannot be read | Terms not current | No price, or a price not vouched for | Sequencer was down |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| The owner's withdrawal | VLT-090, then VLT-091 | Open (PLT-051) | PLT-060 | PLT-060 | PLT-065 | Open (PLT-071) | Needs no price | Open |
| The release of a queued payout | VLT-090, then VLT-091 | Open (PLT-051) | PLT-060 | PLT-060 | PLT-065 | Open (PLT-071) | Needs no price | Open |
| A release by the holder's own step | PLT-040 | Stated with the step, in its own domain | PLT-060 | The holder is the caller | PLT-065 | Open (PLT-071) | Stated with the step | Stated with the step |
| A collection | PLT-040 | Open (PLT-051) | PLT-060 | The holder is the caller | PLT-065 | Open (PLT-071) | Needs no price | Open |
| A payment for the other side, on a repayment | Open (PLT-041) | Open (PLT-051) | Open (PLT-061) | Held (PLT-062) | Never asks | Open (PLT-071) | Needs no price | Open (PLT-090) |
| A payment for the other side, at a close-out by force | PLT-040 | Open (PLT-051) | Refused for a liquidation it starts (PLT-060). Open with no reward for a step of PLT-063 | Held (PLT-062) | Never asks | Open (PLT-071) | Not vouched for: refused (PLT-080). No price: handed over whole (VLT-018) | PLT-090 |
| Any sale of an asset under a lien | PLT-040 | Open (PLT-051) | As its step | Held (PLT-062) | As its step | Open (PLT-071) | Not vouched for: refused (PLT-080). No price: nothing is sold (VLT-018) | Waits (PLT-090, PLT-080) |
| Principal to a borrower at an opening | PLT-040 | PLT-050 | PLT-060 | PLT-060 | PLT-065 | PLT-070 | Stated in the loan domain | Stated in the loan domain |
| The purchase of a lender's side | PLT-040 | PLT-050 | PLT-060 | Held (PLT-062) | PLT-065 | PLT-070 for the buyer | VLT-135 with no owner present. Otherwise stated in the exits domain | Stated in the exits domain |
| A non-party paid at a wallet, and an inviter | As its step | As its step | Not paid (PLT-063) | Not paid (PLT-060) | PLT-065 | Never asked (PLT-071) | As its step | As its step |
| A seller's claim for interest (VLT-044) | As the payment it is part of | Open (PLT-051) | As the payment | Held (PLT-062) | Never asks | Open (PLT-071) | Needs no price | Open |
| A side's custody moved to its new holder | PLT-040 | Open (PLT-051) | PLT-060 | PLT-060 | PLT-065 | Open (PLT-071) | Needs no price | Open |
| The loan for one transaction | VLT-043 | VLT-043 | VLT-043 | The lender is not drawn (VLT-043) | PLT-065 | VLT-043 | Needs no price | Open |

A payment to the treasury, the reserve or the backstop, a fee in the platform's token, and an
allowance take the outcome of the step they are part of. While the platform is paused an order
a vault recorded reads as unsigned (VLT-066).

## Section 2: the vault itself

The platform's rules (PLT) and section 1 apply throughout and are cited by id.
"Position" means one side of one loan or of one open offer. "Genuine vault" is defined in
section 3.
"Lien" alone means a position lien (VLT-120). A reserved commitment (VLT-141) is not a lien.

## 2.1 What a vault is

### VLT-100 · rule

**Who:** a wallet.
**When:** it uses the platform on a network.

A wallet has at most one vault on a network, and a vault has one owner.
A wallet's free balance on a network rests only in its own vault.
What is held for a position that wallet holds may rest in another vault until it is collected
or its custody is moved (VLT-033, VLT-045).
No vault holds another owner's free balance.

- **Tests owed:** the defaults for a rule.

### VLT-101 · rule

**Who:** the platform, a vault's owner and its signers, and the holder of a position's token.
**When:** a vault is asked to do something.

A vault answers to three voices, and none can speak for another.
The platform alone asks it to move an asset, and only within section 1.
The owner alone, with the signers the owner named, gives its authority: what the owner
commits, and the owner record of VLT-180.
The holder of a position's token alone gives the authority for that position's own lien
(VLT-131, VLT-185), and for nothing else in the vault. The platform can give none of it.
Every other caller a vault answers is named in its own statement, and none of them can
move an asset out except as section 7 states.

- **Tests owed:** the defaults for a rule, with each voice attempting each other's part.

### VLT-102 · rule

**Who:** anyone who sends an asset to a vault's address.
**When:** the asset is sent on a network other than the one that shows the address.

A vault's address is valid only on the network that shows it.
An asset sent to that address on another network is in no vault of this network.
Where the platform's own address differs there, no vault can exist at that address and no
step recovers the asset.
Where the same owner's vault can come to exist at that address there, the asset is untracked
in it from its creation (VLT-162).
(DPL owed: which of the two holds between each pair of networks.)

- **For the mistake:** VLT-M01, warn only. The platform has no say at that address there.
- **Tests owed:** the defaults for a rule.

### VLT-103 · rule

**Who:** the vault.
**When:** at any time.

A vault's records are kept in the vault and nowhere else:
its balances, its commitments, its liens, its receipts, the amounts it holds for a position,
and its owner record.
The platform keeps the record of each loan and each offer, and totals worked out from the
vaults' records: how much of each asset is pledged, and the market's lending figures.
Such a total is never used as a vault's balance.
Any figure the platform gives for a vault's balance is a read of the vault.

- **Tests owed:** the defaults for a rule, and a build check that no second copy is written.
  The check names the derived totals.

### Model: a vault

**States:**

- Not created (start): the wallet has no vault on this network yet.
- Open: the vault is created, and is not locked.
- Locked: the vault's owner record carries a lock.
- Recovered (end): the recovery address has recovered the vault, as section 7 states.

**Steps:**

| From | Step | Who | Guarded by | To |
| --- | --- | --- | --- | --- |
| Not created | Create | As section 3 states | VLT-200, VLT-034, PLT-060 | Open |
| Open | Lock | The owner or a signer | Section 5, VLT-184 | Locked |
| Locked | Unlock | As section 5 states | Section 5, VLT-184 | Open |
| Open | Recover | The recovery address | Section 7, which VLT-111 and VLT-112 name | Recovered |
| Locked | Recover | The recovery address | Section 7, which VLT-111 and VLT-112 name | Recovered |

**Refusals out of state:**

| Step | Refused by |
| --- | --- |
| Create | A vault that exists is returned and not created again, VLT-200. An address that cannot have a vault, a flagged wallet, or a pause, VLT-202 |
| Lock | Section 5 states them (VLT owed: the refusals of a lock). The platform's side is applied whole or the change is refused, VLT-184 |
| Unlock | Section 5 states them (VLT owed: the refusals of an unlock). As for a lock, VLT-184 |
| Recover | Section 7 states them (VLT owed: the refusals of a recovery). Until then a recovery is named only by VLT-111 and VLT-112 |

### Notes on the life of a vault

In every state after creation the vault keeps its records (VLT-103), receives payments for the
positions it backs (VLT-150), and pays what it owes the other side (VLT-092).
What a lock and a recovery stop is stated in sections 5 and 7.

## 2.2 The balance record

### VLT-110 · rule

**Who:** the vault.
**When:** it holds an asset.

For each asset, by its kind, its contract and its token id, the vault records the free
balance and each thing that holds a balance, by the one list in the domain's outline.
An asset that arrived outside the platform's steps is in none of those figures (VLT-162).

- **Tests owed:** the defaults for a rule, for each kind of asset.

### VLT-111 · rule

**Who:** the vault.
**When:** its free balance of an asset rises.

The free balance rises only in the ways of this statement and of VLT-115.
By an arrival, which the vault measures:
its own taking of a token from its owner's wallet under a permit (VLT-081);
its owner's own send of an NFT, or of a token booked inside the owner's own step (VLT-116);
the lender's part of the fee of a loan for one transaction (VLT-043);
a release from another genuine vault for a position its owner holds (VLT-154);
and from outside any position, a usage reward or a non-party's payment under PLT-003.
Section 7 adds the ways of a recovery.

- **Tests owed:** the defaults for a rule, one path for each way, and a path for every other
  arrival showing the free balance unchanged.

### VLT-112 · rule

**Who:** the vault.
**When:** its free balance of an asset falls.

The free balance falls in these ways only:
the owner's withdrawal (section 1.4);
a commitment the owner made, which moves the amount under a lien or a reserved commitment;
a payment the owner authorized from it, then or by a standing commitment: a repayment,
a purchase or a fee (VLT-151);
an amount moved into the held record when a token refuses its delivery (VLT-072);
and a move into the Ready balance or into a queued payout (sections 4 and 6).
Section 7 adds the ways of a recovery.

- **Tests owed:** the defaults for a rule, one path for each way.

### VLT-113 · never

**Who:** the platform.
**When:** at any time.

No step of the platform leaves a vault's records counting more of an asset than the vault
holds: the free balance and everything that holds a balance, added together.
A token whose balance falls by itself is the one way the records can come to exceed the
holding. VLT-011 then bounds what may leave
(LON owed: what such a fall does to a lien).

- **Against:** VLT-T16.
- **Watch:** for every vault and asset, the sum of the recorded figures against the balance.
  An asset counted under two kinds is caught by PLT-110's watch, not by this one.
- **Tests owed:** the defaults for a never, for each kind of asset, and a token that shrinks.

### VLT-114 · rule

**Who:** any surface or step of the platform.
**When:** it shows a vault's balance, or decides anything by it.

The figure used is the smaller of the vault's record and what the vault holds.
An asset that is untracked is not shown as a balance and counts for nothing until adopted:
not for a fee discount, and not for any other decision.

- **Tests owed:** the defaults for a rule, with an untracked amount beside a recorded one.

### VLT-115 · rule

**Who:** the vault.
**When:** its free balance of an asset rises with nothing arriving.

The free balance also rises when the vault frees, for its own owner, an amount it holds:
the release to its owner of an amount held for a position its owner holds (VLT-037);
the release of a lien or a reserved commitment to its own side (VLT-128, VLT-035, VLT-140);
a queued payout that is cancelled, or an amount that comes back out of the Ready balance
(sections 4 and 6);
and an adoption (VLT-170).
Nothing moves in any of these. A release to another vault's owner is VLT-154.
Each is refused unless the vault then holds that amount free of everything else (VLT-038).

- **Tests owed:** the defaults for a rule, one path for each way.

### VLT-116 · rule

**Who:** a vault's owner that is a contract and does not sign.
**When:** it sends a token to its own vault inside a step it starts and ends at the vault.

The owner may send a token to its own vault and have it booked with no permit.
The owner itself starts the step at the vault and ends it there, in one transaction.
Between that start and that end every other step on that vault is refused.
The vault counts what arrived between them, and adds exactly that to the free balance.
Anything that arrived before or after is untracked (VLT-162).
The owner is screened as the caller, as for any deposit.

- **Tests owed:** the defaults for a rule, with an arrival before the step, one after it, one
  inside it from a third party (booked, since only the owner's own code can bring it), and
  a payment for a position and a release from another vault attempted inside it (refused).

## 2.3 Liens

### VLT-120 · rule

**Who:** the vault.
**When:** it backs one side of a position.

A position lien is the vault's record of what it holds for one side of one position:
an open offer, a loan's collateral, or a rental's prepayment.
It names the position, the asset, its token id and the amount; this side's position token
and, once there is one, the other side's; and the budgets of VLT-019.
A collateral lien also records, from the terms its owner committed:
the principal still owed, the loan-to-value limit it opened under, what VLT-016 needs,
and the earliest time the collateral may be taken for a missed due date.

- **Tests owed:** the defaults for a rule, for each kind of position lien.

### VLT-121 · never

**Who:** the platform.
**When:** at any time.

A lien never opens on the platform's word alone. It opens in two ways only:
under the authorization, in that transaction, of the one entitled to its side (VLT-181);
or as a draw on a commitment that still stands, authorized earlier by the one then entitled:
an open offer, an amount set aside to lend, a due-date plan or a refinance request.
A lien grows in the same two ways, and by a draw on a loan reserve into that loan's own lien.

- **Against:** VLT-T17.
- **Watch:** every lien recorded names an authorization or a standing commitment of its vault.
- **Tests owed:** the defaults for a never, on every step that opens a lien or adds to one,
  with a keeper's match of two posted offers among them.

### VLT-122 · rule

**Who:** the vault.
**When:** a lien is recorded.

The vault records a lien only with its own side's position token named, and only after
checking that the token is held by the one entitled to that side under the commitment:
the vault's owner, or whoever holds the offer's token the commitment was made under.
This holds for the borrower's side as for the lender's.
A token that was issued to anyone else opens no lien in the vault.

- **Tests owed:** the defaults for a rule, with a token issued to a third party on each side.

### VLT-123 · rule

**Who:** the vault that funds a loan's principal.
**When:** the loan opens.

It pays only within its offer's lien or the amount its owner set aside to lend.
It pays only when a genuine vault holds a collateral lien for the same position, authorized by
that vault's owner, on the terms its own commitment states.
It reads the borrower's side's token from that lien, never from the platform, and pays the
vault of that token's holder the principal less the opening fee the terms allow.
The fee leaves under its budget (VLT-019).
Where that holder has no vault the opening is refused (VLT-073). None is created for it.

- **Tests owed:** the defaults for a rule, and a path where the collateral lien is missing,
  is on other terms, or is in a vault that is not genuine.

### VLT-124 · rule

**Who:** the vault of a lender who set an amount aside to lend.
**When:** a loan is filled from it with no owner present.

The fill moves principal only within the amount set aside and the slot's exposure cap, in
the asset set aside, before the slot's end date, for a loan whose collateral is under a lien
in a genuine vault, in the slot's collateral asset.
The collateral must cover the principal at the slot's own loan-to-value limit, by the vault's
own read of the price guard.
A fill never touches free balance outside the amount set aside.
It pays no one but the borrower's side and the payees of its budgets (VLT-019).

- **Tests owed:** the defaults for a rule, one path past each bound.

### VLT-125 · rule

**Who:** the vault that holds a loan's collateral.
**When:** the loan's opening payment is received.

A collateral lien is bound from the moment a receipt for the opening payment exists for the
same position, at the vault of whoever holds the lien's own side's token.
That holds whatever the platform's own record says.
The lien then records, as its other side, the token the paying vault's record names.
Until it is bound it binds nothing, and the one it answers to can release it (VLT-131).

- **Tests owed:** the defaults for a rule, and a path where the platform records a loan
  with no receipt.

### VLT-126 · never

**Who:** the platform.
**When:** at any time.

No one becomes the lender of a loan unless the principal was paid.
No borrower's collateral is bound unless the entitled borrower was paid, or the borrower's
earlier loan was paid off under the borrower's own commitment.
No one becomes the borrower of a loan that another party's collateral backs.

- **Against:** VLT-T18.
- **Watch:** every bound collateral lien has a receipt for its opening payment, for the same
  position, in the vault of its own side's holder at that time.
- **Tests owed:** the defaults for a never, one abuse case for each sentence.

### VLT-127 · rule

**Who:** the vault that holds a loan's collateral.
**When:** the principal still owed is read or changed.

The principal still owed is what was lent against the lien less what was repaid for the
borrower's side.
It falls only by the principal part of a repayment, read in the transaction that made the
repayment, and counted once.
No other payment lowers it: not an opening, and not the purchase of the lender's side.

- **Tests owed:** the defaults for a rule, with a receipt presented twice and a purchase
  presented as a repayment.

### VLT-128 · rule

**Who:** whoever holds a collateral lien's own side's token.
**When:** the lien, or part of it, is released to its own side.

Outside a close-out in kind (VLT-143), a collateral lien is released in full to its own
side only when its own figure for the principal still owed is nil.
It is released in part only as far as what stays still covers the principal owed at the
lien's own loan-to-value limit, by the vault's own read of the price guard.
Collateral with no price, or whose price the guard does not vouch for, returns only in full.
What is released goes to this side's holder, by VLT-035 and VLT-038.
Every way a collateral lien ends is listed in VLT-142.

- **Tests owed:** the defaults for a rule, with a part release at the edge of the limit.

### VLT-129 · rule

**Who:** the vault.
**When:** a borrower holds several loans, or several loans opened in one step.

Each loan has its own collateral lien, with its own principal still owed, highest rate, date
and bound.
A group of loans opened together holds no lien of its own.
A reserve kept for such a group is a reserved commitment (VLT-141), and a draw from it tops
up one named loan's own lien.

- **Tests owed:** the defaults for a rule, with several loans opened in one step.

### VLT-130 · never

**Who:** any lender's side, and the platform.
**When:** a loan is closed out.

What a close-out takes comes from that loan's own lien and from nothing else.
One lender's close-out never reaches collateral that stands behind another loan.

- **Against:** VLT-T19.
- **Watch:** every payment to a lender's side is debited from the lien of that same position.
- **Tests owed:** the defaults for a never, with two loans of one borrower in one asset.

### VLT-131 · rule

**Who:** whoever holds a position's token after a plain transfer.
**When:** the token of either side changes hands outside the platform's steps.

Nothing changes in any vault.
A lien answers to its own side's holder at each moment: its steps need that holder's
authorization, and what it releases goes to that holder's vault.
What is paid for the other side is held for the position and released to its holder (VLT-033),
so no payment needs the holder's vault to exist first.

- **Tests owed:** the defaults for a rule, with each side transferred in each state of a lien.

### VLT-132 · never

**Who:** the platform, and anyone who governs it.
**When:** a step of the platform replaces a position's token with a new one.

A lien's other side is replaced only by a record the leaving side made:
"this token is replaced by that one", accepted only from the replaced token's holder or that
holder's genuine vault.
A lien, and an amount held for the replaced token, follow that record and nothing else.
The platform's own record of who holds a side never replaces it.

- **Against:** VLT-T20.
- **Watch:** every change of a lien's other side has a replacement record from the leaving side.
- **Tests owed:** the defaults for a never, with a token the platform issued to itself.

### VLT-133 · rule

**Who:** the vault of an incoming lender, and the vault of the leaving holder.
**When:** a lender's side is bought.

The purchase and the replacement happen in one call, or neither happens.
The incoming vault pays the leaving holder's vault a purchase that names the incoming side's
token, which it has checked as its own side's token (VLT-122).
In the same call the leaving vault checks its own condition (VLT-134), records the receipt and
declares the replacement to exactly that token.
The incoming vault checks the replacement record before its own call returns.

- **Tests owed:** the defaults for a rule, with each half made to fail.

### VLT-134 · never

**Who:** the platform.
**When:** a lender's side is bought.

A lender's vault never gives up a position for less than the principal still out unless its
owner signed for that sale.
With the owner's authorization for the sale, the least price is the one it names.
With no owner present, the leaving vault needs a standing consent to be taken out at face
value, and a purchase of at least the principal the collateral lien still records as owed.

- **Against:** VLT-T21.
- **Watch:** every purchase with no signature for it is at least the principal still owed.
- **Tests owed:** the defaults for a never.

### VLT-135 · rule

**Who:** the vault of an incoming lender.
**When:** it buys a lender's side.

It buys only a side it can see: a collateral lien for that position, in a genuine vault,
that is bound and names the leaving token as its other side.
With no owner present it pays no more than the principal that lien still records as owed,
and only when the collateral covers that principal at the slot's own loan-to-value limit,
by the vault's own read of the price guard.

- **Tests owed:** the defaults for a rule, with a lien that is unbound, and one that names
  another token.

### VLT-136 · never

**Who:** the platform.
**When:** a lender's side changes hands by any route.

A sale or a takeover of the lender's side never makes collateral releasable.
The borrower's lien follows the replacement record, and its principal still owed is the same
before and after.

- **Against:** VLT-T22.
- **Watch:** the principal still owed is unchanged across every replacement record.
- **Tests owed:** the defaults for a never.

### VLT-137 · rule

**Who:** a borrower whose commitment names an earlier loan of theirs.
**When:** a new loan pays that loan off: a refinance, or a continuation with another lender.

The paying vault pays the new principal for the earlier loan's lender's side, as the earlier
loan's collateral lien names it.
The payment is recorded once, as a repayment of the earlier loan and as the opening of the
new one. No other payment has two purposes.
The borrower's own vault pays any rest the earlier loan is owed.
Any part of the new principal beyond it goes to the borrower's side's holder.
Once the earlier loan's principal still owed is nil, its lien is carried whole to the new
loan and bound to the new lender's side, with the new principal as its principal still owed.

- **Tests owed:** the defaults for a rule, with the new principal below, at and above the
  earlier debt.

### VLT-138 · never

**Who:** the platform.
**When:** a new loan pays an earlier one off.

A paying vault never pays a loan off without holding the carried lien when its call returns.
A payoff never hands the collateral to another party:
the new loan's borrower's side's token must be held by whoever holds the earlier loan's.
A lien is never carried while the earlier loan's principal still owed is above nil.

- **Against:** VLT-T23.
- **Watch:** at every carried lien, one holder for both borrower's side tokens.
- **Tests owed:** the defaults for a never, one abuse case for each sentence.

### VLT-139 · rule

**Who:** the vault of the lender of an NFT rental.
**When:** the rental opens.

Nothing is paid at the opening.
The lender's vault itself records the renter's right on the token, for whoever holds the
borrower's side's token as the renter's prepayment lien names it.
The prepayment lien is bound on that record of the right, in place of a receipt.
It has no principal. Each day's rent leaves it as a repayment to the lender's side.
How it ends is stated in VLT-148.

- **Tests owed:** the defaults for a rule, for each standard of NFT.

### VLT-140 · rule

**Who:** whoever a commitment answers to.
**When:** a commitment is lowered or cancelled.

Each of these commitments answers to the owner of the vault that holds it: an amount set
aside to lend, a loan reserve, a due-date plan, standing instructions, and a lender's standing
consent.
One made for a loan is drawn only while that owner holds that side's token of the loan.
Lowering or cancelling is that one's own step alone: an owner who sold a loan's token still
takes back its reserve.
It takes effect at once for what is not drawn, which is released to the vault's free balance.
What was drawn stays under its lien.

- **Tests owed:** the defaults for a rule, with a draw in the same block before and after,
  with a loan's token sold while its reserve and its plan stand (no draw, and the seller takes
  the reserve back), and with a lender's token sold while a consent stands (no draw).

### VLT-141 · rule

**Who:** the vault.
**When:** an amount is set aside to lend, or reserved for a loan.

A reserved commitment is an amount the vault holds back from the free balance with no lien
of its own: an amount set aside to lend, or a loan reserve.
It names the asset, the amount and what may draw on it.
It has no position token and no other side, and it is never bound.
It is drawn only as its commitment allows (VLT-121, VLT-124).
What is not drawn is released by the one it answers to (VLT-140).

- **Tests owed:** the defaults for a rule, for each kind of reserved commitment.

### VLT-142 · rule

**Who:** the vault that holds a loan's collateral.
**When:** a collateral lien ends.

A collateral lien ends in these ways only, with a recovery's (section 7) and those an exit
adds (EXT owed: the ends an exit adds):
its principal still owed is nil, and what it holds is released to its own side (VLT-128);
it is carried whole to a new loan, where it continues (VLT-137);
a close-out has taken all it holds within VLT-017, and nothing is left to release;
or the loan is closed out in kind: the lender's side's slice is handed over or bought out
(VLT-143, VLT-144), and what is left leaves as VLT-143 states.
A custody move is not an end (VLT-045). A rental's prepayment lien ends as VLT-148 states.

- **Tests owed:** the defaults for a rule, one path for each way, and a path showing that no
  step outside these, a recovery's and an exit's ends a lien.

### VLT-143 · rule

**Who:** the vault that holds a loan's collateral.
**When:** a sale of the collateral has failed, and the loan is closed out in kind.

The collateral stays in the vault under its lien. When the sale fails the vault records the
split the platform asks for: the lender's side's slice, the treasury's share, and the rest.
It values the slice once, at that moment, within VLT-017, and not again at a hand-over.
In kind, the slice leaves only to the lender's side's holder, or to the backstop in that
holder's place (VLT-144), and never more than the record states.
In that call the treasury's share leaves under the lien's budget for the treasury (VLT-019),
and the rest is released to the lien's own side's holder. (FEE owed: the share's size.)
What else a split lien may still do is stated in VLT-147.

- **Tests owed:** the defaults for a rule, with the price risen and fallen after the split,
  and the treasury's share paid once and within its budget.

### VLT-144 · rule

**Who:** the backstop, and the two vaults of a loan that is closed out in kind.
**When:** the backstop buys out the lender's side.

The buyout is not a purchase: it replaces no position token, and the loan ends with it.
The backstop's vault pays the lender's side's holder's vault what that side is due, in cash.
In the same call the vault that holds the collateral hands the lender's side's slice to the
backstop's vault: the slice as recorded and no more, and only against proof of that payment.
The lender's side's vault accepts that payment from the backstop's vault and from no one else.
How much cash is due is the platform's figure. No vault sets a floor or a ceiling on it.
The slice can reach only the backstop's vault, at the address fixed in the vault code.
The rest is released in the same call (VLT-143).

- **Tests owed:** the defaults for a rule, with the cash due below, at and above the principal
  the lien records, with a caller that is not the backstop's vault, and with a due of nil:
  no payment is made, and the slice does not reach the backstop.

### VLT-145 · rule

**Who:** the vault that holds a loan's collateral.
**When:** the loan is renewed in place with the same lender.

A renewal in place pays no principal and opens no loan.
It is a draw on the due-date plan of the borrower's side's holder (VLT-140), and only when,
in the same call, the lender's side's vault confirms its own consent to renew.
The interest owed and the renewal's fee leave that holder's vault as a repayment and a fee
(VLT-151): from the loan's payment reserve first, then from the free balance
(VLT owed: beyond the reserve, a protected account draws only from its Ready balance).
The lien stays and takes the renewal's terms in one step (date, highest rate, budgets), with
no highest rate above the plan's. What the loan could owe is carried over (VLT-016).

- **Tests owed:** the defaults for a rule, with a renewal at a higher rate followed by a
  close-out, a renewal above the plan's highest rate, one with no consent to renew, one whose
  plan was set by a former holder, and one the reserve and the free balance cannot pay for.

### VLT-146 · rule

**Who:** the vault that holds the collateral of a loan that ends by notice.
**When:** the lender's side gives notice.

Until notice is given the loan's due date is the end of its term. The lien's date is the due
date plus the loan's own grace.
A notice moves the due date earlier, by the notice period the lien's signed terms carry, and
never later. It is not withdrawn.
It is recorded on the lien by a call from the genuine vault of whoever holds the lender's
side's token at that moment, which the vault that holds the lien checks.
A continuation with another lender and a takeover clear it. A plain transfer does not.
The platform's own record of a notice is not one. (EXT owed: whether a sale clears it.)

- **Tests owed:** the defaults for a rule, with a notice the platform alone records, one from
  a former holder, and a takeover after a notice.

### VLT-147 · rule

**Who:** the vault that holds a split lien.
**When:** the slice has not yet been handed over or bought out.

A split lien still takes a repayment (VLT-127), and still pays a retried sale or an internal
match, in part or in full, within VLT-017. A part taken scales the slice and the treasury's
share by the share that remains of the collateral the split was recorded over; no price is
read. The rest is what the lien then holds beyond those two (FCL owed: rounding, lender first).
It returns to bound by a cure: collateral added under the borrower's side's authorization,
after which what it holds covers the principal owed at the lien's own loan-to-value limit,
by the vault's own price read. With no price, or one the guard does not vouch for, no cure.
Collateral added short of a cure joins the rest: the slice stands, and no price is read.

- **Tests owed:** the defaults for a rule, with a repayment to nil while split, a cure, a
  cure attempted with no price, a top-up short of a cure after a price rise and with no
  price (the slice unchanged, the step not refused), a retried sale, and a match in part at
  a fallen price and in full, and a match in part after a top-up (the top-up is not scaled),
  each with every share checked after it and the three summing to what the lien holds.

### VLT-148 · rule

**Who:** the vault that holds a rental's prepayment lien.
**When:** the rental ends.

A rental's prepayment lien ends in two ways only.
At a close in time: what is left is released to the borrower's side's holder, once the
lender's vault records that the renter's right has ended, and a receipt or a held record
(VLT-072) exists for the rent owed.
At a default: what is left of the rent leaves to the lender's side as a repayment, and the buffer
leaves to the treasury under the lien's budget for it (VLT-019). Nothing is released.
A late fee is taken from the buffer and never from the rent (RNT owed: its size and payee).

- **Tests owed:** the defaults for a rule, for each standard of NFT, with a close in time, a
  close inside the grace with a late fee, and a default.

### Model: a lien

**States:**

- None (start): no lien is recorded for the position in this vault.
- Recorded: the lien is recorded and not bound. An offer's lien stays here.
- Bound: the lien is bound to its other side, by a receipt or by the record of a rental right.
- Split: a sale failed, and the vault recorded the split for a close-out in kind.
- Released (end): the lien has ended, in one of the ways VLT-142 and VLT-148 list.

**Steps:**

| From | Step | Who | Guarded by | To |
| --- | --- | --- | --- | --- |
| None | Record | The authorization of the one entitled, or a draw on a standing commitment | VLT-121, VLT-122 | Recorded |
| Recorded | Draw an offer's lien into a loan | A match, a fill or an accept | VLT-121, VLT-123 | Recorded |
| Recorded | Bind | The receipt of the opening payment, or the lender vault's record of a rental right | VLT-125, VLT-126, VLT-139 | Bound |
| Recorded | Release | The one it answers to | VLT-125, VLT-131 | Released |
| Recorded | Move custody to the new holder's vault | The platform, for the new holder | VLT-045 | Recorded |
| Bound | Move custody to the new holder's vault | The platform, for the new holder | VLT-045 | Bound |
| Bound | Add to it | The borrower's side's authorization, a draw on a loan reserve, or a draw on a standing commitment | VLT-121 | Bound |
| Bound | Pay the other side | A repayment, or a close-out | VLT-015, VLT-017, VLT-127, VLT-130 | Bound |
| Bound | Pay the other side, leaving nothing | A close-out | VLT-015, VLT-017, VLT-127, VLT-130, VLT-142 | Released |
| Bound | Replace the other side | The leaving side's record | VLT-132, VLT-133, VLT-134, VLT-135, VLT-136 | Bound |
| Bound | Take fresh terms in place | Both sides' standing commitments | VLT-145 | Bound |
| Bound | Take a date from a notice | The vault of the lender's side's holder | VLT-146 | Bound |
| Bound | Release in part | Its own side's holder | VLT-128 | Bound |
| Bound | Carry to a new loan | The borrower's commitment | VLT-137, VLT-138 | Bound |
| Bound | Split for a close-out in kind | A failed sale | VLT-143 | Split |
| Split | Add to the rest | Collateral added short of a cure | VLT-147 | Split |
| Split | Cure | The borrower's side's added collateral | VLT-147 | Bound |
| Split | Pay the other side | A retried sale, or an internal match | VLT-017, VLT-147 | Split |
| Split | Pay the other side, leaving nothing | A retried sale, or an internal match | VLT-017, VLT-142, VLT-147 | Released |
| Split | Repay the last of the debt | A repayment | VLT-127, VLT-128 | Released |
| Split | Hand over the slice, or the backstop's buyout | The lender's side's holder, or the backstop | VLT-143, VLT-144 | Released |
| Bound | Release in full | Its own side's holder, or the step that pays the last of the debt | VLT-128, VLT-072 | Released |
| Bound | End a rental | A close in time, or a default | VLT-148 | Released |

**Refusals out of state:**

| Step | Refused by |
| --- | --- |
| Record | On the platform's word alone, VLT-121. With a position token issued to anyone else, VLT-122 |
| Draw an offer's lien into a loan | Beyond the offer's lien, or with no collateral lien for the same position, VLT-123 |
| Bind | A second binding, or one with no receipt for the opening payment, VLT-125, VLT-126 |
| Release | By anyone but the one the lien answers to, VLT-131 |
| Move custody to the new holder's vault | To any vault but that of the side's present holder, VLT-045 |
| Add to it | With none of the borrower's side's authorization, a draw on a loan reserve and a draw on a standing commitment, VLT-121 |
| Pay the other side | From a lien that is not bound or split, VLT-125. Beyond the lien, VLT-015. From another loan's lien, VLT-130 |
| Pay the other side, leaving nothing | As for any payment for the other side, and beyond the most the loan can owe, VLT-017 |
| Replace the other side | Without the leaving side's own record, VLT-132 |
| Take fresh terms in place | Without the lender's side's consent in the same call, or above the plan's highest rate, VLT-145 |
| Take a date from a notice | From anyone but the genuine vault of the lender's side's holder, or to a later date, VLT-146 |
| Release in part | Beyond what still covers the principal owed, or with no price the guard vouches for, VLT-128 |
| Carry to a new loan | While the earlier loan's principal still owed is above nil, or to another holder, VLT-138 |
| Split for a close-out in kind | With no failed sale, VLT-143 |
| Add to the rest | On a lien that is not split, VLT-147 |
| Cure | With no price the guard vouches for, or short of cover, VLT-147 |
| Repay the last of the debt | A release while principal is still owed, VLT-128 |
| Hand over the slice, or the backstop's buyout | With no split, above the recorded slice, or a buyout without proof of its payment, VLT-143, VLT-144 |
| Release in full | While principal is owed, outside a close-out in kind, VLT-128 |
| End a rental | At a close in time, before the renter's right has ended and the rent owed has a receipt or a held record, VLT-148 |

**Dimensions:**

| Dimension | Values | Named by |
| --- | --- | --- |
| The kind of lien | An open offer's, a loan's collateral, a rental's prepayment | VLT-120 |
| Who is present | The one entitled, in that transaction; or a standing commitment with no owner present | VLT-121 |
| The collateral's price | Vouched for by the guard; not vouched for; none | VLT-128, VLT-147 |

### Notes on the life of a lien

An offer's lien is never bound: it is recorded, drawn on and released.
A draw of an offer's lien into a loan lowers it by what was drawn.
A reserved commitment is not a lien and has no states of its own beyond that (VLT-141).
What a split lien may still do is VLT-147. It returns to bound only by a cure.
Collateral added short of a cure leaves the slice unchanged.
A payment from a split lien scales the slice and the treasury's share by the share of the
collateral that remains.
At a hand-over or a buyout the treasury's share is paid in the same call.
A custody move ends no lien: the lien continues in the other vault, in the same state (VLT-045).
A lien carried to a new loan is bound for the new loan.
Which steps replace each side is stated in the exits domain
(EXT owed: the steps that replace a side).
At a rental's default nothing is left to release.
Inside an owner's own send every other step on the vault is refused (VLT-116).

## 2.4 Receipts

### VLT-150 · rule

**Who:** a vault that is paid by another vault.
**When:** the payment arrives.

The paying vault names the position, the purpose and how much of the payment is principal.
The receiving vault checks that the caller is a genuine vault, or for a buyout the backstop's
fixed address (VLT-144, VLT-210), and measures what arrived.
It records a receipt under a number: the asset and the amount that arrived, the paying
vault, the position, the purpose and the principal part.
The principal part can never exceed what arrived.
A receipt is counted once.

- **Tests owed:** the defaults for a rule, with a caller that is not a genuine vault, the
  backstop's vault under each purpose, and a principal part above what arrived.

### VLT-151 · rule

**Who:** the paying vault.
**When:** it names the purpose of a payment.

The purpose is set by the paying vault from the record its payment draws on. The platform
cannot choose it, and the receiving vault records it as given. There are four:
an opening, drawn on an offer's lien or on an amount set aside to lend;
a repayment, paid for the borrower's side from that side's own lien, reserve, free balance
or collateral proceeds, or from another payer's own funds under that payer's authorization;
a purchase, paid by an incoming lender for the lender's side;
a buyout, paid by the backstop's vault for the lender's side (VLT-144).
Only a repayment lowers the principal still owed (VLT-127).

- **Tests owed:** the defaults for a rule, and a payment from each source under each purpose.

### VLT-152 · never

**Who:** the platform.
**When:** a vault is asked to accept that a payment was made.

A receipt in the receiving vault, or a record of an amount held in the paying vault
(VLT-072), is the only proof of payment a vault accepts.
The platform's own record that a payment was made is never proof.

- **Against:** VLT-T24.
- **Watch:** every fall in a principal still owed has a receipt or a held record for it.
- **Tests owed:** the defaults for a never.

### VLT-153 · rule

**Who:** the holder of the position a receipt is for.
**When:** a payment has been received for the position.

What arrived is held for the position until it is released to whoever holds its token:
in the same call where PLT-001 pays a party to the transaction at once, and on the holder's
own collection otherwise.
A receipt is counted when it is made. A side that changes hands later changes nothing in what
a lien has already counted.

- **Tests owed:** the defaults for a rule, with the side sold between payment and collection.

### VLT-154 · rule

**Who:** a vault that receives a release from another vault.
**When:** an amount held or freed for a position its owner holds is released to it.

A release to a holder is not a payment for the other side.
It has none of the four purposes, makes no receipt, and lowers no principal.
The releasing vault names the position and says that it is a release: a collection of an
amount held (VLT-037), what a cancel frees (VLT-035), or collateral
released to a holder who does not own that vault (VLT-128, VLT-143).
The receiving vault checks that the caller is a genuine vault, measures what arrived, and
adds exactly that to the free balance.

- **Tests owed:** the defaults for a rule, one path for each kind of release, and a release
  presented as a repayment.

## 2.5 What arrives uninvited

### VLT-160 · refusal

**Who:** any sender.
**When:** the network's own coin is sent to a vault.

The coin is refused, and stays with the sender. A vault never holds the network's own coin.

- **Refused as:** a vault does not accept the network's coin.
- **For the mistake:** VLT-M13, refuse.
- **Tests owed:** the defaults for a refusal.

### VLT-161 · refusal

**Who:** any sender other than the vault's owner, a genuine vault or the vault's own listing
escrow.
**When:** an NFT is sent to a vault by a send that asks the vault to accept it.

The NFT is refused, and stays with the sender.
Every send of a multi-unit NFT asks, so every such send from anyone else is refused.
The owner's own send is accepted (VLT-111).
So is a delivery inside a step of the platform: from a genuine vault, from the vault's own
listing escrow, or as the return of a rental.

- **Refused as:** the vault accepts an NFT only from its owner or inside a step.
- **For the mistake:** VLT-M12, refuse.
- **Tests owed:** the defaults for a refusal, for each standard and each kind of sender, and
  a lot coming back from a listing escrow that is torn down.

### VLT-162 · rule

**Who:** anyone who sends an asset straight to a vault.
**When:** a token arrives by a plain transfer, an NFT by a send that does not ask, a token is
issued to the vault's address, or a token's balance grows by itself.

What arrived is untracked: the vault's balance of the asset less everything it records.
It is in no figure of VLT-110, and no step moves it, counts it or shows it as a balance.
An asset that reached the address before the vault was created is untracked from creation.
It stays untracked until the vault's owner adopts it (VLT-170).
The one exception is a token its owner sends inside the owner's own step (VLT-116).

- **For the mistake:** VLT-M02 and VLT-M10, undo through adoption.
- **Tests owed:** the defaults for a rule, one path for each way of arriving.

### VLT-163 · rule

**Who:** anyone who sends an asset to a vault that is not theirs.
**When:** the asset arrives untracked.

Only that vault's owner can adopt it. No step returns it to the sender.

- **For the mistake:** VLT-M11, warn only. The vault cannot tell a gift from a mistake.
- **Tests owed:** the defaults for a rule.

## 2.6 Adoption and disowning

### VLT-170 · rule

**Who:** a vault's owner.
**When:** the vault holds an untracked amount of an asset.

The owner may adopt it. The owner names the address it came from and signs an acknowledgement
bound to the exact warning shown, to a number used once, and to a deadline.
The named source is screened. If it is clean the amount is added to the free balance.
Nothing moves. From then on it is free balance like any other: the owner may commit it, or
withdraw it with the account's own delay where protection is on.

- **Tests owed:** the defaults for a rule, for each kind of asset.

### VLT-171 · refusal

**Who:** a vault's owner.
**When:** an adoption asks for more than the untracked amount, comes after its deadline,
reuses a number, or names an NFT of a standard the asset does not answer as.

The adoption is refused, and nothing changes.

- **Refused as:** more than the untracked amount, with both figures; past its deadline;
  already used; or the wrong kind of asset (PLT-110), never as "nothing untracked".
- **For the mistake:** VLT-M38, refuse.
- **Tests owed:** the defaults for a refusal, one path for each reason.

### VLT-172 · refusal

**Who:** a vault's owner.
**When:** an adoption is asked while the network's sanctions screen is unset or cannot be read.

The adoption is refused, and nothing changes. This is a step that states its own outcome for
that condition (PLT-065).

- **Refused as:** the screen cannot be read.
- **For the mistake:** VLT-M40, refuse.
- **Tests owed:** the defaults for a refusal, with the screen unset, failing and reverting.

### VLT-173 · rule

**Who:** a vault's owner.
**When:** the source named in an adoption is flagged.

Nothing is credited. The source is recorded against the vault, and PLT-060 to PLT-065 apply
to the vault's owner as to a flagged wallet until that source is no longer flagged.
The ban is on the vault: it holds for the owner wallet in force, the first or a replacement.
It then lifts by itself, with no step from anyone.
The text the owner signs says so.

- **For the mistake:** VLT-M39, warn only, signed. The platform cannot tell a mistaken
  declaration from a true one.
- **Tests owed:** the defaults for a rule, and a path where the source is later cleared.

### VLT-174 · rule

**Who:** a vault's owner.
**When:** the untracked amount is a token's own growth of a balance the vault already records.

The owner adopts it as any other untracked amount, naming the token's own address as the
source. That address is screened like any other.
Until it is adopted the growth is not the owner's balance: it is untracked (VLT-162).

- **For the mistake:** VLT-M41, undo through adoption.
- **Tests owed:** the defaults for a rule, with a token whose balance grows.

### VLT-175 · rule

**Who:** the owner wallet in force for a vault, the first or a replacement.
**When:** it adopts or disowns.

Adoption and disowning belong to the owner wallet the vault's own record names at that
moment. A replacement owner wallet may adopt as the first one could.

- **Tests owed:** the defaults for a rule, with a replaced owner wallet.

### VLT-176 · rule

**Who:** a vault's owner.
**When:** the owner disowns an untracked asset.

Disowning is a public mark that the asset is not the owner's property.
It moves nothing, credits nothing and binds nothing: the owner may still adopt the asset later.
It asks for no source, no signature of acknowledgement and no screen, and stays open when
adoption is refused.

- **Tests owed:** the defaults for a rule, and an adoption after a disowning.

### Model: an untracked asset

**States:**

- Not in the vault (start): the asset has not arrived outside a step.
- Untracked: the asset is at the vault's address and in none of the vault's figures.
- Adopted (end): the owner adopted it, and it is free balance.

**Steps:**

| From | Step | Who | Guarded by | To |
| --- | --- | --- | --- | --- |
| Not in the vault | Arrive outside a step | Anyone | VLT-160, VLT-161, VLT-162 | Untracked |
| Untracked | Adopt, source clean | The owner | VLT-170, VLT-171, VLT-172, VLT-174, VLT-175 | Adopted |
| Untracked | Adopt, source flagged | The owner | VLT-173 | Untracked |
| Untracked | Disown | The owner | VLT-176 | Untracked |

**Refusals out of state:**

| Step | Refused by |
| --- | --- |
| Arrive outside a step | The network's own coin, VLT-160. An NFT by a send that asks, from anyone but the owner or a step, VLT-161 |
| Adopt, source clean | More than the untracked amount, late, reused, or the wrong kind, VLT-171. The screen unset or unreadable, VLT-172. By anyone but the owner wallet in force, VLT-175 |
| Adopt, source flagged | As for a clean source, VLT-171, VLT-172, VLT-175 |
| Disown | By anyone but the owner wallet in force, VLT-175 |

### Notes on the life of an untracked asset

Disowning is a mark, not a state.
An adoption that names a flagged source credits nothing and bans the vault (VLT-173).
An asset that leaves a vault and later returns outside a step is untracked again.

## 2.7 The owner record and signed authority

### VLT-180 · rule

**Who:** a vault's owner, and its signers.
**When:** at any time.

Each vault alone records its owner wallet, its signers, its delay, its lock, its payout
destinations and a pending replacement of its owner.
The platform reads that record and cannot write it.
A vault's address follows from its first owner, so a look-alike contract with a forged owner
record is not a genuine vault and is never paid as one.

- **Tests owed:** the defaults for a rule, and a build check that no platform step writes it.

### VLT-181 · rule

**Who:** a vault's owner, a signer where the rule for a change names one, or a position's
holder (VLT-185).
**When:** an authorization is given.

An authorization takes one of these forms and no other:
the right key's own call to the vault;
that key's signature, from an ordinary wallet or a contract wallet, under PLT-112;
a permit the owner signed for the vault to take a token from the wallet (VLT-081);
or, for an NFT, the owner's own send of it to the vault with the commitment named.
A signature for one action is never accepted for another: a request, an approval, a
cancellation and a removal do not stand in for each other or for a later round.

- **Tests owed:** the defaults for a rule, with each form used for each other's action.

### VLT-182 · rule

**Who:** a vault's owner.
**When:** the owner sends an NFT to the vault with a commitment named.

The vault holds that commitment as authorized only when the asset's own contract reports the
owner as both the sender and the one who made the send, and only for the token and amount
that arrived.
The step that follows uses it once. It lapses at the commitment's own deadline, or when the
owner takes the token back.
A send with nothing named adds the token to the free balance.
A send by anyone else authorizes nothing, whatever it names.

- **Tests owed:** the defaults for a rule, with a send by an approved third party.

### VLT-183 · rule

**Who:** the key that gave a signature.
**When:** the signature has not been used.

That key may void it. A voided signature is never accepted.
Voiding stays possible while the platform is paused.

- **For the mistake:** VLT-M32, undo.
- **Tests owed:** the defaults for a rule, with the void and the use in one block, each first.

### VLT-184 · rule

**Who:** a vault's owner, or its signers.
**When:** a change to the owner record has an effect on the platform's side:
switching protection on or off, raising the delay, a lock, an unlock, replacing the owner.

The platform's side of the change is applied in the same transaction, or the change is
refused. A change never reports success with half of it applied.
Each lock cancels the work waiting at that lock. A later unlock does not bring it back, and
an old lock applied late cancels nothing requested after that unlock.
Anyone may ask the platform to bring its side in line with a vault's record.

- **Tests owed:** the defaults for a rule, with the platform's side made to fail, and with
  too little gas.

### VLT-185 · rule

**Who:** the holder of a position's token who does not own the vault that holds its lien.
**When:** the holder authorizes a step of that lien.

The right key is the holder's, read from the position's token at that moment and never from
the vault's owner record.
The holder authorizes by its own call, by its signature under PLT-112, or through its own
genuine vault acting under one of those.
The authorization reaches that position's lien and what is held for the position, and
nothing else in the vault.
The vault's owner, once no longer the holder, can authorize nothing for that lien.

- **Tests owed:** the defaults for a rule, with the vault's owner, the first holder and a
  later holder each attempting each step of the lien.

## Outcome under each condition of the platform (section 2)

A cell names the statement that decides it. "Open" means the condition does not refuse the step.

| Step | Paused | Asset paused | Caller flagged | Screen cannot be read | Terms not current | No price, or a price not vouched for | Sequencer was down |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Recording a lien for a new commitment | PLT-040 | PLT-050 | PLT-060 | PLT-065 | PLT-070 | Stated with the step | Stated with the step |
| Lowering or cancelling a commitment | PLT-040 | Open (PLT-051) | PLT-060 where value is released | PLT-065 | Open (PLT-071) | Needs no price | Open |
| A fill from an amount set aside to lend | PLT-040 | PLT-050 | PLT-060, either side | PLT-065 | PLT-072 | Either case: no fill (VLT-124) | Stated in the loan domain |
| Releasing collateral in part | PLT-040 | Stated with the step | PLT-060 | PLT-065 | Open (PLT-071) | Either case: only in full (VLT-128) | Stated with the step |
| A plain transfer of a position's token | Stated in the position domain | Open | PLT-060 | PLT-065 | Open (PLT-071) | Needs no price | Open |
| An adoption | PLT-040 | Open (PLT-051) | PLT-060 | VLT-172 | Open (PLT-071) | Needs no price | Open |
| A disowning | PLT-040 | Open | Open (VLT-176) | Open (VLT-176) | Open (PLT-071) | Needs no price | Open |
| A change to the owner record | Stated in section 5 | Open | Stated in section 5 | Stated in section 5 | Open (PLT-071) | Needs no price | Open |
| Voiding a signature | Open (VLT-183) | Open | Open | Open | Open (PLT-071) | Needs no price | Open |
| A renewal in place, and a notice | Stated in the loan domain | Stated in the loan domain | Stated in the loan domain | Stated in the loan domain | PLT-072 | VLT-145 needs no price | Stated in the loan domain |
| A close-out in kind, and the backstop's buyout | PLT-040 | Stated in the close-out domain | PLT-061 to PLT-063 | PLT-065 | Open (PLT-071) | The slice is valued once (VLT-143) | Stated in the close-out domain |

The purchase of a lender's side has its row in section 1's table, and is not repeated here.

## Section 3: creation and code

The platform's rules (PLT) and sections 1 and 2 apply throughout and are cited by id.
This section states what a vault itself holds to. Who governs, and with what delay, is owed by
the authority rules and is cited in the owed form.

## 3.1 Creating a vault

### VLT-200 · rule

**Who:** anyone.
**When:** a wallet has no vault on a network.

Anyone may create the vault of any wallet, by the step whose only purpose is that.
Creating it gives the creator no right over it, and moves nothing.
A wallet has no vault until one is created for it, and it is created once. A wallet's vault
is the one whose owner record names it (VLT-180), and asking again returns that vault.
No other step creates a vault for anyone but its own caller: a payment never creates one
for the party it pays (VLT-034), and a payer's first payment creates only the payer's own.
Only the wallet created for is screened: a flagged creator may create a clean wallet's vault.

- **For the mistake:** VLT-M03, bound. The harm is the network fee the creator paid.
- **Tests owed:** the defaults for a rule, with a creator who is not the wallet, and with a
  flagged creator.

### VLT-201 · rule

**Who:** anyone.
**When:** a vault's address is read.

A vault's address follows from its first owner wallet and from the platform on that network.
It can be worked out before the vault exists, and it never changes.
Replacing the owner wallet changes who controls the vault, and not which vault it is:
the positions it backs and the payments owed to it stay with it.

- **Tests owed:** the defaults for a rule, with an address read before creation and after a
  replacement.

### VLT-202 · refusal

**Who:** anyone.
**When:** creation is asked for an address that cannot have a vault, for a flagged wallet, or
while the platform is paused.

No vault is created for the zero address, for a vault, or for one of the platform's own
addresses, except the backstop's own vault as a lender (VLT-212).
No vault is created for a flagged wallet (PLT-060).
In a pause creation is refused (PLT-040), except a payer's own vault created inside a
repayment or a collateral top-up that PLT-041 keeps open.
Creation stays open while the sanctions screen cannot be read: it opens no position and
takes no commitment (PLT-065).

- **Refused as:** the address cannot have a vault; the wallet is flagged, naming it; or the
  platform is paused.
- **Tests owed:** the defaults for a refusal, one path for each reason, a borrower's first
  repayment in a pause, and the backstop's own vault created and used as a lender's.

## 3.2 A genuine vault

### VLT-210 · rule

**Who:** a vault.
**When:** it has to know whether another contract is a vault of the platform.

Every vault is the same shell, made by the platform's one creation step, and it runs the code
the version registry gives it (VLT-220).
A vault tells a genuine vault by two things together: it is that shell, and it sits at the
address that its own recorded first owner derives (VLT-201).
The shell alone is not enough: anyone can deploy a copy of it with any owner record.
A vault does not ask the platform, and nothing the platform can change inside a transaction
changes the answer.

- **Tests owed:** the defaults for a rule, with a copy of the shell made outside the creation
  step, carrying a forged owner record, and a contract that copies a vault's records.

### VLT-211 · rule

**Who:** anyone.
**When:** a vault is genuine.

Anyone can have a genuine vault, an attacker included.
Being genuine gives a vault no right over any other vault.
What it can be paid is bounded by the lien it is paid from (VLT-015) and by the position it
is paid for (VLT-033).

- **Tests owed:** the defaults for a rule, with a genuine vault that holds no position.

### VLT-212 · rule

**Who:** a vault.
**When:** it deals with the backstop, the treasury or the reserve.

The backstop's vault and the treasury's vault are built to a vault's rules and are not
genuine vaults. A vault knows them and the reserve only by the addresses fixed in its own
code (VLT-240).
From the backstop's fixed address a vault accepts only the buyout of VLT-144. To it a vault
hands only that buyout's slice, and that slice is what a lien's budget for the backstop pays.
As a lender the backstop acts through an ordinary vault that it owns: a genuine vault.
To the treasury's vault and to the reserve a vault pays only under a lien's budget
(VLT-019) or a fee authorization (VLT-151). (FEE owed: the treasury vault's own rules.)

- **Tests owed:** the defaults for a rule, with each fixed address attempting each payment a
  genuine vault may make, the backstop lending and collecting through its ordinary vault, a
  fee paid from free balance, and a rental's buffer paid at a default (VLT-148).

## 3.3 Which code a vault runs

### VLT-220 · rule

**Who:** a vault.
**When:** it runs.

A vault runs the version its owner pinned, as long as that version is not revoked.
Otherwise it runs the current version.
Both are read from one version registry, which no part of the platform can change.
At the registry the platform can do four things only: pass on an owner's signed pin change,
raise a vault's pin delay as far as the longest protected pin delay [PRM-006], void what is
waiting for a vault (VLT-233), and apply the change that retires a price guard (VLT-229).
The registry reads one thing of the platform's: which price guard is the platform's
(PRC-300).

- **Tests owed:** the defaults for a rule, with a pinned vault and an unpinned one across a
  change of the current version, and the platform attempting each other change.

### VLT-221 · rule

**Who:** any caller.
**When:** a step needs a vault.

No step ever waits on a vault's version.
There is no version a vault must reach first and no upgrade a vault's owner must send:
a change of the current version reaches every vault that is not pinned at once.

- **Tests owed:** the defaults for a rule, with a close-out on a vault created under an
  earlier version.

### VLT-222 · authority

**Who:** governance.
**When:** a version of the vault code is registered, made current or revoked.

Only governance may register a version, propose making one current, or propose revoking one.
A proposal to revoke the current version names its successor (VLT-228).
One change waits at a time: a second proposal is refused while one waits.
Once a change has waited (VLT-223), anyone may apply it.
The one exception is the change that retires a price guard, which only the step that replaces
the guard applies (VLT-229).
Governance or the pauser may cancel a change that is waiting.
The pauser may never propose one or hurry one.

- **Held by:** governance, with the pauser's cancel.
- **Changed by:** governance, by its own rules (AUT owed: who governs the version registry).
- **Tests owed:** the defaults for an authority, with a second proposal while one waits, and
  a revoke of the current version proposed with no successor.

### VLT-223 · rule

**Who:** governance.
**When:** a version is to be made current, or revoked.

Each waits at least the vault code wait [PRM-002] between its proposal and its execution.
The registry enforces the wait itself, whatever delay governance otherwise runs under.
The wait is fixed, and always longer than the longest delay a protected account may choose
for its payouts [PRM-005]: outside a pause, a payout queued when a change is proposed is
released before the change lands.
Raising that longest delay needs a new registry with a longer wait. A vault is tied to its
registry for good (VLT-201), so for a vault that exists it is never raised.
Proposing, applying and cancelling a change stay open while the platform is paused.

- **Tests owed:** the defaults for a rule, with an execution one second early, and a change
  proposed and applied through a pause.

### VLT-224 · rule

**Who:** the pauser.
**When:** the platform is paused, and only then.

The pauser may revoke a version at once, in a pause of either kind.
When it revokes the current version it names the version that becomes current in the same
call: one registered at least the vault code wait [PRM-002] earlier, not revoked, and naming
the platform's price guard and no other (VLT-228).
So vaults then run only code that was visible for the full wait.
A change that is waiting and names a version the pauser revokes ends with that revoke. So
does one waiting to make current the version the pauser names as successor.
The pauser cannot register code, and cannot make current any code governance did not register.

- **Tests owed:** the defaults for a rule, with a revoke outside a pause, one that names no
  successor for the current version, one onto code registered too recently, one onto a
  version that names another price guard, a waiting change ended by a revoke of the version
  it names, and a waiting change to make current the version the pauser names.

### VLT-225 · never

**Who:** governance, the pauser, a vault's owner, and anyone else.
**When:** at any time.

No vault ever runs code that was not visible in the version registry for the full vault code
wait [PRM-002] first.
That holds by the ordinary route, by the pauser's route and by an owner's pin alike (VLT-231).
The one exception is the first version a fresh deployment starts with, which is current
before any vault exists (DPL owed: the first version and its launch check).

- **Against:** VLT-T02.
- **Watch:** every version a vault runs was registered at least the wait before it first ran.
- **Tests owed:** the defaults for a never, by each route.

### VLT-226 · rule

**Who:** governance.
**When:** a version is registered.

A version that does not report itself as vault code cannot be registered.
Every version keeps every record of the versions before it, unchanged and readable:
a new version may add to a vault's records and never moves or drops one.
A revoked version is never restored.
No more than the most live versions [PRM-008] are registered and not revoked at once.
A further one is refused, so the change that retires a price guard walks a bounded number
(VLT-229).

- **Tests owed:** the defaults for a rule, with code that is not a vault, a version that
  moves a record, and one registered above the most live versions.

### VLT-227 · rule

**Who:** governance.
**When:** a rule of the platform is to change while earlier versions stay registered.

Every version that is not revoked serves every step the platform's rules allow on the
positions a vault backs: a repayment, a collection, a close-out and every other.
A pinned vault keeps its version's bounds and fixed figures (VLT-230). So a version that
could not serve a step under the new rule is revoked no later than the rule changes: before
it, or in the transaction that changes it (VLT-229).
An owner's pin is never a way to refuse the other side (VLT-005).
(AUT owed: a change to the platform is tested against every registered version first.)

- **Tests owed:** the defaults for a rule, with every step of every lifecycle path run on a
  vault pinned to each registered version.

### VLT-228 · never

**Who:** governance, the pauser, a vault's owner, and anyone else.
**When:** at any time.

No vault ever runs a version that names another price guard than the platform's.
A version names one price guard and no earlier one (VLT-240).
The registry holds this on each of the four routes by which a vault comes to run a version.
It refuses such a version as an owner's pin (VLT-231), as the successor a revoke names, by
governance (VLT-222) or by the pauser (VLT-224), and as the version an ordinary change makes
current (VLT-222).
It refuses when the change is asked for and again when it is applied.
Only the change that retires a price guard makes such a version current (VLT-229).

- **Against:** VLT-T30.
- **Watch:** the price guard every version a vault runs names is the platform's.
- **Tests owed:** the defaults for a never, by each of the four routes, at the ask and at the
  apply, before and after a replacement of the price guard.

### VLT-229 · rule

**Who:** governance, and the step that replaces the platform's price guard.
**When:** the platform's price guard is replaced.

One change of the vault code retires a price guard. It names the replacement it belongs to,
and is refused with none pending. It makes a named version current and, in the same call,
revokes every version that is not revoked and names another price guard than the named
version's. Nothing is revoked before. Governance proposes it, and it waits like any change
(VLT-223). Only the step that replaces the platform's price guard applies it, in that step's
own transaction, as proposed. It lapses or is cancelled with its replacement.
Cancelled alone (VLT-222), or ended by the pauser's revoke (VLT-224), it leaves the
replacement pending, and the step is refused until a new change has waited.

- **Tests owed:** the defaults for a rule, with the change proposed with no replacement
  pending, applied by anyone but the step, the step run after the replacement lapsed, the
  step run after the change alone was cancelled or was ended by the pauser's revoke, and a
  version naming the old guard still live after the step.

### Model: a version of the vault code

**States:**

- Not registered (start): the registry does not know the version.
- Registered: the version is registered, is not current, and no change of it waits.
- Registered, to be made current: a proposal to make it current waits.
- Registered, to be revoked: a proposal to revoke it waits.
- Current: new vaults and vaults with no pin run the version.
- Current, to be revoked: a proposal to revoke it, naming its successor, waits.
- Revoked (end): no vault runs the version, and it is never restored.

**Steps:**

| From | Step | Who | Guarded by | To |
| --- | --- | --- | --- | --- |
| Not registered | Register | Governance | VLT-222, VLT-226 | Registered |
| Not registered | Start as the first version of a fresh deployment | The deployment | VLT-225 | Current |
| Registered | Propose making it current | Governance | VLT-222 | Registered, to be made current |
| Registered, to be made current | Apply, after the wait | Anyone | VLT-223, VLT-225, VLT-228 | Current |
| Current | Another version is made current | Governance's proposal, applied by anyone after the wait | VLT-223 | Registered |
| Registered | Propose a revoke | Governance | VLT-222 | Registered, to be revoked |
| Registered | Propose the change that retires a price guard, naming this version | Governance | VLT-222, VLT-229 | Registered, to be made current |
| Registered, to be made current | Apply the change that retires a price guard | The step that replaces the price guard | VLT-229 | Current |
| Current | Revoked by the change that retires a price guard | The step that replaces the price guard | VLT-229 | Revoked |
| Registered | Revoked by the change that retires a price guard | The step that replaces the price guard | VLT-229 | Revoked |
| Current | Propose a revoke, naming its successor | Governance | VLT-222, VLT-228 | Current, to be revoked |
| Registered, to be revoked | Apply the revoke, after the wait | Anyone | VLT-223 | Revoked |
| Current, to be revoked | Apply the revoke, after the wait | Anyone | VLT-223 | Revoked |
| Registered | Revoke at once, in a pause | The pauser | VLT-224, VLT-225 | Revoked |
| Current | Revoke at once, in a pause, naming its successor | The pauser | VLT-224, VLT-225 | Revoked |
| Registered, to be made current | Revoke at once, in a pause | The pauser | VLT-224 | Revoked |
| Registered, to be revoked | Revoke at once, in a pause | The pauser | VLT-224 | Revoked |
| Current, to be revoked | Revoke at once, in a pause, naming its successor | The pauser | VLT-224, VLT-225 | Revoked |
| Current, to be revoked | The successor its waiting revoke names is revoked at once | The pauser | VLT-224, VLT-225 | Current |
| Registered | Become current as the successor a revoke names | Governance's revoke after the wait, or the pauser's in a pause | VLT-223, VLT-224, VLT-225, VLT-228 | Current |
| Registered, to be made current | Become current as the successor a revoke names | The pauser's revoke, in a pause | VLT-224, VLT-225, VLT-228 | Current |
| Registered, to be made current | Cancel | Governance or the pauser | VLT-222 | Registered |
| Registered, to be revoked | Cancel | Governance or the pauser | VLT-222 | Registered |
| Current, to be revoked | Cancel | Governance or the pauser | VLT-222 | Current |

**Refusals out of state:**

| Step | Refused by |
| --- | --- |
| Register | A version that does not report itself as vault code, a revoked version restored, and one above the most live versions, VLT-226. By anyone but governance, VLT-222 |
| Start as the first version of a fresh deployment | Once any vault exists, VLT-225 |
| Propose making it current | A version that was never registered, or a second proposal while one waits, VLT-222. A version that names another price guard than the platform's, VLT-228 |
| Apply, after the wait | Before the wait has passed, VLT-223. A version that names another price guard than the platform's when it is applied, VLT-228 |
| Another version is made current | As the apply that makes the other one current, VLT-223 |
| Propose a revoke | A second proposal while one waits, or by anyone but governance, VLT-222 |
| Propose a revoke, naming its successor | As for any revoke, VLT-222. With no successor, or one that was never registered or is revoked, VLT-220, VLT-226. With one that names another price guard than the platform's, VLT-228 |
| Apply the revoke, after the wait | Before the wait has passed, VLT-223 |
| Revoke at once, in a pause | Outside a pause, or by anyone but the pauser, VLT-224 |
| Revoke at once, in a pause, naming its successor | Outside a pause, VLT-224. With no successor, or one that is revoked or was registered too recently, VLT-224, VLT-225. With one that names another price guard than the platform's, VLT-228 |
| Become current as the successor a revoke names | A successor that is revoked, or was registered less than the wait before, VLT-224, VLT-225. One that names another price guard than the platform's when the revoke is applied, VLT-228 |
| The successor its waiting revoke names is revoked at once | Outside a pause, or by anyone but the pauser, VLT-224 |
| Cancel | With no change waiting, or by anyone but governance or the pauser, VLT-222 |
| Propose the change that retires a price guard, naming this version | By anyone but governance, or while a change waits, VLT-222. With no replacement of the price guard pending, VLT-229 |
| Apply the change that retires a price guard | By anyone but the step that replaces the price guard, before the wait has passed, after the replacement lapsed or was cancelled, or after the change itself was cancelled, VLT-222, VLT-223, VLT-229 |
| Revoked by the change that retires a price guard | A version that names the same price guard as the version made current is not revoked, VLT-229 |

### Notes on the life of a version of the vault code

One change waits at a time in the registry (VLT-222).
A revoke of the current version names its successor in the same proposal or the same call.
On governance's route the successor's season is measured when the revoke is applied, not
when it is proposed (VLT-225), so a successor may be registered on the day of the proposal.

The pauser may revoke at once a version whose own change is waiting, from each of the three
waiting states, and the waiting change ends in the same call (VLT-224 says "a version",
with no exception).
From "Current, to be revoked" the pauser names a successor, which need not be the one the
proposal named.
When the pauser revokes the version that a waiting revoke names as its successor, that
change can never be applied, so it ends too and the current version is "Current" again.

VLT-222 states that governance's revoke of the current version names a successor, and
VLT-224 that a waiting change naming the revoked version ends with the revoke.
Where a change to make a version current is waiting and the pauser names that same version
as successor, the version is current at once and the waiting change ends (VLT-224).
The change that retires a price guard ends the same ways, and VLT-229 states what follows.

A version naming another price guard than the platform's is refused when a change is asked
for and again when it is applied (VLT-228), on every route: an ordinary change, a successor
named by governance's revoke or by the pauser's, and a pin.
The change that retires a price guard belongs to one replacement. Governance or the pauser
may cancel it alone: the replacement then stays pending, and its step is refused until a
new change has been proposed and has waited (VLT-229).

Two consequences of the retiring change are worth stating.
A new guard must answer the read a vault already makes, since the version made current
differs in the guard's address alone (VLT-245). A guard that needs other vault code is
adopted only after that code has shipped by the ordinary route, in a version that names
the present guard.
After the step the pauser has a successor to name (VLT-224) only if a second version naming
the new guard was registered and seasoned beforehand. The check that precedes the proposal
of a replacement reports whether one exists. It is stated there and not required.

## 3.4 The pin

### VLT-230 · rule

**Who:** a vault's owner.
**When:** the owner pins the vault to a version.

A pin promises this: the vault runs that version until its owner changes the pin, or until
governance revokes the version.
A revoke moves a pinned vault to the current version without its owner's consent.
The owner may re-pin and may remove the pin.

- **For the mistake:** VLT-M37, undo.
- **Tests owed:** the defaults for a rule, with a pin across a change of the current version
  and across a revoke.

### VLT-231 · refusal

**Who:** a vault's owner.
**When:** a pin names a version that is not registered, one that is revoked, one that was
registered less than the vault code wait [PRM-002] ago, or one that names another price
guard than the platform's (VLT-228).

The pin is refused, and nothing changes.
A pin that waits is refused the same way when it is applied.

- **Refused as:** the version is not live; or the version is too new, with the time from
  which it can be pinned; or the version names a price guard that is not the platform's.
- **Tests owed:** the defaults for a refusal, one path for each reason, with a pin asked to
  the version a waiting replacement names.

### VLT-232 · rule

**Who:** the owner wallet in force for a vault, the first or a replacement.
**When:** a pin is set, changed or removed, or the pin delay is changed.

Each pin change needs that owner's own authorization (VLT-181) and takes effect after the
vault's pin delay. With no pin delay it takes effect at once. After a delay anyone applies it.
With protection on, the pin delay is raised, to no more than the longest protected pin delay
[PRM-006], so that a pin asked for as soon as a code change is proposed still lands first.
Only the owner's own authorization may raise it further. Raising it takes effect at once.
Lowering it waits the delay in force.
A pin change is a safety setting: it stays open while the platform is paused.

- **Tests owed:** the defaults for a rule, with a pin asked on the day a change is proposed,
  and a pin change in a pause.

### VLT-233 · rule

**Who:** a vault's owner, its signers, and the platform.
**When:** a pin change, or a lowering of the pin delay, is waiting.

One pin change waits at a time for a vault.
The owner or a signer may cancel what is waiting.
With protection on, no pin change is accepted while the account is locked.
Everything waiting for a vault is voided when protection is switched on or off, at a lock,
and when the owner wallet is replaced: nothing asked under one posture matures under the next.
A waiting pin whose version is revoked meanwhile lapses, and the pin stays as it was.
When the version a vault is pinned to is revoked, a waiting change of the pin goes on as a
first pin, and a waiting removal ends.

- **Tests owed:** the defaults for a rule, one path for each way a waiting change ends.

### VLT-234 · rule

**Who:** a vault's owner.
**When:** the platform's price guard is replaced.

Every pin ends at the step that replaces the price guard, whether or not the unit changes:
every version naming the retired guard is revoked in that step (VLT-229, VLT-230).
A pin that is waiting lapses at the step as well.
A vault's owner is told from the proposal on: the date, that the pin ends then, and that a
version naming the new guard may be pinned from the step on (PLT-121).

- **Tests owed:** the defaults for a rule, with a pinned vault across the step, a pin and a
  change of pin waiting at the step, and a pin to the new version asked before and after it.

### Model: a pin

**States:**

- Not pinned (start): the vault has never been pinned. It runs the current version.
- Waiting to pin: a pin waits the pin delay, with none in force. The vault runs the current version.
- Pinned: the vault runs the version its pin names.
- Waiting to change the pin: a pin to another version waits. The vault runs the version pinned.
- Waiting to unpin: a removal waits. The vault runs the version pinned.
- Unpinned (end): no pin is in force after one was asked for. The vault runs the current version.

**Steps:**

| From | Step | Who | Guarded by | To |
| --- | --- | --- | --- | --- |
| Not pinned | Ask for a pin, with a pin delay | The owner | VLT-231, VLT-232 | Waiting to pin |
| Unpinned | Ask for a pin, with a pin delay | The owner | VLT-231, VLT-232 | Waiting to pin |
| Pinned | Ask for a pin, with a pin delay | The owner | VLT-231, VLT-232 | Waiting to change the pin |
| Not pinned | Ask for a pin, with no pin delay | The owner | VLT-231, VLT-232 | Pinned |
| Unpinned | Ask for a pin, with no pin delay | The owner | VLT-231, VLT-232 | Pinned |
| Pinned | Ask for a pin, with no pin delay | The owner | VLT-231, VLT-232 | Pinned |
| Waiting to pin | Apply, after the pin delay | Anyone | VLT-232 | Pinned |
| Waiting to change the pin | Apply, after the pin delay | Anyone | VLT-232 | Pinned |
| Waiting to unpin | Apply, after the pin delay | Anyone | VLT-232 | Unpinned |
| Waiting to pin | Cancel | The owner or a signer | VLT-233 | Unpinned |
| Waiting to change the pin | Cancel | The owner or a signer | VLT-233 | Pinned |
| Waiting to unpin | Cancel | The owner or a signer | VLT-233 | Pinned |
| Waiting to pin | Void: protection switched on or off, a lock, a replacement of the owner wallet | The platform, with the owner's change | VLT-233 | Unpinned |
| Waiting to change the pin | Void: protection switched on or off, a lock, a replacement of the owner wallet | The platform, with the owner's change | VLT-233 | Pinned |
| Waiting to unpin | Void: protection switched on or off, a lock, a replacement of the owner wallet | The platform, with the owner's change | VLT-233 | Pinned |
| Waiting to pin | The version asked for is revoked | Governance, the pauser in a pause, or the step that replaces the price guard | VLT-233, VLT-234 | Unpinned |
| Waiting to change the pin | The version asked for is revoked | Governance, or the pauser in a pause | VLT-233 | Pinned |
| Pinned | Ask to remove, with a pin delay | The owner | VLT-232 | Waiting to unpin |
| Pinned | Ask to remove, with no pin delay | The owner | VLT-232 | Unpinned |
| Pinned | The pinned version is revoked | Governance, the pauser in a pause, or the step that replaces the price guard | VLT-230, VLT-234 | Unpinned |
| Waiting to change the pin | The pinned version is revoked | Governance, or the pauser in a pause | VLT-230, VLT-233 | Waiting to pin |
| Waiting to unpin | The pinned version is revoked | Governance, the pauser in a pause, or the step that replaces the price guard | VLT-230, VLT-234 | Unpinned |
| Waiting to change the pin | The pinned version and the version asked for are revoked in one call | The step that replaces the price guard | VLT-230, VLT-233, VLT-234 | Unpinned |

**Refusals out of state:**

| Step | Refused by |
| --- | --- |
| Ask for a pin, with a pin delay | A version that is not live, is too new, or names another price guard than the platform's, VLT-231. While a pin change waits, or while a protected account is locked, VLT-233 |
| Ask for a pin, with no pin delay | A version that is not live, is too new, or names another price guard than the platform's, VLT-231. While a pin change waits, or while a protected account is locked, VLT-233 |
| Apply, after the pin delay | Before the pin delay has passed, VLT-232 |
| Cancel | With nothing waiting, or by anyone but the owner or a signer, VLT-233 |
| Void: protection switched on or off, a lock, a replacement of the owner wallet | With nothing waiting it changes nothing, VLT-233 |
| The version asked for is revoked | A revoke is refused as the version registry states, VLT-222, VLT-224 |
| Ask to remove, with a pin delay | With no pin in force, while a pin change waits, or while a protected account is locked, VLT-232, VLT-233 |
| Ask to remove, with no pin delay | With no pin in force, while a pin change waits, or while a protected account is locked, VLT-232, VLT-233 |
| The pinned version is revoked | A revoke is refused as the version registry states, VLT-222, VLT-224 |
| The pinned version and the version asked for are revoked in one call | By any call but the change that retires a price guard, which alone revokes more than one version, VLT-229 |

**Dimensions:**

| Dimension | Values | Named by |
| --- | --- | --- |
| The pin delay | None; a delay the owner chose; a delay raised for protection, as far as PRM-006 | VLT-232 |
| Protection | On, and not locked; on, and locked; off | VLT-232, VLT-233 |

### Notes on the life of a pin

When the version a vault is pinned to is revoked while a change of the pin waits, the
change goes on at its original time as a first pin, and the vault runs the current version
until then (VLT-230).
The owner's authorization named the version asked for, not the one left, and a revoke
changes none of the things that void what waits (VLT-233).
A removal that waits ends with the revoke, since no pin is left to remove.
A lowering of the pin delay that waits is untouched: the delay belongs to the vault.
VLT-233 states both.

At the step that replaces the price guard a pin that is waiting names a version of the
retired guard too, since no other could be asked for (VLT-231). So it lapses in the same
call, and a vault waiting to change its pin ends "Unpinned" (VLT-234).
An ordinary revoke takes one version in a call, and reaches the same end by two rows.

The pin delay is a figure beside the states, and changes none of them.
Raising it takes effect at once, by the owner, or by the platform as far as PRM-006 with
protection on. A lowering waits the delay in force (VLT-232).
A lowering that waits is voided as a waiting pin is, and the delay then stays unchanged (VLT-233).
A cancel, a void and a lapse leave the pin as it was before the ask.

## 3.5 The addresses fixed in the code

### VLT-240 · rule

**Who:** a vault.
**When:** it pays or approves one of the platform's own endpoints.

The treasury, the reserve, the backstop, the marketplace with its listing conduit, the order
protocol and the price guard are fixed in the vault code.
A vault reads them from no registry and from no setting of the platform.
Changing one means a new version of the vault code, with its wait (VLT-223).

- **Tests owed:** the defaults for a rule, with a platform setting that names another address:
  the vault refuses it.

### VLT-241 · rule

**Who:** a vault.
**When:** an open loan's listing still uses an earlier conduit.

Beside the conduit that new listings use, a version may list a small number of earlier ones
[PRM-007] that open listings still use.
A vault accepts any that its code lists and refuses every other.
A version whose earlier list repeats an entry, repeats the current one, skips a place or
leaves a conduit without its key cannot be built.
A version lists no earlier price guard: it names one (VLT-228).

- **Tests owed:** the defaults for a rule, with a listing on an earlier conduit across a
  change of version.

### VLT-242 · rule

**Who:** whoever pays a fee.
**When:** a fee is paid to the treasury.

The treasury is named in one place only: the vault code.
The platform keeps no second copy and no setting that changes it, and the treasury it reports
is the one the current version names.
A fee drawn from a vault goes to the treasury that vault's own version names.
So a pinned vault pays its version's treasury until its owner removes the pin or the version
is revoked.

- **Tests owed:** the defaults for a rule, with a pinned vault across a change of treasury.

### VLT-243 · refusal

**Who:** whoever pays a fee.
**When:** the vault code in force names no treasury.

The fee is refused. It is never sent to an empty address.

- **Refused as:** no treasury is named.
- **Tests owed:** the defaults for a refusal.

### VLT-244 · rule

**Who:** governance.
**When:** a version of the vault code is kept registered.

A version registered at least the vault code wait earlier, and not revoked, could become the
code vaults run at once in a pause (VLT-224). So the addresses it fixes could take effect
at once.
A version whose addresses are no longer accepted, or whose code is found unsafe, is revoked
and not left registered.
The pauser's revoke falls back only to a version that is not revoked.
(DPL owed: a launch is refused until the endpoints fixed in the vault code and those the
platform is configured with agree.)

- **Tests owed:** the defaults for a rule, a launch check on every registered version, and a
  pauser's revoke with an older version revoked before it.

### VLT-245 · rule

**Who:** governance.
**When:** a version is proposed as the one a change that retires a price guard makes current.

That version differs from the version it replaces in the price guard's address alone.
No owner can decline it, since every pin ends at the step (VLT-234), so it carries no other
change of the vault code.
The chain cannot hold this. A named check does: the two versions are compared with their
fixed addresses masked, before the proposal, and its report is published with the proposal.

- **Tests owed:** the defaults for a rule, with a version that differs in one more thing
  refused by the check.

### VLT-246 · never

**Who:** a vault.
**When:** it checks an outcome for a loan whose lien holds the collateral as priced.

A vault never treats that collateral as having no price, whatever price version the platform
names. A lien holds the collateral as the loan stands: as priced in a priced loan, and only
there (PRC-018, PRC-533). The collateral of an unpriced loan is held as unpriced, also where
the asset by itself has a price, and its hand-over is that loan's own route.
Its bound holds against the most lenient version the guard still answers (PRC-254). Where such
a version has no source for the asset, the vault's read is a refusal, and never the route for
an asset with no price (PRC-255).

- **Against:** PRC-T20.
- **Watch:** no vault let an outflow go on the route for an asset with no price for
  collateral its lien holds as priced, outside the record of the last resort.
- **Tests owed:** the defaults for a never, with each version still answered named for a lien
  whose asset gained its source at a later one, and the default of an unpriced loan whose
  collateral by itself has a price.

## Outcome under each condition of the platform (section 3)

A cell names the statement that decides it. "Open" means the condition does not refuse the step.

| Step | Paused | Asset paused | Caller flagged | Screen cannot be read | Terms not current |
| --- | --- | --- | --- | --- | --- |
| Creating a vault | PLT-040. Open inside a step PLT-041 keeps open (VLT-202) | Open | PLT-060, for the wallet it is created for. Open for a flagged creator (VLT-200) | Open (VLT-202) | Open (PLT-071) |
| Setting, changing or removing a pin, and changing the pin delay | Open (VLT-232) | Open | Stated in section 5 | Stated in section 5 | Open (PLT-071) |
| Making a version current, or revoking one | Open (VLT-223). The pauser's route opens (VLT-224) | Open | Not a party's step | Not a party's step | Not a party's step |

No step of this section sets a price, and none is moved by a sequencer outage. VLT-246 states
what a vault's own read of a price never does.
