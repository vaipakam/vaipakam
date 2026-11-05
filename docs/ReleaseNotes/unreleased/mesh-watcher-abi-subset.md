## Mesh watcher — carry only the views it reads (PR #<n>)

The VPFI recycling mesh watcher used to bundle five complete facet ABI files,
about 300 KB of its 1.1 MB Worker, almost all of it error and event
definitions it never decodes. It runs every five minutes on the Workers Free
plan, which allows 10 ms of CPU per run, and most runs start a fresh copy of
the Worker that has to load all of that again. Live runs were measured at
26 to 37 ms of CPU each.

The Worker now carries only the fourteen views it calls, each copied
unchanged from the compiled facet ABI by a small script. The bundle drops to
about 790 KB, and loading it costs about a fifth less CPU in a local
measurement. What the watcher reads, checks and alerts on is unchanged.

The copy cannot go stale silently. A check refuses any entry that differs
from the current compiled ABI, and it runs in the watcher's CI job (which any
facet ABI re-export triggers) and before every build and deploy of the
Worker. Before this change, a re-export that moved a watched view failed at
the first live run. Now it fails before the deploy. The per-run shape check
the readers rely on still runs as before.

> Caveat: whether Cloudflare counts start-up in the per-run CPU figure was not confirmed; the CPU figure in Workers Observability after the deploy is the measurement that settles how much this saves.
