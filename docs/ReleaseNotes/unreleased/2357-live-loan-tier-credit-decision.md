## Thread — VPFI fee-tier credit on a transferred live position: decided, not deferred (PR #2362)

When a loan closes and one side's payout waits in the original party's vault for a different position holder, #2342 keeps that VPFI out of the original party's fee-discount tier. Live loans were left out, and the functional spec called that an open product decision. This change records the decision: the rule stays limited to closed loans. While a loan is live, VPFI held for a transferred position keeps counting toward the original party's fee-discount tier until the funds are re-anchored to the position's holder. Consolidation is the general way that happens, and some position sales re-anchor directly to the buyer. Nothing in the platform's behaviour changes. The spec, the library comment and a design-doc note now state the decision, with the reasons and the limits.

The decision follows rules the code had already settled for neighbouring cases. Three reasons support it:

- **The original party can change.** On a live loan, consolidation and a sale both move the funds. An exclusion charged to the original party would go stale and leave a permanent over-exclusion on a vault that no longer holds the funds. The same reason led to dropping an earlier active-loan counter for parked lender shares.
- **The original party cannot spend the VPFI.** The funds stay reserved against their spend paths, so only the fee-tier credit lingers.
- **Sanctions are not a trigger.** Sanctions status changes in the external oracle with no on-chain event the platform could react to. The closed-loan rule takes the same stance.

The window has no guaranteed end. A holder can often consolidate their own position, but not always: not while the holder is sanctioned, not while the protocol is paused, and not while the loan is in a state where consolidation is refused. The spec gives these as examples only; the platform's consolidation rules decide. A loan past its term and grace period only becomes eligible to be defaulted, and from the moment a close-out actually executes, the closed-loan exclusion applies.

Closes #2357.
