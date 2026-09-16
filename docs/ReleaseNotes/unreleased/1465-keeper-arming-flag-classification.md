## Thread — the keeper's arming flags are secrets, and its own config finally says so (PR #<n>)

The keeper Worker's configuration file described `KEEPER_ENABLED`,
`REWARD_REMIT_ENABLED` and `REWARD_COMMIT_ENABLED` as "operator-managed vars
(non-secret config — plain vars)". They are not. They are per-Worker secrets,
set the way secrets are set and unreadable afterwards from either the API or
the dashboard. That was checked against the live deployment on 2026-07-30 for
the kill-switch specifically; the two reward flags were **absent** there, both
reward passes dark, and are provisioned the same way when they are armed. The
distinction matters for anyone reconstructing deployment posture: two of the
three are not unreadable live state, they are simply not set.

The Worker's own environment module and the off-chain restore runbook already
recorded the classification correctly, and the runbook went as far as naming
this config file as the one carrying the wrong description. The other two
inventories were each wrong in a different direction, and are corrected here
too: the keeper README filed the reward passes' lookback and lane-cap knobs
under "set via wrangler secret put" although they are ordinary variables, and
the root contributor guide left both reward arming flags out of the keeper
secret list entirely. So this was not one stale file against four correct
ones — three sites disagreed, and an operator could land on any of them.

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
edit to it is overwritten rather than kept — it has to be changed in the
configuration. Nothing else in the plain-variable class is declared, so
everything else in it is genuinely preserved.

One thing this change does not establish is whether the deployed keeper is
currently armed. For the kill-switch the value exists but cannot be read back,
which is the whole reason each gated pass reports how it resolved it at
runtime; for the two reward flags the last live check found nothing set at
all, and that observation is over a month old.

Closes #1465.
