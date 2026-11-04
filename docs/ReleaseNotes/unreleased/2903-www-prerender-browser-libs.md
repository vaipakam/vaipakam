## Thread — www deploys prerender again on Workers Builds (PR #3130)

The automatic marketing-site deploy was red. The earlier cause (the config
gate could not read the live bundle) went away with the all-waves refresh,
and the deploy then stopped at the prerender step. Workers Builds runs an
Ubuntu image without the shared libraries Chromium needs, so the browser
Playwright downloads could not start. Until 2026-11-02 the dashboard deploy
command skipped prerendering altogether, so this was the first time the
step had run there.

The prerender step now asks the dynamic loader which libraries the browser
is missing. It maps each one to the Ubuntu package that ships it, fetches
those packages with the host's own apt into a private folder (no root, no
system files written), and launches the browser with that folder on its
library path. Each step is announced in the build log. A library with no
known package, a host without apt, or a library still missing afterwards
fails the deploy and names what is wrong.

The launcher also stops hiding its own failures. It used to report only
its first error, so the Workers build said the browser "doesn't exist"
right after installing it. It now lists every attempt and why each failed.

Closes #2903.

> Caveat: the library-to-package table is measured against Ubuntu 24.04 and Chromium 149. A Playwright upgrade that needs a new library fails the deploy by name until the table is extended.
