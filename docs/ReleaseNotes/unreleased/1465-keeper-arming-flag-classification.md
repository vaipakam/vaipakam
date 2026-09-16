## Thread — the keeper's arming flags are secrets, and its own config finally says so (PR #<n>)

The keeper Worker's configuration file described `KEEPER_ENABLED`,
`REWARD_REMIT_ENABLED` and `REWARD_COMMIT_ENABLED` as "operator-managed vars
(non-secret config — plain vars)". They are not. On the live deployment all
three are per-Worker secrets, set the way secrets are set and unreadable
afterwards from either the API or the dashboard. Four other places in the
repository already recorded that correctly — the Worker's own environment
module, the off-chain restore runbook, the keeper README and the root
contributor guide — and the restore runbook went as far as naming this config
file as the one carrying the wrong description, after checking the live
deployment on 2026-07-30. The file an operator actually edits was the last
holdout, so the correction never reached the place most likely to be trusted.

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
survives. One thing this change does not establish is whether the deployed
keeper is currently armed: the values cannot be read back, which is the whole
reason each gated pass reports how it resolved them at runtime.

Closes #1465.
