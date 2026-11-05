## Thread — Scaffold the next connected app, apps/alpha05 (PR #3179)

A new workspace package, `apps/alpha05`, starts the connected app rebuilt
from the functional specs under the rulebook in
`docs/DesignsAndPlans/Alpha05AppDesign.md`. It deploys to its own Worker,
`vaipakam-alpha05`, and nothing about `apps/app` or `app.vaipakam.com`
changes: the current app keeps serving until the new one reaches parity
under the rulebook's cutover conditions. Advances #3180.

The scaffold carries the same toolchain the other surfaces use, every route
of the page map rendering an honest "not built yet" page that names the
feature-matrix rows it will carry and links the current app, and the shared
modules the rulebook says ship before any route, as typed contracts with
minimal implementations: the capability service (which reads the Diamond's
routed functions from the loupe and reports everything else as unknown
until read), the eligibility verdict and switch classes, three-valued
transaction outcomes, identity-scoped read keys, the claim row model, copy
tiers with a typecheck-time word budget on inline status sentences, the
"Why?" help link, and the receipt and finish-card types. A connected user's
own state is read through the wallet's provider first, with the read-only
proxy as fallback.

Every response from the new Worker says it is not to be indexed until the
cutover, the content-security policy is completed from the build the same
way the current app's is (connect sources report-only first), and the
Worker is held in the deploy-lag check until a Workers Build exists for it.
CI typechecks and unit-tests the package.

> Caveat: the lockfile re-keys three of `apps/app`'s dependency variants (the
> wallet libraries' optional `zod` peer) because the package manager
> deduplicates peers across the workspace; the resolved versions are the same
> and neither app imports that optional entry, so the current app's bundle is
> unchanged.

The new app carries the website's brand set (the shield mark in both colourways, the wordmark, the home-screen icon) as its own files: the favicon follows the colour scheme, the header shows the mark on phones and the wordmark on wider screens, and the loading splash uses the same mark.
