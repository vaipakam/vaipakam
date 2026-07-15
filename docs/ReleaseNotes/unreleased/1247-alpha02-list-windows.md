## Thread — alpha02 list windows: every big list renders a page at a time (PR #TBD)

The #1247 pagination audit found two kinds of gap on the app side:
several surfaces rendered every row their capped fetch returned — up
to 500–2,000 row components on one navigation for a busy wallet or
market, each mounting its own token-metadata (and sometimes health or
claimability) reads — and two client reads had no data-layer ceiling
at all (the Claims position walk and the Rate Desk pair-book
hydration). This change applies the Activity feed's proven
window pattern everywhere: render the first twenty-five rows and a
"Show N more" button that grows the window a page at a time, so the
screen and the per-row reads scale with what the user asks to see.

Windowed surfaces: My positions (open offers plus the live and ended
loan groups — the needs-your-attention group deliberately stays whole,
since a hidden row there would be a hidden payout), the Offer Book
(whose per-row security screening now also grows with the window
instead of screening all fetched rows up front), the Claims list, NFT
rental listings, and the Rate Desk's open-orders and positions tabs.
The standing-approvals card is windowed one level deeper: its
per-token allowance lookups happen inside the fetch, so the window
bounds which tokens are checked, and "Check N more tokens" widens the
scan itself.

Two data-layer guards ride along: the Claims page's on-chain
position walk gains the same fail-loud two-thousand-position ceiling
the positions pages already had (it previously walked without limit),
and the Rate Desk order book's chain-first read now refuses to
hydrate a pair bucket past six hundred offers, failing over to the
market-scoped, capped indexer copy instead — so a spammed pair
degrades honestly rather than fetching without bound. The remaining
indexer-side caps from the audit (PAG-007/009/010/011) land in a
separate indexer PR.

Refs #1247.
