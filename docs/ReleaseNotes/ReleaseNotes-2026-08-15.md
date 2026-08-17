# Release Notes — 2026-08-15

The heaviest day in this window, and twelve of its twenty-three entries
belong to one sweep, #1749. Eleven of the twelve share a single defect: the
connected app showing a previous answer while a new one is still loading.
The asset breakdown mixed two networks'
figures, the keeper panel showed the previous loan's wallets, the
minimum-collateral figure used the previous pair's prices, the rental banner
inherited the previous loan, and the loan detail page showed the previous
loan outright. Every one is the same defect — a cached value surviving a
change of subject — and each is fixed by deriving the display from the
current query rather than holding the last good result. The twelfth is the
same sweep's other half: splitting modules so that editing a page during
development no longer reloads the whole app.

Read together they make a point worth stating plainly: a stale figure on a
funding screen is not a cosmetic lag. Several of these were numbers a user
would have signed against.

The rest divides into three. Cross-chain work: messages now carry proof of who
sent them, lane settings refuse to be quietly reset, and the surplus reading
refuses to answer on the wrong deployment. Correctness of description: four
contract comments corrected, and a blocking gate (#1651) that stops the
removed VPFI purchase surface being described as live again — the mechanised
answer to the previous day's manual cleanup. And the connected app's
remaining lint work: expiry surfaces that froze at page load, nine
"reading a ref while rendering" reports triaged into three real fixes and six
deliberate reads, and six data-fetching gates that now declare what they read.

## apps/defi: the admin propose-change dialog could lock up, and would not let you clear a field

The admin console's "propose a change" dialog pre-fills the new-value box with
the setting's current on-chain value, so an operator adjusting a number starts
from where it is today. Two faults in how that pre-fill was built.

**It could freeze the dialog.** The pre-fill was written as a calculation that
quietly wrote its own answer back into the form, and the same form value was one
of the inputs the calculation watched. The only thing that stopped it repeating
forever was that the value it wrote was normally non-empty, which made a "has
anything been typed yet" check fail on the next pass. For a setting whose
current value is blank, the pre-fill wrote a blank, that check kept passing, and
the dialog re-drew itself until the browser gave up. Nothing about the settings
catalogue prevents a blank current value — this was luck, not design.

**It would not let you empty the box.** Because "has anything been typed yet"
was inferred from whether the box was empty, deleting the pre-filled number was
indistinguishable from never having touched it, so the dialog immediately put
the old value back. An operator could overwrite the value but could not clear
it.

The pre-fill is now worked out from the current value each time the dialog
draws, rather than being written into the form, and whether the operator has
edited anything is tracked in its own right. Both faults go away: there is no
value being fed back into its own calculation, and clearing the box now clears
it. A field the operator has not touched also picks up a fresher current value
if one arrives while the dialog is open, which it previously would not have.

Unchanged: settings whose setter takes more than one value still start out
empty, so each one is entered deliberately — proposing the same value as today
is allowed, but it has to be typed.

**And a third fault, which only became reachable once clearing worked.** Eight
of the settings in this console are on/off switches for live protocol mechanics
— range orders, partial fills, periodic interest, the numeraire swap, and the
three automation switches. The dialog's "you must fill every box" check
deliberately skipped on/off settings, and the code that turns typed text into a
value for the contract treated anything it did not recognise — including an
empty box — as "off".

While the box refused to stay empty, that combination could not be reached. With
clearing fixed, it could: clear the box on an enabled switch, press the button,
and the dialog would produce a perfectly valid, signable proposal that turns
that mechanic **off** — looking no different from one an operator meant to
write. The dialog now requires an on/off setting to say exactly "true" or
"false" and says so if it doesn't, and the encoder refuses an unrecognised value
outright rather than quietly choosing "off" for you. Turning a switch off is of
course still allowed; it just has to be asked for.

An on/off setting is now written exactly one way — `true` or `false`. The
encoder had historically also accepted `1` and `0`, and a first pass at this
kept them while the dialog itself required the words, which left the two halves
disagreeing about what a valid entry is. They agree now, on the stricter side:
the dialog has always shown these values as `true`/`false` and says so in the
field, and extra spellings for a switch that turns a live mechanism on and off
are the same looseness that caused the original fault.

Ten tests now cover this dialog, which had none. Run against the previous
version, five of them fail — one with React's own "too many re-renders" guard,
which is the freeze reproduced directly, and the rest on the on/off handling.

## Four contract comments corrected, each describing something the code does not do

Two review passes over the admin runbook found that several claims a published
operator page was making came straight from contract comments, and that the
code did not support them. The comments were the root cause, so this change
corrects them at the source. Nothing about how the protocol behaves changes.

**A note on scope.** This started as a larger sweep that also covered the
cross-chain channel-peer map, on the finding that comments described an
identity check the receiving side did not perform. That half is **withdrawn
rather than merged**: separate work has since built the check, so the comments
this change would have corrected became accurate again on their own, and
"correcting" them now would have introduced the very kind of false statement
the sweep exists to remove — in the opposite direction. The remaining four
corrections are unaffected by that work and are still needed.

### The reward-configuration field is not zero on the canonical chain

A field recording which network is the canonical one was documented as being
left empty on that network itself. It is not: the deployment scripts set it on
every network, canonical included. The wrong description had already caused a
correct deployment to be written up as configuration drift.

The claim had propagated. It appeared in the field's own description, in a
guard elsewhere that cited it as the reason for reading the network's identity
directly rather than from the field, and in the commentary of the test covering
that guard. All are corrected. The guard itself is still right, and now for a
better reason than the one recorded: the field is administrator-settable, so a
check reading it to decide "am I the canonical network?" could be switched off
by a governance write, whatever the deployment happens to configure.

### The price anchor named as the single source of a rate is one of three

A keeper-reward constant described itself as the place a particular
VPFI-to-ETH rate is stated. Two other places express the same relationship for
different features, and none of the three reads the others — so changing one
does not move the rest. Someone repegging from that constant would have
concluded they had found the only one.

The three are not alike, which is the part worth carrying: two are fixed values
compiled into the contracts, while the third is a runtime setting with no
built-in value that governance can change at any time. That third one is the
only one that can quietly come to disagree with the others on a live
deployment. Its value for one test network is documented in the deployment
runbook — but a runbook records what an operator is instructed to do, not what
the network currently holds, and the corrected text is careful about the
difference.

### An unchecked operator input leaned on an enforcer that had been deleted

An oracle setter justified accepting an unverified address by pointing at a
policy enforced elsewhere. That elsewhere was removed in an earlier legal-scope
excision, along with the feature it governed, so the guarantee this setter
relied on had no enforcer anywhere. It also cited a section of the repository
guide that no longer exists.

This is the most dangerous shape a stale comment takes: it makes an existing
check appear to be part of a pair, so whoever audits it next goes looking for
the other half and finds nothing. The setter now states plainly that nothing
enforces the choice, that it is the only surface, and that the operator must
verify the address against the chain's official bridge registry — naming the
registry rather than any internal document as the source, after three
successive replacements each pointed somewhere that had gone.

### Residue from a removed feature described it as live

A storage-structure section header for the removed fixed-rate purchase surface
outlived its own fields and was left labelling unrelated entries beneath it,
its sentence cut off mid-clause. Removed, with a note recording why, so the
next reader is not left wondering what used to be there.

### A storage slot was specified, shipped, and never built

A field for a cross-chain "authorised peer" was allocated, released, and
documented in a design document as validated on arrival. Nothing in the code
reads or writes it. The specified check was never built.

The slot's description now records that plainly. Since this change was first
written, separate work has built equivalent authentication one layer down, in
the shared cross-chain adapter, covering every channel at once — which is the
argument for retiring this slot rather than completing it, as a second copy of
the same check could drift out of agreement with the first. That decision is
tracked separately; the slot stays where it is either way, because moving it
would disturb the storage layout.

## Cross-chain messages now carry proof of who sent them, and lane settings refuse to be quietly re-pointed

**This changes the cross-chain message format and must be rolled out to both
sides of a lane together.** A messenger on the new format cannot interpret a
message from a messenger on the old one, and vice versa; a lane upgraded on
only one side stops delivering until the other side catches up.

**Drain each lane before upgrading it.** A message already in flight keeps the
format it was sent in, and an upgraded receiver cannot read it — so upgrading
the other end does not rescue it. Waiting for a refused message to become
deliverable will not work. Recovering one means rolling the receiving side back
to the old format, re-running the message, and upgrading forward again: possible,
but a far worse thing to be doing under pressure than draining was. The same
applies to anything sent into the one-sided window.

Nothing is destroyed in any of these cases — a refused message is recorded as a
failure rather than consumed — but "not destroyed" is not the same as "will
arrive on its own", and the difference is the whole reason to drain.

### What was wrong

Each cross-chain lane records the address of the contract it expects to be
talking to on the other network. That record was passed to the receiving
contract as the answer to "who sent this", and some receivers act on that
answer — but it was an answer read out of local configuration, not one
recovered from the message. So the receiving side was not verifying the
sender at all. It was repeating a claim, and the claim was only as good as
the configuration behind it.

That is a weak place to be even with careful operators, and it was made
weaker by how easily the configuration could move: the record could be
overwritten in a single write, with nothing to distinguish a deliberate
re-point from a first-time assignment.

### What changed

A message now carries the identity of the contract that actually sent it, and
the receiving messenger checks that identity against the configured peer
before handing anything to the local contract. A mismatch is refused rather
than reported as though it were the truth. The message format also carries a
version, and a version the receiver does not recognise is refused rather than
interpreted — reading sender information out of a layout you do not recognise
is guessing, and guessing about who sent a message is the thing this change
exists to stop.

Alongside that, all four lane settings — the chain's network selector, its
remote messenger, a channel's local handler, and a channel's remote peer —
now behave the same way. A change that conflicts with a live value is
rejected. Re-stating a value a setting already holds is still accepted and
does nothing, so a deployment script that reasserts its own configuration
does not need to know whether it has run before. A genuine change is made by
clearing the setting and then assigning the new value: two transactions, two
entries in the event log, and a re-point that reads as a re-point.

The uniformity is the point. The earlier version of this change protected
only the peer, on the reasoning that the other three fail loudly when
mis-set. That reasoning does not hold: a channel pointed at a wrong but
otherwise compatible address delivers its messages and tokens successfully.
None of the four announces itself reliably, so none of them is overwritten in
place. A remote address can also no longer be declared as the peer of two
different channels at once, which is a configuration that could never have
been right on both lanes.

### What operators need to do differently

Rotating a channel's partner address now requires draining the lane first.
Because a message carries the identity of whoever sent it, a message the old
partner had already sent is refused once the new one is installed. The
procedure is: stop the old contract sending, let whatever is in flight arrive
or be abandoned deliberately, then clear the setting and assign the new one.

A message stranded by a rotation done without the drain **is recoverable**, and
it is worth being exact about that rather than implying loss. There is no
expiry and no revocation involved: clear the new partner, put the old address
back, re-run the stranded message, then repeat the rotation properly. An
operator who believes a transfer is gone might abandon one that isn't. Drain
anyway — the recovery works by pointing a live lane's trust setting backwards
for as long as it takes, which is not something to be doing in a hurry.

**Rotating a channel's local handler needs the same drain, for a different
reason and without the same safety net.** A message names the conversation it
belongs to, not the contract that should receive it — that is resolved on
arrival — so a message sent while the old handler was in place is delivered to
the replacement, along with any tokens it carries. Nothing rejects it, because
from the protocol's point of view it arrived on the right conversation. This
one cannot be fixed the way the partner check was: a sender can prove its own
identity, but it has no way of knowing which contract the far side has
appointed. Quiesce the channel, let deliveries land on the old handler, then
change it.

**Upgrading an already-deployed messenger requires a migration step.** The
one-address-one-channel rule is enforced through a new index that starts empty
on an existing deployment, so it must be populated from the configuration
already in place — as part of the upgrade transaction, not afterwards. Until
that runs, the rule is not actually in force. The list of configured lanes has
to be supplied by the operator and derived from the deployment's own event
history, because a contract cannot enumerate its own configuration; a lane left
off the list stays unprotected.

## A gate that stops the removed purchase surface being described as live again (#1651)

A feature was removed from this project to reduce legal exposure: the protocol
had a fixed-rate way to buy its own token across chains, and that shape carries
enough securities-law risk that the project chose not to carry it. That is the
project's own risk assessment, not a legal opinion and not a ruling about how
any regulator would classify it. The contracts went. The roughly hundred places
that *describe* those contracts did not, and clearing them has been running as
a series of small changes for weeks.

Each of those changes found something the one before it missed, and never in
the same kind of file twice — a contract comment telling operators that a
deleted contract still enforces a safety property, a security questionnaire
sent to a partner, deployment runbook steps, a section heading left behind
after its contents were deleted so that it silently retitled the unrelated
settings underneath it. The pattern is not carelessness. It is that prose has
no compiler: deleting a thing tells you nothing about which sentences describe
it, and no amount of care makes a person reliable at that search.

This adds an automated check for the class rather than another pass over it.

The obvious design does not work. Banning the removed names outright would
fail on the very text doing the cleanup, because a note explaining that
something was removed has to name it. So the check counts instead of bans: it
records how many times each file currently mentions the removed surface, and
fails when a count changes. A count going **up** means new text describing a
removed thing — the case worth blocking. A count going **down** means someone
cleaned up and the record is now out of date, which fails too, on the grounds
that a ledger nobody maintains stops being evidence.

Scope is everything the project tracks, minus a short list of exclusions. The
historical record is what gets excluded — release notes, superseded documents,
findings, decision records — because a release note about a removal is
*supposed* to name what was removed, and pinning those would produce constant
noise from documents doing their job. Everything else is in, including
top-level policy documents and configuration.

It began the other way round, as a list of places to check, and that is worth
saying because the reasoning was appealing and wrong. A short list is cheaper
to maintain, so the first version enumerated the surfaces where a stale mention
would mislead an operator. What it actually did was omit the security policy
document, which described the removed components as live parts of the
cross-chain system. A list of places to look can only cover the places someone
thought of, and text nobody thought of is the entire problem here.

The check runs on every pull request and blocks. That is a deliberate choice
about severity: text presenting a deliberately removed surface as available is
not a style preference, and the reason it was removed is what makes a stale
description of it worth stopping.

Review of the first version found three ways past it, all of them real. It
matched only code spellings, so ordinary English — "VPFI buy adapter" — walked
straight through, and two deployment scripts were presenting the removed
components as current steps while the check reported green. Its list of
directories to search omitted the security policy document, which described the
deleted contracts as live parts of the cross-chain system. And because it
compared only a total, removing one mention while adding another in the same
file left the number unchanged — the exact shape of this project's own cleanup,
so a live instruction could have ridden in under cover of a legitimate edit.

Later rounds added three more gaps of the same kind, and one of the opposite
kind. The name-matching still had holes — the off-chain watchdog, the
notification channel and the deleted storage keys could all be named in
instructions without tripping it. But the opposite failure had also been
introduced: the pattern for the removed sale was a prefix of the name of a
*surviving* feature, treasury buyback, so an ordinary sentence about buyback
work failed the check as though it were residue. On a check that blocks every
change, that would have obstructed legitimate work — the more damaging of the
two failure directions, and the one I had reasoned away as improbable when
choosing broad patterns.

All of these are closed. Matching now happens on normalized text, which folds
casing, spacing and punctuation together and joins the file into one string, so
a phrase broken across two lines is caught too — one such mention was found
immediately. The scope became an exclusion list rather than an inclusion list,
because a list of places to look cannot cover the file nobody thought of, and
that is precisely what this is for. And each file now carries a fingerprint of
its mentions alongside the count, so a substitution that keeps the total the
same still fails.

A second review round found four more gaps, and two of them mattered. The
check knew the removed contracts by name but not the removed *operations*, so
an instruction telling an operator to call one of the deleted functions passed
cleanly — the names of things and the names of actions both had to be listed.
And the fingerprint covered only a short span of text around each mention,
which was enough to notice a mention being swapped for a different one but not
enough to notice one being *reversed in meaning*: flipping "were removed" to
"remain deployed" a line away left the fingerprint untouched. It now covers the
surrounding lines, because whether a mention is a retraction or an instruction
is carried by its sentence, not by the few words either side of the name.

The other two were about trusting the wrong thing. Whole directories had been
excluded as "historical" when only parts of them were: one of them held a
security questionnaire that gives an outside scanner present-tense
configuration instructions for the removed component, and another a test matrix
listing it as current coverage. Exclusions are now per-file wherever the
surrounding tree is still active. And an entry in the ledger that simply
omitted its fingerprint was silently treated as opting out of that check —
now rejected outright, since a safeguard that can be switched off by leaving
something out is not a safeguard.

A further round found the same two failure directions again. Two generic
message names could be synthesised out of ordinary English — "whether to buy.
Request independent advice" reads, once punctuation is stripped, as the name of
a deleted message — so unrelated prose could block a change. And a status
heading more than two lines from a mention was invisible: flipping a section
from "Planned" to "Current" turned an entry below it into live guidance without
moving anything the check looked at. The heading governing a mention became part of what gets fingerprinted.

The other half of that was fixed twice and then withdrawn, which is worth
recording. Two of the removed names are ordinary English word pairs, unlike
every other name on the list, so ordinary sentences could accidentally spell
them once punctuation was ignored. The first response was to teach the check
where an English thought ends — full stops, then blank lines, then table cells,
then list markers. Each addition turned out to mishandle a different case: one
silenced a real mention inside a quoted code sample, another blocked a document
merely because a heading interrupted a paragraph. The rules were guesses about
prose, and prose does not cooperate.

The first response was to require those two names, and only those two, to
appear as one word — and to delete everything about where sentences and
paragraphs end. That went too far. The block rules had been quietly doing the
same job for two other names that are also ordinary words in sequence, so
removing them made sentences like "Decide what to buy. Adapter selection
follows." fail as though they described the removed component.

What ships is both: the two ordinary word pairs must appear as one word, and a
mention still cannot span a sentence end, a paragraph break, a table cell, or —
in documents only, and never inside a quoted code sample — a heading or list
item. The document-only qualification is not incidental. The characters that
open a heading or a bullet in a document are comment and continuation markers
in code, and applying either rule everywhere silenced real findings twice: once
in a code sample pasted into a document, once in two deployment scripts whose
comments wrap across lines.

The removed error conditions were also added to the list, which is where the
count grew sharply: one of them is declared in a shared interface file, so it
propagates into more than forty generated interface artifacts. That reinforces
the ordering noted below — the declaration has to go before regenerating is
worth doing.

A related fix: the fingerprint had been taken from text with formatting
stripped, which meant a retraction could be visually inverted without moving
it — striking through the word "not" leaves every letter in place. It now
covers the text as written.

Widening the net kept roughly multiplying what it sees: a hundred and
twenty-five files, against the thirty-one the first version tracked. Most of the newly visible text is legitimate, but some of it is not,
including operator-facing deployment steps, a security document, a partner
questionnaire and a test matrix. Those are recorded as pending triage rather
than fixed here — the ratchet stops the problem growing, and the cleanup is
reviewed on its own, tracked as a separate piece of work so the marker cannot
quietly become permanent.

Compiling that list turned up something of a different kind, and a first
attempt at describing it was wrong in a way worth recording. A generated
interface file used by the data-indexing service still lists error conditions
belonging to the removed feature. The obvious reading — stale build artifact,
fix by regenerating — is not the whole story: one of those error definitions is
still present in the contract source itself, carrying documentation that
describes the removed purchase pipeline as though it still runs. So the
sequence is source cleanup first, regeneration second; regenerating alone would
faithfully reproduce the leftover.

The first pass missed it by searching only for the names already found in the
generated file, which is circular — it can only confirm what it started with,
never find the one that was named differently. The build configuration has a
matching problem: it still lists a test file for the removed feature that no
longer exists on disk.

Two further things came out of building it, both worth stating because they
change what the numbers mean. Counting *occurrences* rather than *matching lines*
turned out to matter — the two disagree wherever a line mentions the thing
twice, and line-granularity would let a mention be added to an
already-matching line without moving the number. And the first honest count
found two files nobody had listed, plus a stretch of deployment runbook that
still carries a step-by-step configuration checklist for the removed component
underneath a heading marking it historical. A label above a checklist does not
stop someone skimming for their chain's steps from following it. That is
recorded as known debt in the ledger rather than fixed here, so the cleanup
can be reviewed on its own terms.

The last several rounds were all one question the check kept getting wrong:
what does a reader actually see? A page is not the file. Formatting markup is
invisible to the reader but sits between words on disk, and quoted code is the
reverse — visible characters that mean themselves rather than what the
surrounding format would make of them. Confusing the two failed in both
directions, and the direction alternated. Text styled mid-phrase read as two
unrelated fragments and passed; a placeholder inside a quoted command was
mistaken for formatting, deleted, and a real instruction went with it; a
comment invisible to every reader kept two words apart; prose sitting either
side of an unrelated code sample was fused into a mention nobody had written.

What settled it was giving the check a single model of where quoting applies
and applying it consistently — and confining that model to the document format
that actually has quoting rules, rather than to every file that might contain
markup. The three ways a document can quote code are all treated alike now, a
comment counts as invisible because the reader cannot see it, and the names
inside a formatting tag are read on their own, since a tag can carry the name
of a removed component as easily as a sentence can.

Two of those rounds also relaxed the check. Two more of the removed operation
names turn out to be ordinary trading vocabulary once punctuation is ignored —
sentences about pending buy-side liquidity, or about quoting buy orders — and
each of them independently blocked clean documents. They now have to appear as
a single identifier, the same constraint two other ordinary-English names
already carried. This keeps being the harder half to get right: the check
blocks every change, so a false alarm obstructs unrelated work, and that cost
is paid by whoever is unlucky enough to write the sentence.

Character references belong to that same "what does a reader see" question and
were the next instance of it: a document writing a non-breaking space between
two words shows the reader one phrase, while the source spells four extra
letters between them, and the check read the source. They are now resolved to
what is rendered.

One further gap was of a different kind, and subtler than anything above,
because it concerned how the fingerprint is *assembled* rather than what it
covers. Each mention's surrounding text was joined into one string with a
separator, and that separator is an ordinary character which the text itself
routinely contains — every row of every table is full of them. So two
different sets of contexts could produce the same string to fingerprint, and
an edit that moved text across one of those boundaries would leave the
fingerprint unmoved while changing what the document says. That is the exact
guarantee the fingerprint exists to provide, defeated without needing to break
any cryptography — just by the punctuation of ordinary prose. The pieces are
now assembled unambiguously.

One exemption turned out to be too broad in a way worth naming. Assembled
release notes are excluded from the check, correctly — a dated note recording
that something once existed is doing its job. But the exemption covered the
pending fragments too, and a pending fragment is not a historical record: it is
a description of the product as it is about to ship, written by the same change
that ships it. A fragment promising operators a surface that no longer exists
was exactly the defect the check looks for, arriving in the one file every such
change is required to add. Pending fragments are now checked; the assembled
notes stay exempt. Two existing fragments were picked up immediately, both
legitimately naming the retired surface in order to describe its removal, and
both recorded as such.

No behaviour changes in the product.

## The cross-chain surplus reading now refuses to answer on the wrong deployment

Each supported network runs its own copy of the protocol, and one of them —
Base — keeps the ledgers that track how recycled reward funding is spread
across the others. A reading built on those ledgers reports whether a
particular network is sitting on more recycled funding than its recent usage
justifies.

That reading was available on every deployment, not just the one holding the
ledgers. Asked on any other network, it did not refuse; it read that
network's own empty copy and answered with zeros. Nothing distinguished that
from a real answer of "no surplus here" — the shape of the response was
identical, and there was no signal that the question had been put to a
deployment that could not possibly know.

A wrong number returned confidently is worse than a refusal, because whatever
reads it carries on and acts. This reading now refuses on any deployment other
than the one that owns the ledgers.

### Why the existing check did not already cover this

There was already a guard, and it is a different question. It refuses to
report on the network the deployment is *itself* running on, because a
network cannot hold a surplus relative to itself — the whole notion describes
funding that could move somewhere else. That check asks "is the network being
asked about a mirror?". The new one asks "should this deployment be answering
at all?".

Neither implies the other. The old guard passes happily on a mirror as long as
the network named in the question is some *other* mirror, which is exactly the
case that returned a confident zero. Both checks are now in place and both are
needed.

### What this does not change

Only this one reading is affected. Its neighbours were reviewed at the same
time and deliberately left alone: the ones that return raw ledger figures
already describe themselves as returning zeros away from Base, which is honest
about what they are, and at least one of them is genuinely meaningful on a
mirror because mirrors populate that particular record themselves. The reading
changed here is the one that composes several figures into a judgement and
presents the result as an assessment — which is what made an empty answer
misleading rather than merely empty.

Anything that was already asking this question of the deployment that owns the
ledgers sees no change.

## apps/defi: the lint rule now honours the "deliberately unused" naming convention

The lending app's lint run reported twelve unused declarations. Half of them
were not oversights at all — they were already named with a leading underscore,
which is the conventional way to write "this is bound on purpose and not meant
to be read": a destructured field the surrounding code does not need, a
placeholder parameter that exists to reach the one after it, a discarded slot in
a tuple.

The rule has no such convention switched on by default, so it flagged all six
and the intent written into the names counted for nothing. The usual way that
gets resolved is by editing the six sites; the better fix is to tell the rule
about the convention the codebase is already using, which is what this does.
Nothing about those declarations changed.

That leaves six that really were dead: three test helpers imported but never
called, and three address constants left behind by earlier edits. One of the
constants looked live at a glance — a `WETH` address, in a file that mentions
WETH twice more — but both of those are the plain text "WETH" being checked as a
token symbol, not the address. It was confirmed unused before removal, not
assumed.

Nothing about behaviour changes here: the six that stay are named exactly as
they were, and the six that go were referenced by nothing. The combined effect
of both groups on the app's lint total is given at the end.

One deliberate scope note. The sibling app carries the same rule and the same
underscore convention, but has no declarations of this kind today, so the option
is not added there — it would be configuring for a situation that does not
exist. If that changes, the same one-line answer applies. This also is not a
change to any shared lint configuration: the two apps keep separate configs, and
the only shared one is a narrow guard covering a single unrelated rule.

A second rule in the same app was reporting the same kind of thing, and is
included here for the same reason. A timeline component maps a dozen activity
kinds onto a single icon by listing their labels together — a normal, permitted
way to write it. What the rule objected to was that two of those labels carry a
short note explaining why they joined the group: a comment sitting between two
labels stops the group counting as empty, and the check then reads it as a
missing `break`. The two reports were precisely those two notes.

The choice was to delete useful explanations to satisfy a rule that is not about
explanations, or to tell the rule that bodyless label groups are fine. The
latter, with one caveat worth stating: the dangerous case — a branch that does
real work and then silently continues into the next one — is still reported.
That was confirmed against a throwaway example rather than assumed, since
relaxing a correctness rule on the strength of a plausible-sounding option would
be the wrong way round.

Together the two groups take the app's lint total from 270 problems to 256 —
fourteen reports resolved, twelve from the unused-declaration group and two from
the grouped-case one — and its error count from 263 to 249. Six declarations
were deleted; everything else was a matter of telling the rules what the code
already said.

## apps/defi: expiry surfaces no longer freeze at the moment the page loaded

Several parts of the lending app decided things like "has this grace period
closed", "is this loan overdue" and "is the indexer still fresh" by reading the
clock once, while drawing the screen. A value read that way never changes again
for as long as the page stays open. The comparison is correct at the instant it
runs and then quietly stops being true.

What that looked like in practice: open a loan page a few minutes before its
grace period ends, leave it open, and the action surface keeps offering itself
after the deadline has passed. The page has no idea anything changed, because
nothing prompted it to look at the clock again.

This is not a newly discovered risk. One page already carried a fix for exactly
it, added earlier with a note explaining that a page opened before the boundary
"would keep showing the action surface forever" otherwise. The fix was correct —
but it was applied to one deadline, and the same page's *other* deadline, a few
lines above, went on reading the clock directly. So one half of the page updated
and the other half did not.

Nine places read the clock this way, and they did not all need the same answer.

Six now share one small piece of machinery that keeps time and refreshes about
once a minute, replacing two separate hand-rolled copies that had grown up in
different files. Those are the genuine deadline surfaces: grace periods, overdue
loans, a cooldown, and two countdowns.

The other three turned out not to want a clock at all. Two were asking whether
the app was still successfully reaching the chain, and the honest answer to that
comes from whether the last check succeeded, not from how long ago a number last
moved — a distinction that cost two review rounds to get right, because a
plausible-looking staleness threshold hid it. The third was asking whether a
queued governance change had matured, which is a fact about the chain's clock,
not the administrator's; a machine running fast would otherwise be told an
operation was ready while the network still refused it. That one now takes its
answer from the chain alone.

An attempt to also make that governance panel refresh itself the moment a queued
change matures was written and then withdrawn during review, and the reasoning is
worth recording. The panel finds queued changes by scanning a bounded window of
recent chain history. A change queued with a long delay falls out of that window
before it matures, so a refresh triggered at the maturity moment would come back
empty and make the pending change *disappear* from the dashboard — at exactly the
moment an administrator needs to act on it. A momentary network failure had the
same effect. The panel is therefore left as it was: it can show a stale countdown
until the page is reloaded or the chain switched, which is recoverable, rather
than risk removing a live proposal from view, which is not. Refreshing it properly
means asking the timelock for its active operations directly instead of
rediscovering them from history, and is tracked separately.

Two details worth recording, because both were places this could have gone
wrong. Some of these readings sat below a point where the component can bail out
early; a naive move would have put the new clock there too, which breaks the
rule that a component must ask for the same things in the same order every time
— the same class of fault that caused a live crash on the Create Offer screen
not long ago. Those were lifted above the early exits instead. And the refresh
interval is a minute, not a second: these are deadlines measured in hours and
days, and a faster tick would redraw the screen constantly for no visible gain.

No visual or behavioural change on a freshly loaded page. The difference only
appears on a page left open across a deadline, which is where it was wrong
before.

## apps/defi: nine "reading a ref while rendering" complaints, sorted into three real fixes and six not-faults

The lending app's linting flagged nine places that touch a short-term scratch
value — the kind of holder a component uses to remember something across
renders without redrawing when it changes — while the screen is being drawn.
The tool treats every one of these as a fault. Six of them are not — five are
deliberate, and one is a plain false alarm — and much of this change is about
writing down which is which, so the next person to see the warnings does not
"fix" a guard that exists on purpose. The other three are real, and one of those
only became clear during review; it is described last, because it started out on
the "deliberate" side of the ledger.

**Two were obviously genuine and are now fixed.** The active-offer list and the loan list
each keep a note of the newest block the app is confident about, so that a
background refresh can catch up on anything it missed. The note was being
updated while the screen was drawn, which is not safe in the drawing model React
is moving toward — a draw can be abandoned halfway, and an update made during an
abandoned draw has still happened. Both now update just after the screen is
committed instead. The only reader in each case runs after a network round-trip,
so it sees the settled value; even in the theoretical case where it did not, it
would use the previous block number, which shortens one catch-up pass that the
next one covers anyway.

**Five are deliberate and now say so.** The risk-acknowledgement gate deliberately
consults its notes mid-draw, and that timing is the entire mechanism. Two of them
answer "was this answer worked out for the offer and wallet being drawn right
now?", so that the moment a user switches offer or wallet, the previous offer's
answer is withheld rather than shown for one frame. Three more do the same for a
risk verdict, so a stale "you're clear to proceed" cannot enable an action that
is already doomed. Deferring any of these by one frame would reopen exactly the
window they were added to close — an earlier review round put them there for
that reason.

**A sixth looked deliberate and was not**, and review caught it. The same
risk-acknowledgement gate keeps a note of the current wallet-and-chain so that a
transaction already in flight can check whether it is still relevant before
applying its result. That note was being updated mid-draw. The argument for
doing it then was that updating it later leaves a gap in which work started
under the *new* wallet compares against the old one and cancels itself for no
reason — which is true of the later of the two available moments, but not of the
earlier one. Updating it at the point the screen is committed, before anything
can be clicked, closes that gap too, and avoids a worse problem: the browser may
begin preparing a screen for a different wallet and then throw that work away,
and a mid-draw update would already have overwritten the note. A transaction
running against the wallet still on screen would then look stale to itself and
bail — and because the "am I still relevant" check also guards the code that
clears the busy state, the button would have stayed spinning even though the
transaction succeeded. It now updates at commit time, matching what the
terms-of-service check in this app already does for the same reason.

**The last is a plain false alarm.** A tooltip passes a callback down to whatever
element it wraps so it can find that element on screen. Nothing reads the value
at that moment — React calls the callback later, once the element exists. The
tool cannot tell that apart from handing out a value to be used immediately.

No intended change to what the app does — none of this alters a feature or a
rule. One of the three fixes does change observable behaviour, though, and
saying "no behaviour changes" would deny the very bug it repairs: under the old
mid-draw update, a wallet switch that the browser started preparing and then
abandoned could make a transaction already in flight look irrelevant to itself
and bail, leaving its button spinning after the transaction had actually
succeeded. That button now clears.

## apps/defi: six data-fetching gates now declare everything they actually read

Parts of the lending app that fetch data on a schedule declare, alongside the
fetch, the list of things that should make it fetch again — the connected
wallet, the selected chain, and so on. Six of those lists were incomplete: the
code read a value but did not list it, so a change to that value alone would not
prompt a refetch.

None of the six is a bug a user could have hit today, and this note deliberately
does not claim otherwise. In every case the undeclared value moves together with
one that *was* declared — the vault address is derived from the wallet, the
diamond address and the chain client are both derived from the selected chain —
so a change to the missing value has always dragged a declared one along with
it. What was wrong was the reasoning, not the behaviour: the correctness of each
of these depended on a coincidence that nothing in the code enforces and that a
future refactor could quietly break.

They are now declared. Concretely:

- The vault assets page re-reads balances when the wallet or the diamond address
  changes, not only when the derived vault address does. This one needed a
  second change to be safe, described below.
- The offers list re-classifies and re-caches against the chain it is actually
  reading, rather than relying on the event feed happening to change at the same
  moment. The snapshot cache is keyed by chain, so a chain identifier captured
  from an earlier render is precisely what would file one chain's offers under
  another chain's key.
- The protocol-config read declares the chain client it uses.
- The liquidity preflight compares the collateral amount directly instead of
  converting it to text first. The conversion was unnecessary — amounts of this
  kind already compare correctly by value — and it made the entry impossible for
  the checker to verify, which is why a blanket suppression had been sitting
  above the whole list. That suppression is gone.

The sixth is a genuine false alarm, and is now marked as one with the reasoning
written down. A terms-of-service check keeps a counter that it bumps whenever the
wallet or chain changes, so that a read already in flight for the *previous*
wallet can tell it has been superseded and discard its result. The checker warns
that the counter may have changed by the time the bump runs and suggests working
from a copy taken earlier. Following that advice would break the mechanism
outright: the bump has to land on the live counter, because that is the value
every in-flight read compares itself against. Bumping a stale copy would leave
the live one untouched and let a previous wallet's result apply. The changed
value is the entire point.

### A real fix that came out of it: no more mixed-wallet vault figures

The vault-assets change above was not safe on its own, and review caught it.

That page shows, per token, how much sits in your vault and how much of it the
protocol has recorded — two figures read from two different places. One is keyed
by your vault's address, the other by your wallet's. The vault address is itself
looked up from the wallet, and that lookup takes a moment.

Telling the page to refresh the instant the wallet changes meant it refreshed
*during* that moment: it read one figure against the new wallet and the other
against the previous wallet's vault, and showed the smaller of the two as your
balance. A number combined from two different accounts is not a slightly stale
number — it is a meaningless one, and nothing on screen would have suggested
anything was wrong. Before this change the page simply didn't refresh yet, which
was stale but at least internally consistent.

The vault lookup now records which wallet each answer belongs to, and an answer
belonging to a different wallet is withheld rather than handed out. During the
moment after a switch the vault reads as not-yet-known — a state every caller
already handles — instead of confidently returning the previous wallet's. That
protects the other place this lookup is used, too, where a stale vault address
would have been matched against the wrong borrower.

Aside from that, no behaviour change is expected on any of the six.

## A swap-to-repay panel now names the connected wallet directly, instead of relying on a proxy for it

The panel that tracks a swap-to-repay intent refreshes itself every fifteen
seconds so a fill or a cancellation shows up without a reload. When the indexer
is unavailable it falls back to reading the chain directly and fills in the
missing pieces itself, including stamping the record with whoever is connected.

The refresh did not name the connected wallet among the things it watches. It
kept working anyway, because switching accounts replaces the handle the panel
uses to talk to the contract, and that handle *was* named — so the refresh
restarted, and the stamp was rewritten with the new account.

So this is not a fix for something users were seeing. It is the refresh now
naming the thing it actually reads, instead of relying on a second value that
happens to change at the same moment. Two separate reviews were needed to
establish that, and the first two accounts of it — including one in this very
note — described a staleness that the indirect route had already prevented.

Nothing displays that stamp or decides anything from it today either. Recorded
plainly because the alternative is a changelog claiming a fix for a problem
nobody had.

## The installed app's shortcut no longer offers to sell you VPFI

Anyone who installed the lending app to their home screen got a shortcut
labelled "Buy VPFI", described as a way to "acquire VPFI for fee discounts".
The protocol has no purchase surface — that was removed deliberately, for legal
reasons, and the page the shortcut pointed at was renamed at the same time. The
link still worked, because the old address redirects to the new page, so nothing
looked broken from the outside. What survived was the wording, sitting in the
operating system's launcher rather than anywhere the removal had been reviewed.

A shortcut is a stronger claim than a sentence in a document. It is a labelled
entry point a user taps expecting the thing on the label, and it lives outside
the app where nobody rereads it.

The shortcut now says what the page it opens actually is: the VPFI Vault and
Discounts page, for holding VPFI in your vault to earn tiered fee discounts —
the same wording the page itself uses. It points straight at the current
address instead of relying on the redirect.

An internal note in one component described the same page as somewhere you could
"buy and deposit in one flow"; it now describes depositing VPFI you already
hold, and records that the purchase step was removed, so the next person reading
it isn't misled the way this shortcut was.

Installed shortcuts refresh when the app's manifest is next fetched, so existing
installs pick up the corrected label without reinstalling.

While correcting the label it turned out every entry in that file pointed at an
address the app no longer serves. The connected pages were moved to the top
level some time ago — `/offers` rather than `/app/offers` — and the installed
shortcuts, along with the address the app opens at when launched, were never
updated. They appeared to work only because the first part of the address is
read as a language code, and an unrecognized one quietly falls back to English.
A visitor whose browser asks for a language the app does support would have been
sent somewhere that does not exist.

All four shortcuts and the launch address now point at the pages as they are
served today. Each target was checked against the app's route list rather than
assumed.

## Connected app — the asset breakdown stops mixing two networks' figures (PR #1761)

The analytics page shows a per-asset breakdown of loan volume, including each
asset's percentage share of the total. Those rows carried no record of which
network or which asset set they were computed from, so switching networks left
the previous network's breakdown on screen beside the new network's headline
totals until the reads finished.

That combination is worse than an ordinary stale figure, because a share is a
proportion *of a total* — showing one network's percentages next to another
network's total presents an arithmetic that does not hold. The rows are now
labelled with the network and the exact set of assets they describe, and the page
reports that it is still working rather than showing the earlier set.

The analytics page itself needed a matching change. It had been treating "no
rows yet" as "no loan volume", which was harmless while the rows were merely
stale but became a confident and wrong "there is nothing here" once they
correctly go blank between networks. It now says it is loading, and only reports
no volume once something has actually answered.

Two states are deliberately kept distinct. "The indexer is offline" is a settled
answer, not a pending one, so the page keeps rendering its own placeholder for
that instead of spinning forever. And a network with no assets to break down is
also an answer — an empty breakdown — rather than something to wait for.

## Connected app — the keeper status panel stops showing the previous loan's wallets (PR #1762)

The loan detail page reports whether keepers can act on each side of a loan.
That answer depends on which wallet currently holds each side's position
token — so on a page reused between loans, it must follow the loan on screen.

The page already tried to handle this: it discarded the previous loan's answer
the moment the holders changed. But the discarding happened just after the page
had drawn, so for one frame the previous loan's keeper state was displayed under
the new loan's heading — and that state drives an "actions are inert" warning
keyed to a wallet, so the warning shown could belong to someone else entirely.

The answer now carries the pair of wallets it was read for, and the page decides
at drawing time whether that pair still matches what is on screen. Where it does
not, it reports that it is still reading. The existing protection against a slow
read for the previous loan overwriting the new one is unchanged — that guard was
already correct, and this replaces only the part that ran too late.

## Connected app — the minimum-collateral figure stops using the previous pair's prices (PR #1760)

The create-offer form shows a minimum collateral amount derived from live oracle
prices for both assets and the collateral's on-chain risk profile. Those figures
carried no record of which pair or which network they were fetched for, so
changing either asset — or switching networks — left the previous pair's prices
and borrowing cap on screen until the new reads returned, with the minimum
recalculated from them in the meantime.

The reads are now labelled with the pair and network they answer for, and the
form reports that it is still working rather than showing a figure derived from
the wrong inputs. Re-selecting a pair after moving away re-prices it rather than
reusing quotes taken earlier.

## Connected app — the rental listing banner stops inheriting the previous loan (PR #1764)

The loan detail page shows a banner for an NFT rental prepayment listing, and
the actions offered alongside it depend on what that listing currently says.
Moving between loans, or switching networks, briefly showed the previous loan's
listing under the new loan — and because the banner drives which action is
offered, the borrower could be presented with an action belonging to a different
loan.

The page already tried to prevent this and said so: it cleared the listing
"immediately — BEFORE the new fetch starts". But the clearing ran just after the
page had drawn, so it shortened the window rather than removing it.

The listing now carries the loan it was read for, and the page works out at
drawing time whether it still matches. Where it does not, the banner reports
that it is loading instead of showing the earlier loan's.

Two existing behaviours are preserved deliberately. A momentary indexer outage
still keeps the last good listing for the loan being viewed, rather than blanking
the banner mid-flight — that only ever applied within one loan, and now provably
so. And the post-transaction settling rules, which decide whether a confirmed
write or a lagging indexer view wins, are unchanged; they now write against the
loan being viewed rather than against whatever the page happens to hold.

## Connected app — liquidation quotes and loan totals stop showing the previous answer (PR #1759)

Two more lookups get the treatment from PRs #1753 through #1756.

The liquidation quote panel is the one that matters. A quote is a price for a
specific loan, on a specific network, for a specific size — so the previous
loan's ranked venues shown against a different loan is not stale decoration, it
is a number someone would act on. The panel now labels each quote with the whole
request it answers, and reports that it is still working rather than showing the
earlier answer. Closing and re-opening the panel re-quotes rather than showing a
price fetched before it was closed, and the explicit refresh button is included
in the label, since that button exists precisely to obtain a newer price.

The loan totals behind the analytics cards were keyed to nothing at all, so
switching networks showed one network's totals under the other's name until the
new figures arrived. They are now labelled with the network they describe.

One distinction worth stating: the periodic background refresh does **not**
count as a new question. It asks the same thing hoping for a fresher answer, so
the charts keep their current figures while it runs instead of blanking on every
tick. Only a genuine change of question — a different network, loan, or size, or
an explicit press of refresh — clears what is on screen.

## Connected app — three more lookups stop showing the previous answer (PR #1754)

Continues the change in PR #1753 across three further on-chain lookups: whether
the auto-lend feature exists on the current network, whether a wallet is
sanctions-flagged, and the risk figures behind each loan row. All three kept
their answer in place while a new one was being fetched, and corrected it only
after the page had drawn — so for a frame each showed the previous question's
answer against the new question.

What that looked like in each case. The auto-lend check drives whether the page
invites you to create an intent or tells you the feature is unavailable on this
network, so switching networks briefly showed the wrong one of those two. The
sanctions check is the sharper one: a previously checked address's "not flagged"
result sitting against a newly connected wallet reads as a clean bill of health
for an address nobody had checked yet. And the loan risk figures are per-network
per-loan quantities, so a set computed against one deployment could be shown
against another — and health factor is what the row colouring and the
liquidation warning are drawn from.

Each lookup now labels its answer with the whole question it answers — which
network, which address or loan set — and works out at drawing time whether that
label still matches what is being asked. It reports "still loading" when it does
not, and discards the answer entirely when the lookup is torn down, so re-asking
the same question after a pause reads as loading rather than as the answer from
before the pause.

The sanctions check keeps its existing convention that a loading result reports
"not flagged"; callers are expected to wait for loading to clear before acting,
and that has not changed.

## Connected app — the claim list and offer children stop showing the previous answer (PR #1755)

Two more lookups get the treatment from PR #1753 and #1754: the list of
open claims for a wallet, and the child loans that came out of a given offer.

The claim list is the one that matters most so far. It kept the previous
wallet's open claims in place while the new wallet's list was being fetched, so
for a moment a freshly connected wallet was shown someone else's claims — and,
worse in the other direction, a wallet with claims waiting could briefly be
shown the previous wallet's empty list. A stale "nothing to claim" is a reading
that costs a user money, or at least a wasted trip.

The offer children lookup was already trying to solve this and getting it half
right. Its own note says it clears the previous offer's rows "so navigating
between offers can't briefly show the previous offer's children under the new
one" — but the clearing happened just after the page had drawn, which is the
frame it was meant to prevent. Both now label the answer with the whole question
asked and decide at drawing time whether the label still matches, so there is no
frame to shorten.

Both also discard their answer when the lookup is torn down, so reconnecting the
same wallet, or coming back to an offer already visited, reads as loading rather
than as the answer from before.

## Connected app — the admin check and the accept preflight stop lagging a frame (PR #1756)

Two more lookups get the treatment from PRs #1753, #1754 and #1755.

The admin check decides whether protocol-administration controls appear. It
reset itself only after the page had drawn, so on disconnecting a wallet, or
switching to a network where that wallet holds no administrative role, the
controls stayed on screen for a moment for someone who no longer had the role.
The on-chain role check has always been the real boundary and is unchanged —
nothing could have been done with those controls — but showing them at all is
misleading.

The accept preflight is the check the accept modal runs before letting an offer
through. It kept the previous offer's verdict while the new offer's check was in
flight, so opening the modal on a second offer briefly showed the first offer's
answer against it. That verdict is what drives the modal's blocking messages,
so the wrong one is the difference between "you may accept this" and a specific
reason you may not.

Both now label the answer with the whole question — which network, which wallet,
which offer — and work out at drawing time whether the label still matches.
The preflight's label also includes its explicit re-check counter, so the
re-check that runs after recording an acknowledgement cannot be satisfied by the
answer taken before it; that call exists precisely to get a fresh verdict.

## Connected app — asset details no longer flash the previous asset's answer (PR #1753)

Three of the app's asset lookups — liquidity tier, liquid-or-illiquid status,
and on-chain token name/symbol/decimals — kept their "still loading" and "not
applicable" states as stored values that were corrected shortly after the page
had already drawn. Because the correction happened after the draw, switching
from one asset to another showed the previous asset's answer for a frame,
underneath the new asset's name. On the create-offer and offer-book surfaces
that meant a line like "Tier 3 — borrow up to 80%" could appear beside an asset
it did not describe, then change.

The three lookups now label each answer with the asset it was fetched for and
work out what to show at the moment of drawing: the answer if it belongs to the
asset being asked about, "loading" if it does not yet, and "not applicable" when
there is nothing to look up. There is no window in which a stale answer can be
displayed, in either direction — switching to an asset that cannot be looked up,
or switching between two that can.

The second case is the one that mattered and the one the previous approach never
addressed: it reset itself only when the asset became invalid, so moving between
two perfectly valid assets was exactly when the stale reading was shown.

Three cases the first version of this change still got wrong, all the same
mistake: the answer was labelled with the asset it was fetched for, but not with
the chain it was fetched from, nor with whether the lookup had been switched off
and on again in between. Switching networks with the same asset selected kept
the previous network's answer — and for the tier lookup that answer sets a
borrowing limit, so it is not a cosmetic staleness. Toggling the collateral type
away from ERC-20 and back on the create-offer form, with the address left in
place, re-showed a liquidity reading taken before the toggle, which the submit
gate would have accepted as current. The label now covers the whole question
being asked, and an answer is discarded when the lookup is switched off rather
than kept for a later re-enable.

No change to what any of the three lookups reports once it has resolved.

## Connected app — the pending-changes panel stops listing another network's queue (PR #1763)

The admin panel lists governance changes that have been scheduled and are
waiting out their delay. That list carried no record of which network it was
read from, so switching networks showed the previous network's queue.

This one lasted longer than the equivalent problem elsewhere in the app. The
panel deliberately does not re-read on a timer — an earlier attempt to do so
was withdrawn because rediscovering operations through a limited history window
could make a genuinely pending change disappear at the moment it became
executable, and a vanished proposal is worse than a stale one. The consequence
is that a list carried across a network switch stayed there until the page was
remounted, rather than for a frame.

The list is now labelled with the network and timelock it was read from, and the
panel reports that it is still reading when the label does not match. A network
with no timelock deployed is treated as a settled "nothing queued here" rather
than a perpetual loading state.

The decision not to re-read on a timer is unchanged.

## Connected app — editing a page no longer reloads the whole app (PR #1752)

Seven files in the connected app exported a React component *and* something
that is not a component — a hook, a set of protocol constants, a pure string
helper, a data mapper. That combination defeats Fast Refresh: when the file is
edited the dev server cannot prove the non-component exports are unchanged, so
instead of hot-swapping the component it reloads the whole page. In practice
that meant a one-character change to the offer book, the keeper settings page,
the locale resolver, or any of the three context providers dropped the
connected wallet session, the open modal, and every bit of scrolled-to state,
and the developer had to walk back to where they were.

The non-component halves have moved to modules of their own, next to the other
things of their kind rather than inside a page: the locale-prefix helpers now
sit with the rest of the i18n code, the keeper permission bits with the other
protocol constants, and the offer row shape with the offer libraries — where
three unrelated callers were already reaching into the offer book page to find
it, which is the clearest sign it never belonged there. The three data-freshness
/ watermark / realtime-push providers keep all of their logic; only the context
handle and its reader hook moved to a sibling module.

No user-facing behaviour changes and no intended behaviour changes — every
moved definition is byte-for-byte what it was, and the test suite passes
unchanged. This clears the twelve `react-refresh/only-export-components`
warnings tracked in #1749; the `set-state-in-effect` half of that issue is
untouched and still open.

## Connected app — the loan detail page no longer shows the previous loan (PR #1757)

Opening a loan's detail page, then navigating to a different loan, showed the
first loan's parties, amounts and status under the second loan's heading until
the new read finished. The page did try to avoid this — it set itself to a
loading state when the read began — but that happened just after the page had
already drawn, which is the frame the loading state was meant to cover.

The read now labels its answer with the loan it was fetched for and the page
decides at drawing time whether the label matches what is on screen. Where it
does not, the page reports loading rather than the previous loan's figures.
Leaving a loan and returning to it re-reads rather than reusing the earlier
copy, which matters because a loan's status and outstanding amount are exactly
the fields that move while you are away.

One behaviour is deliberately preserved: on a network with no deployment, the
page still reports a settled "nothing here" rather than a permanent loading
state, so the unsupported-network banner keeps rendering as before.
