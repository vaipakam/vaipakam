## Thread — Deploy verify exact-matches a recorded facet count (PR #70)

The post-deploy `verify` phase in the deploy shell scripts used to
sanity-check the diamond by asserting it carried *at least* 32 facets —
a hardcoded floor with a `>=` comparison. That check was both stale and
too loose: the diamond's facet set had since grown past 32 (the #66
`RiskFacet` split alone added one), so the literal was already wrong,
and a `>=` floor would silently pass a deploy that cut *too many* facets
or, after the floor drifted further out of date, one that cut too few.
A whole missing facet could slip through.

PR #70 makes the facet count a single source of truth. `DeployDiamond`
now records the authoritative count — the length of the cut list it
actually applied — into the per-chain `addresses.json` artifact, written
alongside the other deployment addresses after the broadcast completes
(never mid-deploy, so a revert in a later initialization step cannot
leave a facet count that disagrees with the recorded diamond and facet
addresses). The three deploy scripts — `deploy-chain.sh`,
`deploy-testnet.sh`, `deploy-mainnet.sh` — read that recorded value and
require the live `DiamondLoupe` count to match it *exactly*, failing the
verify step on any mismatch in either direction. No hardcoded facet
count remains in the shell scripts to drift.

A follow-up review also cleared two stale "32 facets" references that
the change had made wrong — explanatory comments in `DeployDiamond` and
the `verify`-row wording in the deployment runbook — so the deploy
tooling no longer states a count that contradicts the code.

This closes the gap left by the `.facetCount` check's predecessor: it
catches a missing whole *facet*. Catching a facet that is present but
missing some of its *selectors* is tracked separately (Issue #71).

Closes #69.
