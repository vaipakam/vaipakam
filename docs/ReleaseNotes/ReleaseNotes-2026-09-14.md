# Release Notes — 2026-09-14

Seven entries. The first two are the #1566 slice-4 pair, and they belong
together: the first lands the whole custody-holder lifecycle dark — the
holder itself, its replacement ceremony, the recoveries for value that
reaches a holder by no protocol path, and the paid-side rebase that chains
carrying history need — and the second switches reward custody onto it.
The dark change settles the shape of the irreversible steps around the
holder, and the safeguard each one carries differs, so they are worth
stating separately. Replacing the holder and sweeping its unattributed
remainder to the treasury require the platform's manual pause. The
paid-side rebase and the older seed require that manual pause and also
refuse a stale pause-transition count — a count the platform now keeps —
so no tooling can pair a stale operator answer with whatever pause happens
to be in force. The administrator-only recoveries of a foreign token,
native currency, an NFT or predecessor VPFI carry no pause gate at all;
each is verified at both ends of the move instead. The in-place refresh
that carries all of this pauses as its first transaction, simulates every
chain before broadcasting to any, and restores service only through an
unpause that checks, by that same count, that nothing else touched the
pause meanwhile. The one gate this change deliberately leaves off chain —
pausing the facet cuts themselves — is tracked as #2179.

The cutover is behind a per-chain activation rather than a facet cut, and
the activation refuses until several things are true at once: an
administrator holds the manual pause and names the pause count the
figures were taken under; the paid-side migration has run; a canonical
chain has armed per-receipt recovery attribution — the refresh's own
migration, without which a canonical activation refuses after everything
else is in place, which is why the ceremony's pre-flight checks it before
anything is sent; every position the address must back is settled —
exactly backed, or for a mirror's imported headroom either funded up to
the figure or written down to what the address backs; and the
deployment's whole facet routing is the one a complete refresh or deploy
recorded — so the custody surface cannot be switched on ahead of the reward paths
that read it, short of an administrator recording a partial routing as if
it were complete. From the facet refresh itself — before the activation, not only after
it — the canonical chain pays fresh rewards only out of what has been
funded into the address minus what has been paid, while recycled rewards
keep paying from the recycled runway, which is backed separately; and
since nothing can be funded until the activation, a canonical chain
refuses fresh rewards in the window between the refresh and the
ceremony, which is why that window is meant to be spent paused.
Every payout leaves the address by its fresh and recycled parts; an
ordinary remittance leaves by the same two parts and is charged against
the delivered ledger by its fresh share, while a redispatch funded from
the recovery position is debited from that position — through it alone,
by the full redispatched amount — and is not charged against the
delivered ledger again, its original outflow having been charged already. Where custody has moved onto the address, the mesh watcher checks the
address's balance against its attributions exactly and treats a balance
it cannot read as a critical finding rather than as zero; before the
activation it keeps applying the older relation to the platform's own
balance. Six review rounds
shaped it, and what they added is in the entry: the restitution position's
two exits, the release that reconciles a position a moved figure left
over-backed, the complete-cut record, and the expiry clock reading the
address rather than the platform's own balance.

The next four entries are the day's work on the live-drive tooling —
the scripts that exercise the deployed app and testnet after a deploy.
Each is about a verdict that had been silently wrong: a drive that did not
finish is now reported as not fully reviewed — its earlier results kept,
its later surfaces unexamined — rather than as passed or failed; a
write whose confirmation could not be read from a lagging endpoint is no
longer reported as a failed write; a screen whose opening timed out now
says so instead of hiding among the other ways a screen fails to load; and
the seven rules that each worked out what a name holds now share one
resolver that answers in three states, including "could not tell".

The last entry is a different kind of correction: not a verdict that read
wrongly, but records the platform had stopped checking at all. The index
learned that a loan was over only by seeing it announced, so an
announcement it missed was missed for good — and nothing afterwards ever
compared its own list against the chain's. Measured on the test network the
morning this was written, three positions were being published as running
that had already ended, one of them since early July. It now checks, and
the entry is mostly about what a correction declines to claim: it cannot
tell when a loan ended and does not pretend to, cannot always tell how, and
will not address a message to a holder it cannot establish.

## #1566 slice 4 PR A — a dedicated custody address for delivered reward funding, deployed dark (PR #2158)

The reward funding delivered to a chain used to sit in the Diamond's own token
balance, beside every other VPFI the Diamond touches. Slice 4 of the #1566
design moves it to a dedicated custody address the Diamond owns, so that what
backs reward payouts is one balance an observer can read and no other path can
spend by accident. This first of three slice-4 changes puts that address and
its lifecycle in place without moving any value: no payout, gate or funding
path reads it yet, and no protocol writer can fund it yet. Its address is
public, so an unsolicited token transfer into it is possible at any time;
such value is not custody the ledger describes and operators must not read
the dark holder as necessarily empty. In the configured reward token it shows
as the unattributed remainder in the read surface and moves along at a
replacement, with no attribution path in this change; in any other token,
including a former reward token after a rotation, it is invisible to the read
surface and would stay behind at a replaced holder, so an administrator can
recover such a token from any holder the platform constructed to the
treasury, and only to the treasury, through an audited sweep that refuses the
configured reward token itself and reports what the treasury actually
received beside what was requested — while every recovery from a holder, of
any asset, is refused unless the holder was debited by exactly what was
released, so a token that credits without debiting can never be reported as
recovered. Native currency forced into a holder,
which accepts none by itself, is likewise reported and recoverable to the
treasury the same way — refused if the holder's own balance did not fall by
exactly the amount, so a treasury that forces value back cannot turn a sweep
into a repeatable report — and so is an NFT that reached a holder: a constructed
holder refuses a safe transfer of one, but a non-safe transfer, or delivery to
the holder's predicted address before it exists, still lands there and nothing
else could ever move it, so an administrator can recover a single-token NFT or
multi-token units from any platform-constructed holder to the treasury only —
and a single-token recovery is reported only after the token reads as owned by
the treasury, so a token that did not move is refused rather than reported.
Every token recovered to a platform that is its own treasury is credited to
the treasury's tracked balance, the one its claim path releases, so nothing
recovered sits unclaimable in the platform's raw balance; native currency and
NFTs have no such claim or withdrawal path on a platform that is its own
treasury, so those recoveries refuse that destination outright — the asset
stays at the holder, releasable to an external treasury — rather than strand
it, and the platform stays closed to every inbound NFT. A refresh that found
the platform live restores service at the end through an unpause that itself
checks, on chain, that nothing else touched the pause state during the run — a
pause raised meanwhile, by a watcher or by a person, makes that unpause refuse
and is left in force for a fresh decision; to make that hold, a watcher's
automatic pause raised while the platform is already manually paused is now
recorded as a pause transition (its window noted, its event emitted) instead of
being silently ignored, though an already-active automatic window is still
never extended. A single-token recovery also refuses a token
the named holder does not own, so a token already with the treasury can never
be reported as recovered from a holder.
The sweeps act only on holders the platform itself
constructed, kept in a registry that includes every predecessor, never on an
address that merely claims to be one. The configured reward token sent to a
retired predecessor after its replacement is brought back into the bound
holder, where it shows as the unattributed remainder, rather than left
trapped — a move verified at both ends exactly as a replacement is: the bound
holder must grow, and the retired predecessor must be debited, by precisely
the amount moved, so a token that credits without debiting can neither strand
value at a replacement nor report a recovery that moved nothing. The bound
holder's own unattributed remainder — configured reward token that reached its
public address outside any writer, which nothing describes and which would
otherwise roll forward through every replacement — can be moved to the
treasury by an administrator under the manual pause, never beyond what no
ledger row describes, so attributed custody is never reachable that way and
the token-rotation runbook's drain-to-zero step stays possible; in that move
the treasury must grow, and the bound holder must be debited, by precisely the
amount moved — no retired holder takes part. A fresh deployment
constructs and binds its holder while still paused and records the address in
the deployment artifact; a live chain gets one through a dedicated one-shot
script after the facet refresh, because a refresh must never deploy or
re-point a holder. The platform constructs its own custody
holders; no externally supplied address is ever accepted as one, so nothing
can be imitated. Replacing a holder is its own paused ceremony: the successor
is created, the old holder's whole balance moves into it and the Diamond's
pointer flips in the same transaction, refusing if the successor did not grow
by exactly what was released or the previous holder did not end up empty. Value someone sent ahead of time to the
address the successor would take is reported as unattributed rather than
allowed to block the ceremony.

The holder keeps no ledger. Which part of its balance is live fresh funding,
recycled value, a stranded recovery, a Detached era's pending surplus and so on
is recorded in Diamond storage, credited and debited only by the Diamond; those
writers arrive with the cutover change, so on this change every row reads zero
and the read surface says when a balance cannot be read at all, including when
the configured token cannot answer, rather than reporting it as empty. Keeping the ledger out of the holder is what makes the
holder replaceable at any size.

The change also lands the paid-side migration the design requires for chains
carrying history that closure 2 now charges: a paused, admin-only, one-shot
rebase that installs a reconstructed absolute total as a floor, never lowering
what the counter already holds and never accepting a figure, requested or
resulting, above what the reward pool can ever pay out — the older additive
seed is bounded the same way, and on the canonical chain sets the received
side to the same figure so a no-provenance deployment starts from zero headroom
rather than negative headroom. It consumes the older additive seed as well as
its own guard, so a stale seed can never add historical value on top of an
absolute total. A fresh deployment consumes both guards at deploy, exactly as
the seed already was, so neither migration writer can run on a chain with no
history to import. The in-place facet refresh runs the rebase itself while the
Diamond is still paused, after the reward-role backfill and before service
resumes, and refuses to default the figure: the operator states the
reconstructed total or declares there is none. Every answer to a due
migration — the older seed, this total, or a declaration that there is no
history — is bound to the pause it was established under: the platform now
counts every pause-state transition (a count a lift-and-reapply moves even
inside one block, where a timestamp could not tell the two apart), the
operator states the count at which the answer was established under the
manual pause, and the rebase — and the older seed alike, which is now bound
to the manual pause and its epoch exactly the same way — refuses a stated
count that is no longer the live one, so no tooling can pair a stale answer
with whatever pause happens to be in force. The multi-chain pre-flight refuses to proceed for a
chain with a migration due unless the platform is already under its manual
pause (read directly, so a manual pause beside a watcher's automatic window
counts) at the stated count, the refresh refuses again before its first
transaction and immediately before each broadcast, and it never pauses on
the operator's behalf over a due migration. The refresh itself pauses as its
very first transaction, before any implementation is deployed; a chain it
found paused is left paused and reported as such — user operations stay
disabled until a fresh unpause decision — never as ordinary completion, and a
chain whose pause state cannot be read afterwards, or that sits under an
automatic pause window, is reported as not live rather than as restored. On
the first in-place rollout of this change the platform does not yet count
pause transitions, so no pause made before it can be pinned: that run cuts
every part of the refresh except the two paid-side migrations — the facet
cuts, the removal of retired functions, the proxy upgrades and the
reward-role record all run — and defers only the seed and the rebase,
demanding no migration answer for that run; a second run — after pausing
again under the new code and establishing the answer under that pause —
carries them, so no migration is ever sealed against a pause that could not
be shown continuous. A function this change retires — the older seed's
previous form — is removed from an upgraded platform in the same refresh and
verified gone, so it cannot survive routed to code that checks neither the
pause nor its epoch. The refresh
always sends its pause as the very first transaction, so the facet cuts run
under it by transaction order; an unpause slipped between two of its
transactions could still expose a mixed facet set for the rest of the run,
which is why the irreversible steps, not the cuts, are the ones the platform
gates on chain — gating the cuts themselves on chain is tracked separately
as #2179. The
pre-flight also checks, before any broadcast, that the signer can perform the
post-refresh holder binding wherever one will be needed. The
refresh also decides a deferral from what it reads rather than by calling
into a refusal, so a deferred rebase on a detached chain never puts a failing
transaction on the broadcast — and the multi-chain
pre-flight refuses, before any chain broadcasts, a stated total, a stated seed
or an already-recorded paid counter above what the reward pool can ever pay
out — and, where that counter can be read, the seed's own predicate, the
counter plus the seed within the cap — so a later chain's refusal can never
land after earlier chains have already completed their irreversible
refreshes. Beyond those explicit checks, the multi-chain refresh now simulates
every selected chain's whole refresh against its live state before the first
broadcast on any chain, so each refusal the refresh can raise on chain is
exercised at that chain's state at simulation time, with nothing sent — a
per-chain validation at a point in time, not a cross-chain guarantee: state
that changes between the simulation and a later chain's broadcast can still
refuse that chain; a change caught by the re-simulation immediately before
sending refuses before that chain sends anything, while a failure during the
broadcast itself can leave that chain partially refreshed and paused, and the
run says so rather than claiming nothing was sent, naming the broadcast journal
to inspect, the chains already complete, and the command to resume for the
remaining chains. A simulation
writes nothing to the deployment record, enforced at the single place every
record write goes through rather than script by script; the one deliberate
exception is the ceremony record step's single reconciliation write, made
through a dedicated writer for that one field so that no setting an
environment could carry can widen the exception to any other write.
The relation between a chain's bound holder and its deployment record is
classified before any broadcast by the same rule the post-refresh step
applies, so a record that names a different holder than the chain, with no
ceremony record to explain it, refuses the run before anything is sent — and a
holder state that cannot be read at all, for any reason other than the platform
not yet routing the getter, refuses the run rather than reading as absent; a
pending ceremony record is accepted as the explanation only after the ceremony
script itself validates it, the same way the record step will; and a bind
record left by a staged or direct bind that never executed, over a chain that
reports no holder, refuses the run before anything is sent, since the one-shot
bind refuses to run over such a record and would otherwise only say so after
the refresh had broadcast. A direct
ceremony's pending record names only what its run can know — the deployment,
the mode and the block it was prepared against — never an inclusion block,
which is proven by the record step from live chain state. On a chain whose reward role is
inactive the rebase accepts only a history-free chain, meaning nothing to
import and nothing on either the paid or the received side; a detached chain
carrying history on either counter keeps its guard open until it is
re-attached, so the baseline is never installed under the wrong role — and
only a detached chain's refusal is treated as that deferral: a chain with no
reward role at all that carries history has no re-attachment ahead of it and
keeps paying meanwhile, so its refusal stops the refresh, paused, for an
explicit decision. The record step of a replacement accepts a ceremony record
only if the predecessor it names is the deployment record's current holder, so
a stale or corrupted record can never confirm a replacement that never
executed. Replacing a holder, and the paid-side rebase, require the platform's MANUAL
pause and refuse under an automatic, time-bounded watcher pause alone — enforced
by the platform itself whatever path the call arrives by, since such a pause
lapses on its own and service would resume by no one's decision after an
irreversible step; the in-place refresh therefore proves the manual pause or
sets it before its migrations, and a refresh begun under an automatic pause
leaves the platform paused for a fresh decision. Replacing a holder is run
through its own script, which leaves a pending ceremony record; the
deployment record's holder address is rewritten by the separate record step
after the transactions have confirmed, so no later tool reads the emptied
previous address as custody once that step has run, and later ceremonies
refuse to proceed until it has. In every mode the deployment
record is reconciled by a separate record step from live chain state after the
transactions have confirmed, never from the ceremony's own simulated result,
so a rejected or interrupted broadcast can never leave the record pointing at
a holder that was never bound. Before governance handover the script runs the
ceremony directly; after handover, where pausing and administration sit with
different signers, it stages the two calls for those signers — the pause is always executed
immediately before the replacement, whatever the state was at staging, since
a time-bounded automatic pause can lapse and an authorised unpause can resume
service while the delayed call waits — and a final record step reconciles the
deployment record only once the platform reports a new holder as bound.
In neither mode does the ceremony resume service: a replacement leaves the
platform paused, and unpausing stays a fresh decision, because a ceremony
that lifted the pause could also lift an unrelated emergency pause raised in
the meantime. The one-shot initial binding on a live chain follows the same
direct-or-staged shape, so a handed-over deployment can bind its holder
through its signers and reconcile the record afterwards. The multi-chain
refresh wrapper carries the rebase figure per chain, exactly as it carries the
older seed, and refuses to run a chain whose figure is not stated. Refs #1566, #1349, #1956.
<!-- assembled-fragment: 1566-slice-4a-custody-holder.md sha256=403958adcc79b6de5191e7a4f7db78ec1bb39cc4961f7c2ea3af57fcaecee3f8 -->

## #1566 slice 4 PR B — reward custody moves onto the dedicated address (PR #2186)

The first slice-4 change bound a dedicated custody address per deployment
and left it dark. This change switches reward custody onto it: once an administrator runs the activation ceremony — an
administrator-only call, taken under the manual pause and bound to the
pause count the figures were established at (under governance the pause
is the pauser's act and the activation the timelock's, which the staged
form of the ceremony keeps apart), and only when every position the
address must back is settled: the recycled runway, the recovery position
and the overage quarantine must each equal their figure exactly — a position whose remaining
shortfall is zero takes no answer, and one with a shortfall refuses
without one, so a retried ceremony states only what is still missing —
and a mirror's imported delivered headroom is settled by one of two
recorded choices — funding the position up to the imported figure, or
writing the figure down to what the address actually backs, after which
the written-down figure is what bounds claims; and the address's balance
in the configured token must be readable and must cover the total of
every attribution, or the activation refuses whatever the rows say —
every reward read and debit goes through the address's attribution rows instead of the platform's own
token balance. A
single-chain deployment with no reward role never activates and behaves
exactly as before, and a detached deployment waits for the era registry
that gives its inbound packets a rule. Backing a position ahead of the activation is itself an
administrator-only action taken under the manual pause, and it waits for
the paid-side migration whose result the figures depend on. It takes one
of two forms, each a different disposition of funds: replacement funding
the administrator supplies from their own tokens, or a relocation of the
platform's own historical inventory into the address — which the
ceremony refuses without a stated provenance record, and which is never
permitted for a mirror's imported headroom, since that history is not
money; a position
that a moved figure leaves over-backed before the activation can be
released back to the platform's own balance — by an administrator, under
the manual pause, by at most the excess, and to no other destination — so
nothing is stranded at the address. Activation and the
backing of a position also require the deployment's whole facet routing —
every installed facet and every function it serves — to be the one a
complete refresh or deploy recorded, so a partial refresh cannot switch custody onto the address while a
reward path that does not know it is still installed or a required one
has been removed. That record is the complete refresh's own attestation
of the routing it installed, bound to that routing so any later change
invalidates it; it is not an on-chain proof that the cut was complete,
and an administrator who took the record after a partial cut would be
attesting to a partial routing. The canonical chain now bounds reward payouts by what
has actually been funded minus what has been paid, where funding is one
explicit administrator transfer into the address that credits the received
side in the same act (refused above the pool's lifetime cap), so a
canonical chain that has not been funded refuses any claim or ordinary
remittance that carries a fresh component rather than paying it from
other value — a recycled-only claim or remittance still pays from the
recycled runway, which is backed separately — a
redispatch funded from the recovery position draws on that position, not
on this headroom, and is not refused by it; a funding that lands against a
paid-over-received deficit closes that deficit into a separate restitution
position and only the excess becomes headroom — a position with two recorded exits — a correction of what the
administrator attests to be an accounting error, which lowers the paid
side and creates headroom by the same act, or a release to the treasury
for what the administrator attests to be a genuine deficit — each an
administrator-only action taken under the platform's manual pause and
recorded under a disposition reference the administrator supplies, the
cause being that attestation and its off-chain record rather than
anything the platform verifies, and one from which a demoted compensation gives back what it still
holds — the live headroom and the restitution part alike — while whatever
was already paid out before the demotion stays paid and leaves the return
short by that much. The reward token cannot be rotated while custody or any
of the old token remains at the address, and a rotation is refused
outright when the old token's balance at the address cannot be read,
rather than that balance being taken as zero. The public backing snapshot gains
a versioned form that names the address's balance and attributions; the
mesh watcher reads only that form — a chain without it is reported as
unverified rather than judged by the older relation — and alarms exactly, with no tolerance, when the address's balance stops
covering its attributions where custody has moved — and a balance it
cannot read is itself a critical finding, never a zero. Payouts leave the address by
their fresh and recycled components in one step, into a vault or a wallet,
and a failure after the tokens moved rolls the whole leg back before the
wallet is paid instead; absorptions re-attribute inside the address; user
fees and relocated custody move into it as they are credited; a
repatriation surplus leaves it; each outbound remittance names the custody
it draws on and is refused beyond the headroom before anything is approved.
Overage — value above any entitlement — gains a disposition to the
treasury, likewise administrator-only and taken under the manual pause.
Reward-role changes are frozen from the first custody attribution or from
the activation itself, whichever comes first — an activation with every
position still zero freezes them too — until the era registry lands, and a mirror's source is never rebound directly. The
activation is its own administrator script with direct and staged forms,
and neither form restores service: the deployment is left paused, and an
unpauser's own fresh decision resumes it once the record step has
confirmed the activation. The multi-chain refresh wrapper reports an
unactivated chain as not ordinary completion and runs the ceremony only
when opted in. Stated as not in this
change: a delivery's unattributed remainder, a quarantined compensation and
a pre-attribution return still rest in the platform's balance, for the
cutover change that follows. Refs #1566, #1349, #1956.
<!-- assembled-fragment: 1566-slice-4b-custody-cutover.md sha256=465b3f601b06670e5adda1c15c5dcbbecca55758cd3c83e0a9e0ff25cf0a691e -->

## Thread — A live driver can no longer be added without saying what it means (PR #2184, issue #2099)

The batch that runs the live drives reads each one's exit code and turns
it into a verdict. Two of those verdicts are easy to tell apart — the
drive passed, or the drive found a defect — and the third is the one that
matters here: the drive did not finish, so its surfaces were not fully
reviewed.

That third verdict needs stating carefully, and an earlier draft of this
note got it wrong. It does NOT mean the drive saw nothing. A drive can
check every screen for one kind of user, hit a setup failure on the next,
keep everything it already established, write its report, and still end
on that verdict so the run is not called clean. Describing that as
"verified nothing" throws away work the drive deliberately preserved, and
sends whoever reads it back over ground already covered.

A driver only gets that third reading if it appears on a list, and the
list is kept by hand while the drives themselves are discovered by
looking in a directory. That is deliberate. A drive that never agreed to
mean "I did not finish" by exiting the way it does should not have that
read into it, so being on the list is something each drive opts into.

What was missing was not the opting in. It was any way to tell a drive
that opted OUT from one nobody had got to yet, and any consequence for
the second. The runner printed a warning naming unlisted drives — but it
printed it during a batch run, which happens before a release and not
when someone proposes a change. So a drive could be added, reviewed,
merged, and run for weeks with its "did not finish" reported as "found a
defect".

The row is not silent about it — it carries a note saying the drive is
undeclared and the result may be infrastructure, and the summary repeats
that. An earlier draft of this note said the reader had no way to know,
which was an overstatement worth correcting rather than quietly dropping.
What is wrong is the VERDICT ITSELF: a row saying a defect was found,
hedged, is still a row saying a defect was found, and a hedge asks the
reader to discount a verdict instead of giving them the right one.

Now there are two lists: the drives that speak the third verdict, and the
drives that deliberately do not, each with its reason written down. A
drive in neither fails a check that runs on every proposed change, and
the failure names it and says what to do about it. The reason is required
too — an opt-out without one is an oversight wearing the clothes of a
decision. The runner tells the two apart in its own output as well: a
drive that opted out is reported with its reason, and no longer carries
the "might be infrastructure" hedge that belongs on a drive nobody has
classified.

Be precise about that check's force, because the workflow it runs in says
in its own header not to overstate it, and an earlier draft of this note
did exactly that. The suite it belongs to is visible on every change and
is meant to be treated as blocking by reviewers, but it is not one of the
checks that mechanically prevents a merge. So this closes the gap of
nobody NOTICING — which is what actually went wrong, a warning that
printed only during a release run — and not the gap of somebody
overriding a red check on purpose. Making it mechanical is a separate
decision about which checks are required, and belongs to whoever owns
that list.

One drive turned out to be in exactly the gap this describes, and listing
it needed two fixes to the drive first — which is the most useful thing
this change found.

It ended each of four checks with the third verdict, and all four turned
out to be wrong. Three rounds of review reached that from three
directions: a defect found early and then buried by a later check; a
defect reported as an incompletion because the check that ended the run
came FIRST, before anything had been recorded; and finally the last two,
on evidence that needed no judgement.

None of those four checks is a precondition. Each of them runs only after
a page has been served, and each asks whether what was served is right:
is the connector offered, did clicking it open anything, did what opened
go where it must. Something served, a question asked of it, the answer
wrong — that is finding a defect, not failing to start.

What settled it was not an argument about definitions but the drive
contradicting itself. It already recorded a missing WalletConnect entry
as a defect, and a WalletConnect connection that never opened as a
defect. The Coinbase halves of those exact two questions were being
reported as "did not finish". One drive, one kind of fact, two different
verdicts, a few lines apart. All four report a defect now.

The drive still reports "did not finish" — through the shared machinery
that every drive uses, for an unreachable site or a missing credential or
no browser at all. Those are the real preconditions, and none of them is
a check written in the drive itself.

Adding a drive to that list without reading it is the same mistake as
leaving one off: it puts a claim into the runner's output that the drive
never made.

The lists moved out of the runner to make any of this possible. The
runner starts every drive the moment it is loaded, so nothing could read
its lists without launching browsers against the live site, which is why
a warning printed during a run was the only guard that could exist.

An earlier draft of this note ended by saying the runner behaves exactly
as before. That was true when it was written and stopped being true two
paragraphs above, once the runner learned to tell a deliberate opt-out
from an oversight. What has not changed is the translation from exit code
to verdict: the same code still means the same thing. What has changed is
what the runner says about it, which was the point.
<!-- assembled-fragment: 2099-live-driver-verdicts.md sha256=c0ce03ad987fc2bdbd72c1c44f31285fd0190431a2310e042c323daa3bcaf51b -->

## Thread — A confirmation that could not be obtained is not a failed write (PR #2187, issue #2107)

When one of the live drives sends a transaction, it reads the state
afterwards to check the transaction did what it was for. The reading is
the part that went wrong.

The chain is reached through a public endpoint that is really several
machines behind one address. The receipt saying the transaction was
included can come from one of them while the reading a moment later is
served by another that has not caught up. What comes back is then the
state as it was BEFORE the transaction — which is exactly what a
transaction that achieved nothing would leave behind. The two are
indistinguishable to a check that just looks once and believes what it
is told.

That is not hypothetical. A batch run against the live site on
10 September ended by announcing that a signed lending offer might still
be fillable by anyone holding the signature, and telling the operator to
go and revoke it by hand. The revocation had already happened. Reading
the chain afterwards showed it exactly where it should be.

This is the worst alarm to get wrong in this direction. Acting on it
costs a second fee for a revocation that already took place. Not acting
on it — which is what people start doing once an alarm has been wrong a
few times — is how a signature that genuinely is still live eventually
gets waved past. It also turned a whole run red for something that was
never a product fault.

### What changed

The check now asks its question of a machine that is demonstrably far
enough along. Each attempt asks the machine how far it has got, ignores
it if it is behind the transaction, and otherwise reads the state as of
exactly the point it reported. A machine too far behind removes itself
before it can give a misleading answer, and one that falls behind
between the two questions produces an error rather than a quiet wrong
answer.

The more important half is that there are now three possible outcomes
where there used to be two. The state is right. The state is wrong. Or
no attempt could get an answer it could use — which is neither, and is
what actually happened in September. That third outcome no longer borrows
the second one's words. (An earlier draft called it "nobody would
answer"; a later round showed that was itself a claim the run cannot
make, since a rejected call is an answer. See the final section.)
Where it comes up, the report says what IS known — the transaction was
included and did not fail — and then says the effect is unknown, along
with how to check by hand. It stops there deliberately. Inclusion is
evidence toward the effect and not proof of it: if it were proof, the
reading being missing would not matter, and there would be nothing to
check. So the report does not say the order may still be fillable, and
equally does not say it is safely revoked. Neither is something the run
found out.

A wrong answer, by contrast, is decided on a single reading and not
retried. At or after the transaction's own point in the chain there is
nothing left to wait for, and a check that kept asking until it heard
what it wanted would be a way of sitting out real faults rather than a
way of avoiding false ones.

### Where it applies

Three places, all of them cleanup paths that revoke something the run
created: two in the signed-offer drive (the cancellation the run drives
through the screen, and the direct one its cleanup falls back to) and
one in the rate-desk drive, which cancels the offers it posted. All
three previously read the state once, immediately, and treated a stale
answer as a failed revocation.

The rate-desk cleanup gained one more distinction along the way. Its
closing summary used to say every offer it swept was verified cancelled.
An offer whose cancellation was sent and could not be confirmed is not
that — and it is not established as an offer left live with funds held
either, since the cancellation was included without failing. It is now
counted separately, and the summary declines to claim it in either
direction rather than rounding it to whichever is nearer.

One drive in this family already did the right thing, for the same
reason, after an earlier review round. What was missing was that it was
one drive's private solution rather than something the others could use.
It is now shared, and the three places above are the first users.

### Two more, found in review

Both were invisible — neither would have shown up as an error, only as
the wrong verdict.

The first: the question "how far has this machine got?" was being
answered from a cache. The library keeps that answer for four seconds by
default, and the check was asking again every three, so what looked like
a series of fresh attempts was partly one answer repeated. Worse, an
answer cached while the machine was behind could still be handed back at
the very end, after the chain had caught up — failing the confirmation
because the last question was never actually asked. Every attempt now
insists on a fresh answer.

The second: not every failure to read is a failure to reach. If the
thing being read has itself broken — a function that now rejects the
call, a reply that will not decode — every machine gives the same answer,
and waiting out the deadline to announce that nobody would answer blames
the network for a fault in the code. Those two specific failures were
recognised and reported as what they are. Everything else still retries,
deliberately: the list of ways a network call can fail has no end, so the
short, knowable list is the one worth naming, and anything unfamiliar
behaves exactly as it did before.

*(Neither half of this survived. The part about replies that will not
decode was replaced twice over the next two rounds and finally stopped
being a matter of recognition at all; the part about a call being
rejected was deleted in the round after that, along with the whole idea
of recognising anything. The last two sections are what replaced them,
and this is left standing because four failed attempts are the argument
for the answer that worked.)*

A third suggestion was to prove the reading came from the same chain the
transaction is on, rather than merely from the same height — two machines
can disagree at one height while the chain reorganises. That is true, and
it is not fixed here, for a reason written into the code rather than left
implied: for the two questions actually being asked, every way it can go
wrong goes wrong in the safe direction. A reorganisation that dropped the
transaction leaves the state looking untouched, which reports as a
problem — correctly, because the transaction really is no longer there.
A momentary reading from a competing branch reports the same, which is a
false alarm that sends someone to look rather than one that tells them
not to. And a false all-clear would need a branch on which the answer is
already the one being hoped for — which, for "this offer can no longer be
taken", is a branch where it cannot be taken anyway. Guarding against it
would mean adding a defence against something no run has ever seen, and
this codebase has a costly recent lesson about exactly that. The limit is
written down instead.

### And three more, from the round after

The recognition of "broken in a way every machine agrees on" was named
one case too narrowly. It covered a reply that was empty; review
produced a reply that was present but the wrong size, which fails
identically everywhere and was still being waited out. The library
offers seventeen such errors and gives them no shared parent, so naming
them one at a time would have added one per review round — so they were
recognised as a family, by the pattern the library names them under,
with a check insisting every member of that family was covered.

*(That is not how this ends. The very next round found failures that
decode a reply wrongly and do not carry the pattern's name at all, and
the section below replaces this fix rather than extending it. It is
described here as it happened because the two failed attempts are the
argument for what finally worked.)*

The deadline was a promise the check did not quite keep. It waited a
fixed interval between attempts regardless of how much time was left,
so a run could sleep past its own deadline and then begin a fresh
attempt — and an attempt is not quick, since each network call has its
own timeout and retries. A ninety-second bound could overshoot by tens
of seconds, or return an answer the caller had been told could not
arrive that late. Attempts are now gated on the deadline and the wait is
trimmed to what remains.

The third is the most worth recording, because the previous round caused
it. Making broken-everywhere failures stop being retried meant they were
raised instead — and raising them handed them to the surrounding cleanup
code, whose message says the position may still be live, funds may be
held, and someone should go and cancel it by hand. That is the exact
false alarm this whole change exists to remove, reached by a longer
route. The transaction's own receipt said it succeeded; a checker that
breaks afterwards does not withdraw that. Such a failure is now reported
as what it is — the verification did not complete, and here is precisely
why — with the error named rather than swallowed, and without the claim
about funds that nobody established.

### The round after that, where two of these stopped being lists

Recognising "broken in a way every machine agrees on" had now been
attempted twice — first as a handful of named cases, then as a family
named by a pattern — and review broke it a third time, with failures
that decode a reply wrongly but do not carry the pattern's name at all.
Three attempts at one boundary is the point at which the boundary is
wrong, not the list.

So the list was not extended again. The reading was split in two
instead: fetching the reply, which is worth trying again because a
machine may be unreachable or behind, and making sense of the reply,
which never is — a reply that arrived arrived everywhere. Only the
fetching is retried now. Nothing has to be recognised for that to hold,
because a reply that will not make sense is no longer inside the part
that retries. What remains to be recognised is a single question: did
the machine answer by rejecting the call? That one has been stable
throughout and has produced no surprises.

*(Two claims in that paragraph did not hold. "A reply that arrived
arrived everywhere" is false — the last section explains why — so
making sense of a reply IS worth trying again, and it is retried now.
And the single remaining question was itself deleted a round later. The
split described here is real and stayed; only the reason for it
changed.)*

The split was checked against the live chain before being trusted:
reading the two values the two drives actually read, the old way and
the new way, returns identical results — including for the one that
comes back as a whole record rather than a single number.

The time limit needed the same treatment. Checking the clock before
starting an attempt still allowed the first half of that attempt to run
long and the second half to begin after the limit had passed. Checking
between each step would have meant a new check for every step anyone
adds later. The attempt as a whole is now run against the remaining
time, so the limit covers steps nobody has written yet — and the timer
is cleaned up when the attempt wins, which matters because a live run
would otherwise sit at the end refusing to finish.

### Round four, where the recognising stopped entirely

Recognising which failures are pointless to retry was attempted in four
consecutive rounds, and review broke it in all four — each time by
naming the case the previous attempt had missed, ending with the form
that a plain call actually produces, which the round before had just
added a different class for.

A rule wrong four times running is not one case short. It is the wrong
idea, so it is gone. Every failure to get an answer is now retried, and
nothing tries to judge which ones are futile.

Two things make that safe rather than a step backwards. The part that
must never be retried — making sense of a reply that did arrive — is no
longer a matter of recognition at all; it sits outside the retrying, as
of the previous round, and that is untouched. *(The next round overturned
that half: making sense of a reply IS worth trying again, because one
machine can hand back a broken reply where the next hands back a good
one. It is retried now, and still without recognition. See the last
section.)* And what
the recognising was really protecting was a sentence: the report used to
end by saying no machine would answer. That was the false part. A
rejected call *is* an answer, from every machine. The report now states
the cause it actually saw and declines to say why, noting that a cause
of that shape points at the code rather than at the network. What is
lost is promptness in a situation no run has ever produced.

The other half of the round: losing a race is not the same as stopping.
Marking the abandoned attempt as ignorable only silences it; the attempt
itself carried on, and once its first request came back it started a
second one, after the answer had already been given up on. It now checks
whether it has been abandoned before going further. The limit of that is
stated plainly rather than implied — no new request is made once time is
up, but one already in flight cannot be called back, and runs to its own
timeout.

### Round seven, which corrected round three

The round that moved making-sense-of-a-reply out of the retrying rested
on an argument: a reply that arrived arrived everywhere, so trying again
could not help. Review showed the argument is wrong. The endpoint is
several machines, and one of them can hand back an empty or truncated
reply while the next hands back a good one — which is the very thing
this whole change exists to cope with. Round three was right that these
failures must not be *recognised* by name, and wrong about where to put
them.

They are simply retried now, like every other failure to get a usable
answer. That needs no recognition either, so nothing is given back. What
is left is one rule where there were three: try again until the time is
up, and report what was seen without saying why.

The same round caught the last piece of unearned certainty, and it was
in a sentence written two rounds earlier to *remove* unearned certainty.
When the checking itself broke, the report said the failure happens on
every machine or else the drive is at fault. Neither follows from one
bad reply. It now says only that this confirmation did not finish, and
why it stopped. A companion sentence that declared a rejected call to be
a fault in the code rather than in the network went the same way: the
cause is printed, the reader draws the conclusion, and the report says
plainly that this is what it is doing.

### Round eight, on what a receipt is actually evidence of

Three more, all the same shape as everything above: saying more than was
established.

The largest is a habit that had crept through every one of these reports.
Where the confirming reading could not be got, they each said the
transaction was included and succeeded, *so the thing it was for
happened* — and then went on to say the confirmation was missing. Those
two cannot both be load-bearing. If inclusion proved the effect, the
missing reading would not matter and there would be nothing left to
check; the fact that the reading exists at all is an admission that it
does not. Inclusion without failure is strong evidence and it is not
proof. Every one of those reports now says what the receipt shows and
then says the effect is unknown, in those words.

The second is the same point one step along: a sweep was declining to
call an offer live because its cancellation had been included. Declining
to call it live is right; the reason given was not. It is now declined
because nothing was established either way.

The third is smaller and is a mismatch between a rule and a sentence. The
test for "this can no longer be taken" was deliberately loosened to
accept a figure at or above the expected one, since either way nothing
rests. The reports kept saying the figure had been set *to* the expected
one. They now print what was actually read and describe it as at or above
— an unexpected figure being visible is the point of reading it.
<!-- assembled-fragment: 2107-write-confirmed-at-its-own-block.md sha256=b392c8fc89a495944a7a4fc0920f9a0d6070aa89ded3da88b93cfa59b77114e0 -->

## Thread — A page that ran out of time now says so (PR #2185, issue #2109)

The sweep that walks every screen of the deployed app prints one line per
screen. When a screen fails to load, the line ends with "DID NOT LOAD".

Three kinds of thing can put it there, and two of them have always said
which: the server answered with an error page, or the app sent the
visitor somewhere else. The third is the opening itself throwing, and
that covers more than one situation — the screen ran out of time, or the
connection was refused, or the name would not resolve, or the browser
went away. Whichever it was, the line said nothing at all about it. It
read as a broken screen.

In the run that prompted this, four screens reported it, and other passes
of the same run loaded those same screens without trouble. That does not
prove the screens are fine — a screen that hangs intermittently is a real
problem, and one pass succeeding does not excuse another failing. It does
mean the reader is being told something the run did not establish: the
line says "DID NOT LOAD" and stops, so anyone reading it starts looking
for a fault in the app, when what actually happened may be that the
attempt ran out of time and nobody knows why.

The distinction is not cosmetic. A screen that answered with an error is
something the sweep established. A screen that ran out of time is a
screen the sweep never finished looking at, and it cannot say whether
that screen works. Reporting the second as though it were the first
states a finding nobody made.

That line now names the deadline that expired and says the screen is not
fully reviewed. Not that nothing was seen — the sweep may have watched
the page arrive, load scripts and report errors before one slow piece of
it ran the clock out, and the counters printed on that same line say so.
Claiming nothing was observed would contradict the numbers next to it,
which is the same kind of overreach in the other direction.

It cites the time budget rather than how long this attempt took, because
the elapsed figure only means something once you know what the screen was
allowed — and the budget is now written down once instead of being
repeated wherever a page is opened.

A failure the sweep does not recognise is reported as itself, in its own
words, on one line. It is not sorted into a category it has not earned,
which would be this same defect in a new place.

Whether the deadline expired is settled by asking the failure what it is,
at the moment it happens, rather than by reading its wording afterwards.
The first version read the wording, which would have handed the softer
"ran out of time" explanation to any failure whose text happened to
mention a timeout — an infrastructure excuse for a real defect, and the
one direction that matters.
<!-- assembled-fragment: 2109-navigation-timeout-says-so.md sha256=ae22ef34f64deeff5eecefe06f59472019f539d9d8de2f2f89e0dc9567af6630 -->

## Thread — One answer to "what does this name hold, and can I trust it here" (PR #2177, issue #2175)

The checks that keep the live drives' source regions honest repeatedly
need to know what a name stands for. Seven separate rules were working
that out independently — each asking the same underlying question, each
deciding for itself what a missing answer meant, and each expressing "I
could not tell" in its own way.

Two things followed from that, and both were found by review rather than
by reasoning about it.

A rule added to one of the seven was absent from the other six. Unpacking
a name from a pattern is not the same as naming a value, and one copy had
known that for several rounds while the rest did not — so a bound taken
apart from a search result read as though it were the search itself, and
a region that does not exist at runtime was certified.

And "I could not follow this" kept being read as "this is harmless".
Those are opposite answers, and while they shared one blank response,
which one a caller got depended on where the blank arrived from.

There are three answers now, and they are different questions. The name
stands for something, and here it is. The name has a binding, and what it
holds at this point cannot be trusted — it was written to earlier, or
unpacked from a pattern, or declared in a branch that may not have run,
or defined in terms of itself. Or the name has no binding in this file at all, which means it is a
global — something the language or the page provides, or a name nothing
declared. An imported name is not that third answer: the scope analysis
binds an import, so it comes back as the second answer, a binding whose
value cannot be followed here; what an import shares with a plain
parameter is a separate fact the answer carries alongside its state, that
the value arrives from outside this file.

That third answer is not a kind of failure, and separating it out is half
the point. A built-in is unbound and perfectly well understood; a local
whose value cannot be followed is unknown and must be refused. Keeping
them in one bucket had made a built-in look unreadable, and could as
easily have made an unreadable local look like a built-in.

Callers still decide what each answer means for their own question, and
two of them deliberately disagree: a name from elsewhere is taken as text
when it is being searched for, and is not taken as a bounded region when
something is being cut from it. Both are right, and neither could be
stated while the two situations shared one response.

Making the states visible immediately showed one caller answering
permissively: a receiver whose value could not be determined was being
trusted, when the whole purpose of that rule is to catch a stand-in
pretending to be text. Two kinds of name are exempt, and both for the
same reason: a plain parameter, whose value arrives from whoever called
the function, and an imported name, whose value belongs to another file.
Neither can be read here, and both are how these drives are ordinarily
handed their source. Everything else whose value cannot be determined is
now refused.

That exemption was first written by matching on the REASON the lookup
failed, and review caught it immediately — which is worth recording,
because it is the same mistake in miniature that the whole change exists
to remove. Several quite different situations shared one reason with a
plain parameter: one that supplies its own value when the caller omits
it, one that collects the remaining arguments into a list, one taken
apart from a pattern, and one defined inside a branch that may never have
run. All four inherited the exemption. The rule now asks the binding a
question of fact — does this value arrive from outside this file — which
is true of a plain parameter and of an import and of none of the four.

One more limit on that exemption followed, and it is the kind worth
stating: it describes a value the check CANNOT SEE. Where a helper is
called with the value in plain view — handed an object that merely has a
search-shaped property — the exemption had been vouching for exactly what
the check exists to catch. So a call whose argument is visibly not text
is refused, whatever the helper's body would have said. Working out what
each parameter holds at each call is a larger analysis and is not
attempted here; the narrower question has an answer and is asked instead.

That limit needed widening twice more before it held. Every form the
language offers for passing a value along — selecting between two,
spreading a list, assigning, awaiting, discarding all but the last of a
series — is somewhere the inspection can stop one step short of the
value, and each was found separately. They are now listed in one place so
there is a single thing to check rather than one more each time. The
inspection also refuses an argument whose value could not be worked out
AND does not come from outside the file: the exemption describes a value
that cannot be seen, and such a name satisfies neither half of that.

There is a SECOND behaviour change, and an earlier draft of this note
said there was not. Because every rule now follows a name the same way, a
small helper reached through a second name is recognised where before it
was not — the old code required the helper's own declaration to be the
function itself, and a name pointing at another name is not that. This is
a widening: regions that used to be refused now pass. It follows from the
change rather than being aimed at, which is exactly why it needed
stating; a reader checking whether this note was complete would have
found it and been right to mind.

A THIRD followed, found the same way, and this one corrects an
over-strictness rather than widening a judgement. Where a name is
declared twice — once by unpacking and once plainly — the old rule
refused it because one of the two declarations was an unpacking, even
when the plain one is the declaration that stands where the name is used.
It now reads the declaration that actually stands, so a name provably
holding the beginning of the text is accepted as such. The old answer was
not conservative, it was wrong.

A TIGHTENING joins them, found the same way and closing a window that was
open before this change rather than introduced by it: a value reached by
reading a property of something is no longer accepted as the text being
searched — what a property holds when a line runs is not a question this
can answer, which the work preceding this change had already concluded
elsewhere.

A second tightening stood here for several rounds and is now GONE, which
is recorded rather than quietly dropped because a reader may remember it.
It made a built-in the file itself writes over stop counting as the
built-in. That went the way the later check for a rewritten prototype
went, and for the same reason, described further down: the two were one
question with no answer, and both are replaced by a stated assumption.

The check on what a caller hands a helper went through five revisions
before it was abandoned, and the abandonment is described further down —
this paragraph records only what those revisions were reaching for, since
a later section replaces the answer and not the question. Each version
asked the same crude thing of EVERY argument — is this visibly not a
piece of text — which was wrong twice over: it condemned an ordinary
numeric search offset passed alongside the text, and it never asked which
parameter a stand-in would actually land on. The narrower question those
revisions settled on was which parameter the helper searches THROUGH, and
what was passed for that one. What did survive all of it is the
separation: what an expression hands over, and whether that value is a
stand-in, are two readings with two names, which is the same correction
this whole change is about.

One consequence of separating them is worth recording: the rule about
what counts as a piece of text now lives in one place, with the rule
about receivers, instead of being written twice in slightly different
words. A name holding a regular expression and a regular expression
written out are the same question, and were being answered by two pieces
of code.

Review then found three more, and all three are the same shape as the
ones before them: a rule that had been written at one site and not at its
sibling. A name holding a stand-in was being accepted where the identical
stand-in written out at the call was refused — one question, two answers.
A built-in replaced through a stable second name for the language's own
global object was not seen as replaced, though replacing it directly had
been caught for two rounds. And a search written inside a function the
helper merely CREATES, and never calls, was being attributed to the
helper's own result, so an ordinary argument was refused on the strength
of code that does not run.

Fixing the first of those exposed a defect in the consolidation itself,
and it is worth stating because it is the risk that comes with having one
answer instead of seven. Each rule keeps a record of what it has already
looked at, so that a name defined in terms of itself is refused instead of
followed forever — and resolving a name had been borrowing whichever
rule's record was to hand. Two rules that each resolve the SAME name while
judging one thing therefore shared that record, and the second read the
first's entry as a loop. A plain parameter came back "defined in terms of
itself", and a correct region was refused. Resolving keeps its own record
now; the answer depends on the name and the file and on nothing a caller
happens to have looked at first.

Alongside those, a genuine loosening. A value assigned on the arm of a
branch that the use excludes cannot have been assigned by the time the
use runs, and counting it had erased a parameter's provenance and refused
a correct region. Only the two constructs where the arms truly cannot
both run are treated this way; a switch falls through, and a catch runs
because its try block got part of the way, so neither qualifies.

The round after that found two of those very fixes reaching past their
own question, which is worth stating as the pattern it is rather than as
two more entries. The branch-arm rule holds only within a SINGLE
evaluation: where the name being written outlives the function the branch
is in, the first call's assignment is still there for the second, and the
rule was stepping over the lifetime test standing next to it. And the
alias walk gave up after a fixed number of steps — a guess about how many
names someone might chain together — where the condition that actually
ends such a walk is reaching a name declared nowhere in the file, or
coming back to one already on the chain. Both are decidable; a number is
not.

The third finding of that round was the third in a row against one small
piece of this: which of a helper's parameters a search actually looks
through. Each round named a different place the search should not have
been looking, and all three were the same question asked about the wrong
thing. What selects an argument for inspection is not a search written
anywhere inside the helper — it is a search whose result can BE the
position the helper hands back. A search used only to choose between two
outcomes that are both genuine landmarks cannot change the answer, and
neither can one inside a function the helper never calls. That is now one
question in one place, and the accompanying list names only what is
provably discarded, so anything missing from it is inspected rather than
skipped — a gap costs a refused region, never a certified one.

And then the round after that removed the thing all three of those rounds
had been about, which is the most consequential change here and the one
worth reading if you read only one.

Working out which of a helper's parameters a search actually looks
through had produced a finding in five consecutive reviews. Each named a
different route through a helper's body — a nested function reusing a
name, a function created and never called, a search used only to pick
between two outcomes, a search feeding another search's starting point, a
helper handing its value to a second helper. Every one of those findings
was right, every fix was correct, and not one of them ended the sequence.
The sixth was going to exist as well.

The question underneath was never which parameter a search reads. It is
whether an argument could hand the helper a SEARCH THAT LIES — something
shaped like a text search that answers with a fixed number instead of a
position. Only an object can carry a method that lies. A piece of text
can too, in principle, except that its own search is the genuine one.
Every other simple value — a number, a true or false, nothing at all —
carries no such method, so a helper handed one fails visibly rather than
quietly producing a fixed window.

So that is the question now, asked of every argument, with nothing traced
through anything. It is shorter, it cannot be evaded by passing a value
through one more helper, and it accepts the ordinary numeric offset that
five rounds of a widening rule had refused.

Two things are given up, and they are recorded rather than glossed. An
argument that really is a stand-in, handed to a helper whose every
possible answer is a genuine landmark regardless, is now refused — the
previous round had established that case and made it pass. So is one
whose search only supplies the starting point of an outer genuine search.
Both were correct regions. Both are refused, because establishing
otherwise needs exactly the tracing that produced five rounds of findings.
The cost is a refused region on shapes that appear nowhere in this
codebase; the direction is the safe one, and the alternative was a rule
whose edges had no end.

The review after that found two holes in the short rule that replaced all
of it — and both are the very mistake this whole change exists to remove,
made inside the rule that removed the last one.

The claim that a simple value carries no search of its own is false when
the file gives it one: a number handed a property is briefly wrapped in an
object, so a file that attaches a search to that wrapper makes every
number answer with whatever it likes. That is the same mechanism as
replacing a built-in outright, which this guard already refuses one level
up, and it is refused the same blunt way — by asking whether the file
contains such an attachment at all, not by working out which values it
could reach. Working that out is the tracing that had just been removed.

The second is plainer and worse. The same number written two ways got two
answers: one spelled as a bare digit was accepted, and one spelled with a
leading plus was refused. Nothing about the value differs. Deciding from
how something is written rather than from what it produces is the defect
this change is named after, and it had been reintroduced in the fix for
it. Every form whose result is a simple value whatever its parts — the
arithmetic and comparison forms, the negations, the increments, an
ordinary template — is now read as one. A template with a function
attached to it is deliberately not, because that function returns
whatever it likes.

The same review found the branch rule reaching only one of the two places
that need it. A name given its value where it is declared is not recorded
as having been written to — the two are different things to the machinery
underneath — so a declaration on the arm of a branch the reader is not on
never reached the rule that would have discounted it, and was refused by a
neighbouring test instead. It is one shared piece of reasoning now, which
is the fifth time on this change that one rule turned out to be answered
at one site and not at its sibling.

The next review produced three separate ways past that first rule, and
they were not three faults. One installed the replacement through a loop
rather than an assignment. One slipped past because the check only looked
at values written out at the call, while a value handed in from outside is
wrapped for a property access exactly as a written-out one is. And one
replaced not a search at all, but the machinery by which a list is read
out — so a list written in plain sight handed over something it does not
contain.

That third settles the shape. Once a file may replace the machinery
values are read THROUGH, the escape stops being a property of any
particular value, and no amount of classifying values more carefully will
close it: there are several other pieces of that machinery, and
enumerating them is the open-ended list this change has now twice been
caught depending on.

So the question is asked once, about the file, before anything else: has
this file rewritten any of the language's own machinery. If it has,
nothing in it can be established and every search is unknown — including
an ordinary direct one, which the previous placement could never have
reached, though a replaced text search makes it lie just as readily.

Two smaller corrections came with that review. The branch rule was taking
a fact from whoever called it rather than working it out, and the caller
that needed it most was not supplying it — so a name declared inside a
function, on the arm of a branch the reader was not on, was refused where
the same shape at the top level was accepted. It determines that for
itself now. And an assignment that computes something — adding one to a
counter, say — was being read as though it might hand back either side,
which is true only of the three that may decline to assign at all. It
hands back what it computed, and that is a simple value whatever it was
computed from.

And then the check itself was removed, along with an older one it turned
out to be a second copy of. This is the third such removal here, and the
one that names the pattern rather than being another instance of it.

Both checks were answering the same question: has this file replaced
something the language provides. Neither could. Six reviews each found
another way to write the replacement — a key computed rather than
spelled, three different standard functions that do it without an
assignment, a name taken apart from a list, and several pieces of
machinery that reach the same end without naming the thing they replace.
A check over a list with no end is not a weaker check. It reports a
certainty it does not have, which on something whose entire job is
refusing unearned certainty is worse than admitting the limit.

It was also never the danger. This guard exists to stop somebody writing
a fixed-length window by mistake, and nobody rewrites the language's own
machinery in a browser test by accident.

So the assumption is now written down where the reasoning lives, and the
suite checks it against the real files in the forms a person might
plausibly reach for. Best effort is the right standard there and was the
wrong standard inside the reasoning: a form the suite misses means nobody
noticed something strange in our own files, while a form the reasoning
missed meant a region certified as correct that was not.

The check in the suite is deliberately narrower than "no prototypes
touched". One of the drives legitimately replaces a browser method on the
page it is driving, which has nothing to do with the searches this
reasons about, and a rule that objected to it would be objecting to
correct work — the failure this whole family of guards exists to avoid.

One finding from that review is fixed rather than removed. A name created
afresh on each pass of a loop cannot be affected by a later pass, so
ordinary before-and-after reasoning holds within one pass; the rule had
been discounting every loop unconditionally. Freshness depends on how the
name was declared as well as where, since the older form of declaration
is written inside the loop and still outlives it.

This note ENUMERATES the behaviour changes rather than counting them, and
that is a correction rather than a preference: a running total beside a
list is a second place the same fact is recorded, and this one was wrong
on three consecutive reviews. None of the changes was aimed at. Each
follows from every rule resolving names the same way, which is the point
of the change — and that is exactly the kind that goes unmentioned unless
somebody checks, because a reader cannot tell a deliberate widening from
an accidental one unless the note says which.

Everything else behaves as it did. The rules that were correct are
correct in the same cases; they now say why in terms anyone can check.
<!-- assembled-fragment: 2175-one-name-resolver.md sha256=0acc2afcdd3a5a218241f25918ab5637b2a33ff596a5642ae5dc13d5a1df1728 -->

## #2101 — the index checks its own loan statuses against the chain (PR #2190)

The indexer learns that a loan has ended by seeing the event announcing
it. An ending it does not see is missed permanently: letting the service
catch up restores its place in the chain, not the records it went past,
because nothing goes back over ground the marker has already crossed.

Why an ending goes unseen is deliberately not claimed here. An earlier
draft blamed the service being down, being rate-limited, or a gap outgrowing
what it will scan backwards over — and those are among the things the
reading explicitly survives: it resumes from the last block it finished,
a failed read leaves the marker where it was, and the marker moves only
after the work behind it is done. The note admits further down that the
check cannot say why an ending was missed; opening by naming causes
contradicted that, and named the wrong ones.

Nothing checked afterwards. The result, measured on the test network on
14 September: the chain said six loans were running, one published figure
said seven, and the list of running loans had nine entries. Three of those
entries were loans that had already ended — one of them two months
earlier, in early July, and untouched since.

That is not a cosmetic miscount. Each of those entries is a position the
platform is telling the world is still open, in the offer book and in
anything else reading the published list, for a loan that has already
defaulted or been repaid.

### What now happens

On each scheduled tick where it has finished reading new blocks, the index
asks the chain how many loans it considers running and compares that to its
own count. If the two differ it examines a handful of its records; if they
agree it still examines one. Where the chain says a loan has ended and the
record says otherwise, the record is corrected.

That qualification is deliberate, and it is the one place this check waits
longest exactly where it is needed most. Old blocks are read in bounded
passes of about two thousand at a time, so a service that has been down
comes back needing as many passes as the gap divides into, and the
comparison waits for the last of them.

How long that takes in real time is NOT something those two numbers give
you, and it would be worse than useless to imply otherwise — how quickly
passes follow one another depends on the arrangement. On the one in use a
backlog mostly drives itself rather than waiting for the next scheduled
turn between passes, though it stops doing so once it is nearly finished
and leaves the last stretch to the ordinary schedule — so the final wait
before the comparison runs is a scheduled one however fast the rest went.
On the fallback every pass waits for its own turn, so the same gap takes
far longer to close. Neither is a figure this note can
usefully give, because both depend on values an operator can tune. The
honest statement is the shape: the gap is closed in bounded passes, and the
comparison happens once they are finished.

Why wait at all, rather than compare while catching up? NOT because a
correction could be invented — it could not, and the platform's own
statement of intent says so: a source that is behind reports the loan still
running, which matches the record and changes nothing. The cost is about
the money rather than the lifecycle. A correction rewrites the whole record,
amounts included, from the chain as it stands NOW, while the events still
queued behind it describe a state months earlier. Applying those afterwards
to a record already corrected leaves the two disagreeing about the figures,
which is the precise failure this check was rearranged to avoid. Letting the
queue drain first means the correction is the last word rather than the
first.

How many chains that covers per tick depends on how the service takes in
data. As currently configured every chain is serviced on every tick, so the
check reaches all of them. On the fallback arrangement one chain is taken
per tick in turn, and the wait before a given chain comes round grows with
the number of chains. The distinction is stated because it decides how long
a wrong record can survive, which is the figure an operator would actually
want.

A correction is the whole record, not just the word "ended". The same
question that returns the loan's state also returns the money still
attached to it, so both are written together. That matters because the
things that move those figures — a part repayment, a forced sale, a
collateral top-up, a debt written off — announce themselves the same way an
ending does, and can be missed the same way. A record stale enough to have
missed an ending has no claim to be current about the amounts, and nothing
is given up by preferring the chain's: an ending never erases what was
owed, so where the chain holds a smaller figure, that smaller figure is
what actually happened. A closed loan also loses everything the
platform was still offering to act on for it: a collateral sale listing, and
a committed swap the borrower could still be shown a cancel button for.
Neither would work against an ended loan, which is no comfort to whoever
tried.

These two came from consecutive review rounds — first the listing, then the
swap — so the fix was not to add the second one beside the first. There is
now a single named clean-up that runs whenever a loan CLOSES, wherever the
closing was learned; the correction calls that rather than keeping its own
list of things to tidy, so anything added to it in future is covered without
the correction changing at all. Ending a listing or a commitment on a loan
that is still running stays deliberately separate: withdrawing a collateral
sale is not withdrawing a swap commitment, and the platform must not dispose
of a position the borrower still holds.

Both halves of the deciding are deliberate. It keeps looking when the totals
agree because two mistakes cancel — one ending missed and one beginning
missed leaves the totals equal while both records are wrong — so a check
that only wakes on a mismatch is one that can be quietly satisfied. And it
examines only a few records per turn because the scheduled work has a hard
ceiling on how many outside requests it may make, most of which the
existing scan has already spoken for. In the ordinary case the whole thing
costs two of them: one to ask the chain its total, one to read the single
record it examines anyway.

How many it may spend when the totals DO disagree depends on how the
deployment ingests, and that is worth stating rather than leaving to be
inferred. Where the reading of the chain runs in its own slot — which is how
the service is currently configured — the correction may examine up to three
records per turn. That figure came down from five when establishing the real
holder of a corrected position was added: fewer records per turn, and the
message reaching the right person, is the better of the two. Where it shares a slot with the other scheduled work, it
examines one.

That second case — the shared slot — deserves a plain statement rather than
a reassuring one. It is not merely tight: counted properly, the work already
scheduled into it can exceed what the platform allows, before this
correction is added at all. That is a separate fault, raised on its own, not
something this change introduced or repairs; taking the smallest possible
share is what this change can honestly do about it, and it does not pretend
that makes the slot safe. Where the slot is not over its allowance, every
record is eventually reached and the difference is only how many turns it
takes. Where it is, the promise does not hold: work can be cut off before
the turn advances, and the same records can be missed repeatedly. That is
the separate fault, and until it is fixed the rotation on that arrangement
is best-effort rather than assured.

The check also runs on a **quiet** chain — one producing no new blocks
between ticks — and that is not a detail. An earlier version ran it only
where new blocks had just been read, which meant it never ran at all on a
chain that had gone quiet. The three records this was written for sit on
exactly such a chain, so the check might never have examined the very
entries that prompted it.

Where it sits in the tick matters too. It now runs **before** the two
surfaces that tell people things: the reminder sweep and the inbox. Both
read the records as they stand and neither withdraws what it has already
said, so running afterwards meant a loan that had ended months ago could
still be sent a "payment due" or "overdue" reminder that nothing would ever
retract. And a correction now announces itself to anyone watching the
position, the same way any other change does — without that, the record was
put right while every open screen kept showing the old one until it happened
to refresh. That announcement belongs to the current arrangement for reading
the chain, which is the one in use; on the fallback there is no live
announcement to make and no channel to carry it, so a corrected screen there
waits for its next refresh. Worth knowing before choosing to fall back. The announcement names the corrected loan, which sounds like a
detail and is not: the announcement is filtered down to the people it
concerns, and a corrected loan is by definition an OLD one that appears
nowhere else in that tick's work. Left unnamed, the one announcement that
mattered would have been filtered away from exactly the two people it was
for. Naming it is still not quite enough where the position has changed
hands in the meantime — the new holder's own view cannot know about a loan
they have only just been found to own — so a correction also marks its
announcement as incomplete, which makes it reach everyone rather than only
those already known to be involved.

Both holders of a corrected position also get the ending in their inbox.
They had received nothing: the announcement was missed, so the surface that
turns announcements into messages never saw one, and a position could be put
right while the two people with money in it were told nothing at all. What
those messages carefully do not do is pretend to be news of the moment. They
say the platform found this out now, which is true; they do not carry a date
for the ending, because the check genuinely cannot work out when it happened;
and they are marked as coming from a correction rather than from an
announcement nobody saw.

Where the chain records that a loan is finished but not how it finished —
the same state is reached by a repayment, by a default and by a forced sale
— the message says only that it ended. An earlier version said nothing at
all in that case, on the grounds that anything else would be inventing a
claim. That was the wrong half of the trade: knowing your position ended,
from a platform declining to say how, is better than hearing nothing because
it could not say everything.

Who receives them is asked of the chain, not of the platform's own record of
who holds what. The same gap that swallowed the ending could equally have
swallowed a transfer of the position, so that record is untrustworthy for
exactly the same reason — and the one message a holder gets about their loan
ending is the worst possible one to send to somebody who has already sold
out of it. Where a holder cannot be established at all, no message is sent
for that side rather than one sent to a guess, and the holder it does
establish is written back, so the surfaces that ask who holds a position now
stop naming the wrong one. That is narrower than it sounds and the
difference is worth stating: the record also carries the parties the loan
STARTED with, those are published too, and a correction does not touch them.
So a position that changed hands can still show its original names on
surfaces reading that half. Putting those right needs the same
held-position history raised separately.

Which half of that gets acted on took two goes to get right, and the rule
it settled on is worth stating. An earlier version also recorded an
ABSENCE — nobody holds this side, because that party already took what was
theirs — and worked out which case it was by inspecting how the reading had
failed. That test had to be narrowed once, and the narrowing was the
signal: the same failure also covers an ordinary hiccup, so a version meant
to stop offering something already claimed would, on a bad minute, erase a
holder who still owned it. This project has met that shape before and its
answer is to remove such a test rather than keep sharpening it.

Removing it took the whole write with it, which went too far. The unsafe
part was concluding a position had been given up from a question that went
unanswered; an answer that names an actual holder concludes nothing. So the
correction records a side it got an answer for and leaves a side it did not
exactly as it was.

The cost of that is stated rather than implied: a side whose holder could
not be read gets **no message at all, and no later attempt at one.** The
record is still corrected — the loan stops being published as running,
which is the harm this whole check exists to end — but that one person is
not told. Retrying instead is not available, because an unanswered question
and a position legitimately given up are the same answer here: waiting for
one would leave the other's record wrong forever, which is the worse of the
two.

That last point has a consequence for the message above that says only "it
ended", and it is worth being blunt about: the commonest way of reaching that
state is a way this message cannot cover. A loan reaches it when both sides
take what is theirs — which destroys the very holdings ownership is asked
about — so there is nobody to establish, and nobody is told. The record is
still corrected. The fix is not to relax any of this and fall back on the
stale list; it is a record of who HELD a position that no longer exists,
which the platform does not keep yet
and which is raised separately.

There IS a route to that same state where the message lands, and it is what
decides the wording. When a borrower's collateral sale completes, the loan
finishes without either side claiming — the borrower's position is released
rather than destroyed, so there is still somebody to tell. That route also
hands over everything owed as part of the sale, which means the one case
where this message reaches a reader is precisely the case with nothing left
to claim. So it says to open the position and see where it stands, rather
than pointing at a claim that by construction does not exist. Every other
ending keeps its own wording, because those genuinely do leave something to
collect.

They also arrive as NEW rather than as something already read. The inbox
decides what is unread by position in the chain's order, and a message
carrying no position of its own has to be placed deliberately — placed
wrongly, it lands behind things the holder has already opened and is never
shown at all. The reminder messages had already learned this; the correction
messages repeated the mistake, and the placement rule is now one shared rule
rather than one each writer has to rediscover.

### What it will not do

It only ever moves a record from "running" to an ending, and only when the
chain says so. A machine that is behind reports the loan as still running,
which matches the record, so nothing is written: being out of date can cause
a correction to be missed, never invented.

That one-way direction is necessary and it is NOT on its own sufficient, and
an earlier draft of this note said otherwise. A correction cannot be undone
by the same check — a record it has ended is no longer one the check looks
at — so a reading that is wrong rather than merely old is permanent. What
actually makes it safe is that the chain is read at a point the chain itself
treats as settled, never at whatever a machine last saw. Without that, a
momentary reorganisation could report an ending that then disappears,
leaving a genuinely open loan recorded as closed with nothing that would
ever come back to it.

That holds while the source can be asked for a settled point, and there is
one case where it cannot. A source too old to understand the question is
answered instead by stepping back a fixed distance from the latest block —
which is a guess at settlement rather than the chain's own word, and against
a deep enough reorganisation it is the reading this rule exists to forbid.
It is a pre-existing arrangement rather than anything this change
introduced, and it is raised separately as #2201; it is stated here because the
safety the rest of this section claims is exactly what it qualifies, and a
reader who is told the rule and not its exception has been told the
comfortable half.

It also refuses to touch a record that has already ended, leaving
corrections between one ending and another to the event path, which knows
more. The chain does not distinguish a forced sale from an ordinary
default, so a record repaired this way may read as the latter where the
event would have said the former — less precise, never wrong, and much
better than "still running". That is stated here rather than left to be
discovered.

And it cannot say WHEN the loan ended, so it does not record a time. An
earlier version stored the moment it happened to look and called that an
honest substitute. It is not one: that figure is published, and the list of
positions with something to claim is ordered and capped by it, so a loan
that ended in July would have presented as freshly ended and pushed genuinely
recent ones out of a limited list. The time is now left empty, which is what
is true.

Leaving it empty turned out to be only half the job. The list of positions
with something to claim, finding no ending time, fell back to when the
record was last written — and a correction writes the record at the moment
it makes it, so the July loan arrived at the top of that list anyway. Fixing
the field being written and not the claim being made is how the same defect
survived its own fix. So the ordering now treats an unknown ending as
unknown: positions with no known ending time come after every position that
has one. They are not hidden — where nothing else is competing they are the
whole list — but an ending nobody can date may not push a genuinely recent
one out of a limited one.

The correction also stands down entirely when the chain briefly reports a
settled point BEHIND where the service has already read. That sounds like an
edge and is not: the same point decides which holder the platform believes
owns the position, so acting on the older one could correct a record
perfectly and send its one message to whoever held it at that earlier moment
— the precise mistake the chain-sourced recipients exist to prevent,
arriving by the clock instead of by the record. There is no single point that
is safe for both questions when they disagree, so the turn is skipped and
the next one does the work.

Two answers it treats as neither running nor ended. A record for a loan the
chain has never heard of — one indexed once from something later undone —
reads, through the chain's own interface, exactly like a running loan; those
are now named in the operator's log as unresolvable. Being named is not
yet being withdrawn, and the difference matters: the record keeps its
running state, so it is still counted and still published as open. What has
changed is that it is no longer mistaken for a confirmed running loan on
every pass in silence. Withdrawing it needs a record state the platform does
not have, which is raised separately. And a state this build does not recognise, which a newer
deployment could introduce, is named rather than passed over in silence: if
such a state turns out to be an ending, quietly skipping it would leave the
record published as open while every check reported perfect health.

And it cannot say why an ending was missed in the first place.

The correction, the tidying and the messages to the two holders are a single
write, which either happens completely or not at all. That is not a refinement: a
correction that landed on its own would take the record out of the set the
rotation looks at, so nothing would ever come back to finish the job, and a
service killed mid-way leaves no failure to report either. Committing them
together is the only version with no window. The messages were the last
thing still written afterwards, and they had the same flaw: a failure there
left the position corrected and the two people with money in it told nothing,
permanently.

A failure to look up the two parties is treated the same way as a failed
write, including the waiting: the correction is abandoned, and the rotation
has already moved past that record, so it is reached again only when the
rotation next comes round.

The messages are written only where the correction was actually made by
this check. If another part of the service recorded the ending first — which
is the very race the check is built to lose gracefully — it stops, rather
than telling the two holders it discovered something it did not. And where
looking up the parties in its OWN records fails, that is treated as a
failure rather than as "nobody to tell": the whole correction is left for
the next turn instead of going through with the part that is silent.

That applies to its own records and not to the chain, and the difference is
the point. A query of its own store that fails has unambiguously failed, so
waiting is safe. Asking the chain who holds a position gives one answer for
"nobody holds it" and for "the question did not get through", and since
those cannot be told apart, waiting on the second would mean never
correcting the first. So that case commits the correction and sends no
message, as set out above.

One failure it survives rather than prevents: if the write for one record
fails while others in the same turn succeed, the successful ones stand and
are reported, and the failed one is left exactly as it was. It is not looked
at again on the very next turn, though: the rotation has already moved past
it, so it comes round again when the rotation next comes round — which on a
long list, or on the arrangement that examines one record a turn, can be a
considerable wait with the position still published as running.
An earlier version threw the whole turn away, which quietly discarded
corrections that had already been made — and because a corrected record
leaves the set being checked, nothing would ever have gone back to account
for them.

### Not included

The other half of the original report — that the published list and the
published count apply different filters, and so answer the same question
differently — is deliberately not fixed here. Applying that filter first
would take the list from nine entries to seven while the chain says six:
the surfaces would still contradict each other, and the remaining ghost
would be harder to notice because the obvious disagreement had gone. The
repair is the part that has to land first.

Closes #2101. Four follow-ups carry what deliberately did not land here:
#2194 (a subrequest overrun on the fallback ingest arrangement that
predates this change), #2195 (the participation and lifecycle records a
correction does not yet write, and a source for who HELD a position that no
longer exists), #2196 (making a correction's live announcement survive the
service dying between the write and the sending) and #2197 (a record state
for a row the chain has never heard of, so it can stop being published as
running). The last is recorded in the code-versus-docs audit rather than
resolved by editing the specification.
<!-- assembled-fragment: 2101-loan-status-reconciliation.md sha256=2e0dd532484d4a9591652908ad99907aae6bd1b6563ac327be4f8d880b66d99a -->
