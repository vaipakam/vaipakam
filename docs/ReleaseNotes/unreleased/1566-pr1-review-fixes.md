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

An unconfigured chain becoming a mirror levels its delivered counters
again.

The day-to-era lookup is now a binary search, so a deep era registry can
never stall a claim or a closure. Holding or releasing an
era's room now emits an event. An era cannot finalize while a staging record
still holds part of its row. The custody cutover version is now 4. An era release or
a surplus drain counts as a re-credit, not a delivery, so the
counted-funding view still reconciles against what Base sent. The
reconciliation queue views answer only the era their queues are kept under.

A parked legacy broadcast whose day has since landed by another route with
the same content now retires as applied, as the newer broadcast kind already
did. The remittance destination gas budget is now derived from the measured
cost of each wire's ingress plus a reserve for the receiver. Two gas cells
pin it. The old 300,000 sat below even the older wire's cost, so a delivery
to an activated mirror could not execute on arrival.

A service operator's capacity-deposit withdrawals, live or from a retired
rotation epoch, now count as exits for the Terms gate, as the app's own rule
for returning a user's assets requires. Posting a deposit stays gated.

**Pre-open re-review (2026-10-12).** Three more review passes over the custody-era revision and the fixes above found no fund-losing defect; the smaller findings are fixed here.
- An administrator's correction of a reconciliation entry is refused when the entry's packet belongs to a retired era, not only when the entry itself was made in one: that packet's value sits in the retired era's holding, which a correction would have moved as if it were live.
- The lifetime cap on funding the reward pool now counts delivered value net of the in-holder re-credits that era releases and surplus drains make, the same way the delivered-position figure does; a legitimate funding near the cap is no longer refused.
- A day the loan-side cap trims to nothing is no longer retired once its entry's expiry has begun: from then on the expiry sweep settles it, so one day is never settled two different ways depending on which call came first.
- A claimant can no longer cancel the staging record of their own expiry before its deadline, as they already could not for a forfeit.
- The keeper's match pass now reads its pre-match check from its own account. The check's capacity test keys on the caller, and a read with no caller always looked covered, so an exhausted keeper never saw the refusal it was built to see.
- Comments that still described the removed role freeze and backfill, and a few others the fixes had overtaken, were corrected.

**Offer-match split.** The comments, messages and docs that still named the
old hosts were corrected, and an unused import was removed.

**The custody eras, revised (owner decisions, 2026-10-12).** Each mirror's
day report now carries the custody era it is live in, and the canonical
chain stamps every remittance with the era the destination last reported,
so a delivery always names the era it will land in. A mirror that cannot
yet send the new report falls back to the previous one, and the canonical
chain accepts both. What the destination then does with a delivery's era,
and why no era step is manual any more, are in the slice 4 PR C-3 and PR C-5
entries.

**Codex review, round 1 (#2459).**
- **Capacity-deposit screening (P1).** A chain that has ever configured a sanctions oracle now treats switching it off as an outage: deposits and withdrawals defer until an oracle is installed again. Before, switching it off silently turned screening off, which could have released principal that had to stay frozen. A chain that never configured an oracle runs the deposit surface open, as before. One rule now serves every deposit mutation and the post's preview.
- **Capacity curves.** The per-action cost and the free refill rate need a resolution of at least a million units. Rounding then never costs more than a millionth of an action, and no armed deposit buys nothing until a threshold.
- **Park-release event.** The event is now announced as the release found the record, before a raise, so its two balances agree.
- **Late B4 reports.** A day report that reaches the canonical chain after its day finalized still updates that chain's custody era. Its figures are dropped and named by an event, instead of the whole message failing for good.
- **Claim Center rewards.** A paused or held claim now shows as unavailable, never as "nothing owed".
- **Clean-up.** The transport-epoch release entries were documented as still shut, though this PR opens them. The text is corrected, and the interim error they used to raise is removed.

**Codex review, round 2 (#2459).**
- **Match preview.** The match preview now takes the matcher as an explicit input and checks that account's capacity. Before, it checked whoever made the call, and a call from an off-chain tool carries no caller, so an exhausted matcher was told a doomed match would succeed. The app passes the connected wallet and the keeper passes itself.
- **Capacity curves.** A curve's refill rate and the deposit at which capacity reaches four times the free tier are now bounded, so no accepted curve can make a capacity calculation fail. The arming fee is computed in full precision.
- **Sanctions oracle.** Its documentation now says that switching it off, on a chain that ever configured one, freezes capacity deposits until an oracle is installed again.

**Codex review, round 4 (#2459).**
- **Demoted compensation credits.** A provisional compensation that is later demoted is now taken back from where its value actually is. The platform records where the credit was booked and, when a retired era is finalized, where that era's value went, and the demotion follows those records: the era's own holding while it is open, pending surplus after a finalization while detached (then the live balance that surplus was drained into), or the later era a finalization's value went into. It never takes more through a finalization than the finalization carried, since what the era paid out before it is gone. Before, the demotion guessed the location from the chain's role at the moment of the demotion, so after a detached finalization and a reattachment it took unrelated live backing and left the credit itself behind.
- **Who capacity charges, and what the previews check.** Every capacity charge now names the charged account through one rule, which runs in one place, and the match and intent-fill previews take the outer initiator as an input. A backstop fill's preview names the account that will trigger the fill, not whatever the read's own transaction carried, so an exhausted caller is told the fill will be refused. A match sent through an aggregator adapter is now charged to the operator bound to that adapter, as the design requires, instead of the adapter contract, and so is a keeper action an adapter takes. The previous preview entry is removed from the refresh scripts' routing, so no deployment keeps the old one live beside the new one.
- **Arming fee ceiling.** The arming fee rate and its floor can no longer be set above the whole newly-armed principal. A higher setting is refused by name, so no accepted fee can make a post or its quote fail.
