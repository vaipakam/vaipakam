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

All three paths now behave exactly like `repayLoan`. Each computes the loan's
fixed origination maturity, adds the same late fee when the close lands in the
grace window (zero within term, so on-time closes are completely unchanged),
and reverts if the close is attempted strictly after the grace period — at
which point resolution belongs to the default/liquidation path, not an
early-close door. The ERC-20 preclose and refinance route the fee through the
same treasury/lender split the interest uses (including the VPFI yield-fee
discount case, so a discounted close can't silently drop the penalty); the NFT
rental preclose funds its late fee from the loan's pre-funded buffer exactly as
the rental repay path does. The offset-completion path receives the same
treatment defensively — it was already prevented from completing at or past
maturity by an existing anti-drift guard, so the fee is zero there in practice
today, but the term is now present should that guard ever change.

On-time and in-term closes see no behavioural difference. Closes #1189
(umbrella #1196).
