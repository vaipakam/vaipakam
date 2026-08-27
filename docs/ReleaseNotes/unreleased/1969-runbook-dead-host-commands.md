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

The third was a diagnostics smoke test. It would fail cleanly, which is
the best of the three outcomes, but reads as an outage of a service that
is healthy.

Left alone deliberately: the incident runbook already tells operators to
use the correct host and explicitly not this one, the staging plan
describes decommissioning it, and the release notes record the migration
onto it. Those are accurate records of the past, and rewriting history to
match the present is how a dated record stops being useful.
