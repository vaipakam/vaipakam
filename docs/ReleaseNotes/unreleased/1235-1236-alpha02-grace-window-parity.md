## Thread — alpha02 grace-window parity for close-early and refinance (PR #TBD)

The contracts (Pass-2 A1/D5, #1189) made closing a loan early and
refinancing it valid all the way through the grace window — both
charge the same late fee a normal late repayment does there, and only
a strictly-past-grace attempt is rejected. The alpha02 app still
gated both surfaces at the original due date, so a borrower inside
the grace window could not reach either door the protocol actually
holds open.

The position page now keeps the close-early card and the refinance
form available through the grace window, judged by chain time against
the live term fields and the live grace schedule. In grace, both
surfaces say plainly that the loan is past due and that the figures
include the growing late fee (the close-early quote comes from the
protocol's own settlement view, which already includes it). Strictly
past grace, both disappear and any attempt is stopped before a wallet
prompt with an honest "the default process applies now" message.

The refinance money-math is now time-aware end to end: the payoff
quote and the pending request's funding watch include the late fee
and the interest that keeps accruing past the due date as of now, and
the standing payoff approval (both at posting and from the restore
action) covers the full pull at the last moment the request could
still be accepted — its own expiry or the end of the grace window,
whichever comes first. Previously the approval was sized to
the fee-free payoff, so a request accepted inside the grace window
would pull more than the allowance and fail; the borrower had to
over-approve by hand. A pending request whose loan has gone strictly
past grace now reads as dead (like an expired one): funding warnings
stop and cancelling to unwind the approval is the remaining action.
The lender sale-listing flow keeps its at-maturity block (the
contract genuinely rejects listing a matured position) and got its
own accurately-worded error instead of borrowing the refinance one.

Closes #1235. Closes #1236.
