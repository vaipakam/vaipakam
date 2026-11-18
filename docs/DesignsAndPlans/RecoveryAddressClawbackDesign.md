# Recovery address and clawback for protected accounts (#3246 part 2)

Status: **design, decided by the owner** (2026-11-06, 2026-11-08 and
2026-11-18). Not built. It builds on the protected record each vault holds
([one vault outflow policy](VaultOutflowPolicyDesign.md), Stage B2) and on the
[outflow limiter](OutflowLimiterDesign.md), which already exempts a clawback.
Fresh deploy, no migration. Choices the decisions left open are marked
**Default**.

## 1. The problem

Protected account mode makes a loosening change wait, and lets the owner or
any recovery signer lock the account. A lock is deliberately firm: it drops
every pending change, an unlock is itself a waiting change, and signers
cannot be removed while the account is locked. That is what makes one honest
signer enough to stop a thief who holds the owner key.

The same firmness means a locked account can stay locked for as long as the
people who hold its keys disagree. Protected mode then ends in a stalemate:
nothing is lost, loans can still be serviced, but the free balance cannot
leave. The account needs one exit that no single key can block and no single
key can steer.

## 2. The decisions

| Date | Decision (owner) |
| --- | --- |
| 2026-11-06 | A recovery address and a clawback are added. A recovery address is mandatory to switch protected mode on. A change of address waits 30 days. Positions stay open after a clawback and pay the recovery address. Every clawback leaves a full record. |
| 2026-11-08 | Clawback is manual only: the owner, any recovery signer, or the keeper acting on the owner's linked chat. No automatic or permissionless trigger. The recovery address must prove control by its own signature. Only the owner requests a change; the owner or any signer can cancel it; a lock or a replacement voids it. No contract switch pauses clawbacks while a change is pending. |
| 2026-11-18 | **A lock stays firm, and the clawback is the exit from a locked account.** No rule lets the owner remove a signer who holds a lock, and no lock lapses by time. The conditions in sections 3 and 4 follow from this. |

## 3. The recovery address

### 3.1 What it may be

One address per account, held in the vault's own protected record and read by
the vault itself. Only the owner (the account's manager) sets or changes it.

It may not be the owner wallet, the wallet the account was created for, a
recovery signer, a signer whose addition is pending, the nominee of an open
replacement, or an allowlisted destination. The reverse is refused too:
adding a signer, proposing a nominee or adding an allowlisted destination is
refused, at the request and again when it is finalized, if the address is the
recovery address in force or a pending one.

Setting it, and every change, needs a signature from the new recovery address
itself (a wallet signature, or the contract-wallet form), bound to the chain,
the vault, a nonce for this purpose and an expiry. A request without that
proof is refused, so a typo or an address whose key is already lost can never
become the only place a clawback pays.

### 3.2 The first setting waits

The first setting does not count at once. It comes into force after twice the
account's delay. With protected mode still off, the wait is twice the
shortest delay an account may choose.

The reason: a clawback pays at once. If a first setting counted immediately,
a thief holding the owner key could set an address and claw back in the same
hour, which would go round the delay on wallet outflows. A wait of one delay
opens nothing a direct withdrawal does not already allow; two is the cautious
figure and costs an honest owner one setup wait.

While it is pending, the owner or any signer may cancel it, and a lock or a
replacement drops it, like an allowlist addition.

**Default.** An address comes into force when its wait has passed, with no
second transaction, so an owner who sets an address and walks away is not
left without one. Two things make that safe:

- A pending setting or change is stored with the vault's epoch at the
  request, like an allowlist or signer request. A lock, a replacement and a
  clawback advance the epoch. The read that answers "which address is in
  force" counts a pending one only while its epoch is still the vault's
  current one, so a setting that was dropped can never come into force by
  the passing of time.
- The identity rules of 3.1 are checked from both sides at every request.
  Because a signer, a nominee or a destination equal to a pending recovery
  address is refused during the wait, nothing can have become one by the
  time the address comes into force, and no check is needed at that moment.

### 3.3 Changing it

A change waits 30 days. Until then the current address stays in force and is
the only place a clawback pays; the pending one never counts. The change is
announced on every alert channel. The owner or any signer may cancel it. A
lock, a replacement or a clawback drops it.

### 3.4 Removing it

The address cannot be cleared while protected mode is on, while a signer is
active, or while a signer addition is pending. An account with signers
therefore always has a recovery address in force.

### 3.5 Signers need it

Switching protected mode on needs a recovery address set, pending or in
force, so the first setup is one sitting. Requesting a signer needs the same.
Finalizing a signer needs an address **in force**: without one the addition
is refused and stays pending until it expires. If a pending first setting is
cancelled or dropped, the account has no clawback until an address is set
again, and no signer can be finalized meanwhile.

This is the rule that keeps section 1's promise. An account can only have a
signer able to lock it if it already has the exit.

## 4. The clawback

### 4.1 Who may trigger it

The owner, any recovery signer, or the keeper acting on the owner's linked
chat. Each can act by a direct call or by a signature someone else submits,
like every other write to the protected record. It is one transaction and
cannot be cancelled once sent.

Nobody else may trigger it, and the recovery address itself may not. A cold
key that could pull the account to itself would turn the theft of that one
key into the loss of everything.

Triggering it is safe in any hands that are allowed to: it pays only the
recovery address in force, which no trigger can choose.

### 4.2 What it needs, and what it does not

It needs protected mode on (or an account already replaced, see 4.5) and a
recovery address in force. It refuses while the first setting is still
waiting.

It does not need a signer's co-signature. It does not need the destination to
have verified itself, because the address proved control when it was set. It
does not wait the outflow delay, is not held by the outflow caps and does not
trip the outflow brake. It **runs while the account is locked**, whoever
placed the lock. It does not pass through the queue of waiting payouts, which
a lock cancels; it pays the recovery address directly as its own typed
destination in the vault's outflow policy, and the vault checks that
destination against its own record.

### 4.3 What it moves

The account's free balance of every asset the caller names, and every queued
payout, at once. It can be called again for further assets.

It does not move what is not free. Collateral under a lien and amounts held
for an open position stay where they are until the loan or the position ends;
what is released then pays the recovery address. Position NFTs stay held
under their lock, and what they pay out follows the same rule.

**Default.** The build states whether the backing of an open offer counts as
free (and moves at once) or held (and follows on release). Either way a
recovered account's open offers cannot be filled.

### 4.4 The recovered state

After a clawback the account is locked and stays locked. It opens nothing
new. Every later payout it would have paid its owner goes to the recovery
address. Open positions stay open and settle normally.

Whenever a recovery address is in force, recovered or not, the
paused-platform escape route pays it and not the owner wallet. The vault-side
owner exit keeps its own two routes (#3424).

### 4.5 Replacement

A replacement does not clear or change the recovery address. The replaced
account keeps it, a clawback works on a replaced account, and its trigger
keys are that account's current manager, its signers and the linked-chat
keeper. A change requested after a replacement waits the same 30 days.

## 5. Events and the record

- A first setting, a change request, a cancellation and a drop each emit an
  event naming the account, the address and the time it comes into force.
- A clawback emits one event naming the account, the recovery address, who
  triggered it (owner, signer or linked-chat keeper) and each asset and
  amount moved, beside the vault's usual outflow event.
- Each later payout routed to the recovery address is marked as such.

The account page and an exportable statement show the recovered state and
every amount that went to the recovery address.

## 6. App

- Setup asks for the recovery address before protected mode and before any
  signer, shows when it comes into force, and reminds the owner to keep that
  key cold and safe.
- A locked account's page names the clawback as the way out and shows where
  it would pay.
- While a change is pending, the clawback action names the current
  destination, says it is the address being replaced and that the pending one
  will not be used, and asks for an extra confirmation.
- Alerts go out for every setting, change, cancellation and clawback.

## 7. Tests (acceptance)

1. A locked account, with the lock renewed by one signer on every unlock
   request, is emptied of its free balance to the recovery address by the
   owner's clawback.
2. A clawback before the first setting is in force is refused. A setting,
   protected mode switched on and a clawback in one block moves nothing.
3. No sequence of the owner's own actions makes a clawback pay an address
   requested less than 30 days earlier (twice the delay for a first setting).
   A signer cancels a change; a lock drops it.
4. A signer cannot be finalized without an address in force. The address
   cannot be cleared while a signer is active or pending.
5. The recovery address cannot be, or become, a signer, a nominee, the owner
   wallet or an allowlisted destination, from either side.
6. A replaced account keeps its address and its clawback pays it.
7. Liened collateral and held positions do not move; what they release later
   pays the recovery address.
8. The recovery address cannot trigger the clawback. A caller outside 4.1 is
   refused.
9. The authority-order suite (#3568) includes the recovery address among the
   records whose changes it orders against locks, replacements and delays.

## 8. Residuals

- **The recovery key is stolen as well as the others.** The clawback then
  pays the thief. This is the residual the threat model already states.
- **The recovery key is lost while a signer is hostile.** The owner can
  request a change, but any signer can cancel it and a lock drops it. The
  account stays locked with no exit until the signer relents. Keeping the
  recovery key safe is the owner's part; the app says so at setup.
- **An honest signer cannot stop a clawback.** By design: it pays only the
  address the owner fixed in advance.

## 9. Alternatives considered

1. **The owner may remove a signer who holds a lock, after the delay.**
   Declined. A thief holding the owner key would remove the one honest signer
   the same way, and the lock would stop meaning anything.
2. **A lock lapses unless it is renewed.** Declined for the same reason: the
   thief only has to wait, and an honest signer who is travelling loses.
3. **Accept the stalemate and state it.** Declined: funds frozen without an
   end date is the outcome protected mode exists to prevent.
4. **An automatic clawback after repeated contested changes.** Declined
   (2026-11-08): a contested account always has an honest party who can
   trigger it by hand, and an automatic one could pay an address whose key
   the owner no longer holds.
5. **The recovery address may trigger its own clawback.** Not taken (4.1).
6. **A first setting that counts at once.** Not taken (3.2).

## 10. Recommendation

Build this with #3246 part 2, before any release in which an account can
both have recovery signers and hold value: the signer rule of 3.5 and the
clawback of section 4 are one behaviour and ship together.
