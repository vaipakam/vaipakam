## Thread — a lender selling out is no longer billed for interest already paid to them (PR #1801)

Both lender-exit sale routes charged the seller their forfeited accrued interest
straight off the accrual clock. On a loan with periodic interest servicing that
figure is wrong: each servicing run forwards interest to the lender without
resetting the clock, so the raw accrual still spans periods the borrower has
already paid for. A lender selling mid-term was therefore charged a second time
for interest they had already received, and the two sale routes were the only
settlement paths in the protocol that did not account for this — repayment,
preclose, swap-to-repay, default and the fallback route all already did.

The fix narrows the *window* the forfeiture is measured over rather than
subtracting an amount from it. The platform now records, per position, the point
in time through which the lender has actually been paid; the forfeiture then
runs from whichever is later, that mark or the loan's interest-accrual origin.
A seller is charged for the stretch nobody has paid them for, and for nothing
else.

Measuring a window rather than netting an amount is the load-bearing choice, and
it took two attempts to see why. The forfeiture figure belongs to the loan's
*current* accrual stretch, and several ordinary events — a partial repayment, a
swap-to-repay — restart that stretch. A running total of interest delivered over
the loan's whole life is therefore not comparable with it: immediately after a
restart the total describes a window the forfeiture no longer covers, and once
the same amount accrues again it gets deducted a second time. A point in time
composes with a restart by construction, because the later of two marks is still
a valid start. It also removes a refusal the amount-based version needed: a
window cannot over-subtract, so there is no leftover credit to strand, and a
lender who is fully paid up simply forfeits nothing and completes the sale
normally. An earlier revision of this change blocked that sale outright.

There is a second, subtler version of the same mistake, and it is closed here
too. Interest recorded as settled to the lender side is not always interest the
lender received: when a periodic payment is due to a wallet the sanctions
registry flags, the money is held rather than delivered, while the record still
counts it — correctly, since the borrower paid it and their obligation must
reduce either way. A sale then hands that held balance to the buyer. So it is
money the exiting lender never received and does not keep, and treating it as
paid would credit them for it a second time at the platform's expense. The mark
only advances where interest genuinely reaches the lender.

A completed sale also moves the mark forward, because a sale settles the
outstanding forfeiture — to the platform, or into the buyer's rate compensation.
The position the buyer receives is clean, and their own window opens at the sale.
Without that, the same stretch would be forfeited again on every resale, at the
seller's expense once per hop.

A plain transfer of the position is deliberately different: it moves nothing.
Nothing is settled by a transfer, so the outstanding forfeiture travels with the
position exactly as the unpaid interest it represents does. Treating a transfer
like a sale would let any lender zero their own forfeiture by sending the
position to a second wallet — or to themselves — and selling from there, which
is a larger hole than the one this change closes.

Loans that predate this change carry no mark, which resolves to the accrual
origin — exactly the behaviour they already had. Nothing needs to be
reconstructed or backfilled for them.

Seller-facing surfaces read the same figure the contract charges, through a new
read-only view that reports both the window's start and what it comes to right
now. The offer picker, the confirmation receipt, the funding watch and the
submit re-check all quote the corrected cost rather than the raw accrual.

Also of note for anyone reading test coverage: the listed route's net-settlement
fan-out was previously unreachable in the unit suite, because the scaffolded
completions never escrow the buyer's principal; a test-only escrow setter now
makes what the seller is charged observable on that route too.

Part of #1503 (item 28).
