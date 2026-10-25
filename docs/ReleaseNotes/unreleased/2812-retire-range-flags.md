## Thread — Retire the dead range flags (PR #<n>)

Ranged offers are now always on, and the three flags that claimed to switch
them off are gone. The two range master flags (one for ranged amounts, one for
ranged rates) and the borrower-side collateral range flag had not been read by
any contract path for some time: an offer's range was accepted or refused by
its own bounds, never by these flags. They still had admin setters, getters and
configuration events, so an operator could "turn ranges off" and nothing would
happen. The owner decided on 2026-10-25 to remove them rather than leave a
switch that does nothing.

Their setters, their getters and the three-flag status read are removed from
the configuration facet, and the protocol configuration bundle no longer
carries the two range fields. The storage slots stay where they are, marked
retired, so the layout is unchanged. The matching kill-switch (partial fill)
stays: while it is off the order matchers refuse and an accepted offer fills
once, and while it is on a ranged offer can be filled across several matches.
The deploy scripts now turn on only that switch. A curated in-place refresh
removes the six retired entry points from a Diamond that still routes them, so
the old build cannot keep answering for them.

This reaches a chain with the next fresh deploy. Until then the live testnets
still run the old configuration facet, whose bundle carries the two retired
fields. The app, indexer and e2e tooling move with this change (they read the
matching switch from its own getter). Refs #2812.
