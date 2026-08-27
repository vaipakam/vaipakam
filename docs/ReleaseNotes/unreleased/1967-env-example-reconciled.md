## Thread — the connected app's example configuration matches what it reads (#1967)

`apps/app/.env.example` is what an operator copies to `.env.local` before
deploying, and #1854 made it more load-bearing by pointing the deployment
runbook and the staging plan at it as the authoritative list. It was
missing two of the variables the app actually reads, so an operator could
follow it completely and still not know those settings existed.

Both are optional and both degrade quietly rather than breaking, which is
exactly why they were easy to lose. One overrides the host of the
indexer's realtime push channel, for deploys that front the WebSocket
somewhere other than the read API — unset, the socket origin is derived
from the read origin by swapping the scheme, so realtime updates work
either way and nothing looks wrong. The other repoints the "report an
issue" target in the diagnostics panel, which otherwise defaults to this
repository's tracker; a deploy that wants support reports going somewhere
else had no documented way to say so.

Both are now listed with a comment saying what happens when they are left
empty, and the variable count quoted in the runbook, the staging plan and
the #1854 release note moves from sixteen to eighteen.

Worth recording what this was NOT, because the first pass got it wrong in
both directions. Two per-chain WebSocket entries looked unused and were
nearly removed: nothing in the source mentions them by name, because the
key is assembled at runtime from the matching RPC variable. They are read,
and they stay. Two others looked missing and are correctly absent — one
names a rollout hatch that was removed, surviving only in a comment about
its removal, and the other is a test-only widening that an end-to-end spec
sets and production builds must never carry.

The lesson generalises past this file. A guard that compared the example
against a search for variable names in the source would have produced
exactly those four wrong answers — deleting two live settings and
documenting two that should not be. Any future check here has to
understand computed keys and distinguish operator configuration from test
scaffolding, or it will confidently make the file worse.

Closes #1967.
