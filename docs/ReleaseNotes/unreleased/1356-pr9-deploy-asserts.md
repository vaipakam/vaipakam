# Deploy-time guardrails for the new fee-and-reward defaults (#1356)

Adds the M2 deploy-sanity asserts the completion plan schedules before any
mainnet deploy. A fresh deployment is now proven — by the same automated
gate every deploy already runs — to land in exactly the intended dark
state:

- the VPFI price anchor is unset (the retail deploy never prices VPFI, and
  an accidentally-set anchor would arm the VPFI-payment discount path);
- new-origination fees resolve to the frozen defaults (0.2% initiation,
  2% yield);
- the fee-entitlement master switch is off — the joint reward-cutover gate
  expressed as a deploy assert — with its tariff coefficient at the bounded
  default;
- the reward governor is unarmed (arming is an operator ceremony with its
  own preconditions);
- the retired per-ETH-day tariff knob still reads its default, so a value
  moved on a dead knob is caught as the alarm it is.

Because the platform is pre-live, these are green-field assertions on
fresh deploys — no migration variants exist or are needed.

The pre-deploy gate also gains a drift check between the deploy scripts
and the shared deployments manifest: every facet address a deploy script
records must have a matching typed field in the manifest every consumer
reads — an unrecorded-but-deployed address would otherwise be invisible to
the frontend and the off-chain workers. Typed fields that no script writes
are listed as advisory only, since some are populated by chain-specific
tooling.

Part of the #1349 recycling completion programme (plan §M2 PR-9).
