## Thread — one schema gate for every scheduled user of the shared database (PR #2635)

The indexer has held its scheduled work while the shared database was missing
a migration its build carries, so new code never met an older schema. The
agent had no such check, and the keeper machine borrowed the indexer's by
reaching into the indexer's source. The agent and the indexer both
auto-deploy on merge, through a dashboard deploy command the repository cannot
pin, so an agent build could go live before the indexer's deploy had applied
its migrations.

The gate and the list of shared migrations now live in the shared package. The
indexer, the agent's cron tick and the keeper machine's tick all use them. Each
declines by name while a migration is missing and resumes by itself once it
lands. The agent's HTTP routes are still not gated and must tolerate the
previous schema. The migrations directory stays the indexer's, and the
indexer's typecheck still fails if the list and the directory differ. The
recommended Workers Builds setting (deploy command `pnpm run deploy` for all
three) is unchanged; the gates are the backstop for a route that skips it.

Closes #2410.
