## Thread — Refinance collateral carry-over (PR #576)

Refinancing a loan used to make the borrower lock collateral **twice**.
Creating the refinance offer pre-vaulted a fresh full collateral batch,
the new loan was built on that fresh collateral, and the old loan's
collateral was then withdrawn back to the borrower — so mid-refinance the
borrower momentarily had two full collateral batches locked. For an
operation that is "same debt, same collateral, just a better lender/rate,"
that was capital-inefficient and poor UX.

Refinance now **carries the existing collateral over in place** for the
common case. When carry-over applies, the collateral never leaves the
borrower's vault: the refinance offer pledges no fresh collateral, the new
loan is created without a fresh deposit or lien, and the encumbrance lien
simply **retags** from the old loan to the new one (same vault, same amount
— the protocol's locked-balance ledger is unchanged across the refinance).
The double-lock is gone; the borrower no longer needs a second collateral
batch. The post-refinance health-factor and LTV checks run against the
carried collateral, and the carried collateral identity must match the old
loan's exactly (asset, type, amount, token id, quantity) or the refinance
is rejected.

Carry-over is deliberately scoped to the case the retag machinery handles
end-to-end: the refinancer must be the **original borrower** (the borrower
position has **not** been transferred) and the offer must pledge a
**single, fixed** collateral amount (no borrower range). Every other
refinance — a **transferred** borrower position, a **ranged** offer, or an
**untagged** direct refinance — takes the unchanged **legacy path**: the
new collateral batch is deposited fresh and the old loan's collateral is
returned to the current borrower-position holder. This avoids skipping a
deposit the protocol never received (a transferred position's collateral
lives in the *original* borrower's vault, which carry-over can't retag into
the refinancer's). Letting a transferred position also carry over — by
consolidating the collateral into the current holder's vault — is tracked
as a separate design item (#594).

The carry-over decision is **computed once at offer creation and recorded
on the offer**, and every later step reads that record rather than
re-deriving it. This is the key correctness property: the targeted loan's
borrower can change (obligation transfer) and its lien can be released
between offer creation and the later steps, so a re-derived decision could
flip and desync from what was physically deposited — a carry-over offer
deposited nothing, so a flipped "not carry-over" reading could try to
refund or settle collateral that never existed (a fund-safety bug on
cancel). Recording the decision once removes that whole class.

Eligibility is correspondingly precise: an offer carries over only if it is
the original borrower's, single-value, with collateral identity exactly
matching the targeted loan AND a live old-loan lien. Anything else — a
mismatched-collateral or no-lien tagged offer included — resolves to "not
carry-over" and takes the legacy fresh-pledge path (so it is never an
unfillable advertised offer). A refinance-tagged offer's collateral is also
**frozen** once created — the offer-collateral mutators reject it (principal
and rate terms can still be changed). Separately, when a same-key retag
moves a lien from the old loan to the new one, the old loan's lien row is
zeroed (matching the normal release path) so stale per-loan readers can't
mis-report the collateral as still owed on the refinanced-away loan.

A refinance-tagged offer is also **direct-accept-only**: it must be filled
by a lender directly accepting it (which chains atomically into the
refinance), not through the anonymous range-order matcher. The matcher
can't guarantee the collateral retag fires atomically with the
replacement-loan creation, nor preserve the fixed carried collateral
against its own midpoint sizing, so it rejects refinance-tagged offers.
Re-admitting them with a carry-over-aware matched path is tracked
separately (#595).

Refinance carries over the **same** collateral by definition; changing the
collateral as part of a refinance is out of scope (use the add/remove
collateral flow). Closes #576.
