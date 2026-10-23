## Governance — a new Diamond stays paused until a launch step proves it is ready (PR #<n>)

The deploy used to unpause the Diamond at the end of its contracts phase.
That opened offers and accepts to the public before the later phases had
wired a price feed, set a sanctions screen or registered a swap route, so a
chain could be live with every wallet reading as unsanctioned and no way to
liquidate. The deploy now leaves the Diamond paused on every chain, and the
first unpause belongs to a new launch step.

The launch step reads five requirements off the live chain and prints each
as met, not met, or not checked: a treasury is set, a sanctions oracle
contract is set, the ETH/numeraire price feed is set, at least one enabled
swap adapter exists, and the VPFI cross-chain pool has at least one lane. A
requirement the chain cannot answer is never read as met. On a production
chain every requirement must be met and the governance handover must be
complete, and the step broadcasts nothing: it prints the Timelock proposal
for the governance Safe, so the first unpause waits out the same 48-hour
window as any governance action (owner decision 2026-10-23).

The proposal is not a bare unpause. It is a batch of two calls: a new
stateless launch-gate contract reads every requirement again, and checks
that the deploy key still holds no role, then the Diamond is unpaused. The
Timelock runs both in one transaction, so if a requirement stopped holding
during the 48-hour wait (a swap route was removed, the sanctions oracle was
cleared, the deploy key was given a role back), the execution fails and the
Diamond stays paused until it is fixed. The unpause is also tied to the
pause count at the time of the proposal: if the Guardian pauses or the
watcher auto-pauses during the wait, the launch can no longer execute, so a
launch decided before an incident never lifts the incident's pause. A fresh
proposal is needed once the incident is closed. The gate has no owner and sits at
an address fixed by its own code, so reviewers can check exactly what the
proposal calls; the contracts phase deploys it.

No requirement is met just because an address has code. The sanctions
oracle must answer a sanctions lookup (the Diamond treats a failing lookup
as "not sanctioned", so a wrong contract would screen nobody), the price
requirement asks the platform's own price oracle to price ETH right then,
under the same rules every other flow uses (so a missing, malformed, stale
or distrusted price does not count), and a swap route counts only when the adapter
is enabled and answers as an adapter. The cross-chain lane check reads the
VPFI pool from Chainlink's token registry for the token the Diamond itself
records, rather than trusting a pool address from the deploy files. A production launch also
refuses while the deploy key still holds any Diamond role, not only the
unpause role.
A Diamond that is already unpaused is recorded as launched only on
evidence: on a production chain the Timelock must report the launch
operation executed, and on a testnet no answered requirement may be unmet.
Any other unpause makes the launch step refuse instead of recording it,
and the deploy scripts record the launch from that same evidence rather
than from whether the Diamond happens to be unpaused. Once a Diamond has
launched, the launch step never offers to unpause it again: a later pause
is an incident and is lifted through incident response. On a testnet,
where the admin launches directly and leaves no such record, the admin
unpauses only a Diamond that has not been paused since it was created,
unless the operator explicitly confirms it never went live. The readiness
report printed by the verify phases now reaches the same verdict the
launch would, handover included. On
a testnet no answered requirement may be unmet and the admin unpauses
directly. A local development chain only warns. The deploy scripts' verify
phases print the same report, and fail if a Diamond was unpaused outside
the launch step.

The testnet configure phase now also sets the admin's test sanctions list as
the Diamond's oracle (#946), so a testnet launch passes the sanctions check.
On mainnet the sanctions source is still waiting on the #2443 adder-host
decision, so a mainnet launch refuses until that is settled, by design.

Closes #945. Closes #946.
