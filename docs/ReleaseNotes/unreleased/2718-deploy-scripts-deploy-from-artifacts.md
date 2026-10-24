## Thread — Deploy scripts create facets from their built artifacts (PR #<n>)

The Diamond build and refresh scripts (the fresh deploy, the all-facets
refresh, the curated refreshes, the oracle upgrade, the risk-terms migration
and the slippage census) now create every facet, the Diamond itself and the
two cross-chain implementations the refresh replaces from the creation code
Foundry already wrote for them, instead of compiling that code into the
script. What goes on chain does not change: the same code, from the same
sender, at the same address, broadcast as the same contract-creation
transaction with the contract's name attached for verification.

The reason is build cost. Compiling every facet into the deploy script also
compiled it into each deploy-sanity test and probe that builds or inherits
the script, and the compiler optimized all of it again for each one. One
suite and its probe took nearly eight minutes of compiler time on a warm
cache, and the deploy-sanity step of the per-PR contracts job had grown to
about an hour. Each facet is now compiled once per build. The artifact stays
current because each script names the facet through its type, which only
compiles when the script imports the facet's source, so a changed facet is
rebuilt before the script or test runs.

The shared test setup and the individual test suites still compile their
facets in; moving them onto the same helper is #2789. Closes #2718.
