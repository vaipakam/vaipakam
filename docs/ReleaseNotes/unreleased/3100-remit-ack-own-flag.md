## Remit acknowledgements get their own keeper switch (PR #3129)

The keeper's acknowledgement pass, which completes each reward-budget
remittance on Base once its delivery lands on the mirror, used to share its
switch with the pass that sends new remittances. Turning remittances off
therefore stopped the acknowledgements too. That broke the pre-redeploy
drain in the deployment runbook, which needs exactly that combination: stop
new remittances, and keep acknowledging the ones already in flight until
none is pending.

The acknowledgement pass now has its own switch, `REWARD_REMIT_ACK_ENABLED`.
Like every keeper switch it ships off. A keeper that already sends
remittances must have it turned on in the same change, or its remittances
stay pending. The runbook's drain step now names the switch it leaves on,
and the incident and restore procedures name both switches.
