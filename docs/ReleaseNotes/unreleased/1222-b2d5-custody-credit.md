## #1222 M3 B2-d5 — a chain's own absorption stops being confused with tokens the platform sent it

Stage B2-d5 of the recycling completion programme (plan #1348 §M3; umbrella
#1349; design record `Vpfi1222B2dDeliveredBackingDesign.md` §2f). It closes the
last accounting gap between a mirror chain's recycled balance and what that
chain truthfully reports about itself, and it is the stage that makes mirror
reward claims safe to switch on.

**The problem it fixes.** When the canonical chain tops up a mirror chain's
reward budget, real tokens arrive on that chain. Until now nothing recorded
them against that chain's recycled balance — the balance was only ever credited
by the chain's own absorption. But when users on that chain claim their
rewards, the payout is drawn down against that same balance in full, without
distinguishing which part the chain funded itself and which part arrived from
the canonical chain. A chain that funded 40 of a 63-token day and received the
other 23 would draw 63 against a balance that only ever recorded 40. The
shortfall did not lose anyone's tokens, but it corrupted the chain's own
bookkeeping — and that bookkeeping is exactly what the canonical chain reads to
decide how much that chain can fund next time.

**Arriving top-ups are now recorded as relocated custody.** A remittance now
states how much of it is recycled, and the receiving chain records that portion
against its recycled balance so the claim path has real backing. Critically,
this is recorded as a *relocation of custody*, not as absorption. Those tokens
were already counted once as absorbed on the canonical chain when they first
entered the recycled economy; counting them again on arrival would let a single
protocol receipt cycle round — balance, budget, expiry, balance — and
manufacture repeat reward budget with no user activity behind it.

**The exclusion had to be wider than it first looked.** Keeping relocated
custody out of the daily absorption figure is not enough on its own. Each chain
also reports a lifetime absorption total, and the canonical chain derives two
separate things from it: how much that chain may fund locally, and how much
day-by-day absorption it is allowed to claim. Letting relocated custody into
that lifetime total would have handed the canonical chain a phantom balance —
it would have read its own already-spent top-up back as the mirror's own money
and committed it a second time. So a relocated-custody total is tracked
separately and netted out of the figure each chain reports. The netting holds
even after the tokens are claimed, which is the case that matters, because
claiming moves value between the two quantities the reported figure is derived
from.

**Reporting keeps a separate channel.** The relocation is announced on its own
event rather than being folded into the existing absorption event with a new
label. Every existing reader of that event treats it as absorption, so reusing
it would have manufactured absorption in the reporting layer even while the
on-chain figures stayed correct — and silently, in any reader not updated at the
same time. A distinct channel makes an un-updated reader under-count, which is
visible and conservative, instead of over-count.

**Compatibility and safety.** Remittances sent before this change decode as
carrying no recycled portion, which reproduces exactly the previous behaviour —
no credit rather than a wrong credit. A remittance that claims more recycled
backing than it actually delivered is rejected outright, and a delivery that
arrives short (for tokens that charge on transfer) has its recycled portion
scaled down to what genuinely landed. As with every stage of this programme,
none of it is active until the operator arming ceremony; single-chain
deployments are unaffected.

**Upgrades cannot be applied half-way without noticing.** The chains in this
mesh are upgraded one at a time, and the canonical chain goes first — so there
is always a window where it has started stating the recycled portion while some
receiving chain has not yet learned to read it. The new message is deliberately
shaped so that an un-upgraded receiver cannot misread it: rather than looking
like a slightly longer version of the old message — which an old reader would
have accepted while quietly discarding the new fields, stranding the sender's
record and skipping the credit — it is marked such that an old reader rejects it
outright. The delivery then fails loudly and is re-delivered once that chain is
upgraded, so nothing is lost and nothing is silently mis-recorded. This makes
the upgrade order impossible to get wrong, rather than merely documented; it
needs no operator switch. The same reasoning applies to the operator's in-place
refresh tooling, which now upgrades the receiving component alongside the rest
and refuses to proceed on a receiving chain whose record of that component is
missing.

The off-chain indexer is deliberately left un-updated here: it records
absorption from the existing event, and relocated custody is correctly absent
from absorption, so its figures stay right. Surfacing the relocation itself
belongs with the transparency-metric milestone that consumes it.

Follow-up: with the backing now real, the next stage lifts the halt that
currently stops mirror chains from pricing reward claims on armed days.
