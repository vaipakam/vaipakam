## Thread — Internal-match top-up-aware unwind (PR #591)

A fallback-pending loan can receive an extra collateral top-up (a
borrower "cure" attempt that doesn't fully clear the debt). That top-up
sits in the borrower's own vault under a lock, while the loan's original
collateral has already moved into the protocol's central custody. Until
now such "topped-up" loans were excluded from internal-liquidation
matching entirely: a match draws the matched collateral from the central
custody, and if it had drawn against the loan's full collateral figure
(which silently includes the vault-held top-up) it would have over-drawn
custody — taking collateral belonging to other loans parked in the same
asset.

This change replaces that exclusion with top-up-aware accounting. A
topped-up loan is now matchable, but only its custody-held portion
participates in the match — the vault-held top-up never does. The top-up
stays where it is, locked in the borrower's vault, and is folded into the
borrower's residual claim so it is returned to the **current**
borrower-position holder (not a stale original borrower if the position
was transferred). On a full match the loan settles as internally matched
and the whole remaining collateral — the custody residual plus the
untouched top-up — becomes claimable by that holder. On a partial match
the loan stays fallback-pending and its settlement snapshot is scaled
against the custody portion only, leaving the top-up lock intact for a
later match or in-kind payout. The same custody-portion-only rule now
governs the claim-time retry swap, so that path is likewise safe for
topped-up loans.

With the unwind in place, the four former exclusion points (the direct
trigger gate, the auto-dispatch skip, the candidate-scan filter, and the
defensive settlement guard) are removed, and the unused
"top-up unsupported" error is retired. Lender-proceeds routing from the
lender-side lifecycle work is unchanged. Closes #591 (the Part B
follow-up to #585).
