## Thread — Fee-tier credit on a transferred live position: decided, not deferred (PR #TBD)

When a loan closes and what one side is owed waits in the original party's vault for a different position holder, #2342 keeps that VPFI out of the original party's fee-discount tier. Live loans were left out, and the functional spec described that as an open product decision. This change records the decision: the rule stays limited to closed loans. While a loan is live, VPFI held for a transferred position keeps counting toward the original party's tier until the position is consolidated to its holder. No behaviour changes; the spec, the library comment and a design-doc note now state this as intended, with the reasons.

The decision follows rules the code had already settled for neighbouring cases rather than adding a new one.

- **The holder controls the window.** The current holder can consolidate their own position on a live loan at any time. That moves the funds, and the credit with them.
- **Stored party is not fixed.** On a live loan, consolidation and a sale both move the funds. An exclusion charged to the original party would go stale and leave a permanent over-exclusion on a vault that no longer holds them. This is the same reason an earlier active-loan counter for parked lender shares was dropped.
- **Funds stay locked.** The original party cannot spend any of it meanwhile, because the funds stay reserved against their spend paths. Only fee-tier credit lingers.
- **Sanctions are not a trigger.** Sanctions status is not used to switch the exclusion on, because it changes in the external oracle with no on-chain event the platform could react to. The closed-loan rule takes the same stance.

The one case the holder cannot shorten is a sanctioned holder, who is refused consolidation. It lasts until the loan closes, at the latest when its term and grace period run out, and from then on the closed-loan exclusion applies.

Closes #2357.
