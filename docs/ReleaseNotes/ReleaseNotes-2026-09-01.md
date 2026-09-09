# Release Notes — 2026-09-01

Six entries. Three are about the same thing viewed from different angles — a
report that tells you what it contains before it leaves your device — and the
fifth is about a quieter kind of honesty: what a button is entitled to claim
once the work it started has finished.

The sixth entry was folded in after the day's first assembly. It adds the
recycling loop's fourth absorption channel — a consumable perk bought with a
user's own VPFI — and closes a broadcast that could have left a mirror chain
stranded.

The support report the app builds is a pre-filled public issue, so its contents
reach GitHub the moment the form opens — before anyone has decided to file
anything. Reading it first was therefore the whole safeguard, and the only way
to do so was a Copy button that could fail without saying a word. It can now be
read in the app, a refused copy says so and shows it, and the same text is what
the link carries and what a support ticket attaches: one thing to read, covering
every route out. The address scrubber that guards it also stopped depending on
an address being written the ordinary way, since a prefix is a convention and
conventions are the part that gets omitted.

The third is a deletion. Eight translated marketing strings described a fee
discount that works differently now, and one of them told readers their
settlement rate is not their current rate — the reverse of the truth. None was
ever displayed, so nobody read them; they are gone rather than corrected,
because copy that already exists in ten languages is copy the next developer
trusts.

The fourth is operational and shares the theme: a deploy guard was deciding
which Worker a configuration protected by where the file sat, when Wrangler
decides it by what the file says. It asks the configuration now.

The fifth is about buttons that report on their own work. Press one twice, or
press it and move on, and two answers can be outstanding at once — and the app
was showing whichever arrived last, regardless of which question it belonged
to. Fixing that turned out to need three separate things, each found by looking
harder at the previous one: ignore an answer a newer press has superseded; have
a confirmation say which address, token or report it was earned by, so it
cannot carry over to whatever has replaced it on screen; and, when a wallet
answers "no" rather than failing outright, read the answer instead of counting
it as agreement.

## Thread — The deploy guard now asks which Worker a configuration names (PR #2036)

The repository-wide deploy checker protects two Workers, and until now it
decided which Worker a deployment targeted partly by where the configuration
file sat on disk. Wrangler does not work that way: it reads the Worker's
identity out of the configuration's own name field. A configuration living
outside either protected directory but naming one of them therefore deployed a
protected Worker while the checker reported nothing, because the directory it
was asked about was out of scope.

The checker now reads that field. When a deployment explicitly selects a
configuration file, and that file can be found and understood, the name it
declares decides the answer — the same rule Wrangler itself applies, and the
same rule the checker already applied to an explicitly named Worker. This cuts
both ways: a configuration sitting inside a protected directory but naming a
different Worker is now correctly treated as deploying that different Worker,
whose values are not the protected ones.

When the file cannot answer, the checker no longer stays silent. It still tries
the older directory-based reasoning first — a configuration selected from inside
a protected package is reported against that package, with that package's
remedy, because that is the more useful answer when it is available. What
changed is the case where even that yields nothing: rather than passing the
deployment, the checker reports it against no package at all, with a remedy of
its own, because naming a package would be a claim about a Worker that was never
identified. That remedy is to make the command safe for whatever it targets,
which is always available and never wrong for any Worker: carry the preservation
flag, or declare preservation in the selected configuration.

A configuration the surrounding script rewrites on its way to the deployment is
not the file that gets loaded, so the copy sitting in the checkout answers
nothing about it — neither which Worker it names nor whether it preserves
values. A script that ships a configuration declaring preservation and edits
that declaration away immediately before deploying is the case, and it reads as
safe to anyone reading only the checked-in file. Both of the checker's readers
of a selected configuration now stand down when they see it being written,
whether the write is spelled as a file write in a program or as a redirection in
a shell script.

That inversion is affordable because it was measured before it was adopted. The
repository contains one hundred and thirty-two deployment mentions and none of
them selects a configuration file, so the rule cannot produce a single complaint
on the tree as it stands — which matters, because this checker runs as part of
type-checking and a wrong complaint would block every change in the repository.
Anyone who later adds a legitimate configuration-selecting deployment clears the
complaint by making the command safe, not by asking for an exemption. The
measurement is worth re-taking rather than assumed, and the reasoning is
recorded beside the rule so a future reader can re-take it.

The inversion is deliberately confined to configuration selection. Two related
options name a directory rather than a file and reach the same
cannot-be-identified state, but they are ordinary in wrapper scripts and were
not part of the measurement, so widening to them is separate work with its own
count. The surrounding text still gets the first word, which on a runbook line
names a package the reader can act on — but it no longer gets the last one. A
command written out as an executable call in a helper script has no surrounding
text to defer to, and deferring there produced no answer at all, so a generated
configuration selected from such a helper passed unexamined.

The order is what makes both work. A selection the checker resolved wins
outright; one it could not identify yields to the text and to the directory the
command runs in, and claims the deployment only when neither has an answer. An
earlier attempt at this made the unidentified case win immediately, which
closed the gap and turned a report that could name a package, with that
package's own remedy, into one that named nothing — a correct answer, and a
worse one.

A configuration a script generates deserves the same treatment for
preservation, and now gets it in two more places. An explicitly named
configuration is answered by the path it names and by nothing else: the checker
used to fall back to a file of the same name inside a protected package, which
answers about a different file. And a script that writes the configuration
before deploying it is recognised in more of the shapes a script actually uses,
including the one where the file is named before the write rather than inside
it. The write has to come first, though — a scan that ignored order let
maintenance code below a deployment invalidate the file that deployment reads,
and report a correct command because of a line that runs after it.

Selecting an environment changes which name ships, and the checker reads that
too. Wrangler layers the chosen environment over the top of the configuration
and takes the deployed Worker from the result, so a configuration whose
top-level name is some unprotected Worker can still deploy a protected one
through an environment further down the same file. Which environment matters:
when the choice is written plainly enough to read, only that one is consulted,
because deploying one environment says nothing about the others, and consulting
them all made an unrelated environment answer for a deployment that never
touches it. Where the choice cannot be read, every environment is a candidate.

An environment can be chosen in more ways than a command-line flag, and most of
them look like nothing at all. A command inherits whatever its parent was
started with, so an environment can arrive without appearing anywhere in the
script; a file of variables named for loading is read before the configuration
is; a set of variables assembled elsewhere in the script carries the same
inheritance forward. Nothing written on the line can rule any of that out.

So the checker presumes an environment is chosen, and unnamed, and asks instead
what would rule it out. Four things do: naming the environment explicitly as
empty, assigning the variable explicitly as empty, removing it outright, or
handing the command an environment built entirely in the script with nothing
inherited into it — the one construct that gives the command a closed set of
variables rather than an open one. That last one carries the whole weight of
proving a negative, so it holds only when every name in it can be read: a
computed name the checker cannot work out is exactly the name it is looking
for, as far as it knows. Absent all three, every environment the configuration declares is a
candidate. That is a wide presumption and it is affordable for the same reason
the earlier one is: it only ever decides between configurations the checker
could read, and no deployment in this repository names a configuration at all.

The point where this had to be settled is what a name that matches nothing
protected proves. If the environments were read, it proves the deployment is
out of scope, and the checker says so. If they could not be — a configuration
in the format whose environments live in sections this checker's reader stops
before — it proves nothing, because an unread section could name a protected
Worker, and the checker falls back to the directory instead. An earlier version
of this work applied the cautious half everywhere. That was sound while
environments were not read at all and became wrong the moment an inherited set
of variables counted as a choice, since almost every real command carries one:
the caution then fired constantly and reported ordinary deployments of
unprotected Workers. It now applies only where it is earned.

This was the one finding of ten deferred out of the preceding deploy-guard
work, on the grounds that reading another file was a different kind of tool
from scanning a line. That objection no longer holds: resolving a path against
a modelled working directory, opening the file and reading a field out of it
was built during that same work for the preservation setting, so this is one
more field out of a file the checker already opens.

Closes #1996.
Closes #2040.
<!-- assembled-fragment: 1996-config-identity.md sha256=16ba9cf1eb267ba68f70a3aadde7a3171e03e6130e1b16976bc8a6a65811b973 -->

## Thread — You can now read a support report before sending it (PR #2043)

The Diagnostics drawer offers to open a support report as a pre-filled GitHub
issue. The details it carries — the last error, where it happened, which
network, a shortened wallet — travel in the link itself, which means they
reach GitHub the moment the form opens, whether or not anyone goes on to file
the issue. That is the right design for a report someone has decided to send.
It puts a lot of weight on the step before the decision.

The drawer shows a summary of what it holds, and the summary is deliberately
short: it renders the first few hundred characters of an error message and
none of the technical trace, while the report carries several times more of
both. So the honest way to check a report was to copy it, read it, and then
decide whether GitHub could have it. "Copy details" was that step.

It could fail without saying anything. A browser can refuse an app access to
the clipboard — a hardened privacy setting, a denied permission, a page not
served securely — and when that happened the button did not copy, did not
report an error, and did not even change its label. Nothing was on the
clipboard and nothing said so. The only way left to see what the report
contained was to open the report, which is the act of disclosing it.

**The report is now readable in the drawer.** A "Show full report" control
displays exactly what the link would carry, so it can be read, and selected
and copied by hand, without the clipboard and without sending anything. Copy
details stays as the convenience it was always meant to be.

**And a refused clipboard now says so — and opens that view.** Reporting the
failure on its own would have been more honest and no more useful; the point
of the step is to see the report, so the failure message arrives with the
report already on screen and names the remedy that is now in front of you.

**One more button was claiming a success it had not had.** On the testnet
faucet, the button that copies a newly minted token's ID changed to "Copied."
without waiting to find out whether the copy worked, so on a browser that
refuses the clipboard it said the ID was copied when it was not. Someone told
that stops reading the ID displayed just above it and pastes whatever their
clipboard held before. It now confirms only a real copy, and otherwise points
at the ID on screen.

The two are the same mistake facing opposite ways: one stayed silent when it
should have spoken, the other spoke when it had nothing to say. A control that
reports on its own success is worth no more than the accuracy of that report.
<!-- assembled-fragment: 2023-read-the-report-before-you-send-it.md sha256=0c7a3dbf68f9a258b736f2ef0ece4f2472a30065923b524490af4ba4bee3ecd4 -->

## Thread — Support reports now redact an address written without its 0x (PR #2043)

A support report shortens every wallet address in it before the report can
become a public issue — the first six characters, an ellipsis, the last four.
That promise is repeated to users in the Privacy Policy.

That promise held for an address written the ordinary way, and this change
widens which spellings it covers — it does not make it unconditional. The
scrubber searched for `0x` followed immediately by forty digits, so it
recognised an address only when the two were written together. Put anything
between them — a space, a second query parameter in a link — and the address
travelled whole. So did forty digits written with no `0x` at all, which is a
full account one fixed two-character edit from being usable.

**The scrubber now recognises the digits, not the prefix.** A run of exactly
forty hexadecimal characters standing on its own is treated as an account and
shortened, wherever it appears and whatever comes before it. Where a `0x` does sit
right beside them it is still taken along, so a report reads exactly as it
did.

**Transaction hashes still come through untouched**, which is the constraint
that shaped the fix. Support needs those whole, and a hash is a longer run of
the same characters — sixty-four rather than forty — so it is not mistaken for
an account, and neither is the last forty characters of one.

**Two gaps are left open on purpose, and are written down rather than left to
be found.** A run of hex *longer* than forty is not shortened, and an address
deliberately cut in half and rejoined around a separator is not either. Both
follow from keeping hashes intact: any rule aggressive enough to catch them
also destroys every hash in every report. Neither shape occurs in an ordinary
error message — producing one takes deliberate composition by someone who
already knows the address.

There is a general point in this worth keeping. The previous rule was not
wrong about what an address looks like; it was wrong about what identifies
one. A prefix is a convention, and conventions are the part an attacker is
free to omit.
<!-- assembled-fragment: 2027-an-address-is-its-digits.md sha256=d39965d00ee6853b23d7d70168930e88bdfaa2367a85f06d93531234e9edd68e -->

## Thread — Removed eight unused marketing strings that described the fee discount wrongly (PR #2043)

The marketing site carried eight translated strings, in ten languages,
describing how the VPFI fee discount is calculated. The description was out of date, and
one of them was not merely stale but backwards: it told a reader that at
settlement the treasury cut is reduced by a *time-weighted average* of their
discount "not the current rate", and that a late top-up would earn a share
*proportional* to how long the tokens were held.

Settlement uses the current effective tier. And the real rule cannot produce a
proportional outcome at all — the tier is a *minimum* over recent history, and a
minimum is not a proportion. Someone at the lowest tier for most of a month who
raises their balance at the end resolves at the lowest tier, not somewhere in
between.

The strings are gone rather than rewritten. **None of them was displayed
anywhere** — they belong to two cards that were never built on this site, so no
visitor has read any of this. The one string a visitor *could* reach was
corrected separately, in the change that first found this.

Deleting is the safer of the two options here, and the reason is about the next
person rather than the current reader. Copy that already exists in ten languages
is copy the next developer will trust: someone building that card would
reasonably wire these up and ship a screen telling lenders their settlement rate
is not their current rate. A missing string is a visible gap that gets written;
a wrong one gets shipped.

The conclusion the worst of them drew — that topping up just before repayment
does not capture the full current-tier discount — remains true. It is true for a
different reason: a discount tier needs a minimum holding period, and it is
clamped to the lowest level held recently. Only the stated mechanism was wrong,
which is the same shape as the error that prompted the sweep.
<!-- assembled-fragment: 2033-remove-dead-discount-copy.md sha256=b37eafc6e68989085becf2599e811f099d802f778ddb4c5d78c237ac44a0260a -->

## Thread — A late answer can no longer speak for a newer question (PR #2049)

Several buttons in the app do something that takes a moment and then report
how it went — copying to the clipboard, asking a wallet to add a token. If you
press one twice, or press it and then move on, two answers can be outstanding
at once, and until now whichever arrived last was the one displayed, regardless
of which question it belonged to.

That produced small untruths of the worst kind: a button saying it had copied
something when the copy was refused, or saying a copy failed when it had
worked. The same shape appeared on the testnet faucet, where a request to add a
token to your wallet could sit waiting for your approval while you minted a
second token — and approving it then marked the *new* token as added, when what
you agreed to was the previous one.

**Every one of these now ignores an answer to a question that has been
superseded.** Press twice and only the second result is shown. Move on to
something else and the earlier answer is discarded rather than applied to what
is now on screen.

**And a confirmation now says what it is about.** Ignoring a superseded answer
turns out to cover only half of it: if you leave a wallet prompt open and then
switch account or network, or a list of addresses redraws with different rows,
nothing has superseded the answer you are waiting on — the question underneath
it has simply changed. A button that only remembered "yes, that worked" could
not tell. So each of these confirmations now records *which* address, token,
wallet and network it was earned by, and shows itself only beside that one. An
answer that arrives about something you have moved on from is no longer
applied to what replaced it, and "Added to your wallet" no longer stands over a
wallet that was never asked.

That applies to the support report too, and it is the place it matters most.
The report refreshes itself while the panel is open, so "Copied" could sit
beside a version of it that was not the one your clipboard took — on the one
control that exists so you can read the report before deciding whether to send
it. The confirmation now belongs to the exact text that was copied. The
*failure* notice deliberately stays put when the report refreshes: it is still
true that the copy did not happen, and making an accurate warning vanish would
be the worse mistake.

**And a wallet that declines quietly is no longer counted as a yes.** Asking a
wallet to add a token can come back as a plain "no" rather than as an error,
and the app was treating anything that came back at all as agreement — so a
declined prompt could still read "Added to your wallet". It now looks at the
answer.

**Where a control stays quiet, that is deliberate**, and it is about not
crying wolf. When a wallet declines to add a token, that is usually because you
declined it — and the app cannot tell your decision apart from a genuine error,
so reporting one would be guessing at your intent. The small address chips that
copy an account are quiet for a different reason: they simply do not flip to
"Copied", which is the whole of what they claim. The two controls that do make
a claim in words — the diagnostics report and the testnet faucet's token ID —
say plainly when they could not do what they were asked.

The rule is now written down in one place rather than repeated at each button.
It had been fixed four separate times in the preceding change, each time
correctly and each time only where it had been noticed; four is the point at
which a habit should become a thing that exists.
<!-- assembled-fragment: 2044-one-rule-for-late-answers.md sha256=e6ac4ccd7992695e35ffddfc45d835abfe75c72be9480015cf9de15025eed2f8 -->

## Thread — VPFI recycling: the perk absorption channel, and a broadcast that could strand a mirror (PR #1349)

The recycling loop's absorption side has been thin: until now only forfeited
interaction rewards, the notification tariff and the Full tariff put value back
into the recycle bucket. This adds the fourth channel the programme has been
carrying as a design since the tokenomics redesign — spend-gated perks.

A user may now buy a consumable perk entitlement by spending VPFI from their own
vault. The spend moves into protocol custody and credits the recycle bucket as
genuine absorption, because it is fresh value from a user that has never been
counted anywhere else. It is a purchase, deliberately: not refundable, earning
nothing, conferring only a convenience — never a change to risk parameters, to
the terms of offers already posted, or to any settlement outcome. That shape is
what keeps a perk a price on a service rather than an instrument.

What deliberately did NOT ship is any individual perk's behaviour. Which perks
exist and what they cost remain open product decisions, so the platform sells
entitlements and each perk's effect arrives with its own decision.

One of those decisions is settled, and in the negative: the listing-visibility
boost does NOT ship. A perk may change what its buyer gets, never what other
participants see — an ordering that can be bought is not a neutral book, and
saying so on the listing would document that rather than undo it. That rules
out visibility-for-sale as a whole class, not merely one proposed perk. A perk with no published price is not for
sale, and that is the state every perk is in on a fresh deployment — the channel
is dormant until an operator prices something. Those decisions are therefore
configuration rather than code, and nothing shipped here presumes them. Buying a
timed perk while one is still running extends it instead of replacing it, so
buying early never costs the buyer the remainder; withdrawing a perk from sale
stops further purchases and leaves what people already bought untouched.

Because the price and the shape of a perk are governance's to change, a purchase
now settles on the terms the buyer stated rather than whatever the chain happens
to hold when the transaction lands. The buyer names the most they are willing to
pay in total and the entitlement they are buying, and a perk that has been
re-priced or re-shaped in the meantime makes their purchase fail instead of
quietly charging more or handing them something else. That binding runs both
ways — a longer entitlement than the one agreed is still a substitution, and
refusing it costs a buyer nothing but a retry.

Once a perk has sold its first unit, its kind is settled: a timed perk stays
timed and a counted one stays counted. Entitlements live as per-holder records
that no setting can revisit, so changing a perk's kind after it has sold would
leave its holders with a basis the perk no longer reads — and changing it back
would revive entitlements that were meant to be gone. Price stays adjustable and
the perk stays withdrawable; only the meaning is frozen, and a new meaning takes
a new perk. Withdrawing a perk from sale also works while the protocol is
paused, which is when an operator is most likely to want it: purchases are
closed by that same pause, so nothing can be BOUGHT while it holds.

That is not the same as saying the lever can only shut a channel — an earlier
draft of this note said so and it is wrong. A price set during a pause is kept,
and the perk is on sale the moment the pause lifts, with no further action
needed. So a price written during containment is a scheduled opening, and worth
re-checking before the pause is lifted.

Separately, a cross-chain defect that could not be closed operationally. The
reward broadcast that opens a day on a mirror chain is permissionless by design,
so anyone may apply a finalized day. If that happened before the governor was
armed, a later rebroadcast of the same day was treated as a duplicate and
returned early — and because the arming day can only ever be chosen once, that
mirror could no longer be armed through that route at all. The operator runbook
could only avoid it by hoping an unused day still existed when it was needed,
which a third party gets to decide. A duplicate broadcast now installs the
arming day when the chain has none, while still refusing to re-choose one that
is already set, so the hole can be filled but never moved. A duplicate arriving
on the retired message format after the reward era has rotated is excluded from
this: replays on that format stay accepted so settled days keep replaying
harmlessly, but installing an arming day is not a harmless replay, and a retired
era must not get to choose one.

The same gap existed on a second route and is closed with it. A day first
opened by the older message format carries no lapse timetable, so its
rebroadcast on the current format is handled as a repair of that missing
timetable — and that repair finished without ever installing the arming day,
leaving the chain waiting on a further broadcast nobody had a reason to send.
Both routes now install it, on the same one-shot terms.

A third change gives one chain the ability to earmark part of its own recycling
budget for the keepers that serve it — but only when the home chain says so.
That instruction has ridden the cross-chain message since the mesh was built and
did nothing: the receiving chain stored it and no code ever read it. It is now
applied, and the amount is set per destination by an administrator on the home
chain only, defaulting to nothing. A receiving chain cannot grant itself a
budget, which is the whole point of the arrangement; and because the figure is
frozen into each day when that day closes, changing it affects later days rather
than rewriting settled ones.

That earmark is counted as its own kind of draw rather than folded in with the
budget a chain has been committed to spend. The two behave differently: a
commitment is something the receiving chain later reports back as settled,
which releases it, whereas an earmark is simply set aside and never reported
that way. Counting them together would have left every earmark looking like a
commitment that could never be settled, quietly and permanently understating
how much that chain had available. It is still subtracted from what the chain
can be asked to fund, so the home chain can never promise the same tokens
twice — that was always the point of counting it, and it is unchanged.

The earmark is also bounded by what is actually left. It is a second call on
one pot rather than a slice taken out of the first, so a chain whose own
demand has already used up everything it holds now earmarks nothing instead
of promising more than it has. An instruction that does not fit is honoured
as far as the pot allows rather than refused outright — refusing would let a
keeper-budget setting fail a whole day's funding, which is a far worse
outcome than a smaller keeper budget.

Upgrades do not land everywhere at once, and that gap is handled explicitly. A
chain still running the previous version records the instruction but cannot act
on it, because the code that acts did not exist yet — and once a day is marked
handled, an ordinary re-delivery would skip straight past the step that was
missed. The home chain would have set the amount aside while the receiving
chain still counted it as spendable. A re-delivery now completes that one
missing step, tracked separately so it can run exactly once no matter how many
times a day is re-sent, on both of the routes a re-delivery can take.

The monitoring that watches this accounting from outside was taught about the
new figure in the same change. It re-derives what each chain should have
available and raises a critical alert when its answer disagrees with the
chain's; without being told about the earmark it would have disagreed by
exactly that amount and reported every healthy chain as broken. It can now
also check the earmark against the room actually left, which nothing else
could see.

Arming it required making room first. The contract that owns the reward day had
32 bytes of deployable space left — less than a single call — so nothing could
be added to it at all. The part that ships a finished day to other chains has
been moved into its own contract, along the boundary the code already described:
that step was documented as deliberately separate so a finalization stays cheap
and a failed delivery to one chain can be retried on its own. Nothing about the
behaviour changes, the same operations are reached the same way, and the move
freed roughly five kilobytes — enough for this work and for the queue of changes
that were previously undeployable.

Also in this pass: the indexer now tells an out-of-date contract apart from an
unreliable network when it reads the recycling backing figures, because those
two need opposite operator responses and previously produced the same log line.

Refs #1349, #1204, #1944, #1930, #1569.
<!-- assembled-fragment: 1349-vpfi-perk-channel-and-broadcast-arming.md sha256=7d64ece3ace41c6ed9e8659ca73a7f19d200ae292dd44f31c11f3bf495ba20a8 -->
