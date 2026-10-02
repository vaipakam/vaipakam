## Thread — VPFI credit on a transferred live position: decided, not deferred (PR #2362)

When a loan closes and what one side is owed waits in the original party's vault for a different position holder, #2342 keeps that VPFI out of the original party's credit. Live loans were left out, and the functional spec described that as an open product decision. This change records the decision: the rule stays limited to closed loans.

While a loan is live, VPFI held for a transferred position keeps counting toward the original party until the position is consolidated to its holder. That covers both the fee-discount tier and the staking-reward weight, since both read the same balance. No behaviour changes. The spec, the library comment and a design-doc note now state this as intended, with the reasons and the limits.

The decision follows rules the code had already settled for neighbouring cases rather than adding a new one:

- **The holder usually controls the window.** In the ordinary case the current holder can consolidate their own position on a live loan at any time. Consolidation moves the funds, and the credit moves with them.
- **The stored party is not fixed.** On a live loan, consolidation and a sale both move the funds. An exclusion charged to the original party would go stale and leave a permanent over-exclusion on a vault that no longer holds the funds. That is the same reason an earlier active-loan counter for parked lender shares was dropped.
- **The funds stay locked.** The original party cannot spend any of it meanwhile, because the funds stay reserved against their spend paths. Only the credit lingers.
- **Sanctions are not a trigger.** Sanctions status is not used to switch the exclusion on, because it changes in the external oracle with no on-chain event the platform could react to. The closed-loan rule takes the same stance.

The holder cannot shorten the window whenever consolidation is refused:

- the holder is sanctioned;
- the loan is waiting in the fallback state after a failed default swap;
- the loan is an NFT rental;
- the borrower position is bound to a collateral-sale listing or a swap-to-repay intent commitment;
- on the lender side, VPFI held for the lender is not fully reserved in VPFI.

None of these has a fixed end date. A loan past its term and grace period only becomes eligible to be defaulted, and it closes when someone submits that default and it succeeds. From then on the closed-loan exclusion applies.

Closes #2357.
