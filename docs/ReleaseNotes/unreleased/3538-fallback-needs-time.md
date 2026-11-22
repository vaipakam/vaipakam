## Thread — One failing swap list can no longer push a loan into in-kind custody (branch, no PR yet)

Health-factor liquidations and time-based defaults can be started by anyone, and the caller writes the list of swap routes to try. An empty list was already refused, but a single route given broken data on purpose still counted as a real attempt. When it failed, the loan went straight into the in-kind fallback, even though the market could have sold the collateral. The lender lost a sale at market price, and the borrower's surplus stayed unsold.

Now a forced sale whose listed routes all fail moves the loan into the fallback only if an earlier failed sale of the same loan, from any caller, is at least 10 minutes old. Before that, the failed sale is undone. No collateral leaves the borrower's vault, the loan stays active, and the protocol records the failure. It also announces the earliest time a failed sale would open the fallback. During that window anyone with a working route can liquidate at market. A record whose last failure is more than a day old is ignored, so a loan that recovered and later becomes liquidatable again starts afresh.

A new view gives the app and the keeper the loan's standing: how many failed sales are recorded, when the first one happened, and when the fallback opens. Other refusals of a sale, such as a quote out of range, revert exactly as before and record nothing. Periodic-interest sales and split-route liquidations are unchanged, because neither ever enters the fallback.

Design: `docs/DesignsAndPlans/FallbackEntryGateDesign.md`. The liquidation spec states the rule. Advances #3538.
