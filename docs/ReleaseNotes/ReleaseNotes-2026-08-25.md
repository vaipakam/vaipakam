# Release Notes — 2026-08-25

A day weighted toward hardening the lender's direct exit and toward making the
platform's own records honest. On the exit path, the direct position sale gained
the last of its behavioural guards: it now fits the size and term the buyer
authored (#1923) and lets a seller bind the three costs — net, transferred
interest, and forfeited reward — to the economics they reviewed (#1922), closing
the in-place lender-sale cluster (#1503 items 5, 6, 9, 15). On the honesty side,
a code-first audit corrected nine source comments that had drifted from the code
beside them (#1349); the published backing figures now include every reserve
subtracted from them (#1930); and the launch deploy no longer quietly puts a
price on VPFI (#884). Operationally, the keeper was removed from its schedule
while its CPU-budget problem is worked (#1896) — a change with real costs that
its own note enumerates.

## Nine comments in the contracts described behaviour the code beside them had changed (#1349)

A code-first audit of the VPFI recycling programme — reading the source rather
than the tracking cards — found nine explanatory comments that describe how the
platform used to work rather than how it works now. Nothing users can see changes
here. What changes is what the next person reads before touching this code.

Four of them said the notification fee goes straight to the treasury with no
intermediate custody. It has not worked that way since the fee became the first
input to the recycling loop: the fee is taken into the platform's own custody and
credited to the recycling balance. Two of those four cited, as their authority,
the very file that contradicts them.

One was worse than merely out of date. It described how a loan opened before fees
were frozen per-loan resolves its treasury share, and it named the wrong source —
the current setting rather than the frozen historical one. A developer trusting
it would conclude the code had a bug and "fix" it, and that fix would quietly
reprice every grandfathered loan at repayment — in whichever direction the
current setting happens to sit relative to the frozen one. The project's own
engineering notes warn against exactly that change; the comment described it as
already true.

One header contradicted its own file a hundred and forty lines further down: it
said a cross-chain feature was deferred and inactive, while the code below it
implements and uses that feature. The reason the deferral existed is preserved,
because it explains why the current arrangement is safe rather than merely
allowed.

The last said a reserved field would start carrying values at a milestone that
has since passed. It is still empty, for a different and still-open reason, and
now says so.

Review of the first pass found four more, and one of them was introduced by the
pass itself: a corrected paragraph left an older paragraph in the same file still
asserting the state it had just retired, so the file contradicted itself in a new
place. Another named a function that does not exist, in a change whose entire
premise is that comments should resolve against the code. That one is now checked
mechanically rather than by eye — every symbol these comments name is confirmed to
exist before the change goes out.

Two others were understatements rather than errors, and correcting them made the
warnings stronger — then review showed both corrections were themselves too
confident, which is worth recording as its own lesson.

The first described a hazard as capping out at twice the correct fee. It is not
capped there: the fee setting a change like this would wrongly consult can be set
anywhere up to the platform's ceiling, and it can also be set *below* the frozen
historical rate, so the same mistake can move value in either direction. A third
comment elsewhere in the codebase had reasoned about the below-the-line case
correctly for some time, so two files quietly disagreed; they now say the same
thing.

Naming who actually loses took three rounds, and the first two answers were both
wrong. On the ordinary repayment path the fee is a share of the interest the
borrower already owes — the rate divides that amount rather than adding to it —
so the borrower pays the same either way and what moves is the split between the
lender and the platform. A rate above the frozen one pays the lender less than
the terms they agreed to; a rate below it short-changes the platform.

But that is one path, and the answer does not hold everywhere. Where the
collateral is put up for sale as a listing, the fee is added on top of what the
lender is owed to set the minimum acceptable price, and whatever the sale raises
beyond that goes to the borrower's side — so at a fixed price a higher rate takes
from the borrower rather than the lender.

There is a third arrangement, and it behaves like neither. Where the borrower has
instead pre-authorised a swap of the collateral to repay the loan, the same
figure is used only as the threshold the swap has to clear; once it clears, the
proceeds are divided by the ordinary repayment rules, in which the lender's share
and the platform's share add up to a fixed amount. A higher rate there can cause
the swap to be refused outright, and cannot reduce what the borrower keeps on one
that goes through.

So the honest answer is that it depends on how the loan is being closed — and
each earlier attempt had picked one party and asserted it everywhere. Naming the
mechanism rather than the beneficiary is what finally stopped this being wrong,
because the mechanism carries its own scope.

The second listed the reasons a billing step can fail and omitted one. Saying it
"stops billing for everybody" was then too broad, and the correction after that
was wrong in a third way: it claimed every other listed reason concerns the
individual being billed, when only one of the three does. The other two — a
caller without permission, and a platform-wide setting left unconfigured — fail
every payer alike.

Then the correction after that overshot too, twice: it said the shared budget is
the only cause that can fail some users and not others, and that seeing a partial
outage means the answer is not with the individual user. Neither holds. An
underfunded account fails exactly that way by definition, and once the account is
ruled out the shared budget is still only one candidate — the notification step
also reaches out to the cross-chain messenger, which can refuse for reasons of
its own.

Then a further round found that even the surviving summary was too tidy. It said
a total outage points at permissions or an unconfigured setting — but the whole
platform can be paused, which stops billing for everyone and was missing from the
list entirely despite being declared on the billing function itself. And the
shared machinery can fail for everyone at once too, whenever every user in a batch
happens to need it.

So the list stopped being a list. What is left is a way of thinking rather than a
lookup: sort a reported failure by how many users it hits, and remember that the
shared machinery can imitate either pattern depending on the batch.

The one piece of ordering advice also needed correcting, and it is the kind of
thing an operator would have lost an hour to. "Check the user's balance first"
was too small: a user can hold plenty and still be unable to pay, because the
withdrawal also screens the account, can require an outdated account to be
upgraded first, and only spends the portion not already pledged elsewhere. So a
healthy balance does not clear the account — the whole account state has to be
ruled out before looking at the shared machinery, and an earlier version of this
note would have sent someone straight past a pledged or outdated account to go
hunting through infrastructure.

Five attempts to enumerate the causes produced five incomplete enumerations,
which is a reasonable sign that enumerating them was the wrong shape.

A pattern worth naming, since it repeated on nearly every one of these: the
first correction of a wrong statement was usually itself too confident. Each
round replaced a false claim with a narrower one that still asserted more than
the code supported, and it took several passes before the wording said only what
could be checked. Describing the mechanism rather than announcing the conclusion
is what finally held, because a mechanism carries its own limits with it.

These were found by reading the code and asking what it does, rather than by
reading the documentation and believing it. That distinction is the reason the
audit was worth running.
<!-- assembled-fragment: 1349-stale-source-assertions.md sha256=0b4a93078f08e253944951cb7c926dfabd1c25dcc758e053c4d07ec06778566f -->

# The keeper is deployed but no longer scheduled

The keeper Worker has been removed from its every-minute schedule. It is
still deployed, and everything it needs to work is still in place — the
code, the database binding, all seventeen secret and configuration
bindings. **Nothing has to be rebuilt or reconfigured to bring it back.**

That is not the same as saying it comes back in one line, and an earlier
version of this note said exactly that. It is wrong in a way that
matters: the switch arming the jobs that move funds cannot be read back,
so restoring only the schedule can start all six of them immediately, on
a Worker still known to exceed its limit. Safe restoration is a written
sequence — turn that switch off first, commit and publish the schedule,
wait for it to take effect, then watch the jobs that cannot move funds
before arming the ones that can. It is kept beside the schedule itself
and is summarised further down. Follow it rather than the one-line
shortcut.

## Why

It had not been completing its work for at least as long as the
platform's logs go back. Measured against the live deployment, roughly
every single invocation was being terminated for exceeding its CPU
allowance, and had been continuously. So each minute the Worker
started, spent its whole budget, and was cut off before finishing.

That is not the same as achieving nothing: several of its jobs did
complete before the invocation died, and may well have sent alerts or
written records first. What is certain is that every minute ended in
termination rather than in an orderly finish, indefinitely.

*Which* of its ten jobs consumed that budget is not yet known. An
earlier draft of this note named two of them; that was inference rather
than measurement, and it has been withdrawn. The jobs are started
concurrently, so a job with no completion line may equally have been
waiting on a network response when the whole invocation was cut off.
Finding the real answer needs profiling inside the jobs, and is part of
the work this note does not finish.

It also returns a scheduling slot to a pool that was completely full.
The platform's plan allows only five scheduled jobs across the whole
account, and a previous deployment failed outright on that limit.

## What it does cost

**Four** of the ten jobs were not switched off by configuration, so
stopping the schedule stops them for certain. Two earlier drafts of
this note got this wrong in turn — the first said the change cost
nothing, the second named only half of them:

- **Health-factor alerts to users.** The largest loss, and the one both
  earlier drafts missed. The watcher keeps evaluating positions and
  keeps messaging borrowers even while the keeper's own actions are
  switched off. Stopping the schedule stops those messages: a borrower
  drifting toward liquidation is no longer told.
- **The daily price snapshot.** Deliberately left outside the keeper's
  kill-switch, precisely so that turning the keeper off for an
  unrelated reason would not leave gaps in the price series — so
  stopping the schedule produces exactly the gaps that choice existed
  to prevent. Mitigated by the fact that anyone can perform this
  snapshot; it is not restricted to the keeper.
- **The pre-grace warning.** Borrowers approaching their grace boundary
  stop receiving the heads-up that lets them repay in time.
- **Liquidity-confidence state.** Its switch governs only whether it
  submits on-chain; it still reads and still records. Stopping the
  schedule stops that record advancing at all.
- **Cleanup of expired Telegram link codes — found during review, and
  fixed here rather than accepted.** The only thing that removed them
  ran inside the watcher. The part that *issues* those codes is a
  different service that stays running, so the stop would have left
  them handed out and never cleared — short-lived codes that should
  expire in minutes staying on record, with the table only growing.
  That cleanup now also runs on the service that issues the codes,
  which is where it belonged: that service already tidies its own
  records on the same schedule, and the sweep is a single bounded
  delete. The keeper keeps its copy, so nothing is lost when it comes
  back; running twice is harmless.

  **This one needs an operator step in the same sitting as the merge,
  and is not fixed without it.** The keeper's change takes effect on
  merge automatically; the notification service's does not, because
  that service is not deployed automatically. Merge alone therefore
  *removes* the only live cleanup and does not start the replacement —
  the opposite of the intent. Deploy the notification service as part
  of landing this — through its own packaged command, not a plain
  deploy, because that service also holds settings that exist only on
  the dashboard and a plain deploy erases them — and confirm on a later
  run that the cleanup ran. Until that is done, treat this as a cost of
  the stop rather than a fix.

**Six more stop conditionally**, and whether they were running cannot
be determined from outside. The matcher, the liquidator, the
auto-lifecycle pass, reward-budget remittance, its acknowledgement
pass, and the commitment report all sit behind the master switch. If
that switch was on before this change, unscheduling stops all six as
well; if it was off, they were already idle. Since the switch's value
cannot be read back — the same limitation stated further down — **plan
for the case where they were running**: matching, liquidation and
reward funding must be treated as unavailable for the duration rather
than assumed to be someone else's job.

**They do not resume the instant the schedule returns, and some losses
do not resume at all.** A restored schedule can take up to a quarter of
an hour to take effect everywhere. The daily snapshot then waits for
its next daily window, and the pre-grace warning for its next turn in
the rotation. Days of price history missed in the meantime are **not
backfilled** — the contract records only the current day.

Pre-grace warnings divide in two, and an earlier draft of this note got
it wrong by treating them as one. A loan whose repayment date has
already passed by the time the schedule returns is never warned about —
that warning is simply lost. But a loan that is *still* within its
warning window when the keeper comes back **is** warned then, just
late. So the return of the schedule can bring a burst of overdue
warnings rather than silence, and borrowers may get less notice than
the window is meant to give them. Expect both, and treat a long stop as
something to announce rather than to let people discover.

## What it does not change

Nothing about what the keeper *is*. No job was deleted and no
configuration was cleared. The switch that arms the fund-moving jobs
is untouched — and untouched is all that can honestly be said about
it: its value is stored in a form that cannot be read back, so nobody
can confirm from the outside whether it is on or off. That is why the
re-enabling steps begin by setting it off explicitly rather than
assuming, and it is why restoring the schedule out of band, without
that first step, must not be treated as safe. When the underlying work
is done, the schedule goes back and the keeper resumes every task it
had before.

The re-enabling steps are written where the schedule is defined, next
to the empty list, rather than in a separate document that could drift
away from it — including how to confirm from the live logs that the
jobs are finishing rather than being cut off, which is the check that
was missing when this problem went unnoticed.

Part of #1896, which stays open for the underlying work.
<!-- assembled-fragment: 1896-keeper-unscheduled.md sha256=34d51242d10f43df6d8f63e59af25b33064894806e92d2a57c8c3c3b97729df7 -->

### A seller can now hold a direct position sale to the economics they reviewed

Selling a loan position straight into a standing buy offer settles in one
transaction, at figures the contract recomputes from live state at the moment it
mines. Between the seller reading a quote and their transaction landing, that
state can move — a borrower partial-repays, or parked interest is settled — and
the seller's actual receipt can come out lower, or their cost higher, than the
quote they acted on. The unbound sale takes whatever the live figures produce.

There is now a second, opt-in way to sell that carries the seller's reviewed
numbers: a minimum net receipt, a ceiling on how much already-accrued interest
would transfer to the buyer with the position, and a required deadline. The
sale is refused if execution would be worse for the seller than those figures —
a net below the floor, more accrued interest migrating to the buyer than the
ceiling allows, or a fill past the deadline — and passes when it is at least as
good. These are the same quantities the listed route's bound carries, read from
the same seller quote, and the check runs against the very figures the
settlement uses, so it cannot drift from what the seller actually receives.

The deadline is required, not optional, and that is deliberate. Selling the
position also forfeits the seller's pending usage reward, measured at the day
the sale settles — a loss that grows the longer the transaction is delayed and
that neither the net floor nor the held ceiling can see. A finite deadline caps
that forfeiture to the window the seller chose, exactly as the listed route's
mandatory finite expiry does. A seller who genuinely wants no cap on any of the
three costs still has the original unbound sale; the bound entry, by contrast,
must bound all three, so it requires the deadline.

This mirrors the bound entry the listed sale route already offers, and exists for
the same reason: the platform's two sale routes must let a seller bind their
economics identically, or the same position could be sold on different terms
depending on which route it left by. The original unbound sale is unchanged and
still available; the bound entry is a strictly additional, safer option.

Closes #1922 (#1503 item 6) — the last of the four remaining lender-sale items
(5, 9, 15 already closed) being closed in place rather than by a new sale
instrument.
<!-- assembled-fragment: 1922-direct-sale-seller-bound.md sha256=bf99069cb08c6bcf4b52af8516f9aa6f153ee5fad4d578e14f61e0ab0340f3e0 -->

### A direct position sale must now fit what the buyer authored — on both size and term

When a lender sells an active loan straight into a standing buy offer, the buyer
steps into the loan as it stands. Two of the checks on that step were loose, and
both let a buyer end up in a position they had not agreed to.

**Amount is now an exact match, not a floor.** The path used to accept any offer
whose amount was at least the loan's principal, fund the principal, and refund
the rest — while consuming the whole offer and burning it. A buyer who had
authored a larger, fixed amount was placed into a smaller position than they
signed for, with their offer used up and nothing left to deploy at the size they
wanted. A sale now requires the offer's amount to equal the loan's principal
exactly; an over-funded offer is refused rather than silently trimmed. This
matches how the listed sale route already builds its vehicle — at exactly the
principal — so the same position can no longer sell on different terms depending
on which route it leaves by.

**The loan's remaining term must fit within the duration the buyer authored.**
The old check was inverted: it refused an offer whose duration was *longer* than
the loan's remaining term (harmless, since a sale never changes the loan's
maturity) while admitting a *shorter* one — so a buyer who offered to lend for a
few days could be locked into a position with weeks left to run. Because a loan's
maturity is fixed at origination and a sale cannot move it, the buyer's authored
duration acts as a ceiling on how long they consent to be locked, not as the
loan's term. A sale is now refused when the remaining exposure exceeds that
ceiling, and permitted when it is shorter — the same one-directional shape
already used for the loan's inherited risk terms and treasury-fee rate, where a
better-than-authored position stays sellable. The check is measured against the
maturity timestamp rather than whole days, so a fill cannot slip up to a day past
the buyer's window.

Both refusals name their specific condition. The former over-funding refund path
is removed with the over-funding it served. A companion guard refuses a sale once
the loan is at or past its maturity (it was previously caught only as a
side-effect of the old duration check), matching the listed route.

The connected app's direct-exit picker is updated to match: it now shows only
offers that cover the loan's remaining exposure and whose amount equals the
principal exactly, and re-checks both live before submission, so a user is never
shown — or allowed to submit — an offer the contract would reject.

Closes #1923 (#1503 items 9 and 15). Of the four lender-sale items being closed
in place, item 5 landed earlier (#1921); item 6 remains.
<!-- assembled-fragment: 1923-direct-sale-buyer-fit.md sha256=a03b9a3815dda8ab6bf64a6979a1917fb08f15f7dfbe45e0c4e932970116056a -->

## The published backing figures now include every amount subtracted from them (#1930)

The platform publishes how much of the recycling balance is unspent. That figure
is a remainder: it is what is left once each reserved class has been taken out.
Two of those classes — value quarantined while it is in transit back to the main
chain, and value set aside against a recovery position — were being read from the
contract and then dropped before the figure was stored, so they never reached the
page.

The effect was not a wrong number. The remainder itself was right. What was
missing was any way for a reader to check it: given only the answer and some of
the amounts subtracted to reach it, the arithmetic does not close, and there is
nothing on the surface to explain the gap. Those two amounts exist in the contract
specifically so an outside reader can reproduce the calculation instead of taking
the platform's word for it, which is the whole point of publishing the series.
Both are now stored and published alongside the figure they help explain.

Readings taken before this change do not carry the two new amounts, and they are
still served. A reading that predates the addition is a complete record of
everything it claimed to hold at the time, and the two newer amounts are simply
reported as not determinable for it. The alternative — treating those readings as
unusable — would have blanked the backing figures until fresh ones were taken, an
outage caused by improving the disclosure.

This does not change what the deployed contract returns. A separate operator step
is still needed before the two amounts appear on the live network; until then the
new fields stay empty, and nothing else about the surface changes.
<!-- assembled-fragment: 1930-indexer-recovery-reserves.md sha256=0769e043a58a9c432fec8005307dbea6628640e4aa86bc3e6eed231099ea3beb -->

## The launch deploy no longer puts a price on VPFI (#884)

The platform can give a lender their fee discount in two different ways, and
which one it uses depends on a single setting: whether VPFI has a configured
price. With no price set, the discount is simply taken off the fee — the lender
gets it outright, and no VPFI moves. With a price set, part of that same
discount is only available to a lender who actually pays the fee in VPFI.

The intended posture for launch has always been the first one: no price, discount
taken off the fee. The deploy scripts did the opposite. The step that configures
the price ran automatically as part of every deployment, so a platform that was
supposed to launch unpriced would come up priced, and lenders would silently be
on the second model rather than the first.

This was hiding behind a check that looked like it was watching for exactly this.
The check confirmed the price was unset — and it was, at the moment it looked.
The step that set it ran immediately afterwards. The check was true and the
deployment was still wrong, which is the most expensive kind of green.

Setting a price is now something an operator asks for deliberately, the same way
every other one-way switch on the platform works. A launch deployment leaves VPFI
unpriced, and the discount is delivered the way the design always said it would
be.

Two documentation errors turned up in the same area and are fixed with it: the
deployment runbook described this step as running on one network only when it
actually runs on all of them, and it listed the step as part of the standard
launch sequence, which it no longer is.

Asking for it takes one exact value. Anything else — a typo, a leftover setting
from a previous deployment, a plausible-looking word that means yes in some other
tool — leaves the price unset. A switch that decides which of two products the
platform launches as should not be reachable by accident, and the deployment
should not stop halfway through because someone wrote the wrong word for yes.
<!-- assembled-fragment: 884-launch-leaves-vpfi-unpriced.md sha256=69fa9ba53a89ca3c2cf8221e04a4913ce42907c016a2c55caa2c7b2593f52bb8 -->
