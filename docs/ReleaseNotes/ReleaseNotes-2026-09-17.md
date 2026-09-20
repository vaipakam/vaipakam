# Release Notes — 2026-09-17

Nine entries, in the order the file assembles them: the keeper's arming
flags, the transport epochs, the reminder hold, the indexer's request count,
the order payment reminders go out in, what a held record now tells a person
about the loan number it is holding, a lookup that no longer fails because a
lot is waiting for it, a correction to what the notification service does when
a change merges, and — following directly from that one — how to tell whether
any service is running the code that was merged. The transport epochs are
the substantial one — the last part of the #1566 programme before the role
carry-forward — and what that change adds is deliberately inert where it
counts: no ledger arithmetic moves, and no classification comes out
differently than it would have yesterday. It is not inert in the sense of
adding nothing — anyone may now ask the sending chain to attest a
delivery's composition, pay the quoted transport fee for it, and have the
receiving chain record the figures. That supplies the one thing the
previous release left missing: a mirror holding value whose composition it
was never told can now be told, by the chain that sent it, what that chain
recorded when it sent. The figures are kept and not yet consulted, because
the step that would consult them does not exist until the next change; and
what a classification may treat as evidence is worked out from them when it
is asked rather than frozen in advance, since asking the source and
releasing the value are both open to anyone and can happen in either order.
Alongside it, every arrival now commits to the days it names, so the ledger
that comes next can check a re-supplied list against the chain's own record
rather than against an event.

The last entry is a different kind of correction: a figure the system was
asserting rather than knowing. The indexer works to a fixed allowance of
outbound requests per run, and the number it was working to lived in a
hand-written note that three consecutive reviews corrected and three
consecutive reviews got wrong. It is now measured as it is spent. The same
entry records what measuring it honestly cost — the count had to stop
following a moved address, because counting those moves exactly would have
meant re-implementing the web's own forwarding rules and keeping the copy in
step forever.

The reminder-ordering entry is a near neighbour of that one, and shares its
shape: a service that knew where it had stopped, recorded that place in a form
that stopped meaning what it said, and carried on confidently. It kept its
place in a list that is rebuilt every run, so once the loans it had just
handled dropped out, the remembered place pointed past the very deadlines that
should have come next. It now records the deadline instead. Whether any
reminder was actually missed is recorded as unknown rather than assumed either
way, which is the honest state of it.

The two remaining corrections are both cases where a record and the thing it
described had drifted apart. A Worker's configuration file called three
arming flags plain settings when they are secrets, which matters to anyone
reconstructing what a deployment actually holds. Two of the three were
found unset at the last live check, over a month before this correction;
whether the deployed keeper is armed today is not something this change
establishes, and the entry says so rather than letting a stale observation
read as current posture.

And a reminder could still be sent about a loan nobody had confirmed: a
record the periodic check could not settle stays stored as open, which is
exactly what a permanently missed ending looks like, so those records are
withheld from reminders rather than read as ordinary. The memory of which
records are unconfirmed is written after each turn rather than within it,
so a turn interrupted in between loses its entry and leaves that turn's
worth of exposure — the next turn to examine the record writes it again.
The entry states that limit rather than leaving it to be discovered.

The sixth entry continues that same hold, and the reason it is worth reading
is what it decided NOT to do. A held record silently withholds reminders from
whatever loan currently bears its number, so releasing it automatically once
the number belongs to a different loan looks like the obvious fix. It was
built, and then removed: every way of establishing "this is a different loan"
from what the platform has stored proved unsound, four different ways, each
found after the previous was fixed. The platform now tells a person what the
number points at today and lets them decide, and labels that description as
stored and unverified rather than presenting the same record it refused to act
on as settled fact.

The seventh and eighth entries are both about a claim that was true when it was written
and had stopped being true, which is the day's recurring shape. One is a
question the platform asks its own store about many records at once: it can be
refused for naming too many things, and the refusal arrives exactly when a
backlog has built up — so the pass that would drain the backlog is the one that
cannot run. Three places had independently learned the limit and two had never
heard of it, so it now lives in one place that works out the size from the
question being asked.

The other began as a single stale sentence — documentation saying a service is
not deployed automatically when a change merges, when it is — and turned into a
longer lesson about what could be promised alongside it. The surrounding
guidance described how to protect a database change by closing the ways users
write. Review found one more way in each time it looked: work on a timer, a
background alarm that restarts itself, work already running when the closure
went up, addresses that bypass it. Listing the ways code can reach a database
turns out not to be a finishable task, so the document now states the hazard
plainly and says the procedure is unsettled, rather than offering a list that
reads complete and is not. That is a smaller promise than it made this morning,
and the only one it can keep.

The ninth entry grew out of the eighth, and it is worth reading for what it
stopped claiming rather than for what it established. Having corrected one
stale sentence about which services deploy themselves, the obvious next move
was a reliable way to check. Two candidate checks were tried and both
misled — looking for a build to have run, then reading a deployment's age —
so what survives is deliberately one-sided, and weaker than it first reads:
a deployment older than the newest change is **evidence that the service may
be behind and worth inspecting**, while a newer one establishes nothing at
all. Not even the first half is certainty — a change can carry a timestamp
later than the moment it landed, so a current service can compare as behind.
Being wrong that way costs a second look; being wrong the other way is what
the check exists to prevent. Saying only the half that holds, and saying it
as evidence rather than as a verdict, is less satisfying than a green tick
and is the only version that does not eventually tell somebody the wrong
thing.

## Thread — the keeper's arming flags are secrets, and its own config finally says so (PR #2223, issue #1465)

The keeper Worker's configuration file described `KEEPER_ENABLED`,
`REWARD_REMIT_ENABLED` and `REWARD_COMMIT_ENABLED` as "operator-managed vars
(non-secret config — plain vars)". They are not. They are per-Worker secrets,
set the way secrets are set and unreadable afterwards from either the API or
the dashboard. That was checked against the live deployment on 2026-07-30 for
the kill-switch specifically; the two reward flags were **absent** there and
are provisioned the same way when they are armed. The distinction matters for
anyone reconstructing deployment posture: two of the three are not unreadable
live state, they are simply not set.

Their absence would leave three scheduled duties dark rather than two, which
is worth stating precisely because the flags and the duties are not one-to-one:
the reward-budget remittance pass and the remittance-acknowledgement pass are
both gated by the remit flag, and the commitment-report pass by the commit
flag. An operator reconstructing what is running from the flag names alone
would otherwise miss the acknowledgement duty entirely.

That "would" is doing real work. The deployed keeper currently has **no cron
schedule at all** — it was deliberately unscheduled after nearly every
invocation exceeded its CPU ceiling — and this Worker has no HTTP surface, so
every pass is dark right now regardless of any flag. The flag-by-flag account
above describes what gates what *once the schedule is restored*; read as a
description of today it would wrongly imply the non-reward passes are running.

The Worker's own environment module and the off-chain restore runbook already
recorded the classification correctly, and the runbook went as far as naming
this config file as the one carrying the wrong description. Several other
places did not, and are corrected alongside it: the keeper README filed the
reward passes' lookback and lane-cap knobs under "set with `wrangler secret
put`" although they are ordinary variables; the root contributor guide left
both reward arming flags out of the keeper secret list; the Secrets Store
migration plan listed the kill-switch as non-secret configuration; the
environment module's own passthrough label said "non-secret" while covering
all three flags, contradicting a correction recorded twenty lines above it;
the incident runbook's reward-remittance prerequisite told operators the flags
live in the Worker's variables; and two design and restore documents carried
warnings that the configuration comment could not be trusted, which were true
until this change and are now stale.

The way that list was arrived at is worth recording, because the first attempt
was wrong. Sites were initially found by searching for classification
*language* near a flag name — and that search missed the incident runbook,
whose sentence says only "in the keeper Worker's vars": no "plain", no
"non-secret", nothing the pattern was looking for. Deciding from prose whether
a sentence classifies a binding is the same unbounded guess this repository
has been bitten by before. The list above instead comes from reading **every**
mention of the three flag names outside dated changelogs and tests — a fixed
set of exact strings, small enough to read in full. That is a bounded check,
and it is what turned up several entries no review round had named.

What this deliberately does not claim is completeness. Each of three review
rounds found one more document saying something looser than the code does,
and "no prose anywhere could mislead a reader about this" is not a property
anyone can check. The corrected sites are the ones that were found.

Where a disagreement turns up later, it resolves against the live deployment
and the recorded decision, not against the Worker's code comments — those are
descriptions of a deployment choice, and the environment types a variable and
a secret identically, so the code cannot establish the binding class on its
own. If a ratified decision ever changes the intended classification, the
comments are what gets updated to match it.

The consequence was not cosmetic. Reading that heading, the reasonable next
step is to commit an arming value into the config so the live state is
visible in review — which is exactly what the tracking issue for this
proposed. Doing it would change deployment semantics twice over. A committed
variable arms or disarms the keeper from any clean checkout. And a variable of
the same name does not sit beside the secret — the deployment tool's own
collision warning says it replaces the remote secret with the configured
value, so committing the flag destroys the binding it was meant to document,
with no fallback and no rollback short of setting the secret again after
removing the variable. The environment module already recorded the decision
not to do this; the config now points at that decision, and at the mechanism,
instead of quietly inviting the opposite.

The same tracking issue also reported that every plain deploy silently
cleared these flags. That was true of genuine dashboard-managed variables and
is now prevented by the preservation setting this Worker declares, but it was
never true of the three arming flags, because a deploy does not remove
secrets. Both halves of that report are therefore resolved — one by the
preservation declaration, one by the flags never having been variables in the
first place — and the config now separates the two classes so the distinction
survives.

That preservation promise is itself narrower than it reads, and the config now
says so: it protects variables the configuration does not declare, because a
declared one is uploaded on every deploy like any other setting. The bot
handle is the one variable this configuration does declare, so a dashboard
edit to it is overwritten rather than kept. Nothing else in the plain-variable
class is declared, so everything else in it is genuinely preserved.

The bot handle is a weak example of its own rule, and the documentation now
says so rather than leaving an operator to discover it: no keeper code reads
that value at all — the Telegram link that uses the handle is built by a
different Worker from its own binding — so setting it either way changes
nothing the keeper does. It is kept because the declaration is what makes the
overwrite behaviour visible, not because the Worker needs it.

One thing this change does not establish is whether the deployed keeper is
currently armed. For the kill-switch the value exists but cannot be read back,
which is the whole reason each gated pass reports how it resolved it at
runtime; for the two reward flags the last live check found nothing set at
all, and that observation is over a month old.

Closes #1465.
<!-- assembled-fragment: 1465-keeper-arming-flag-classification.md sha256=982f1feb564d701596440f79a62ca3721a04814cc6b35610e1514b04ae6db8aa -->

## #1566 transport epochs, first change — the attested split, and every arrival's day-list commitment (PR #2224)

The cutover's second part let an administrator classify a protected packet's
value, and bounded a fresh classification by evidence the administrator
cannot write: what the packet's source chain recorded of its split. Nothing
on a live deployment could supply that evidence, so an untyped arrival could
be classified recycled only. This change supplies it — recorded for later
rather than consulted yet — and records one more fact about every arrival
that the transport epochs' ledger will need.

**The attested split.** The canonical chain can send, for any remittance it
issued, the split it recorded when it sent: the fresh figure and the recycled
figure, toward the chain that remittance went to. Anyone may ask it to. The
content is the chain's own record, so a caller can neither forge nor inflate
it, and the caller pays the transport fee, which the platform quotes
beforehand. The mirror that received the remittance resolves it through the
receipt the delivery created and keeps both figures once, each scaled down to
what actually landed in the same proportion, so a short delivery shrinks both
and never leaves one larger than the whole. It refuses what it cannot
honestly attest: a packet whose wire already carried its split, a receipt
whose delivery came from a chain other than the attesting one, a receipt that
predates packet stamping, an empty split, and a second attestation that
disagrees with the first — the first record is the source's, and a differing
one is a faulty source rather than a correction. A second attestation that
says the same thing changes nothing and is accepted, because asking again is
how a sender handles a delivery it cannot confirm, and the transport fee is
paid whether or not the message lands. A refused message stays re-executable,
so a repeat send is a retry, not a grief.

Only a remittance that carried its own identity on the wire can be attested.
The oldest wire shape carried none — no receipt exists for it, and the
canonical chain holds no reservation — so such a packet's fresh component
stays unauthenticated for good: it classifies recycled, or leaves untyped
through the dispositions the epoch already provides.

**Recorded, not yet consulted, and never frozen.** The two attested figures
sit beside the packet and are never changed afterwards. What a classification
may treat as evidence is worked out from them at the moment it is asked,
never written down in advance at some earlier step — because asking the
canonical chain to attest is open to anyone, and so is the step that later
releases a packet's value for classification, and the two can happen in
either order. A figure frozen before the attestation arrived would read as
"no evidence" for ever, for exactly the packets the attestation was sent to
evidence. Today the release step does not exist yet, so the answer is the
same as it was before this change: an attested packet still classifies
recycled only. The transport epochs' ledger, the next change, is what makes
the answer move.

**Every arrival commits to its day list.** A packet on any wire before the
next wire version names the days it funds. The mirror's ingress now records,
with the packet and in the same transaction, a fingerprint of that list and
its length. Nothing reads them yet. They are what the transport epochs'
ledger will check a re-supplied day list against when it admits a packet,
so a packet that landed before that ledger existed is never admitted on the
strength of an event, only of the chain's own record. A compensation
delivery, which names one day, is committed the same way.

**The mirror-side ingress has its own facet.** The three entries the
transport calls on a mirror — the budget delivery, the compensation delivery
and the compensation-day hook — moved unchanged out of the remittance facet,
which had almost no room left under the platform's per-facet size limit, into
a facet of their own, because the ingress is exactly where this family of
changes and the role carry-forward after it will grow. Every caller reaches
them by the same identifiers through the same entry point; only the code
behind them is separate, and a refresh must carry the two together. The one
derivation of a delivery receipt's key, which four places had copied byte for
byte, now lives in one place.
<!-- assembled-fragment: 1566-transport-epochs-3a.md sha256=174d78b6af638e846c8393c883a6ac641d3664131cf297c17a09d33a1f2f3cc0 -->

## Thread — A reminder could still be sent about a loan nobody had confirmed (PR #2213, issue #2212)

The platform checks its own loan records against the chain a few at a time,
and derives due-date and grace-period reminders from those records. A record
the check could not settle — one the chain has never heard of, one whose state
could not be read, one whose correction failed to write, one in a state this
build does not recognise — is still stored as open, which is exactly what a
permanently missed ending leaves behind. Reminders fire once and are never
taken back, so "prepare to repay" must not be derived from a record nobody has
confirmed.

A previous change held such records back, but only on the turn that noticed
them. Since each turn looks at a handful of records, the very next turn had
nothing to hold back — the record was simply not in that turn's findings — and
the reminder went out anyway. The mistake was treating *what this turn looked
at* as if it were *what is currently unconfirmed*. Those are different
questions, and any answer read from a single turn confuses them.

That is worth stating plainly because the obvious cheaper fix fails the same
way. Holding back **every** record on a turn whose findings were dirty looks
stricter and is not: the next turn's findings are clean for having looked
elsewhere, so the reminder still goes out — and meanwhile every healthy loan
on that chain loses its reminders too.

### What changed

The platform now remembers an unconfirmed record until a later turn confirms
it. The reminder surface consults that memory rather than the current turn's
findings, so a record stays held back across every turn that does not examine
it.

What is remembered is *which* way the record could not be confirmed — an
unreadable record, a failed write, a state the build does not recognise, and a
record the chain denies all need different responses — and *when it was first
noticed*, which is preserved rather than refreshed each time. That distinction
is the whole operator signal: minutes means a source having a bad moment, days
means a position nobody has resolved. A record held back that long is now
named out loud, with its age and when its unconfirmed state was last
successfully recorded — the platform says
what it observed and leaves the conclusion to whoever reads it.

Releasing is the half that had to be right. A record held back forever on the
strength of one bad read would be the mirror image of the defect, so release
is derived by subtraction — everything the turn examined, minus everything it
could not settle — rather than from a list of releasable cases. A list would
mean that a newly added kind of failure is released by default: marked by one
half and cleared by the other on the same turn, with nothing appearing wrong.

### Three quiet failures in the first attempt

**A record ended the ordinary way would have stayed held back forever.** A
record held after one unreadable moment, whose ending then arrives normally
before the check comes round to it again, leaves the set the check draws from
— so nothing could ever release it. It would have been held, and reported as
stuck, for good. Releasing now also happens wherever a loan is closed out,
which is the list every close-out already shares.

**The platform would have stopped reminding anyone at all during a deploy.**
The reminder query names the new memory, and the deploy sequence publishes the
new code before the database change that creates it. In that window the query
fails, and the surrounding safety net turns one failed query into *no reminders
on any chain* — a far bigger outage than the one this closes, and open
indefinitely if the database change then fails. The query now asks whether the
memory exists and, when it does not, reminds exactly as it did before and says
so. It starts holding records back the moment the change lands, with no
redeploy.

**The operator report claimed more than it knew.** It named at most twenty
records, so on a chain with more than that the same twenty appeared every time
and everything behind them stayed silent — while the note said anything held
that long is reported. It now counts the total and says how many it left out.
It also no longer asserts that a source "has not recovered", nor that
retrying cannot settle the record: on a chain whose check takes longer than
the threshold to come round, a record can pass it without having been looked
at again, and may settle the moment it is. The report gives its age and when
its unconfirmed state was last successfully recorded, and leaves the
conclusion to the evidence.

### What else had to be right

**A second reminder lane was still speaking.** Due-date and grace reminders
are not the only unretractable message the platform sends about a loan: a
separate lane sends "your interest payment is due" and marks that checkpoint
as told. It reads the same stored records, in a different part of the system,
and had no idea about any of this — so a user could still be told a payment
was due on the very loan every other reminder was being withheld for.

That lane now does something different from the reminder sweep, and the
difference matters for anyone diagnosing it. Rather than consulting the
memory, it **asks the chain directly** about each loan it is about to message,
after every cheaper filter has narrowed the candidates to a handful. So the
two lanes fail differently on purpose: the sweep depends on the memory being
present and current, while this one depends on the chain being reachable and
simply stays quiet for that turn when it is not. Nothing is marked as told, so
the next turn asks again, and the window is days wide.

**What asking the chain does not give you is a guarantee, and this is worth
being exact about.** The answer is true at the moment it is read. A loan that
ends in the seconds between that read and the message going out is still
messaged, and its checkpoint is still marked as told. Nothing off-chain can
close that gap — the message is sent from outside the chain, so there is
always some interval between asking and speaking. What the check removes is
the large case: a record that has been wrong for hours or days because an
ending was missed. What remains is a few seconds, on a reminder about a
payment that is still days away.

The reason for the split is width. The sweep considers up to two thousand
records per chain each turn, where asking about them would cost more requests
than that part of the platform's budget allows even when the asking is
batched; this lane considers the few inside a three-day window. A first attempt
had it share the memory instead, and three separate problems followed — all of
them about coordinating two independently-scheduled parts of the system rather
than about the rule itself.

**Asking once per loan turned out to be the same budget problem in miniature.**
Each run of this lane has a fixed allowance of outbound requests, shared with
everything else happening on that run, and "a few" was an assumption about
load rather than a limit. That allowance now covers **every** request the run
makes, the platform's own chain queries included: they were bounded per
network while the messages were bounded per run, so adding a fourth network
would have pushed a busy run past the ceiling — with the overshoot landing on
messages that had already been attempted and recorded as sent. And an
allowance that ran out partway through did not merely stop that chain — it
stopped every chain after it in the same run, on every run, indefinitely. Two
changes make the assumption unnecessary: a chain's checks now go out in
batches of a hundred rather than one request per loan — up to three batches,
so three requests where there were a hundred — and what a single run may send
is capped outright.

A cap has to be fair or it is just a quieter way to lose reminders, so the
order is now **nearest deadline first**, and the run starts at a different
chain each time. A loan the cap defers is one place nearer the front on the
next run, and gets there well before its own deadline; without that order the
same records would be reached every time and the ones behind them never.

A run also **remembers where it stopped**, and which network it began with,
and the next one continues from there — and when that could not be written
down, the run says so instead of promising the resume anyway. The record of
where to continue is kept by the same database that can refuse it, and a
summary claiming a resume the database had just rejected contradicted the
warning printed a line above it. The reassuring line is the one someone would
have acted on. Deriving either position from the clock
instead works until it meets the platform's other rotation: a network that
only gets a turn every third run sees the clock advance in threes, so the
position it computes can be the same one every time it is actually asked, and
two thirds of its window would never be examined. Any schedule-derived
position can fall into step with some other schedule; a remembered one
advances on the work actually done, which nothing can align with. That holds
at both scales — which record to resume at, and which network goes first — and
they are the same defect. When the platform cannot remember either position it
now says so, because silently starting from the front every time restores the
unfairness the memory was added to remove, and does it invisibly. The position
is approximate — the list it indexes into changes between runs — and that is
stated rather than implied, because near enough is all that forward progress
needs.

**A cap that counts the wrong unit reintroduces the very unfairness it exists
to prevent.** Counting *records* is not counting work done: anything that
occupies a record slot without sending anything still holds the whole run's
allowance and is never marked as handled, so the same few records sit at the
front on every run while the people behind them are never reached. At least
two separate kinds of record do that — one the chain rejects, having never
heard of it, and one whose recipients have both switched these reminders off —
and fixing them case by case would only keep finding the next one.

So the limit now counts the thing it exists to protect: **outbound requests**,
decremented wherever one is actually issued — the platform's own queries to
the chain, the messages it sends, **and its own reads and writes of the
platform's records**, which are outbound requests too and were not being
counted as any. That last part is the correction, and it matters most where
the run was quietest: a run that sent nothing at all still made two record
lookups per position, so a busy network could pass the limit while every
message it thought it was rationing went unsent.

A record that issues nothing still cannot consume the limit — but "issues
nothing" turns out to be a narrower set than it first appeared. A position the
chain rejects costs nothing, because there is nothing worth asking about a
loan that does not exist. A position whose recipients have switched these
reminders off costs two lookups, because **establishing that someone opted out
means asking**, and there is no way to know without it. What survives, and is
what the fairness this cap exists for actually needs, is that such a position
costs only its lookups and never its messages, that a subscribed position
behind it is still reached on the same run, and that the run's remembered
place moves past it so the next run starts beyond rather than paying for it
again.

Stating the limit in requests rather than in messages is what lets an operator
explain a run that exhausted its allowance while delivering little. A run also
walks past records it cannot send for, in batches of a hundred, and reaches
the ones behind them on the same run.

The run also holds back the one request it needs to SAVE ITS PLACE, and will
not begin a record it could only finish by spending it. Saving the place is
the last thing a run does, so nothing else was checking that it would still
be affordable — a run could stop exactly one request over its own limit. And
a run that stayed inside the limit by skipping that write instead would
re-read the same prefix on every later run, which is the unfairness the
remembered position was added to remove. The two have to hold together.

One consequence is worth stating because it looks like waste: a run refuses to
begin a record it might not be able to finish, which can leave a little
allowance unused. Stopping halfway through a record would tell one party and
mark the reminder as delivered, so the other party's reminder would not be
delayed — it would be lost.

**Not spending the allowance is not the same as making progress.** A record
that sends nothing is also never marked as handled, so it keeps its place at
the front of the order and is examined again on the next run, and the next.
Costing nothing does not move it. With enough of them ahead of a record that
would send — a few hundred recipients who have these reminders switched off is
not an exotic situation — starting at the front every time hides the record
behind them permanently. So when the window is wider than one run can
examine, successive runs begin at successive parts of it. Every record is
examined within a few runs, which are minutes apart in a window measured in
days, and when the window fits in one run the nearest deadline is still
examined first.

**A message that was never issued is no longer counted as one.** The platform
was charging itself for messages it had not managed to attempt — when no
signer was configured for one of the two channels, and again when the
configured signer was unusable, which fails every message of that kind rather
than one — and a recipient the platform has on file but has no way to reach
was being reported as reminded. None of these change who gets a reminder. All
of them were letting a run's own accounting say more than had happened, and
the misconfigured-signer one had teeth: it spent the run's whole budget on
messages that never left, deferring the recipients the platform could still
have reached on the other channel.

The sending step now reports what actually happened — nothing left, the
service accepted it, or the attempt failed — and the run charges and counts
from that answer rather than from having called it. Those two uses of the same
answer disagree about a failed attempt, deliberately: a request that may have
gone out is charged, because the limit exists to keep the platform inside what
it is allowed to send, and is *not* reported as a delivery, because nothing
confirms it arrived.

So "reminded" now means the delivery service confirmed it. A message it
refused — a rotated token, a stale chat — and a message whose fate is unknown
are each counted as their own thing. Before this, both were reported as
reminders, which is precisely the number someone would read while trying to
work out why nobody had heard from the platform.

A service that says "not now" — rate limiting, or being briefly unwell — is
counted apart from one that says "not ever, as configured". Both are answers
and both mean the message did not go, but only the second needs a person: the
first clears on its own, and filing it under the total whose stated meaning is
"keeps failing until someone repairs it" would send that person to replace a
credential during an incident that needed nobody.

**Whether a reminder is marked as finished is now one rule, decided for the
position rather than assembled from each party's outcome.** Marking it means
"never come back to this period", and that is earned exactly when no later
run could do better for anyone — which is three questions. Was anybody
actually reached, in which case coming back would tell them twice? Is
anything uncertain — a message that was sent and never answered for may have
arrived, so coming back risks that same duplicate? And is anybody owed
another attempt?

Only two things earn one: a service that said "not now", and a recipient who
switched the reminder off and may switch it back on before the deadline. A
refusal does not, because it will fail the same way until a person acts.
Having no usable channel does not, and neither does having no subscription.

This replaces a scatter of separate judgements that was corrected four times
in three review rounds, each time for a different combination of the two
recipients' situations, and each correction leaving the next combination
standing. The cause was structural rather than arithmetic: a single word per
recipient cannot carry two recipients' worth of partial knowledge. The rule
is stated once now, in terms of what the mark means.

**Someone who asked for a channel the deployment cannot use is owed another
try, not written off.** This is the tail of the change above and it only
became visible once that one landed: reporting an unusable channel as "never
attempted" — which is the truth — left a recipient who has ONLY that channel
with nothing at all recorded against them, so nothing said they were owed and
the reminder was marked finished. An operator repairing the setting, or the
dependency, during the window could then no longer deliver it. Marking a
record as handled while delivering nothing is the failure the whole
disclosure above exists to make visible, and it had reappeared one step
further down. Such a record now stays unmarked until a usable channel either
succeeds or leaves the outcome uncertain.

A refusal does not earn another attempt and does not block one either, which
has a price worth naming: a position where one party is owed an attempt and
the other's channel was refused comes back, and the refused channel is tried
again beside the party who is owed, because there is no way to reach one
without the other. On a deployment whose credential has been rotated that is
every position with a party who has switched reminders off. What bounds it is
the remembered place in the window, which moves past a position whether or
not it was marked — so the futile attempt costs once per trip round the
window rather than once per run.

**One consequence changes a previously stated behaviour, and is called out
because nobody asked for it.** A position where one party had no usable
channel and the other had switched reminders off used to be marked as
finished, on the reasoning that the first party was settled. That is true of
them and says nothing about the second, who may re-enable before the
deadline — and since nothing was sent to anybody, there was no duplicate to
protect against. It is now left unmarked, like any other position where
somebody is still owed an attempt. The cost is that such a position is looked
at again each run for the rest of its window, which is what a position with
both parties opted out has always cost.

**And "not now" now means the platform comes back.** Telling an operator the
message would be retried was only half of it: the reminder was still marked as
handled, and a reminder marked handled is one the platform never revisits — so
a thirty-second rate limit could suppress a borrower's payment reminder for
that period permanently, while the report said it had merely been deferred. A
reminder the service only deferred is left unmarked, and a later run sends it.
The opposite case is deliberate and unchanged: a reminder the service
*refused* stays marked, because the same message will fail the same way until
somebody repairs a credential, and re-sending it every few minutes for the
rest of the window buys nobody a reminder. And a reminder that reached one
party over one channel stays marked whatever the other channel did, because
the mark is per position — coming back would tell the party who was reached a
second time about one payment.

A message the service ANSWERED and refused is counted apart from one whose
fate is unknown, because they need opposite responses: a refusal is a
credential or a destination to fix and will keep failing until someone does,
where an unknown may be a passing incident. An earlier version of this note
promised that separation while the code still had one bucket for both — the
sending step returned a yes/no, so the distinction was thrown away before
anything could count it. It returns a verdict now. Only one of the two
channels can tell the difference today, and the platform says that rather
than implying the other never refuses.

Failed messages are counted per channel, and separately from whether the
person was reached at all. Someone told over one channel while the other
failed is both a reminder and a broken channel; counting only the first would
have hidden an outage of one channel for as long as the other kept working —
which is the outage hardest to notice and the one worth reporting most.

**A loan can be open and still have nothing due.** The reminder is about a
particular payment period, and a borrower who has just paid leaves the loan
open with the platform's own record still pointing at the period they settled.
Every other condition passes, and the reminder would have arrived moments
after the payment. The chain's own record of when the last period was settled
now decides it: if the period the reminder is about is not the period the
chain is on, nothing is sent and the record waits for a later run, by which
time the platform's records have caught up. That answer was already in the
reply the platform was reading — it simply was not being looked at.

**And a check is only as good as what it checks against** — starting with
whether the source is the right network at all. A setting pointed at a
different chain answers every question confidently and about the wrong one,
so it could confirm a loan that has nothing to do with the reminder being
sent. The part of the platform that scans the chain has refused that
configuration since long before this change; the reminder lane became
authoritative about whether a loan is still running and never asked. It asks
now, once per source, and stays quiet if the answer is wrong or absent.

**A reminder is only worth sending if the payment it demands can be made.**
Governance can switch periodic interest off across the platform. That stops
new positions taking a cadence and makes settlement itself refuse — but a
position already open keeps the cadence it was opened with, because that is
fixed when the position starts and no later change touches it. So with the
switch off, every existing position still looks due to this lane, which would
go on telling borrowers to pay before their collateral is sold, for a payment
the platform would reject. An instruction the recipient cannot act on is worse
than silence, and it is worst during whatever emergency prompted the switch.

The lane now reads that setting before it speaks — in the same request as the
lead time, so it costs nothing extra — and sends nothing on a network where it
is off, marking nothing, so reminders resume by themselves when it is turned
back on. A run that cannot READ the setting also sends nothing, on the same
reasoning as everywhere else here: not knowing whether a payment can be made
is not permission to demand one.

**And switching periodic interest off is not the only way settlement closes.**
The platform-wide halt described next is asked FIRST, because that is the
order the settlement route itself uses and because it is the more serious of
the two — a first version of this asked it second, so with both closed the
reader was told only about the milder one, and a failed read of the
periodic setting hid the halt completely.

The platform has a second, independent emergency stop that halts everything at
once — and the settlement route checks it BEFORE it looks at the
periodic-interest setting, so a deployment can have periodic interest enabled
and still refuse every payment. Reading only the first setting left exactly
that case sending reminders. It is also the worse case of the two: a
platform-wide stop closes ordinary repayment as well, so someone told to pay
before their collateral is sold has no route at all, not even the one they
would fall back on. Both settings are now read before the lane speaks, and
neither being readable is treated as permission.

That setting is read at the SAME moment in the chain's history as the
positions themselves. Asked at "now" instead, it could report the payment
available for a moment the positions were never read at — because the setting
changed in between, or because two machines behind one address answered from
different heights. The result would be the reminder this whole rule exists to
prevent, arriving through the check meant to prevent it. A run therefore
settles on one moment first and reads everything against it. That costs one
extra question on a network with nothing due, where the run used to stop
earlier; it is the honest price of every answer describing one moment.

**A missing bookmark is not a fresh start.** The freshness check compares the
network's head against how far the platform's own records have been brought
up to date, and that position is read from a single stored row. A missing row
used to mean "nothing has been indexed, so there is nothing to be behind", and
the run went on to send. That reading is only safe where the absence explains
itself — a network the reader has never run for has no stored positions
either, so nothing would be sent regardless. Where it does not explain itself,
a partial restore or a deleted row, stored positions exist whose freshness
cannot be established, and a lagging source will report one of them as running
at an older point. That is the very message the check exists to withhold. A
missing row now stops the run exactly as an unreadable one does — and is still
reported as its own thing, because a read that failed clears on its own and a
row that is gone does not.

**One of the two notification channels cannot send at all, and the platform
now says so instead of counting it.** The library the platform uses for its
app-notification channel signs each message using a method from an older major
version of its cryptography dependency than the one installed. The signing
happens before any request is made, so every notification on that channel
fails having sent nothing. This is not new and is not caused by this change —
but the run was charging its request allowance for those attempts and filing
them as messages whose fate is unknown, which since the change above also
means they SUPPRESSED the retry of a message the other channel had merely
deferred. A channel that cannot send anything was blocking the retries of the
one that can.

The platform now checks, before entering that library, whether the signer it
holds offers what the library will ask for. If not, no request is attempted,
nothing is charged, and the channel is reported as unusable for the whole
deployment — alongside the two configuration causes that produce the same
outcome, because the remedy differs for each and an operator sent to look for
a missing setting will not find a version mismatch. It is asked as a
capability question rather than guessed from the error, so the day the
dependency pair is fixed the channel resumes with no further change. Making it
send again is a dependency decision and is tracked separately.

**And a source can be the right network and still be behind.** The chain is
consulted through whichever source the platform is configured to use, and that
source can lag behind what the platform has already recorded. Asked about a
loan that ended after the point that source has reached, it answers that the
loan is still running — confirming the exact reminder the check exists to
withhold, which is worse than not checking at all. A run now compares the
source's position against the platform's own and sends nothing when the source
is behind, saying so — and also sends nothing when that comparison cannot be
made at all, because an unanswered question is not an answer and treating it
as one would turn a momentary database failure into permission to send. Every
loan in a run is also read at a single point in the chain's history, so a
source that serves part of the answer from further back fails outright rather
than quietly mixing two moments.

When a run does stop early, it says what it saw: how many records were in the
window, how many it examined, how many it reminded, how many the chain
rejected, how many are waiting on the platform's own records to catch up, how
many it could not read, and which of the two limits stopped it. Those are
different problems with different remedies — a run that keeps reporting
hundreds of rejections is reporting stuck records, not load — and flattening
them into "deferred" would hide the one that needs a person.

**Agreeing on a date is not agreeing on a schedule.** A reminder is about one
payment period, and how long that period is comes from the position's payment
schedule. The platform checked only that the chain's schedule was one it
recognised, then compared the resulting dates — and two different schedules
produce the same date whenever the last payments differ by exactly the gap
between them. A quarterly position and a monthly one sixty days apart land on
the same day. The dates matching then confirms nothing, and the reminder goes
out permanently marked and describing a schedule the position does not have.
The schedule the platform read the position with is now part of what has to
match, rather than something inferred from the dates agreeing.

**A record can disagree with the chain in two directions, and only one of
them fixes itself.** The platform compares the period a reminder is about
against the period the chain is on, and any disagreement disqualifies the
reminder — that part is right in both directions, since neither justifies a
message that cannot be taken back. But the two are not the same problem. When
the CHAIN is further along, the borrower has paid and the platform's records
are catching up; nothing needs doing. When the platform's OWN record is
further along — a payment recorded and then undone by the chain reorganising,
or a damaged record — nothing catches up, because the correction pass does not
revisit that field. Reporting both as "the records are catching up" told
whoever read it to wait for something that never arrives, while that
position's reminders stayed suppressed indefinitely. The two are now separate
verdicts with separate totals, and the second says plainly that it needs a
person.

**Two of those totals were the same total until review separated them.** A
borrower who has just paid leaves the chain's record of the period ahead of
the platform's for a few moments. The per-record line already called that
what it is — the platform's own records catching up — while the summary
counted it among the records the chain rejected and told the reader those
indicate stuck records needing repair. The parts were right and the total was
wrong, which is the harder way round: nobody reads every per-record line, and
the summary is what someone acts on. Both the wording and the total are now
decided in one place, so they cannot describe a record one way and count it
another, and a new kind of verdict cannot quietly inherit an existing total —
it has to be given one deliberately.

**And when recording that a record could not be settled fails, the platform
now says WHEN that record loses its protection rather than that it already
has.** The turn that noticed it still holds it back from its own findings,
which needs no write to have succeeded — that is exactly why the in-memory
half exists alongside the durable one. What is lost is protection on *later*
turns that do not examine the record again. Saying it was unprotected
immediately sent whoever read it looking for reminders that could not yet
have escaped, and understated the real risk, which begins quietly on the
following turn.

**That "last recorded" wording is exact, and the exactness was earned.** The
stored time moves only when the record of the problem is successfully written,
which is not the same as when the platform last looked — and this change made
the difference reachable, because it also made a failed write reportable. A
record examined minutes ago whose write failed keeps an older time, and
calling that "last examined" would say it is merely waiting its turn, sending
whoever reads it away from a record whose bookkeeping is broken. The stored
time cannot tell those apart; the failed-write report can, and now says so.

**A failure at the very last step could erase everything the run had just
done.** Marking a record as told is the final act for that record, and it
happens after the messages have gone out. When that write failed, the error
escaped far enough to discard the run's totals, skip the summary entirely and
leave the scan position unsaved — for a run in which real people had already
been messaged. An operator saw a generic failure for the whole network and no
sign that anyone had been told anything. The failure is now handled where it
happens, per record, so one unwritable mark cannot silence the rest.

What that warning CLAIMS is read off what the run actually did, rather than
asserted beside it. The mark is also written for a record nobody could be
reached for, so this failure is reachable with no message ever having been
attempted — and the first version of the warning announced a delivery anyway,
turning a database error into a claimed notification. That is the same
overclaim removed from the "reminded" total earlier, arriving by a different
door, which is why the sentence is now built from the recorded outcome: two
statements cannot drift apart when only one of them exists.

Where a message did go out, the consequence is stated rather than left to be
inferred: the mark is missing, so a later run sends that reminder again. That
is the right trade in this direction — a repeated reminder is recoverable
where a missed one is not — but it is a real consequence, and the mark is the
only record that the message already went.

**A failing chain would have printed its own access key into the operator
log.** When a chain read fails, the failure is written to the log so an
operator can see why the platform went quiet. The failure text produced by the
library used here contains the full address it tried to reach — which, on
every hosted provider the platform uses, has an access key embedded in it. So
the log written *because* a provider was failing would have recorded that
provider's key, on every affected loan, every run. The log now records only
the kind of failure and its error code, with anything address-shaped removed;
that is the identifying part, and none of it can carry a secret. The rule had
already been written down once, next to the code that first needed it, and was
not followed the next time the situation arose a Worker away — so it now lives
in the shared library both sides use.

**And a cleanup that fails no longer silences the report that would have said
so.** The tidy-up and the naming of long-held records ran under one failure
handler, in that order, so a repeating write failure returned before anything
was named — every long-held record on every pass went unmentioned while the
reads that would have mentioned them were perfectly healthy. That is the worse
half of the pair to lose, because the report is what tells anyone the tidy-up
is broken. They fail independently now, and a failed tidy-up says so and then
lets the report run.

**A record can also be released long after the fact, and now is.** The
ordinary release happens when a loan closes, alongside everything else that
close-out does. That leaves one gap: if the platform could not establish
whether the memory exists at that moment, naming it would have failed the
whole close-out, so the release is skipped — and by then the loan has ended
and left the set the periodic check draws from, so nothing would ever come
back for it. The record would sit held, and be reported as stuck, for a loan
that ended in the ordinary way. A sweep now releases every held record whose
loan is no longer running, on every pass. It keys on the record's own state
rather than on remembering what went wrong, so a release missed for any
reason — including reasons nobody has thought of — is picked up.

**Closing a loan could have stopped a chain being read at all.** The release
added above goes into the same all-or-nothing group of writes as the rest of
a close-out, so during the deploy window it would have failed that group,
which in turn would have stopped the reader advancing — leaving that chain
frozen on one block until the database change landed. Everything that touches
the new memory, read or write, now asks first whether it is there.

**And the platform still does not know what one of its own passes costs.**
The reader's pass has a fixed allowance of outbound requests, and the parts
of it were always reasoned about in prose rather than counted. That was
survivable while database calls were believed free — and they are not, which
is what this change established. Three separate corrections followed, each
found by someone re-reading the sum rather than by anything in the system: a
second lane making its own copy of the same question, and then nine further
database calls inside the repair step that nobody had ever counted, because
the code said in as many words that they cost nothing.

So the honest position, which the code now states instead of a fourth
figure: the worst case is ABOVE the ceiling and its exact value is unknown.
Going over does not degrade a pass, it stops it before its progress is
recorded, which is the frozen reader this whole change works to avoid.

What could be done now was: correct the claim that those calls are free,
before anyone else builds on it; take the repair step from three positions
per pass to one, which removes most of the uncounted cost as well as six
chain reads; and stop asserting a total that three rounds of arithmetic had
each got wrong. The risk predates this change — those calls were always made
and never counted — and this change is what made it visible. Giving that
pass a real counter is tracked separately and is a blocker for it, not a
tidy-up.

**And asking the "does this memory exist" question is itself not free, which
nearly reinstated the freeze it prevents.** A "does this memory exist yet" check is a database
call, and a database call is one of the limited number of outbound requests a
run may make. A negative answer was deliberately not remembered — remembering
it would leave a run ignoring the memory after it had been created, until
that run happened to restart — so during the window before the database
change lands, EVERY closing loan asked again, and a closing loan can reach
the check twice. A catch-up over a stretch of history with enough closures
would spend the whole allowance on identical questions and stop before
recording its progress, which is precisely the frozen chain this guard
exists to avoid.

The answer is now remembered for the length of ONE pass over a network:
however many loans close in it, the question is asked once, and it is asked
afresh on the next pass so a database change that has just landed is noticed
within a pass rather than whenever a run restarts. Both mistakes are bounded,
and the one that remains is the harmless one. Remembering also only happens
where a pass has explicitly been opened — a lane that never opens one keeps
the old behaviour and pays the extra question, because the cost of getting
this wrong in the other direction is a run silently ignoring the memory for
hours, and the cost in this direction is one database read.

**A deployment that cannot send one kind of message now says so.** The
platform reaches people over two channels, and one of them needs a signing
credential the operator configures. A subscriber who has asked for that
channel while the deployment has no credential could never be reached on it —
and, once the run stopped charging itself for messages it was not going to
send, stopped being mentioned anywhere either. The diagnostic used to live
inside the sending step, and moving the check out of that step to fix the
accounting took the disclosure with it. So a run could mark forty records as
handled, deliver nothing, and say nothing, which is the ordinary shape of a
misconfigured deployment rather than an exotic one. The run now reports the
count once, naming the setting.

It names the credential as missing OR unusable, because it now covers both
and saying only "missing" would send someone looking for an unset value that
is sitting there and invalid — the slower of the two to find.

It is also reported ONCE for the whole network per run, and not once per
recipient. The sending step used to write the same line for every person it
was asked to reach, which on a wide window buries a real configuration
failure in its own repetitions — the failure mode where a message that
matters becomes something people scroll past.

It covers a credential that is PRESENT and unusable as well as one that is
missing, and the first is the worse case: a missing credential is at least
obviously missing, where a malformed one fails every message on that channel
while looking correctly configured. The platform now takes that answer from
the sending step — which tried and could not — rather than from inspecting the
setting and guessing.

The same disclosure now covers the platform's OTHER message channel, which
the first version of this fix left out — a rule applied to the case that
prompted it rather than to the class. Someone who asked for that channel on a
deployment that cannot use it was counted as having nobody to tell, which
reads as a fact about them when it is a fact about the configuration.

**And the number in that line counts people, which is what it says.** It was
counting appearances: one wallet that lends on five positions was five
misconfigured subscribers, so a single stale subscription on a busy network
reported as something close to a deployment-wide outage. Those two readings
call for very different responses, and the sentence was only ever true of the
first. It now counts distinct wallets.

**And a completed run reports too, when it has something to report.** The
summary only appeared when a run stopped early, on the reasoning that a run
which finished needs no explanation. That is true of a run where everything
went right and false of one that reached nobody — and the second kind never
stops early, because reaching nobody costs nothing. A run that finishes now
says what it saw whenever anything happened that a person would want to know
about, and stays silent otherwise. One of the tests written earlier in this
change had asserted that silence as correct.

**A record can also be released long after the fact,** and the pass that does
it no longer writes to a table it has established is missing. During the
deploy window the release step built one instruction per settled record
against a table that does not yet exist — failing every pass, then describing
the consequences in terms of withholding, while the reminder lane was
simultaneously and correctly reporting that nothing was being withheld,
because there is nowhere to withhold anything. Two parts of the platform
contradicting each other about one table is worse than either going quiet. The
answer to "does this table exist" was already established earlier in the same
pass; it is now consulted before anything is built. A pass that could not
establish it still tries, because a question that failed is not evidence of
absence.

And where that write does fail, it no longer says the records it was releasing
"stay withheld". Almost none of them were: the release runs over every record
the pass settled, which on a healthy network is ordinary positions that were
never held back at all, and the instruction for those does nothing. Claiming
they are now suppressed would invent a problem on exactly the networks that
have none — and the write failed, so which of them were actually held is the
one thing the pass cannot know. It says their state could not be updated, that
any which were held stay held until a later pass reaches them, and that the
rest were never held.

A third lane that messages users — the health alerts about a loan's safety
margin — needed no change, and the reason is worth stating: it works from the
chain's own list of open loans rather than from the platform's records, and
asks the records only who to tell. A loan the chain considers ended is not in
its list at all. That is the test for any lane added later: where does its
list of loans come from?

### What this does not change

Reminders for every record the platform *has* confirmed, which is nearly all
of them and includes every other loan on a chain where one record is stuck.
Holding one back never holds back the rest.

The memory is written after each turn rather than as part of it, so a turn
interrupted between the two loses that turn's entry — the record is still
unconfirmed, so the next turn that examines it records it again. That is a
turn's worth of exposure rather than a guarantee, and it is stated here rather
than left for someone to discover.

Closes #2212.
<!-- assembled-fragment: 2212-quarantine.md sha256=6a8b8cf979c31bb1f3fc4ebc4548d951dd81e6f8c0e195e12c687260ea115f48 -->

## The indexer now counts the requests it makes, instead of estimating them (PR #2227, issue #2221)

Each run of the indexer is allowed a fixed number of outbound requests before
the platform stops it. Until now, the indexer did not count them. The figure
lived in a note written by hand, and that note was corrected three times in
three consecutive reviews — and was wrong each time. Every correction came from
a person re-reading the sum, because nothing in the running system knew the
number.

Being wrong about it has a specific cost. Going over the allowance does not make
a run slower; it stops the run before it records how far it got. The next run
starts from the same place and does the same thing, so a chain can stop moving
forward entirely while appearing to run normally.

The indexer now keeps a live count of what a whole scheduled run spends. The
allowance belongs to the run, not to any one job inside it, and a run does
several things at once — reading the chain, catching up records, retrying an
earlier listing that failed to publish, tidying old rows. Counting each job
separately would have produced several comfortable-looking numbers for a run
that had already been stopped. There is now one count, and every job draws on
it: reads from the chain, reads and writes to the indexer's own database, the
credentials it fetches at the start, and the listings it sends to the
marketplace.

Two details are worth stating because they are what made hand-counting
unreliable in the first place. Several database statements sent together travel
as a single request, not one each. And a statement that is prepared but never
sent on its own costs nothing. A count that got either of those wrong would be
a confident number that was still incorrect, which is what was there before.

Those statements are also why there are now **two** counts rather than one.
The platform sets two separate allowances — how many requests a run may send,
and how many database statements it may submit — and they are the same size on
the tier this is built for. A batch sent together is one request but many
statements, so one number would have had to be wrong about one of the two: it
would have reported a comfortable figure for a run about to be stopped for its
statement count. Both are counted and both are reported, and a run that passes
either one says so.

A third detail was found by review of the first attempt, and it is the reason
this note no longer claims more than it should. The counting originally wrapped
the two objects the run was known to use, and was described as if it counted
everything the run sent. It did not: a failed read is retried automatically up
to three more times, and those attempts were invisible; a second reader built
elsewhere in the run was invisible; and the message sent to the marketplace was
invisible. The counting now happens where requests actually leave — so a retry
costs what a retry costs, and code that knows nothing about the allowance is
counted anyway.

Two things follow from that, and both are deliberate. Every run reports what it
spent, including runs that end early or fail — the ordinary figure is the one
worth having, and it was previously reported only on the busiest path. And when
a run does pass its allowance, it says so at the moment it happens rather than
at the end, because by the end the run may no longer be alive to say anything.

Review found two further places the count fell short, and both are now closed.
A run is counted to its own end rather than to the end of its main job — the
step that tells connected apps what changed reads records too, and a figure
published before it ran was short by that much.

The second is a deliberate change in behaviour and is worth stating plainly.
A request answered with "this has moved elsewhere" used to be followed
automatically, and each move is a further request that the count did not see.
Following them and counting each one was tried first, and it meant
reproducing the web's own forwarding rules — which method survives which kind
of move, which requests keep their body, what happens to credentials when the
new address is on another host. Review found three separate places where that
second copy of the rules did not match the original, which is what a second
copy of anybody's rules does.

So these runs no longer follow. A moved address is reported, naming where the
request was being sent, and the request fails there. What these runs talk to
is a configured address for each network, a marketplace and the platform's own
services — none of which should be moving — and if one does, the fix is to
correct the configured address rather than to have the indexer quietly follow
a provider somewhere new. The count stays exactly right either way, which is
the property the rest of this work exists to establish.

What is still not counted is stated in the code rather than left to be
discovered: requests served to visitors of the public read endpoints are a
separate allowance and a separate count.

This is the groundwork for the allowance being enforced rather than only
observed. The figures the indexer works to are still the conservative ones set
while the true cost was unknown; now that it can be measured, they can be set
from evidence.
<!-- assembled-fragment: 2221-indexer-subrequest-counter.md sha256=e169fb7633944626c5ad02738b9f44d0ccb163b0fa258c57fbdc503668e3052e -->

## Payment reminders again go out nearest-deadline-first after a busy run (PR #2229, issue #2219)

The service that reminds people about an upcoming interest payment works
through a list of loans ordered by how soon the payment is due, nearest first,
and stops when it has used its allowance for that run. It then records where it
stopped, so the next run picks up rather than starting over.

What it recorded was a **position in the list** — "I stopped at the sixth". The
list is rebuilt from scratch each run, and a loan reminded on the previous run
is no longer in it. So the sixth place in the new list is not the sixth loan
from before: it is the eleventh. The five loans in between — the nearest
remaining deadlines, the very ones that should have been next — were stepped
over.

Under sustained load this ran the service's own rule backwards: reminders about
payments further away went out while nearer ones waited.

Whether any reminder was actually missed is **not known, and is not claimed
here**. The reasoning that made this look harmless was that the position wraps
to the front when it runs off the end, so a stepped-over loan is reached on a
later pass — but that argument holds only if the list is worked through. If
loans enter the list about as fast as they are handled, its end keeps moving,
the wrap may not come, and a loan stepped over near the front can pass its
deadline and leave the window before anything reaches it. That is the same
sustained load the fault needs to appear in the first place. Establishing
which of those actually happened would take production evidence nobody has
gathered, so this is recorded as an ordering fault of unknown consequence
rather than as one known to be harmless.

It now records **the deadline** it stopped at, and resumes at the first loan due
at or after that moment. A deadline does not move when other loans are reminded,
settled, or pass out of the window, so the resumption is exact rather than
approximate — and the note in the code claiming an exact resumption was
impossible here has been corrected, because it was wrong about why.

Two consequences worth stating. Where the recorded place cannot be read at all —
a database problem, or a deployment that arrives before the schema change it
needs — the run starts at the nearest deadline instead. For any one run that
repeats work already done rather than stepping over anything, which is the only
acceptable direction for that failure. It is not harmless if it persists: a
service that always restarts at the same place never works its way down the
list, so loans further along stop being reached. That is why the run says so
every time rather than falling back quietly.

And the old recorded positions are cleared rather than left behind: a stale
number in a table other things still read is how a later reader comes to trust
a position that means nothing. That clearing is best-effort rather than
guaranteed, which is worth stating plainly — the schema change is applied
before the new service is deployed, so a last run of the old one can write its
position back in between. A row written back that way is inert, because
nothing reads it any more, and an operator can remove it once the new service
is live.
<!-- assembled-fragment: 2219-prenotify-deadline-cursor.md sha256=9282e48e9103a808ffb997efe5f02cb6543ae901524fd2795f7e1f0efbd5822c -->

## Thread — A held record now says what its loan number points at, instead of silently withholding (PR #2231, issue #2222)

When the platform cannot confirm what happened to a loan, it remembers that and
holds that loan's reminders back rather than sending ones it cannot stand
behind. The memory is released when the loan is settled, or found to have
ended.

One case releases neither: a loan the network denies exists, which may have no
stored record either. That is deliberate — nothing proves such a position
ended, and keeping it held and visible in the report a person reads is the most
useful thing this memory does. But the documented way for an operator to
resolve one is to delete the fabricated record, and once they do, the held
entry matches nothing and stays.

That is worse than untidy, and the reason is the part worth stating. A held
entry withholds reminders from **whatever loan currently bears that number** —
so if the number ever comes round again, after a network redeployment or a
reset, a real loan goes without reminders and nothing says so.

The obvious remedy is for the platform to notice that the loan bearing the
number now is a different one and release the entry by itself. That was built,
and then removed, because every way of establishing "this is a different loan"
from what the platform has stored turned out to be unsound:

- the recorded start time can be the platform's own clock, substituted when the
  network could not be read at the moment the loan was recorded;
- a recorded place in the network's sequence goes stale as soon as an entry is
  rewritten by a path that cannot rewrite it too;
- that sequence restarts on a test-network reset, so a newer loan can appear
  older;
- and the sequence value itself can be left behind by a reorganisation the
  platform is documented as never revisiting.

Each of those was found by review after the previous one was fixed. Acting on
any of them would have released a hold — and resumed reminders — on the
strength of a read that failed, which is precisely what the memory exists to
prevent.

So the platform does not guess. The report a person reads now names, for every
long-held entry IT DESCRIBES, what its number points at today: no stored loan at all, or a
stored loan in a given state that began at a given point. That description is
explicitly labelled as **stored and unverified** — the same record that proved
unsound to act on is not then presented as settled fact — and held numbers are
listed even when there are more than the report describes in full, up to a
stated limit, because an entry left out entirely would be withholding reminders
with nothing anywhere naming it. Those listed-but-undescribed numbers get no
such lookup, and the report says so in terms: being named is not being
examined, and nothing above one of them says what it points at now.

Someone reading it can see whether the entry is still about the loan it was
made for, and clear it if not. That is a deliberate act, spelled out in the
report, and it names the exact entry that was read: a check that ran between
the reading and the clearing can have recorded a fresh finding under the same
number, and an unguarded removal would discard it.

Where more entries are held than the report describes in full, it also says
what it is not doing: those numbers are named but not described, the
descriptions are of the longest-held entries and do not take turns, and
resolving one of those is what brings the next into view. It would be easy to
write "described next time" there, and it would be untrue — nothing would ever
supply that detail.

Each described entry carries its removal command already written out, to be
run exactly as printed. That is deliberate and it replaced three earlier
attempts to print the *pieces* and let a person assemble them — each of which
turned out not to run, in a different way each time. The command is checked by
being executed: the tests take the text the report emits and run it.

The value it quotes is two values, not one: a token and the time of the
sighting, and they cover different things rather than doubling up. An ordinary
write rotates the token; a write made while the store is still on the older
shape cannot, and those are caught by the time moving instead. A time recorded to the second cannot
tell two sightings within the same second apart, and a token cannot be
refreshed by the older write shape, so either on its own would let a removal
delete a finding recorded *after* the person read the report — resuming
reminders for a loan nothing has settled, which is exactly the harm this
memory exists to prevent. One narrow gap remains and is written down further
below. The window is narrow, and that is no defence: the whole value of a
safety check is that it can be trusted without being checked, so one that can
fail silently is worse than none. Naming an entry while withholding what it takes to act on it
sounds harmless and is not: because the described page does not take turns,
the entry would stay unactionable indefinitely, and a person who needed it
gone would be pushed toward exactly the unguarded removal this report spends a
paragraph warning against.

One release does still happen on its own — when a stored loan bearing the
number is no longer running — and that carries the same identity assumption in
smaller form: where a number has been reused, it establishes that the
replacement ended rather than that the original position did. It is recorded as
a known limit rather than presented as settled, **and it is the release itself
that says so**, giving a count where the store reports one — and saying so
plainly where it does not — alongside a bounded roster of the CANDIDATES it
read immediately before removing. Not of what it removed: the removal re-checks
its condition, so fewer can go than were listed, and where that happens it says
how many and that it does not know which, or why.
Leaving that to the held-entry report would have disclosed nothing in the one
case that matters: a release can clear the last held entry, and the report says
nothing when nothing is held.

That roster took two goes as well, and the first was worse than it looked. It
named at most a set number of entries — but only after asking the database for
every single one and holding them all in memory, so the *appearance* of a limit
sat on top of work that still grew without one. A limit that only shortens the
message is not a limit; it hides the cost rather than removing it. The entries
are now read back under a limit the database itself applies; the count is
exact where the store reports one, and where it does not the report says so
rather than supplying a number. The roster is described for what it is: what the sweep was
about to release, read immediately beforehand, rather than a claim about the
removal itself.

There is a second way a held entry clears by itself, and it is the sound one:
a run examines the number, the network answers, and the entry goes. That is
deliberately left alone — the network's own answer about a number is the only
solid evidence in any of this, and every basis the platform declines to act on
is a stored value standing in for exactly that answer. Blocking it would leave
a live, settled loan without reminders indefinitely on the strength of a
finding about a loan that no longer exists. But where the entry had been held
long enough to be appearing in the report a person reads, its release is now
announced, together with what that release cannot establish: if the number had
come round, the answer concerns the loan bearing it now, and the earlier
unresolved finding has gone with it. An entry cleared before it was ever
reported stays unannounced — that is the everyday case of a reading that failed
once and succeeded next time, and a line for each would bury the ones that
need a person.

Reporting takes the same small number of database enquiries however many
entries are held, and the first attempt at that left the amount READ and
PRINTED still growing with the number of entries — so the report would have
failed on exactly the network that most needed it, inside the run that must
also record how far the chain has been read. It now names at most a set number
of entries, says **exactly** how many more are held, and hands over the
enquiry that lists them. A listing that simply stopped would be the silent
truncation this whole change exists to avoid.

What matters there is that the work does not vary with the size of the fault
more than it must — not that it is as small as it could be. A shorter version
was written and set aside: it would have saved one database enquiry by using a query feature the
database's own documentation neither promises nor rules out, and which nothing
else in this codebase has ever asked it for. This is the one report that makes
a withheld position visible at all, so a query the database declined would not
degrade it — it would hide every withheld position on every run, which is the
fault the whole change exists to prevent. One saved enquiry is not worth that.

A held entry can be cleared from more than one place — a periodic sweep, a run
that settles the loan, and the close-out that ends it — and announcing each was
done one at a time, as each was noticed. That is how the third one stayed
silent: in the very case worth disclosing, a reused number's replacement
closing normally, the entry vanished without a word while the other two paths
announced themselves. The missing piece was never a case, it was a rule. There
is now a single shared way for the platform to release ONE entry by itself — a
removal a PERSON runs is a different thing and outside this rule, written out
for them one per entry and guarded as described above — and it reports
what it removed, and a new route cannot be added without deciding what it
announces.

The periodic sweep is the exception, and saying so matters more than a tidy
rule would. It removes a batch in one instruction, so it cannot use a
per-entry form — a check demanding one would force it back into removing rows
one at a time, which is what several rounds of this change were spent getting
away from. It carries its own announcement instead, and it is the only such
place.

That is a strong default, not a guarantee, and the difference is worth stating
because the first version of this paragraph claimed the stronger thing. A route
that took the shared form and threw away what it returned would still be
silent, and nothing can prevent that: these releases have to be committed
together with unrelated work, so they cannot control their own execution. What
changed is that staying silent is now a deliberate act rather than an
oversight, and a check refuses any release the platform itself performs with a
hand-written statement — the commands it writes out for a person are a
different thing, covered above. A guarantee a
reader trusts without checking is worse than one they check.

What a release says also depends on what licensed it, and there turned out to
be four different licences rather than two. A run that read the network for a
number and got an answer holds the soundest evidence in any of this, and says
so. A repair is a network read too, but of a loan whose ending was never
announced — so it says the ending was FOUND, rather than claiming one arrived,
which on the one path defined by a missing announcement would have described
the opposite of what happened. It only says that where its own write is the
one that recorded the ending; where another writer got there first it says
less, because that writer may have been the announcement arriving, and
claiming none came would deny the likeliest explanation. A close-out did see the ending announced, and
establishes that the loan CURRENTLY bearing the number ended, never that the
entry being released was about that loan. Each names its own basis and none
borrows another's. Sharing a mechanism does not license sharing a claim, and
one announcement wired to every route briefly said the strongest of the three
on all of them.

Two things about the upgrade itself. A deployment publishes the new code
before the store is updated to match, so for a while — minutes in an ordinary
rollout — the code runs against the older shape — and a run that cannot record a withheld loan lets
the next run remind on it, which is the failure this memory exists to prevent,
arriving during its own upgrade. Recording is therefore written to succeed
against both shapes, and the platform asks the store which shape it has rather
than assuming. While the older shape is in use the report still names
withheld loans on the same terms as ever — up to its stated limit, with an
exact count of any beyond it, because a deployment is exactly when a
suppression most needs to be visible — but offers no removal command at all,
and says why: every such command names something the older shape does not
have, so printing one would hand a person an instruction that cannot run. The
enquiry that would hand back instructions for entries past the limit is
withheld there too, for the same reason.

It also does not promise how long that lasts. Asking the store establishes
only that the newer shape is ABSENT, never when it will arrive, and an update
that failed or was skipped leaves this indefinitely — so the report says what
to do with a second sighting: if the same message turns up on a later run, the
update did not land and wants looking at, because these entries cannot be
cleared safely until it does.

The safety value also had to become two values rather than one. The older
write shape cannot refresh the token, so a token on its own would go on
matching after a fresh sighting; the time of the sighting moves instead. One
narrow gap is left and is written down rather than implied — an older-shape
sighting in the same second as the one a person is holding moves neither
half — because closing it would mean pushing the recorded time forward on a
collision, which corrupts the one thing telling a person how long ago a record
was really made. And an entry written before the new safety value existed
carries an empty one; the report prints that in a form that can be pasted as
it stands, because an entry nothing ever re-examines — exactly the kind this
report is for — would otherwise be named and permanently unremovable by the
safe route.

The sweep that releases entries clears a limited number on each run and leaves
the rest for later ones, and that limit is not a matter of taste: the store
refuses a single instruction carrying more than a fixed count of supplied
values, and one that exceeds it fails the same way every run — releasing
nothing while appearing to work. The removal also re-checks, as it removes,
the fact that licensed it, because between finding an entry and removing it
the loan under that number can have been replaced by a live one. That is
exactly the reuse this whole change is about.

The count of how many entries are held and the list of them are also now read
in the same instant. Taken separately, a removal happening in between left the
report claiming entries that no longer existed — an "exact" figure that
described no moment that ever was.

Finally, the report's promises and its behaviour are now the same size. Three
separate rounds each bounded a different cost of the same report — the length
of the message, the volume handed back to the platform, and the work the
database does to produce it — and each was found only because the previous one
was fixed. The common cause was not the implementation but the claim: the
specification promised fixed work outright, so every review went looking for
the next place that was not fixed. It now says precisely what is bounded and
names the one thing that is not — establishing HOW MANY entries are held grows
with how many there are, and that is kept deliberately, because telling someone
"more than 200" when the true figure is three thousand hides the only number
that tells them how bad it is. A supporting index makes the page a bounded walk
rather than a sort of everything held.

A suppression a person can see and undo is worth more than an automatic release
built on evidence that has been wrong four different ways.
<!-- assembled-fragment: 2222-quarantine-id-reuse-release.md sha256=b46f0c77b690c49c757cf5585bb331b336dbf6d1e9e2f19e32df597f61a611de -->

## Thread — A lookup no longer fails because there is a lot waiting for it (PR #2235, issue #2234)

The platform's back-office services ask their own store about many records at
once: who each inbox notification is for, who owns a sold offer row, which
delivered cross-chain remittances have already been acknowledged. Each of those
questions names every record in the batch being worked on, and the store
refuses a question that names more than a hundred things at a time.

Refusal is not a slow answer — it is no answer, and the work the question
belonged to fails whole. Worse, it fails the same way on the next attempt,
because what made the question too large is a backlog, and a backlog does not
shrink while the thing that would drain it is failing. That is the shape worth
naming: not a flaky moment, a stall, and one that arrives precisely when the
platform has fallen behind and most needs to catch up.

Three of these lookups already split their question up. Two did not. The one
that mattered most is the pass that acknowledges cross-chain reward
remittances: it examines a window two hundred wide, so a hundred or more
unacknowledged deliveries in that window made every attempt fail — and because
that pass records its new position **before** asking, each failing attempt also
moved past a window whose acknowledgements were never sent. Value had been
delivered and the bookkeeping that closes it would never have followed. The
likeliest moment to meet that is the first time the pass is switched on, since
nothing has been acknowledging while it was off.

That pass has not run in production — this service's schedule is currently
empty and the feature is not enabled — so this is a defect on the arming path
rather than an incident. It was found by reading the arming prerequisites, not
by anything reporting it.

**The fix is one shared rule rather than five careful authors.** The store's
limit and the splitting now live in one place used by every service. Callers
hand over the rest of their question's contents and get back complete,
correctly sized pieces, so there is no count for anyone to keep in step with a
condition added later — which is how the three that knew about the limit came
to be three rather than five. Splitting costs nothing extra: the pieces travel
together as one request, so a lookup that used to be one request still is.

One place deliberately does **not** use the shared splitter, and the reason is
recorded where it lives: the sweep that releases long-held records limits how
many it examines per pass so that what comes back always fits a single
instruction. That is a bound on how much work one pass does, and splitting
would remove it rather than respect it. An exception with a stated reason is
worth more than a rule that reads absolute and quietly is not.

A fourth service, the internal mesh watcher, asks similar questions. The first
version of this change exempted it on the grounds that its lists are sized by
how the deployment is configured. **That was wrong, and review caught it**: the
set of chains it watches is read from the canonical chain itself, where nothing
limits how many may be registered, and one chain can raise more than one
finding. So the exemption was the same unexamined assumption of smallness that
this change set out to remove — written in the same breath as removing it.

Two of its questions could not simply be split, and the reason is worth
recording. They were phrased as "delete everything EXCEPT these", and that
phrasing cannot be broken into pieces: the first piece deletes what the second
was going to keep. They now ask the opposite question — read what is stored,
work out what is not being kept, and delete that in bounded pieces — which
splits safely and means the same thing. The read happens inside the same
guarded boundary as the writes, so a failure of it is reported rather than
escaping.

That service also had no test of what those two operations actually delete —
only of how they behave when the database is unavailable. So the rewrite could
have changed the retention behaviour with every existing test still passing.
Tests for the behaviour itself were written first, and then deliberately broken
to confirm they would object.

The watcher stays outside the shared package for trust reasons — its own
database, its own alerting channel — but it now uses the same splitting rule,
reached the same way it already reads shared deployment data. One definition
beats a copy that drifts.

Closes #2234.
<!-- assembled-fragment: 2234-d1-bind-cap-shared.md sha256=2c280741ff86793a71acf0fba1d03a568a4aa81fa208cf120d317b2521bbf498 -->

## Thread — The notification service does deploy itself on merge, and two places said it did not (PR #2238, issue #2237)

Operational documentation and a comment in the service's own source both stated
that the notification service is **not** deployed automatically when a change
merges, and that an operator therefore has to deploy it by hand in the same
sitting. Both are now corrected: it is deployed automatically, along with the
two services already described that way.

The claim was true when it was written, and it stated its own test — *does a
build check appear on a recent merge?* — which is what makes it checkable now.
It does: the build runs on the merge commits that touch this service, and the
live deployment was created seconds before that build check finished — the
deployment happens during the build, which is what produces it. The test is
kept and the answer refreshed, rather than the test being removed.

**Believing the old wording was worse than the problem it warned about.** It
told a reader that a merged change to that service is not live when it is, and
nobody goes looking for the effects of a change they think never shipped. The
source comment carried the same claim into the file it most affects — the
sweep that clears expired account-linking codes, which had been moved to this
service precisely so it would keep running when another service stopped.

Two things the correction does **not** sweep away:

- **The nightly backup worker still is not deployed automatically**, and the
  step still says so, with the same evidence checked the same way.
- **The configuration hazard the old comment described is real and matters
  more now, not less.** Two operator-tuned settings live only in the
  deployment dashboard, and a deploy that does not know about them removes
  them. An automatic deploy passes no flags at all, so the protection cannot
  be something a person remembers to type — it is declared in the service's
  own configuration file, which every deploy route reads. The comment now says
  that, instead of naming a command an automatic deploy never runs.

The step in the runbook also warned that, during the gap before a hand-run
deploy, this service would read and write the *old* database while its
neighbours used the new one — so a setting changed or a support request filed
in that window would land in a database about to be deleted.

**A first version of this change said that gap no longer opens; a second said
it is now a short, measured one. Both were wrong, and review caught each in
turn.** What is true is smaller and more useful: each service reaches a new
database binding through its own independent build, so from the merge until
every binding has been *checked*, the set is in a mixed state — with no
guarantee about which services have switched, in what order, or for how long,
and no guarantee that a given one switched at all, because a build can fail
and leave that service on the old binding until a person repairs it.

The second version's "short window" came from comparing two build-completion
timestamps. That comparison does not measure what it was used for: a
deployment is created *during* its build, not at the end, and the other
service's activation time was never collected. The document now says the
duration is not derivable rather than printing a number that was not measured
where it matters.

So the guidance is one requirement covering both directions, rather than a
caveat per path: **before any binding change is merged — the cutover or its
undo — no service may still be able to write to either database, and normal
operation resumes only once every service's binding has been confirmed on the
database it is meant to be on.**

That is stated as a CONDITION rather than as an action, and the difference is
the whole of what this change learned. "Close the routes through which users
write" was the action an earlier version prescribed, and it does not achieve
the condition: it leaves timed work, background alarms and already-running
work untouched. Someone following it would believe the change was protected
and lose rows anyway.

The framing also corrects two narrower errors: it named only one of the two
services that accept user writes, and it pointed an undo at the same checks as
the rollout, which would have passed a service still stuck on the database
being abandoned.

What the automatic deployment genuinely changes is *who* closes the window — it
no longer waits on somebody remembering a command. It does not make the window
zero, bounded, or safe to leave unguarded.

Trying to state that protection precisely enough to be tested against is where
this change stopped. Each review round found another way a service reaches the
database that the previous wording had not covered — a second service's public
routes, then diagnostic routes, then work scheduled on a timer, then a
self-rearming background alarm, then work already in flight when the closure
went up, then addresses that bypass it, then the fifteen minutes a schedule
change takes to take effect.

**Listing the ways code can reach a database is not a finishable task**, and a
list that reads authoritative while being incomplete is worse than none: an
operator follows it, believes the writers are stopped, and loses exactly the
records the step exists to protect. So the document now states the hazard and
says plainly that the procedure is unspecified, with the requirements and the
decisions it needs recorded separately. One of those decisions is whether the
closure should work by removing the database from the service entirely rather
than by naming its entry points — the only formulation that does not depend on
having listed them all correctly.

What did get settled: the checks that prove a binding moved cannot all run
while writes are closed, since two of them work by writing. Confirmation is in
two passes — read each service's binding directly, which is what authorises
restoring traffic, then run the write checks afterwards.

None of these mechanics has been exercised on the live account; they are
reasoned from how the deployments work, and the document says so.

One service writes nothing at all today because its schedule is empty. That is
recorded as a fact about today rather than a property of the service: restore
the schedule and it writes user-visible alerts that a later re-check cannot
reconstruct, because the condition they describe may have passed.

Closes #2237.
<!-- assembled-fragment: 2237-agent-auto-deploy-correction.md sha256=dafc0b7ee4ad0be5742e5f146d9a24dbb8f61df394c488cde52de7ea50531c96 -->

## Thread — How to tell whether a service is actually running the code that was merged (PR #2243, issue #2242)

A cutover step told an operator which services deploy themselves when a change
merges, and which need deploying by hand. It was corrected earlier the same day
because it named one service as manual when it is automatic. Measuring every
service afterwards showed the corrected list was **also** wrong, in the other
direction: another service deploys itself and was left out.

Two errors in one list on one day is a sign the list is the wrong thing to
maintain, so the step now leads with the test rather than the answer — and the
test it used to name turns out not to work.

**Looking for a build to have run misleads in both directions.** A change to a
single file at the top of the repository starts a build for every one of the
five services that build automatically; a change confined to the documentation
folder starts none at all.

And **building is not deploying** — which is the distinction that matters most
here, and the easiest to lose. One of those five builds automatically and is
still deployed **by hand**: its build reported success four days after its last
deployment, and that deployment is still the one serving. Only the nightly
backup worker has no automatic build at all. So "a build ran" can
be true of a service the change never touched, and "no build ran" can be true
of one that does deploy itself. The same kind of change behaves differently
again on a branch than on the main line, which removes the last way a reader
might have salvaged the signal. Worse, a **successful build does not mean
anything was deployed**: one service's build reported success four days after
its last deployment, and that deployment is still the one serving.

**The deployment timestamp is the thing worth reading — in one direction
only.** If a service's last deployment is older than the newest change
affecting it, that change is almost certainly not live. Almost, because a
change can carry a timestamp later than the moment it actually landed — but
that is the safe direction to be wrong in: it costs a redundant deployment or
a second look, where the opposite mistake costs the thing the step exists to
prevent. The reverse does not hold: a recent-looking deployment proves
nothing, because the comparison can be made against a stale local copy of the
project's history, because a service can be affected by changes outside its own
folder, and because undoing a deployment creates a *new, recent* record that
points at *old* code.

An intermediate version of this change also used staleness to infer that a
service must be hand-deployed. That is wrong in a way worth naming: a service
whose automatic deployment **failed** is also behind, and reading that as "this
one is manual" sends someone to deploy around a broken build instead of fixing
it. Being behind says the code is not live and says nothing about why.

Running that comparison found two services behind: the connected app by four
days, and the nightly backup worker by twenty-eight. Both are hand-deployed by
design, and both had simply not been deployed. Their figures are now recorded
in the step, as the reason to check rather than assume — "somebody will have
deployed it" is not a safe default for either.

One service appears in no deployment list at all, and that is correct: it is
deployed as part of an arming ceremony that has not happened. The step says so,
so it is not mistaken for drift.

Part of #2242.
<!-- assembled-fragment: 2242-deploy-currency-check.md sha256=9e6be06c94440e55c26b38d02334d51d2c73ef63444ee96f78ac31c8c6bbf8bb -->
