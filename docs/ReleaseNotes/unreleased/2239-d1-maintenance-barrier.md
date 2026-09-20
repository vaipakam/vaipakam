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
**gracefully** — the exception is the nightly backup service, which shares none
of this code and is described further down. Without it, code that expected a
database would simply crash, which is loud but tells nobody whether their write
landed. Now each of those three refuses at its entrance: a caller gets a temporary-unavailable answer that says plainly that
nothing they sent was recorded and that nothing read back would be current,
with a retry hint; background ticks decline to start and say so once, rather
than launching a dozen pieces of work that each discover the refusal
separately. Any path that somehow gets further meets a stand-in that refuses by
name — including through operations the database provider has not invented yet,
because the stand-in states a rule rather than listing today's methods.

Two choices inside that are worth naming because they cost something. The
refusal is **blanket**: a handful of routes touch no database at all and are
refused along with the rest, for the short duration of a window. The
alternative is a hand-kept list of which routes read data, which is the same
unfinishable list one level down, so the cost is accepted and recorded rather
than traded for a new one. And the self-rescheduling ingest work declines
**without rescheduling itself**, because it cannot make progress without a
database and retrying every few seconds would only bill for rediscovering the
same refusal; the ordinary scheduled backstop restarts it afterwards.

The guarantee is also bounded honestly. Work already running when the
maintenance build goes out still holds what it was given and can still write.
That is real, and it is disclosed in the procedure as the one remaining
exposure, to be waited out — with the length of that wait left unstated,
because nobody has measured it and an invented number in an operating procedure
is the defect this whole exercise was opened to remove. What changed is the
shape of the unknown: one measurable quantity instead of an open-ended set of
entry points to get right.

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
