## Thread — #1349 / #1956 programme, PR 1 pre-open review fixes

Before PR 1 of the recycling programme opened, an adversarial and security
review of the whole diff ran in four parts: service capacity (#1219), the
custody eras, the staging and transport epochs, and the offer-match split.
This entry records what that review changed. Refs #1349, #1956, #1219, #1566.

**Service capacity.** A curve retune no longer locks out an operator last
seen under the old terms: from its next touch, the bucket holds what the new
curve has earned since the retune took effect. Raising the point where
capacity stops growing no longer arms principal for free. The armed balance
is the principal at the time it was armed, never more than that point. The
newly covered principal is armed by a later paid post, which may add no new
principal. A withdrawal never arms what it leaves behind.

The backstop's fill draws from a free-tier bucket of its own, so it can never
cut credit a deposit bought. An adapter with no bound operator charges the
outer initiator's free tier, never the adapter contract. An adapter's own
roll of a matured loan charges its bound operator. A fill is charged after it
executes, and every match and intent preview now reports a fill the bucket
cannot cover, at the point the execution would refuse it. The keeper reads
that refusal and stops spending a pass on it.

Previewing a post now walks the post itself. The fee rounds up. A released
parked withdrawal pays the larger of the parked cap and the amount then
asked. A clean post on a parked record releases the park. Events now carry
the token and the armed balance, and a dedicated event announces each
free-tier charge.

**Staging and transport epochs.** A day the loan-side cap trims to nothing
for its owner is now retired the way a claim retires a capped day: the
commitments are released, and nothing is paid, credited to the recycle
bucket or drawn from the pool. It used to be priced as an expiry, which
paid out the capped share. A multi-call claim's extent is revalidated after
every lifecycle change, not only the first. Each legacy slice keeps day
records of its own, so two slices of one claimant can no longer consume each
other's coverage. A slice opens its domain only once its loan has closed.

A staged expiry keeps the expiry sweep's own rule: before removal begins, a
shortfall under the emission ceiling waits instead of being written off. A
legacy slice whose record overflows its pending list now consumes what that
record holds. Before, the next preparation reverted, and that blocked every
claim of the owner.

A day no epoch lists no longer lengthens a domain's deadline, so a long
live-only extent can no longer hold reward-role changes and custody
activation for most of a year. A claim's named venue binds its domain. A
domain's pages walk only the records the domain owns, so another sweep's
record on a gap day no longer blocks them. A page that resolves or unwinds a
batch-bearing record ends there, which keeps every call inside the block's
gas. A forfeited party can no longer cancel the forfeit sweep's record before
its deadline. Once the priority winner has taken its share of a batch, the
rest of the batch is anyone's to stage. A priority right left to lapse is
burnt when the next window opens, exactly as a taken one is.

**Custody eras.** Proving a day closed now needs only that the interest fold
has reached it. The chain's own day close used to be required too, and that
close becomes permanently impossible once Base finalizes the day first, or
while a mirror is detached. Such a day would have kept its era unfinalizable
for good, and through the era's row blocked every VPFI token rotation. The
rotation runbook now names the era rows.

Two activation-order fixes:
- Completing the history backfill before custody activation no longer
  freezes role changes for good.
- An unconfigured chain becoming a mirror levels its delivered counters
  again.

The day-to-era and time-to-era lookups are now binary searches, so a deep
era registry can never stall a claim or a closure. Holding or releasing an
era's room now emits an event. An era cannot finalize while a staging record
still holds part of its row. The pending-surplus drain stays dark until the
backfill completes. The custody cutover version is now 4. An era release or
a surplus drain counts as a re-credit, not a delivery, so the
counted-funding view still reconciles against what Base sent. The
reconciliation queue views answer only the era their queues are kept under.

A parked legacy broadcast whose day has since landed by another route with
the same content now retires as applied, as the newer broadcast kind already
did. The remittance destination gas budget is now derived from the measured
cost of each wire's ingress plus a reserve for the receiver. Two gas cells
pin it. The old 300,000 sat below even the older wire's cost, so a delivery
to an activated mirror could not execute on arrival.

**Offer-match split.** The comments, messages and docs that still named the
old hosts were corrected, and an unused import was removed.

**Still open, for the owner.** Two items wait on an owner decision:
- How a sender addresses the destination's era: rooted remittances still
  carry era zero, so a mirror's role change would quarantine them. Routing
  classification and corrections to a packet's era goes with that decision.
- Whether to turn the backfill's attested packet count into an on-chain
  proof.
