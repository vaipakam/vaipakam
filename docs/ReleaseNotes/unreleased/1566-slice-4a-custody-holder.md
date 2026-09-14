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
When the platform itself is the configured treasury, its receiver accepts
exactly the token, id and amount a custody sweep has pinned for that one
delivery and nothing else, so recovery works in that configuration while the
platform stays closed to every other inbound NFT.
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
