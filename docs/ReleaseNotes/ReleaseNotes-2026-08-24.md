# Release Notes — 2026-08-24

Two more guards on the lender position-sale route, both tightening what a buyer
can be admitted into. The first refuses a sale that would hand the buyer a
higher inherited treasury-fee rate than a fresh loan carries; the second brings
the direct (one-transaction) sale route up to the listed route's rule for who
the sale is screened against — the loan's live borrower, never a stale record,
and never the borrower buying their own debt's lender side.

### A position sale now checks the fee rate the buyer inherits

A loan keeps the treasury-fee rate it was created under for its whole life, and
settles at that rate no matter what governance does later. That rule is
deliberate and unchanged — a retune must never re-price a loan someone already
holds.

What it did not account for is a loan changing hands. When a lender sells their
position, the buyer inherits the loan's original fee rate along with everything
else. If the fee has been lowered since that loan was created, the buyer ends up
paying the older, higher cut and earning less than the terms of their own
standing offer imply — and nothing they could look at would have told them so.
The rate is not part of the offer they wrote, and it does not show up in any
health or collateral reading.

Sales are now refused when the inherited rate is higher than the rate a loan
created today would carry. A position created under a **cheaper** rate stays
sellable, because its buyer inherits a better deal than a fresh loan would give
them — the same one-directional test already applied to the loan's inherited
risk terms. The refusal names the fee specifically rather than being reported as
a collateral problem.

The existing loan is untouched by this: it still settles at its own rate. A fee
change can now leave a position temporarily unsellable while it remains
perfectly valid to hold, repay, or liquidate.
<!-- assembled-fragment: 1918-sale-inherited-fee.md sha256=af37863362fad19cc3e3f0a50ecff1f73ae52d3e49ef76c3ad36c7c2578a14df -->

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
<!-- assembled-fragment: 1921-direct-sale-current-borrower.md sha256=bc38cdfa14fd2fe806096b8cfac2496afc2b20cdab5c04ede181df18e7edff2d -->
