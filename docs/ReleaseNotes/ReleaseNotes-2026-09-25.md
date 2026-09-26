# Release Notes — 2026-09-25

Nine changes, listed in the order they merged.

The first three change how these notes are produced, and nothing the platform
does. All three close ways the assembler could publish a fragment twice or
misreport what it had done, and each was found by reading the code and
reproduced in a test rather than observed in the published notes. The third
builds on the first.

The other six:

- one change to the contracts: reward transport epochs now pay a listed day
  from its epoch first (PR #2276);
- two to the end-to-end tests: a walkthrough of what an advanced user would do,
  run against a local copy of the live test deployment (PR #2320), and a
  reverted setup step that now says why it reverted (PR #2335);
- one to the app: a failed transaction's explanation no longer mistakes the
  request for the error (PR #2338);
- two to repaying a loan from its collateral: a direct swap now sells only what
  the debt needs (PR #2339, closing #2317), and the auction route puts up only
  what the debt needs, with the rest staying pledged (PR #2341, closing #2322).
  Their headings below name the issues rather than the pull requests.

Eight other merges landed the same day and are not written up below, because
none changes behaviour. PRs #2319 and #2329 published notes: the previous
day's, and the first three sections of this file. PR #2324 changed heading
levels, and nothing else, in ten earlier dated files: 32 sections had opened
at the level of a document title and now open as sections of their release,
with five of them moved down whole so their own subsections stayed
subsections. PR #2331 did the same for 46 sections, in nine files, that had
opened one level too deep. PRs #2325, #2326 and #2327 reorganised the
assembler's own documentation so that each rule is explained in one place
rather than several. PR #2340 removed a duplicate copy of the revert-reading
code from the end-to-end tests in favour of the app's own, which returns the
same result.

## An older dated file the assembler cannot read is now refused rather than guessed at (PR #2321)

Folding release-note fragments into a dated file has a check for one accident:
an older run that was interrupted after publishing a fragment but before
removing it. In a file written before assembly markers existed, nothing
records that, so the assembler looks for the fragment's heading and refuses to
append it a second time.

That check compared bytes, and older runs published a fragment exactly as it
was saved. A fragment saved in UTF-16 or UTF-32 therefore sat in the dated
file in a form the check could not even recognise as a heading. The first run
after such an interruption was refused anyway, because the pending copy could
not be read either. But the refusal does not say why, and the obvious remedy
is to re-save the pending copy as ordinary UTF-8 — after which the two copies
were in different encodings, the next run found no match, published a second
copy, and deleted the source. An older single-byte encoding could reach the
same end by a less likely route: its first rerun is refused as a duplicate,
with instructions that do not suggest re-saving, but an author who re-saved
anyway met the same loss. Reproduced for UTF-16 with and without a byte-order
mark and for a single-byte encoding before the fix.

The assembler now asks the question it can actually answer. If the dated file
has no markers and contains anything that is not plain UTF-8 text, the run
stops and says it cannot tell whether a pending fragment is already there,
before anything is published or removed. That refusal reads only the published
file, so re-saving a fragment does not get past it; reading the file and then
deleting the fragment, or re-running with `--force-append`, does. (As merged,
a file that already carried markers only reported the condition as a note;
later the same day #2328 narrowed that — see the last section below.)

It does not try to decode the other encoding: that would mean guessing which
parts of one file are in which encoding, with nothing to check the guess
against. Every existing dated file is plain UTF-8, so nothing that assembles
today is refused. Closes #2315.
<!-- assembled-fragment: 2315-unreadable-dated-file-is-refused.md sha256=80ef520b4e7cb0875dcc5800f4c6c575549ead7546c555590a65e9cd70dfac93 -->

## Text quoted back from a fragment can no longer rewrite the assembler's messages (PR #2323)

When the release-note assembler refuses a fragment, it quotes the offending
line and names the file, so the author can find what to fix. Nothing filtered
what it quoted. A terminal acts on control sequences rather than printing
them, so a fragment whose opening line carried the right few bytes could
erase the refusal on screen and print a success message over it. The run
itself still refused — nothing was published and nothing was deleted — but
the operator's view of what happened could be forged, which is the one thing
a tool built to refuse clearly must not allow.

Every message now passes through one point that shows each control character
as a visible escape such as `\x1b`, instead of letting the terminal act on
it. That covers file names as well as quoted lines, and any message added
later. The characters are shown rather than removed, because a stray control
character in a file name is something the operator needs to see in order to
find the file. The invisible characters that reverse the direction of text
are treated the same way, since they can reorder a line on screen without
any control sequence. Ordinary text, including the em dash every heading
here uses, is printed as before.

Anything quoted from a fragment — a line, or a list of the references it
refused — is also cut off after 160 characters as a whole, with a note of how
much was left out, so a long line or reference list cannot bury the message
around it. Closes #2302.
<!-- assembled-fragment: 2302-quoted-text-cannot-forge-output.md sha256=fd5770af2701dc1710457f9bac6f0c2eb26dd86c8836cb7e5438a92179167845 -->

## An older release-notes file that has gained one marker no longer loses a fragment on rerun (PR #2328)

Folding a release-note fragment into its dated file leaves a small invisible
marker behind, which is how a later run recognises a fragment it has already
published. Files written before markers existed have none, so for them the
assembler falls back to a weaker check: if the file already contains the
fragment's heading, it stops and asks rather than appending a second copy.

That check looked at whether the file had any marker anywhere. A file written
wholly after markers existed is fine under that rule, but most dated files are
older, and each gains its first marker the next time anything is folded into
it. From then on, one marker at the bottom switched the check off for every
older section above it: a fragment matching one of those was published a
second time and its source deleted. This was found by reading the code and
reproduced in a test; no duplicate has been traced to it.

The check now asks the question per fragment: does this file record a marker
for this fragment's own name? If it does, the pending text is either an edit
made after an interrupted run or a new fragment reusing an old file name;
neither loses anything by being appended, so it is appended with a note as
before, asking for a superseded copy to be checked. If it does not, the run
stops and asks, whatever other markers the file carries. The same rule now
governs the refusal for a dated file that cannot be read as plain text, and
that check no longer counts the markers themselves: a marker records a
fragment's file name exactly as the filesystem gave it, which need not be
plain text, and one such name used to make a whole file look unreadable.

The cost is a refusal when two different fragments in one day's file share a
title exactly. In every dated file in the repository, the only repeated
headings are subsections such as "Verification" — no two fragments share a
title — and `--force-append` remains the override once the file has been
checked.
<!-- assembled-fragment: 2312-marker-coverage-per-fragment.md sha256=1f8c4cf7837e9d417c0b1a76e09928cde2da2583aec76c5fd7ad97c7c2dba7e0 -->

## Reward transport epochs — the draws (#1566 PR 3b-ii-A)

The previous transport-epochs release gave every old-wire reward delivery
its own **epoch**: one untyped balance, bound to the days the delivery
named, that nothing could yet spend. This release lets the obligations on
those days spend it.

When a claim, a forfeit or an expiry settles an armed day that an epoch
lists, the day is now paid from that epoch **first** — ahead of the live
delivered ledger and ahead of the recycle bucket — and only the residual
reaches the shared sources. This is the order the design requires: a
claim whose matching transport sits parked must not draw down the funding
every other claim shares. The rule is applied in exactly one place, the
day pricing every one of those settlements already goes through, so the
claim, the forfeit sweep, the expiry sweep and the preview the claimant
sees cannot disagree about what an epoch pays. The preview says what the
claim will do; the executable-now predicate that drives the expiry clock
reads the same figure. That predicate's recycled test now reads the claim
walk's own draw on the recycle bucket — net of what the epochs pay, the
day the walk would refuse included — where it previously compared a
pre-cap upper bound. The bound could not be netted by an exact epoch
figure: on a day the per-user cap trims, the difference left a residue no
claim would ever draw, and an obligation an epoch covered in full read as
a bucket drought without end, its expiry clock never starting. The walk's
figure carries what the bound was kept for — it is the joint draw of the
claimant's whole day set, and it is measured day by day — without the
slack. A settlement the walk would refuse because more epochs list a day
than one read scans is likewise not executable until the day's cursor has
been pruned, which anyone may do.

An epoch's balance is untyped, so when it cannot cover both of a day's
legs it is split in two steps. First the day's own shortfalls — each leg's
need net of the source that already covers it (the delivered ledger for
fresh, the bucket for recycled) — because a day cannot settle otherwise.
Then whatever coverage remains goes to whichever leg carries the greater
deficit against the shared sources over the **allocation domain**, fresh
first on ties. The domain is the days one settlement call prices for one
claimant — a single day for a forfeit or expiry sweep — and its needs are
totalled once per call and worked down as days settle; nothing is carried
across calls. The domain is deliberately the GROSS needs — what the call
would price if every day settled — not the days a funded call ends up
settling: those depend on which leg each epoch's leftover coverage took,
which is the very choice the domain guides, so a funded domain would be a
fixed point with no single-pass answer. The choice only decides which shared
source pays an obligation in the call — never whether value is paid, moved or
lost — and a day it leaves short defers whole to the next call. Since an
epoch is drawn only once attested, and an attested epoch's two component
rooms together never exceed its balance, the choice has nothing to decide for
any epoch ingress creates today; it is kept for an epoch whose rooms together
exceed what it holds. The same pass's quick check for whether any reachable
day lists an epoch now gives each side the whole day allowance, since a side
that defers on its first day leaves the next side all of it. Two of the
design's own cases are the reason. Five fresh and
five recycled, with five of live fresh, an empty bucket and a five-token
epoch, is fully payable only if live pays the fresh and the epoch pays the
recycled — a blind fresh-first rule would refuse a claim the funding fully
covers. And one claimant over two days, each needing fresh and recycled,
with live covering both days' fresh, the bucket only one day's recycled,
and an epoch worth one day's recycled listing the first day, settles both
days only if the epoch pays that day's recycled: a rule that looked at
the first day alone would spend the epoch on fresh, drain the bucket, and
leave the second day waiting. What crosses a call — a long obligation's
later days, or other claimants' demand on the same shared sources — is
the overlapping-membership matching the contested-allocation machinery is
for, and this release states that rather than pretending to a scan it
cannot afford.

What each ledger sees afterwards follows from the source. The 69M emission
cap and the delivery's commitment retire by the full figure — an
epoch-funded payout is still emission, and the obligation ended. The
delivered ledger and the bucket are charged only for what they actually
paid. The epoch-paid share leaves the custody row where an epoch's value
rests and goes to the claimant directly, or, for a forfeit or an expiry,
recycles in place, because there is no claimant to transfer to. An
epoch-funded forfeit or expiry therefore settles even while the live
backing row is empty, which on a mirror funded only by the older wire is
the ordinary case; a live-funded one is bounded by that backing exactly as
before, and a shortfall of it still defers.

Every draw is recorded on the epoch as a fresh leg and a recycled leg, so
the ledger's conservation identity — what was admitted equals what is
held, plus what was parked, plus what left by classification, plus what
the legs paid — holds after every draw, and a delivery's attested fresh cap
is netted by the fresh leg its epoch has already paid.

**An epoch is drawn only once its split is attested.** Until the source
chain's attestation of a delivery's fresh/recycled split lands, its epoch is
withheld from every day's draws and reported as withheld for that reason.
A leg is typed once, by the caps it is drawn under, and never retyped. An
earlier version drew an unattested epoch and retyped its legs when the split
arrived — but by then the claim had already charged the bucket, released the
recycled commitment and charged live funding for the legs as first typed, so
the retyped epoch and those ledgers told different stories. Once attested, the
epoch pays each leg only within that component's remaining cap, each cap read
net of the classification the delivery already carried; a classification
recorded before the split that already exceeds a cap is not undone by the
attestation — it is recorded as a divergence for the correction path, and no
further draw or classification of that component is admitted meanwhile. A
later classification correction moves no drawn leg either: where it takes a
component's classification plus that component's drawn leg past the cap, the
excess is reported on the same divergence view and no further draw of that
component is admitted. A deferred settlement's cursor move is progress the
claim keeps even when it paid nothing, so a retry never scans the same
exhausted window twice, and such a deferral ends that call's settlement on
every side, so the preview — which cannot move the cursor — describes what
the claim did, and the preview simulates the cursor advance a side's
draw performs — exactly where the claim's settlement would reach that
draw, and nowhere else — so its later sides read what the claim's would. A day's reported coverage counts only what its epochs can
pay through at least one leg, and an epoch whose attested split leaves no
room under either cap is passed by the day's cursor as exhausted even
though a residual unit remains, so it cannot hold a window slot forever.
The residual leg of an epoch's coverage is chosen
on each leg's deficit net of what the day's own shortfalls already drew.

A day's index is kept in **arrival order** whoever indexes it — an epoch
indexed late takes its place by arrival, or, when that place is among the
epochs the day's cursor has already passed, its place by arrival among the
epochs after the cursor, so it is never behind the cursor, the cursor never
moves back (which is what lets the day report its consumption as an exact
count in constant work), and which late epochs a window holds is the
ledger's choice and not the indexer's; same-block arrivals in a fixed order by delivery identity, and each epoch
linked into its place in constant work (a materializer may name the
predecessor; without one the ledger searches back from the newest for a
bounded number of steps and refuses beyond that), so indexing an epoch
late never costs more than indexing it on time; every epoch is linked as
it is indexed, so a day's order holds it whole from its first member and
a day is read one way only — an earlier revision of this release carried a
second, membership-ordered read path for days indexed before the order
existed, with a catch-up step and a switch-over; no chain ever held such a
day, and two read sources were the root of several review findings, so the
path was removed rather than carried —
so the **bounded window** a day is read through always holds its oldest
epochs, and within the window they are spent in an order the ledger
fixes rather than the order anyone indexed them: the **oldest arrival
first**, the epoch's identifier on ties; the order is a
property of the epochs in the window, never of who indexed them or how
they were read, and that order is the priority in which epochs are spent.
An epoch's flexible balance — what either leg may take — is held back
from a leg only where a later epoch's capacity for the other leg could
not otherwise be used, so the two legs are paid the most any assignment
could pay them without a lower-priority epoch being spent ahead of a
higher one. Where either leg could take a flexible unit and the day is
covered the same amount either way, it goes to the leg that would otherwise
have to **reach furthest** into the window to be served, so the epochs
actually opened are the earliest ones and the furthest — which may be the
only one funding another day — is left standing. A leg the window cannot
serve at all reaches past its end, the furthest there is, so it is served
at once, which is the same rule as the reservation above. Coverage one leg's cap rejects
is offered to the other leg; a day wider than one window is read through
that window and draws from it, rather than being refused outright, because
the window is always a prefix of the day's one order; an attested
epoch pays each leg only within that component's recorded cap, and the
one unit a scaling residual can leave outside both caps is never drawn
and stays in the epoch for the close-out's disposition path; and a
forfeit's or an expiry's recycled slice is a commitment release, not a
funding pull, so it draws no epoch value — the epoch's coverage goes to
the legs that need funding. The spending order is fixed by the ledger —
arrival, then identifier — because indexing is open to anyone and its order
would otherwise decide who gets scarce funding. An epoch whose membership is still being
written in pages is invisible to every day until its last page lands, so
a first page's days cannot drain what later pages' days were owed. When
more epochs list a day than one window scans, and the visible coverage
cannot cover the day while a residual would otherwise fall through to the
shared sources, the day is deferred rather than paid short: nothing is
drawn and nothing is staged, so there is nothing to unwind, and the day's
cursor is moved past any epochs already exhausted by other days so the
next attempt sees a fresh window. Anyone may run that cursor maintenance
for a day at any time. A transaction draws from at most one hundred and twenty-eight epochs over every day it settles — the bound is the transaction's gas, so two settlements batched in one transaction share it; a day whose draw would take the transaction past that is deferred exactly as a day whose epochs exceed one window is — nothing drawn, the days before it standing, and a settlement batched after one that spent the budget pays nothing rather than failing the batch — and the next transaction starts there, so a claimant funded by many small epochs progresses a few days per transaction rather than never. The follow-up release adds the staging that lets a
day wider than one window make progress; until then such a day waits,
with its value protected in its epochs. A day no epoch lists costs one
storage read and no call, on every chain, and the domain rule's own pass
first reads, without pricing anything, whether any day the call could
price has an epoch listed — the same reads the pricing makes — so both
are decided from the ledger itself: the draws and the split are right
from the first block of an in-place upgrade over a ledger that already
holds epochs, with nothing to count and nothing to migrate. Every draw is
also recorded on the delivery's own packet as an exit, so the packet's
identity — what it put in equals its untyped remainder plus every exit —
holds after each draw as the epoch's conservation identity does. The
claimant's armed-need reading keeps its shape; it counts the epoch-paid
fresh in the requirement it reports and says, beside it, how much of that
the live delivery must fund.

The preview a claimant sees simulates the draws it predicts, on either
side of the claim: within one
preview, an epoch listing two days is not counted for both, so the figure
shown is the figure the claim pays. And a claim's recycled leg that an
epoch paid retires its commitment the way a forfeit's does — without a
bucket debit, since the bucket never paid it — so what the mirror reports
as fundable is not depressed by obligations that have already ended.

**An epoch listing more than one day is withheld until contested
allocation lands.** The design refuses a draw that another day's known unmet
obligation is competing for, and draws an epoch listing a not-yet-arrived day
only for a day's gap. Neither condition can be checked yet: an epoch records
how many days it lists but not which ones, and there is no per-day record of
unmet obligations. So every epoch listing more than one day is withheld from
every day's draws, reported as withheld for that reason, and kept whole for
the contested-allocation machinery, which settles it. An intermediate version
of this change drew such epochs last, for a day's gap only; that still let an
underfunded day drain an epoch another day's unmet obligation was counting
on, which is exactly the contested draw the design refuses. A day that only a
shared epoch could fund defers until then; nothing is spent or lost.

**A claim now allocates against the live funding it will actually be
checked against.** The claim chose which part of a day an epoch pays using
the delivered ledger alone, while its final check requires every live-paid
unit to be backed by tokens actually held. With the ledger showing funding
the backing could not support, the allocator could spend an epoch on the
recycled leg and leave the fresh leg to live funding that the final check
then refused, reverting a claim that a different split funds in full. The
claim and its preview now read the same live-backed figure the expiry and
forfeit sweeps already used.

**The reconciliation view says when an excess is not yet knowable.** For a
recorded delivery whose split has not arrived, the view that reports how far
a classification exceeds its attested caps now says so explicitly instead of
reporting a zero, which reconciliation tooling would have read as "within
its caps".

What this release deliberately does not decide: the close-out of an epoch
(parking its remainder, acknowledging it, the operator dispositions) stays
unavailable to everyone, as the previous release left it, until the per-day
obligation check that gates it lands.
<!-- assembled-fragment: 1566-transport-epochs-3b-ii-a-draws.md sha256=bcdad5ff18edd3aaf357bfc7089da65a30006624b51d0eb3b5d4b8b3110125d8 -->

## Thread — an advanced-user walkthrough of the live Base Sepolia deployment

We now have a way to ask "does the deployment that is live right now behave
the way we say it does?" and get an answer accounted to the wei. A new
scenario driver runs against a local fork of a real deployment rather than a
fresh local deploy, so what it exercises is the deployed bytecode together
with that deployment's own configuration — the swap venue that is actually
registered, the faucet prices and pool depth that were actually seeded, the
external treasury address, the facets that are actually routed. Several of
this first run's findings are properties of the deployment rather than of the
source tree, and a fresh local deploy would have hidden every one of them. It
needs no Solidity compiler: it reads the committed per-facet ABIs, so the
compiler stays the single source of truth for every decode while the driver
itself is plain Node.

The run now covers two hundred and seventeen scenarios across the whole advanced
surface — offer creation and escrow, accept and the loan-initiation fee,
repayment and the treasury's interest cut, the borrower's collateral claim,
time-based default, health-factor liquidation, preclose, partial repayment,
lender exit by listing and by direct sale, releasing surplus collateral mid-loan, refinance,
the offset and obligation-handover exits, periodic interest, NFT rental, repaying from collateral, and the sanctions, KYC and
illiquid-asset gates. The
fee and health-factor behaviour reconciles exactly against the specification,
including the per-loan fee stamps that stop a governance retune re-pricing an
open loan. Four results are worth an operator's attention. Rehearsing a
forced close by moving a faucet asset's price feed alone makes the asset
read illiquid after a three-percent move, and the protocol then correctly
refuses to swap it — not because the test pool is shallow, as the first
write-up said, but because the pool's own price does not follow the feed and
the protocol distrusts a pool whose price disagrees with the oracle. Moved
together, as a real market would move them, the asset stays tradable through
a fifty-five-percent fall and the position is liquidated from the collateral
side exactly as specified; the driver now does that in one step. Closing a loan early under a full-term-interest offer saves the
borrower nothing, which every preclose quote has to say out loud. A repayment
settles the money but leaves the collateral lien standing until the borrower
separately claims it, so "Repaid" is not "done". And with KYC enforcement
armed — an industrial-fork knob that retail never turns on — the gate binds at
accept rather than at offer creation, so a maker can post an offer that no
taker is permitted to fill.

Two paths that move funds on an open position, rather than closing one, were
added after the first pass. Releasing surplus collateral turns out to be
bounded exactly by the initiation health-factor floor — the protocol quotes
everything down to it, refuses a single wei past rather than clamping, and
authorises the release by the borrower's position NFT rather than by the
address recorded on the loan, so a transferred position carries the right
with it. Refinance confirmed its stated invariant: two loan records and four
position NFTs, all four still resolving, with the old borrower token
surviving as a receipt on the original position. What was not obvious until
it was driven is how much consent a refinance needs first — the borrower has
to have capped, in advance, the rate any refinance may carry, and that
consent is itself required to carry a deadline. The terms a third party may
move a borrower onto are bounded by something the borrower set, not by the
offer alone.

The two exits that hand a position to someone else were added last, and the
offset one carries a trap worth stating plainly: its completion is automatic.
Posting an offset offer leaves the original loan open, but a third party
filling that offer closes it inside the same transaction, and calling the
completion step afterwards is refused. A surface that shows "offset posted,
now complete it" is waiting for something that already happened. Two further
details are not obvious from the name — the vehicle is a lender-side offer
posted by the borrower, so anything classifying offers by their type alone
files it under the wrong party; and the rule that the replacement may not
mature later than the original is enforced to the second, which is why a
same-length replacement fits in the second the loan originated and is refused
a minute later. Obligation handover, by contrast, keeps the loan record and
rewrites its borrower in place, with the lender and principal untouched. The
exiting borrower pays the interest accrued so far plus a protection top-up
for the lender whenever the replacement's remaining interest falls short of
the original's — which it did in this run, so the handover cost more than the
accrued interest alone. Refinance ends
one loan and starts another; handover mutates one. Any indexer has to model
both shapes. The lender's two exits mirror the borrower's: a listed sale
completes itself the moment a buyer fills it, a direct sale settles in one
transaction with no listing at all, and on both the borrower's position runs
on unchanged. The sale vehicle is the offset vehicle's mirror image — a
borrower-side offer posted by the lender — so neither can be classified by
its type alone.

Periodic interest ships dormant on this deployment, which is its intended
default, and while it is off an offer carrying a cadence is refused outright
rather than quietly downgraded. The connected app never offers a cadence, so
nothing is hidden from users behind the flag. Armed on the fork only and then
restored, the feature proved strict about admission — on this deployment a
monthly cadence needs a principal of at least one hundred thousand in the
numeraire — and it closes an unpaid period by selling collateral while the
loan stays open, sized exactly as the specification sets it: the shortfall's
worth at the oracle, plus the configured maximum-slippage allowance as a
buffer. The settler bonus and treasury fee come out of the proceeds, and the
lender keeps the rest — slightly more than the period's shortfall — with all
of it recorded as interest already paid, so the borrower is not charged for
it again. A period the
borrower pays voluntarily is closed by that payment itself — and because a
partial repayment charges all interest accrued to that moment, paying on the
day after the period ends costs that extra day's interest too.

NFT rental was checked against the functional specification rather than the
code, and matched it point for point: the NFT sits in the lender's own vault
throughout, the renter holds only the right to use it and never custody, rent
is prepaid with a five-percent buffer, and an early close pays the lender
exactly the days used while returning the unused rent and the whole buffer to
the renter — conserving every unit across the rental's life. A rental reports
no health factor, but through a different refusal than an illiquid-collateral
loan does, so any surface showing health factor has to recognise both.

Repaying straight from collateral behaves as specified on authority,
partial-mode consent and health, and accounts every unit of the sale — but it
turned up one divergence. The amount of collateral the caller allows the
protocol to sell is treated as the exact amount to sell, not as a ceiling, so
an over-generous allowance converts far more collateral into the lending
asset than the debt needs. The specification and the code's own description
both read it as a ceiling. No value is lost and no shipped surface uses this
path yet. The owner has since decided that the specification is the intent
and the code is the defect: the sale should be sized to the debt, with the
rest of the collateral left pledged and claimable. The fix is tracked
separately, and the walkthrough's check for it now asserts the intended
behaviour — so it reads as a failure against the live deployment until the
fix ships, rather than as a pass that certified the defect.

On the middle two of the four findings, the connected app was checked afterwards rather than
assumed, and already honours both: the early-repay card reads the loan's
interest mode live and is deliberately tri-state, never defaulting to
full-term wording on a loan that might accrue pro rata, and the Claims page,
the claim-all card and the close-early confirmation all point the borrower at
the collateral still waiting for them. They are written up as protocol shapes
a new surface must reproduce, not as gaps in the shipped one — and the
write-up records that correction rather than quietly dropping the two items
it first listed as follow-ups.

The run also found that the committed Base Sepolia deployment artifact no
longer describes the live Diamond: its own facet count disagrees with the
number of entries it holds, seven routed implementations appear under no key
at all, and the companion source record names a diamond that was retired. This
is the same omission class the deploy-time readback guard was built to catch;
the live deployment simply predates that guard. No address is lost — every
implementation stays recoverable from the Diamond's own loupe — so the cost is
inventory accuracy rather than funds, and the fix is the refresh-and-re-export
that this work could not perform itself. Once Foundry was available the ABI
re-export was run for real and found every committed interface already
matching the source, so there was nothing to publish. The on-chain refresh
is different: it has to be signed by the Diamond's admin account, whose key
this work does not hold, and it remains an operator-side action that the
written-up walkthrough names as the first follow-up.

The whole walkthrough was then re-run on Anvil, Foundry's fork node, which
the session could install after all through Foundry's official npm packages.
That re-run found three problems in the test driver that the first node had
masked, each now fixed at its root rather than scenario by scenario. The
well-known development accounts a fork node hands out are not clean on a
public testnet: two of them already carry smart-account delegations on Base
Sepolia, so the protocol saw contracts where the test meant plain wallets.
The driver now generates fresh accounts every run and refuses to start if any
of them has code. A scenario that aborted halfway used to leave its price
changes behind and quietly break every scenario after it; each scenario now
runs inside a snapshot of the fork and is rolled back afterwards, whatever
happened. And Anvil's gas estimate for a call that closes a loan comes back
just short, because clearing that much storage earns a refund that hides the
peak; the driver adds a margin, as wallets do, and names a gas shortfall as
such when one still happens. Whether a production node's estimate has the
same shortfall was not tested, and the write-up says so.

Review of the walkthrough then found the ledger itself too forgiving: some
rows printed a figure under a pass that nothing had checked, and others
recorded a regression as a mere observation. The fix went into the ledger's
structure rather than into individual rows. A row is now either an assertion
— which can only pass or fail, and needs a real condition — or an
observation, and there is no longer any way to write a verdict by hand. Every
formerly unchecked pass was given an exact expectation, and all of them hold
on the live deployment. Four rows that had been certifying a deployment's
configured value now record it as an observation instead, so a later change
of configuration can never be reported as a green "unchanged". The steps that
move money on an open position — the obligation handover, both kinds of
lender sale, and the periodic interest settlement — now check every balance
change against the amount the specification's own formula gives, so an
unexpected transfer fails as surely as a wrong one; all of them reconcile to
the smallest unit. Every refusal the walkthrough checks is now checked by the error's name, so a
guard that disappears cannot hide behind an unrelated later refusal, and
every step that moves money — from the first offer to the last claim, across
the early exits, the refinance, the offset and the rental — now reconciles
exactly against the specification's own arithmetic, including the split of a
forced close between the keeper, the lender, the treasury and the borrower.
No fee rate, share, floor or window is written into the walkthrough any more:
each is read from the deployment, or from the loan's own record of the terms
it opened on, so a legitimate change of configuration can neither break a
correct check nor pass a wrong one. Every claim is checked on both sides of
the transfer, position NFTs after a claim are checked against the
specification's closure rule, and the administrator the walkthrough acts
through is whoever holds the role on the live deployment rather than the
address the deployment record names. One figure is read rather than
predicted, and the write-up says why: the size of the collateral sale in a
full repayment from collateral, which is exactly what the pending fix
changes. Where a scenario chooses an input rather than asserting one — the
size of a probe, how far to move the clock — it now derives it from the
deployment, or declares the configuration it was written for and stops,
naming the setting, on a deployment outside it, instead of reporting a
protocol failure. After every step the whole position is checked — every field
of the loan record, both position NFTs and their holders, and the collateral
lien — not just the field the step is named for. What a run verifies is
declared in the driver's README, and the checks beyond it are tracked as a
follow-up (#2332). Every sale routes through the swap venue at the position
the live deployment lists it, and the deployment's own sanctions and KYC
settings are recorded before the run; if a deployment has KYC switched on,
the runner switches it off on the fork only, and says so, so the scenarios
run on the retail setup they were written for. The re-run records two
hundred and seven passes, nine observations and one failure —
the swap-to-repay check whose expectation was deliberately corrected — with
no scenario file aborted.
<!-- assembled-fragment: fork-scenarios-base-sepolia-walkthrough.md sha256=4ceefcb32503f8d03a660a9a6aede86dc69ce3f2be754147157766ddbf8e5aa3 -->

## A reverted setup step in the app's end-to-end tests now says why it reverted (PR #2335)

The app's end-to-end tests run against a copy of the live test network. When
a step that prepares a test sends a transaction and it fails on-chain, the
tests already stopped at that step and named it. They could not say why: the
failure reason is not kept with the transaction, and the copy of the network
is thrown away when the run ends. So when one test failed on 2026-09-25 and
passed on a rerun of the identical code, there was no way afterwards to learn
what had gone wrong, or to tell a flaky test from a real regression.

The failure message now includes the reason. Where the test network allows it,
the tooling re-runs the failed transaction exactly as it happened, in its own
block, and reads the error it produced, naming the contract's own error by
name where it has one. Where it cannot, it replays the transaction against the
network as it stood just before, and marks that answer as approximate, since
the replay does not run at the same moment and can differ for that reason
alone. When the replay does not fail at all, the message says the cause is
unknown rather than guessing, and if the lookup itself fails, the original
failure is still reported in full.

This changes nothing in the app itself; it is the first step of #2334, so
that the next occurrence of that flaky test explains itself.
<!-- assembled-fragment: 2334-confirm-names-the-revert.md sha256=690ef3c423587b5e45f45fd2eb5da5372fa99cece2bedd7ec04459770332c9d8 -->

## A failed transaction's explanation no longer mistakes the request for the error (PR #2338)

When a transaction fails, the app reads the error the contract reported and
turns it into a plain-language explanation. The shared decoder looked for that
error in the failure message as well as in the error's own fields, and the
messages produced by the app's blockchain library also repeat the request that
was sent, including the call's own encoded arguments. Those arguments have the
same shape as an encoded error, so in some failures the decoder picked up the
request and reported it as the reason for the failure.

Two effects were reproduced with the library's own error types. When the
wallet could not estimate a transaction and the network answered only with
"exceeds max transaction gas limit", the app showed that raw text instead of
its guidance that this is not a real gas shortage and usually means a missing
approval or a stale app version. And when a call failed with a real error
nested one level down, the decoder reported the function being called instead
of that error, so no friendly explanation matched and a support string could
name the wrong code.

The decoder now reads the error's structured fields across the whole chain of
wrapped errors first, and only then falls back to message text. In that text it
skips the notes the library adds about the call, which is where the request is
repeated, and reads only what the network or wallet itself reported. Wallets
that put the error only in plain message text are still read as before.

What the network reports as the error is taken as reported. The decoder does
not try to spot a network that repeats the request inside its own report:
review of this change showed that any such check would also discard a real
error whose code happens to match the called function's, trading one misreading
for another. Closes #2336.
<!-- assembled-fragment: 2336-revert-decoder-ignores-request-echo.md sha256=dd72af43476a1c456f4222114c43e844e84642a52e7600ba0e59b03e752fda72 -->

## Thread — swap-to-repay sells only what the debt needs (#2317)

Repaying a loan in full straight from its collateral used to sell every unit
of collateral the borrower allowed, not just the collateral the repayment
needed. The borrower's allowance was meant as a ceiling — the functional
specification and the contract's own description both say so — but it was
treated as the exact amount to sell, so a generous allowance turned pledged
collateral into the lending asset far beyond the debt and sent the excess to
the borrower's wallet. The fork walkthrough of the live Base Sepolia
deployment measured it: with a little over a thousand owed and an allowance
worth twelve hundred, all twelve hundred was sold. The owner decided the
specification is the intent and the code was the defect.

The close-out now sizes the sale to the debt. It sells exactly the least collateral whose worst-case proceeds, under the
borrower-facing slippage cap, still cover the whole repayment, whatever the
two assets' decimals and prices (as refined by #2322); the allowance only bounds that, and everything
above it stays pledged and is released by the borrower's normal claim. Any
principal left after the debt is paid is the fill beating that worst case,
which is the favourable-quote surplus the specification describes. A new
read-only preview reports the sale size, the floor it must clear and the debt
it covers, from the same computation the close-out runs, so an interface can
quote a route for exactly that amount. The sized amount is the most the protocol will
let any route sell. A route whose quote fixes the sell amount in advance can
drift from it as interest accrues or a price updates: a route that sells a
little less still goes through if its proceeds cover the debt at the
slippage floor, with the unsold collateral staying pledged; one that would
sell more is refused and the next venue is tried. On-chain venues size
themselves. An integration that used to quote for the borrower's whole
allowance must now quote for the preview figure, since a quote for the whole
allowance is refused on every such route. No shipped interface does that. The partial mode is unchanged — there the borrower chooses how
much to sell, by design.

Nothing about the settlement waterfall, the sanctions freeze or the claim
path changed. The fork walkthrough's check for this behaviour fails
against the currently deployed bytecode. With the corrected close-out swapped
into a local fork of the live Base Sepolia deployment, it passes, along with
every other repay-from-collateral check. On the walkthrough's loan the sale
fell from the whole allowance to the collateral the debt needed, and the rest
stayed pledged until the borrower's claim released it. The
resolver-filled intent path committed the whole collateral to its auction
when this change landed. The specification's rule, that unused collateral
stays pledged and claimable, applies there too. It is sized by the same
rule in a separate change (#2322), not in this one.
Closes #2317.
<!-- assembled-fragment: 2317-swap-to-repay-sells-only-the-debt.md sha256=c73593390ff58ac898c746c80f55049129fbc5bb555cb183f55a48b9da13f5b4 -->

## Thread — repay-from-collateral by auction puts up only what the debt needs (#2322)

The auction form of repaying a loan from its collateral — where the
borrower posts an order and a resolver fills it — used to put the loan's
entire collateral up for sale. A filled auction therefore turned every unit
of collateral into the lending asset, which is the same problem the direct
form had until #2317. The functional specification says collateral the
repayment does not need stays pledged and returns to the borrower through
their claim, and that rule covers both forms, so the auction now follows it.

When a borrower commits an order, the protocol now puts up only the lot the
debt needs. That is the least collateral whose worst-case value, under the
same borrower-facing slippage allowance the direct form uses, covers the
debt plus the auction's safety buffer. Both forms size the sale through one
shared rule, so they cannot drift apart. The order is a fixed-price order,
and the borrower sets its price by how much principal they ask for that lot:
- The least the borrower may ask is the lot's own worst-case value. When
  the collateral comes in coarse units that value can be well above the
  debt, and the minimum follows the lot rather than the debt, so no lot is
  ever sold below the worst case. Asking that minimum accepts the worst case
  the slippage allowance permits, and a resolver keeps that discount.
- Asking more prices the lot higher.
- Whatever a fill raises above the debt is paid to the borrower as surplus,
  exactly as in the direct form.

Any collateral the lot does not include never leaves the borrower's vault
and stays pledged for the whole auction. There is none left over when the
debt needs all of it. So that this remainder cannot end up
anchored to someone who no longer holds the position, the borrower position
is locked while the auction is live. This uses the same transfer lock the
early-close and loan-sale flows use, and it is released when the auction
settles or is cancelled. The release only clears the auction's own lock: an
auction committed before this change never took one, and settling it must
not clear a lock another flow holds, such as a live collateral listing's. The app's NFT verifier now names this lock ("locked
for a repay-from-collateral auction") instead of calling it an unrecognised
reason. The agent's queued-order notes now say that only the auction lot
is in protocol custody, and that any collateral the lot does not include
stays pledged in the borrower's vault. A loan with a live auction is also kept out of the
protocol's internal loan-against-loan matching, because none of its
collateral is free to match. After a fill, the borrower claims the rest
through the ordinary claim, and it stays pledged until they do. A cancelled
or expired auction returns the lot and leaves the loan exactly as it was.
When even the whole collateral, at the worst case, cannot cover the debt
and buffer, the commit is refused before anything moves. A new read-only
preview shows the lot and the least principal a commit accepts. Like the
commit, it refuses while a deployment has the auction form switched off,
so it never quotes a capability that deployment does not offer. The
committed order is the one to post to the resolver network, because
interest and prices can move between the preview and the commit.

Fixing this also exposed an accounting issue in how the pledge was
restored after a fill. The old code assumed the whole collateral had been
unpledged at commit, and re-pledged the borrower's whole remaining claim on
top of whatever was still pledged. With the untouched part now pledged
throughout, that would have counted it twice. After a fill the pledge is
now topped up to cover the claim, and it equals the claim whenever the
pledge matched the loan's collateral before the auction, as loan initiation
sets it. No shipped interface drives the auction form yet, and the live
testnet still runs the previous contracts until an operator refreshes them.
Closes #2322.
<!-- assembled-fragment: 2322-swap-to-repay-intent-sizes-the-lot.md sha256=c00f7c4ab4a004fbeaa2d68b92aaa5b78f0cc76ddf9e667f081f2d3dcc7a388f -->
