## Thread — the keeper's arming flags are secrets, and its own config finally says so (PR #<n>)

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
anyone can check. The corrected sites are the ones that were found; the
Worker's own environment module is the authority if some other source
disagrees.

The consequence was not cosmetic. Reading that heading, the reasonable next
step is to commit an arming value into the config so the live state is
visible in review — which is exactly what the tracking issue for this
proposed. Doing it would change deployment semantics: a committed variable
arms or disarms the keeper from any clean checkout, and a variable and a
secret sharing a name are two different bindings, not one. The environment
module already recorded the decision not to do this; the config now points at
that decision instead of quietly inviting the opposite.

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
