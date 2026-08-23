# Release Notes — 2026-08-23

The entries here group by kind rather than by order, and the summary names the
kinds instead of counting them — an intro that counts, or points at "the last
one", stops being true the moment another entry lands on the same day.

**Two exits that could be held open indefinitely, now bounded.** A borrower's
pending offset had no deadline and could be cleared only by the borrower who
posted it, so a borrower who walked away could freeze the lender's exit routes
for good. Separately, selling a position directly into a standing offer
discarded every term the buyer had authored, handing them a position that could
behave differently from the one they agreed to. Both are settlement paths that
move real money, and both were fixed the same way: by asking what the sibling
route already does. In each case the answer was already in the codebase — one
route had solved the problem and the other had been left behind.

**Checks that had stopped checking the thing they were named for.** A privacy
verification watched page load, while the wallet library it was policing only
phones home when somebody picks a wallet from the dialog — so the check passed
against a deliberately broken build. Published copies of the documentation were
filled in from figures frozen at compile time while the pages beside them read
the live configuration, an agreement that would have broken silently and
permanently at the first rate change. And the keeper's workload had never been
measured at all, so which of its passes could safely run less often was
guesswork. The shape recurs: a green signal that had quietly stopped covering
its subject.

**Tooling.** The release-note assembler moved to Python behind the same command
operators already run.

## The published documents now carry the same numbers as the pages

The site publishes plain-text copies of its documentation for automated
readers — search crawlers and AI assistants. Until now those copies were
filled in with the fee rates and tier figures **compiled into the build**,
while the pages a person reads fetch the live published configuration. As
long as nobody changes a rate the two agree, so the gap was invisible.

The first governance retune would have made it visible in an awkward way.
The rendered page would show the new rate. The published copy of the same
document would show the old one — not just until the next deploy, but
**indefinitely**, because those files are written from values frozen at
compile time and a rebuild would write the same frozen values again. An
assistant answering questions from them would have been confidently,
permanently wrong.

They are now written from the same published configuration the pages
read, using the same freshness and decoding rules rather than a second
implementation of them.

### Refusing beats guessing

If the configuration cannot be read, the publication step **stops** rather
than falling back to the compiled figures. That is the opposite of how the
pages behave, and deliberately so: a page retries on every visit and tells
the reader what it is showing, while a published file is served untouched
until the next deploy and can do neither. Silently shipping frozen numbers
is exactly the failure this change exists to remove, so it is not
available as a fallback.

An operator who genuinely wants to publish without a live read can say so
explicitly. When they do, the published index states on its own face that
the figures are build-time defaults and will not follow a retune — so a
reader of the file learns it, not just whoever ran the build.

When the read succeeds, the index records **which deployment** the figures
came from and **when** the snapshot was stamped. "Current as of this build"
is only worth saying if it comes with the moment attached.

### A specified position, reversed on purpose

The specification previously ruled this out, and gave reasons: reading at
publication time moves staleness from release to publication, makes
publishing depend on a service that can be down, and lets two publications
of the same source produce different files.

Those reasons still hold, and the owner's decision was that the
alternative is worse — an artefact one deploy behind beats one that never
moves and drifts without limit from the pages beside it. The dependency
concern is answered by refusing rather than guessing. The third is no
longer counted as a fault: after a retune, two publications of the same
source *should* differ, because the thing they describe did.

The old rule and its reasoning are kept in the specification rather than
deleted, so the trade-off does not have to be rediscovered by whoever
revisits it next.
<!-- assembled-fragment: 1664-item3-live-exports.md sha256=e8e10afbcc360343d41bb6bd88162038534d36b6db8f453170e90d0979adb4d4 -->

## A borrower's pending offset can no longer freeze a lender's exit forever (#1814)

When a borrower wants out of a loan, one of the routes open to them is to post
an offsetting offer — they take a lending position of their own that closes out
the one they owe. While that offer is pending, the lender's two early-exit
routes are deliberately refused, because either would start a second settlement
of a loan that already has one in flight and the two would race.

That refusal was meant to last until the offsetting offer either completed or
was cancelled. The problem was that a pending offset had no deadline of any
kind, and only the borrower who posted it could take it back. So the refusal had
no end: a borrower who posted an offset and then simply walked away left the
lender unable to use either exit route, indefinitely.

It is worse than indefinite, because the offer outlives its own purpose. An
offset can only complete if the replacement loan it creates would finish by the
original loan's end date. Past a certain point no acceptance can ever succeed
again — so the offer sits there unfillable, still blocking, and still removable
only by the person who has stopped responding. This is not hypothetical: a
pending offset in exactly that state was found on the test network, three weeks
old, against a loan that had ended a fortnight earlier.

A pending offset now carries a deadline, and giving it one is what fixes the
freeze — because it puts the offer back under a rule the platform already had.
An offer past its deadline can be cleared out by anyone, not just the person who
posted it, and clearing it releases the borrower's position, drops the link to
the loan, and returns the borrower's own posted funds to the borrower, exactly
as their own cancellation would have. A lender no longer has to wait on a
borrower who has gone quiet, and nobody gains anything by doing the clearing.
The borrower keeps their unconditional right to cancel at any point before the
deadline.

The deadline is set at the moment the offer stops being acceptable, and that is
**earlier** than the loan's end date — earlier by the length of the replacement
the offer proposes. Because the replacement loan starts when the offer is taken
up, an offer proposing a three-week replacement stops being takeable three weeks
before the loan ends, not when it ends. Anchoring the deadline at the loan's end
date would have left the offer unusable but not yet lapsed for exactly that
span, with the freeze running on through it — and for an offer proposing the
loan's entire remaining term, that span is the whole term, meaning the fix would
have done nothing at all in the case that needed it most.

One consequence is worth stating because it looks odd and is correct: an offset
proposing a replacement exactly as long as the loan's remaining term can only be
taken up in the instant it is posted. That is not the deadline being harsh — it
is the existing replacement-term rule shown honestly, rather than hidden behind
an offer that looks open but can never be taken. A borrower who wants a usable
window proposes a shorter replacement, and gets a window exactly as long as the
difference. Posting the full-term one is still allowed; what would be wrong is
refusing to create it, which is where an earlier attempt at this deadline went
astray.

Nothing about the replacement-term rule itself changes. Whether a replacement
would really run past the original end date is still decided when the offer is
accepted, measured against the moment the replacement actually starts. The
deadline neither replaces that check nor tightens it.

Closes #1814.
<!-- assembled-fragment: 1814-offset-vehicle-expiry.md sha256=26452cdd6071b5961c3e3f82286578ef468f197d6e841f871e93addc9ad0ec0d -->

## Wallet telemetry: the check was watching the wrong moment

An earlier change turned off the analytics phone-home in the wallet
libraries the app embeds — the beacons users never opted into, which also
fill the browser console with errors on locked-down networks. A live check
confirmed the deployed sites were silent, and the work was recorded as
verified apart from one gap: nobody had put a real wallet through an
actual connect.

Closing that gap found something about the check itself.

The wallet library sends nothing while a page loads. It sends when
somebody **picks it** from the connect dialog. Measured against a
deliberately re-broken build: loading the page produced no beacons at all,
opening the dialog produced none, and choosing the wallet produced six
immediately, with two more as the connection completed. The original check
only ever watched the page load — so it was watching the one moment in the
flow when nothing is sent, and would have reported a clean result whether
the setting was on or off.

The new check walks the real path: arrive as a first-time visitor, open
the dialog, choose the wallet and let its software actually start up —
then, because finishing inside that wallet needs a person, complete a
connection through the **test wallet the check injects**, and return as a
repeat visitor. Naming which connector completes it matters: the gap this
work was closing was "nobody has put a real wallet through a connect",
and that gap is narrowed here, not closed. On the live site
it is silent at every step. Against the re-broken build it fails loudly.
That pairing is the point — a check that has never been seen failing is
not evidence of anything, and this one had not been.

It also writes down what it cannot see. It stops where the wallet's own
window opens, because finishing a connection there needs a real wallet and
a person.

### The second wallet library, and a check that isn't one

The other way of connecting — the one that shows a QR code for a phone
wallet — was switched on the same day. It appears in the dialog as
**"Other Wallets"** rather than under its own product name, which is worth
knowing: the first version of this check looked for the name, found
nothing, and would have reported the feature missing while it was plainly
working.

Its own privacy setting is a different story, and the honest answer is
that it is **still unverified**. Turning the setting back on and measuring
again produced exactly the same silence as leaving it off — tried twice,
including with genuinely valid credentials so the connection was known to
be healthy. That library evidently only reports home later in a session,
after someone has actually paired a phone. A measurement that reads the
same whether the setting is on or off is not evidence of anything, so the
check records the number and explicitly declines to call it a pass.

Saying "we could not test this" is the point. The alternative — a green
tick standing on a measurement that cannot fail — is worse than an
acknowledged gap, because it stops anyone looking again.

### A privacy beacon that never worked

Separately, the hosting provider had been injecting its own analytics
script into every page, and the site's own security policy refused it on
every load. It gathered nothing while filling the browser console with
errors — errors every review had to read past, which is how genuine
problems hide. It turned out to be a single zone-wide setting covering all
three sites, not a per-site one, which is why nobody found a switch for
this app.

It is off now, and the routine sweep of the deployed site went from
reporting these on every page to **54 of 54 pages clean**. The security
policy carries a note saying the omission is deliberate, so the next
person does not helpfully add it back.
<!-- assembled-fragment: 1836-connect-path-telemetry.md sha256=bda5a304894bf19906c177789017e1565440fdccc420a9fe4e70bf160762b3a4 -->

## Release-note assembly moved to Python, behind the same command

The script that folds pending release-note fragments into a dated file is
invoked exactly as before. What changed is what sits behind that command:
the work now lives in a Python program, and the shell file is a thin entry
point that finds an interpreter and hands the arguments straight through.

The reason is the shape of the failures the old version kept producing. It
had reached roughly 2,600 lines and forty-six review rounds, and the
findings had stopped being about the design — they were about its
application. A guard placed one step too late. A check that answered for
the moment the run started rather than the moment that mattered. Two lists
describing one fact and disagreeing with each other. That is what a program
too large to hold in one head produces, and no amount of care about the
next line fixes it.

The transactional core is also the part a shell is worst at. Rename, stat,
hash, temporary file, signal window: every one is a separate command whose
failure has to be noticed and routed by hand at each place it is used, and
the missed routing was the recurring finding. In the new implementation
those failures raise on their own, and every fallible step reports through
a single place, so a failure reads the same way wherever it happened.

### What operators need to know

**Python 3.10 or newer is now required, and Bash 4 is not.** The entry
point interrogates each candidate interpreter rather than trusting its
name, so a `python` that is still Python 2 is refused with a clear message
instead of running into a syntax error. Stock macOS Bash 3.2 is now fine
and there is no `brew install bash` step; the test suite still uses Bash 4
features, but that is a requirement for contributors changing the
assembler, not for anyone folding fragments. Both operator documents have
been corrected — they previously stated the opposite in both directions.

Behaviour is otherwise unchanged, and the test suite is what supports that
claim — but it should be stated more carefully than "the tests still pass",
because the suite itself changed a great deal. It drives the command line
rather than any internal, so the CONTRACT it checks carried over unaltered.
The suite around that contract did not: it grew by roughly a thousand lines
and lost four hundred, and it currently records 41 whole cases and 29
individual assertions as retired. What survived unchanged is the external
behaviour each case describes; what was rewritten is how the fault gets
produced. That is weaker evidence than "the same tests pass against the new
implementation", and it is the honest description of it.

### The suite now checks its own retirements

Some cases in that suite injected a fault by breaking the specific command
the old shell version happened to run. Those faults cannot be produced any
more, and such cases were marked retired with a stated reason. Marking is a
claim, and reading the code to decide was wrong nineteen times — three
cases were retired as covered elsewhere when they were not covered at all
and still worked perfectly, and sixteen more simply passed. All nineteen
were restored, and the suite now proves each remaining retirement by
lifting it and requiring the case to fail. A retirement that cannot be
demonstrated is no longer allowed to stand — which is the only reason the
41 that remain retired can be read as a considered decision rather than a
convenience.

Closes #1877. Closes #1886.
<!-- assembled-fragment: 1877-assembler-python.md sha256=a674715efe4b632b2bf295e40896a353997298989d266a01aa522d0e2a4f4b1c -->

## The keeper can now be measured, and most of its work turns out to be unskippable

The `vaipakam-keeper` Worker runs ten periodic jobs on an every-minute
schedule and had been exceeding the CPU time its plan allows. The obvious
remedy is to stop running everything every minute. This change went
looking for that saving, found far less of it than expected, and the
finding is the more useful half of the work.

### What changed

The ten passes are now declared in one table, each naming how often it
runs and why, which the scheduler walks. They were previously ten
hand-written blocks repeating the same four concerns — trap the errors,
name the pass, decide the cadence, time the run — and four things
remembered ten times is how a job ends up running every minute for no
reason anyone recorded.

Every pass now reports how long it took, including when it fails, and a
pass held back by its cadence says so and why. That follows a rule the
keeper already had for a different kind of idleness: a pass blocked by a
misconfigured arming flag names the flag and what was wrong with it. A
job that has quietly wedged must never look the same as one that is
simply waiting its turn.

### Only two of the ten can safely run less often

Each cadence was supposed to come from a timing assumption the pass
already documented. Three of the first five did not survive review, and
all three failed the same way — a real constant was read from the file,
and it turned out to govern something adjacent to the thing that
actually matters.

- **Liquidity confidence** was slowed on the strength of an hour-long
  cache. That cache backs *promotions*; the path that **demotes** a
  degrading asset re-checks the market every run and lowers its
  borrowing power immediately, because that is the fail-safe direction.
  Slowing it meant a degraded asset could keep generous terms for half
  an hour while new loans were written against it.
- **Commitment reporting** was slowed because its reports are keyed by
  day — true, and beside the point. It deliberately stops part-way
  through a large backlog and resumes where it left off on the next run,
  so the tick rate *is* the drain rate, and another chain's remittance
  waits on it finishing.
- **Acknowledgements** were slowed on the strength of a retry backoff
  that governs *re-sends*. Noticing a delivery for the first time has no
  earlier attempt to be backed off from, so nothing bounded that latency
  except the cadence itself.

A fourth, **auto-extension**, was pulled back for the same reason before
review reached it: it stops after a fixed number of extensions per run
and does not deal with the most urgent first, so running it less often
drains a backlog proportionally slower against deadlines that are
enforced to the second.

What is left is genuinely idle most of the time: the pre-grace warning,
which fires inside a 24-hour window and re-scans from scratch each run,
and the reward-budget top-up, whose own notes say re-scanning each run is
harmless and keeps no state. The daily oracle snapshot now runs only
inside the ten-minute window it acts in, rather than waking 1,430 times a
day to decide it has nothing to do.

### The honest arithmetic

Spacing the remaining jobs apart still matters, because the limit is
charged per run rather than per day: jobs on every-5, every-15 and
every-30-minute cadences all land together on the hour unless they are
given different minutes. An early version of this change missed that and
reported a 63% saving while the busiest minute was unchanged — the
average moved and the number that matters did not.

With the unsafe cadences reverted, the real figures are a busiest minute
of nine jobs rather than ten, and about a quarter fewer runs per day.
That is not a fix, and this note should not be read as one.

**The conclusion is that this approach cannot solve the problem.** Seven
of the ten jobs have to run every minute for reasons that are about
correctness and safety rather than convenience. The CPU has to come down
by making a run cheaper — reading candidates from the existing database
instead of re-deriving them from the chain, and bounding the work each
run does — not by running less often. The timing added here is what makes
that next step a measurement rather than another guess.

Part of #1896, which stays open.
<!-- assembled-fragment: 1896-keeper-pass-schedule.md sha256=bf577624d31e3ea793d1ff1a16f44d1714d73624902ddeb6da0edea6adaa7b32 -->

## Selling a position directly can no longer hand a buyer terms they never agreed to (#1912)

A lender leaving a loan early has two ways out. They can put the position up for
sale and wait for a buyer, or they can sell it straight into an offer somebody
has already left standing. Both move the same position to the same kind of
counterparty, and the platform requires them to behave identically — a rule that
applied to one and not the other would let the same position be sold on
different terms depending on which door it left by.

They were not behaving identically.

A loan carries terms that decide what the borrower may do to whoever holds the
lender side: whether the loan may be repaid in parts, whether interest is owed
for the whole agreed term or only for the time the money was actually out,
whether interest settles periodically, and whether the borrower may put the
collateral up for sale. It also carries the identity of the specific asset
backing it.

On the listed route none of this can go wrong, because the offer put up for sale
is built from the live loan. What the buyer reads and agrees to is the
position's real behaviour, and nothing else can be delivered to them.

The direct route works the other way around. It spends an offer its author wrote
earlier, for a loan that did not exist yet — so there is nothing to build from,
and the two descriptions have to be reconciled instead. They were not being
reconciled at all. Every one of those terms was simply discarded, and the buyer
inherited whatever the loan happened to carry. Someone who wrote "no repayment
in parts" could be moved into a loan that allows it; someone who chose full-term
interest could end up on a pro-rata loan.

The most consequential of them reached past the buyer entirely. Permission for
the borrower to put the collateral up for sale is fixed when the loan is
created, and that is the copy the platform checks later. A buyer who had
declined that permission could inherit a loan where it was granted — after which
the borrower could list the collateral against a lender who had never agreed to
it.

The direct route now refuses a sale whose standing offer disagrees with the
position it would buy, and says which term disagrees rather than failing
generically — a seller can act on "the buyer's offer expects no partial
repayment", and cannot act on "invalid offer".

The check is exact rather than lenient in the buyer's favour. Being handed
*stricter* terms than you wrote still leaves you holding a position you did not
agree to, and the listed route could never deliver that, so accepting it here
would recreate the very door-dependent difference the two routes are forbidden
to have. Terms the listed route leaves alone are deliberately left alone here
too, for the same reason read backwards.

Nothing changes for a sale where the offer and the position already agree, which
is the ordinary case: an offer written with the usual defaults against a loan
carrying those same defaults fills exactly as before.

This is the same defect that was found and fixed on the listed route earlier,
arriving late on its sibling. That it could sit open on one route after being
closed on the other is the more useful lesson: the two routes are checked by
separate hand-written lists, and nothing forces a term added to one to appear in
the other. The code now says so plainly where the list lives, rather than
implying a safety net that does not exist.

Closes #1912.
<!-- assembled-fragment: 1912-direct-sale-term-parity.md sha256=6074299544a8a1103a316471e793d8391e72c9801fad2158b83190b2aa1955db -->
