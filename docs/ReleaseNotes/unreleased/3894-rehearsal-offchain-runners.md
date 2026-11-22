## Thread — The deploy rehearsal's indexer and keeper runners (PR #<n>)

The deploy rehearsal now has its off-chain stage. After the readback, the rehearsal driver builds a local shared database with the indexer's own deploy path, then runs one step per forked chain. That step runs the real indexer pass on the fork from the deploy block, and requires the indexer's own health route to report the new Diamond adopted on that chain. It then runs the keeper's real tick setup and one run of every pass in the keeper's schedule, armed exactly as the desired-state file's arming list says for that chain. A pass that throws fails the stage. A pass that tried to reach a service other than the fork is reported by name as not rehearsed, because outbound requests are narrowed to the fork for the whole stage.

The local database comes from a new, separately named entry in the indexer's deploy script. It applies and verifies every shared migration and seeds the retired Diamonds from the run's archive manifest, exactly as a real deploy does, into a folder under the run's scratch root, and it publishes nothing. It refuses any root outside the rehearsal's scratch prefix and a database folder that is not empty.

The keeper signs with keys made for the run. The stage funds them on the fork and grants the keeper, watcher and notification-biller roles, as the fresh-deploy guide's bot-role step does with the real wallets. Each grant is sent as whichever of the run's own admin accounts holds that role's admin role, impersonated for that one transaction. The report lists every key address, grant and mined block, so what the stage changed on the fork is stated.

A second step runs every Worker's existing dry-run publish. It finds them from the packages that carry one, rather than from a list. The report says what that proves and what it does not: each Worker builds, from the committed deployments bundle, and nothing is published.

To check the arming list against the flags the keeper actually reads, the keeper's list of arming flags is now a value as well as a type. A flag in the desired-state file that no pass reads is refused by name instead of arming nothing.

Closes #3894. Part of the deploy rehearsal (`docs/DesignsAndPlans/DeployRehearsalDesign.md`, sections 7 and 16).

> Caveat: the keeper's private database is built in memory from its migrations for each step, because a rehearsal has no deployed private database to stand in for.
> Caveat: the stage reads `keeper.armed` from the desired-state file, which #3111 adds; until that lands the driver cannot run it.
