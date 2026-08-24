### A direct position sale now screens the loan's current borrower, not a stale record

When a lender sells an active loan straight into a standing buy offer (the
one-transaction "direct" route), the platform checks the incoming lender against
the loan's borrower before letting the sale through. It was checking the
borrower recorded when the loan was first created. But a borrower position can
change hands after origination, so that record can be stale — and the check
never looked at who actually holds the borrower position now.

Two problems followed. The compliance screen validated the buyer against a
borrower who may no longer be party to the loan. And, more seriously, nothing
stopped the loan's **own current borrower** from buying the lender side of their
own debt. That would leave a single wallet as both lender and borrower of a live
loan — a party owing itself — after which the ordinary repayment path rejects
that wallet's own repayment, stranding the position.

The direct route now resolves the borrower position's live holder and refuses
the sale when the buyer is that holder, with a distinct error naming the
condition so the seller knows to pick a different buy offer rather than re-list.
The compliance screen now runs against the live holder too. The listed sale
route already did both of these; this brings the direct route to the same rule,
as the platform's two-route parity requires — the same position must not sell on
different terms depending on which door it leaves by. The self-dealing refusal
takes effect on every deployment; the compliance-counterparty correction matters
where identity gating is switched on.

Closes #1921 (#1503 item 5), the first of the four remaining lender-sale items
being closed in place rather than by a new sale instrument; items 6, 9 and 15
remain.
