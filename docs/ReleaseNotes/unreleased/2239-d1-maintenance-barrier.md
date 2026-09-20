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
