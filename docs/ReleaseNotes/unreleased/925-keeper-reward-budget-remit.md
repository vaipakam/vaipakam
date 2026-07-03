## Keeper now auto-funds mirror reward budgets (#925)

The #776 reward-budget bridge lets Base fund each mirror chain's
interaction-reward VPFI on demand, but until now an operator had to call the
remittance by hand. This adds a keeper pass that drives it automatically.

On every cron tick the keeper, running against the canonical (Base) chain,
re-scans a bounded window of recent days for each mirror, batches the ones that
have a finalized-but-un-remitted budget (keeping each send under a configured
per-lane VPFI ceiling), quotes the exact cross-chain fee, and remits — so
mirrors stay funded ahead of the day their claim gate opens and users don't hit
the "claim reverts on an empty balance" back-pressure. Discovery needs no stored
cursor: the on-chain quote returns zero for any non-finalized or already-sent
day, so re-scanning is harmless, and sends are idempotent (a day already remitted
is skipped), so retries after a hiccup are always safe.

The pass is dark by default. It runs only when the master `KEEPER_ENABLED`
switch and a dedicated `REWARD_REMIT_ENABLED` flag are both on AND the keeper's
address has been authorized on-chain (either as ADMIN or via the optional
reward-remittance keeper role) — so enabling the automation is a deliberate,
reversible operator step. If a single day's slice ever exceeds the configured
lane ceiling it is skipped with a loud log pointing at the lane-capacity
provisioning follow-up (#918), since a day is remitted atomically.

Closes #925.
