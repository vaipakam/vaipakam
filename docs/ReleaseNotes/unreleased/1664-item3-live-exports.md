# The published documents now carry the same numbers as the pages

The site publishes plain-text copies of its documentation for automated
readers — search crawlers and AI assistants. Until now those copies were
filled in with the fee rates and tier figures **compiled into the build**,
while the pages a person reads fetch the live published configuration. As
long as nobody changes a rate the two agree, so the gap was invisible.

The first governance retune would have made it visible in an awkward way.
The rendered page would show the new rate. The published copy of the same
document would show the old one — not just until the next deploy, but
**indefinitely**, because those files are written from values frozen at
compile time and a rebuild would write the same frozen values again. An
assistant answering questions from them would have been confidently,
permanently wrong.

They are now written from the same published configuration the pages
read, using the same freshness and decoding rules rather than a second
implementation of them.

## Refusing beats guessing

If the configuration cannot be read, the publication step **stops** rather
than falling back to the compiled figures. That is the opposite of how the
pages behave, and deliberately so: a page retries on every visit and tells
the reader what it is showing, while a published file is served untouched
until the next deploy and can do neither. Silently shipping frozen numbers
is exactly the failure this change exists to remove, so it is not
available as a fallback.

An operator who genuinely wants to publish without a live read can say so
explicitly. When they do, the published index states on its own face that
the figures are build-time defaults and will not follow a retune — so a
reader of the file learns it, not just whoever ran the build.

When the read succeeds, the index records **which deployment** the figures
came from and **when** the snapshot was stamped. "Current as of this build"
is only worth saying if it comes with the moment attached.

## A specified position, reversed on purpose

The specification previously ruled this out, and gave reasons: reading at
publication time moves staleness from release to publication, makes
publishing depend on a service that can be down, and lets two publications
of the same source produce different files.

Those reasons still hold, and the owner's decision was that the
alternative is worse — an artefact one deploy behind beats one that never
moves and drifts without limit from the pages beside it. The dependency
concern is answered by refusing rather than guessing. The third is no
longer counted as a fault: after a retune, two publications of the same
source *should* differ, because the thing they describe did.

The old rule and its reasoning are kept in the specification rather than
deleted, so the trade-off does not have to be rediscovered by whoever
revisits it next.
