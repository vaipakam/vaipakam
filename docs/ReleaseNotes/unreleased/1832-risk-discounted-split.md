## Thread — The discounted liquidation route moves to its own facet (PR #<n>)

The discounted liquidation route (the liquidator pays the loan's whole debt
and receives the collateral at a per-tier discount, usually inside a flash
loan) has moved out of the risk facet into a facet of its own, the
discounted-liquidation facet. The risk facet was 45 bytes under the
24,576-byte contract size limit, and the queued lifetime-counters change (#1832) would have pushed it
over, which would have made every later change to it undeployable. The
discounted route was already a self-contained entry point, so it moved whole
rather than having unrelated code trimmed to fit, the same way the split-route
and internal-match liquidations were carved out before.

There is no behaviour change. The entry point keeps its exact function
signature, so its selector is unchanged and every caller that reaches it
through the Diamond (the flash-loan liquidator contract, the keeper, external
liquidators) is unaffected. Its checks, the figures it charges and seizes, the
claims it records, the loan's transition to Defaulted and its event are the
same; the event and its errors were moved with it unchanged, so their topic
and selectors are unchanged too. It still reads the health factor, the eager
consolidation and the collateral lien through the same Diamond hosts as
before.

The two facets carry one behaviour and must be refreshed together. The deploy
and the all-facets refresh carry both; the curated liquidation refresh now
carries the new facet too, moving the route's already-routed selector onto it
in the same cut as the risk facet. Refreshing the risk facet alone would leave
the discounted route on the previous risk-facet build.

The connected app, the indexer and the keeper read the combined Diamond ABI,
which now names the route under its new facet. The risk facet's own ABI no
longer lists the discounted route, its event or its four route-only errors.

No functional specification changes: this is a structural move, and what the
platform is meant to do is unchanged.
