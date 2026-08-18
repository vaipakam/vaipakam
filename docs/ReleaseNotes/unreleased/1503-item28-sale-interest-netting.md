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
in time through which the lender has actually been paid, and the forfeiture runs
from there. A seller is charged for the stretch nobody has paid them for, and for
nothing else.

That mark is the authority, not the loan's own interest clock. The two are easy
to conflate and answer different questions: the loan's clock restarts whenever
the borrower's obligation is re-based, which is not the same event as the lender
being paid. They diverge in a case that matters — when a payment is due to a
lender whose wallet the sanctions registry flags, the money is held rather than
delivered while the obligation still re-bases — so reading the obligation clock
as evidence of payment would close the seller's window over money that never
reached them. Where no payment has ever been made to a lender, the loan's clock
is the starting point; after that, only actual payment moves the mark. A payment
path the platform failed to account for therefore over-charges the seller
slightly rather than quietly paying them twice, which is the safer way to be
wrong.

Measuring a window rather than netting an amount is the load-bearing choice, and
it took two attempts to see why. The forfeiture figure belongs to the loan's
*current* accrual stretch, and several ordinary events — a partial repayment, a
swap-to-repay — restart that stretch. A running total of interest delivered over
the loan's whole life is therefore not comparable with it: immediately after a
restart the total describes a window the forfeiture no longer covers, and once
the same amount accrues again it gets deducted a second time. A point in time
composes with a restart, because a mark that records actual payment is unaffected
by a restart that paid nobody. It also removes a refusal the amount-based version needed: a
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

For the same reason it advances only when a period is settled in FULL. A partial
settlement leaves the remainder in the borrower's obligation, so treating the
period as paid would let the seller collect that remainder through their sale
price while the buyer can still collect it later through repayment — the same
interest, paid twice. The effect would be largest exactly where collateral is
nearly exhausted and the payment smallest.

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

The mark is honoured only while it still describes the position, and this is the
limit worth understanding. A point in time carries no amount. It can stand in for
"interest already received" only when nothing since has changed what that stretch
is worth or broken it into pieces — and two ordinary things do.

The first is a change of principal. The unpaid stretch is priced at the balance
it accrued on, so a partial repayment inside the stretch leaves part of it having
accrued on a larger balance than the loan now carries; one figure would bill it
at the wrong size. The second is a payment held rather than delivered. After
that, the lender's delivery is no longer one continuous run — an earlier period
is unpaid while a later one is settled — and a single point cannot express which,
so reading it as "paid through the later one" would credit the held period too.
That second disqualification lasts the rest of the lender's tenure, because no
later payment restores the missing one.

A loan also needs a starting point for any of this to mean anything. Each new
loan records the balance it opens at, so the first delivery has something to
compare against; without that, a balance change between origination and the
first settlement would be invisible, and that settlement would install a record
that looks trustworthy while excluding interest charged at the larger balance.
Loans already open when this ships have no such starting point, and no later
event supplies one: the interval between origination and the first delivery is
never reconciled, so a mark installed after it excludes whatever happened in
there just the same. Such a position therefore grants no credit for the rest of
the lender's tenure — it keeps the full charge it already had — and only a sale,
which opens a fresh window for the incoming lender, clears the condition.

Neither disqualification lifts. A later clean settlement cannot repair a record
that is already discontinuous, so once either has happened nothing on that
position is trusted again until a sale opens a fresh window for the incoming
lender. That matters most in a sequence that looks harmless: a principal change
followed by a successful settlement would otherwise re-validate the mark and
silently exclude the stretch that accrued on the larger balance.

Where any of these applies — a principal change, a held payment, or a missing
starting point — the platform discards the credit and charges the full accrual,
the behaviour that shipped before this change. The exiting lender may be charged
for interest they genuinely received; the platform never pays the same interest
twice. A sale clears all of them, since the buyer's period opens at the purchase
and carries nothing from the seller's tenure.

Both conditions are read from the loan's own recorded state rather than reported
by whatever caused them. That distinction is the point: principal is reduced at
eight places across five parts of the protocol, and a rule those places have to
remember to honour has eight places to be forgotten — including in code written
later by someone who has never seen this change. A rule that reads the state
instead cannot be forgotten.

One consequence is worth stating plainly, because it is a step back for some
sellers rather than only a correction. A larger forfeiture is a larger cost, and
the sale routes refuse a sale that would leave the position short of its solvency
floor. A lender on a loan that has taken a partial repayment, or that has ever
held a payment to them, may therefore find a sale priced higher than before —
and, near the floor, refused where it would previously have completed. That is
the platform declining to fund a credit it cannot size correctly, not a fee
increase, and it resolves as the accumulator work lands.

The narrower cases this leaves open — crediting interest delivered beyond a
period boundary, and pricing a stretch that spans a principal change — are
tracked separately. Closing them properly needs the platform to accumulate the
forfeitable amount segment by segment as the loan changes, rather than infer it
from a single point in time, and that is a larger change than this one.

One more thing changed on the app side, and it is a correction rather than an
addition. When the seller's window cannot be read — a transient RPC failure —
the app used to fall back to the loan's own interest clock on the reasoning that
this is the cautious direction. It is not always: the point a lender was paid
through can sit EARLIER than that clock, because closing a loan early re-bases
the clock without clearing the older record. The platform would then charge from
the earlier point while the app quoted from the later one, understating the cost
and letting a seller commit to a sale the platform then refuses. The app now
says the quote is unavailable instead of estimating one. Every other surface is
unaffected — only the figure that cannot be computed declines to be computed,
and a listing that exists on chain keeps its card and its cancel button even
while its funding figure is unknown.

Relatedly, the app can no longer price a sale against a different moment than it
read the loan at. The timestamp is part of the snapshot and the pricing helpers
take no clock argument, so pairing a loan with someone else's clock is not
something a caller can express any more, rather than something each caller has
to remember.

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
