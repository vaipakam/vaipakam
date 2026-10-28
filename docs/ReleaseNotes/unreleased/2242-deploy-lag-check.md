## Thread — A Worker left behind main now opens an issue (PR #3007)

Merged code that never reached its Worker used to be silent. The connected app once served a build from before a merged fix for days, and nothing said so: the live review that follows a deploy never happened, because the deploy never happened. Closes #2242.

Every deploy the repository runs now records the commit it was built from on the Worker version it uploads. That covers the app, the marketing site, the indexer, agent and keeper (through their shared deploy script), and the two operator Workers. Cloudflare already recorded when a version was uploaded, but not what it was built from. A deploy from a working copy with uncommitted changes is marked as such. If no commit can be named, the deploy still goes ahead and says it recorded nothing.

An hourly check compares each Worker's live deployment with main. It finds the Workers from the tracked Worker configs, so a new Worker is watched with no edit. A Worker's code is its own directory plus the shared packages its build reaches. Changes to tests, end-to-end drivers and Markdown are not counted, and neither is a shared package's build tooling. Once a merged change to a Worker's code has waited six hours undeployed, the check opens one "Workers behind main" issue naming each Worker, the changes it is missing and the oldest of them. It comments again only when the set of Workers changes, and closes the issue once nothing is overdue. A Worker whose deployments cannot be read is reported as unknown, never as current.

A deployment from before this change carries no record, so the check places it by its deploy time and marks the result as inferred. A Worker whose lag is a decision can be listed with its reason in a reviewed commit. It is then still reported, with that reason, but no longer opens the issue. The one listed today is the recycling-mesh watcher, which is complete but deliberately undeployed because it has no free Cloudflare cron slot.

The issue-and-chat alert the indexer health probe built is now one shared workflow, and both checks use it. The probe's behaviour, titles and wording are unchanged.

> Caveat: a change that alters a bundle through a path no package declares (a build reading a file outside the Worker's directory and its shared packages) is not seen. The check under-reports rather than false-alarms there.
> Caveat: Workers Builds runs whatever deploy command its dashboard holds. A Worker whose dashboard command bypasses the package deploy script deploys without the record, and the check marks it inferred.
