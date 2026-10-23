## Governance — a new Diamond stays paused until a launch step proves it is ready (PR #<n>)

The deploy used to unpause the Diamond at the end of its contracts phase.
That opened offers and accepts to the public before the later phases had
wired a price feed, set a sanctions screen or registered a swap route, so a
chain could be live with every wallet reading as unsanctioned and no way to
liquidate. The deploy now leaves the Diamond paused on every chain, and the
first unpause belongs to a new launch step.

The launch step reads six requirements off the live chain and prints each
as met, not met, or not checked: a treasury is set, a sanctions oracle
contract is set, the declared WETH is configured and priced, at least one
enabled swap adapter exists, VPFI is routed through the declared
cross-chain pool, and that pool carries exactly the declared lanes. A
requirement the chain cannot answer is never read as met. On a production
chain every requirement must be met and the governance handover must be
complete, and the step broadcasts nothing: it prints the Timelock proposal
for the governance Safe, so the first unpause waits out the same 48-hour
window as any governance action (owner decision 2026-10-23).

The proposal is not a bare unpause. It is one call to a new launch
function on the Diamond, which first asks a new stateless launch-gate
contract to read every requirement again, and unpauses only if the gate
agrees, in the same transaction. The gate also checks that the deploy key
still holds no role, that the Diamond is still owned by the Timelock the
Safe reviewed, and that no role has changed hands since the handover check
proved who holds each one. The Diamond's role holders cannot be listed
on-chain, so the Diamond now keeps a count of every change to its role
table; the handover check prints that count when it passes, the proposal
carries it, and the launch refuses if the count has moved. So if a
requirement stopped holding during the 48-hour wait (a swap route was
removed, the sanctions oracle was cleared, the deploy key was given a role
back, or another queued operation gave an administrator role to someone
new), the execution fails and the Diamond stays paused. A moved role count
needs the handover check run again and a fresh proposal. The unpause is
also tied to the pause count at the time of the proposal: if the Guardian
pauses or the watcher auto-pauses during the wait, the launch can no longer
execute, so a launch decided before an incident never lifts the incident's
pause. A fresh proposal is needed once the incident is closed. The gate has
no owner and sits at an address fixed by its own code, so reviewers can
check exactly what the proposal calls; the contracts phase deploys it. The
Diamond accepts only a gate call about itself, so a gate's answer about a
different Diamond cannot launch it.

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
A Diamond is recorded as launched only on evidence, the Diamond's own
record of its first unpause (described below), and on a production chain
that record must name the Timelock and this checkout's launch gate. A
Timelock operation that only unpauses leaves no gate on the record, so it is
refused rather than counted as a launch that no readiness check vouched for,
and so is an unpause through any other contract that merely answers the
gate's call, since nothing shows what it checked. Any other unpause makes the launch step
refuse instead of recording it, and the deploy scripts record the launch
from that same evidence rather than from whether the Diamond happens to be
unpaused. Once a Diamond has launched, the launch step never offers to
unpause it again: a later pause is an incident and is lifted through
incident response. The readiness
report printed by the verify phases now reaches the same verdict the
launch would, handover included. On
a testnet no answered requirement may be unmet and the admin unpauses
directly. A local development chain only warns. The deploy scripts' verify
phases print the same report, and fail if a Diamond was unpaused outside
the launch step. They also end with the launch verdict in words, so a
"verify OK" never reads as "ready to launch": verify runs before the
handover, when a production launch still refuses by design, so that verdict
is stated rather than turned into a failure. After a launch, the scripts say
whether the Diamond is paused now: one launched and then paused for an
incident is reported as launched and paused, never as live.

The Diamond now records its own launch: the first time its birth pause is
lifted, it stores who lifted it and when, and never changes that record
again. The launch step reads whether a Diamond has launched from that
record. Before, it rebuilt the Timelock operation it expected, which a later
build of the launch gate, a different registry or admin address, or a
Pauser repeatedly re-pausing to inflate the pause count could all hide; a
launched Diamond under an incident pause could then have been offered a
second launch. On a production chain the record must name the Timelock, so
a Diamond first unpaused by anyone else is refused and named. A testnet
Diamond paused again before it ever went live no longer needs the operator
to confirm it never launched: the record says so.

The launch checks the chain against what the launch DECLARES, not against
itself. The lane list is the same per-chain list the cross-chain wiring
phase uses, and the pool must carry exactly those lanes: a missing lane
would leave a destination unreachable, and an extra one is a route nobody
reviewed. The pool Chainlink's registry routes VPFI through must be the pool
the deploy recorded, the one the handover check proved is owned by the
Timelock; the handover check itself now also fails when the registry routes
VPFI through any other pool, or when that pool's rate limits can be set by
anyone but the bounded rate governor. The launch-gate contract re-reads that
authority when the Timelock executes the launch: the token's registry
administrator, the pool's owner and the rate governor's owner must all still
be the Timelock, with no transfer pending where one can be seen, and the
pool's rate-limit admin must still be the governor, so a change queued in the
same 48-hour wait cannot hand the route to someone who could lift its limits.
(A Chainlink pool keeps a started ownership transfer private, so the gate
cannot see one; the handover check reads it from the pool's events.) The
configured WETH must be a token
contract with 18 decimals, because the price oracle prices whatever address
is stored as WETH from the ETH feed. Nothing on-chain records which token is
a chain's bridged WETH, so the Timelock proposal prints the WETH (with the
registry, pool and lanes) for the governance Safe to check against the
chain's official bridge registry, and the on-chain re-check refuses any
other value than the one signed. A deployment built without the VPFI token
that declares no pool or lane reports both cross-chain requirements as met
because they do not apply, and says so, so a testnet deployed that way can
still launch.

The cross-chain readiness check now reads every lane of the VPFI pool, not
just whether one exists. Each lane's inbound and outbound rate limits must
be enabled and inside the bounds the rate governor enforces. A lane wired
without its limits (for example when the limits transaction failed after
the lane was added) carries no cap at all, so it refuses the launch, and the
Timelock's launch also fails if a limit is switched off during the wait.

Because the Diamond now stays paused until launch, the two risk settings
(per-asset risk parameters and the loan-admission health-factor floor) no
longer refuse while paused (owner decision 2026-10-23). Without that, a chain
could not set its risk limits before going live. They still need the risk
admin role, which the Timelock holds after the handover, so every change keeps
its governance delay.

The testnet configure phase now also sets the admin's test sanctions list as
the Diamond's oracle (#946), so a testnet launch passes the sanctions check.

The launch report and the verify verdict count the admin key only when the
admin's private key is actually supplied, as the launch itself does, so they
never predict an admin unpause the launch could not make.
On mainnet the sanctions source is still waiting on the #2443 adder-host
decision, so a mainnet launch refuses until that is settled, by design.

The launch checks do not cover per-asset risk parameters, and the launch
step now says so on every run. No deploy phase sets them and there is no
declared list of collateral assets to check, so a chain can pass every check
while each ERC-20 collateral still has a zero loan-to-value cap, which
refuses every liquid loan (loans against illiquid assets and NFTs are
unaffected). Until asset onboarding is designed (#2696, owner decision
2026-10-23), governance sets those parameters through Timelock proposals
before scheduling the launch.

Closes #945. Closes #946.
