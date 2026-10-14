# Release Notes — 2026-10-13

Two pull requests with release notes merged on this day. The large one is the
first of three that close out the VPFI recycling programme (#2459, the
recycling core). It brings the transport epochs that let a reward delivery
travel committed to its days, the custody eras that carry a chain's reward
custody across a change of role, the per-day closure proof that lets anyone
finalize an era once nothing on it is owed, and the service capacity deposit
for solvers, matchers and keepers, with its limiter and arming fee (#1219).
Eight rounds of review left one design change worth stating up front: a
compensation that arrives before its day's broadcast is now held apart, in
an attribution of its own and counted as neither funded nor uncounted, until
that broadcast confirms or rejects it, instead of being counted on arrival. Nothing has to be chased back out of shared funds when one
is rejected. The other merge (#2461) records, for a position, what was lent and
what is locked now (#2453, #2454). Nothing here is deployed yet: the contracts reach
testnet together at the end of the programme.

## Thread — an operator can now hold a service capacity deposit, in its own escrow, behind a switch that ships off (#1219 slice 1)

**Problem.** The VPFI circular-flow programme's one genuinely new sink is a deposit that lets solvers, matchers and keepers buy operational capacity above the free tier. The design is merged and the owner has decided its shape: the deposit is refundable, earns nothing, and is never at risk — version one has no slash of any kind — and it ships dark, because VPFI is earn-only at launch and a required deposit would make the gated roles unreachable. Nothing of it existed in the contracts.

**What changed.** An operator can post VPFI as a capacity deposit for one role, raise it, and withdraw it immediately. The principal lives in an escrow of its own — a holder contract that moves tokens only at the platform's instruction — never in the reward custody and never in the platform's own balance, so reward payouts never see it and the backing figures the reward gates read gain no new term. Every record is kept per role, per operator and per VPFI rotation epoch, with the armed balance recorded beside the principal (equal to it while no arming fee exists) and published together with the escrow's total for the live epoch. Every change emits an event carrying the post-balance.

**Dark by default.** The channel ships off: posting is refused by name until the admin enables it, while withdrawals always work and the permissionless free tier is untouched. Enabling it is a deliberate later act, gated on VPFI being distributed widely enough that the roles it raises stay contestable.

**Sanctions, on every value-moving selector.** The screen is the registry-aware three-way read. A first authoritative flag on a post is a committed, value-unmoving refusal: the call returns a refusal status, persists the flag, and moves nothing; a first flag on a withdrawal parks the request, capped to the principal, and pays nothing — frozen funds are never seized. With the flag already persisted the next call takes the ordinary sanctions revert. An oracle outage defers every mutation, for every party, and persists nothing; the same calls succeed on the first clean read after recovery. A clean read heals a stale persisted flag, and releases a parked deposit's cap.

**Not in this slice.** The capacity curve and the limiter that prices throughput, the gating of the match and keeper routes, the arming fee's shape, and the rotation-epoch archival are the next two slices. No slash exists and none is planned for version one.

**Spec:** TokenomicsTechSpec gains section 6c (service capacity deposits).
<!-- assembled-fragment: 1219-service-capacity-1-deposits.md sha256=627b80d37fb1a7c4a2de6b43be14860a3b7456bf594d1d7732ba6078aedffe7b -->

## Thread — capacity now has a price curve and a limiter, and every solver and keeper route pays one action at the right actor (#1219 slice 2)

**Problem.** The first slice let an operator hold a capacity deposit, but nothing yet turned a deposit into throughput, and no route charged anything: the deposit was a record with no effect.

**What changed.** Each role has a capacity curve the admin sets: a free tier (the permissionless baseline, floored at one action), its refill rate, the deposit at which capacity reaches four times the free tier, and what one executed fill or action costs. Every operator's bucket for a role refills at the operator's own rate from the operator's own last touch and is clamped to the operator's own ceiling — continuously and proportionally to the deposit, with no minimum and nothing unlocked at a threshold. A bucket seen for the first time holds exactly one free action — the baseline every operator has — and never deposit-derived credit, so a fresh address buys no burst. Any change of capacity — a deposit raised or withdrawn, a curve retuned — settles the credit earned so far under the old terms before the new ones apply; a retune resets every bucket at its next touch rather than silently re-crediting it. Until a role's curve is set, its limiter is dark: nothing is charged and nothing is refused.

**Where it binds.** The three solver entries (matching two offers, matching a signed offer, filling a lender intent) and the ten keeper-gated actions each charge one executed item, refusing by name when the actor's bucket cannot cover it — and only the actor the route rules name: a direct solver pays at their own capacity; an adapter's fill is charged to the operator bound to it when the adapter was created; the backstop's fill is charged to whoever triggered it, at their free tier only, never to the shared vault; and a keeper's action is charged to the keeper — an owner acting on their own position is never capacity-gated. A reverted action is not charged, and an admitted one is charged exactly once.

**A host split, not a byte shave.** The offer-matching facet sat a few hundred bytes under the EIP-170 size limit, so the three fill gates could not fit in it. The standing-intent fill — the entry the solver, backstop and adapter routes use — now lives in its own facet, and the match-execution core every match entry shares moved into one library both facets compile in: one source, two hosts. Same storage, same Diamond, same selectors; callers change nothing, and a future change to either host no longer competes for the last bytes of the other.

**Not in this slice.** The arming fee's shape and the rotation-epoch archival are slice 3.

**Spec:** TokenomicsTechSpec section 6c gains the capacity and limiter paragraph.
<!-- assembled-fragment: 1219-service-capacity-2-limiter.md sha256=0f62b7479da2815ab1ab1014522b99fc206bcd6a962b8cda38bd2cd18299bf3d -->

## Thread — arming a capacity deposit now carries a fee with a floor the code enforces, and a VPFI token rotation retires the deposit epoch atomically (#1219 slice 3)

**Problem.** The first two slices let an operator hold a deposit and turned it into throughput, but the deposit was free to arm — the design's fee, the one genuinely new VPFI sink in the circular-flow programme, had no shape yet — and a token rotation would have stranded every deposit behind a pointer-only switch, which the rotation runbook had already named as a shipping prerequisite of enabling the channel.

**The arming fee.** Posting or raising a deposit pays the platform an arming fee: a governance-set rate over a positive floor the code enforces (the floor is raise-only and never returns to zero; a positive rate may not sit under it). The fee is charged only on the principal the post newly arms — nothing on principal above the point where capacity stops growing — so a capacity-neutral raise is accepted and pays nothing, and principal armed again after a withdrawal pays again. It is paid beside the principal, never out of it: the escrow holds the principal only, and the fee goes into the platform's recycle bucket through its own provenance-verifying entry, recorded under its own source class. The post binds what the payer reviewed — the fee, the capacity the deposit buys afterwards, the rotation epoch and the curve version — and refuses by name, naming the term, if any moved. The quote is the walk the post executes.

**Dark until lit.** While no positive rate is set, or a role has no curve, arming is dark: posting is refused by name and withdrawals stand. The channel ships with the rate at zero and the switch off, so a deployment posts only once governance has set both.

**Rotation epochs.** A VPFI token rotation now retires the live deposit epoch in the same transaction as the pointer change: its principal stays in the escrow, keyed by the retired epoch, in its original asset; a new epoch opens under the new token; every role's curve is cleared, so a token of different decimals can never inherit the old thresholds — the limiter and arming are dark until the admin sizes a curve for the new token. A retired deposit buys no capacity and is withdrawn in full, in its own asset, under the same sanctions rules as a live one; the first touch of a retired record announces it as archived. An operator holding principal in a retired epoch must withdraw it before posting under the new token. The retired epochs, their assets and their totals are readable, and the rotation runbook's post-rotation step now names the exact effects to read back.

**Spec:** TokenomicsTechSpec section 6c gains the arming-fee and rotation-epoch paragraphs. **Runbook:** the VPFI token rotation runbook's deposit-custody passages and its step 7 name the shipped hook, views and drain.
<!-- assembled-fragment: 1219-service-capacity-3-arming-and-rotation.md sha256=458d6cec33a8d183877a7ecbdcfb0dae57bb0d3246060b87029ebfa9f0734e77 -->

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
- **Demoted compensation credits.** Round 4 made a demotion follow the credit through the custody moves recorded since it was booked. Round 5 replaced that approach; see below.
- **Who capacity charges, and what the previews check.** Every capacity charge now names the charged account through one rule, which runs in one place, and the match and intent-fill previews take the outer initiator as an input. A backstop fill's preview names the account that will trigger the fill, not whatever the read's own transaction carried, so an exhausted caller is told the fill will be refused. A match sent through an aggregator adapter is now charged to the operator bound to that adapter, as the design requires, instead of the adapter contract, and so is a keeper action an adapter takes. The previous preview entry is removed from the refresh scripts' routing, so no deployment keeps the old one live beside the new one.
- **Arming fee ceiling.** The arming fee rate and its floor can no longer be set above the whole newly-armed principal. A higher setting is refused by name, so no accepted fee can make a post or its quote fail.

**Codex review, round 5 (#2459).**
- **A provisional compensation is held apart until it settles.** A compensation that arrives before the day's broadcast is no longer counted on arrival. Its value now waits in a custody line of its own, counted as neither funded nor uncounted and backing no claim, until the broadcast confirms or demotes it. Confirmation counts it once, for exactly the amount held, and credits it to the day's era as if it arrived at that moment. Demotion moves it, untouched, to where the return to the canonical chain draws it from.
- **Why.** Counted on arrival, the value joined live funding, and later role changes, era closings and surplus drains carried it into shared pools. A demotion then had to chase it through moves that no record could trace exactly, and three review findings came from that. Held apart, nothing ever moves it, so a demotion is exact. A new view reports the amount held, so what the canonical chain sent always reconciles as counted plus uncounted plus held.

**Codex review, round 6 (#2459).**
- **Token rotation waits for a held compensation.** A held provisional compensation is in the token it arrived in, and its record does not name a token. The reward token can no longer be rotated while any such hold is pending, including a hold made before custody activation, which rests in the platform's own balance. The rotation runbook lists the new precondition.
- **Late day reports keep the chain-wide figures.** A day report that reaches the canonical chain after its day finalized still drops that day's figures, but now applies the reporting chain's cumulative recycled availability and its commitment retirement and release totals. These describe the chain, not the day, only ever move forward, and are checked against the canonical chain's own records. Before, a chain whose last report arrived late, or that then detached, left already-retired commitments counted as outstanding.

**Codex review, round 7 (#2459).**
- **Late day reports are visible to the indexer.** When a late report advances a chain's recycled availability, the canonical chain now emits the same availability event an on-time report emits, with no day credit, so the indexer's recycling figures track what the chain holds.
<!-- assembled-fragment: 1566-pr1-review-fixes.md sha256=da95ad99447f937f44d7f2137aa13135b3f94e9a514a64c8c7a0fbc87b4fb6c3 -->

## Thread — a chain's reward role lives in eras: a role change carries the delivered custody into the retiring era instead of levelling it away (#1566 slice 4 PR C-1)

**Problem.** When a chain changed its reward role, the delivered-fresh residual was retired by levelling the paid counter up to the received one. That erred safe — the chain resumed with no headroom — but it left the custody that residual backed sitting in the live row with nothing that could spend it, and it recorded no history: after two transitions nobody could say what the first era had delivered, what it still owed, or when it ended. The design's answer is an era registry: the span of a role between two changes is an era; a change retires the live era and opens the next; what the retiring era delivered stays with it, consumable by the obligations accrued in it and released only when it is terminal.

**What changed.** The custody era registry exists: the live era's id, and per era its holder row, a count of how many of its days the per-day closure proof has proven closed, the day it opened on, and a terminal flag. On an activated custody, every effective role change — any change of the four-state role, not only of the mirror predicate — retires the live era: the live-fresh row moves, inside the holder, into the retiring era's holder row; the delivered counters are levelled so the new baseline opens with no headroom; a deficit the old baseline owed is not erased but recorded as the new era's opening deficit, which the first credit of the new era covers first under the deficit split; and the next era opens with today's reward day as its boundary. Era rows join the attributed total, so the invariant that attributed custody never exceeds the holder's balance now covers them. Before activation the registry is untouched and the counters are levelled as before, so every pre-activation figure belongs to the first era. A direct promotion out of the detached state is such a change too: the counters leave it with the paid side levelled up to the received side, so a received history that was never retired on the way in cannot surface as delivered headroom on the way out.

**Two attribution writers.** The era-terminal release finalizes a retired era that is free of outstanding liability — every day of its span proven closed by the existing per-day closure proof, which anyone may run, and so counted on the roomy closure facet rather than written on the loan path — with nothing staged holding its row; it releases its row — to the live baseline under the deficit split on an active role, into the pending-surplus row while the chain is detached (never into recovery). The pending-surplus drain credits that row to the live baseline once an active era exists. Both are deterministic bookkeeping over custody the holder already holds, so both are permissionless, and both share the one fresh-credit rule every ingress uses. Neither waits on a manual step.

**What follows.** The per-era decomposition of a claim's need, the era of an arriving delivery and of every later credit, the parked lane for era-less broadcasts, and the removal of the role freeze this carry-forward makes unnecessary are the following slices of this programme.

**Spec:** TokenomicsTechSpec, slice-4 bullets gain a third change (the era registry and the carry-forward).
<!-- assembled-fragment: 1566-slice4-prc-1-era-registry.md sha256=7a6e9ac322444b27d9a4ae58f5a818cd0e322e170f0d2ad66e6fcfbfd31ae5e8 -->

## Thread — an obligation accrued in a retired era is paid from that era's custody first, and the live bound is charged only for what the live era funds (#1566 slice 4 PR C-2)

**Problem.** The previous slice made a role change carry the delivered custody into the retiring era's holding instead of levelling it away, but nothing could yet spend that holding: every reward settlement read one delivered bound and one live row. An obligation accrued before the change — a loan that earned its reward in the old era — would have waited on live headroom the new era had not received, while the custody that was delivered for exactly that obligation sat in the era's holding.

**What changed.** Pricing a day now follows the design's order: the day's matching transport epochs first, then the era the day was live in, then the live baseline. Every day belongs to exactly one era — the newest era whose boundary day is at or before it — so an era is debited only for days that were live in it, which is the design's "each era's debit capped by the need accrued in it" by construction. The era's holding funds what the epochs did not, up to its room (the holding net of what standing staging reservations already hold); only the rest is held against the live bound. The era-funded part is split between the claimant and the treasury exactly as the transport legs are, folded through the same accumulator, and settled per day as a movement inside the custody address from the era's holding into the live row, so the payout or the absorption that follows leaves the custody address exactly as a live-funded one does. The delivered bound is charged only for the fell-through portion; a retired era's contribution charges nothing, because that era delivered it before. Sweeps that absorb an obligation into the recycle bucket account the era-funded part as its own class, counted apart from live-funded absorption, so the bucket's composition names it. A staging record that spans several calls holds its era legs against the era's room and releases them when it resolves (consumed) or unwinds (restored); a reserved record's re-pricing reads what it holds rather than allocating anew.

**What does not change.** With a single era — every deployment today — no retired era exists, every era room is zero, and every figure is byte-identical to before; the whole reward suite is that regression. The live era's custody is the live row itself, so a day in the live era finds no era room and prices as it always did.

**Spec:** TokenomicsTechSpec, slice-4 bullets gain a fourth change (the era term of a day's reward funding).
<!-- assembled-fragment: 1566-slice4-prc-2-era-decomposition.md sha256=ec6c172c73f222fb78793da11193e796d440e65a095bf4c65ba5e2616ab5fdf1 -->

## Thread — an arriving delivery belongs to the era it was dispatched for, and every later credit of its value follows that era (#1566 slice 4 PR C-3)

**Problem.** A remittance in flight across a role change could land in the new era and be credited there, while the obligations it was dispatched for belonged to the era just retired. The design asks the receive ingress to validate a delivery's intended era against the live one, and asks that value sent for an era stay with that era.

**What changed.** A rooted delivery names the custody era it was dispatched for — the destination's own, as the destination last reported it (the review entry for this PR describes the report). A delivery for an era AHEAD of this chain's live era cannot come from this chain's own reports: it means this chain's deployment was replaced and its eras restarted. It is taken into the live era and flagged for the operator rather than refused, because a refused delivery would stay undeliverable in transit for good. A delivery for an era this chain has already RETIRED is not held aside: it opens its epoch in that era, typed by the split its wire carries, and the obligations of the days it lists draw from it; nothing it carries reaches the live baseline. A delivery on the older list-bearing wire carries no era, so it is placed by the days it lists: listing only days from the live era's boundary on, it belongs to the live era and is taken as before; listing any earlier day, it belongs to the era of its earliest listed day and likewise opens its epoch there — typed from its own split when it carries one, made whole the way the rooted wire makes it (the recycled share as delivered, fresh the rest of what landed, so no wei is left that no day could draw), otherwise awaiting the canonical chain's split attestation like any untyped delivery; listing no day, it funds the live era, since it names no obligation of a retired one.

**Every packet carries its era, and every exit follows it.** Each packet is stamped at arrival with the era it belongs to: the era its wire names or its days place it in, a compensation the era of its day, any other the live era. Every exit that credits a packet's fresh value outside a draw — an administrator's classification, a compensation's credit — routes by that era: a live-era packet's value to the live baseline under the deficit rule; a retired era's, while that era is not yet closed, into that era's holding, counted as delivered and levelled at once, so the live baseline gains no headroom from value sent for an era it no longer is; a closed era's to wherever that era's own release went — the live baseline while a role is active, pending surplus while the chain is detached. A demotion takes its credit back from where it went. A reconciliation entry can be corrected only in the era it was made in: after a role change its value lives in the retired era's holding, so a correction is refused by name rather than moving the wrong era's custody.

**Spec:** TokenomicsTechSpec, slice-4 bullets gain a fifth change (an arriving delivery's era, and the era routing of every exit).
<!-- assembled-fragment: 1566-slice4-prc-3-era-validation.md sha256=b9b38c10754991ea4f0f4195b8e9fcb8732778a936a4348a5c47f6247c8d103a -->

## Thread — a broadcast the chain cannot route after its source rotated is parked with a recorded disposition, not bounced for ever (#1566 slice 4 PR C-4)

**Problem.** When a mirror's canonical source rotates, the older era-less broadcast wires can no longer be trusted to describe the live era, so the chain refused them — by reverting the delivery. A reverted cross-chain delivery sits in the transport's failed queue indefinitely, re-executable but never acceptable, with no record on the chain that it ever arrived and nothing an era's close-out could see. The design asks for a parked-message lane instead: accept the message, park it with its identity, let anyone retry it against the live gate, and let the operator tombstone what the gate will never accept.

**What changed.** The two refusals of era-less broadcasts (the older single-day wire and the older per-destination wire) now PARK instead of reverting: the delivery is accepted, no day state is installed, and a record is kept — the wire's kind, the day, a digest of the broadcast, the receipt time and the custody era live at receipt — and counted against that era, which anyone can read. Anyone may retry a parked broadcast by re-supplying it; the digest proves it is the one parked, and the same apply runs through the same gate, so it is applied exactly when the gate would now accept it and stays parked, by name, while the gate refuses. A broadcast first received after the first era closed is quarantine-only: it exits by tombstone alone, because the next era's opening never certifies a later arrival as belonging to it. The operator tombstones a parked broadcast with a recorded reason; that is an operator decision by design — the platform choosing to stop waiting on a message it cannot route — and an optional one: nothing waits on it. An era's closing does not wait on its parked broadcasts either, since every day of a closed era that carried obligations had its broadcast installed, so a parked copy installs nothing that prices one.

**Why the retry exists although today's gate never clears.** The rotation that retires the era-less wires is permanent on this tree, so a parked legacy broadcast is never re-accepted; the lane's value today is the record and the disposition. The retry keeps the design's shape at no cost, so a gate that can clear — the era registry replacing the rotation flag as the authority, in a later slice — has its retry ready.

**Spec:** TokenomicsTechSpec, slice-4 bullets gain a sixth change (the parked-message lane).
<!-- assembled-fragment: 1566-slice4-prc-4-parked-lane.md sha256=7c9cb189c391e348ab34e92370df7921411c89765fdda00f9477098dcc4699b1 -->

## Thread — no era step is manual, and the role freeze is gone (#1566 slice 4 PR C-5)

**Problem.** Once a chain's reward custody was activated, every effective change of its reward role was refused. A change used to level the delivered history away, which would have left the custody it backed stranded, so the freeze stood until history could be assigned to eras — and nothing on the chain could ever assign it, so the freeze never lifted. The carry-forward (slice 4 PR C-1) makes a role change safe: what the retiring era delivered stays with that era. An earlier revision of this slice lifted the freeze through a paused operator backfill of history; the owner decided the platform must not rely on manual updates and checks.

**What changed.** The freeze is removed. Custody activation no longer arms it, a custody credit no longer re-arms it, and the role setters accept an effective change on an activated custody, carrying the live custody into the retiring era; the one gate that stays is the staging gate, which refuses a change while a staging record still holds custody. The custody ledger view no longer reports a freeze flag, and the freeze getter is removed. History needs no assignment: every packet recorded before the era registry existed belongs to era 0, because no era can open before the registry does. An era closes once every day of its span is proven closed by the per-day proof, which anyone may run, and nothing staged holds its row; it waits on no operator step and no count of packets awaiting classification, since a packet classified later routes its value by its era (slice 4 PR C-3). The custody activation script no longer confirms a freeze.

**Spec:** TokenomicsTechSpec, slice-4 bullets gain a seventh change (no era step is manual).
<!-- assembled-fragment: 1566-slice4-prc-5-no-manual-era-step.md sha256=8d20bbff88d0f28f78bc89ce009ccaae3ec7c08b9fb8d16831b5117c1cea6b43 -->

## Thread — a sweep's wide day is staged like a claim's, under its own commitment (#1566 transport epochs 3b-ii-A2-ii, part a)

**Problem.** Until this change only a claim could stage a day that more epochs listed than one read could scan: a forfeit sweep or an expiry sweep reaching such a day deferred with nothing drawn and nothing kept, so a forfeited or expired reward on a wide day could never settle from its epochs — it waited on the live sources, which the staging change exists to keep it off.

**What changed.** A forfeit sweep's or an expiry sweep's wide day now opens a staging record exactly as a claim's does, under the sweep's own commitment (its entry and its operation), so the same preparation, reservation, resolution, unwind, deadline, stale-record and forfeit rules apply to it unchanged. Its close-out routes the day as the sweep itself would have: a forfeit's legs absorb into the recycle bucket as forfeited reward under its loan, an expiry's as expired reward, the expired totals are recorded on the entry and its expiry is announced when its last day settles, and no loan-side reward cap is charged for either. A sweep reaching a day a claim's record holds defers on it and opens nothing; a claim reaching a sweep's day is refused by the commitment.

**Every value movement is explicit, and in one place.** One leg settle now serves every close-out — the claim, both sweeps and every staged record's payout — taking the recycle source it absorbs under, so no two paths can route a leg differently. The record-opening step is hosted once, behind a Diamond-internal entry the claim walk and both sweeps reach by self-call, since the expiry walk's host has no room to carry it.

**Spec:** TokenomicsTechSpec, the staging change's bullet (a sweep's day).

## Thread — a released batch gets a priority window, keyed to the batch, and one priority reservation per obligation (#1566 transport epochs 3b-ii-A2-ii, part d)

**Problem.** The first staging change answered a record's unwind with a three-day cooldown on the obligation that unwound: the same claimant's day could open no new record meanwhile, while the coverage it returned was anyone's. That left the hostage the design names: two obligations under one controller can alternate — one unwinds, the other stages what it returned, unwinds in turn, and so on — so a batch never reaches the honest obligation that found it held.

**What changed.** A non-settlement release now puts a window on the **batch** it returned to, not a cooldown on the obligation. While the window stands, no record stages from that batch — the releaser included — though a claim or sweep that can settle its day in one call still draws from it directly. Records that found the batch contested (every unit of it held by other records while they stayed short) are marked as such and may register for the window; registration is permissionless and keeps a running minimum of the registrants' record-opening times, so the **oldest record** wins whatever order registrations or scans arrived in. Once the window closes, that registrant alone stages the batch — its one priority reservation, burnt for that obligation on that batch for good — and every other record waits until it no longer holds the batch (its resolution consumes it; its unwind returns it and opens the next window). A registrant whose right goes untaken for a day loses it; with no registrant, ordinary staging resumes the moment the window closes. Because the reservation is non-renewable per obligation and batch, the alternation burns each controlled obligation once and the oldest honest waiter is served at every turn. A record whose scan meets a batch its window withholds stops there and resumes at it on its next preparation, and a restoration it cannot yet stage stays unread — so a windowed batch is never passed over, never crowds out the record's bounded memory of epochs still untyped, and keeps the reservation refusing until the window admits the record.

**Every state is published.** The window, its releaser, its oldest registrant and whether a priority reservation is held are readable per batch, alongside whether ordinary staging is admitted now; a contested finding, a registration, a window opening and a priority reservation each emit an event. The obligation-keyed cooldown and its view are retired (their storage slot stays allocated, unread).

**Spec:** TokenomicsTechSpec, the staging change's bullet (the window and priority mode).

## Thread — a claim spanning more days than one settlement chunk decides as a DOMAIN: every day prepared, nothing paid until every day is reserved (#1566 transport epochs 3b-ii-A2-ii, part b)

**Problem.** A claim whose pending reward days exceeded one settlement chunk paid the first chunk's days at once and left the later chunks to later calls. The shared sources — the live delivered balance, the emission cap, each loan side's reward cap — could then be short for the later days after the early days' scarce allocation had already been paid out, and nothing could be undone.

**What changed.** Such a claim now opens a **domain** for the claimant and side: a committed extent — the entry set and the last day, fixed as a snapshot when the staging pass begins — and a preparation cursor. Each call prepares up to one chunk of days, opening a day record per day that holds the day's transport allocation and persisting nothing; a day no epoch lists keeps a record of its own place so its live residual can still be reserved; a day that prices to nothing takes its place with no record. Once the extent is prepared, anyone may run the domain's **reservation** pages: the claimant-side's entry lifecycle version is compared with the version at commitment — unchanged means nothing moved; changed means every day record is revalidated, and a stale one unwinds the whole domain — then a cursor reserves each day's residual from the live sources and the cap headroom in order, the domain's own earlier days counted as its own rewarded days and amounts for each loan side rather than as another holder's reservation. A day the sources cannot bear stops the cursor, announced, with the days before standing reserved and nothing paid; more funding lets it continue. Once every day is reserved the domain is **resolving** — irrevocable, beyond any deadline — and its records pay in day order, each on its own last page, the entries' cursors catching up as each day persists. The domain clears once its last record has closed. A one-chunk claim settles exactly as before.

**Deadline and teardown.** The domain's deadline is its opening plus one cadence per chunk of its extent plus every day record's own lease pages plus one grace, moving only upward and only while it has not passed; no record of a domain expires before the domain. Past it anyone unwinds the domain across calls, and the claimant may cancel it earlier while it stages or reserves; each record's unwind returns exactly what it held (and opens each returned batch's priority window), and the extent clears when the last record is gone — no new domain commits for the claimant-side before that. A domain's day record cannot be reserved, resolved or unwound on its own; those entries refuse it by name. The claimant may bind the venue the domain's days deliver to while it stages.

**Published.** The domain's phase, extent, cursors, live-record count, chunks and deadline are readable; its opening, each phase change, a reservation stop and its clearing each emit an event. The lifecycle entries live on their own facet, since the record facet sits within a few hundred bytes of the size limit, and its pages drive each day record through the record facets' own platform-internal entries, so the reservation, resolution and unwind machinery is compiled once and the domain facet carries only the ordering and the snapshot; the swap-to-repay close, which the lifecycle record had carried past the size limit, now reaches the reward close through the platform-internal hook the other terminal paths already use, with a failure still surfacing to the caller; for the same reason the record-opening seam and the window registration moved to the settlement facet.

**Spec:** TokenomicsTechSpec, the staging change's bullet (the multi-chunk domain).

## Thread — an entry's pre-arming slice consumes the epochs that list its days before the schedule funds it (#1566 transport epochs 3b-ii-A2-ii, part c)

**Problem.** A reward entry's days before the arming day — its *legacy slice* — are priced and paid as one whole, not day by day, so none of the staging changes reached them: a legacy slice whose days an old-wire delivery listed was still paid wholly from the live sources, and that delivery's coverage for those days sat parked while the funding every other claim shares was drawn down for a slice the delivery had been sent to pay. That is exactly the over-draw the third change exists to prevent, left open on one more path.

**What changed.** When a legacy slice is about to settle — by the claimant's claim, by a forfeit sweep or by an expiry sweep — and any day of its window is listed by an epoch, the slice first opens a **domain of its own**: the entry's pre-arming window, prepared one page of days at a time (a listed day with a priced share opens a day record under a legacy-slice commitment and scans the day's epochs for exactly that share, fresh only; a day no epoch lists, or whose share prices to nothing, takes its place with no record) and then **consumed** in day order — each record's staged coverage debited from its epochs into the domain's aggregate and the record closed — until the cursor passes the window. Until then the settlement defers and reports progress, each call running one page, and anyone may drive the slice home faster through a permissionless step. Once consumed, the settlement pays the slice **whole**, as before, but the part the epochs funded arrives as a transport leg from the epochs' custody and only the remainder is charged to the live sources: for a claim the leg goes to the claimant's side, for a forfeit or an expiry to the treasury's, absorbed in place exactly as the day-level legs already are. The slice settles once; the domain hands its held aggregate to the payout's row and is gone.

**Why a domain and not a day walk.** The slice is priced whole on purpose (the first regime's identity holds for the whole window and it is paid as one), so its days are never walked; the domain gives it the staging change's shape — prepared, then consumed, nothing paid until everything is in — without changing how it is priced. Each day's share is the day's step of the same minimum curve the whole-window price differences, so the days' shares add up to at most the whole and the live part is never negative; and a listed day the curve has not reached yet stops the preparation page rather than passing for nothing, exactly as the whole-window price waits for the same curve.

**What a legacy-slice record is not.** It is never reserved from the live sources, never paid by itself, never unwound and has no venue: the record facet's entries refuse it like any domain record, and only the slice's own pages move it. On a chain that has never admitted a transport batch the whole check is one read and the slice settles exactly as before.

**Published.** The slice's domain — its phase, window, preparation and consumption cursors, live records and the epoch fresh consumed — is readable per entry; its opening and its consumption each emit an event. As with the multi-chunk domain, the slice's machinery is compiled once: its gate and settle live on the domain facet and every settlement reaches them through platform-internal entries, and its per-record preparation and consumption run on the record facets that already carry those steps.

**Spec:** TokenomicsTechSpec, the staging change's bullet (the legacy slice).
<!-- assembled-fragment: 1566-transport-epochs-3b-ii-a2-ii-domains.md sha256=0f445d4890d0fde35640d0677b4a4eef562be9efe05ad95ce08f6e9f9b28919e -->

## Thread — the reward preview is the claim itself, and the expiry clock reads prepared coverage (#1566 transport epochs 3b-ii-A2-iii)

Until now the reward preview was a mirror of the claim: a dry run that re-walked the claimant's days and simulated every side effect the real claim has — the epochs it would draw, the cursors it would move, the day it would settle, and, since staging landed, the record it would open. Nine of the fifteen review rounds on the draws were that mirror drifting from the walk. This change retires the mirror. **A preview is now the claim, run in a frame that reverts at the end:** the claim entry gains a simulation form that executes the real claim for a named account and then always reverts, carrying the figures it would have paid. Nothing it did survives, no transaction can claim on another's behalf through it (it cannot succeed), and an off-chain caller reads the result from the revert data through an ordinary `eth_call`. The app's rewards panel reads it that way. Because it is the claim, it cannot drift from the claim.

**The callers that cannot make a call keep a read-only path, and it changed shape.** The expiry clock, the sweeps' executability gate and the lens's armed-need view may not run a settlement and may not scan a day's epochs either. They now read **prepared coverage**: for an obligation's day, the one batch at the day's cursor, priced through the same day primitive the settlement uses; a day a staging record holds is that record's to settle and reads as not executable while the record stands, in any of its phases — the rule the staging change already stated, now read the same way by the clock and the preview. This read is conservative by construction — it never over-counts, and a day that would need a scan to cover reads as not yet executable — so preparation, which anyone may run, is what makes such a day read covered: prepare until covered, then the clock and the sweep see it. For the expiry clock the per-entry read is stricter still: an entry is read as claimable only when it is the first pending day of its side, and a borrower-side entry only when no lender-side day is pending, because the claim settles days in that order and a static read cannot price the days ahead. The clock then waits rather than runs; it is never over-generous. The armed-need view — now hosted on the epoch view facet, reached by the same selectors as before, because hosting the pricing it inlines had put the lens over the facet size limit — gains an eighth output (what the read's days would pay the user) and its armed figures now describe the first pending day per side rather than a simulated chunk; the lens's own preview view remains, as a lower bound, for on-chain readers.

**The allocation domain is the day.** The gross-needs pass that once priced a whole settlement call before its first day, to choose which leg an epoch's leftover coverage should take, is removed. Under the rule that only attested single-day epochs are drawn, no epoch's two leg rooms can exceed its balance, so the choice it guided never changes what a leg receives; and the cross-chunk case it was meant to help is the staged, challengeable domain of the next change, not a pre-pass. Three read views (the dry run, the domain needs and the domain probe) are retired with explicit removal legs in the in-place refresh; none was routed on any chain.

Refs #1566, #2305, #2308.
<!-- assembled-fragment: 1566-transport-epochs-3b-ii-a2-iii-preview.md sha256=9aaa1be0625be41470b67219fe9a854aab7c0b4f5affcfc4ed32b60983a1102a -->

## Thread — a past day is proven closed once every obligation on it has terminated, by anyone, once (#1566 transport epochs 3b-ii-B, the closure proof)

**Problem.** The release of an old-wire delivery's remainder must wait until no obligation on any day it listed could still draw from it — the machine check the design states and the owner chose (#2258). No per-day figure of outstanding obligations exists, and maintaining one would charge every settlement on every chain for a check only a mirror holding such a delivery ever runs.

**What changed.** Anyone may now prove a past day closed, in bounded pages, and the proof is paid once per day, ever. A walk is opened for the day under the starter's own nonce and advanced a page at a time per side: entry identifiers in ascending order past the side's cursor, each of that side and covering the day, each terminated on it — settled whole, or part-claimed past the day, with no staging record of its claimant-side standing on the day and no open legacy slice of the entry spanning it. The side is complete when the visited entries' per-day figures add up to the day's own folded total — the same conservation test the commitment report already uses, so an omitted entry leaves the sum short and the walk cannot complete. When both sides are complete the day is stamped closed, irreversibly; a day with no obligation on either side closes at the start. A sum beyond the total means the day's records disagree, and the proof refuses rather than completing on them.

**Why the stamp is safe.** A past day's covering set is fixed — no entry can begin or stop covering a day that has passed — so "every obligation on it has terminated" is a monotone fact of the day, provable once and true for ever, and shared by every delivery listing the day. Two conditions guard the irreversible stamp: the chain must have closed the day itself, since the totals the proof compares against are final only once the day is folded and reported; and the interest fold must have reached the day on both sides (the preceding thread), since otherwise an empty walk would pass conservation against two zero totals.

**A walk is the starter's, never a shared cursor.** A caller who omits a covering entry advances only their own cursor past it; their walk can never complete and is simply abandoned, a fresh walk by anyone closes the day, and nothing an author does can spoil another's proof. No reset entry, no administrator in the loop.

**Published.** Whether a day is proven closed, each walk's cursors, sums and completeness, a starter's nonce, and whether a given entry counts as terminated on a day are readable; a walk's opening, each page and the day's closure each emit an event. The entries live on their own facet.

**Spec:** TokenomicsTechSpec, the transport-epoch bullets (fifth change: the closure proof).

## Thread — an old-wire delivery's remainder is released only once every day it listed is proven closed (#1566 transport epochs 3b-ii-B, the release gate)

**Problem.** The first transport-epoch cut shipped the release shut to everyone: the rule — refuse a batch that still lists an outstanding obligation — could not be checked until obligations were tracked per day, and a release the chain cannot check is an earmark spent on the caller's word (#2258, the owner's Reading B).

**What changed.** Parking a batch's remainder is now the release gate, and it is open. The caller re-supplies the batch's whole day list, checked against the commitment recorded when the delivery arrived exactly as its indexing was, and from the batch's own cursor one page of listed days at a time must each be proven closed by the closure proof above; the first day still open refuses the page by name and nothing is applied. When the cursor reaches the end the remainder parks — still refused while any staging record references the batch or the batch is not fully indexed. Parking is mechanical and permissionless: the remainder moves into a holding of the same batch under the same membership, nothing becomes spendable, and what makes it valid is state, not the caller.

**The acknowledgment is the administrator's.** Releasing the parked remainder — after which the batch's delivery passes the classification gate — is the operator disposition the design names, gated accordingly; it is one-way and refused twice. The one-argument park entry that refused everyone is retired.

**Spec:** TokenomicsTechSpec, the transport-epoch bullets (fifth change: the release).

## Thread — a remainder that owes nothing payable can be retired by anyone, so its days can close (#1566 transport epochs 3b-ii-B, the zero-priced retirement)

**Problem.** A closed, non-forfeited reward entry whose remaining window prices to nothing payable was never marked settled: the expiry sweep returns before starting its clock when nothing is payable, and the owner has nothing to claim. The closure proof tests "settled, or part-claimed past the day", so such an entry would have refused its days — and every delivery listing them — for ever, over an obligation that owes nothing.

**What changed.** Anyone may now retire such remainders, through the same entry family as the expiry sweep and with the same budgets. Two shapes are distinguished, by two tests, never one: a window that is empty — closed before it began, or priced to no value at all — is marked settled with nothing moving; a remainder the loan-side reward ceiling trims to a zero payout while its raw entitlement still stands runs the expiry sweep's own terminal accounting for one day per call — the ceiling's truncate-and-consume, which retires the commitment behind the raw entitlement and persists the day — until the window is done. A retirement keyed on "unpriced" alone would have retired raw dust and left every cap-exhausted entry, its days and its deliveries unclosable; so a closed window that merely is not yet priceable is left alone, as is anything payable, open or forfeited. The proof's termination test is unchanged.

**One body for the terminal day.** The expiry sweep's single-day settle is now the one routine both the sweep and the retirement run, so the two cannot drift.

**Follow-ups recorded, not built.** Repatriation of an UNTYPED released remainder (the design names it as the exit for a remainder no evidence can classify) has no path today — the existing repatriation moves typed recycled value — and needs a canonical-side untyped return leg; recorded as an owner question (#2376). Batch-bound replacement funding has nothing to clear under the owner's reading, since the park already requires every listed day proven closed.

**Spec:** TokenomicsTechSpec, the transport-epoch bullets (fifth change: the retirement).
<!-- assembled-fragment: 1566-transport-epochs-3b-ii-b-closeout.md sha256=fb7a9abdcc2413946414de1c62c220a258bdc61a0df4e8cd28d50955ee4391b8 -->

## Thread — a shared delivery is drawn by two gates, not withheld whole: contested days refuse it, unarrived days make it the last resort (#1566 transport epochs 3c-1)

**Problem.** Since the draws landed, every old-wire delivery listing more than one day was withheld from every day it listed, because the chain could not tell a contested draw from an uncontested one: a batch recorded how many days it listed, not which, and no per-day figure of unmet obligations existed. The owner settled the definitions (#2318, the design text as written): a draw is **contested** when the batch is listed by the day of at least one other known unmet obligation; a batch with an **unarrived** listed day is drawn **last**, only for what no other source can cover — two separate gates, both validity conditions of a draw.

**What changed.** A delivery now keeps the list of days it named, written as its membership is indexed, and the planner reads each other listed day live: a day whose broadcast has arrived and whose obligations are not all proven terminated makes the batch contested — withheld from this day's draw, reported by name; a day whose broadcast has not arrived makes the batch a necessity-tier source — planned after every ordinary source and drawn only for the shortfall live funding and the recycle bucket leave, never for a day's ordinary transport-first draw; a batch whose other listed days have all arrived and been proven closed is ordinary and pays like a one-day delivery. The closure proof is the fact the contested gate reads, so proving a day closed is what frees the deliveries that list it. A delivery wider than the fan-out cap, or one indexed before its list was kept, is withheld as contested rather than read on a hot path. An unattested delivery is still withheld on its own account, and both reasons are reported each on its own.

**One predicate, three readers.** The one-call settle, the staging path and the static preview all read the same admission: the one-call draw re-plans at the moment it settles, so the gates hold at settlement by construction; the staging path stages ordinary deliveries only — the necessity tier serves a shortfall the live sources leave, which a record measures at reservation, not at staging — so a record never holds a necessity-tier draw that settlement would have to re-judge; and the preview counts only ordinary coverage at the cursor.

**Why the gates cannot turn against a staged draw.** Arrival, attestation and closure are all monotone facts, and no obligation can begin covering a day that has passed; the only obligations that can still appear are on days that have not arrived — which is exactly the tier the staging path does not take. So the design's settlement-time re-check has nothing to catch on this cut's staged draws; the one-call path re-checks by re-planning. Recorded, so the next cut (the challenger machinery) inherits the argument rather than the assumption.

**Spec:** TokenomicsTechSpec, the transport-epoch bullets (third change: the draw order gains both gates; fourth change: the withheld sentence is replaced).
<!-- assembled-fragment: 1566-transport-epochs-3c-1-gates.md sha256=541304f73dacff4939df02e04cc82b94ac37c4404c12a870e22b4d74b15953bc -->

## Thread — a reward budget travels committed to its days by a root, typed on the wire, and is held whole as its own epoch (#1566 transport epochs 3d, the d6 wire)

**Problem.** Every remittance wire so far carried the list of days it funded in the message itself. That list is what the destination writes, day by day, into the indexes every draw reads — and a message is immutable, so a list too wide for one call to write cannot be refused at the destination without refusing the same message for ever. The transport-epoch design closed that for the OLD wires with the compact admission: the arrival is recorded whole and the list is re-supplied and re-hashed, page by page, afterwards. For the new wire it asked for something stronger — a Merkle root over fixed-size indexed chunks of the list, together with the list's extent, so each materialization call verifies one bounded chunk against the root instead of re-hashing the whole list, and the chain knows exactly when the membership is whole. It also asked that the packet carry the era it was dispatched in, because the coming era-registry change validates a delivery's intended era at the receive ingress and no wire before this one carries one.

**The sender.** Every ordinary remittance the canonical chain dispatches now travels on a sixth payload shape, d6: in place of the day list it carries a root over fixed-size indexed chunks of the funded days (sixteen days to a chunk), the extent (how many days, in how many chunks), the total, the remittance id, the sender's address, the recycled share and the era it was dispatched in — zero, the pre-registry era, until the era registry lands and replaces that word with the live one. The send and its fee quote build the payload through ONE rule, so a quote prices exactly the bytes the send emits, and the reservation the canonical chain keeps for the remittance records the root it committed to, beside the closed days it already recorded. The per-remittance day cap is unchanged (see the recorded limit below). The compensation wire is unchanged: it is day-scoped and carries its own shape.

**The receiver.** The mirror-side receiver decodes d6 and forwards it through a new Diamond ingress. On a deployment whose reward custody is activated, that ingress records the packet, stamps its commitment and extent and era, takes the split the wire stated as the packet's attested caps — the wire is the attestation; a later one from the canonical chain finds the same figures and is held to them — and opens the delivery's transport epoch at once, holding the WHOLE delivery: nothing of it is credited to the live delivered ledger or the recycle bucket at ingress, and the days the root commits to draw it first under the rules every other epoch obeys (transport-first, the contested and necessity gates, staging), with only the residual reaching the shared sources. A wire whose extent is not the fixed-size chunking of its element count, that commits to nothing, or that declares more chunks than the index can mark is refused by name; so is a split that does not account for the whole delivery, because the whole delivery becomes one epoch typed by exactly two caps and a wei under neither would be value no day could draw.

**Chunks, in any order, each once.** Anyone may index a rooted epoch's membership one proven chunk at a time: the chunk's index must lie inside the committed extent and not have landed before, its length must be the one the extent commits to for that index, and its indexed leaf must verify against the root under the supplied proof. Each chunk's days then go through the same per-day writer a flat-hash page uses — one implementation of "this batch lists this day" for both commitments. The epoch's index count reaches its day count exactly when every chunk has landed, and that count is what every allocation and the park already gate on, so a rooted epoch is spendable, and its remainder parkable, only when whole — by the existing rule rather than a new one. Parking a rooted epoch reads the list its chunks wrote; no list is re-supplied, and a supplied one is refused by name. The flat-hash page refuses a rooted batch by name, and the chunk route refuses a flat-hash one.

**Before activation.** On a deployment whose custody is not yet activated a rooted delivery takes the typed-ledger path exactly as a d5 delivery does — the fresh component counted, the recycled one credited to the bucket — and opens no epoch, for the reason the untyped path already states: the activation is what assigns tokens that rest with the Diamond, and an epoch beside it would be two records on one sum. Its commitment and era are still stamped.

**Rollout.** A receiver that does not yet speak d6 reads the new tag as an array offset and REVERTS the delivery — never a silent mis-decode — and the transport re-delivers once that receiver is upgraded. The receiver's wire generation advances to 6, so the in-place refresh upgrades every deployed receiver rather than reading one as current; mirrors are refreshed before the canonical sender, the same order the previous wire change used.

**What this changes in accounting, and what is recorded for the owner.** Under this reading of the design a new remittance no longer tops up the live delivered ledger or the recycle bucket at ingress; the live ledgers keep what they hold and the claim's live leg shrinks to what the epochs cannot cover. That is the design's stated order ("an obligation on a day a delivery listed is paid from that delivery's epoch first"), and the alternative — a root riding a ledger-credit wire — would leave the root, the extent and the chunked index with nothing to gate. Both readings, the chunk size and the chunk-count bound are recorded on #2388. **The dispatch cap lift the design foresaw is not taken here:** the gate change (3c-1) reads a batch's listed days on the hot path and declines a list wider than the fan-out cap as contested, so a rooted delivery wider than the cap would be accepted and indexed but withheld; the cap lift waits on a gate that reads a wide list off that path, recorded on #2388 with the options.

**Spec:** TokenomicsTechSpec, the transport-epoch bullets gain a sixth change (the rooted wire).
<!-- assembled-fragment: 1566-transport-epochs-3d-d6-wire.md sha256=a5bc0fe7bf606ecbb68c3606037eda76b9ef5604095a449b8ed69a0ee2190d01 -->

## Thread — a chain never reports a day its interest fold has not reached (#2277)

**Problem.** A chain's day-close report reads that day's per-side interest totals from a fold that advances a bounded number of days per call, and the close stamped the day and dispatched the report after a single bounded advance without checking that the fold had arrived. After a deployment or reporter gap wider than that reach, a permissionless close of a far-past day shipped a zero or partial report to the canonical chain — once, since the stamp made the day one-shot — and nothing could move the fold to the day afterwards or resend. Found by review of the transport-epoch close-out design, whose per-day closure proof reads those same totals and is sound only if a reported day's totals are final.

**What changed.** The close now refuses, by name, a day either side's fold has not reached, leaving nothing behind; so a day is never stamped reported with totals the fold has not produced. A permissionless, resumable catch-up advances the fold through any elapsed day in bounded steps — anyone may run it until both sides reach the day, after which the close reports the folded figures as before. The catch-up carries the same bound the close does, strictly elapsed days: a fold run ahead of the clock would silently drop the start and end of every loan registered afterwards. Within one reach nothing changes — the close still folds and reports in one call. The two frontiers are readable.

**A day already reported short before this rule** cannot be re-reported from the mirror: the canonical chain accepts one report per chain and day. No live chain has such a day (none has existed long enough for a gap of that width); should one arise on a test network, the remedy is the fresh deploy those networks already use. Closes #2277.

**Spec:** TokenomicsTechSpec, "Failure modes and safety" (a reporting gap wider than the fold's reach).
<!-- assembled-fragment: 2277-close-day-frontier-guard.md sha256=fbafcf5211dbc8d8c087e15b887d5ba5f0f33867e5f432b42c96524d99dbf58f -->

## Positions — what was lent, and what is locked now (#2453, #2454)

An internally matched loan's page said "You lent 0" and "No collateral collateral (borrower's)". Both came from reading live figures as if they were the loan's history. Internal matching reduces a loan's principal and pays away the borrower's collateral as it settles the loan, so once a match closes it both are zero. The page took the zero principal as the amount lent, and dropped "No collateral" into a sentence that already ends in "collateral".

The indexer has always kept a separate, never-rewritten record of the principal each loan was initiated with. It now serves that figure next to the live one, and the positions lists carry it onto the loans they read live from the chain. The loan page headline, the Positions list, and the desk's Positions and History panels use it. They now describe the position rather than the reader. For example: "Your lending position · 1 tLIQ lent when this loan started". Whoever holds a position may have bought it, and a buyer never lent anything. Some loans indexed before that record existed had it filled in from their then-current principal. Where the chain's own initiation record does not back that value, the value is now marked and is no longer served as history: those loans say the amount isn't available. The rate chart keeps reading it as a frozen fill size, so past fills never shrink. This also corrects partly repaid loans, which used to show only what was still outstanding as the amount lent. A loan repaid in full now states the whole initiated principal as repaid. Where a row does not carry the initiated amount (a loan read straight from the chain before the indexer has seen it), the page says the amount isn't available rather than showing a figure. What is still owed keeps using the live outstanding principal.

The "Locked" row names an amount as locked only while the loan is open. A closed loan's record keeps its collateral figure even after the borrower has claimed it, so that figure is no proof the collateral is still held. A closed loan now says its collateral is settled through the claims. An internally matched loan says the match paid the borrower's collateral to the lender of the loan it was matched against, with any surplus returned through the borrower's claim. "No collateral" is kept for an open loan that holds none. On an internally matched loan, the lender's receipt no longer falls back to "principal plus interest", which matching does not pay. While a loan is open, the loan page now takes its principal and collateral from its own live chain read rather than the indexer's, so a partial repayment, a collateral change or a just-completed match shows at once. A just-matched loan's pre-match collateral is never shown as still locked. All new wording is translated in the nine translated languages.

Closes #2453. Closes #2454.
<!-- assembled-fragment: 2453-2454-position-amounts.md sha256=1fed84f6a9315491367532cadff81c5be9cae793ac462f561ea82b687b5bba71 -->
