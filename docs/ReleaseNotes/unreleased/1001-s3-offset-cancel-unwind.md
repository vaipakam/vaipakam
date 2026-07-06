## Offset preclose (Option 3): cancelling an un-matched offer now refunds the Step-1 prepayment (#1001 / #998 S3)

When a borrower uses the "offset with a new offer" preclose to swap out their
lender, the platform pays the outgoing lender their full amount — principal plus
the interest accrued so far plus any rate shortfall — up front, the moment the
offset offer is posted, so the outgoing lender is made whole immediately rather
than waiting for a replacement to appear. The catch: a borrower is explicitly
allowed to cancel that offset offer before anyone takes it, and until now cancel
only released the position lock and forgot about the money already moved. The
prepayment sat stranded in the outgoing lender's balance. If the loan later
closed any other way, that lender could collect the ordinary close-out payment
**on top of** the stranded prepayment — the principal effectively paid twice —
or, seen from the other side, the borrower silently forfeited what they had
already put up.

Cancelling an un-matched offset offer now unwinds that Step-1 prepayment: it is
pulled back out of the outgoing lender's balance and returned to the borrower who
fronted it, and the internal reservation is cleared so a later close-out pays
exactly once. The borrower's separate new-offer capital was already refunded by
the ordinary cancel path; this closes the gap for the prepayment that the offset
flow moves in addition to it.

Separately, a loan may now have only one live offset offer at a time. A second
offset attempt while the first is still outstanding is rejected up front, so the
outgoing lender can never be prepaid twice by stacking offers.

Known limitation (pre-existing, tracked separately): the small treasury fee taken
on the accrued interest at offer creation is paid to the external treasury and is
not clawed back on cancel, so a borrower who offsets a loan that has already run
for a while, then cancels, forfeits that fee. It is zero for a freshly-started
loan. Moving that fee to completion is a follow-up.

Closes #1001 under the #998 spec-conformance umbrella. The related timing item
(paying the outgoing lender at completion rather than at posting) is out of scope
here — this change makes the current "pay up front" model safe to cancel.
