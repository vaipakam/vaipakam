## Thread — An early close is the borrower's own (PR #<n>)

A keeper the borrower had approved could start an early close on the borrower's behalf: a direct close, a handover to another borrower, or an offset with a new offer. The handover and the offset choose terms the borrower is then bound to, so a leaked or misused keeper key could close a loan on terms the borrower never picked. All three now take only the borrower position's holder (or, for a protected account whose old wallet was replaced, its controller). Someone else who wants to pay a loan off uses the ordinary repayment, which now takes any payer.

The external "complete an offset" entry is gone too. Accepting an offset offer has completed the offset in the same transaction for some time, and the accept reverts whole if the completion fails, so the entry had no work left. The internal completion the accept calls is unchanged, and a direct call to it from anyone but the platform itself is refused.

The two keeper action flags these entries read (start an early close, complete an offset) now grant nothing. They can still be approved until the approval setter learns to refuse them, which is a later step of the same review.

This is the first build item of the keeper approvals review (KeeperApprovalsReviewDesign.md, sections 4, 6 and 7). It advances #3790.
