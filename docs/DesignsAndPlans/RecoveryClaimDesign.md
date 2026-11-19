# Claim by the recovery address after an owner-set wait: design

**Status:** owner decision of 2026-11-19 ("Yes, owner may switch it on"). Card #3756. Reviewed by the security thread on 2026-11-19: build as designed, with the three additions recorded in section 11. It amends the decision of 2026-11-08 that a clawback is triggered by hand by the owner or a signer only. Design first, no code yet. Built before the pre-audit refactor. Reaches a chain by fresh deploy.
**Related:** `RecoveryAddressClawbackDesign.md` (#3246 part 2), `ProtectedAccountExitDesign.md`, `VaultOutflowPolicyDesign.md`, `PayoutDestinationRuleDesign.md`.
**Base:** the code named below was read on the batch branch of #3743 (`claude/project-thread-ijafuu` at `a067c7bae`), where the recovery address and the clawback are built (`VaultRecovery`, `VaultProtectionBase`). Main does not have that code yet. Section numbers of the clawback design are those of the batch branch's copy.

## 1. Why

A protected account has one exit that no single key can block: the clawback, which pays the recovery address the owner fixed in advance. Today it is triggered by the owner or by any recovery signer.

Many owners will set a recovery address and name no signer. For them the owner key is the only trigger, and two ordinary events leave the account with no exit at all:

- **The owner key is lost.** With no signer there is no replacement of the owner wallet either. The owner still holds the recovery key and can do nothing with it.
- **The owner can no longer act**, for any reason, and the people around them hold the recovery key the owner left them.

In both cases the funds stay in the vault for good. Nothing is stolen, and nothing can be recovered.

## 2. What the user gets

One more setting on a protected account, off until the owner switches it on:

> **Let my recovery address claim this account if I stop responding.** If my recovery address asks for the account and neither I nor one of my signers cancels within the wait I choose, it may run the clawback.

The wait is the owner's choice, from 30 to 365 days.

The claim does nothing a clawback does not already do. It pays only the recovery address in force, moves what a clawback moves, and leaves the account in the same recovered state. The only new thing is who may start it, and how long they must wait.

## 3. The rule

1. **Off by default, and only the owner switches it on.** No governed setting, signer or caller can switch it on for an account.
2. **Only the recovery address in force may ask**, by a direct call or by its own signature. A pending first setting and a pending change of address cannot ask, and while a change of address is pending nobody may ask or run a claim.
3. **The claim waits the owner's wait, counted from the request.** Nothing moves and nothing is held back during the wait: the account works exactly as before.
4. **The owner or any signer cancels it**, at any moment before it is run, in one step.
5. **Anything that shows the owner or a signer is acting on the account's protection drops it**: a lock, a replacement, a clawback, and every change to the protected record that the vault authorizes as the owner's own.
6. **When the wait has passed, only the recovery address runs it**, within 30 days. After that the claim lapses. A run is refused while the platform is paused and for 24 hours after a sequencer outage, because the owner could not have answered then.
7. **What runs is the clawback**, unchanged, recorded with its own trigger so the record shows it was a claim.

## 4. Design

### 4.1 The setting

Held in the vault's own protected record, beside the recovery address.

| Setting | Meaning | Bounds |
| --- | --- | --- |
| Claim allowed | whether the recovery address may ask | off by default |
| Wait | the time between the request and the earliest run | 30 to 365 days |

- **Who sets it:** the owner (the account's manager), like every other protected setting.
- **It needs** protected mode on and a recovery address set, pending or in force, so a first setup is one sitting.
- **Switching it on, and shortening the wait, are loosening changes.** Each waits the account's delay, may be cancelled by the owner or any signer, is refused while the account is locked or in a cool-down, and is dropped by a lock, a replacement or a clawback, like an allowlist addition. Until the change is in force the old setting applies.
- **Switching it off, and lengthening the wait, are immediate**, and are accepted while the account is locked, since they only tighten.
- **Switching protected mode off switches the claim off.** A clawback needs protected mode on, so a claim could not run anyway, and an owner who switches protected mode on again chooses afresh.
- **A recovered account** has nothing left to claim. The setting cannot be changed there and no request is accepted.

Switching the claim on gives a holder of the owner key nothing new: the owner can already trigger a clawback at once. The delay on switching it on is kept so one rule covers every loosening change.

**What an owner does when the recovery key is no longer safe.** Two steps, which the app offers as one action:

1. **Switch the claim off.** It is immediate, it drops any open claim, and from then on the old key can ask for nothing. Only the owner can switch the claim on again, and that waits the delay. This step alone is the guarantee, and no signer can undo it.
2. **Request a change of recovery address.** While the change is pending, a request and a run are both refused (4.2, 4.5). Once it is in force the old address is no longer the one that may ask.

The second step without the first is not a guarantee, and the design does not claim it is: a signer may cancel a pending change of address, as the clawback design allows, and the old address then stays in force and may ask again. So an owner who wants the claim back with the new address switches it on only after the change is in force.

The floor of 30 days matches the wait of a change of address, so the shortest claim is no quicker than the slowest other way of redirecting a clawback.

### 4.2 Asking

`requestRecoveryClaim(auth)`, authorized as the recovery address in force.

- Refused when the claim is not allowed, when the account is recovered, when a claim is already open, during the pause of 4.4, while a change of recovery address is pending, and when the caller is not the recovery address in force.
- **Accepted on a locked account.** The clawback is the exit from a locked account, and an owner who locked the account and then lost the key is exactly the case this serves.
- It records who asked, the time, the time it may first be run (the request plus the wait in force at the request) and the time it lapses (30 days later), together with the vault's epoch.
- It emits an event with all four, and the alerts of 4.6 start.
- A later change of the wait does not move an open claim's dates. A change by the owner drops the claim in any case (4.4).

### 4.3 The wait

Nothing is frozen, held or delayed because a claim is open. The owner lends, borrows, withdraws and changes settings as before. A claim that could restrict the account would hand the holder of a stolen recovery key a way to interfere with it.

### 4.4 Cancelling, and what drops a claim

- **Cancel:** `cancelRecoveryClaim(auth)`, by the owner or any signer, by a direct call or a signature, on the cancel lane the other pending changes use. It works while the account is locked and at any time up to the run, including after the wait has passed.
- **A cancel always works.** The cancel, and every owner write that drops a claim, must be accepted while the platform is paused and during an escape window. A pause called for an incident must never let a claim mature while the owner is unable to answer it.
- **Dropped by a lock, a replacement or a clawback.** Each advances the vault's epoch, and a claim counts only while its epoch is the vault's current one. The person who locks, replaces or claws back is someone who may cancel. The epoch alone records no time and announces nothing, so the one shared step that advances the epoch also ends an open claim through the same helper a cancellation uses: it starts the pause below and emits the drop event.
- **One helper ends a claim.** A cancellation, an owner write and an epoch advance all end a claim through it, so each of them clears the claim, starts the pause and emits the event, and none can forget one of the three.
- **Dropped by the owner's own writes.** Every write to the protected record that the vault authorizes with the owner's key drops an open claim, whether the step is the owner's alone or one a signer may also take (in the code read, `_asOwner`, and `_asOwnerOrSigner` when the key is the owner's): a settings change, an allowlist or signer request, a change of recovery address, switching the claim off. An owner who signs any of these holds the owner key and is acting on the account, which is what the claim asserts is no longer true. A signer's writes other than a lock and a cancellation of the claim itself drop nothing: they say nothing about the owner. Two limits keep this from being used against a claim. Only a step authorized with the owner's key **at that call** drops one: a step anyone may call that brings an earlier pending change into force (settling an address, finalizing a signer) drops nothing, or a stranger could end a claim by finalizing something old. And an old or replayed owner signature is refused by its nonce, as today, so it cannot be kept back and used later to drop a claim.
- **The linked-chat hold drops nothing**, as today: it is a lapsing hold that cancels nothing.
- **Using the platform does not drop a claim.** Lending, borrowing, repaying and withdrawing are not writes to the protected record, and the vault does not treat them as an answer to a claim. The alerts and the app's prompt (4.6) are how an active owner learns of one. Section 7 lists counting any activity as an alternative.
- **The pause after a cancellation or a drop.** A new request is refused for 30 days. It keeps a stolen recovery key from asking again the moment a claim is cancelled, so the owner and the signers are not alerted over and over. A claim that merely lapsed (4.5) starts no pause.

Each cancellation and each drop emits an event naming the account, who acted (or which step dropped it) and the time a new request is accepted.

### 4.5 Running it

`runRecoveryClaim(assets, auth)`, authorized as the recovery address.

- Accepted from the time the wait has passed until the claim lapses 30 days later, while the claim's epoch is the vault's current one and the caller is still the recovery address in force.
- **Refused while a change of recovery address is pending.** With the rule of 4.2 this makes the protection of 4.1 rest on a check, and on no arithmetic between two waits.
- **Refused while the platform is paused.**
- **Refused until 24 hours after the latest sequencer outage ended**, on a network that has a sequencer, read from the price guard's outage window, the source the loan clock already uses. During an outage the owner cannot send a cancel, so the claim does not complete on the first block after one.
- The lapse date does not move for a pause or an outage. A claim whose last days are lost to one lapses, and the recovery address asks again and waits again. Section 8 states this.
- **Only the recovery address runs it.** It is not open to any caller. The step cannot be undone, and requiring the recovery key at this moment shows the key is still held at the end of a wait that may have lasted a year. No keeper runs it and no keeper flag is needed.
- It runs the clawback of the clawback design's section 4 with no change to what moves (4.3 there) or to the state it leaves (4.4 there): the free balance of the assets named and every queued payout go to the recovery address; liened collateral and held amounts follow when they are released; the account is locked and recovered for good; position tokens stay with the account and what they pay reaches the recovery address; the permissionless sweep moves later arrivals.
- Whatever screens the clawback applies to its destination apply unchanged.
- It is recorded with its own trigger value, "recovery claim", beside "owner" and "signer" (and the value reserved for the linked chat), in the `AccountRecovered` event and in the Diamond's clawback record.
- Later calls for further assets on the now recovered account are the existing clawback's, by the owner or a signer, and the existing sweep's, by anyone.
- **A lapsed claim is void.** The recovery address may ask again at once, and waits the full wait again. Without a lapse a matured claim would stand for ever as a way to take the account at once with one key.

### 4.6 Alerts and app

- **Alerts.** A request is announced on every channel the account has, to the owner and to every signer: at the request, at the half-way point, seven days before and one day before the claim may be run. A cancellation, a drop, a run and a lapse are announced too. The keeper's protected-account alert pass carries them, under its existing arming flags, which ship unset.
- **Whether alerts are being sent is stated, never assumed.** The alerts are an operator's service and can be off on a deployment. The app reads the deployment's alert status from the service that sends them and shows one of three answers wherever the claim setting appears: alerts are being sent; alerts are not being sent on this network; or the status could not be read. It never shows the reminder schedule as something the owner will receive unless the first answer was read.
- **The owner's and the signers' app.** While a claim is open, every page shows a prompt that cannot be dismissed without an answer: the recovery address has asked for this account, the date it may be run, and one action, "Cancel the claim". The owner's prompt also offers "Cancel and switch the claim off".
- **Switching it on.** The setup shows the wait, proposes 90 days, and states section 8 before the owner confirms. Where the account has no alert channel linked, or alerts are not being sent on this network, or that could not be read, it says that the app's prompt will then be the only notice, offers to link a channel where that would help, and does not continue until the owner has ticked a separate acknowledgement that they will hear of a claim only by opening the app. An account with the claim on shows the same warning for as long as any of the three is true, so an owner learns when alerts stop after setup.
- **The recovery address's app.** A wallet that is the recovery address of an account sees that account, whether a claim is allowed and the wait, and "Ask for this account". With a claim open it shows the dates and, once the wait has passed, "Run the claim" with the same confirmation a clawback asks for.
- **Indexer.** The setting and claim events, and a lookup from a recovery address to the accounts that name it.
- **Views.** One read returns: whether a claim is allowed, the wait, a pending change of either with its time, and for an open claim who asked, when, when it may be run and when it lapses, plus the end of a pause.

## 5. Contract changes

| Where | Change |
| --- | --- |
| Protected record (vault storage) | The claim setting, the wait, a pending change of them, the open claim (requester, times, epoch) and the end of the pause, appended to the record. |
| Vault recovery code | Set the claim setting, ask, cancel, run, and the read of 4.6. The run reaches the existing clawback with the new trigger value; what the clawback moves and records is not copied. |
| The owner's authorization step | Ends an open claim through the shared helper (4.4). One place, so no setting forgets it. |
| The step that advances the epoch (lock, replacement, clawback) | Ends an open claim through the same helper, so the pause starts and the drop event is emitted. The claim is also tied to the epoch, as a second check at the run. |
| The identity rules of the recovery address | Unchanged. |
| Pre-deploy checks | The storage-layout golden file rewritten; the code-split test of the clawback design (its test 13) extended to the new endpoints; sizes of both vault code contracts measured, and a further code contract split off along the claim's seam if either has no room. |

Nothing here is a step any caller may take, so no keeper pass submits a transaction and the permissionless-steps ledger gains only rows that record a caller gate.

## 6. Tests

1. Off by default: a request on a fresh protected account is refused.
2. Switching it on waits the account's delay; a signer cancels it; a lock drops it; a request before it is in force is refused. Switching it off and lengthening the wait are immediate; shortening waits the delay and the old wait applies until then.
3. Only the recovery address in force may ask: the owner, a signer, a stranger, a pending first setting and a pending change of address are each refused.
4. A claim cannot be run before the wait has passed, and cannot be run after it lapses; the dates in the event match.
5. The owner cancels; a signer cancels; each works on a locked account and after the wait has passed. A stranger and the recovery address cannot cancel.
6. A lock, a replacement and a clawback each drop an open claim, each emits the drop event and each starts the 30-day pause, including a lock placed by a signer. The linked-chat hold does not.
7. Each kind of owner write to the protected record drops an open claim. A withdrawal, a loan and a repayment do not.
8. After a cancellation or a drop, a new request is refused for 30 days and accepted after. After a lapse it is accepted at once.
9. The owner switches the claim off while a claim is open: the claim is dropped and no action of the recovery key, of a signer or of a stranger opens or runs one until the owner switches it on again and the delay has passed. Separately, the owner requests a change of address with the claim left on: the claim is dropped, a request is refused while the change is pending, and after the change is in force only the new address may ask; and where a signer cancels that pending change, the old address may ask again after the pause, as section 4.1 states.
10. A run by anyone other than the recovery address is refused, matured or not.
11. A run moves exactly what the owner's clawback of the same account would move, pays only the recovery address in force, leaves the account locked and recovered, and records the "recovery claim" trigger.
12. A claim asked on a locked account, with no signer and no owner action, runs after the wait.
13. Nothing is restricted while a claim is open: a withdrawal, a new loan and a settings change each behave as on an account with no claim (the settings change also drops the claim).
14. Switching protected mode off switches the claim off; switching it on again leaves it off.
15. A recovered account: the setting cannot be changed and a request is refused.
16. A change of recovery address is pending: a request is refused. The run's own check refuses too, shown by a harness that leaves a claim open across a change request, since the owner's request would otherwise have dropped it. Once the change is in force, only the new address may ask.
17. With the platform paused, and during an escape window: the owner's cancel, a signer's cancel and an owner write each still end an open claim; a run is refused.
18. A sequencer outage ends: a run is refused for the next 24 hours and accepted after; on a network with no sequencer the check does not apply.
19. A step anyone may call that brings an earlier pending change into force does not drop an open claim. An owner signature already spent, or one for an earlier nonce, is refused and drops nothing.
20. A replaced account: the claim works under its current manager as on any other, and the retired wallet can neither cancel nor change the setting.

## 7. Alternatives considered

1. **Keep the clawback manual only** (the decision of 2026-11-08). An account with no signer has no exit when its owner key is lost or its owner is gone. Reopened by the owner on 2026-11-19 for that reason.
2. **Require every protected account to name a signer.** A signer can already trigger a clawback. It would force every owner to find a second person or device before using protected mode, and a signer who is gone as well leaves the same gap.
3. **The recovery address may claw back at once.** Not taken in the clawback design and not taken here: the theft of one cold key would be the loss of the account.
4. **A wait fixed by the platform.** Simpler, but the wait is the owner's protection against a stolen recovery key and owners differ in how often they look. The owner sets it inside a floor and a ceiling.
5. **Anyone may run a matured claim, backed by a keeper.** It would complete a claim without the recovery key online a second time. Not taken: the step cannot be undone, and the second use of the key shows it is still held. It also keeps the feature free of any step a stranger can take.
6. **Count any activity by the owner as a cancellation** (a loan, a repayment, a withdrawal). Closer to "if I stop responding", and it would protect an owner who never sees an alert. Not taken for the first version: those steps run through many entry points outside the vault's protected record, and a rule that some of them forgot would be worse than a rule that names what counts. Kept for later, as one check at the vault's outflow step if it proves needed.
7. **Freeze wallet outflows while a claim is open.** Not taken (4.3): it would let the holder of a stolen recovery key interfere with the account.
8. **No pause after a cancellation.** Each new request waits the full wait, so the pause adds no safety by itself in most cases. Kept because it stops repeated alerts.
9. **A cancel from the owner's linked chat.** A cancel only tightens, like the chat's hold. Left to the keeper mandate work (#3353), under its own grant.

## 8. What this does not do, stated to the user

- **It is no defence against a stolen owner key.** Whoever holds the owner key can cancel every claim, for ever. Signers and the clawback are the defence there, as before.
- **A stolen recovery key can take the account if nobody cancels in time.** With the claim off, a recovery key alone can do nothing. With it on, the wait and the alerts are the protection. Choose a wait longer than the longest time you go without looking.
- **Alerts can fail, or be off.** A channel can be unlinked, muted or missed, and the alert service can be switched off on a network. The app says which is the case when it can tell. The app's prompt appears only when the owner or a signer opens the app.
- **Changing the recovery address does not by itself stop the old key.** A signer can cancel a pending change. Switching the claim off is what stops it (4.1).
- **Using the platform is not an answer to a claim.** Only cancelling it, or changing a protected setting, stops it.
- **Any signer can cancel every claim.** An account whose signer cancels each time stays as it was before this setting existed. That signer can trigger the clawback directly.
- **The platform does not judge who should receive an account.** It does not know why an owner is silent. The claim goes to whoever controls the recovery address, and to nobody else.
- **It cannot be undone.** After a run the account is recovered for good: locked, opening nothing new, and paying the recovery address.
- **Open positions are not closed.** They run to their end and pay the recovery address as they settle.
- **The setting is public.** Anyone can read on-chain that an account allows a claim, and the wait. It therefore shows which accounts depend on their owner answering within a known time.
- **A pause or an outage can cost the last days of a claim.** A run is refused while the platform is paused and for 24 hours after a sequencer outage, and the 30 days in which a claim may be run are not extended. A claim that lapses this way is asked again and waits again.
- **The recovery key is needed twice**, to ask and to run, as well as when the address was set.

## 9. Changes to the clawback design when this is built

The builder applies these to `RecoveryAddressClawbackDesign.md` on the branch that carries the code:

- **Section 2:** a row for 2026-11-19: the recovery address may trigger the clawback after an owner-set wait of 30 to 365 days, only where the owner switched it on; this amends "manual only" of 2026-11-08.
- **Section 4.1:** "the recovery address itself may not" becomes "the recovery address itself may not, except by a claim the owner allowed, after the owner's wait (`RecoveryClaimDesign.md`)". The reason given there stands for an immediate trigger.
- **Section 8:** the first residual gains: with a claim allowed, a stolen recovery key alone can take the account if neither the owner nor a signer cancels within the wait.
- **Section 9, alternative 5:** marked as taken in this bounded form.

## 10. Recommendation

Build it as designed: one setting and a wait in the protected record, a request by the recovery address, a cancel by the owner or any signer, a drop on every act of the owner on the record, and a run by the recovery address that is the existing clawback with one more trigger. Ship the alerts with it; a claim nobody hears about is the one risk the feature adds.

## 11. Settled with the security review (2026-11-19)

1. **The owner-write drop** (4.4): agreed, on the two limits stated there. Only a step authorized with the owner's key at that call drops a claim, and spent signatures stay refused.
2. **One account delay for switching it on** (4.1): enough. It gives a holder of the owner key nothing new.
3. **A pending change of recovery address** refuses both the request and the run (4.2, 4.5). Required.
4. **Pause** (4.4, 4.5): the cancel and the dropping writes work while the platform is paused and during an escape window; the run is refused while paused. Required.
5. **Sequencer outage** (4.5): the run waits 24 hours after the latest outage ended. Required.
6. **Statements** (section 8, 4.6): a stolen owner key cancels every claim; switching on with no alert channel needs an explicit acknowledgement; the public setting shows which accounts depend on the owner answering.

## 12. Open with the builder

1. **Room in the vault code.** Whether the recovery code holds the new endpoints or a further code contract is split off.
2. **The owner's authorization step.** Confirm that one place covers every owner write to the protected record, including the owner's direct calls and signed ones.
3. **The alert schedule.** Whether the keeper's alert pass can hold the four timed reminders with its present state, or needs a small table of its own.
4. **Reading the pause and the outage window from the vault's code.** The vault's protection code runs in the vault, and both facts live with the Diamond and the price guard. The builder chooses the read; the run fails closed if either cannot be read.
