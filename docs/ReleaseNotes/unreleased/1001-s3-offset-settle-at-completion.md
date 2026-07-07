## Offset preclose (Option 3) redesigned to settle at completion, not at posting (#1001 / #998 S3)

The "offset with a new offer" preclose — where a borrower exits their loan by
posting a lender offer that a new borrower takes — used to pay the outgoing
lender their full amount (principal, accrued interest and any shortfall) the
moment the offer was *posted*, and then leave that money parked while the offer
waited to be matched. That parked payment was the root of a whole family of
problems: cancelling the offer stranded it (the lender could later be paid
twice), and any other action on the loan while the offer sat — the lender
selling their position, the loan being repaid or liquidated, the obligation
being transferred, or the offer's own terms being edited — could misdirect or
double-count it.

The flow has been redesigned around a single principle: **nothing about the
original loan's settlement changes until the offset actually completes.** A
posted offset is now just a pending intent. Posting moves no settlement money at
all — the outgoing lender is paid their full due only at the instant a
counterparty accepts, computed from the loan's live terms at that moment (so the
accrued interest covers the whole time the loan actually ran, and the shortfall
reflects the replacement offer's current rate), and deposited to whoever holds
the lender position at that time.

Consequences of the redesign:

- **Cancelling is trivially loss-free.** With nothing parked, cancel just
  releases the borrower's position lock and refunds the borrower's own new-offer
  capital. There is no reservation to unwind and the outgoing lender was never
  pre-paid, so a later close-out of the loan pays them exactly once.
- **The double-pay and the interleaving hazards are gone by construction.**
  Because the loan's lender-side state is untouched until completion, a lender
  sale, a repay/default/liquidation, or an obligation transfer that happens while
  an offset is posted can no longer corrupt a half-settled payoff.
- **Term edits can't shortchange the lender.** The payoff is computed from live
  terms at completion, so lowering the replacement rate after posting simply
  raises the shortfall the borrower owes — the outgoing lender is always made
  whole.
- **The outgoing lender is now paid for the full elapsed time.** Previously the
  accrued interest was frozen at posting time even though the loan kept running
  until completion; it is now measured at completion.

To keep the pending offset from racing a concurrent change to the same loan,
three actions are refused while an offset is live (until it completes or is
cancelled — it is short-lived): listing the lender position for sale,
transferring the borrower obligation, and editing the linked offset offer (the
offer is immutable once linked, its terms pinned to the loan it offsets). A loan
may still hold only one live offset offer at a time.

One trade-off is intentional: the borrower must hold the payoff funds (and
standing approval) at *acceptance* time rather than at posting. If they don't,
the acceptance simply reverts and the original loan is left untouched — never
partially settled.

Closes #1001 under the #998 spec-conformance umbrella.
