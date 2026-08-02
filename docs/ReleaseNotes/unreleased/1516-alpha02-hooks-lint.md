## Thread — Linting for the connected app (#1516)

The connected app ran no linting at all. It had type-checking, a
hardcoded-string guard, unit tests, a production build and a preview
deploy on every change — and none of those can see a React hook called
in the wrong place. That gap let a defect reach a merge-ready state in
the previous change: a hook placed below the position page's
loading branch, which meant the page requested a different number of
hooks on its first render than on its second, and React aborts the page
outright when that happens. It would have crashed the position page on
every single load, and it was caught by a reading pass rather than by
any automated check.

This adds the missing check, deliberately narrow. The one rule that
catches that defect is now enforced and fails the build; the connected
app is clean against it today, so it starts enforcing rather than
starting as a backlog. The linter's other, newer advice — about work
done in the wrong phase of rendering — is recorded as warnings for now
and tracked separately, because switching it on wholesale would have
meant either a large unrelated rewrite bundled into a plumbing change,
or quietly downgrading the whole check to advice to get it passing.
Advice nobody has to act on is how this gap appeared in the first
place.

The check runs inside the same command continuous integration already
invokes for this app, so enforcement needed no new pipeline step.

Running the same check against the OTHER connected surface — which has
had a lint configuration for some time that nothing has ever executed —
surfaced the identical defect class fourteen more times, one of them a
live crash: changing the asset type on the offer-creation form flips a
branch that sits above two hooks, so an ordinary dropdown change takes
the page down. That is filed separately with the reproduction, along
with the rest of that surface's backlog; it is not fixed here, because
a plumbing change is the wrong vehicle for a fix to a different app.
