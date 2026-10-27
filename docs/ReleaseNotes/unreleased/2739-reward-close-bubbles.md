## Thread — Terminal reward closes can no longer be skipped (PR #<n>)

Every way a loan ends closes its interaction-reward entries, and that close
decides whether the borrower keeps the reward or forfeits it. Five facets ran
their reward calls through a private best-effort hook that ignored any
failure: direct preclose and offset completion, the periodic-interest
settlement, both prepay-sale finalisations, the claim-time default of a
fallback-pending loan, and the three internal-match liquidation legs. The
reward-window split at an obligation transfer (not a terminal, but the same
hook) went through it too. A caller
could arrange for the close to run out of gas (the 63/64 rule), let the hook
swallow it, and finish a late preclose with the borrower's reward entry still
open. An open entry on a repaid loan reads as claimable, so the reward the
close should have forfeited stayed payable.

The hooks are gone. Each of those calls now goes through the same bubbling
cross-facet call every other terminal path already used, so a failed reward
close reverts the whole transaction, carrying the close's own revert reason
(or `RewardHookCallFailed` when it gave none). A loan can no longer reach a
closed status with its reward entries open. The early-withdrawal facets
already bubbled and are unchanged. The cost is a few bytes per facet;
PrecloseFacet keeps 533 bytes of EIP-170 headroom.

Closes #2739.
