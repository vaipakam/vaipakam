## Security — the recovery claim (PR #<n>)

A protected account can now let its recovery address ask for the account after
a wait the owner chooses, so an account with no signer still has an exit when
its owner key is lost or its owner is gone. The claim is off by default. The
owner switches it on, with a wait of 30 to 365 days between a request and the
earliest run. Switching it on, or shortening the wait, waits the account's
delay like every other loosening change; switching it off, or lengthening the
wait, applies at once, also on a locked account. Switching protected mode off
switches the claim off.

Only the recovery address in force may ask, and not while a change of
recovery address is pending. A request is accepted on a locked account, since
the clawback is the way out of one. Its dates are fixed when it is asked: it
may be run from the end of the wait until 30 days later, when it lapses and
must be asked again. Nothing on the account is frozen while a claim is open. A claim belongs to the address
that asked: once a change of recovery address is in force, the replaced
address's claim is void, and the new address asks for itself, at once and with
the full wait.

The owner or any signer may cancel an open claim at any time before it runs,
also while the account is locked and while the platform is paused. A lock, a
replacement and a clawback each end it. So does any write to the protected
record that the owner's key sends itself, because that shows the key is still
held. A write submitted on the owner's signature by someone else does not: a
signature can be kept and submitted later. After a claim is cancelled or
dropped, a new request waits 30 days, so a stolen recovery key cannot keep
re-alerting the owner; a lapse starts no such wait.

Only the recovery address runs a matured claim. The run is the existing
clawback, unchanged in what it moves and the state it leaves, recorded with
its own trigger value ("recovery claim", 3). The platform refuses the run
while it is paused (escape window or not) and until 24 hours after the end of
the price guard's latest sequencer outage window, failing closed when that
window cannot be read; on a network with no sequencer the check does not
apply. The owner's and the signers' own clawback is unchanged.

The design is `docs/DesignsAndPlans/RecoveryClaimDesign.md`; the clawback
design records the amendment to its "manual only" decision. The alerts for an
open claim are the keeper thread's work and ship disarmed. The app's prompt,
setup warning and recovery-address view follow separately.

Closes #3756

> Caveat: a pause or an outage can cost the last days of a claim's run window; the lapse date does not move.
> Caveat: a stolen owner key can cancel every claim; signers and the clawback remain the defence there.
