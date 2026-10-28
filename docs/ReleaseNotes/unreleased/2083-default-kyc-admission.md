## Thread — Time-based default: lender KYC check, its value and a view (PR #<n>)

The time-based default keeps its check of the lender's KYC tier. KYC is off on the retail deploy, so the check never blocks a retail default, but the code keeps it for a fork that turns KYC on. That is the owner's decision. The spec now states it: the default checks the loan's lender, never the caller who triggers it.

The check now values the loan the way the KYC thresholds say to: the liquid principal plus the liquid collateral as it stands at the default, through the same helper every other KYC comparison uses. Before, it counted the principal alone, so with enforcement on, a lender whose tier covered only the principal could pass. An NFT rental is valued at its rent, the daily rate times the duration, as before.

A new view, `defaultKycAdmission`, tells an app before anyone signs whether a default would pass this check. It gives the same answer as the default, and the same revert data when it would refuse. The app thread asked for it so the connected app can name this reason instead of a generic failure.

Part of #2083. The accept path values an NFT rental at zero for KYC, because a rental has no collateral; that is tracked separately in #3044.

> Caveat: nothing changes on any current deployment, since KYC enforcement is off everywhere.
