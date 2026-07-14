## Thread — Early-close paths now charge the late fee and refuse post-grace (PR #1189)

Before this change a borrower who let a loan run past its due date could
sidestep the late-fee penalty — and reopen a repayment door the ordinary repay
path deliberately closes — simply by choosing a different close-out call. The
three "strategic close" entry points (`precloseDirect`, `refinanceLoan`, and
offset completion) only checked that the loan was still active: they charged no
late fee and had no grace-window cut-off, whereas the normal `repayLoan`
charges the standard late fee on any overdue close and blocks a repayment once
the grace period has expired. The gap let a late borrower keep ~99% of the
penalty (which is lender income) in their own pocket and get a post-grace exit
the protocol otherwise routes to the default path.

All three paths now charge the same late fee `repayLoan` does when the close
lands in the grace window (zero within term, so on-time closes are completely
unchanged), routed through the same treasury/lender split the interest uses —
including the VPFI yield-fee discount case, so a discounted close can't silently
drop the penalty. The NFT rental preclose funds its late fee from the loan's
pre-funded buffer exactly as the rental repay path does. The offset-completion
path receives the fee defensively — it was already prevented from completing at
or past maturity by an existing anti-drift guard, so the fee is zero there in
practice today, but the term is now present should that guard ever change.

Where the paths differ is the post-grace **cut-off**, because they differ in
structure. `precloseDirect` is a single atomic transaction with nothing
pre-created, so — like `repayLoan` — it simply reverts once the grace period has
expired; resolution then belongs to the default path. **Refinance is a two-step
flow**: accepting the replacement offer creates and funds the new loan and pays
the borrower in one transaction, and a later transaction completes the swap by
settling the old loan. Reverting that completion once the old loan crossed grace
would strand the borrower with *both* loans active, so a refinance whose
replacement was already accepted always completes — settling the old lender in
full plus the grace late fee, which is strictly better for that lender than a
default recovery (the same reasoning behind `repayLoan`'s post-grace
FallbackPending cure). A *fresh* post-grace refinance is instead refused earlier,
at offer admission: a refinance-tagged offer cannot be created, accepted, or
matched against a target that is already past its grace window, and a tagged
offer's expiry is capped at the target's grace deadline so it can't linger
unfillable. Legacy untagged manual refinances, which the admission layer can't
associate with a specific loan, are allowed to complete on the same
lender-favourable, penalty-charging basis.

On-time and in-term closes see no behavioural difference. Closes #1189
(umbrella #1196).
