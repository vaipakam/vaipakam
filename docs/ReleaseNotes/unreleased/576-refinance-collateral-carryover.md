## Thread — Refinance collateral carry-over (PR #576)

Refinancing a loan used to make the borrower lock collateral **twice**.
Creating the refinance offer pre-vaulted a fresh full collateral batch,
the new loan was built on that fresh collateral, and the old loan's
collateral was then withdrawn back to the borrower — so mid-refinance the
borrower momentarily had two full collateral batches locked. For an
operation that is "same debt, same collateral, just a better lender/rate,"
that was capital-inefficient and poor UX.

Refinance now **carries the existing collateral over in place**. The
collateral never leaves the borrower's vault: the refinance offer pledges
no fresh collateral, the new loan is created without a fresh deposit or
lien, and the encumbrance lien simply **retags** from the old loan to the
new one (same vault, same amount — the protocol's locked-balance ledger is
unchanged across the refinance). The double-lock is gone; the borrower no
longer needs a second collateral batch.

This works correctly even when the borrower position was transferred after
the original loan was taken out. The collateral stays in the original
borrower's vault (an NFT transfer can't move vault balances), and the
refinanced loan is recorded against that same custody vault while the new
borrower position NFT goes to the refinancer (the current holder) — exactly
the shape the protocol already handles for any transferred position, so
every close path (repay, default, claim) returns the collateral from the
right vault to the rightful holder. The post-refinance health-factor and
LTV checks run against the carried collateral.

Refinance carries over the **same** collateral by definition; changing the
collateral as part of a refinance is out of scope (use the add/remove
collateral flow). Closes #576.
