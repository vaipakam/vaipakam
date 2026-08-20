# Release Notes — 2026-08-20

Two entries, and they are two halves of one piece of work: the completion of the
VPFI recycling programme's settlement layer.

Rewards can end three different ways — a holder claims them, an unclaimed one
reaches the end of its claim horizon and is recycled, or a defaulted position
forfeits them. Each of those three used to work out on its own what the reward
was worth, applying the same limits in slightly different ways. That is the kind
of duplication that does not announce itself: every copy looks correct in
isolation, and the disagreements only surface at the edges — a reward that could
never be finalized, an estimate that contradicted what a claim would actually
pay, a limit applied twice or not at all. All three now ask the same settlement
engine for the answer.

The second entry is what that unification was for: a receiving chain can now pay
out its own coordinated-mode days, bounded by what it has actually been funded,
instead of being held back entirely.

## Reward expiry now settles the same way a claim does (#1434)

When a reward entry reaches the end of its claim horizon without being
claimed, the protocol reaps it and returns its value to the recycling
bucket. Working out *how much* an entry is owed at that moment is the same
question a normal claim answers — but until now the expiry path worked it
out separately, with its own arithmetic.

That separation was the problem. Three consecutive review rounds each
corrected the expiry calculation, and each correction was wrong in a new
way: it measured the raw amount owed rather than the amount actually
funded; then an amount that looked capped but was not, on precisely the
chains where it mattered; then a figure borrowed from the claim path that
covered the wrong span of days and the wrong set of limits. The arithmetic
differed every time; the shape of the mistake did not.

Expiry now asks the settlement engine for the answer instead of computing
one. The practical consequences:

- **Entries that share a daily ceiling no longer interfere.** Previously
  two expiring entries could each be measured against the whole shared
  allowance — leaving one of them permanently stuck, or letting both
  together exceed the ceiling. Each now takes its own allocated share, and
  what it consumes is recorded so the next one sees the reduced remainder.

- **Long entries no longer lose value when reaped.** An entry spanning more
  days than a single pass can price used to be closed out in full while
  only part of it was credited; the rest was simply lost to the claimant.
  An expiry now settles only the days it actually priced and carries the
  remainder forward, so a long entry is reaped across several passes with
  nothing dropped.

- **Expiry is no longer limited by a cap that does not apply to it.** An
  expired reward returns to the bucket rather than being paid out to a
  participant, so the per-loan payout ceiling was never meant to bind it —
  the same exemption forfeited rewards already have. Where that ceiling was
  exhausted, an entry could previously be closed out while none of its
  value was returned.

- **A reap never partially credits while the owner can still claim.** Where
  the overall emissions budget is nearly exhausted, an expiry waits rather
  than taking what fits and discarding the rest. A claimant asking to be paid
  is right to take what is available; someone being reaped without asking is
  not, and while their own claim is still open to them, waiting costs nothing
  but time.

- **Once a reap has actually moved value, that changes — deliberately.** The
  first pass that credits anything removes the reward: it is announced, and
  the owner's claim to it closes from that moment. From then on the reward
  must finish rather than wait, because the emissions budget only ever
  shrinks — a wait that began after removal could never end, and the reward
  would be left permanently unfinished with its owner already unable to
  claim. So a later shortfall settles for what the budget allows and
  completes, and any remainder it could not fund is discarded rather than
  held.

  This is a real trade, stated plainly: tail value CAN be discarded, but only
  after the owner has been removed and told, and only to guarantee the reward
  terminates. The alternative — waiting forever on a budget that cannot grow
  — loses the same value AND leaves the reward stuck, with no signal that
  anything happened.

- **Only a genuinely permanent shortfall triggers that trade.** The
  emissions budget is not the only thing that can come up short at
  settlement: the platform also refuses to credit more than its own
  balance currently backs, and that constraint is temporary — it clears
  with the next inflow. A removed reward that hits a momentary backing
  dip now waits for it to pass, rather than settling short and discarding
  the difference. Discarding is reserved for the one budget that can
  never refill.

- **Removal happens when value first moves, not merely when the sweep
  first advances.** A sweep pass can step past days that turn out to be
  worth nothing — for example a day whose shared allowance an earlier
  claim already used up. Such a pass now leaves the reward exactly as
  claimable as before; the owner's claim closes only on the first pass
  that actually credits value, which is what the platform's announcements
  have always described.

- **Detaching a chain from the cross-chain mesh is now a full role change.**
  A chain's delivered-funding position was already retired when its
  canonical/mirror role flag flipped; the same retirement now also applies
  when the chain is detached or re-attached by clearing or setting its
  home-chain reference — the second way its effective role can change.
  Previously a detach-and-reattach round trip could re-offer funding
  headroom whose backing had already been spent.

- **Previews and readiness checks now model the lifetime budget the same
  way payment does.** Near the end of the emissions schedule, the
  platform's forward-looking figures — the pending preview and the
  "could this claim be paid?" check that drives the expiry clock — used
  to treat the remaining schedule as unlimited while applying the
  cross-chain funding bound, so they could disagree with the live claim
  about which limit actually applies. A claim that would succeed (paying
  exactly the schedule's remainder) could preview as zero, and the
  readiness check could wait on cross-chain funding for value the
  schedule will never emit — stalling expiry clocks permanently. Both now
  apply the schedule's remaining headroom exactly as the claim does,
  which is also what the specification always said. Two refinements
  complete this: the simulated budget is spent down day by day exactly
  as a real claim spends it (previously each day of a multi-day estimate
  was measured against the full remaining headroom), and it accounts for
  the parts of the same claim that are paid before the daily walk — the
  legacy window and each reward's pre-cutover slice — so an estimate can
  never promise the same headroom to two legs of one claim. That
  accounting reserves by what a leg SPENDS, not by who receives it: a
  forfeited reward's pre-cutover slice goes to the treasury channel
  rather than the claimant, but it draws on the same schedule, so it
  reserves headroom too — while remaining excluded from the pending
  figure shown to the user, who receives nothing from it.

- **Forfeited rewards now settle through the same engine as everything
  else.** The last path that still worked out its own settlement — the
  sweep that finalizes forfeited rewards — now prices each armed day
  through the shared settlement engine: the same daily ceilings, the
  same split between newly-emitted and recycled value, the same
  cross-chain funding bound, and a bounded amount of work per call with
  progress saved between calls (a very long reward settles across
  several sweeps instead of needing one impossibly large transaction).
  Two visible consequences: a sweep that cannot yet be funded
  cross-chain simply makes no progress and succeeds later (previously
  the whole call failed), and a forfeited reward whose value rounds to
  nothing still closes out cleanly when the emissions schedule is
  exhausted. Operators also get a safer maintenance path: re-running the
  full facet refresh on an already-migrated deployment no longer stops
  mid-way asking for migration inputs that only ever applied to the
  first run. The same budget discipline covers the parts of a forfeited
  reward that predate the daily engine: their settlement never pushes
  the emissions ledger past the lifetime cap, and a temporary backing
  shortage makes them wait rather than silently forfeiting the
  recoverable remainder.

- **A forfeited reward is settled against what the cross-chain funding
  actually owes.** The permissionless sweep that finalizes forfeited
  rewards used to require cross-chain funding to cover the reward's raw
  value, but the funding schedule only ever remits the capped figure —
  so a capped forfeited reward could never be finalized at all. The
  sweep now settles exactly the capped amount (the same figure the
  funding schedule states), writes off the capped-away remainder just as
  the schedule already did, and still retires the full obligation.

- **Routine sweeps no longer pay for questions whose answers cannot
  matter.** The eligibility probe — an expensive simulation of the
  owner's whole claim — now runs only where its answer can change the
  outcome: before a reward's removal point, and its cross-chain half
  only on chains where that bound applies. Previously it ran
  unconditionally, letting a large enough reward history make an
  otherwise valid sweep run out of gas.

- **A removed reward shows no countdown either.** The Claim Center's
  removal countdown is a deadline for the owner to act on; once removal
  has begun that deadline has passed, and continuing to show it — possibly
  for a long settlement tail — would invite a claim that can no longer
  succeed. The countdown now clears at the removal announcement, exactly
  as it does for a claimed or fully expired reward.

- **A removed reward no longer counts toward what its owner could claim.**
  The internal check that asks "could this user's whole claim be paid
  right now?" excludes removed rewards — the claim itself already skips
  them. Previously a removed reward still mid-settlement inflated that
  figure, which could stall the expiry clocks of the same user's other
  rewards indefinitely. (The user-facing pending preview was measured to
  be unaffected — it already read zero for such rewards through a
  different mechanism — and now states the exclusion explicitly as well.)

The claim-horizon sweep also moves onto its own internal component. It now
shares the settlement engine, and no existing component had room for it
within the per-component size limit that the platform's upgrade mechanism
imposes. Nothing changes for anyone calling it: the address and the call
itself are unchanged.

## Receiving chains can now pay out their own coordinated-mode days (#1434 P1-b)

Until now, a receiving chain never priced the days that run under the
platform's coordinated reward mode. Those days were stopped outright — not
because anything was wrong with them, but because the platform had no way to
tell how much funding a receiving chain had actually been sent, and paying
without that knowledge could have drawn on tokens held for other obligations.
The stop was a placeholder for the missing measurement.

That measurement now exists, so the stop is gone. A receiving chain prices its
coordinated-mode days exactly as the coordinating chain does, and what keeps it
honest is a simple rule: **it may pay out no more of that funding than it has
actually been sent.**

**A shortfall makes a day wait; it never shrinks it.** This is the part that
matters most for anyone whose rewards are affected. Two different limits can
hold a payout back, and they settle in opposite ways:

- The platform's lifetime emission ceiling only ever shrinks. What it cannot
  cover can never be covered later, so a day held back by that ceiling is paid
  down to what fits and then closed for good.
- Delivered funding is the opposite — it grows with every delivery. A day short
  of it is simply not funded *yet*, so it waits, and the next delivery pays it
  in full.

Trimming a day for the second reason would permanently underpay someone whose
funding was merely still in transit. The two limits are therefore tracked
separately, so the platform can always say which one actually applied. Where
both apply equally the day closes, because no future delivery could complete it
and waiting would mean waiting for something that cannot arrive.

**The wait can always end.** A day that is waiting on funding is not stuck: it
becomes payable the moment that funding lands. The rule is keyed on the amount
present rather than on the arrival of any particular message — which matters,
because some days are deliberately never funded from the coordinating chain
(the receiving chain covers them locally, or the amount rounds to nothing). A
rule keyed on messages would leave those days waiting forever and block every
later day behind them.

**What is unchanged.** The coordinating chain is unaffected — it funds its own
days directly and receives no deliveries, so the new limit does not apply to
it. Rewards earned before coordinated mode was switched on are also unaffected:
no delivery ever funded them, so they are not measured against delivered
funding and continue to pay as they always have.

**What you will see.** A reward estimate on a receiving chain no longer quotes
an amount that a claim will decline to pay **for want of delivered funding**.
Previously an estimate could promise a full day's reward while the claim paid
nothing at all, because the estimate did not know what had been delivered.

One limit used to sit outside that guarantee: near the platform's lifetime
emission ceiling an estimate could read higher than the claim would pay, because
estimates did not model that ceiling. The other entry in these notes closes that
gap — the pending preview and the readiness check now apply the schedule's
remaining headroom exactly as a claim spends it — so the two figures agree at
that boundary as well. The agreement described here is the separate one about
delivered funding, where the gap was never a bound but a wrong answer.
