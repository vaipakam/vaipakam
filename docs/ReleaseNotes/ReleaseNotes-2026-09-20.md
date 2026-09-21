# Release Notes — 2026-09-20

Five entries, in the order the file assembles them: how a deployment is now
checked against the record it wrote, how a deployment configuration is
recognised, why a transaction that was mined is not a transaction that
worked, the messaging rail that can send again, and how a service is held
away from its data while that data is moved.

A theme runs through four of the five, and it is worth naming because it was
arrived at separately each time rather than applied as a policy. In every
case the first attempt tried to establish something by *listing* — every way a
deployment might record a component, every name a configuration file might
have, every place in the code that writes to a database — and in every case
the list turned out to have no last entry. Review kept finding one more, each
fix revealing the next. What shipped instead, in each case, removes the need
for the list: compare the deployment against its own output rather than read
its source; identify a configuration by a field only that kind of file
carries; take the database access away rather than enumerate its users. The
same correction appears once more *inside* one of those changes, where an
attempt to close every socket from the outside was itself abandoned for
requiring a hand-kept list of chains.

The fifth, the messaging rail, is the plainest of the five and the most
immediately felt: notifications had been failing to send, the cause was a
dependency pinned to a version whose interface had moved, and the fix was to
unpin it.

Two of these changes also record something they deliberately do **not**
claim. The database mechanism names two residual exposures rather than
implying they were eliminated — one of them unmeasured, and said to be
unmeasured. A misdiagnosis that survived five revisions is written up in the
first entry, along with the detail that the compiler had been printing the
real cause on the last line of its output the whole time.

## Thread — a deploy is now checked against the record it wrote, not against its own source code (PR #2253)

Every deployment writes a file naming the address of each component it installed. Other tooling reads that file afterwards — follow-on configuration scripts, the app bundle, the inventory that tracks which deployments exist — so a component the deploy installs but never records is invisible to everything except the chain itself. An earlier audit found thirteen components in exactly that state. The omissions were fixed; the guard meant to stop them recurring was not, and this change is that guard.

The first attempt read the deployment scripts as text and tried to prove that every component installed was also recorded. Over four rounds of review it collected sixteen distinct ways to slip a registration past it — a comment character inside a piece of quoted text, a registration in a function nothing calls, one hidden behind a condition that is only true on certain networks, a variable reassigned between being installed and being recorded, and so on. Each was real, each fix revealed the next, and two of them could never have been settled by reading source at all. A check that reports success it has not earned is worse than no check, because a green result stops anyone looking. It was withdrawn.

What replaces it asks nothing about how the deployment is written. It runs the real deployment, lets it produce its real record, and compares the two: every component the deployed system reports is required to appear in the file the deployment just wrote. Spelling, structure, control flow and naming become irrelevant, because neither side of the comparison is source code.

One component needs its own separate check, and the reason is worth stating because the obvious version of this comparison misses it. The upgrade component is installed by the system's constructor in a way that leaves it out of the list the system enumerates, so a comparison built only on that enumeration would keep its green result even with that component's record deleted — and it is the one component that can never be reinstalled afterwards, because removing it removes the ability to install anything. It is now resolved and required separately, and the test also asserts that it is genuinely absent from the enumeration, so that if that ever changes the duplication is reported rather than left quietly in place.

Running a real deployment during testing means a real record gets written, and writing it to the usual place would overwrite the committed one on every test run. The deployment now accepts a redirection for where its record goes, held on the deployment run itself rather than in the environment the whole test process shares — a distinction this repository has been caught by twice before, where one test's setting silently changed what a test running beside it did. The redirection is refused outright anywhere a real deployment could occur, and refused loudly rather than quietly ignored: a caller that believed it had redirected and had not would check the committed record instead and pass for entirely the wrong reason.

A failed check now puts the previous record back before it stops. This matters more than it sounds: writing to files survives a deployment being abandoned, and a live deployment runs its whole body as a rehearsal before sending anything, so without the restore a caught omission would leave the file that other tooling trusts describing addresses from a rehearsal that never happened — the check would have manufactured a worse failure than the silence it exists to end. The restore now covers every way the check can stop, including ways added to it later, rather than only the one failure its author thought of.

The summary a deployment prints at the end is now read back from the record it wrote, instead of being a second hand-maintained list naming the same addresses. That is the more honest report — an operator sees what was recorded rather than what was in scope — and it closes the gap that let the original thirteen omissions go unnoticed by anyone reading a deployment log, because the two lists could disagree and only one of them was what other tooling would later read. A missing record is now a missing line.

One diagnosis in this work was wrong for five revisions and is worth recording, because the compiler had been saying so the whole time. A build error reported that a particular function held too many values at once, and five attempts were made to move work out of it — none of which helped, because the real cause was a single unannotated block of low-level code elsewhere in the same component. That kind of block silently switches off the compiler optimisation that lets any function in the component hold more than a handful of values, so the error names the function that ran out of room rather than the block that took the room away. The compiler prints the actual reason on the last line of its own output; nobody read it. Adding the missing annotation — two words, nothing else changed — makes the build pass, and that has now been verified by changing only those two words. The note is written into the contributor guide so the next person reads the last line first.

Two smaller things came with it. The five places that each built the path to a deployment record by hand now go through one, so they cannot disagree. And a deployment that sets no redirection resolves the committed location, which is asserted too — widening a path every real deployment takes means pinning the ordinary case, not only the new one.

Still open and unchanged: comparing the labels used by the deployment and by the in-place refresh, which the issue lists alongside this work.
<!-- assembled-fragment: 1800-deploy-artifact-completeness.md sha256=3746afd991179b201fe23b2f2cd3697fa00a12a2ace3d05f9944bdba1babbc2c -->

## Thread — a wrangler config is recognised by what it contains, not only by what it is called (PR #2245)

The guard that stops a Worker deploy from wiping dashboard-managed variables
used to find configuration files one way: by wrangler's filename convention.
Anything checked in under another name was invisible to it, even though the
deploy command accepts any path — so a deployable config committed as, say,
`configs/agent-staging.jsonc` could omit the preservation flag and nothing
would say so. The retired command scanner had covered that case, and its
removal was recorded at the time as a real reduction awaiting an owner
decision rather than a gap we had always had. That decision has now been made
and the coverage is restored.

A file is now recognised as a Worker configuration if EITHER its name follows
the convention OR it carries a top-level `compatibility_date` — the field
wrangler requires of a Worker and which no package manifest, TypeScript
configuration, lockfile or contract ABI in this repository contains.
Everything either test finds goes through the same single requirement, and the
remedy is unchanged: declare the preservation flag. A file found by its
contents is not asked to be renamed, because the declaration is what makes it
safe and the naming convention is only tidiness. Neither test needs to reason
about how a deploy is spelled or how command-line options merge with file
contents, which is the unbounded reasoning the earlier scanner was retired for.

The choice of field is the whole reason this is safe to do. An earlier attempt
at reading file contents keyed on the project name and turned a correct tree
red, because every manifest has a name; name-plus-entry-point would fail the
same way for the same reason. Two limits are stated plainly rather than
implied. A configuration written in TOML is still recognised only by its name:
identifying it by content would need either a grammar this check deliberately
does not carry, or a crude text search that would flag a file merely mentioning
the field in a comment — trading one narrow gain for a new class of false
alarms. And a file that has neither the conventional name nor the field, with
the date supplied on the command line instead, remains out of reach. The one
genuinely open gap is unchanged and still needs an owner decision: a
configuration that is generated or rewritten at deploy time, which no check
over committed files can see.

The operator-visible trade is unchanged — a deploy cannot remove a variable, so
deleting one stays a deliberate dashboard action. The summary line the check
prints now reports how many files were identified by content rather than by
name, and continues to count exempt Pages projects separately, so the number an
operator reads is a claim about files the check actually asserted.
<!-- assembled-fragment: 2171-keep-vars-content-identification.md sha256=ea92d90c2ce8fbef49f2ddec2b93929ff0b223e9758435a072b1975f9a341a93 -->

## Thread — a mined transaction is not a successful one, and the test suite had been treating it as one (PR #2256)

A scenario test had been failing intermittently for weeks in a way nobody
could reproduce on demand: the same commit would fail one day and pass the
next, with no change to the tree in between. The failure always arrived as a
piece of the page being absent sixty seconds after the page loaded, which reads
like a rendering problem and is the reason several investigations looked at the
wrong half of the system.

It was not a rendering problem. The test sets itself up by sending a real
transaction to the chain and then waiting for that transaction to be mined —
and **being mined is not the same as succeeding**. A transaction that fails
on-chain is still mined, still returns normally to whatever was waiting for it,
and reports its failure only in a field the suite was not reading. So when the
setup transaction failed — which depended on live chain state and therefore
varied day to day — the test carried on as though it had worked, and the page
it then inspected had nothing to show, because the thing it was inspecting had
never been created.

The suite had nineteen of these waits and exactly one of them read the result.
That one was written by hand, in a single test, by someone who had been bitten
by this before.

**Fixing only the failing test would have left eighteen of the same hole.** So
the wait is now a shared step that every test uses, and it fails loudly and
immediately when a transaction failed, naming which transaction it was. The
failure now appears at the setup step that caused it, rather than three steps
later in a message about the user interface — which is the difference between a
report that points at the cause and one that has sent people looking in the
wrong place repeatedly.

The affected test also gained a second, stronger check. Rather than inferring
that its setup worked from whether the page displays something, it now reads
the chain directly and confirms the position really is in the state the setup
was meant to put it in. A test whose only evidence of its own setup is the
screen it is testing cannot tell a broken product from a broken setup, and this
one could not.

Two live operational drivers had the same gap and are fixed alongside. One
could have let a wallet stay in a state the run had reported as cleared; the
other printed "restored" for a restore that had not happened, although a later
check would still have failed the run. That second one changed no outcome, only
what the operator reading the transcript was told — which is worth fixing on
its own, because a log that contradicts the failure beneath it costs more time
than no log at all.

Closes #2183.
<!-- assembled-fragment: 2183-confirm-receipt-status.md sha256=833db5956f98410b4381c9bef108738c7c6425bc5d44249c673a5af7db0ea2cc -->

## Thread — the Push rail can send again, because the pin was the bug (PR #2247)

Push notifications on this deployment had not been issuing anything. The
platform's Push client was pinned to a version that signs its verification
proof with a method belonging to an older signing library, while the workspace
supplies a newer one that names that method differently. The failure happened
before any request left the Worker, so every Push notification — health-factor
band alerts and periodic-interest pre-notices alike — failed having sent
nothing. Telegram was unaffected throughout.

The cause turned out to be narrower and more mundane than "a dependency
decision". The pin read `^0.0.1`, and for a version below `0.1.0` that caret
does not widen anything: it means exactly `0.0.1`. So the range could never
have reached the 1.x line, and a comment that once named the intended range had
been edited to agree with the install rather than the other way round. That
same pinned version declares that it needs the *older* signing library, against
a workspace that has shipped the newer one for some time — a requirement that
was unmet all along without anything failing loudly. Moving to the current
release fixes the mismatch at its source: that release declares support for
both signing libraries and adapts internally, which is the arrangement the
project actually needs.

Two details were load-bearing and would each have left the rail dark while
looking fixed. The first is the guard added when this outage was diagnosed: it
asked whether the signer exposed the one method the *old* client called, so
after the upgrade it would have gone on refusing the perfectly usable signer
the platform has, and reported that refusal in the same words it uses for an
unset key — an outage indistinguishable from "not configured". It now mirrors
what the client itself does, accepting either signing style. The second is a
log filter that exists to stop the client writing subscriber wallet addresses
into Worker logs; its own comment required re-checking the marker whenever the
pin moved, and the pin has now moved. The check was run: the current release
does not log on the sending path at all, so the filter is inert. It is kept
rather than deleted, because an inert filter costs a few lines while a
wrongly-removed one costs user privacy.

The functional specification gains the intent this outage violated: a delivery
rail is offered only while the platform can actually issue on it, a rail that
cannot send is an outage rather than a staged feature, and whether a rail can
send is decided by asking what the signer exposes rather than by interpreting a
failure message after the fact.

Verification is deliberately not a unit test. A mocked client cannot witness a
mismatch between real libraries — that is why the original break survived the
suite, and the same trap reappeared one layer up during this change, where an
incomplete test double produced a failure that looked like a provider
rejection. Closing this properly means sending one real notification to the
production channel and confirming it arrives.

Closes #2220. Follow-up, deliberately not folded in: the Push rail exists as
two near-identical copies, one per Worker, and they have already drifted — only
one of them carries the request-accounting introduced when this outage was
diagnosed, and only one carries the check described above at all. Hoisting it to
a single shared implementation is filed as #2248.
<!-- assembled-fragment: 2220-push-rail-sdk-pin.md sha256=19ea9d06557d478e45a7152b27e74acf9f5c2506cae4f7ad766d48259ec34295 -->

## Thread — a service that cannot reach its data now says so, and stopping every writer no longer means listing them (PR #2252)

Moving one of the platform's off-chain databases requires stopping everything
that writes to it first, and until now the operating procedure could not say
how. Four review rounds had tried to write that procedure as a list of writers
to close, and each round found another one the previous wording had missed — a
second service, scheduled work that reaches the database without going through
any route, background work that reschedules itself, work already in flight when
the gate closes, an alternative hostname that bypasses a network-level rule,
and a schedule change that takes up to a quarter of an hour to take effect. The
list was never going to finish, because listing the ways code can reach a
database is not a question with a last answer.

The mechanism adopted instead does not name a single writer. A maintenance
deployment is the same software with its database access removed outright, so
nothing inside it can reach any database — not a request, not a scheduled tick,
not self-rescheduling background work, not a hostname nobody remembered, and
not an entry point added next year. Three of the objections that had been
raised are answered by the choice of mechanism rather than by a clause each:
there is no network-level rule left to bypass, the schedule is untouched so its
propagation delay stops mattering, and an unlisted entry point is covered
precisely because nothing is listed.

What **three** of the four services gained is the ability to be held that way
**gracefully**. Without it, code that expected a database would simply crash,
which is loud but tells nobody whether their write landed. Now each of those
three refuses at its entrance: a caller gets a temporary-unavailable answer
that says plainly that nothing they sent was recorded and that nothing read
back would be current; background ticks decline to start and say so once,
rather than launching a dozen pieces of work that each discover the refusal
separately. Any path that somehow gets further meets a stand-in that refuses by
name — including through operations the database provider has not invented yet,
because the stand-in states a rule rather than listing today's methods.

**The fourth service is the nightly backup, and it is the exception.** It sits
outside the shared code and has no equivalent gate, so removing its database
access makes its scheduled run fail outright rather than decline politely. That
is expected during a window rather than a new fault, and an operator watching
the logs should know to expect a raw error from it.

**It does cost something, though, and an earlier draft said it did not.** No
live user row is affected — it only reads — but if the window covers its nightly
run, **that day's backup does not happen**. The recovery point for that day is
simply missing, and getting it back means re-running the backup once the
binding is restored. Worth planning around rather than discovering afterwards.

Two choices inside that are worth naming because they cost something. The
refusal is **blanket**: a handful of routes touch no database at all and are
refused along with the rest, for the short duration of a window. The
alternative is a hand-kept list of which routes read data, which is the same
unfinishable list one level down, so the cost is accepted and recorded rather
than traded for a new one. And the self-rescheduling ingest work declines
**without rescheduling itself**, because it cannot make progress without a
database and retrying every few seconds would only bill for rediscovering the
same refusal; the ordinary scheduled backstop restarts it afterwards.

The guarantee is also bounded honestly, and the bound is **open rather than
handled**. Work already running when the service is held off its data still
holds what it was given and can still write until it finishes. Removing the
access does not reach inside something already running.

There is no procedure yet for waiting that out — how long it takes has never
been measured, and inventing a number is the defect this whole exercise was
opened to remove. So the residual is recorded as a known gap rather than as a
step somebody else performs. What changed is the shape of the unknown: one
measurable quantity, instead of an open-ended set of entry points to get right.

**A second residual is named for the same reason, and naming it is what
replaced three rounds of chasing it.** Live connections that the app holds open
to watch for new activity are handed over intact when a maintenance build takes
over, and a connection that nobody has closed goes on answering the browser's
keepalives — so for a while the app can present a paused data feed as a live
one. Three consecutive review rounds each found a genuine hole in the attempt
to close those connections from the outside, and the third made the cause
visible: closing every one of them reliably meant keeping a hand-written list
of the chains they belong to, which is the same unfinishable list this change
exists to stop writing, reproduced inside it. The attempt was removed.

What makes that safe to remove is that the app does not rely on it. The app
decides a feed is live from whether new data has actually arrived recently, on
a schedule the service itself reports; a keepalive carries no data, and no data
arrives while the feed is paused, so the app marks it stale by itself within a
known window and falls back to periodic refreshes. Connections belonging to a
feed that was mid-catch-up when the window opened are still closed immediately,
because that costs nothing and lists nothing. The rest are left to the app's own
check, and the wait is stated rather than implied — unlike the first residual,
this one has a measured bound.

**What this change does NOT include, and the reason is worth recording.** It
ships the ability to hold a service off its data; it does not ship the
step-by-step procedure for actually moving the database. The operating runbook
still says, as it has since the problem was first raised, that the procedure is
unspecified — it now points at the mechanism instead of at an open question.

That was a deliberate split rather than work left undone. A full procedure was
drafted and went through seven rounds of review; each round produced correct
findings and the count rose rather than fell, and one round's fix was
invalidated by the next round's. The cause was not the drafting. The procedure
describes an operation with four unresolved inputs — there is no tooling to
produce a maintenance build without hand-editing production configuration, it
is an open decision whether rows worth keeping are archived or restored back
into service, the length of the wait for work already in flight has never been
measured, and the ordering against a planned contract redeploy is unsettled.
Writing steps around four unknowns generates a steady supply of correct
objections about steps whose preconditions do not exist yet.

So the mechanism lands, and the procedure is tracked separately with its open
findings recorded against the draft. Nothing about the database move becomes
possible or impossible as a result; what changes is that a reader of the
runbook is no longer told a procedure exists when the things it depends on have
not been decided.

The functional specification gains the intent underneath all of this: a service
that cannot reach its data says so rather than answering anyway; holding a
service off its data is done by removing the capability rather than by
enumerating the code that uses it; and the residual is named rather than
absorbed.

Closes #2239. Two follow-ups, both deliberate. Producing a maintenance build
still means editing a production configuration file by hand and remembering to
put it back, four times over; tooling to generate it so no tracked file is ever
touched is #2250, left out here because it cannot be honestly verified from
this side — proving it works means taking a live service off its database,
which is the very operation it exists to make safe. And the operating procedure
for the move itself is #2255, with the draft and its open findings recorded
there.
<!-- assembled-fragment: 2239-d1-maintenance-barrier.md sha256=1e38a46a9e7fd7c9733ef5a0171c828a70b47d3c59930a682e69362a9712fd53 -->
