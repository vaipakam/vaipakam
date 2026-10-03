## Thread — Base Sepolia refreshed to current main; #2355's refinance fix is live there (PR #<n>)

The Base Sepolia Diamond now runs current main (`f8176ea06`). Its last refresh was in mid-September. Every facet was replaced in place, and the vault template, the reward custody holder and the proxy implementations were updated with them. The Diamond address did not change. The deployment record for Base Sepolia, and the consolidated copy the apps and workers read, now describe the live Diamond.

The refresh was needed for #2355's contract half: a lender can now accept a borrower's refinance request directly even while automatic matching is switched off. #2355 changed four facets and a library shared between them, so replacing the refinance facet alone would have left the Diamond running mixed versions of that shared code. The live bytecode of every facet #2355 touched now matches main exactly.

The refresh ran as the documented two-run rollout. Base Sepolia was paused from 14:41 to 15:15 UTC on 2026-10-03:
- The first run replaced the facets and backfilled the chain's reward role (canonical).
- The second run, under a pause the new code counts, performed the one-time rebase of the fresh-reward paid counter. It was rebased to zero, on the operator's declaration that this chain has no fresh-reward payout history; the counters read zero under that pause.
- The full pre-deploy regression ran first. It found 18 test-harness failures, fixed separately with no contract change.
- Before the refresh, the stored-data layout was checked: it has only grown at the end since the last refresh, so existing records read the same.

Three things are stated rather than implied:
- **Reward claims and remittances are refused on Base Sepolia until the separate reward-custody activation ceremony runs.** On the canonical chain the new code allows only what custody has received, which is nothing until it is funded. This is a consequence of shipping main, not of #2355, and the ceremony needs its own operator answers.
- Selectors retired from the code over time are never removed by an in-place refresh, so eleven of them still route to old implementations (tracked in #2313). Every current function routes to the new code.
- The first attempt stopped mid-broadcast on a transient RPC error, after the pause and some implementation deployments but before any facet change. It rewrote the deployment record with addresses that were never put into service. The record was restored before the rerun, and the gap is tracked in #2377.
