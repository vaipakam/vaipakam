## Hovering a fee figure on the public site no longer says something is broken

The documentation quotes protocol parameters — the treasury fee, the loan
initiation fee, the VPFI hold tiers and their discounts — and each of those
figures carries a hover explaining where the number came from. On the public
marketing pages every one of them said the same thing: that the figure was a
fallback, and that a reading from the chain was pending or unavailable.

That described a failure that cannot happen there. The marketing site is
deliberately wallet-free and makes no chain reading at all, by design. So
nothing was pending, nothing was unavailable, and the number the reader was
looking at was the correct one. A reader curious enough to hover a fee — the
reader most worth keeping — was told the mechanism behind it was broken, and
invited to refresh and wait for a figure that would never change.

The hover now names the source the page actually has: a published value,
bundled into the site at release. The two other cases stay distinct, because
they are genuinely different things to tell a reader — a figure that came
from the chain, and a reading that was attempted and has not answered yet.
Which one applies is now something each surface declares about itself,
rather than something guessed at from an empty result, so a surface that
makes no reading can no longer be mistaken for one whose reading failed.

**The second half: keeping the published figures true.** Because these
numbers are fixed at release, nothing tied them to the protocol's own
definitions — they were correct only because whoever last changed a fee
remembered to change them here too. That has already gone wrong once: an
earlier fee retune left the sentences quoting it stale in several languages,
which is why these figures were collected into one place to begin with.
Collecting them fixed the many-copies problem, but a single copy can still
go quietly out of date.

Publication now fails if any published figure disagrees with the protocol
constant it claims to mirror. It compares against the protocol's own source
rather than a live deployment, deliberately: there is no production
deployment yet, the only readable one is a test network whose values are
changed for testing, and gating published wording on it would fail releases
for reasons that say nothing about what the protocol ships. The check also
fails — rather than passing quietly — when it cannot find the parameter it
is comparing against, because a check that silently compares nothing reports
success.

What this does not cover, stated plainly rather than implied: a parameter
changed by governance on a running deployment can still drift from the
published figure. Closing that needs either live readings on the marketing
site or a monitor watching a deployment, and both are decisions worth making
once there is a deployment worth watching.
