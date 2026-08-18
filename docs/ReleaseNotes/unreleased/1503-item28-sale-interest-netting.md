## Thread — a lender selling out is no longer billed for interest already paid to them (PR #1801)

Both lender-exit sale routes charged the seller their forfeited accrued interest
straight off the accrual clock. On a loan with periodic interest servicing that
figure is wrong: each servicing run forwards interest to the lender without
resetting the clock, so the raw accrual still spans periods the borrower has
already paid for. A lender selling mid-term was therefore charged a second time
for interest they had already received, and the two sale routes were the only
settlement paths in the protocol that did not net this out — repayment,
preclose, swap-to-repay, default and the fallback route all already did.

Both routes now deduct what has already been settled before computing the
forfeiture. Where the borrower is *ahead* — more settled than accrued, which an
overshooting servicing run can produce and which a partial repayment may
deliberately leave as a credit against future accrual — the sale is refused
rather than completed with a nil forfeiture. The distinction matters: a nil
forfeiture and a settled position are different claims, and the residual credit
belongs to the loan. Letting the sale through would have passed it silently to
the buyer, reducing what the borrower owes them at final settlement without
either party agreeing to it. The refusal names the residual so the position can
be brought level first, and it sits above the netting on both routes, because
after netting the residual is no longer recoverable.

There is a second, subtler version of the same mistake, and it is closed here
too. Interest recorded as settled to the lender side is not always interest the
lender received: when a periodic payment is due to a wallet the sanctions
registry flags, the money is held rather than delivered, while the record still
counts it — correctly, since the borrower paid it and their obligation must
reduce either way. A sale then hands that held balance to the buyer. So it is
money the exiting lender never received and does not keep, and crediting it
against their forfeiture would pay them for it a second time at the platform's
expense. Only the delivered part is credited, and the platform now tracks the
held part separately so the two can be told apart.

The buyer's side of the same sale gets a matching read-only signal: a position
that cannot complete for this reason is reported as unavailable before anyone
commits a transaction, rather than letting the purchase be attempted and fail.

Refusing is the conservative half of a larger design. The lender-exit design doc
offers a richer alternative — carry the excess into the buyer's compensation —
which belongs with the position-sale bid instrument, where the buyer's side of
the price is actually modelled. That remains open. Also of note for anyone
reading test coverage: the listed route's net-settlement fan-out was previously
unreachable in the unit suite, because the scaffolded completions never escrow
the buyer's principal; a test-only escrow setter now makes what the seller is
charged observable on that route too.

Part of #1503 (item 28).
