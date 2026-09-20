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
end-to-end, and the part that makes it work is an invariant rather than a step.
The four services still switch over at independent times, exactly as they
always did. What changed is what the others are doing meanwhile: during the
window the set is only ever *some on the new database, the rest refusing* — it
is never *some on the new, some on the old*. Nothing can write to the abandoned
database because nothing is pointed at it any more. Staggered switching stops
being a window in which writes are lost and becomes merely staggered. A service
whose switch fails now fails safe, staying on the refusing build rather than
carrying on against the database being left behind.

Several things fall out of that and are now stated in one place rather than
scattered. Unrelated changes must not be merged for the duration, because any
merge re-deploys every service from a tree that still names the old database —
which would put one back on it while others have already moved, recreating
exactly the split the invariant rules out. That freeze is a precondition, in
force before the first step and until the last, rather than a closing remark.
Confirmation is read from each deployment's own configuration rather than from
how a service behaves, because two of the four cannot be asked behaviourally at
all — one is currently unscheduled and answers no requests, the other runs once
a day.

And one thing is now said plainly that had been implied: the rows worth keeping
are **archived, not restored**. They are exported to a file and nothing loads
them into the new database, which starts deliberately empty. So a support
ticket that survives this procedure survives as a line in a file, and somebody
has to answer it from there. Whether that is the intended outcome is an open
decision for the owner — loading them back is not something this procedure can
invent for itself, because it would need answers about identifier collisions
against a fresh schema, about what a diagnostic record means once the contracts
it refers to are gone, and about whether a legal hold may be reconstructed at
all.

The reason all of this now lives in one block is itself worth recording. Three
review rounds found the same defect in three different places: the procedure's
safety properties were restated in the opening summary, in the governing rule,
in the description of the mechanism and inside the steps — and an edit to one
left the others saying something else. Patching a fourth contradiction would
have repeated the loop, so the properties are stated once and everything else
points at them. The steps are lettered, too, because the document already had a
differently-numbered sequence and "step 3" had come to mean two different
things.

There is also an explicitly marked exception: the nightly backup service sits
outside the shared code and so fails bluntly rather than politely during a
window. It writes nothing a user can see, so nothing is lost — but an operator
watching the logs should expect a raw error from it and not read that as a new
fault.

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
