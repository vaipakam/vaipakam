## Thread — an advanced-user walkthrough of the live Base Sepolia deployment

We now have a way to ask "does the deployment that is live right now behave
the way we say it does?" and get an answer accounted to the wei. A new
scenario driver runs against a local fork of a real deployment rather than a
fresh local deploy, so what it exercises is the deployed bytecode together
with that deployment's own configuration — the swap venue that is actually
registered, the faucet prices and pool depth that were actually seeded, the
external treasury address, the facets that are actually routed. Several of
this first run's findings are properties of the deployment rather than of the
source tree, and a fresh local deploy would have hidden every one of them. It
needs no Solidity compiler: it reads the committed per-facet ABIs, so the
compiler stays the single source of truth for every decode while the driver
itself is plain Node.

The run now covers one hundred and twenty-nine scenarios across the whole advanced
surface — offer creation and escrow, accept and the loan-initiation fee,
repayment and the treasury's interest cut, the borrower's collateral claim,
time-based default, health-factor liquidation, preclose, partial repayment,
lender exit by listing and by direct sale, releasing surplus collateral mid-loan, refinance,
the offset and obligation-handover exits, periodic interest, NFT rental, repaying from collateral, and the sanctions, KYC and
illiquid-asset gates. The
fee and health-factor behaviour reconciles exactly against the specification,
including the per-loan fee stamps that stop a governance retune re-pricing an
open loan. Four results are worth an operator's attention. A forced close on
this testnet cannot be reached through a collateral price move, because the
seeded pool sits so close to the liquidity-depth floor that any meaningful
drawdown flips the asset illiquid and the protocol then correctly refuses to
swap it. Closing a loan early under a full-term-interest offer saves the
borrower nothing, which every preclose quote has to say out loud. A repayment
settles the money but leaves the collateral lien standing until the borrower
separately claims it, so "Repaid" is not "done". And with KYC enforcement
armed — an industrial-fork knob that retail never turns on — the gate binds at
accept rather than at offer creation, so a maker can post an offer that no
taker is permitted to fill.

Two paths that move funds on an open position, rather than closing one, were
added after the first pass. Releasing surplus collateral turns out to be
bounded exactly by the initiation health-factor floor — the protocol quotes
everything down to it, refuses a single wei past rather than clamping, and
authorises the release by the borrower's position NFT rather than by the
address recorded on the loan, so a transferred position carries the right
with it. Refinance confirmed its stated invariant: two loan records and four
position NFTs, all four still resolving, with the old borrower token
surviving as a receipt on the original position. What was not obvious until
it was driven is how much consent a refinance needs first — the borrower has
to have capped, in advance, the rate any refinance may carry, and that
consent is itself required to carry a deadline. The terms a third party may
move a borrower onto are bounded by something the borrower set, not by the
offer alone.

The two exits that hand a position to someone else were added last, and the
offset one carries a trap worth stating plainly: its completion is automatic.
Posting an offset offer leaves the original loan open, but a third party
filling that offer closes it inside the same transaction, and calling the
completion step afterwards is refused. A surface that shows "offset posted,
now complete it" is waiting for something that already happened. Two further
details are not obvious from the name — the vehicle is a lender-side offer
posted by the borrower, so anything classifying offers by their type alone
files it under the wrong party; and the rule that the replacement may not
mature later than the original is enforced to the second, which is why a
same-length replacement fits in the second the loan originated and is refused
a minute later. Obligation handover, by contrast, keeps the loan record and
rewrites its borrower in place, with the lender and principal untouched and
the exiting borrower paying only the interest accrued so far. Refinance ends
one loan and starts another; handover mutates one. Any indexer has to model
both shapes. The lender's two exits mirror the borrower's: a listed sale
completes itself the moment a buyer fills it, a direct sale settles in one
transaction with no listing at all, and on both the borrower's position runs
on unchanged. The sale vehicle is the offset vehicle's mirror image — a
borrower-side offer posted by the lender — so neither can be classified by
its type alone.

Periodic interest ships dormant on this deployment, which is its intended
default, and while it is off an offer carrying a cadence is refused outright
rather than quietly downgraded. The connected app never offers a cadence, so
nothing is hidden from users behind the flag. Armed on the fork only and then
restored, the feature proved strict about admission — on this deployment a
monthly cadence needs a principal of at least one hundred thousand in the
numeraire — and it closes an unpaid period by selling just enough collateral,
with a settler bonus and treasury fee, while the loan stays open. A period the
borrower pays voluntarily is closed by that payment itself.

NFT rental was checked against the functional specification rather than the
code, and matched it point for point: the NFT sits in the lender's own vault
throughout, the renter holds only the right to use it and never custody, rent
is prepaid with a five-percent buffer, and an early close pays the lender
exactly the days used while returning the unused rent and the whole buffer to
the renter — conserving every unit across the rental's life. A rental reports
no health factor, but through a different refusal than an illiquid-collateral
loan does, so any surface showing health factor has to recognise both.

Repaying straight from collateral behaves as specified on authority,
partial-mode consent and health, and accounts every unit of the sale — but it
turned up one candidate divergence. The amount of collateral the caller
allows the protocol to sell is treated as the exact amount to sell, not as a
ceiling, so an over-generous allowance converts far more collateral into the
lending asset than the debt needs. The specification and the code's own
description both read it as a ceiling. No value is lost and no shipped
surface uses this path yet, so it is recorded as a pending divergence for an
owner decision rather than resolved by rewording the specification.

On the middle two of the four findings, the connected app was checked afterwards rather than
assumed, and already honours both: the early-repay card reads the loan's
interest mode live and is deliberately tri-state, never defaulting to
full-term wording on a loan that might accrue pro rata, and the Claims page,
the claim-all card and the close-early confirmation all point the borrower at
the collateral still waiting for them. They are written up as protocol shapes
a new surface must reproduce, not as gaps in the shipped one — and the
write-up records that correction rather than quietly dropping the two items
it first listed as follow-ups.

The run also found that the committed Base Sepolia deployment artifact no
longer describes the live Diamond: its own facet count disagrees with the
number of entries it holds, seven routed implementations appear under no key
at all, and the companion source record names a diamond that was retired. This
is the same omission class the deploy-time readback guard was built to catch;
the live deployment simply predates that guard. No address is lost — every
implementation stays recoverable from the Diamond's own loupe — so the cost is
inventory accuracy rather than funds, and the fix is the refresh-and-re-export
that this work could not perform itself. That half of the task is reported
rather than approximated: the session had no Foundry, no deployer key, no
write-capable endpoint and not enough memory for the build, and an ABI export
that never ran the compiler would be a fabricated artifact. It remains an
operator-side action, and the written-up walkthrough names it as the first
follow-up.
