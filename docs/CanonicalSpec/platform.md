# The platform's rules (PLT)

These rules bind every domain. Every other domain is read against this file, and cites its
statements by id.
Figures are named by parameter id and are in the parameters table (`parameters.md`).

## 1. Where funds are paid

### PLT-001 · rule

**Who:** any party the platform owes an amount.
**When:** a step pays or returns that amount.

The amount is paid into a vault.
It is free balance at once when the party's own step releases it.
When someone else's step pays it, it is held for the position and its holder collects it.
For an amount owed to a position, the party is whoever holds that position's token at that moment.

- **Tests owed:** the defaults for a rule, and a place on every path that pays a party.

### PLT-002 · rule

**Who:** a vault's owner.
**When:** an asset is to reach the owner's own wallet.

Only two steps pay a party's own wallet:
the owner's own withdrawal from their own vault, and the release of a payout that owner queued.
With protection on, either may instead pay a destination the owner set for that account.
An account's recovery address is paid from that account only by the steps of a recovery
(VLT-624).
A caller's unspent network fee, sent with a call, is returned to that caller in the same call.

- **Tests owed:** the defaults for a rule.

### PLT-003 · rule

**Who:** a caller who is not a party to the position a step acts on, and an inviter.
**When:** the step pays that caller for running it, or pays the inviter of its borrower.

The caller is paid at their wallet, in the same step:
one who liquidates, one who buys at a liquidation, one who matches, one who runs a keeper step.
An inviter is paid a stated part of that one loan's opening fee, once, in the lending asset,
at their wallet.
An integrator's part of that fee, and an invited user's, is paid once into a vault.
A payee whose account has protection on is credited in its vault instead.

- **Tests owed:** the defaults for a rule.

### PLT-004 · never

**Who:** any step.
**When:** an amount is owed to a position.

No step names the payee of an amount owed to a position.
The payee is read from the position's token, and from nothing the caller supplies.

- **Against:** PLT-T01, PLT-T02.
- **Watch:** every payment for a position reaches the vault of the token's holder at that block.
- **Tests owed:** the defaults for a never.

## 2. Funds are never mixed

### PLT-010 · never

**Who:** the platform, whoever asks or authorizes it.
**When:** a balance rests in a vault or in the treasury.

The platform has no step that places such a balance with an outside venue.
The one exception is a loan that returns in the same transaction,
from the part not lent of an amount set aside to lend, whose owner chose to allow it.
A sale or a swap that completes in one transaction is not a placement.

- **Against:** PLT-T03, PLT-T04.
- **Watch:** at the end of every transaction, every asset rests in a kind of account that some
  domain's own list names.
- **Tests owed:** the defaults for a never.

### PLT-011 · rule

**Who:** a lender and a borrower.
**When:** a loan opens, and for as long as it is open.

A loan has one lender and one borrower at a time. Either side may change hands.
A borrower who needs more than one lender offers takes several loans.
Each of them has its own lender, its own terms and its own collateral.

- **Tests owed:** the defaults for a rule.

### PLT-012 · never

**Who:** the platform.
**When:** funds are set aside to lend, or interest is paid.

Funds that two vaults set aside to lend are never held in one balance.
No loan is funded from more than one vault.
Interest paid on a loan is never shared with the lender of another loan.

- **Against:** PLT-T05, PLT-T06.
- **Watch:** every loan's principal leaves exactly one vault.
- **Tests owed:** the defaults for a never.

### PLT-013 · never

**Who:** anyone but a vault's owner.
**When:** at any time.

A balance leaves a vault only by a step its owner took, or one its owner committed to.

- **Against:** PLT-T03.
- **Watch:** every fall in a vault's balance names a step or a commitment of its owner.
- **Tests owed:** the defaults for a never.

## 3. Facts, and the party decides

### PLT-020 · rule

**Who:** any surface the platform runs.
**When:** it shows a party offers, lenders, borrowers or rates.

The surface states facts the platform can substantiate.
It runs no campaign, gives no advice to move funds,
and does not set one lender's rate against another's as a reason to move.
A lender outside the platform is shown by a neutral id.
Where the platform itself orders or selects, the rule it uses is stated,
and the party sees the result before signing.

- **Tests owed:** the defaults for a rule (APP owed: the tests of each surface).

## 4. Fees

### PLT-030 · rule

**Who:** the parties to a loan.
**When:** a fee is charged.

The same fee schedule applies to every kind of loan, however it was opened.
(FEE owed: the schedule, and how it applies to an NFT rental.)
Its figures are in the parameters table.

- **Tests owed:** one functional test for each way a loan opens, showing the same fee.

## 5. The conditions of the platform

Seven conditions apply to every step that moves funds.
Each such step states its outcome under each condition.
Where it states none, the default below applies.

### PLT-040 · refusal

**Who:** any caller.
**When:** the platform is paused.

Every step is refused, and nothing moves.
That includes a step that only releases an amount inside a vault, and a step that moves no funds.
The only steps not refused are the two of PLT-041, the escape withdrawal (VLT-091),
and a step whose own statement says it stays open in a pause.

- **Refused as:** the platform is paused.
- **Tests owed:** the defaults for a refusal, on every step.

### PLT-041 · always possible

**Who:** a borrower.
**When:** the platform is paused.

A borrower can repay from their own funds, and can add collateral.

- **From:** every state of a loan in which it is open.
- **By:** repay, add collateral.
- **Except under:** an asset whose own code refuses or shortens the transfer (VLT-071),
  a flagged payer adding collateral (PLT-060),
  and, while the loan's lien is split, a repayment of less than all the loan owes (VLT-155).
- **Tests owed:** the defaults for an always possible.

### PLT-042 · rule

**Who:** nobody.
**When:** time passes while the platform is paused.

The time paused since a loan started is added once to its whole schedule:
its due date, its end of grace and each periodic interest deadline.
No loan falls due or defaults during a pause, and no late fee is charged for time paused.
No loan is liquidated during a pause. A liquidation for a low health factor waits for the
pause to end, with no time credit: the borrower can add collateral throughout (PLT-041).

- **Tests owed:** the defaults for a rule, and a path that pauses across a due date.

### PLT-043 · rule

**Who:** nobody.
**When:** time passes while the platform is paused.

A pause moves loan deadlines and nothing else.
Interest keeps accruing through a pause.
A rental's paid use ends on its original date.
The expiry of an offer, a listing or an order does not move.

- **Tests owed:** the defaults for a rule, one path for each of the three.

### PLT-050 · refusal

**Who:** any caller.
**When:** an asset is paused, and a step would open a new position in it.

The step is refused, and nothing moves.
A lender's exit by sale is such a step: it opens the position for a buyer.
So is an extension of a loan in place, when the paused asset is the loan's collateral or its
lending asset. The loan keeps its due date and its end of grace.

- **Refused as:** the asset is paused.
- **Tests owed:** the defaults for a refusal.

### PLT-051 · rule

**Who:** any caller.
**When:** an asset is paused.

Every close-out stays open: repayment, collection, the owner's withdrawal, default,
liquidation, cancelling an offer and taking capital out of an Auto-lend slot.
So does every step that adds the borrower's own backing to an open loan or pays it down:
adding collateral, funding a loan's reserves, and the standing top-up, interest payment and
repayment at the due date.
While a loan's lien is split, only a repayment of all the loan owes is taken (VLT-155).
(AUT owed: when the per-asset pause may be placed, and how each use is published.)

- **Tests owed:** the defaults for a rule, each named step under a paused asset.

### PLT-060 · refusal

**Who:** a wallet the sanctions screen flags.
**When:** a step would create a vault for it, open a position for it, take a new commitment,
a deposit or a collateral top-up from it, pay or release value to it, pay it an incentive,
have it start a liquidation or run a match, or move a position token into or out of it.

The step is refused, and nothing moves.
It makes no difference who sends the transaction:
the wallet acted for, the payer, the recipient and the position's holder are each screened.
On a step that PLT-061 keeps open, PLT-062 and PLT-063 apply in place of this refusal.
The platform's own issue, retirement and settlement of a position token that finish a loan
still happen.

- **Refused as:** the wallet is flagged, naming the wallet.
- **Tests owed:** the defaults for a refusal, on every such step.

### PLT-061 · always possible

**Who:** the other party to a position a flagged wallet holds or is a party to.
**When:** that party is not flagged.

The other party can still be made whole.
Every step that pays down or closes that loan stays open, among them a repayment, a default,
a liquidation, and the completion of a sale already committed.

- **From:** every state of a loan in which it is open.
- **By:** repay, default, liquidate, among others.
- **Except under:** a pause (PLT-040, with its time credit; a repayment is not delayed, PLT-041);
  for a default and a liquidation, a price the guard does not vouch for (PLT-080) and the
  window after a sequencer outage (PLT-090);
  an asset whose own code refuses or shortens the transfer;
  and, while the loan's lien is split, a repayment of less than all the loan owes (VLT-155).
- **Tests owed:** the defaults for an always possible.

### PLT-062 · rule

**Who:** any caller of a step that stays open.
**When:** the step owes an amount to a flagged party.

The amount is held for that party in a vault, and never refuses the step.
It is never paid to the flagged wallet, and never joins the treasury.
It stays held until the flag clears. Its release screens the holder at that moment.

- **Tests owed:** the defaults for a rule, with a flagged lender and a flagged borrower.

### PLT-063 · rule

**Who:** a flagged caller who is not a party.
**When:** it runs a step that anyone may run.

A flagged caller cannot start a liquidation or run a match of offers: PLT-060 refuses both.
It can run a step that settles a loan by a fixed rule, where skipping the step would leave
the parties worse off: the internal match of a loan being closed, or another safety step.
That step completes, and no reward is paid to the caller.
What would have been paid stays with the parties it was to come from.

- **Tests owed:** the defaults for a rule, one path on each side of the line.

### PLT-064 · rule

**Who:** whoever holds a position's token.
**When:** an earlier holder of that position is flagged.

The screen is on whoever holds the token now.
A flag on an earlier holder never holds back or redirects what a clean holder is owed.

- **Tests owed:** the defaults for a rule, with a position bought before the flag.

### PLT-065 · rule

**Who:** any caller.
**When:** a network's sanctions screen is set and cannot be read.

A step that opens a position or takes a new commitment is refused, and nothing moves.
On every other step a wallet that was never confirmed flagged is treated as not flagged:
a wallet's own withdrawal and collection, and every close-out, stay open.
A wallet confirmed flagged while the screen answered stays flagged:
what is held for it stays held, and its position tokens do not move.
A step that states its own outcome for this condition follows that statement.
A network with no screen set checks nothing (DPL owed: where that is allowed).

- **Refused as:** the screen cannot be read.
- **Tests owed:** the defaults for a rule, with the screen failing on each step that asks it.

### PLT-070 · refusal

**Who:** a wallet that is not current on the Terms.
**When:** a step would have it open a position, take one over through the platform,
start a new term on a loan in place, or post or set a standing commitment or instruction.

The step is refused, and nothing moves.
Setting any standing instruction asks, also one that opens nothing.
A refused fill cancels nothing: the offer or the setting stays, and fills once its owner accepts.

- **Refused as:** the wallet is not current on the Terms, naming the wallet.
- **Tests owed:** the defaults for a refusal, on every such step.

### PLT-071 · rule

**Who:** a wallet that is not current on the Terms.
**When:** it reduces or leaves a position, or reaches its own funds.

It is never asked for: repaying, closing early, adding collateral, collecting, withdrawing,
cancelling, switching a setting off, leaving a position that another wallet takes over,
or listing its own loan or its own collateral for sale.
Nor for creating a vault, depositing, or its account's safety settings.
The platform's own backstop vault is never asked.
A default, a liquidation and every step a third party takes to settle a loan never ask.

- **Tests owed:** the defaults for a rule.

### PLT-072 · rule

**Who:** a wallet that is not current on the Terms.
**When:** something it set earlier comes to run.

A run that only pays, tops up, reduces or ends its owner's own loan keeps running.
An open offer and an Auto-lend slot stop filling until their owner accepts.
A plan that would start a new term, an extension or a roll, asks when it runs.

- **Tests owed:** the defaults for a rule, one path for each of the three.

### PLT-080 · never

**Who:** any step that needs a price.
**When:** the price guard does not vouch for the price.

No step proceeds on a price the price guard does not vouch for.
An asset with no price takes the route its own statement gives for such an asset.
A price the guard distrusts refuses the step, and never takes the no-price route.

- **Against:** PLT-T07, PLT-T08.
- **Watch:** not watchable from chain data alone. A refused step leaves no record.
- **Tests owed:** the defaults for a never.

### PLT-090 · rule

**Who:** nobody.
**When:** a network's sequencer was down, on a network that reports it.

No loan becomes defaultable inside an outage or the recovery window after it.
An end of grace that falls inside moves to the window's end.
Until then the borrower may repay from their own funds.
No late fee is charged for time inside the latest outage and its recovery window.
A step that sells an asset waits for the window to end (PLT-080).

- **Tests owed:** the defaults for a rule, and a path with an outage across an end of grace.

### PLT-091 · rule

**Who:** nobody.
**When:** a network's sequencer was down.

An outage moves an end of grace and nothing else.
The due date and the interest are not moved, and a periodic interest deadline is not moved.
Only the latest outage is known.
A network that reports no sequencer state is unaffected.

- **Tests owed:** the defaults for a rule, with two outages in one loan's life.

## 6. Assets sent to the platform's own address

### PLT-100 · refusal

**Who:** any sender.
**When:** the network's own coin is sent to the platform's address outside a step that asks for it.

The coin is refused, and stays with the sender.

- **Refused as:** the platform's address takes the coin only inside a step that asks for it.
- **For the mistake:** PLT-M01, refuse.
- **Tests owed:** the defaults for a refusal.

### PLT-101 · rule

**Who:** any sender.
**When:** a token or an NFT reaches the platform's address outside a step.

The asset belongs to no party's balance, and no step returns it to the sender.
The platform refuses an NFT whose sender asks it to accept.

- **For the mistake:** VLT-M14, warn only. The platform cannot tell whose asset it is.
- **Tests owed:** the defaults for a rule.

### PLT-102 · never

**Who:** the platform, and anyone who governs it.
**When:** an asset reached the platform's address outside a step.

No step of the platform spends or moves such an asset.

- **Against:** PLT-T11.
- **Watch:** every fall in the platform's balance of an asset is matched by a record of a step
  that owed it.
- **Tests owed:** the defaults for a never, in every deployment mode.

## 7. Rules every step keeps

### PLT-110 · never

**Who:** any step.
**When:** the step takes in, records or moves an asset.

No step treats an asset as a kind other than the one the asset answers as.
An asset that answers as an NFT is never accepted as a token counted in amounts.
An asset stated to be an NFT of one standard is never accepted unless it answers as that standard.

- **Against:** PLT-T12.
- **Watch:** the same asset recorded under two kinds, in any vault's records or any loan's terms.
- **Tests owed:** the defaults for a never, with each hostile asset that answers as two kinds.

### PLT-111 · never

**Who:** any caller, and any asset's own code.
**When:** a step that moves funds is running.

No other step can be entered until the running step has finished.
That holds for a token, an NFT or a payee that is handed control during a transfer.
The parts a step runs as its own are not another step.

- **Against:** PLT-T13, VLT-T15.
- **Watch:** not watchable from chain data alone. A refused entry leaves no record.
- **Tests owed:** the defaults for a never, with a payee and an asset that call back.

### PLT-112 · never

**Who:** anyone holding a signature a party gave.
**When:** a step is authorized by that signature.

A signature authorizes only what it states:
one action, for one account, on one network, at one address of the platform,
up to the amount it states and until the deadline it states.
It is never accepted on another network, after its deadline, after its signer cancelled it,
or for more than it states in total.
Every signature the platform accepts states a deadline.

- **Against:** PLT-T14.
- **Watch:** the total drawn under one signature never exceeds its stated amount.
- **Tests owed:** the defaults for a never, on every step a signature authorizes.

## 8. Standing rules of the platform

### PLT-120 · rule

**Who:** the platform.
**When:** funds move, or a step is skipped or takes a fallback.

Every movement of funds leaves a public record of what moved and why.
Every step that was skipped, and every fallback taken, leaves one too, with its reason.

- **Tests owed:** the defaults for a rule, and one record counted on every path step.

### PLT-121 · rule

**Who:** any surface the platform runs.
**When:** it shows principal, interest, a fee, collateral, a claim or a position's status.

The surface states what it knows and states what it does not know.
It shows no figure and no outcome that it cannot substantiate.

- **Tests owed:** the defaults for a rule (APP owed: the tests of each surface).

### PLT-122 · rule

**Who:** the two sides of a loan.
**When:** a loan is closed by force.

The lender's side is paid what the loan owes before the borrower's side receives what is left.
(FCL owed: the order among the lender's side, the fees and a caller's reward.)
In every case the borrower's side comes after the lender's.

- **Tests owed:** the defaults for a rule, with a recovery that falls short.

### PLT-123 · rule

**Who:** a lender and a borrower.
**When:** they choose the assets of a loan.

The platform keeps no list of permitted assets.
Where a feature is limited to assets of a tier, the tier comes from a stated reading and
never from a choice of asset.
No step names an asset to admit it, or to give it better terms than its readings earn
(PLT-124). Nobody names an asset liquid (PRC-500).
An asset with no price is used only where both parties consented to it for that loan.

- **Tests owed:** the defaults for a rule.

### PLT-124 · never

**Who:** the platform, whoever governs it, the guardian, a keeper, and anyone who records a
reading.
**When:** at any time.

No step of the platform names an asset to admit it, or to give it better terms than its
readings earn.
A step names an asset when it changes how the platform treats that asset as the asset lent or
as collateral. A party's choice of the assets of its own position is not such a step.
A step that names an asset only takes from it, records what a stated reading or count found,
gives the price guard a source to read, or uses it as a reference for reading others.
PLT-125 and PLT-126 list every such step.

- **Against:** PLT-T17.
- **Watch:** every step that names an asset is published when it is taken, and the launch
  check reports any setting or record kept by asset that PLT-125 and PLT-126 do not list.
- **Tests owed:** the defaults for a never, and a build check: every step that takes an
  asset's address or keeps a figure by asset, less a party's own steps, is one that PLT-125 or
  PLT-126 lists.

### PLT-125 · rule

**Who:** the platform, whoever governs it, the guardian, a keeper, and anyone who records a
reading.
**When:** a step takes from a named asset.

The steps that take from a named asset are its pause (PLT-050) and these of the price rules:
the mute of a rate source, the confirmed fall and the stop of its price (PRC-154, PRC-152,
PRC-214), the steps of its confidence tier (PRC-521, PRC-528, PRC-543), the count of what is
pledged in it (PRC-636, PRC-637), and a rate binding, which closes the token as an asset lent
(PRC-155, PRC-156).
Each only takes away, or records what a stated reading or count found.

- **Tests owed:** the defaults for a rule, and one path for each step listed.

### PLT-126 · rule

**Who:** the platform, whoever governs it, and the guardian.
**When:** a step gives a named asset a source for a reading, or names it as a reference.

A step that gives a named asset a source for a reading (its entry in the register of feeds, a
rate binding, a cross-check: PRC-220, PRC-155, PRC-111) admits no asset and refuses none.
It decides what the price guard can answer for the asset, and never whether it may be used.
A step that names an asset as a reference for reading others (PRC-512, PRC-613) gives that
asset no tier and no standing.

- **Tests owed:** the defaults for a rule, and one path for each step listed.
