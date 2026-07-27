## #1222 M3 B2-d4 — every chain can price its own reward claims again

Stage B2-d4 of the recycling completion programme (plan #1348 §M3; umbrella
#1349; design record `Vpfi1222B2dDeliveredBackingDesign.md` §2g). It removes the
last blocker on multi-chain reward claims.

**What was blocked.** Since the per-chain funding stage, a chain other than the
canonical one refused outright to price reward claims for any day under the new
funding model. That was deliberate: such a chain's reward funding arrives by
remittance, and until the previous stage nothing recorded those arriving tokens
against the chain's own recycled balance — so paying a claim from that balance
would either fail or quietly spend balance the chain had absorbed for other
purposes. The refusal was a safety backstop, and it made the multi-chain reward
path unusable in practice.

**What changes.** The previous stage records arriving remittances against the
receiving chain's recycled balance, so claims there now have real backing. The
refusal is lifted, and every chain prices its own reward days from its own
funding figures, exactly as the canonical chain always has. The one genuine wait
that remains is unchanged: a chain still cannot price a day whose funding
figures have not yet reached it.

**Why lifting it does not expose an unbacked payout.** A receiving chain's
funding figures arrive before the tokens do — the instruction describes the day
as funded partly from the chain's own balance and partly by a top-up, and the
top-up lands later with the remittance. In that gap the instruction promises
more than the chain holds. The protection already exists and is not new here:
when a claim walks a day, it budgets the recycled portion against the chain's
*live* balance and simply **defers** any day that balance cannot cover, moving
on rather than paying. So the shortfall never reaches the point where the
balance is drawn down. The deferral is not a stall — the day becomes payable as
soon as its funding arrives, and the claim can be retried immediately.

That property is now asserted directly for a receiving chain, rather than left
implicit: a recycled-funded day with an empty balance pays nothing, and the same
day pays once its backing lands.

As with every stage of this programme, none of it is reachable until the
operator arming ceremony, and single-chain deployments are unaffected.
