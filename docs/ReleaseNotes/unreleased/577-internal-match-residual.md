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
matches (no residual) are unaffected.

Scope note — this change closes the **borrower** side of an internal
match (retrieving the residual safely). It deliberately does not settle
the loan: the borrower's residual claim leaves the loan in its
internal-matched terminal state, exactly where an exactly-collateralized
match already sits, with the **lender** side still pending. The lender
side of an internal match (burning the lender position record once the
lender's matched proceeds — and any amount held back from a pre-empted
offset — have been routed to the *current* holder of the lender position,
which matters when that position was transferred) is a distinct,
partly-pre-existing concern tracked as its own follow-up (#585). Settling
the loan as part of the borrower's claim would have stranded the lender's
held funds and left a stale lender position record, so the borrower claim
is kept honestly partial.

One class of rescue is, for now, held back rather than mis-handled. A
fallback-pending loan can still receive an extra collateral top-up while it
waits (the borrower trying to cure it); that top-up sits in the borrower's
own vault while the loan's original collateral has moved into protocol
custody. The internal-match settlement always draws the moved collateral
from protocol custody, so a loan split across both places can't be settled
correctly yet — the vault-held top-up would be mis-counted. Until the
accounting that reconciles the two lands (with #585), any such topped-up
fallback-pending loan is simply **ineligible** for internal matching: it is
rejected up front, before any funds move, whichever way the match is
attempted (a directly requested match is declined; the automatic
keeper/claim-time matcher quietly skips it and the loan resolves through
its normal fallback claim instead — recovery never stalls). The loan stays
fully recoverable through every other path. This is strictly safer than the
earlier behaviour, which tore down the loan's collateral protection and
freed the residual to the original borrower outright.

Closes #577. The broader audit of every collateral-moving path for
transferred positions is tracked separately as #574; the internal-match
lender-side lifecycle as #585.
