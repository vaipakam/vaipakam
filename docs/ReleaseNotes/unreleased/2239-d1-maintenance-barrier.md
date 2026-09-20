## Thread — a service that cannot reach its data now says so, and stopping every writer no longer means listing them (PR #<n>)

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

What the services gained is the ability to be held that way **gracefully**.
Without it, code that expected a database would simply crash, which is loud but
tells nobody whether their write landed. Now each service refuses at its
entrance: a caller gets a temporary-unavailable answer that says plainly that
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

The operating procedure for the database move now carries the sequence
end-to-end, including an explicitly marked exception: the nightly backup
service sits outside the shared code and so fails bluntly rather than politely
during a window. It writes nothing a user can see, so nothing is lost — but an
operator watching the logs should expect a raw error from it and not read that
as a new fault.

The functional specification gains the intent underneath all of this: a service
that cannot reach its data says so rather than answering anyway; holding a
service off its data is done by removing the capability rather than by
enumerating the code that uses it; and the residual is named rather than
absorbed.

Closes #2239. Follow-up, deliberately not folded in: producing a maintenance
build still means editing a production configuration file by hand and
remembering to put it back, four times over. The procedure names that as its
own weakest step rather than glossing it; tooling to generate the stripped
configuration, so no tracked file is ever touched, is filed as #2250. It was
left out because it cannot be honestly verified from here — proving it works
means taking a live service off its database, which is the very operation it
exists to make safe.
