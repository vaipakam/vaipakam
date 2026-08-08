## Thread — the Create Offer page could be taken down by a dropdown (PR #1590)

Changing the asset type on the connected app's Create Offer page could
crash it outright. The periodic-interest cadence field hid itself for
illiquid offers by returning early, and two memoised calculations sat
below that return. Because the liquidity decision is derived from live
form state, switching from a liquid asset to an illiquid one changed
how many hooks the component called between one render and the next,
which React treats as unrecoverable — the page aborts rather than
re-rendering. The fix moves the two "render nothing" gates below the
calculations. Both are pure, so running them on a path that displays
nothing costs a little work and changes no behaviour.

This was found by the linting work in #1529 rather than by anyone using
the app, which is the uncomfortable part: `apps/defi` has carried a lint
configuration for months that no automated job has ever executed, and a
real crash sat in it undisturbed. The same scan reported thirteen more
violations of the same rule. Two turned out to be latent rather than
live — one is gated on a build-time environment flag and the other on a
lookup that does not vary for a given element — but latent is a property
of today's conditions, not a guarantee. Both are fixed here as well. The
admin console needed more than moving its gate: eleven hooks sat below a
redirect for visitors who are not supposed to reach the page, and simply
lowering the redirect would have run the console's chain reads for
exactly those visitors. It is now split so the gate is hook-free and the
dashboard calls its hooks unconditionally — which is also the shape the
planned wallet-aware gating needs, since that will make the condition
runtime-driven and turn the old arrangement into a live crash.

Review then caught the sweep being narrower than it looked. The
documentation component that had been fixed lives in the connected app,
and that copy turns out to be unreachable — nothing renders it. The
component the documentation pages actually render is the marketing
site's near-identical copy, which still carried the same defect, on
pages that really are served: the whitepaper, the overview, the user
guide and the parameter reference. That copy is fixed here too, along
with four more conditional hooks on the parameter-reference page, which
needed the same gate-and-inner split as the admin console for the same
reason. The duplicate itself is left alone for now and tracked
separately (#1603) — two look-alike files where only one is rendered is
a trap that already cost this change a review round, but deleting dead
code is its own piece of work.

Guarding the fix mattered as much as making it. Wiring the app's full
lint into CI is not currently possible — it reports several hundred
pre-existing errors, mostly untyped values — and waiting for that
backlog is precisely what let this crash class survive. So CI now runs a
single-rule check for conditional hooks, the one rule the app is clean
against, alongside the existing type check. Reinstating the original bug
shape makes it fail with the two calculations named. The narrow check is
deliberately quiet about everything else: an earlier draft reported
forty-two problems it did not care about, and a guard that cries wolf is
one people stop reading — the habit that started this.

The marketing site needed the same guard and had even less: no lint
configuration of any kind, which is why nothing could have reported the
defect on its pages. It now runs the same single-rule check, verified
the same way. That closes the gap for every part of the codebase that
renders React — the connected app and the marketing site are guarded by
this check, the alpha surface already ran the full lint, and the shared
component package was scanned and is clean.

No functional-spec change accompanies this: the intended behaviour was
always that the page works, and nothing about what the product is meant
to do has changed.

Closes #1521
