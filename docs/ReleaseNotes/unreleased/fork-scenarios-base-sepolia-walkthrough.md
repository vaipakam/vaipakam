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

The run now covers one hundred and forty-nine scenarios across the whole advanced
surface — offer creation and escrow, accept and the loan-initiation fee,
repayment and the treasury's interest cut, the borrower's collateral claim,
time-based default, health-factor liquidation, preclose, partial repayment,
lender exit by listing and by direct sale, releasing surplus collateral mid-loan, refinance,
the offset and obligation-handover exits, periodic interest, NFT rental, repaying from collateral, and the sanctions, KYC and
illiquid-asset gates. The
fee and health-factor behaviour reconciles exactly against the specification,
including the per-loan fee stamps that stop a governance retune re-pricing an
open loan. Four results are worth an operator's attention. Rehearsing a
forced close by moving a faucet asset's price feed alone makes the asset
read illiquid after a three-percent move, and the protocol then correctly
refuses to swap it — not because the test pool is shallow, as the first
write-up said, but because the pool's own price does not follow the feed and
the protocol distrusts a pool whose price disagrees with the oracle. Moved
together, as a real market would move them, the asset stays tradable through
a fifty-five-percent fall and the position is liquidated from the collateral
side exactly as specified; the driver now does that in one step. Closing a loan early under a full-term-interest offer saves the
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
rewrites its borrower in place, with the lender and principal untouched. The
exiting borrower pays the interest accrued so far plus a protection top-up
for the lender whenever the replacement's remaining interest falls short of
the original's — which it did in this run, so the handover cost more than the
accrued interest alone. Refinance ends
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
borrower pays voluntarily is closed by that payment itself — and because a
partial repayment charges all interest accrued to that moment, paying on the
day after the period ends costs that extra day's interest too.

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
turned up one divergence. The amount of collateral the caller allows the
protocol to sell is treated as the exact amount to sell, not as a ceiling, so
an over-generous allowance converts far more collateral into the lending
asset than the debt needs. The specification and the code's own description
both read it as a ceiling. No value is lost and no shipped surface uses this
path yet. The owner has since decided that the specification is the intent
and the code is the defect: the sale should be sized to the debt, with the
rest of the collateral left pledged and claimable. The fix is tracked
separately, and the walkthrough's check for it now asserts the intended
behaviour — so it reads as a failure against the live deployment until the
fix ships, rather than as a pass that certified the defect.

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
that this work could not perform itself. Once Foundry was available the ABI
re-export was run for real and found every committed interface already
matching the source, so there was nothing to publish. The on-chain refresh
is different: it has to be signed by the Diamond's admin account, whose key
this work does not hold, and it remains an operator-side action that the
written-up walkthrough names as the first follow-up.

The whole walkthrough was then re-run on Anvil, Foundry's fork node, which
the session could install after all through Foundry's official npm packages.
That re-run found three problems in the test driver that the first node had
masked, each now fixed at its root rather than scenario by scenario. The
well-known development accounts a fork node hands out are not clean on a
public testnet: two of them already carry smart-account delegations on Base
Sepolia, so the protocol saw contracts where the test meant plain wallets.
The driver now generates fresh accounts every run and refuses to start if any
of them has code. A scenario that aborted halfway used to leave its price
changes behind and quietly break every scenario after it; each scenario now
runs inside a snapshot of the fork and is rolled back afterwards, whatever
happened. And Anvil's gas estimate for a call that closes a loan comes back
just short, because clearing that much storage earns a refund that hides the
peak; the driver adds a margin, as wallets do, and names a gas shortfall as
such when one still happens. Whether a production node's estimate has the
same shortfall was not tested, and the write-up says so.

Review of the walkthrough then found the ledger itself too forgiving: some
rows printed a figure under a pass that nothing had checked, and others
recorded a regression as a mere observation. The fix went into the ledger's
structure rather than into individual rows. A row is now either an assertion
— which can only pass or fail, and needs a real condition — or an
observation, and there is no longer any way to write a verdict by hand. Every
formerly unchecked pass was given an exact expectation, and all of them hold
on the live deployment. Four rows that had been certifying a deployment's
configured value now record it as an observation instead, so a later change
of configuration can never be reported as a green "unchanged". The steps that
move money on an open position — the obligation handover, both kinds of
lender sale, and the periodic interest settlement — now check every balance
change against the amount the specification's own formula gives, so an
unexpected transfer fails as surely as a wrong one; all of them reconcile to
the smallest unit. One thing the specification leaves open is surfaced
rather than certified: after an automatic periodic settlement the lender
receives slightly more than the period's shortfall, because the collateral
sale is sized with a buffer and the specification does not say who keeps it.
Every refusal the walkthrough checks is now checked by the error's name, so a
guard that disappears cannot hide behind an unrelated later refusal, and
every step that moves money — from the first offer to the last claim, across
the early exits, the refinance, the offset and the rental — now reconciles
exactly against the specification's own arithmetic, including the split of a
forced close between the keeper, the lender, the treasury and the borrower.
No fee rate, share, floor or window is written into the walkthrough any more:
each is read from the deployment, or from the loan's own record of the terms
it opened on, so a legitimate change of configuration can neither break a
correct check nor pass a wrong one. Every claim is checked on both sides of
the transfer, position NFTs after a claim are checked against the
specification's closure rule, and the administrator the walkthrough acts
through is whoever holds the role on the live deployment rather than the
address the deployment record names. One figure is read rather than
predicted, and the write-up says why: the size of the collateral sale in a
full repayment from collateral, which is exactly what the pending fix
changes. The re-run records one hundred and forty-five passes, ten
observations and one failure —
the swap-to-repay check whose expectation was deliberately corrected — with
no scenario file aborted.
