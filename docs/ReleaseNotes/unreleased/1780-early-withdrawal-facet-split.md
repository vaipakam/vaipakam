## Lender early-withdrawal is split into two facets so either route can be fixed again

The lender's two ways out of a live loan — selling the position straight into a
standing lender offer in one transaction, or listing it and waiting for a buyer
— lived in one on-chain component. That component had reached thirty bytes of
room under the hard per-component size limit the chain enforces. Thirty bytes is
less than the cost of a single call from one component to another, which is the
shape almost every pending fix to these routes takes. In practice the routes had
become unfixable: three queued corrections had all been measured, and each one
on its own was too large to deploy.

The two routes are now separate components. Nothing about either route's
behaviour changes, and nothing about how they are called changes — the platform
still presents one address, the same state is shared, and a caller cannot tell
the difference. What changes is that each route now has thousands of bytes of
room instead of thirty, so the queued corrections can actually ship.

The seam runs between the two routes rather than through either of them, for two
reasons. The routes are separate choices a lender makes, with no shared
internals: each one's helpers are used only by it. And the listed route's own two
halves — putting a position up for sale, and completing the sale once a buyer
takes it — are the opposite case: they share the listing's binding, its
one-at-a-time rule, and its relist cooldown, so they are only correct when read
together. Splitting between those two would have freed more space and been the
wrong cut, turning a rule that can be checked in one place into one that spans
two.

This is the second time a component has been split for this reason. Rather than
record it as a one-off the way the first one was, the specification now states
the rule that governs where such a seam goes — follow a boundary the product
already has, and never separate two halves that share an invariant — so the next
one is a decision with a written basis rather than a judgement call made under
deadline.

Three error conditions that both routes can raise moved to the shared error
definitions both components inherit, so the split did not duplicate them. That is
what those shared definitions exist for, and a duplicated error is the kind of
thing that drifts apart silently. The visible cost is that every component
inherits those definitions, so the machine-readable interface files the apps
read all pick up three new entries — a wide but entirely mechanical change,
worth flagging so a reviewer seeing forty-odd touched files knows what they
are.

One consequence to expect rather than puzzle over. Moving those three shared
error definitions means every component's machine-readable interface picks them
up, and two of the four components the public reference keeper bot reads are
among them. That bot lives in its own repository on its own release cadence, so
its committed copies now differ from freshly compiled ones and the pre-deploy
gate will say so. It is advisory by design, not a blocker, and nothing about the
bot's behaviour changes: the functions it calls are untouched, and the three
errors are lender-sale conditions it never triggers. Worth a re-sync next time
that repository is touched; not worth holding a deploy for.

One operational note for redeployments: the two components must be refreshed
together. They were one component, so refreshing only the listed route would
leave the direct route running the code from before the split while everything
around it moved on — the same half-applied-family hazard the redeployment script
already documents for other paired components. The script now carries both.
