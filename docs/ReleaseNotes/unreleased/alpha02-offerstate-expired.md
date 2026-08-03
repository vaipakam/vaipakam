## Connected app — expired offers render as expired instead of vanishing (PR #1517)

The lender-sale listing release taught the contracts to report an
offer's expiry as a first-class lifecycle state. The connected app's
chain-hydrated views (used whenever the indexer is unavailable or
behind) still knew only the four older states and treated the new one
as "unrepresentable", silently dropping the row — an expired offer
disappeared from lists instead of showing as expired. The app now maps
the new state directly to its existing "expired" presentation, which
the indexer-backed path already used. The fork-tier test harness had
the same gap in its stand-in indexer and failed loudly (a 500 emptied
the whole book on every list-driven scenario); it now maps the state
the same way.
