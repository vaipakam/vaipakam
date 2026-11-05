## Keeper — release and return loops start somewhere new each run (PR #3194)

The keeper's reward close-out (the removed remit-destination releases on
Base) and its return transport (pending repatriation authorizations and
stranded quarantine returns on mirrors) walked their candidates from the
first one every run. Both passes cap how many transactions a run may send,
so under a long list the same leading candidates were retried run after run
while the later ones waited.

Each of those three loops now starts at a point that moves from run to run,
using the same rotation the protocol-upkeep pass already uses, seeded by the
run's position in the pass's schedule. Every candidate is still tried once a
run when the budget allows; only the starting point changes. The candidates
in each loop are independent of one another, so the order carried no
meaning. The day-by-day closure and prune steps of the close-out are not
changed by this PR.

This brings the code in line with the keeper spec's existing rule that long
lists rotate their starting point between runs. Both passes still ship
disarmed.

Closes #3155
