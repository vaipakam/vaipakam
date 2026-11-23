# Mistakes: the vault (VLT)

Each row names a mistake an honest party can make.
That includes a party who never uses the app and calls the contracts directly.
The list was written from the party's seat, by a thread that did not draft the statements.

Each row has:

- **Proposed answer:** one of Refuse, Bound, Undo or Warn only. "Stated" is used where no
  answer of those kinds is possible: the statement then says plainly what happens.
- **Wanted statement:** what the answering statement should say.
- **Answered by:** the statement that answers it, once that statement is entered.
- **Waits for:** the section that will answer it, while that section is not entered.

Mistake ids use the form `VLT-M<nn>`, and they are permanent.
Of the 51 rows, 47 are answered by sections 1 to 5 and the platform's rules, and 4 wait for
sections 6 and 7. The vault's rules are not complete while a row still waits.

## 1. Having a vault

### VLT-M01 · Sending to a vault on the wrong network

**Who:** any party.
**Does:** copies a vault address from one network and sends tokens to it on another network.
**Proposed answer:** Stated.
**Wanted statement:** a vault address is valid only on the network that shows it.
Tokens sent to that address on another network are not the platform's.
No step recovers them.
**Answered by:** VLT-102.

### VLT-M02 · Sending tokens to your vault address before the vault exists

**Who:** the owner, or anyone paying the owner.
**Does:** sends tokens to the owner's predicted vault address before the vault was created.
**Proposed answer:** Undo, through adoption.
**Wanted statement:** tokens that reached a vault's address before the vault existed count
as untracked when it is created, and the owner may adopt them.
**Answered by:** VLT-162.

### VLT-M03 · Creating a vault for another wallet by mistake

**Who:** anyone.
**Does:** asks the platform to create a vault for a wallet that is not their own,
for example a mistyped address.
**Proposed answer:** Bound. The harm is limited to the network fee.
**Wanted statement:** anyone may create the vault of any wallet.
Creating it gives the creator no right over it and moves nothing.
**Answered by:** VLT-200.

## 2. Depositing

### VLT-M04 · An amount in the wrong unit

**Who:** the owner.
**Does:** deposits a token amount written in the wrong number of decimals,
for example a figure meant for 18 decimals on a 6-decimal token.
**Proposed answer:** Undo. A withdrawal of the deposited amount is always possible.
The one exception is an account in protected mode, where it waits that account's own delay.
**Wanted statement:** a deposit of an asset the owner holds and approved always succeeds in full
or not at all.
The deposited amount stays the owner's to withdraw.
**Answered by:** VLT-301.

### VLT-M05 · Approving the vault address instead of the platform

**Who:** the owner, calling the token directly.
**Does:** approves the vault address to spend the token, then asks to deposit.
**Proposed answer:** Refuse.
**Wanted statement:** a deposit is refused unless the owner approved the platform for the amount.
The refusal names the missing approval.
**Answered by:** VLT-302.

### VLT-M06 · A zero amount

**Who:** the owner.
**Does:** deposits zero units of a token, or of one id of a multi-token.
**Proposed answer:** Refuse.
**Wanted statement:** a deposit of zero is refused, and nothing moves.
**Answered by:** VLT-303.

### VLT-M07 · The wrong kind of asset

**Who:** the owner, calling directly.
**Does:** says the asset is a token when it is a single NFT, or the other way round,
or gives a kind number the platform does not know.
**Proposed answer:** Refuse.
**Wanted statement:** a deposit whose stated kind does not match what arrives is refused,
and nothing moves.
**Answered by:** VLT-304.

### VLT-M08 · A token that takes a fee on transfer

**Who:** the owner.
**Does:** deposits a token that delivers less than was sent.
**Proposed answer:** Refuse.
**Wanted statement:** a deposit is refused unless the whole amount arrives,
and the refusal states what arrived.
**Answered by:** VLT-071.

### VLT-M09 · Depositing into someone else's vault

**Who:** a party who wants to fund another person's vault.
**Does:** looks for a deposit that names someone else's vault.
**Proposed answer:** Stated.
**Wanted statement:** a party deposits only into their own vault, from their own wallet.
Payments between parties go through the steps of a loan or an offer.
**Answered by:** VLT-305.

## 3. Sending assets to the platform outside its steps

### VLT-M10 · Tokens sent straight to your own vault

**Who:** the owner, or an exchange paying the owner.
**Does:** transfers a token to the vault address with a plain transfer, not a deposit.
**Proposed answer:** Undo, through adoption.
**Wanted statement:** a token that reaches a vault outside a deposit is untracked.
Only its owner can adopt it, after naming its source.
After that it is withdrawn like any other.
**Answered by:** VLT-162.

### VLT-M11 · Tokens sent straight to someone else's vault

**Who:** any party.
**Does:** transfers a token to another person's vault, for example by mistyping an address.
**Proposed answer:** Stated.
**Wanted statement:** a token sent to a vault outside the platform's steps belongs to that vault's
owner
to adopt.
No step returns it to the sender.
**Answered by:** VLT-163.

### VLT-M12 · An NFT sent straight to a vault

**Who:** any party.
**Does:** sends a single NFT or a multi-token to a vault outside a deposit.
**Proposed answer:** Refuse for a send that asks the vault.
Undo through adoption for a plain send.
**Wanted statement:** a vault refuses an NFT offered to it outside the platform's steps whenever
the sender asks it to accept.
An NFT that arrives without asking is untracked and may be adopted.
**Answered by:** VLT-161.

### VLT-M13 · The network's own coin sent to a vault

**Who:** any party.
**Does:** sends the network's native coin, such as ETH, to a vault.
**Proposed answer:** Refuse.
**Wanted statement:** a vault never accepts the native coin.
**Answered by:** VLT-160.

### VLT-M14 · Tokens or NFTs sent straight to the platform's main address

**Who:** any party.
**Does:** transfers a token, or makes a plain send of an NFT, to the platform's own address
instead of to a vault.
**Proposed answer:** Stated.
**Wanted statement:** what happens to an asset sent straight to the platform's address,
and whether and by whom it can be recovered.
**Answered by:** PLT-101.

## 4. Withdrawing

### VLT-M15 · More than is free

**Who:** the owner.
**Does:** asks to withdraw more than they can take now.
The extra may be held by a loan, an offer, a claim or a reserve.
In protected mode it may also be the Ready balance or a queued payout.
**Proposed answer:** Refuse.
**Wanted statement:** a withdrawal of more than the free balance is refused with both figures.
**Answered by:** VLT-012.

### VLT-M16 · Withdrawing to another address without protected mode

**Who:** the owner.
**Does:** names a recipient other than their own wallet, for example an exchange deposit address.
**Proposed answer:** Refuse.
**Wanted statement:** without protected mode, a withdrawal pays only the owner's own wallet.
A withdrawal naming any other address is refused.
**Answered by:** VLT-031.

### VLT-M17 · Withdrawing from an account that is not yours

**Who:** a party, calling directly.
**Does:** names another wallet's account, for example by pasting the wrong address.
**Proposed answer:** Refuse.
**Wanted statement:** only the account's manager may withdraw from it.
**Answered by:** VLT-032.

### VLT-M18 · The wrong kind or id on a withdrawal

**Who:** the owner, calling directly.
**Does:** gives an amount for a single NFT, or names the wrong NFT id or the wrong token.
**Proposed answer:** Refuse.
**Wanted statement:** a withdrawal names one asset the owner holds free, and only that asset leaves.
**Answered by:** VLT-012.

### VLT-M19 · Withdrawing while the platform is paused

**Who:** the owner.
**Does:** asks to withdraw during a pause.
**Proposed answer:** Refuse, with the time the escape route opens.
**Wanted statement:** during a pause, a withdrawal is refused until the escape route opens,
and the refusal says when it opens.
**Answered by:** VLT-090.

### VLT-M20 · Using the escape route with a recovery address in force

**Who:** an owner who set a recovery address and later switched protected mode off.
**Does:** uses the escape route expecting the assets in their own wallet.
**Proposed answer:** Warn only.
Reason: this is the intended rule, because a recovery address stays in force after protected mode
is switched off.
The statement should be clear enough that a direct caller can find it.
**Wanted statement:** while a recovery address is in force, the escape route pays it,
whether protected mode is on or off.
**Answered by:** VLT-091.

## 5. The Ready balance (protected mode)

### VLT-M21 · Expecting the Ready balance to be withdrawable

**Who:** an owner in protected mode.
**Does:** tries to withdraw an amount that sits in the Ready balance.
**Proposed answer:** Refuse.
**Wanted statement:** the Ready balance is never paid to a wallet.
A withdrawal that reaches into it is refused, and the refusal says so.
**Answered by:** VLT-012.

### VLT-M22 · A second top-up meant to add to the first

**Who:** an owner in protected mode.
**Does:** asks for a second move into Ready while one is waiting,
thinking the two will add up.
**Proposed answer:** Warn only.
Reason: replacing is the rule, and it keeps only one waiting move per asset.
The event records the cancelled amount.
**Wanted statement:** a new move into Ready replaces any move of the same asset still waiting,
and its wait starts again.
**Answered by:** VLT-325.

### VLT-M23 · An idle period or a date in the wrong unit

**Who:** an owner in protected mode.
**Does:** sets the idle period as a count of days where seconds are meant,
or gives a "keep until" date that has passed or is too far ahead.
**Proposed answer:** Refuse.
**Wanted statement:** an idle period outside its bounds [PRM] is refused.
So is a keep-until date already past or beyond the longest idle period.
**Answered by:** VLT-331.

### VLT-M24 · Using Ready without protected mode

**Who:** an owner without protected mode.
**Does:** deposits into Ready, or asks for a top-up.
**Proposed answer:** Refuse.
**Wanted statement:** the Ready balance exists only for an account in protected mode.
A Ready step on any other account is refused.
**Answered by:** VLT-320.

## 6. Protected mode

### VLT-M25 · A delay in the wrong unit

**Who:** the owner.
**Does:** gives the protected-mode delay as a count of days where seconds are meant, or far too
large.
**Proposed answer:** Refuse.
**Wanted statement:** a protected-mode delay outside its bounds [PRM] is refused.
**Answered by:** VLT-401.

### VLT-M26 · Raising the delay by mistake

**Who:** the owner.
**Does:** raises the delay further than meant.
**Proposed answer:** Bound. The delay can never pass its largest value.
**Wanted statement:** raising the delay applies at once.
Lowering it waits the delay in force.
**Answered by:** VLT-402.

### VLT-M27 · A wrong destination on the allowlist

**Who:** the owner.
**Does:** asks to add a mistyped or wrong payout destination.
**Proposed answer:** Undo.
**Wanted statement:** a new destination counts only after the delay.
It can be cancelled until then, and removed at any time after.
**Answered by:** VLT-440.

### VLT-M28 · A queued payout to the wrong recipient or the wrong amount

**Who:** an owner in protected mode.
**Does:** queues a payout with the wrong recipient, asset or amount.
**Proposed answer:** Undo.
**Wanted statement:** a queued payout can be cancelled until it is released.
A cancelled payout leaves the asset in the vault, free.
**Waits for:** vault section 6

### VLT-M29 · A wrong signer

**Who:** the owner.
**Does:** proposes a mistyped address as a secondary signer.
**Proposed answer:** Refuse in effect.
A signer that cannot sign can never accept, and the request can be cancelled.
**Wanted statement:** a signer counts only after it accepts with its own key and the delay has
passed.
**Answered by:** VLT-430.

### VLT-M30 · Locking the vault by mistake

**Who:** the owner, or a signer.
**Does:** locks the vault without meaning to.
**Proposed answer:** Undo, after the delay.
**Wanted statement:** a lock applies at once and stops value leaving.
Only the owner may unlock, and the unlock waits the delay.
Changes the lock dropped must be asked for again.
**Answered by:** VLT-421.

### VLT-M31 · Replacing the owner wallet with the wrong wallet

**Who:** the owner, or signers acting together.
**Does:** proposes a wrong nominee as the new owner wallet.
**Proposed answer:** Undo, until it completes.
**Wanted statement:** a replacement takes effect only after the delay, and can be cancelled until
then.
Once it completes, the old wallet has no right over the account.
**Answered by:** VLT-450.

### VLT-M32 · A signed authorization left lying around

**Who:** the owner, or a signer.
**Does:** signs a protected-mode change off-chain and does not want it used any more.
**Proposed answer:** Undo.
**Wanted statement:** a key may void every signature it gave out for a purpose before it is used.
**Answered by:** VLT-183.

### VLT-M33 · Switching protected mode on by mistake

**Who:** the owner.
**Does:** switches protected mode on.
**Proposed answer:** Bound.
Switching it on only tightens, and the delay is at most its largest value.
**Wanted statement:** switching protected mode on applies at once.
Switching it off waits the delay.
**Answered by:** VLT-400.

## 7. Recovery address and clawback

### VLT-M34 · A mistyped recovery address

**Who:** the owner.
**Does:** names a recovery address that is wrong.
**Proposed answer:** Refuse.
An address no one controls can never prove control.
**Wanted statement:** a recovery address counts only after it proves its own control and its wait
passes.
It can be cancelled until then.
**Waits for:** vault section 7

### VLT-M35 · Clawing back by mistake

**Who:** the owner, or a signer.
**Does:** triggers a clawback, perhaps thinking it is an ordinary withdrawal.
**Proposed answer:** Bound.
It pays only the recovery address the owner proved control of.
The finality is the purpose of the step, so no undo is offered.
**Wanted statement:** a clawback pays only the recovery address in force, and it is final.
The account stays locked for good.
**Waits for:** vault section 7

### VLT-M36 · A recovery claim wait in the wrong unit

**Who:** the owner.
**Does:** sets the recovery claim's wait as days where seconds are meant, or out of range.
**Proposed answer:** Refuse.
**Wanted statement:** a recovery claim wait outside its bounds [PRM] is refused.
**Waits for:** vault section 7

## 8. Version pin

### VLT-M37 · Pinning the vault to a version by mistake

**Who:** the owner.
**Does:** pins the vault to a version of the vault code it did not mean to pin.
**Proposed answer:** Undo.
**Wanted statement:** a pin applies only to a live version, and the owner may remove it.
A revoked version never runs.
**Answered by:** VLT-230.

## 9. Adoption

### VLT-M38 · Adopting more than arrived, or after the deadline

**Who:** the owner.
**Does:** adopts an amount larger than the untracked part, or submits the signature after its
deadline.
**Proposed answer:** Refuse.
**Wanted statement:** an adoption is refused above the untracked amount, and after its deadline.
**Answered by:** VLT-171.

### VLT-M39 · Naming a wrong source for an adoption

**Who:** the owner.
**Does:** names a source address that is wrong, for example a typo, or the exchange's address
when they mean their own.
**Proposed answer:** Warn only, signed.
Reason: the platform cannot tell a mistaken declaration from a true one.
**Wanted statement:** an adoption whose named source is flagged bans the vault until that source
is de-listed, and credits nothing.
**Answered by:** VLT-173.

### VLT-M40 · Adopting while the screen cannot be read

**Who:** the owner.
**Does:** adopts when the sanctions screen is unset or not answering.
**Proposed answer:** Refuse.
**Wanted statement:** an adoption is refused while the screen cannot be read.
**Answered by:** VLT-172.

## 10. Second pass: rebasing tokens, the position move, listing escrows

### VLT-M41 · Depositing a token whose balance grows by itself

**Who:** the owner.
**Does:** deposits a token whose balances rise on their own, and expects the growth to be
withdrawable.
**Proposed answer:** Undo, through adoption.
**Wanted statement:** a balance a token adds to a vault by itself is untracked until its owner
adopts it.
**Answered by:** VLT-174.

### VLT-M42 · Depositing a token whose balance shrinks by itself

**Who:** the owner.
**Does:** deposits a token whose balances can fall on their own, and later asks to withdraw the
whole
recorded amount.
**Proposed answer:** Refuse.
**Wanted statement:** the free balance of a token never exceeds what the vault holds of it.
A withdrawal above that is refused.
**Answered by:** VLT-012.

### VLT-M43 · Expecting positions to move with a replaced owner wallet

**Who:** the wallet that replaced an account's owner wallet.
**Does:** expects the account's position tokens to move to the new wallet when the replacement
completes.
**Proposed answer:** Warn only.
Reason: leaving the positions in place is intended, so a stolen key that completes a replacement
cannot
take them at once.
**Wanted statement:** a replacement does not move the account's position tokens.
They move only on a move the new owner wallet asks for, after the delay.
**Answered by:** VLT-454.

### VLT-M44 · Letting the position move lapse

**Who:** the wallet that replaced an account's owner wallet.
**Does:** asks for the move, then does not run it within its window.
**Proposed answer:** Undo, by asking again.
**Wanted statement:** a position move that is not run within its window lapses.
A new one may be asked for.
**Answered by:** VLT-457.

### VLT-M45 · Asking for the position move on a locked or recovered account

**Who:** the wallet that replaced an account's owner wallet.
**Does:** asks for the move while the account is locked, during the new wallet's cool-down,
or after a clawback.
**Proposed answer:** Refuse.
**Wanted statement:** a position move is refused while the account is locked or in cool-down,
and on a recovered account.
A lock, a replacement or a clawback drops a waiting move.
**Answered by:** VLT-458.

### VLT-M46 · Asking for the position move with the old wallet

**Who:** the old owner wallet, or a signer.
**Does:** asks for the move.
**Proposed answer:** Refuse.
**Wanted statement:** only the owner wallet on record asks for a position move, and only after a
replacement.
**Answered by:** VLT-458.

### VLT-M47 · Expecting to withdraw a listed lot

**Who:** an owner whose asset is listed for sale through the platform.
**Does:** asks to withdraw the listed asset, or the listed units of a multi-token.
**Proposed answer:** Refuse.
**Wanted statement:** an asset held for an open listing never leaves the vault by a withdrawal.
It is free again only when the listing ends unfilled.
**Answered by:** VLT-354.

### VLT-M48 · Sending a multi-token straight to a listing escrow

**Who:** any party.
**Does:** sends a multi-token to the address of a listing escrow, thinking it is the vault or the
listing.
**Proposed answer:** Refuse.
**Wanted statement:** a listing escrow accepts nothing except from its own vault.
**Answered by:** VLT-353.

### VLT-M49 · Sending a token or a single NFT straight to a listing escrow

**Who:** any party.
**Does:** sends a token, or a single NFT without asking it to accept, to the address of a listing
escrow.
**Proposed answer:** Stated.
**Wanted statement:** an asset other than the listed lot that reaches a listing escrow cannot leave
it.
No step recovers it.
**Answered by:** VLT-355.

### VLT-M50 · The network's own coin sent to a listing escrow

**Who:** any party.
**Does:** sends the native coin to a listing escrow.
**Proposed answer:** Refuse.
**Wanted statement:** a listing escrow never accepts the native coin.
**Answered by:** VLT-353.

## 11. A loan whose collateral sale failed

### VLT-M51 · Paying part of a loan whose collateral sale failed

**Who:** the borrower's side.
**Does:** pays part of the loan while its collateral sits under a split lien, after every sale
route failed, expecting the payment to lower the debt and free some of the collateral.
**Proposed answer:** Refuse.
**Wanted statement:** while the lien is split, a repayment is of all the loan owes, or the borrower
adds collateral to cure it; a part payment is refused and says those two ways (VLT-155).
**Answered by:** VLT-155.
