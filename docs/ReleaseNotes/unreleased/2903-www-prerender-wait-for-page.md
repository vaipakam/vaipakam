## Thread — www prerender waits for each page to declare itself (PR #<n>)

With the browser libraries in place, the first real Workers Builds run
of the prerender step snapshotted 118 of 120 pages. The two translated
advanced guides failed the indexing check with no canonical link at all.
The step waited a fixed tenth of a second after the site shell mounted,
but the shell mounts before a lazily loaded page renders. The guides are
the heaviest pages, and on a slow build machine they had not rendered in
that time. Pinned to one CPU locally, the old wait failed 11 of 120 pages.

The step now waits until the page writes its own canonical link, which
every route declares and the shell never carries. Then it reads the page.
A page that never declares one fails by name after 30 seconds. On one
CPU, every page now snapshots.

Advances #2903.
