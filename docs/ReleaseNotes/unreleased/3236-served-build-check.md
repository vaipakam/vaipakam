### A scheduled check that each site serves what its commit builds (#3236)

Every six hours a new check rebuilds the commit that each site's live deployment is stamped with (the connected app, the new app alpha05 and the marketing site) and compares what visitors receive with that build. It fetches every file the build writes from the custom domain and from the `workers.dev` address and compares their digests, and it compares the security headers the site's `_headers` file sets for the home page (including the Content-Security-Policy) with the ones actually sent. For the marketing site it compares the bundled code only, because its deploy writes its pages from live data.

The build uses the public build variables recorded in `.github/served-build.json`, not the values read back from the Cloudflare dashboard. That is deliberate: a dashboard change, such as pointing the RPC or indexer address somewhere else, then shows up as a difference until someone records the new value in a reviewed commit. The build runs with no token in its environment.

A finding opens an assigned issue ("Served build differs from its commit") and pings the ops chat, through the same alert path as the deploy-lag check. It says what it found: a file or header that differs, a deployed commit that is not on `main`, a deployment it cannot verify (no stamp, a build with uncommitted changes, or traffic split between versions), or a commit that would not build. A difference names both possible causes, a changed build variable or an altered site, and the runbook says to treat it as altered until shown otherwise. A deploy that lands during the check is not judged that run.

The first run, against the deployments live on 2026-11-07, found all three sites serving exactly what their commits build. A run with one build variable changed reported the difference, so the check can see one. The deploy-lag check now reads deployments through the same shared reader.

Advances #3236.
