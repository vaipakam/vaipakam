## Thread — three deploy commands pointed at a host that no longer exists (#1969)

The deployment runbook carried three instructions an operator runs
verbatim, all aimed at the hostname of a Worker retired in the Stage 3
split. That hostname stopped resolving when the Worker was
decommissioned, so each one failed — but not in the same way, and the
first one did not look like a failure at all.

Registering the Telegram webhook was the dangerous one. The registration
call is made against Telegram, not against our own service, and Telegram
accepts whatever address it is given without checking that anything
answers there. So the command reported success, the operator moved on,
and the bot then silently received nothing — a failure that surfaces
much later as "the bot doesn't respond", with nothing connecting it back
to the step that caused it. It now names the Worker that actually serves
the webhook.

The second was wrong twice over. A frontend deployment step set a
variable that no source file in any app reads — it was split into two
separate origin settings at the same refactor — and pointed it at the
same dead host. An operator following it got precisely the degraded
Alerts page the step exists to prevent, having done everything asked.
Both halves are corrected, with a note recording what the line used to
say, since anyone comparing against an older deployment will find the
old form in their notes.

Repointing them turned out to need more care than swapping a hostname,
and review caught two ways a naive substitution goes wrong.

The frontend step says "set on every frontend deploy", so writing the
production address into it tells an operator to point a staging or
preview build at the live service — and the alerts code carries an
explicit invariant against exactly that, because the live service's
allow-list accepts those origins and one of its endpoints writes real
users' settings. It now says to use the deployment under test, with
production named only as the production case.

The smoke test had the same shape and a second flaw underneath it. Aimed
at the live service, it returns a healthy answer even when the
deployment being tested is broken — a green result that proves nothing.
And its payload carried a fixed identifier while the table treats that
column as a primary key with no conflict handling, so the test worked
once per database and then failed with a constraint error that looks
like a fault in the service. It now generates a fresh identifier per run
and verifies that specific row rather than whatever landed most
recently.

The third was a diagnostics smoke test. It would fail cleanly, which is
the best of the three outcomes, but reads as an outage of a service that
is healthy.

The smoke test needed one more fix that only becomes visible once it can
run at all. Beyond a unique identifier per attempt, each run also needs
to look like a *different* event: the service deduplicates on the shape
of a report and stops writing when the last several records in the whole
table are identical. That check is global rather than per-user, and with
no consumer sending anything else, a run of identical smoke tests trips
it — the sixth returns a polite refusal and the verification query comes
back empty, which reads as a broken deploy but is the deduplication
working exactly as designed. The documented payload now varies per run,
and the refusal is written down so nobody debugs it as a fault.

One correction went further than repointing. The section describing how
the frontend connects to that endpoint said a now-retired variable was
read and already configured. Neither was true, and the endpoint has no
consumer in the shipping app at all — its only callers lived in the
retired connected app. The section now leads with that, because an
operator configuring something nothing calls will be confused by
silence, not by an error.

That correction then had to be made in three places rather than one. The
same section elsewhere described the frontend firing a report on every
failure, and two further settings shaping what gets captured — none of
which exist in the shipping app. The section now says once, at the top,
that the whole feature is dormant and that everything below describes how
it will behave when something calls it. An empty table is the correct
observation today, and an operator checking capture health deserves to
know that before reading three pages about it.

One instruction had to be walked back after review, and the correction
is worth recording because the first attempt was reasonable and wrong.
Warned that the frontend step should not point a preview build at the
live service, I told operators to use the deployment for their own
environment — but there is only one such service, shared by every
environment, and nothing per-environment exists to point at. The step now
says that plainly, and states the consequence instead of pretending it
away: alert settings written from any environment reach real users,
because there is one database behind that one service. Leaving the
setting empty is a safe choice rather than a broken one, since the app
hides the feature and sends nothing. That per-environment isolation does
not exist is a genuine gap, and saying so is more useful than inventing a
URL.

The published privacy policy turned out to describe this same dormant
capture as though it were running — telling every visitor their errors,
redacted wallet and chain are transmitted and kept for ninety days. That
is over-disclosure rather than under-disclosure, but it is still wrong on
a page whose whole purpose is accuracy. It is raised separately rather
than folded in here: it is public legal copy, it needs a decision rather
than a mechanical edit, and burying it in an operations change is how it
would go unread.

Left alone deliberately: the incident runbook already tells operators to
use the correct host and explicitly not this one, the staging plan
describes decommissioning it, and the release notes record the migration
onto it. Those are accurate records of the past, and rewriting history to
match the present is how a dated record stops being useful.
