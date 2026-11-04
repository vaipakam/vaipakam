## Thread — Keeper and agent deploys no longer wait for the indexer's migrations

The keeper's and agent's deploys used to check that the shared database
had every migration their build was written against, wait up to ten
minutes for the indexer's deploy to apply any that were missing, and
refuse to publish if the wait ran out. On this account Cloudflare Workers
Builds runs one build at a time. So on any merge that added a migration,
the waiting agent or keeper build held the only build slot while the
indexer build that would apply the migration sat queued behind it. The
wait timed out every time and the Worker stayed on its previous version.
That is what happened to the agent build for a68b4baa8. A longer wait
would only have blocked the indexer for longer.

Those two deploys now read the migration record once, log a warning that
names any migration still pending (or says the record could not be read,
so the state is unknown), and publish anyway. Safety does not come from
the deploy order. It comes from three guards that were already in place.
Every scheduled runner of the shared database declines its ticks by name
until every migration in its build is recorded, and resumes by itself
once the indexer's deploy applies them. Every migration must be additive,
which CI enforces. Every HTTP route must tolerate the previous schema.

The indexer is still the only deploy that applies migrations, and it
still refuses to publish until it has verified them, so the old race
between three appliers does not come back. A manual release that carries
a migration should still deploy the indexer first, so that the window in
which the agent's scheduled work declines stays empty.

Closes #3115.

> Caveat: between a keeper or agent publish and the indexer's apply, that Worker's scheduled work is paused, not run. The deploy log says so by name.
