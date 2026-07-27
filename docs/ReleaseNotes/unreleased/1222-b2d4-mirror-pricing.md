## #1222 M3 B2-d4 — mirror chains can price their own reward claims again, once their funding has actually arrived

Stage B2-d4 of the recycling completion programme (plan #1348 §M3; umbrella
#1349; design record `Vpfi1222B2dDeliveredBackingDesign.md` §2g). It removes the
last blocker on multi-chain reward claims.

**What was blocked.** Since the per-chain funding stage, a chain other than the
canonical one simply refused to price reward claims for any day under the new
funding model. That was deliberate: such a chain's reward funding arrives by
remittance, and until the previous stage nothing recorded those arriving tokens
against the chain's own recycled balance — so paying a claim from that balance
would either fail outright or quietly spend balance the chain had absorbed for
other purposes. The refusal was a safety backstop, and it made the whole
multi-chain reward path unusable in practice.

**What changes.** The previous stage records arriving remittances against the
receiving chain's recycled balance, so claims there now have genuine backing.
This stage lifts the refusal, and every chain prices its own reward days from
its own funding figures.

**A narrower wait replaces it — and this is the part worth understanding.** The
refusal is not simply deleted. A chain now waits for a day's **funding to have
arrived**, not merely for the day's funding *instruction* to have arrived.
Those are two separate messages: the instruction lands first and describes the
day as funded by a mix of the chain's own balance and a top-up from the
canonical chain, but only the chain's own share is actually present at that
moment — the top-up, and the entire freshly-issued portion, arrive later with
the tokens themselves.

Paying in that gap would not have failed loudly. The claim path checks the
freshly-issued budget against its lifetime ceiling, but performs no equivalent
check on the recycled side, because on the canonical chain that side is
guaranteed by construction: its funding figures are sized against its own
balance. That guarantee does not transfer to a receiving chain. And the routine
that draws down a recycled balance floors at zero rather than refusing, so the
result would have been a silent shortfall — the balance bottoming out, the
lifetime paid-out figure over-counting, and the payout itself coming from
unrelated custody the platform holds for other purposes.

So a receiving chain now prices a day only once that day's funding has actually
landed. This is exact rather than cautious: the canonical chain includes a day
in a remittance whenever it funds anything at all, and every payable day carries
a freshly-issued component it funds — so a day whose funding never arrives is a
day with nothing to pay there. No payable day can be stranded by the wait.

The canonical chain is explicitly exempt, since nothing is remitted to it;
that exemption is asserted directly in the tests, because it is the one way this
wait could have caused broad damage. Reporting is unaffected — a chain can still
report a day's expected liability while it is not yet able to pay it, which is
what keeps the funding cycle moving.

As with every stage of this programme, none of it is reachable until the
operator arming ceremony, and single-chain deployments are unaffected.
