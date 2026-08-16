## The marketing site gets a committed post-deploy drive, and the reason it cannot be run everywhere is now on record

Changes to a published surface are supposed to be checked on the live site after
they deploy — not on a preview, and not only through the automated checks that
run before a merge. Until now the marketing site had no committed way to do
that: whoever performed the check wrote the steps themselves and threw them away
afterwards, so the next person began again from nothing.

The drive for the recently changed worked example is now committed alongside the
site, with a short guide covering how to run one and what belongs in a new one.
Nothing about the site changes; this is the checking, not the thing checked.

### Why an automated pre-merge check is not enough here

The figures in that passage are only correct once the deployed page has fetched
the published configuration from a deployed service. Everything that runs before
a merge — the build, the guards, an inspection of what actually shipped — can
pass while the rendered page shows something different, because none of them
involve the live fetch. That is the gap the live check exists to close, and
closing it needs a real browser pointed at the real site.

The pre-merge guards stay exactly as they are. They cover the half that can be
checked early, and they remain the first thing to fail when something is wrong.

### A check that survives a rate change

The drive asks the search for whatever figure the page actually printed, rather
than a figure written into the check itself. The property being tested is that
the page and the search agree — pinning the expected number would quietly turn
that into a test of one moment's configuration, and it would start failing for
the wrong reason after any legitimate rate change.

Where an exact value genuinely is the point, the check is skipped rather than
failed when the live rates differ from the ones shipped with the site, and the
live rates are printed so a skip can be read rather than guessed at.

### One thing it cannot currently do

The drive cannot be run from the automated agent environment at all: the browser
there is unable to reach the internet through that environment's network policy,
although ordinary command-line requests to the same address succeed. The
underlying problem is recorded separately.

This matters more than a tooling inconvenience. It means a change to a published
surface can be reviewed, merged, deployed and confirmed present in what shipped,
and still not have been looked at in the way the process asks for. The honest
report in that situation is that the live check did not happen — not a
substitute check described as though it had.
