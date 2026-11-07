## Thread — Recovering from a compromised app build (PR #3271)

A service worker keeps running in a visitor's browser after the page that installed it is gone. If a bad build of the connected app, or a script injected into a page, ever registered one, it could go on answering requests after the genuine build was restored. Every load of a production build of the app now removes any service-worker registration on its origin that is not the app's own worker, before it registers its own. One registration that refuses to go does not stop the others from being removed.

That only helps once the genuine page runs. A foreign worker that answers page loads itself would keep the genuine page from ever loading, so the incident runbook gains a section for the case where our own app or domain serves code we did not ship. It covers how to detect it, how to roll the Worker back and stop the bad commit redeploying, the emergency header that clears what a bad build left in browsers (and what that costs visitors), what to tell users about approvals and signatures, and how to confirm the clean build is back. Until now the runbook only covered clones on other domains.

The runbook's domain-hygiene item now records the measured state of the canonical domains: DNSSEC, CAA records and HSTS are not yet in place. Turning them on is an owner decision pending on #3236, as are the automatic served-build check and the mainnet deploy gate.

Advances #3236.

> Caveat: the removal runs only when the genuine page loads; the emergency header in the runbook is the lever for a worker that intercepts page loads, and whether every browser honours it on the worker's update fetch is to be checked during an incident, as the runbook says.
