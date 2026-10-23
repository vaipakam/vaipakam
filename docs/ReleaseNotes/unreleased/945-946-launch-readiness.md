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
stateless launch-gate contract reads every requirement again, then the
Diamond is unpaused. The Timelock runs both in one transaction, so if a
requirement stopped holding during the 48-hour wait (a swap route was
removed, the sanctions oracle was cleared), the execution fails and the
Diamond stays paused until it is fixed. The gate has no owner and sits at
an address fixed by its own code, so reviewers can check exactly what the
proposal calls; the contracts phase deploys it.

A swap route now counts only when the adapter is enabled, has code and
answers as an adapter, so an address registered by mistake is not a route.
A Diamond that is already unpaused is recorded as launched only on
evidence: on a production chain the Timelock must report the launch
operation executed, and on a testnet no answered requirement may be unmet.
Any other unpause makes the launch step refuse instead of recording it. On
a testnet no answered requirement may be unmet and the admin unpauses
directly. A local development chain only warns. The deploy scripts' verify
phases print the same report, and fail if a Diamond was unpaused outside
the launch step.

The testnet configure phase now also sets the admin's test sanctions list as
the Diamond's oracle (#946), so a testnet launch passes the sanctions check.
On mainnet the sanctions source is still waiting on the #2443 adder-host
decision, so a mainnet launch refuses until that is settled, by design.

Closes #945. Closes #946.
