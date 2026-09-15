## Thread — A reminder could still be sent about a loan nobody had confirmed (issue #2212)

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
the chain as well as the messages it sends. What it does NOT count is records:
a record that issues nothing cannot consume the limit, whatever the reason it
sent nothing — rejected, switched off, or nobody subscribed. Stating the limit
in requests rather than in messages is what lets an operator explain a run
that exhausted its allowance while delivering little. A run also walks past
records it cannot send for, in batches of a hundred, and reaches the ones
behind them on the same run.

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
