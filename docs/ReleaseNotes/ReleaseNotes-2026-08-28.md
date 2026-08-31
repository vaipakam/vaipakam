# Release Notes — 2026-08-28

Three of the day's five entries are the same shape: the keeper reading less, and
reading it in fewer round trips. The liquidity-confidence pass stops re-reading
what cannot have changed (#1993), the per-tick RPC budget is told apart into
scan work and action work so the two stop competing (#1992), and the
remittance-ack pass takes its ledger window in one read instead of many (#1994).
That is the #1896 CPU-budget problem being worked rather than waited out. The
other two are about authority: the Terms of Service can apply to somebody again
on the connected app, and the account's cron budget now has a single authority
whose count is the true one rather than one of several disagreeing records.

## Thread — The liquidity-confidence pass stops re-reading what cannot change (PR #1993)

The keeper's liquidity-confidence pass decides, per collateral asset, whether
real aggregator routing supports the depth tier the protocol has on file. Its
per-tick request budget was dominated by two things that were not that
decision.

The first was the scan that finds which assets to evaluate at all: it read every
active loan's details one at a time, sequentially, purely to collect the
distinct collateral assets among them. Those reads are now batched. The walk
still stops as soon as it has as many distinct assets as a tick will evaluate,
and the batches are sized to that same cap so that a book whose loans all carry
different collateral does not decode a pile of loan records the old loop would
never have touched — decoding is the cost this work is about, so a batch that
overshoots the cap would trade a smaller request count for a larger one.

The second was repetition. For every asset under evaluation the pass asks the
token for its decimals, and then does the same for each quote token it might
route through — a value that is fixed for the life of the contract, re-read
dozens of times a tick. It is now remembered for the duration of one chain's
tick, with two deliberate limits. The memory is scoped to a single chain and
discarded afterwards, because the same address is a different token on a
different chain. And only successful reads are remembered: the decimals path
falls back to a default when it cannot read the real value, and a remembered
wrong default would silently distort every slippage figure derived from it for
the rest of the tick.

Oracle prices were **not** given the same treatment, and the reason is worth
recording. An earlier draft of this change remembered them too, which would have
saved more. But the oracle read is live rather than a snapshot of one moment,
and a tick is not instantaneous — evaluating a couple of dozen assets means
dozens of sequential requests to outside pricing services. Reusing an early
asset's price against a later asset's freshly quoted one would compute a
slippage figure across two different market moments. The consequence is
lopsided: raising an asset's tier requires the same verdict several ticks
running and would absorb a blip, but lowering it happens immediately by design,
so a single stale price could lower a tier — and the tier governs how much can
be borrowed against that asset. The saving was not worth that, so prices are
read fresh, and a test asserts they are not cached rather than leaving it to a
comment.

Measured against the profiling fixture the pass drops from 428 requests per tick
to 215, and its CPU from 207 ms to 150 ms.

Separately, the profiling fixture could not see the decimals saving at all: it
carried no ERC-20 interface, so every such read failed and fell back to the
default — silently, because the pass swallows that failure without logging it.
The fixture reported this pass as making zero errors while it failed 78 reads
per run. It now answers those reads, which is what makes the figure above a
like-for-like comparison.

Refs #1896.
<!-- assembled-fragment: 1896-liqconf-read-budget.md sha256=80b273f836c7078c5704f2f813995fe10720263fbbe2b77205a42e428e778704 -->

## Thread — The keeper's per-tick RPC budget, told apart into scan and action (PR #1992)

The keeper's CPU profiling harness could say how many RPC calls each pass made
per tick, but not what they were for. That gap produced a wrong conclusion the
first time the numbers were published: the liquidator's 528 calls were read as
book-scanning work and queued for batching, when in fact the fixture answers
every health factor below the liquidation line, so every loan it scanned was
actionable and most of those calls were the submission path. Batching them
would have optimised a fixture artifact.

The harness now attributes every request by the contract function it called
(or, for the non-contract ones, by its JSON-RPC method), separates the
transaction-submission methods into a stated subtotal, and reports what was
carried inside each batched read rather than only that a batch happened. The
resulting per-pass breakdown answers the question the bare call count could
not: a pass whose traffic is a paginated list plus one read per item is doing
book scan and batching is the fix; a pass whose traffic is quotes, nonces, gas
estimates and sends is doing per-item work, and the fix there is a bound on how
many items it acts on per tick, or nothing at all. The action share is
explicitly a worst case — the fixture presents a fully saturated book — while
the scan share does not depend on that, and the runner says so in its output.

Applied to the ten passes, that split named one unambiguous case. The pre-grace
warning pass made 612 requests per tick with not one of them on a transaction
path: three sequential reads per active loan, plus one read per offer in the
book it consults to decide whether a borrower already has a viable
counterparty. All of it scan. Those reads are now issued as batched
multicalls in three stages — opt-in caps first, loan details for the loans that
opted in, then the borrower-NFT owner for the loans actually inside the warning
window — which is 24 requests per tick instead of 612, with the same reads
performed and the same per-loan failure isolation. A loan whose read reverts is
still logged and skipped rather than aborting the chain. Nothing about which
borrowers get warned, or when, changes.

The three-stage shape is deliberate rather than one flat batch: each stage's
input is the previous stage's survivors, so reading loan details for a loan
whose owner never opted in would trade the saved round-trips straight back.
A test pins the traffic shape for all four of the pass's reads separately —
a partial regression where one stage quietly falls back to per-item reads while
the others batch is exactly what a combined count would hide.

One thing surfaced while checking that guard would hold: the keeper's test
suite ran in no CI workflow at all. The Worker is typechecked, which is what
made the gap easy to miss — a green column on every pull request meant "it
compiles", never "its tests pass". Two hundred and twenty-one tests had never
executed in CI, among them the guard added earlier for exactly this class of
defect, where multicall batching silently degrades to one request per item and
the pass reports success either way. A guard for an invisible failure is worth
little if the guard itself never runs. The keeper's suite now gates alongside
the connected app's, the shared library's and the indexer's. The agent's suite
remains in the same unrun state and stays tracked separately.

Refs #1896.
<!-- assembled-fragment: 1896-pregrace-batching-and-attribution.md sha256=40df8f0359498217da1cebb7c38ca034bf202795af3dc29965e3b470ee07a4f1 -->

## Thread — The remittance-ack pass reads its ledger window in one go (PR #1994)

The keeper drives the acknowledgement that finalises each cross-chain reward
remittance. To find which remittances are still waiting, it walks a bounded
window of the reservation ledger and asks after each one in turn — up to two
hundred separate requests per tick, on a pass whose actual work, sending the
acknowledgements, is a small fraction of its traffic. The window is now read in
one request per hundred reservations. Its bounds, and the order the results are
processed in, are unchanged.

One behaviour needed preserving deliberately, and it is the reason this change
carries a test rather than just a measurement. In the old shape a failed read
threw, which abandoned the whole scan for that chain — so neither the frontier
that marks "everything below here is finished" nor the rotating cursor advanced
past a reservation whose status had never been read. A batched read does not
throw; it hands back a per-entry failure. The obvious translation, skipping the
failed entry and carrying on, would have quietly moved the cursor past an
unread reservation and dropped it from the scan until the window came round
again. So a failed entry still aborts the scan, and a test asserts that no scan
progress is recorded when one occurs.

Against the profiling fixture the pass drops from 249 requests per tick to 51.
What remains is the acknowledgement path itself, which is already capped at five
sends per tick — the share of the pass's traffic that is transaction submission
rises from 8% to about half, which is the intended shape: what is left is work,
not scanning.

Refs #1896.
<!-- assembled-fragment: 1896-remitack-scan-batching.md sha256=d4ef0a97b0bf912d5561cc6d382ba51acc5fe358ad88f9e520e610a5ac497431 -->

## Connected app — the Terms of Service can apply to somebody again

The connected app now asks a wallet to accept Vaipakam's Terms of
Service when a version of them is in force, and holds the app closed
until it does.

That sounds like a feature being added. It is really a control being put
back. The retired app had this gate; the successor was built without it,
and the omission was not visible from either side on its own. Nothing in
the app looked missing, and nothing on-chain looked broken — because the
Terms requirement is one of the few rules the protocol deliberately does
**not** enforce for itself. The contracts record who accepted which
version and publish which version is in force, and they leave the
blocking to the app. So an app with no gate does not degrade the
requirement; it deletes it. Operators could have published terms,
switched them on, and watched every wallet keep transacting without ever
being shown them — with no error anywhere to say so.

What users see depends entirely on whether terms are in force, and today
none are. In that state nothing changes: the app behaves exactly as it
does now, for everybody. The moment operators put a version in force,
anyone with a wallet connected is asked once to accept it, shown the
version and a fingerprint of the exact text, with links to read the
Terms and the Privacy Policy before agreeing. Accepting sends one
transaction — the wallet asks for confirmation and it costs a small
network fee, since the record is kept on chain rather than in the app. Nobody is asked again unless the terms themselves change — and
if they do change, the previous acceptance stops counting, which is the
point of recording a version rather than a tick.

Acceptance is recorded per network. A wallet that has accepted on one
supported chain is asked again on another, because each deployment keeps
its own record and the app can only read the one it is pointed at.

Three deliberate choices are worth stating, because each is a place this
kind of gate usually goes wrong.

**It refuses to guess, and it says which kind of "no" it means.** If the
app cannot reach the network to find out whether terms apply, it does
not assume they do not. It says it could not confirm and offers to try
again — rather than telling you to accept terms you may well have
accepted already, which would be both untrue and impossible to act on. The tempting alternative — let people through when
the check fails — would mean the gate stops working precisely when the
network is flaky, which is neither rare nor hard to arrange
deliberately.

Pages that only show you something — the explainer, your own history,
checking a position token — are never withheld either. There is nothing
on them to withhold, and somebody trying to find out what the terms
mean should not be met by a page that will not open.

**It never blocks getting your money out, or taking back control.**
Repaying, claiming and withdrawing are not behind this, and neither is
anything else that reduces what you are committed to: cancelling your
own offers and orders, adding collateral to a position under pressure,
and withdrawing permissions you granted earlier — a keeper's authority
over your positions, or the consent that lets fees be taken
automatically from your vault. Handing a position over in one step to
someone who has already offered to take it counts too — a lender being
bought out, a borrower's obligation moving to a replacement — because
those end the position outright, and blocking them would have left the
slow way out open while shutting the instant one. A rule about
accepting terms should never become a reason somebody cannot close a
position, and it should never leave a permission running that they are
no longer allowed to cancel.

The same rule reaches the alert settings, which never touch the
protocol at all. Signing up for reminders — linking a messaging channel,
or switching a reminder on — waits until the terms are accepted.
Switching one off, or unlinking, always works, and each reminder can be
switched off on its own. That last part sounds obvious and was not: an
earlier version of this decided by asking whether anything was still
switched on afterwards, which meant anyone with two reminders enabled
could not turn either one off — a rule about accepting terms leaving
somebody unable to stop being messaged.

Nor does a refusal cost anything. Where an action needs a separate
approval step first, the terms are checked before that step, so nobody
pays a network fee for an approval that was going to be turned down.
Nobody is asked to pay for the same acceptance twice either: once the
network has confirmed it, the app treats it as done even while its own
next check is still catching up, rather than putting the prompt back in
front of someone who has already paid. And when the app does refuse
something, it names a page that will actually ask — the pages that stay
open regardless of acceptance deliberately never ask, so pointing at one
of those would have sent people in a circle.

**It does not decide who has accepted.** That question is answered on
chain, by the same contract that holds the terms, which checks both the
version and a fingerprint of the text. Working that out in the app would
have been a second implementation of a rule that already exists, free to
drift from it.

This clears one of the two capabilities that had to exist before users
could be moved from the old connected app to the new one. The other, the
Data Rights export and erase controls, is still outstanding.
<!-- assembled-fragment: 1961-tos-gate-connected-app.md sha256=8c0a50093ad4df6085530f60cba85ad228a8f2cbad356d9b6ac177492a850718 -->

## Ops — the account's cron budget now has one authority, and the count in it is the true one

Cloudflare's free plan caps the account at five cron triggers, and how many
were spoken for was stated in ten places across the tree — three wrangler
configs, four source comments, a README, a design doc and one operator
runbook. All of them agreed with each other. All of them were wrong, in the
same way and for the same reason: they counted the Workers that have source in
this repository, and one of the live triggers belongs to a Worker that does
not.

That Worker is `vaipakam-offchain-data-archive`, the pre-rename predecessor of
the nightly backup Worker. It was supposed to be retired once its replacement
had completed a run; it never was. **As read from the account on 2026-08-27**
it was still armed on the same minute as the replacement, with its own storage
credentials and its own copy of the backup encryption key, and had been
scheduled that way for at least three weeks. Reading the account rather
than the prose is what surfaced it.

An earlier draft of that sentence said it had *run a full second backup every
night*. It had not been established that it had. The account API reports
trigger configuration and says nothing about whether an object was written —
which is the distinction this very change had to add to the restore runbook,
after the same inference was found there. Writing it into the incident record
as well would have told a future operator that every night has a fallback copy,
which is the belief the runbook now exists to prevent. **Armed is not
uploaded**, and only the bucket listing settles it.

Those are dated observations, deliberately. This note lives in the pending
folder until the day's notes are assembled, and the account can change in the
meantime — so a present-tense claim here could ship describing a state that
had already been cleaned up. The one place that carries the live figure is the
authority, which is checked against the account; everything here is history
with a date on it.

The checker enforces that, rather than leaving it to care. Its exclusion for
the release-notes tree covers the **assembled, dated** notes, which are
finished history; **pending fragments are scanned like any other file**,
because a fragment is not history yet. It is a forward-looking description of
behaviour shipping in the same change, and a count written into one would sit
there indefinitely with nothing to contradict it. That distinction was itself a
review finding on this change, and the scan caught a restated count in this
very fragment within the hour of being switched on.

Three things follow from that, and this change addresses all three. Every one of
those comments was a trigger short of the account's real state — so the slot
they reserved for the undeployed mesh watcher was already occupied. The figures
are in the authority; this fragment deliberately does not restate them, for the
reason the whole change exists. That does not mean the keeper's re-enable would have stopped at its
first step: the real occupancy still left a trigger free, so
whichever of the two deployments went first would have taken it and succeeded.
What those comments had actually lost was the SECOND one. Deploy mesh-watcher
first and the keeper's re-enable is the deploy that fails; re-arm the keeper
first and mesh-watcher's first deploy fails. Either way the failure is a 10072
at deploy time with no explanation available, and an operator reading those
comments would go looking for a sixth trigger that does not exist. The restore runbook's
rule for choosing between the two backup buckets ("the two never both hold a
given night") stopped being true the moment both Workers were left running, so
an operator restoring under pressure would have found two candidates and no
way to choose; it now names the supported bucket, treats a gap in it as a
finding in its own right, and records that the compromise reasoning further
down assumes one holder of the write credentials where there are two.

The structural half is that the count now lives in exactly one file,
`docs/ops/CloudflareCronSlots.md`, carrying the date it was last read from the
account. Everywhere else says why a Worker registers one schedule rather than
two — which is durable — and links there for the arithmetic, which is not. A
new gate in CI refuses any text that goes back to restating the occupancy,
while deliberately permitting statements of the cap itself, since the sentence
that replaces a count has to say what the constraint is. The gate also has a
live mode that diffs the committed inventory against the account, which is the
only half that can tell whether the inventory is current; CI runs the offline
half, because CI has no credentials, and a green offline run means "nobody
re-copied the count" rather than "the count is right".

Retiring the duplicate Worker is not done here. It sits on the
disaster-recovery path, and until its replacement is confirmed to be landing
and verifying in the new bucket, the un-retired predecessor is what would mask
a defect in it — so the sequence (confirm, unschedule, delete, rotate its
credentials, expire the old bucket) is an operator decision recorded in the
issue rather than something to take unilaterally.

The case for doing it soon got considerably stronger during this work: two
separate emergency procedures turned out to be written for one Worker where
there are now two, and the consequences are described below.

One thing is worth recording rather than smoothing over, because it is the
most transferable part. **The mechanism did not work first time, or for many
times after.** Review round after review round found the same defect it was
built to prevent — a claim about something live that nothing checks — again
and again *inside the mechanism itself*.

(There is no count in that sentence, deliberately. Earlier drafts said
"twelve rounds", then "fourteen", and each went stale within the day; a
reviewer caught one of them. A restated number describing this change's own
history is the same defect the change is about, and it does not become
acceptable for being about the past.)

The interesting part was never the count anyway. It is that the misses fell
into a small number of repeating shapes — and that two of them were found not
by review but while *writing the reply accepting a different fix*, within an
hour of pushing it. That is the clearest evidence here that the problem is not
attention:

- **Closed worlds keep reopening.** A list of file extensions, a class of
  Markdown prefixes, a set of phrasings gathered from the tree: each was an
  enumeration of what somebody might write, each leaked twice, and each was
  finally fixed by replacing the enumeration with a decidable test rather than
  extending it a third time.
- **Fixing one member of a family and leaving its sibling**, repeatedly — a
  wrap-tolerant matcher applied to one pattern and not the rest; a short-row
  guard added beside the malformed-row finding it belonged with; one file
  extension added while its sibling stayed out; a predicate list taught one
  vocabulary while the matcher beside it kept another. The durable answer
  turned out not to be fixing the sibling but removing the seam: one shared
  definition, used everywhere the thing appears.
- **Closing one direction and opening the reverse.** Requiring every
  reservation to be named, without rejecting a name for a reservation that no
  longer exists. Dropping an anchor so a hidden duplicate could not escape,
  thereby accepting a stamp no reader can see.
- **Answering a question with the neighbouring question's test.** Counting
  well-formed stamps to decide whether there were two. Checking that a
  paragraph is *about* cron to decide whether a sentence *claims* something
  about it.
- **Two fixes, each right alone, contradictory together.** One round added a
  procedure for refreshing the authority after a deploy and, in the same
  commit, a check rejecting the wording that procedure produces — so no
  document satisfied both and the step could not be completed. This is the
  one shape the others do not cover: nothing was individually wrong, and no
  per-change review asks whether the state a fix *produces* is reachable.
- **The correction that landed and was never called.** One check had its
  substring test replaced by a proper parse, for exactly the right reason. The
  parse was written, was correct, and was wired into one of the three places
  that needed it; the other two went on running the test it replaced. So the
  fix and the defect shipped side by side in the same short function, and
  every gate stayed green, because the text being searched happened to contain
  the right word for an unrelated reason. This is not the sibling shape above —
  nothing was left untouched and nothing was overlooked in another file. The
  remedy was present, adjacent, and inert. Nothing that examines a change can
  see this; only reading the finished function can.
- **The correction the producer had already made unreachable.** A later round
  taught the table parser that a code block ends a table, which is what the
  Markdown specification says and what the reader sees. The line was correct
  and it could never run: the stage that strips code blocks out of the
  document runs first, and by the time the parser sees anything the block and
  both of its delimiters are gone. The parser was watching for a marker its
  own input could not contain. The remedy was not to look harder for the
  marker but to stop deleting it — omitted lines are now handed on as blank
  ones, which is the same boundary in a form every reader of that stream
  already understood. A test written against the parser alone would have
  passed; only feeding it the real pipeline's output shows the gap.
- **One rule, two threat models, opposite meanings.** The restore runbook
  gained a rule saying that if a backup fails its checksum, fall back to the
  other bucket. That is right on an ordinary restore, where the second bucket
  is a spare copy — and it is precisely wrong after a compromise, where that
  bucket's Worker holds a write key and a copy of the encryption key, so
  "this one failed, try the other" is the newest-that-verifies move the
  adversarial section of the same document exists to forbid. The sentence
  never changed meaning; the reader's situation did.
- **The general remedy applied without checking that this case has the
  general problem.** A reviewer pointed out that reading only the first page
  of a paginated list would hide exactly the thing the check exists to find.
  True in general, and the endpoint in question turned out not to paginate at
  all — it ignores the parameters and returns everything — so the page loop
  written to fix it was *worse* than the single call it replaced. The same
  round: a file-classifier was rewritten to ask git whether a file is binary
  instead of sniffing for a null byte, keyed on the field that reports git's
  own guess rather than the one carrying the explicit setting — so it still
  excluded the exact file the finding named, while compiling, reading
  correctly and passing its tests. Both were caught by going and asking the
  thing itself. A remedy that is right about the world is not yet right about
  the case in front of it.

Several findings landed outside the mechanism entirely, in the operator
runbooks the un-retired Worker touches, and those mattered more than anything
above. Two were serious enough to change what an operator does in an
emergency.

The disaster-recovery procedure for a **compromised** account said to rotate
the storage credentials and then pointed at a step whose actual instruction
replaces one Worker's pair of keys. With two Workers holding write access,
following it as written leaves the second key valid — so the attacker keeps
the ability to upload after the procedure believes the breach is closed. It
now enumerates the keys from the account before deleting anything, rather
than trusting a number written down in advance.

A second one would destroy data rather than admit an attacker. The routine for
changing the backup encryption key pauses one Worker, migrates one bucket, and
then destroys the old key — while the second Worker carries on writing under
it. Everything that Worker has stored becomes permanently unreadable,
including the copies **this very change had just designated** as the fallback
when the primary ones fail verification. So the edit that made those backups
load-bearing left standing a procedure that would have quietly rendered them
useless. It now says, at each step rather than in a note further up, that the
work applies to both Workers and both buckets — and that the durable fix is
retiring the duplicate.

Neither of those two is wrong sentence by sentence. Each is simply wrong about
how many of something exists, which is the same defect as the copied counts
that started all this, relocated from comments into instructions somebody
follows during an emergency.

And the procedure for bringing the paused keeper back had no failure path for
the validation that runs *after* the fund-moving passes are switched on. The
rollback it did document covers the earlier, still-inert validation, where
backing out costs nothing — so an operator whose post-arming check failed had
no instruction for the one situation where it matters. The Worker's own
configuration file had carried that rollback all along; the runbook had not,
and nothing compares the two.

Smaller, and the same shape: the restore runbook concluded from two armed
schedules that both backup buckets held every recent night — armed is not
uploaded, and an operator restoring under pressure would have taken it as
licence to skip the listing. And a mistyped verification flag printed "OK"
and exited zero without contacting the account at all, in the procedure whose
next step is a deploy that fails if the check was wrong.

Partway through, the review stopped being worth continuing in the same
direction, and it is worth saying how that was decided rather than by feel.
The findings were counted: the rate of new ones was flat across two long
stretches of fixing every single one, the change had doubled in size while
that happened, and two thirds of everything raised concerned the checking tool
rather than the documents it checks. The recent findings had also drifted in
character — they were no longer about the count being wrong, but about
increasingly obscure ways of writing Markdown that the tool interpreted
differently from a reader.

That last part is the diagnosis. The tool had started growing its own
understanding of the document format, one review finding at a time, and each
correction gave the next review more to examine. Two of the bugs *it* caused
were worse than the ones it caught: both would have rejected a perfectly
correct document, which on a check that gates every change means stopping all
work rather than letting one mistake through.

So that machinery was deleted rather than corrected again, and replaced with a
rule: the one file this all protects may not hide any part of itself. That is
a single condition anybody can check, it costs nothing — the file has never
done so, and there is no reason a document whose job is to state one number
plainly would want to — and it makes the entire class of problem impossible
instead of handling it case by case. **Ruling something out is decidable;
interpreting it is not.** Each finding had arrived phrased as an interpretation
problem, and had been answered on those terms for several rounds before anyone
asked whether interpretation was required at all.

One consequence of all that correcting deserved checking on its own, and had
not been. Almost every change to the checker made it **stricter about what
counts as a claim** — each one prompted by it wrongly objecting to an innocent
sentence, and each one carrying the risk of quietly losing the real thing it
was built to find. Nothing had confirmed it still finds them.

So the ten original passages that started this were recovered from the
project's history and run through the checker as it now stands, rather than
through the examples written to describe it. All ten are still caught. The
distinction matters more than the result: an example invented to illustrate a
rule confirms the rule, while a passage lifted from the real history confirms
the job — and no set of invented examples can notice that a rule quietly
stopped matching text nobody thought to write down. That check is recorded
alongside the rules, with a note that anyone proposing to tighten them further
should repeat it rather than trust a clean run of the examples.

Every one of these was written carefully, by someone actively thinking about
this exact failure. That is the argument for the gate rather than an
embarrassment to it: if the defect reproduces this readily under maximum
attention, it was never going to be prevented by care, and the ten copies that
started this were not a lapse.

**#1977 stays open**, deliberately. This change is the repository half of it;
the account half — confirm, unschedule, delete, rotate the credentials that
Worker holds, expire the old bucket — has not happened, and the issue is the
only place that sequence is written down. Closing it on merge would retire the
tracker for a live Worker still holding a `writeFiles` storage key and a copy
of the backup encryption key, and still occupying the trigger the keeper's
return depends on.

Refs #1972, the general class this came out of — live infrastructure state
asserted in many documents and authoritative in none. This is that issue's
shape applied to the one fact where the drift turned out to be load-bearing
rather than cosmetic; the hostname half of it is still open.
<!-- assembled-fragment: 1977-cron-slot-authority.md sha256=37d8d736aab75ac15b1a4decce47a4cb90dffb0870b27dc58aac1045cc78579a -->
