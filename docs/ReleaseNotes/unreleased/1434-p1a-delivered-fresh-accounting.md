## Each chain now records how much reward funding it was actually sent

Groundwork only. Nothing reads this yet and no behaviour changes — it is the
first of three steps toward letting secondary chains pay rewards at all.

### The gap it fills

Reward funding for secondary chains is sent from the main chain. Until now,
when a secondary chain worked out how much it could still pay out, it
consulted the **programme-wide lifetime cap** less what it had paid locally.
That figure is nearly meaningless there: every secondary chain computes it
independently, so each one concludes it has almost the entire programme
available. What actually limits a secondary chain is what the main chain sent
it, and nothing was counting that.

A recent change did narrow this. Before paying, a chain now refuses if the
amount exceeds the tokens it holds that are not already spoken for. That is a
real improvement and it prevents the worst version of the problem. But it
measures **what the chain happens to be holding**, not **what was delivered
to fund rewards** — so tokens that arrived for some other reason (a donation,
an operator transfer meant for something else) can still be paid out as
rewards, and the main chain's own accounting never sees it happen.

So each chain now keeps a running total of the reward funding delivered to it
for coordinated-mode days, separating the portion that is genuinely new from
the portion that is recycled value being relocated. The recycled portion is
already tracked elsewhere; counting it here too would double-count the
backing.

### Two tests a delivery has to pass — and what happens when it fails one

**It has to say what it is made of.** Deliveries arrive in one of three
formats, and the two older ones never carried the new-versus-recycled split at
all. On those, a recycled portion of zero means "not stated", not "none was
recycled" — and from inside the accounting the two are indistinguishable.
Working the new portion out there as "everything that wasn't recycled" would
therefore record a delivery of *entirely unknown* composition as *entirely
new*: over-stating exactly where least is known. The component that receives
the delivery is the only party that knows which format arrived, so it now
states the new portion outright, and for a format that cannot say, it states
**none**.

**It has to be funding for the days this figure governs.** Every day the
delivery covers must be at or after the day that chain switched into the
coordinated mode. Funding for earlier days belongs to the ordinary schedule,
which this figure does not govern.

A delivery failing either test is **recorded as uncounted**, not discarded.
The tokens still arrive and are still counted in the overall received total;
what changes is that they do not widen this particular figure. That matters
because both exclusions are otherwise invisible: an uncounted delivery moves
real value and changes nothing else, so without a counter the only symptom
would be payouts waiting on funding an operator can watch arriving. The two
totals are published together and always account for the whole non-recycled
delivery between them, so they can be reconciled against what was actually
sent.

One case is deliberately conservative. A delivery whose days **straddle** the
switch is refused whole rather than split: the main chain decides day by day
but sends one combined amount, and nothing at the receiving end can divide it
again. Guessing would over-state. Refusing under-states, which delays a
payout; over-stating would pay out funding nobody sent. The uncounted total is
what makes the difference visible instead of silent.

### What this is not, and why the obvious next step is missing

These are **receipts**. They say what arrived and how it was attributed — not
what remains, and not a limit on anything.

The tempting shortcut is to subtract lifetime payouts and call the remainder
headroom. That is wrong twice over, and an earlier version of this change was
withdrawn for doing it. Lifetime payouts mix ordinary-schedule payments — which
no delivery funded — with coordinated-mode ones, and no single starting point
separates two sources inside one running total. Fixing that by noting the
payout figure at switch-over made it worse, not better: it left funding that
had been *delivered and already spent* before the switch reading as still
available, because the note erased the spending while the receipt survived.
That direction over-states, which licenses the very payout the figure exists
to prevent.

So the *paid* half is not derived here at all. It needs the amount paid **for
coordinated-mode days specifically**, which the payment path does not currently
report — a payment trimmed by a per-loan ceiling keeps its full obligation on
record while the amount actually transferred sheds the trimmed part, so no
combination of what it reports is the sum that moved. That lands with the step
that consumes it, alongside the deferral rule below, rather than being guessed
at now.

### What comes next, and why this cannot be used yet

Secondary chains do not currently price reward days in the coordinated mode at
all — that is deliberately blocked, and the block cannot lift until a separate
problem is solved (a day the main chain deliberately funds at zero would
otherwise be permanently closed out at zero, before the compensating payment
can reach it). Until that lifts there is nothing for this budget to limit,
which is why this lands as accounting with no consumer.

When it is applied, a shortfall must **postpone** the day rather than pay a
reduced amount. The existing shortfall behaviour trims and moves on, which is
right against the lifetime cap — that ceiling only ever falls, so a trimmed
remainder can never be funded later. A delivered budget is the opposite: it
**grows every time more funding arrives**, so trimming would permanently
underpay a day whose funding was merely still in transit.
