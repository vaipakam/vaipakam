## The marketing site gets a committed post-deploy drive, and the reason it cannot be run everywhere is now on record

Changes to a published surface are supposed to be checked on the live site after
they deploy — not on a preview, and not only through the automated checks that
run before a merge. Until now the marketing site had no committed way to do
that: whoever performed the check wrote the steps themselves and threw them away
afterwards, so the next person began again from nothing.

The drive for the recently changed worked example is now committed alongside the
site, with a short guide covering how to run one and what belongs in a new one.
The site changes in one small, deliberate way to support it — each page now
carries a machine-readable marker stating whether it accepted the published
configuration, described below — and in no other; what the pages display is
untouched.

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
live rates are printed so a skip can be read rather than guessed at. Skipped
checks are counted in the closing tally too, so a partly-run check cannot
report itself as a complete pass.

### Why a fallback reading must not count as success

Each figure on these pages has a value bundled with the site, kept deliberately
in step with the protocol's own settings, for the moments when the published
configuration cannot be reached. That makes a page served entirely from
fallbacks look right — every number on it is correct — and distinguishable only
by the marker each figure carries saying where it came from.

That is exactly what a failed fetch produces. A check that accepts it would
report success without ever having seen the published configuration it exists to
confirm, so on the live site the drive now insists the figures be published ones,
and only relaxes that when deliberately pointed somewhere without a
configuration service behind it.

Establishing this for every page the drive visits needed one small change to
the site itself: each page now states, in a machine-readable marker, whether it
accepted a published configuration or fell back to its bundled values — the
same conclusion the page already reaches internally, exposed rather than
guessed at. Review showed why nothing less suffices: two successive attempts to
infer it from the outside each re-implemented part of the page's own acceptance
rules and each got a case wrong. The page knows; the check now asks it.

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
