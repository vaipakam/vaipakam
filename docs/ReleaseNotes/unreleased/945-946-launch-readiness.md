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
window as any governance action (owner decision 2026-10-23). On a testnet no
answered requirement may be unmet and the admin unpauses directly. A local
development chain only warns. The deploy scripts' verify phases print the
same report, and fail if a Diamond was unpaused outside the launch step.

The testnet configure phase now also sets the admin's test sanctions list as
the Diamond's oracle (#946), so a testnet launch passes the sanctions check.
On mainnet the sanctions source is still waiting on the #2443 adder-host
decision, so a mainnet launch refuses until that is settled, by design.

Closes #945. Closes #946.
