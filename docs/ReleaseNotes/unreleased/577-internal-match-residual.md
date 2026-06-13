## Thread — Internal-match residual collateral is now retained + claimable, not stranded or drainable (PR #584)

When an over-collateralized loan is closed by an internal match (the
permissionless mechanism that nets two opposing under-water loans against
each other instead of swapping on a DEX), the match only consumes as much
collateral as the opposing debt needs. For an over-collateralized loan
that leaves a **residual** — collateral the borrower pledged beyond what
the match used.

Until this change that residual was mishandled on the full-close paths:
the loan's collateral protection was torn down and the residual was freed
back into the borrower's vault with **no way to retrieve it**. For most
assets the residual was simply stranded (the internal-match terminal
state was never made claimable). For VPFI it was worse — if the borrower
had transferred their loan position to someone else, the original
borrower could quietly withdraw the freed residual, draining value that
belonged to the new position holder.

This thread closes both gaps. On a full internal-match close the residual
now stays **protected** (its collateral lien is retained, or re-created in
the fallback-rescue case) and a claim record is written for it, owed to
the **current holder of the borrower position**. The internal-match
terminal state is added to the borrower's claim path, so the rightful
holder retrieves the residual through the same claim flow every other
proper close uses — the protection releases and the funds move in one
atomic step driven by the holder, exactly the pattern that already guards
against the transferred-position drain on repay/refinance/preclose. A
borrower who has transferred their position away can no longer reach the
residual; the stored loan record's withdrawal is blocked by the retained
lien.

The fix applies uniformly to both internal-match full-close branches (the
active-loan close and the fallback-rescue close). Exactly-collateralized
matches (no residual) are unaffected. Closes #577. The broader audit of
every collateral-moving path for transferred positions is tracked
separately as #574.
