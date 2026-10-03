# Release Notes — 2026-10-02

Two related changes about VPFI held for the current holder of a transferred
position. The first records a product decision and changes nothing the
platform does: while a loan is live, that VPFI keeps counting toward the
recorded party's fee-discount tier until the funds are re-anchored. The
second is a contract fix to the usual way funds get re-anchored. It lets a
lender holder consolidate a position whose held VPFI is fully reserved
through the dedicated sanctioned-holder ledger. Previously that position
was refused for good.

## Thread — VPFI fee-tier credit on a transferred live position: decided, not deferred (PR #2362)

When a loan closes and one side's payout waits in the vault of the party the loan currently records for that side (the "recorded party": whoever opened the position, or the wallet it was last consolidated or re-anchored to) for a different position holder, #2342 keeps that VPFI out of the recorded party's fee-discount tier. Live loans were left out, and the functional spec called that an open product decision. This change records the decision: the rule stays limited to closed loans. While a loan is live, VPFI held for a transferred position keeps counting toward the recorded party's fee-discount tier until the funds are re-anchored to the position's holder. Consolidation is the general way that happens, and some position sales re-anchor directly to the buyer. Nothing in the platform's behaviour changes. The spec, the library comment and a design-doc note now state the decision, with the reasons and the limits.

The decision follows rules the code had already settled for neighbouring cases. Three reasons support it:

- **The recorded party can change.** On a live loan, consolidation and a sale both move the funds. An exclusion charged to the recorded party would go stale and leave a permanent over-exclusion on a vault that no longer holds the funds. The same reason led to dropping an earlier active-loan counter for parked lender shares.
- **The recorded party cannot spend reserved funds.** The pledged collateral and any parked lender share stay reserved against the recorded party's spend paths, so for those funds only the fee-tier credit lingers. The stated exception is a VPFI amount held for the lender that is not fully reserved. The platform refuses to consolidate such a position for that reason, and the unreserved part is open in #2365.
- **Sanctions are not a trigger.** Sanctions status changes in the external oracle with no on-chain event the platform could react to. The closed-loan rule takes the same stance.

The window has no guaranteed end. A holder can often consolidate their own position, but not always: not while the holder is sanctioned, not while the protocol is paused, and not while the loan is in a state where consolidation is refused. The spec gives these as examples only; the platform's consolidation rules decide. A loan past its term and grace period only becomes eligible to be defaulted, and from the moment a close-out actually executes, the closed-loan exclusion applies.

Closes #2357.
<!-- assembled-fragment: 2357-live-loan-tier-credit-decision.md sha256=f61545bdbe6306b3abcbe86b59e38e348ab9759fa88894cd68369618ca5b2203 -->

## Thread — A fully reserved held VPFI amount no longer blocks a lender holder from consolidating (PR #2367)

Consolidation moves a transferred lender position onto its current holder, and the VPFI held for that position moves with it. The platform refuses to consolidate while part of that held VPFI is unreserved, because the unreserved part would become a balance the holder could withdraw before claiming.

A held amount can be reserved in one of two places. Preclose, offset and partial-match accruals use one. A lender share parked for a sanctioned holder while the loan is live uses a dedicated one. The consolidation check read only the first, so it treated a share reserved in the second place as unreserved. A holder who had been delisted could therefore never consolidate that position. Their funds stayed in the departed lender's vault, and so did the fee-tier credit on them.

The check now counts both places. It uses the same reader the closed-loan fee-tier rule uses, so the two rules cannot disagree about what is reserved. A partially reserved amount is still refused, exactly as before.

The investigation also answered #2365. On the current code, every path that adds VPFI to a held amount reserves it in full, so a departed lender cannot spend VPFI held for a holder. The only exposure would be a balance that accrued before held-for-lender reservation was introduced and that still sits on a live loan of an older deployment.

The functional spec's held-for-lender paragraph previously said the reservation was "handled separately". It now states the rule: accruals are reserved in full when they land, the reservation moves with the funds on every lender change, and only an unreserved remainder blocks consolidation.

Closes #2364. Closes #2365.
<!-- assembled-fragment: 2364-consolidation-counts-both-reservations.md sha256=d71dc2255e3aa075c7b2cb1cd00ceb044109ef03c766c9852d6940b1ab6efe10 -->
