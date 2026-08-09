### The fee figures on the public pages now follow the protocol, not the release

The documentation quotes several governance-tunable figures — the fee on lender
interest, the loan initiation fee, the VPFI discount tiers and their thresholds.
Each is written once and referenced from every sentence and every translation
that mentions it, so there is one place to change rather than seventy.

On the public site that reference had nowhere to resolve to. It fell back to the
value shipped with the build, which meant the figures were only ever as current
as the last deploy: after a governance change the pages would keep stating the
old rate until someone remembered to edit it. That is exactly the drift that had
just been cleaned up across the overview pages and both user guides.

They now resolve against the protocol's published configuration. A change to a
fee reaches the public documentation on its own, in every language, without a
release.

### Without giving the marketing site a wallet or a chain client

The site has no wallet connection and no contract code in it, and that is worth
keeping — it is the surface a stranger loads first, and it should stay light. So
the figures are read from the configuration the platform already publishes for
this purpose, the same source the connected app consults first for the numbers it
displays. One small request, no contract interfaces added to the page.

The trade is honest and worth stating: this follows a governance change within
roughly the time it takes to be observed and published, rather than being read
from the chain at the instant you load the page. For a fee rate on a
documentation page that is the right granularity.

### And the tooltip no longer reports a failure that never happened

Hovering one of these figures used to say the value was a compile-time default
because a chain read was "pending or unavailable" — on pages where no read was
ever attempted. A reader curious enough to hover was told something was broken
about a page working exactly as designed.

The tooltip now says where the number actually came from, and the two cases are
genuinely different: a figure that tracks the published configuration, or the one
shipped with this page when that configuration could not be reached. The second
still happens — during a redeploy, or if a published figure is too old to trust —
and a page always renders either way, because a documentation page that fails to
show a number is worse than one showing a slightly older one.

The machine-readable copies of the docs keep resolving their figures at build
time. A static file has no runtime and cannot follow a change; leaving the
reference unresolved to signal that would just serve a crawler a placeholder
instead of a number.
