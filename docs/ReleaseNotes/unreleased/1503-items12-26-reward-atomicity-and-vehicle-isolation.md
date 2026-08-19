## A sold position now always carries its reward migration, and the sale's internal bookkeeping loan stops showing up in your history (PR #TBD)

Two independent defects on the lender position-sale routes, both about a sale
leaving traces it shouldn't — or failing to leave one it promised.

### The reward migration is now part of the sale, not a side effect

Every sale quote tells the seller, as a priced cost line, that they forfeit
the platform-interaction rewards accrued on the position, and tells the buyer
they receive a fresh entry covering the rest of the loan's window. Underneath,
that migration was performed on a best-effort basis: if it failed, the sale
settled anyway. The seller kept a reward entry on a position they no longer
own, the buyer received none, and nobody was told — the transaction succeeded
and reported nothing wrong.

A disclosure the protocol does not keep is worse than one it never made, and
this one is quoted at the moment of decision. Both sale routes — selling
instantly into a standing bid, and the completion of a posted listing — now
treat the reward migration as part of the settlement. If it cannot be
performed, the whole sale is refused and the reason is reported, rather than
settling on terms different from the ones quoted.

In normal operation nothing changes: the migration is simple bookkeeping that
cannot fail, and it does nothing at all before the rewards programme launches.
The failure this makes visible is a misconfigured deployment where the reward
component isn't reachable — precisely the case that must not be allowed to
settle sales quietly on the wrong terms.

### The sale's internal bookkeeping loan is no longer visible anywhere

Completing a listed sale forges a short-lived internal loan record to carry the
lender relationship from the moment a buyer accepts to the moment the sale
settles — usually the same transaction. It is not a real position: no
collateral, no borrower obligation, and it ends within the flow that created
it. The product has always described it as invisible.

It was not. That record was counted into the platform's active-loan and
lifetime-loan statistics, added to the interest-rate averages, appended to both
parties' permanent loan history, placed in the list keepers walk, and announced
to interfaces as a newly created loan. Users saw a loan appear in their history
that they never took out; the protocol's own totals counted positions that were
never real, permanently.

The internal record is now excluded at every one of those points, and — as the
matching half — its close-out no longer removes what it never added, nor
announces the end of something no interface was told about. Never counted,
never uncounted: every entry balances exactly, so no total can drift in either
direction.

What it is *not* excluded from is the bookkeeping that is about records and
people rather than about positions. Someone buying their first position is
still counted as a participant in the protocol's user total, and the listing's
own position token still stops presenting as an open listing the moment it is
consumed. Those were never part of what "invisible" meant, and separating them
explicitly is what keeps a future addition to the position bookkeeping from
silently going missing on this path.

Records created before this change were counted, so their close-outs still
decrement and still announce, exactly as before. The two regimes are
distinguished automatically; no migration or operator action is needed, and the
statistics self-heal as those older sales complete.

Part of #1503 (items 12 and 26).
