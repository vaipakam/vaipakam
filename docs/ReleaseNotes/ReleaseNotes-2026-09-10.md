# Release Notes — 2026-09-10

Five entries, and the day's theme is the gap between a thing having shipped and
a person being able to reach it.

The largest is a close-out the protocol has always allowed and the app never
offered: a lender could watch the repayment window and the grace period both
expire and find nothing on the page to press. The card that fixes that is
mostly notable for two refusals — it will not compute for itself whether the
grace period has elapsed, because a deployment may configure its own grace
schedule and a page whose whole job is saying whether you may act yet cannot
afford to be silently wrong about it; and it names no amount it cannot
substantiate.

Two more are about addresses people already hold. The last two public-read
surfaces still stranded on the retired deployment — the analytics dashboard and
the protocol console — are rebuilt on the connected app, the analytics page
reading the indexer's public keyless endpoints so its numbers can be checked
rather than trusted, stating the age of its data beside the data and
distinguishing a counter the indexer did not report from one that is genuinely
zero. Alongside that, a sweep of what the retired app actually served found
saved links that would have landed on a not-found page, including a whole shape
of address — the retired app put the reader's language into the URL, so every
page existed under a dozen spellings.

The remaining two are about verification itself. The app's live-review matrix
gains a second axis: role journeys, which ask whether someone who has never
seen the product can get from the landing page to a lending offer, a question
every feature row can pass while the answer is no. And the deploy checker
learns that a configuration which is *named* and then written through a
variable is still a rewrite — a script that bound the path first put no name at
the write, so every pattern walked past it and blessed the checkout's copy of a
file the deployment would not load.

## Thread — a second axis for the app's live review: role journeys, not just features

The connected app's verification matrix is organised by feature — one row
per PR or issue, each asserting that a mechanism works. That answers "did
this ship?" It does not answer "can someone who has never seen this
product get from the landing page to a lending offer without hitting a
dead end?", and a surface can pass every feature row while failing that.

A new live driver covers the second question. Each scenario is written as
a user goal with its desired outcome recorded BEFORE the run, and the
actual outcome captured from the live page, so a run can be diffed
against the previous one rather than merely going green. Roles are wallet
postures rather than personas: a first-time visitor is reproduced with no
wallet installed at all, so the app's no-provider paths are the ones
exercised. Two weaker versions were tried first and are worth naming — a
wallet that connects itself tests a returning user, and a wallet that is
installed but reports no accounts tests someone who has an extension and
has not connected it. Neither reaches the code a visitor without a wallet
actually runs.

Fifteen scenarios ran against the deployed app and all fifteen passed.
The one worth naming is the recovery flow: disconnected, it explains what
the flow is, warns that recovering unrecognised tokens can get a wallet
blocked, and asks for a connection while rendering no form at all;
connected, it states plainly that recovery is unavailable because the
screening service is not configured on this network, and that tokens stay
where they are. That is the arm the fork suite cannot check honestly,
because its spec installs a mock oracle.

Two limitations are recorded in the matrix rather than left implied.
Several assertions began as body-length thresholds, and observed lengths
swung between runs as asynchronous reads landed, so a threshold loose
enough to accept both ends caught a blank or missing page and little else.
Review closed that gap before this shipped: each of those scenarios now
identifies its page by the heading the app itself publishes, and the ones
promising controls or claimable items require those specifically — a
faucet with nothing to mint, or a page still loading, no longer counts.
What a green run still cannot tell you is whether the surface is right,
only that it is the right page, populated, finished loading, and — for
the connected roles — genuinely connected.

That last clause was itself a late correction, and the more useful of the
two. The check that proved a connected run really was connected worked by
noticing that the "connect your wallet" button had gone. Anything that
stopped it recognising that button, a reworded label being the obvious
case, would have read as success, and the whole connected walkthrough
would then have run against a signed-out app while reporting green: the
pages it visits still render their headings and their controls to a
visitor. It now looks for the address the header shows only once a wallet
is actually connected, and checks it is the right one.

One scenario also learned to say it did not find out. Asked to confirm
that recovery presents itself as unavailable on a deployment with no
screening service configured, it used to accept a working-looking
recovery form as evidence that a service must be configured — which is
the same page it was sent to judge. Where it cannot tell a configured
deployment from the regression it watches for, it now reports the
scenario as unverified rather than passed. A review that overstates what
it checked is worse than one that admits a gap, because only the second
gets fixed.
And both false failures during the driver's own first runs were the check
being wrong rather than the product: an assertion written from
imagination missed the shipped copy's curly apostrophe, and a settle
period too short for an asynchronous configuration read renders
identically to a disconnected page. Both lessons are written beside the
rows they came from.
<!-- assembled-fragment: 1854-role-based-live-journeys.md sha256=cf6cf348401308790916a65b440e0355a5ee257a1c1ae85af44a437b7acd4097 -->

## Thread — the last two unported surfaces, and the cutover that was waiting on them

The connected-app rename left two public-read tools behind on the retired
deployment: the analytics dashboard and the protocol console. That was
the whole reason the legacy host could not be retired — the marketing
site linked to both, and pointing those links at the new app would have
landed visitors on its in-shell not-found page. Both are now built on the
new app, and the marketing site's links follow it.

Neither is a transcription of the retired page. The old analytics screen
read through a stack of hooks that no longer exists; the new one reads
the indexer's public, keyless endpoints — the same ones any third party
can call — because a transparency page whose numbers cannot be
independently reproduced is asking to be trusted rather than checked. It
states the age of the data beside the data, since every figure is only as
current as the last ingest, and it distinguishes a counter the indexer
did not report from a counter that is genuinely zero. On a page whose
purpose is accuracy, an invented zero is worse than an admitted gap.

The protocol console shows the current values of the governance
parameters the public indexer publishes — a subset rather than the whole
catalogue, and the page says so rather than letting a reader assume
otherwise. Those it does show are read by NAME rather than by position in the config bundle — the
release record already carries an incident where hand-typed positional
tuples silently shifted, and a governance parameter displayed against the
wrong label looks authoritative while being wrong. It holds no controls
and never will: governance changes go through the timelock. The prose
reference stays on the marketing site, where it indexes beside the other
public explainers and is already pinned byte-for-byte against its source;
a third copy would only add something new to drift.

With both ported, the marketing links move to the new app and the helper
that pinned them to the old deployment is deleted — it always said it
existed to be removed rather than become a second permanent surface. The
VPFI call-to-action regained the landing position it promises, and that
anchor is present in BOTH the connected and disconnected states: almost
everyone arriving from that link has no wallet yet, so anchoring only the
connected view would have quietly dropped the majority at the top of the
page — the exact regression the switch was built to prevent.

Two things are deliberately unchanged. The recovery links in the user
guide still point at the old host, because that flow keeps safety state
per origin and moving the links early can let someone broadcast a second
recovery against the first; that turns on state, not on a missing page,
and a redirect does not satisfy it. And the notification-link host stays
where it is, being one decision with the frame paths beside it.

Found while verifying live, and worth recording: both new pages first
rendered empty for the visitors they exist for. They asked the wallet
library which chain to use, and with no wallet connected the honest
answer is Ethereum mainnet — a chain this deployment does not index. They
now use the app's own "where reads land when disconnected" resolution.

Review then found three more of the same shape — things that look right
in a live check and are not. Neither page had any styles at all: every
layout class it named was undefined, so both rendered as a plain
vertical stream. A browser makes unstyled text perfectly readable, which
is exactly why a glance at the deployed page did not catch it, and on
these two the cost is more than tidiness — a counter loses its label
when the pairing is only visual, and a value read against the wrong
label is the failure the console exists to prevent.

The analytics page also treated an indexer that had read nothing as an
indexer reporting nothing. A database still filling up answers every
question successfully with zero, so the page showed a full board of
authoritative-looking zeros for a deployment that may have years of
history behind it. "No defaults" from an empty database is the most
reassuring figure on that page and the least earned; it now says the
indexer has not started rather than showing the numbers.

And the "Smart Contracts" link in the marketing footer, which points at
the transparency section, arrived somewhere with no contract on it. It
now leads with the contract's address and a link to open it on a block
explorer, above the indexer's own provenance — the chain is the source,
and the indexer only a second-hand reading of it.

Both pages were also missing from the site's page-title and sitemap
tables, so each announced itself as "Page not found" in the browser tab
and asked search engines not to index it; and from the list of pages the
Terms prompt never withholds, so connecting a wallet could take away a
page anyone could read without one. The parameter reference the console
links to when an operator has hidden the live values turned out to be
hidden by that same setting, so that link is gone rather than promising
something the setting had already taken away.

A later look found the analytics totals could not be checked by the
reader they are for. Both the loan and offer counters totalled every
state the records hold while naming only some of them on the page, so a
position that closed as fully filled, or a loan waiting on a fallback
read, was counted in the total and shown nowhere — the total would
simply exceed the buckets beneath it, with nothing to say where the
difference went. On a page whose entire claim is that its figures can be
checked rather than trusted, a total that does not add up is the one
number that must not appear. The counters now name those states and
carry an explicit "other" for anything added later, and the total is
computed from the buckets themselves, so it adds up by construction
rather than by two separate counts happening to agree.

Worth recording honestly: on the deployment's current data every figure
already reconciled, because none of the unnamed states happens to exist
there right now. The defect was latent rather than visible, and the fix
is what stops it becoming visible the first time an ordinary lifecycle
produces one.

One gap is recorded rather than closed: the console shows every
parameter the indexer publishes, and the operator reference names some
it does not publish yet. Widening that is an indexer change, tracked
separately; the full reference remains public and the values remain
readable directly from the contracts in the meantime.

One bug found late is worth recording because of how it was found. Both
pages tell a reader how old the figures are, and both treated a
timestamp from the FUTURE as the freshest possible reading — showing
"0s ago" for a stamp that cannot be right, while the freshness guard
behind the parameter page actively confirmed it as current and kept its
own out-of-date warning hidden. A source whose clock is wrong, or whose
timestamp is corrupt, was therefore presented as maximally up to date.

The written specification for these pages already said the opposite —
that an unknown age must never be presented as a fresh one. It did not
need changing; the code did. That is the specification doing the job it
is kept for: it describes what the product is meant to do rather than
what the code happens to do, so it can disagree with the code and be
right. Both pages now share one tolerance for ordinary clock
differences and report anything beyond it as unknown.

A second gap is recorded the same way, and it is about trust in the
labels rather than in the numbers. The console reads governance values
by name, but the naming is applied when the page is served rather than
when the values were captured — so a future contract change that
reorders those values without changing how many there are could show a
real figure under the wrong parameter name until the next capture. That
is a change to how the indexer stores its snapshot, tracked separately;
it predates these pages, which only make the surface public.

Sharing that tolerance turned out not to be the whole fix, and the rest
of it is worth recording because the page ended up contradicting itself
in the one way it must not. The console warns when its published values
are more than a day old. It worked that warning out by asking whether
the snapshot was fresh and treating every "no" as age — but a capture
time from the future is also not fresh, for an entirely different
reason. So a producer with a wrong clock, or a corrupted stamp, made the
console announce that its values were more than a day old directly
beside a line reporting their age as unknown. Two confident and
incompatible claims about governance parameters, on the page that exists
to tell a reader how far to trust them.

A capture time in the future is not an age at all; it is a broken
reading, and the only honest thing to say about it is that the age
cannot be determined. That is already exactly what the page says about a
snapshot bearing no capture time, and the advice a reader needs is the
same in both cases — treat the values as unverified rather than as the
protocol's present configuration. So the two now resolve to one message,
and its wording moved from "no timestamp" to "no usable timestamp"
because it now speaks for both. The day-old warning is reserved for a
snapshot that is genuinely that old.

Two more corrections to the analytics page, both about claiming more
certainty than the data supports.

The page shows how many loans are active, and beneath that how many are
ordinary loans and how many are NFT rentals. Those two do not have to
add up to the first, and the page was presenting them as though they
did. When a loan is indexed before the details of what asset it is in
have been read, it is counted in the total and deliberately left out of
both types — the indexer's own note calls undercounting a type an
admitted gap and misfiling it a false statement, which is the right call.
What the page was doing was dropping the admission: a reader could
subtract, find a difference, and have nothing on the page to explain it.
The difference is now shown, whenever there is one, as active loans
whose type has not been read yet.

The freshness line had a subtler version of the same problem. The page
draws its counters from two separate requests and states a single "as
of" figure for all of them, and it was taking whichever of the two
answers happened to arrive with one. If those two reads are at different
points in the indexer's progress, the page was quoting the more advanced
of them over numbers that came from the other. It now quotes the one
that is further behind, which is the only figure true of everything
shown.

That is a floor rather than a guarantee, and the note it is written
against says so. Each request reads its counters and its position marker
separately, so a write landing between them can still return older
counters with a newer marker. Closing that needs the two bound together
inside the indexer, which is a change to a different service and is
tracked on its own.

The public analytics page shows how many loans are active and, beneath
that, how many of them are of each type. Subtracting one from the other
gives the loans whose type has not been read yet, and the page was
quietly treating a negative answer as zero. A negative answer means the
smaller numbers add up to more than the larger one — the counts
contradict each other — and rounding that away left three figures on
screen that do not reconcile, with nothing saying so. Anyone can do the
subtraction themselves.

The page now says it. When the counts disagree it says they disagree,
says the fault is in the counting rather than in anyone's loan, says
plainly that nothing is at risk, and leaves both the total and the
breakdown exactly as reported so the discrepancy can be seen rather than
taken on trust. It also stops short of claiming to know the right split,
because it does not.
<!-- assembled-fragment: 1959-port-analytics-and-protocol-console.md sha256=121e4a8757aeec008e491bac299701ac0a0fa40299fff4676bbf9262f552637c -->

## Thread — A configuration that is named and then written is a rewrite (PR #2066)

The repository-wide deploy checker refuses to trust the checked-in copy of a
configuration file that the surrounding script rewrites on its way to the
deployment, because the file sitting in the checkout is then not the file the
deployment tool loads. Until now it recognised a rewrite only when the write
itself named the configuration. A script that bound the path to a variable
first, and wrote through that variable afterwards, put no name at the write —
so every pattern the checker had walked straight past it and the rewrite was
blessed. That is a false green on precisely the hazard this reader exists to
catch. Closes #2052.

The rule is now asked in the checker's own currency: if a file names the
selected configuration and writes at all before the deployment, the checkout's
copy answers nothing. It does not attempt to work out *which file* a given
write lands on. That restraint is deliberate and is the design this reader
already documented for itself — a write and a deployment may spell the same
path differently, and a wrong resolution would silence a real configuration,
whereas an over-eager one merely leaves the identity unread, which reports.
An earlier version of this change did try to resolve write destinations, and
every false green it produced was one more spelling the resolver got wrong.
It was withdrawn in full, and the two follow-up items that asked for that
resolution were closed with it — one as invalid against the recorded design,
one as not worth its noise.

Answering by name means the checker has to know which parts of a file are
executable text. Most of the work in this change is that question, and it
arrived through review rather than by design: three separate ad-hoc readers
were tried and each was wrong about some language it was reading. Comment
markers differ — a double slash starts a comment in JavaScript and is integer
division in Python; a hash starts one in shell and Python but not JavaScript,
and needs a word boundary only in shell. A string literal is inert data in
JavaScript and Python, and is not inert in a shell, where a quoted payload
handed to an interpreter is executed. All three were replaced by a single
classifier that is told which language it is reading, and every later reader
in this area now asks it rather than adding another recogniser of its own.

That classifier carries the distinctions the review rounds surfaced: an
expression interpolated into a template literal or an f-string is code and its
writes count, while the format specification after a top-level colon in an
f-string is not; and a triple-quoted Python literal spans lines.

A JavaScript regular expression is deliberately **not** classified. Telling one
from a division needs the token in front of it, and that judgement was wrong
often enough — after arrow bodies, increments, keywords used as property names,
comments in unusual places and TypeScript's own punctuation — that it became
the main source of missed writes: whenever it guessed wrong it treated
everything between two divisions as pattern text, including any real write
there. Since the copy verbs now require a module qualifier, the case it
protected against is a pattern that literally spells out a qualified filesystem
call inside a file that also deploys. The checker accepts a report there rather
than keep a rule that hides writes elsewhere.

The checker briefly tried to tell a declaration from a call, so that declaring
a function named like a copy would not be reported. That reader had to
understand parameter lists, default values, return types, class members and
conditional expressions, and each correction it received exposed another form
it had not anticipated — eventually including cases where it discarded a real
write. It was removed. In its place, the generic copy verbs are recognised only
when they carry a filesystem qualifier, because a declaration named for a
module's copy function is not something anyone writes; the distinctive names
never needed the distinction at all. The narrower guarantee is therefore about
the generic names only: declaring `copy`, `move` or `cp` is not a write. The
distinctive names are read wherever they appear, and that is broader than a
declaration — a method of the same name on an unrelated receiver is reported
too, so a table being renamed or a logger opening a write stream will be
reported in a file that also names the configuration.

That is deliberate and it is the cost of a different miss: these functions are
very often destructured out of their module and called bare, so requiring a
module here would lose the ordinary spelling to catch an unusual one. It is
recorded this way round because the earlier wording said "declaring", which
described something narrower than what the checker does.

The same rule now covers every generic name the checker reads, because it was
being applied in one place and not the others. The names for running a command
include some that are distinctive and some that are not — one of the latter is
also the name of the method that matches a regular expression against a string,
so a pattern being matched was read as a command being run, and the checker
reported a rewrite that could not happen. A generic name is now admitted on its
own or after a module that runs processes, and after nothing else. The reader
that scans for the configuration by name had already required this of the copy
verbs and the one that scans directly had not, which is how the guarantee above
came to be written down while being untrue on one of the two paths.

Which option makes an interpreter run its argument also depends on the
interpreter: a shell runs what follows its `-c`, while the same letter asks
Node only to check that the source parses. Both letters were being accepted
everywhere, so a syntax check read as an executed write. The set of
interpreters this reader recognises was already written down, so this is a
mapping over a closed list; an interpreter it does not recognise keeps both
letters, which is the reporting direction.

One fix in this change is about neither writes nor languages. A shell command
may be continued across several lines with a trailing backslash, and the
reader that splits a file into commands folds each of those into a single
space — so a position within a folded command runs short of the same position
in the file, by one character for every continuation before it. The scan for
writes indexes the file. Comparing the two directly, a write that physically
preceded a deployment could measure as following it, and the rewrite was
blessed; enough continuations and the ordering simply inverted. The folds are
now recorded where they happen and the comparison is made in the file's own
coordinates.

A here-document body was treated as inert input for the same reason, and was
withdrawn on stronger evidence. Recognising where one ends means reading a
delimiter word that a shell accepts in more spellings than this reader could
keep up with — indented terminators, backslash quoting, quotes in the middle of
the word, punctuation the reader then read as pattern syntax — and a delimiter
read wrongly did not cost one line: it marked everything from the opener to the
end of the file as data, concealing every write below it. Review then disproved
what the rule was for. A here-document is input when it is handed to a command
that prints it and is *source* when it is handed to an interpreter, which is a
shape deployment scripts genuinely use, so the exemption was at its most
confident exactly where the writes run. It is gone. A body that both names the
selected configuration and spells a write now reports even under a printing
command, which is a report on a contrived line rather than silence on a real
one.

The shell comparison operator settled the same way. Inside a double-bracket
test a greater-than is a string comparison and not a redirection, and the
checker now asks only whether a substitution appears before it — not whether
the operator sits inside one that is still open. The sharper question was
attempted across six rounds and never answered: closed substitutions,
backticks, escaped backticks, an apostrophe inside double quotes, nested
subshells, literal parentheses in arguments. Every miss exempted a live
redirection. The blunt question errs the other way, over-reporting a comparison
that happens to follow a substitution, and it is bounded.

Following a package script into another script was tried on the same reasoning
and withdrawn for the same reason: it is inter-procedural analysis, the checker
declines that elsewhere, and doing it in one place and not the others produced
a steady stream of corrections rather than a settled rule. Whether this checker
should follow invocations at all is recorded as a separate question.

The set of writes the checker recognises was widened at its edges rather than
lengthened: a manifest script value is shell text and is now read as such;
a command still counts when it is reached behind an environment assignment or
a privilege wrapper carrying its own options; the redirection forms that
truncate a target — the no-clobber override, the combined output form, and the
all-streams form — are recognised alongside the plain one; and the Python call
that renames over an existing path is treated as the overwrite it is. Where a
method name is too common to admit unqualified, it is spelled with its module,
so the guard does not start reporting ordinary string manipulation. A path may
also be spelled in adjacent quoted and unquoted chunks — a single shell word
written with quotes in the middle of it — and the name is now recognised
through that spelling, as the reader that selects the configuration already
did.

A copy spelled as an argument list rather than a command line — a wrapper
handing one of the same copy commands to a child process — was recognised for
three rounds and is now **not**. Each round corrected it and exposed the next
thing: the verb sits inside a quoted string, so the match had to be anchored
outside it; the list may be formatted across lines; a list of the same strings
merely stored in a variable runs nothing; the walk that finds the owning call
began one character too early and missed the commonest spelling of all. The
last correction is the one that ended it: the verb also has to be the program,
and whether the first element of a list is the program depends on the calling
convention of the interface around it — two widely used ones disagree — so
answering it means keeping a table of process interfaces and their shapes. The
recognition was withdrawn instead, and what is missed is nameable: a copy run
as a child process through an argument list. The command-line spelling is
unaffected, and the preservation declaration covers the gap.

Which call owns a piece of code is still asked in one place rather than two.
That walk was separated out while the argument-list reader existed, and has
been kept: it names a question this checker asks, instead of hiding it inside
the answer to a different one.

A method call on a plain variable is not read as a file operation, in either
of the two places that tried to. Telling `webbrowser.open("w")`, which opens a
URL, from the same call on a path depends entirely on what the receiver IS, and
a bare name does not say. Qualifying it by the receiver's NAME was written and
withdrawn in the same sitting: a list of plausible variable names is precisely
the open-ended predicate this work keeps removing. Where the path is
constructed in place the shape is syntax rather than type, and is still read.

A call may be written with the optional-call operator, and that executes when
the member exists. The checker had been told so three times in three different
places before the rule was written down once and shared: the walk that finds an
owning call, the test for whether a constructed function is invoked, and the
write calls themselves. It is one fragment now, so a fourth place cannot repeat
it.

The bare spelling of the call that opens a file is a builtin in one language
and the browser's window opener in another, where a helper doing exactly that
was reported as a file write. It is excluded there specifically rather than
admitted only for the language that has the builtin — the narrower correction,
and the one two fixtures older than this work turned out to require.

The set of writes gained four more spellings, each a real one the checker had
been walking past: a descriptor opened for reading AND writing, which does not
begin with the redirection character the pattern looked for; a command reached
through the standard end-of-options marker; the call that empties a file, which
rewrites it by the shortest route and was in neither write list; and a shell
command written as a tagged template, which one runtime executes although it
looks like an ordinary string.

Two corrections went the other way. An escaped substitution marker inside a
stored value is literal text and the shell performs nothing — asked by the
PARITY of the backslashes before it, because one backslash escapes the marker
while two escape each other and leave it live, so testing merely for the
presence of one would have turned a false report into a missed write.

And a mistake this work has now made three times in three different patterns:
the space after a copying command was written as "any whitespace", which
includes a LINE BREAK. The pattern therefore ran past the end of its own line
and found the configuration's name in the deployment command below it, so any
mention of the word in a script that deploys reported a copy. This one was not
reported by review; it surfaced while checking something else, which is the
argument for probing a change rather than reading it.

Shell syntax only reads as shell where a shell is running. A greater-than is a
redirection in a script and an arrow, or a comparison, in JavaScript; a copying
verb is a command in a script and an ordinary name in Python. One of the two
scans had always drawn that line and the other had not, so both spellings
reported configurations nothing touched.

Correcting it needed more care than the report suggested, and the obvious
reading was wrong: the line is not drawn by the FILE's language. A shell
command handed to an interpreter from inside a JavaScript wrapper really is
shell, and deciding by the file lost eight pinned cases of exactly that. It is
drawn by POSITION — text quoted and handed to something that runs it is judged
on whether something runs it, and only text claiming to be the file's own
syntax is read in the file's own language.

That correction was then applied to only one of the two scans. The other went
on compiling its shell spellings away whenever the containing file was not a
shell, so a redirection inside a command that a JavaScript wrapper executes was
never looked for at all — and because the target of that redirection was held
in a variable, the scan that matches on the configuration's own name could not
see it either. Both scans now ask the same question, and they ask it the same
way: which spelling matched is a fact about the pattern, so the shell spellings
are a separate pass rather than an alternative inside the other one whose
identity had to be recovered by re-reading the matched text afterwards. That
re-reading was itself a second, drifting copy of every shell spelling — one
that had never learned about the write-to-both-streams command, the in-place
editors, or the named-descriptor redirections added after it — and it is now
deleted rather than corrected. Separating the passes also removes an
interference that would otherwise have been possible: two families of spelling
competing inside one pattern let a shell-shaped expression earlier on a line
consume the text a real write occupies later on it.

A payload also begins at its opening quote, and a command position had never
counted a quote as one. Reaching inside executed payloads made that visible
immediately: the redirection was found, and the copy command one character
further in was not.

Opening a file for writing is a write on its own, in every language this reads.
The Node spelling that takes a mode and hands back a descriptor was absent from
the vocabulary, so a helper that opened the configuration that way and wrote
through the descriptor was passed as safe. The truncating open is what is
recognised — the write that follows it names neither a file nor a mode, and the
verb it uses is exactly the kind of generic name this work keeps out.

The same question turned out to have a second half, in the other direction. The
plainest spelling of opening a file is excluded in JavaScript, where it is the
browser's window opener rather than a file operation — but a wrapper handing
source to an interpreter is running that interpreter's language, so the
exclusion was silencing a real overwrite written in the language being executed.
That form is now recognised wherever something runs the text, and stays excluded
where the text is the wrapper's own code, which is the rule the shell spellings
now follow. The three ways an open can carry its mode are written once and asked
of both spellings of the call, so the two cannot drift apart the way the deleted
duplicate did. And the shared statement of what counts as a call — which covers
the optional form that runs only when the member exists — had been written down
but not applied to the open patterns, so the rule the checker states about
itself was not true of every write it recognises. It is now.

An executable helper with no file extension is classified by its shebang, which
had been true for one interpreter and not the other. A Node helper was read as
a language with no string literals, so an inert example inside one was taken
for the file's own code — a false report, and false reports are the failure
this checker is least allowed.

Where a file-open mode may sit depends on what the call is opening, and that
is the language's rule rather than a preference. For the builtin and for a
module's open, the first argument is the file — so a call with a single string
argument is opening a file with that name and reading it, and reading it as a
mode reported a write that does not happen. On a path constructed in place the
first argument really is the mode, so both spellings are read there. One
function does not take a mode at all: its second argument is an integer flag
set, and the only way to see that it truncates is to read those flags, which
are a fixed set of standard names. A fixture written for it earlier in this
work had used the mode-string spelling, which that function refuses at
runtime — so it pinned code that cannot execute, and has been rewritten against
a module that does take one.

That in-place rule was written twice. The first spelling asked whether the
option group immediately after the command contained the in-place letter, and
review returned three separate objections to it in one round: the option may
carry an attached backup suffix, it may come after other options, and a
command that only prints its help edits nothing. Parsing a command's option
sequence is the flag table this work refuses, so the shape was replaced rather
than corrected — with the one the copying commands beside it already use: the
command, then its options wherever they sit, then an operand. The operand is
what excludes the help invocation, and it is a rule that already existed. The
condition for giving this up was restated at the same time, because the
original was too narrow: a third such editor, or another round of objections
about option shapes, ends it rather than extending it again.

Editing a file in place is a write, and until now nothing recognised it: there
is no redirection and no copying verb in it. Two commands are admitted with
their in-place option, not a category, because the same option letter means
case-insensitive to one common tool and interactive to another — so it cannot
be asked of the option alone. A third such editor is the signal to withdraw
this rather than extend it, which is the condition the argument-list reader was
given and met.

Three separate alternatives read a file-open mode, and each qualified its
receiver differently — or not at all. That single inconsistency produced a
report in three consecutive review rounds, every time on the same shape: a
call that opens a browser window read as a file being opened for writing. The
mode was never the problem. They now share one spelling of "a filesystem
open", which is a bare builtin or a member of a module that opens files, and
the question has one answer instead of three.

The exclusion for commands running in a mode that makes no changes has been
narrowed to the single spelling that means it unconditionally. The short and
long forms of "do not overwrite" do not: the tools themselves document that
when several such options are combined only the last takes effect, so a
command carrying one early and a forcing option later does overwrite, and
excluding it on sight hid a real write. Reading that ordering means modelling
how each command's options override one another, which is the per-command
table this work refuses, so those spellings were dropped rather than ordered.
A command told not to overwrite is now reported, which may be a write that
does not happen — the direction this checker prefers.

Two of the checker's own limits proved to reach further than the case that
exposed them, and both were found the same way — by running the checker rather
than reading it. The walk that finds which call owns a piece of code stopped at
a line break, and since that walk runs outwards from inside an argument list,
every line break inside such a list stops it: any call written across more than
one line lost its payload entirely, and the write inside it went unreported.
And the routine that decides whether a shell string is merely being stored read
characters without asking the classifier which of them were code, so a
separator inside a quoted word ended it. Both are now answered the way the rest
of this checker answers everything: through the classifier, and with the reason
recorded where the mistake was.

Three further shapes are deliberately NOT recognised, and all are misses — the
checker stays quiet where a more determined reader would speak. A file
operation reached through a variable is the first, as just described. The
second is a regular expression whose braces fall inside a string template: the
checker deliberately does not tell a regular expression from a division, so
such a brace is counted when the template's own braces are matched, and an
expression after it reads as ordinary text. Correcting that means asking the
question the checker removed for good reason, and its own record is that
guessing wrong there loses writes more often than this shape does. The third is
a command run through a module imported under an arbitrary alias:
resolving that name means following a binding, which this reader declines
everywhere and which is the subject of the open question above. The alternative
of admitting any named receiver was measured against the common case of
matching a pattern held in a variable, and would report that.

A write registered to run later — handed to an exit handler, a timer or a
promise — is read in the position it is written, not the position it runs. The
checker is lexical by design: knowing that a callback cannot run before the
deployment means modelling control flow, which is the same class of reasoning
as following a binding, and the alternative is a list of every way a language
defers work. The cost is a report on a script that defers its write until after
the deployment, which is unusual in the scripts this reads.

One shape is deliberately recognised too eagerly, and it is the opposite trade
— noise rather than a miss, so it is set out separately. A script that quotes
an example of a write to its own configuration will be reported, because in a
shell a quoted string handed to a command may well be executed by it; quoted
shell text is therefore read as executable unless it is plainly being stored.
Narrowing that was tried when the classifier was written and immediately lost
real payloads. All three are named here so they are limits rather than
surprises.

The boundary this reader works to is stated in it: it is defence in depth
behind the configuration declaration that actually preserves operator-managed
values, it is allowed to be incomplete, and it is not allowed to be noisy. A
missed exotic spelling costs nothing that the declaration does not already
cover; a false report blocks correct work, because this check runs inside
typechecking. Several review suggestions that would have widened coverage into
whole shells and dialects this reader does not parse were declined on that
basis, and the reasoning is recorded at the code rather than left implicit.
<!-- assembled-fragment: 2052-deploy-guard-named-write.md sha256=f1662c0047d2448b932d6e72c4f7749a0fb95e63cfd23929e4990f65bdb13508 -->

## Old links keep working — and stop quietly undoing the protections around them

The connected app moved to its own address, and the old deployment is
meant to be retired by pointing everything at the new one. That promise
only holds if the addresses people already have still land somewhere
sensible, and a sweep of what the retired app actually served turned up
several that would not have.

Three were simply missing. The NFT verifier had been renamed, so every
saved link to its old address would have arrived at a not-found page.
The VPFI vault had been renamed too, and its links often carried a
pointer to a particular step, which was being dropped even where the
address itself resolved. And the protocol console had been reachable
under an older name, along with its documentation — both gone.

The larger one was a whole shape of address rather than a single page.
The retired app put the reader's language into the address itself, so
every page it served existed under a dozen or more spellings. Those are
now answered by stripping the language from the address and continuing
to the real page — and, because a link that names a language is asking
for that language, the app switches to it rather than silently answering
in whatever the reader last used. That behaviour is inherited from the
app being replaced, and it has a consequence worth knowing: the choice
is remembered afterwards, so following one old link changes the reader's
language until they change it back. Matching the old behaviour was the
conservative call; narrowing it is a product decision, so it is flagged
rather than taken.

**What made this more than a list of redirects is that two protections
were being walked straight past.**

The first is the rule that keeps people from being locked out of their
own money. When the terms of service change, the app withholds the
pages that would let someone take on new commitments, and deliberately
never withholds the ones that let them repay, claim, or withdraw. But a
redirect is itself a page — so an old address pointing at repayment was
being held behind the terms prompt, and the redirect that would have
taken the reader to the unrestricted page never got to run. Someone
following an old bookmark met a consent screen on their way to paying
off a loan. The rule now looks at where an address leads rather than at
how it is spelled, and the language-prefixed forms are covered too.
Nothing is loosened by that: an old address leading to a page that
creates new commitments is still withheld, exactly as its current form
is.

The second is the instruction that keeps private pages out of search
results. That instruction is attached to exact addresses, and the
language-prefixed versions are not those addresses — so a search engine
that does not run the app would have received an ordinary, indexable
page for a personal position or claim, purely because the link carried a
language in it. Every such address is now excluded, with one rule rather
than one per language.

That last detail is not tidiness. The file carrying those instructions
has a hard limit on how many it may contain, and writing one pair per
language took it past that limit — which failed the deployment build
twice, with an error nobody could read from the build system. The single
rule fits comfortably and never grows. What makes one rule safe is that
every page this app asks to have listed in search is a single top-level
address, so a rule aimed at everything deeper cannot catch one of them;
that is now checked automatically, so publishing a nested public page in
future has to be a deliberate decision rather than an accident that
quietly hides it from search.

One related gap has been closed since. The individual NFT token pages
had already been taken out of search — they are an unbounded set of thin
lookups and have never been listed in the sitemap — but only in the page
itself, which a search crawler sees only if it runs the app's
JavaScript. Every other crawler was still free to list them, and the
file that would have said otherwise still described those pages as
listed. Both now agree, and the exclusion is in the response as well as
in the page. The verifier's own page is unaffected and stays listed.
<!-- assembled-fragment: legacy-url-compatibility.md sha256=3c79bef25e6ec3ecebff5d08a6edad0cf26e8fd4b0f2c77d0f7a87c68cba3822 -->

## Thread — the close-out a lender could never reach

When a borrower simply stops paying, the protocol has always had an
answer: once the repayment window and the grace period after it have
both elapsed, the loan can be forced closed and the collateral moved to
where the lender can claim it. Anyone can trigger that, the lender very
much included.

The app never offered it. A lender could watch the due date pass, watch
the grace period pass, and find nothing on the page to press — the one
moment the product owed them an action was the one moment it had none.
That is now a card on the position, and this note is mostly about the
two things that made it more than a button.

**The app must not work out for itself whether the grace period has
expired.** The obvious implementation reads the loan's start date and
term, adds the published grace ladder, and compares against the clock.
That is right until the first deployment configures its own grace
schedule, which the protocol explicitly allows — and then it is
silently wrong in whichever direction the operator tuned, on a page
whose entire job is telling somebody whether they may act yet. So the
card asks the protocol the question directly and renders the answer.
The grace figure is still read, but only to explain the wait; it never
decides it.

**The action is not one button, because the protocol settles these
positions in several different ways and only some of them can be driven
from a browser.** Where the collateral has no reliable market price, or
has fallen far enough in value that selling it is pointless, closing out
hands it over as-is and the app can do that in a single transaction. An
overdue NFT rental can also be ended in one transaction, but it is a
different thing entirely and the card no longer describes it as a
collateral transfer: ending a rental removes the renter's access, leaves
the lender's own asset exactly where it is, and makes the rent that was
paid up front claimable, less fees. Nothing belonging to the borrower
moves.

Where the collateral is ordinary and liquid, the protocol insists it be
sold on an exchange, and insists further that whoever submits the transaction
supply the route for that sale — deliberately, so that nobody can
shortcut an eligible loan into a worse settlement by simply not trying
to sell. The app cannot build such a route yet. It would have been easy
to show one button everywhere and let the second case fail; the lender
would have paid a network fee to be refused, with nothing explaining
why. Instead that case says plainly that the position IS closable, that
the sale has to be routed, that nothing in the product does that
routing automatically today, and that closing such a position needs an
operator — so it is worth asking about rather than waiting on.

Three things the card is careful never to claim. It never states an
amount, because the settlement path is chosen while the transaction
runs and no figure exists beforehand. It never suggests the lender is
the only one who can act, because they are not, and a lender who
returns to find the position already closed by someone else should read
that as normal rather than as loss. And it is careful about how the money
arrives: what is owed becomes claimable afterwards rather than landing
in a wallet, with one exception it now states — where the position is
settled against an opposing one, whoever submits the transaction is paid
a small incentive directly, out of that same settlement. The correction
further down this note describes it in full. It does not promise the loan is finished
either: closing out usually ends it, but where the protocol settles only
part of the position, or the sale of the collateral cannot go through,
the loan stays open and the borrower can still repay or add to their
collateral.

The card also appears before it is usable, which was a deliberate
choice rather than an oversight. It shows while the checks are still
running, and while the borrower still has time, saying which. Hiding it
until the moment it happened to be actionable is precisely how the
capability stayed invisible for as long as it did: nobody asks for a
route they have never been shown.

Writing the automated test for that behaviour caught a mistake in the
card's own wording, which is worth recording because of where it sat.
The heading read "This loan is overdue" in every state — including the
state whose entire message is that the borrower still has time. The
largest text on the card contradicted the sentence directly beneath it,
and it survived building the card, reviewing the card, and translating
the card into nine languages; it only became obvious when a test had to
assert a heading against the state it was checking. The heading now
depends on the state, and says "if this loan is not repaid" while the
answer is still open.

Review then found four more places where the card knew less than the
protocol does, and they are worth recording together because they share
a shape: each was the app modelling one of the contract's conditions and
stopping one clause short.

The card refused to appear at all for a lender whose wallet is
sanctions-flagged. Every other lender tool on that page does hide, and
copying the surrounding pattern is how this happened — but the close-out
is deliberately not one of those. The protocol keeps this route open to
a flagged caller on purpose, withholding only the incentive paid to
whoever fires it, precisely so a close-out cannot be blocked. Hiding the
card removed a flagged lender's only self-service recovery from a
position that had already gone bad.

A loan whose collateral is an NFT — an ordinary shape, not a rental —
waited forever. The card asked whether the collateral was liquid, a
question that only makes sense for a token with a market price, and
never received an answer because none was ever requested. It now
recognises that case directly and offers the one-click route, which is
what the protocol does with it too.

Two conditions the protocol checks were missing entirely: a
governance-wide pause, and, for collateral with no market price, the
risk acknowledgement both parties record when the loan opens. Without
either, the transaction is refused, so the card now says so instead of
offering a button. And because several of the facts behind that button
can change while a lender is reading the confirmation, the app now asks
the chain one last time immediately before sending — which is a better
guarantee than any of the individual checks, since it is the chain's own
answer to the only question that matters.

Three sentences on the card were also more confident than the contract.
It described a state as handled by automated closers, and there are
none — nothing in the codebase submits this particular call, so a lender
told to wait would have waited indefinitely; it now says an operator is
needed and to ask. It named the collateral as what comes back, when the
protocol may instead settle the position against an opposing one and
return what was lent. And it said the loan ends straight away, which is
usually true and not always. Each of those was a sentence about somebody
else's money, on the card whose whole job is explaining how they get
paid.

One smaller correction came with it. The rule that decides which
actions survive a pending change to the Terms did not list this one,
which would have left a lender who had not re-accepted unable to reach
a defaulted borrower's collateral at all — paperwork standing between
somebody and money they are owed by a counterparty who has already
broken the agreement. It is listed now.

A late correction to the close-out card is worth recording because it
contradicted something else written the same day. The card holds itself
back for a moment after a close-out is submitted, so that a page still
showing stale figures cannot invite a second attempt at a loan that has
just ended. The first version of that hold never let go. But closing out
does not always end the loan — the protocol may settle only part of the
position and leave the rest running, which the card's own receipt had
just started saying — so a position that genuinely still needed closing
lost its button permanently. The hold now lasts exactly as long as it
takes for the app to read the position again, after which whatever the
page shows was worked out from what the transaction actually did.

The same hold also had to learn which loan it belonged to. Switching
networks while sitting on a position keeps the page open, so a
close-out submitted on one network could leave the equivalent position
on another looking as though it had already been dealt with.

One further gap, and the least comfortable of them: the protection that
stops a close-out from stranding a half-finished sale of the lender's
own position was reading a value that was never fetched on the lender's
page. It looked correct everywhere it was used and did nothing at all,
on the single screen it existed to protect. It works now.

The last correction went the other way from all the others: the card was
being too cautious rather than too confident. Where a loan's collateral
is ordinary and priced, the card says the sale has to be routed and
offers no button. But before the protocol ever reaches that sale, it
looks for an opposing position it can settle this one against — and when
it finds one, no sale happens and the close-out the app can already
perform succeeds. So a lender was being told to go and find an operator
for a position they could have closed themselves in one transaction.
That case now has its own message and its own button, and it says
plainly that what comes back is the asset lent rather than the
borrower's collateral, because for this route that is what the protocol
returns.

Two more corrections to the card, and both are the same mistake in
different clothes: a sentence that was true of the commonest outcome and
was being shown for all of them.

The first is about the route that settles against an opposing position.
That message warns, correctly, that somebody else may settle against
that position first — and then told the lender the attempt would simply
fail, costing a network fee, with the loan left open to try again. That
is true only when the collateral is ordinary and liquid. Where it is an
NFT, or has no reliable price and both parties recorded their consent,
or has fallen far enough in value, the close-out does not fail at all:
it carries on and hands over the borrower's collateral instead of the
asset that was lent. A lender was being told the worst case was a wasted
fee, on a transaction that could complete and return something entirely
different from what the card had just described. The card now works out
which route the close-out would actually fall to and says that — the
collateral as it stands, the end of a rental, a refusal costing only the
fee, or, where the app could not read enough to tell, plainly that it
cannot tell.

Worth recording how that is decided, because it is the part most likely
to rot. The fallback is not a second copy of the protocol's ordering
written out by hand; it is the same decision this card already makes,
asked again with the opposing position removed. There is one description
of the order things happen in, so the warning cannot drift away from the
behaviour it describes.

The second is the confirmation screen shown before a lender signs. It
described selling collateral and absorbing a shortfall — for every
close-out, including an overdue rental, where none of that happens.
Ending a rental sells nothing, moves nothing belonging to anybody else,
and leaves no shortfall to absorb; what it does is remove the renter's
access and make the prepaid rent claimable. The rental case now has its
own confirmation that says so line by line.

That is the fourth surface to have carried the wrong description of a
rental close-out — the card body, the specification, the change record,
and now the confirmation. The confirmation outlasted the other three
because it does not vary by route: it reads correctly for the majority
case, so each earlier correction went past it. The lesson is that a
screen which does not change is not thereby a screen that is right.

A further review round found five more places where the card spoke for
one route while showing itself on all of them, and one where failing
safe had quietly turned into failing silent. They are worth recording
together because four of the five are the same shape as everything
above: a true sentence, shown where it is not true.

The card said plainly that closing out never moves anything to the
lender's wallet by itself — that what they are owed becomes claimable
afterwards. That is right for every route but one. Where the protocol
settles the position against an opposing one, it pays whoever submitted
the transaction a small incentive, sent directly to that wallet, and
taken out of the same settlement rather than added on top. So a lender
closing out their own position is paid something immediately, and it
comes out of what they would otherwise claim. Both halves of that were
missing, and the card asserted the opposite of the first.

It also said the amount depends on what the collateral is worth. Two
routes have no collateral valuation at all. An overdue rental makes a
fixed, already-paid sum claimable; a settlement against an opposing
position returns the asset that was lent, priced at the moment the
transaction runs. Both are now described as what they are, rather than
sharing a sentence about a valuation neither performs.

The rental confirmation added earlier in this note claimed the lender
gives up the rest of the rental term. There is no rest of the term. A
rental only becomes closable after its term AND the grace period after
it have both expired, and the whole term was paid for up front — so
nothing further could have accrued. That row invented a loss to fill a
space, which on a screen about somebody's money is worse than leaving
the space empty. It now says there is nothing to lose, and says why,
and adds the thing that is actually true: until the close-out runs, the
renter keeps access they are no longer entitled to.

The message shown immediately after submitting said the loan is ending
and pointed at the claims page. Neither is guaranteed. A settlement that
covers only part of the position leaves the rest of the loan running and
nothing claimable yet, which the card had already learned to say
elsewhere and had not learned to say here. It now describes the
transaction as decided while it runs, and sends the lender to the
refreshed position to see which happened.

The last one is different, and is a correction to a fix made earlier in
this same work. The card is deliberately withheld while a sale of the
lender's own position might be half-finished — otherwise a close-out
could strand it. That guard treated an unanswered question as a reason
to remove the card entirely, so a network problem reading that one fact
took away both the action and any explanation of why, for as long as the
problem lasted. Failing safe should mean the button does not work, not
that the page pretends the position has nothing to offer. The card now
stays where it is and says a check is still running — which is what it
does for every other unresolved check, and what it was built to do.

One more of the same kind, found by checking a claim rather than by
being told. In answering the round above I said the card's two remaining
unconditional notes were true on every route. One is not. The note
warning that closing out cancels a borrower's pending swap-to-repay
order describes a facility that covers ordinary-asset loans only — an
overdue rental can never have such an order. The sentence was never
false, since it is conditional and the condition simply never holds; but
it puts a borrower repaying a loan on a screen whose position has a
renter paying rent, which is the same confusion in a quieter voice. It
is no longer shown there.

A smaller repair, on something introduced two rounds earlier rather than
reported by anyone. The warning about another party settling first was
being assembled at display time by gluing three sentences together with
a space. That is correct in most languages and wrong in Japanese and
Chinese, which end a sentence with their own punctuation and put no
space after it — so two of the ten translations carried a stray gap
mid-paragraph. The product already had a rule for this: elsewhere even
the word "and" and a full stop are themselves translated, rather than
written into the layout. The warning now reads as one sentence per
outcome, written that way in each language, so nothing is joined when it
is shown and there is no join character to get wrong.

A later round found four more, and the first is the most consequential
thing in this whole note. The card was asking the wrong question first.
It checked whether the network's sequencer was healthy before it checked
whether the borrower's time was actually up — so a lender looking at a
loan three days into a ninety-day term, during an outage, was told the
close-out was merely paused until the sequencer recovered. That reads as
"this is available, just not right now" about a position the borrower has
most of the term left to save. The protocol asks in the opposite order:
it refuses an early close-out for being early, whatever the network is
doing. The card now asks in the protocol's order.

The order it had was a deliberate choice, aimed at a real problem — the
heading claiming a loan was overdue during an outage. That problem had
already been fixed properly elsewhere, by only letting states that
follow a confirmed answer claim it. Solving it a second time by asking
the questions in the wrong order bought nothing and cost the truthful
answer.

Second, the description of the route that settles against an opposing
position said the loan can be closed out now and left it there. That
position may be smaller than this loan, in which case only part settles
and the rest stays open — which the card had already learned to say
after the fact and not before it. A lender should know that before they
sign, not from a receipt.

Third, the transparency page's freshness line. It draws counters from two
requests and states one age for all of them; the previous fix made it
quote the older of the two. But a response can arrive with no position
marker at all, and the page was then quoting its sibling's — presenting
one set of counters as current through a point the other had reached. A
missing marker is not a weaker claim to be outvoted; it is the absence
of one, and it now disqualifies the combined statement instead.

Fourth, the warning that closing out cancels a borrower's pending
swap-to-repay order was being suppressed using a live measurement of how
tradeable the collateral is. Whether such an order can exist at all was
fixed when the loan opened, not now — so a loan that could still hold one
was having the warning hidden because the collateral had since become
harder to sell. The prediction now rests only on facts that cannot change
for the life of the position.

The last of these is the mirror of a warning added earlier, and it is
slightly embarrassing that it took a separate round to notice. The card
warns, on the route that settles against an opposing position, that
somebody else may settle against it first and what happens then. The same
race runs the other way and was not mentioned at all: the protocol looks
for an opposing position at the moment the transaction executes, not when
the page was loaded, so a loan that read as handing over collateral can
settle as a match instead and repay what was lent. The confirmation
screen had admitted both outcomes for some time; the card body and its
note about collateral value still promised one. Both routes that describe
a collateral outcome now say what can change it — including the one that
offers no button, because its whole message is that an operator must
arrange a sale, and that advice is wrong too if a match has appeared.

A smaller correction alongside it, in the operator notes rather than the
product. The instruction for pointing a self-hosted deployment at its own
public address told the operator to set the value in the example file.
Nothing reads the example file — it is a template. An operator following
it exactly would have got a sitemap and robots file pointing at the
default hosted address while believing they had changed it. The note now
says to copy it to a file that is actually loaded, and lists them.

Finishing that thought properly took a second pass, and the gap it left
is worth recording because it is the same mistake one step down. The
warning about a settlement appearing at the last moment was added to the
two states that describe handing over collateral. There are four states
that name an outcome, not two.

The one that mattered most was the state that says the close-out is
refused for everyone. That sentence is the strongest claim the card
makes — it tells a lender to stop trying and go and ask for help — and it
is not true if a settlement partner turns up, because the protocol looks
for one before it ever reaches the check that refuses these loans. It now
says "as things stand", and carries the same explanation as the others.
An overdue rental was in the same position for the same reason.

The lesson, written down because the round before it had just written
the rule and then broken it: a disclosure that belongs on a route belongs
on every route where the same thing can happen, and "the ones I was
looking at" is not that list.

One structural change came out of all this, and it is the only reason to
expect the pattern to stop. Almost every correction above has the same
shape: a sentence that is true of one situation, shown in a list of
situations somebody wrote out by hand. The rental described as a
collateral transfer, the warning that promised failure, the warning
given in one direction and then on two of the four cases it applies to —
each was a hand-written list, assembled while looking at the two or
three cases in front of whoever wrote it.

The card now decides all of that from a single table with one row per
situation it can be in. A row cannot be left out: the code will not
build until every situation has one, and every column in it is answered
explicitly. Where the old code ended a chain of choices with a default,
a newly added situation would quietly have inherited whatever that
default was — which for the outcome text meant describing itself as a
collateral transfer. That cannot happen now; a new situation stops the
build until somebody decides what it says.

The table earned its keep immediately: adding a column to it produced
build errors on three rows that had been missed, which under the old
shape would have been three more of the findings above.

Two sentences were left standing by an earlier correction rather than
broken by it, which is worth separating from the rest. Admitting that a
settlement against an opposing position may cover only part of a loan
made two neighbouring statements false, and neither was in the sentence
being corrected.

The first told the lender that if somebody else closes the position out
first, it will simply show as closed. Where only part settles, it shows
as smaller instead and carries on. The second said what is owed becomes
claimable once the close-out settles. For a partial settlement it does
not: the protocol holds that portion and it becomes claimable when the
remainder is closed later, which may be considerably later. A lender
told to go and collect would have found nothing there and no explanation
for it.

Both are the same lesson as the rest of this note, one step removed: a
correction changes what is true around it, not only where it lands.

Rather than wait to be told the same thing a third time, the rest of the
card's wording was read against that one fact — that a settlement may
cover only part of a loan, and that the part it covers is held rather
than paid out until the remainder closes. Two more sentences failed.

The general note about collecting, shown on every route except the one
just corrected, still said what was owed became claimable once the
close-out settled. It has the same exception as its sibling and now says
so. And the description of the settle-against-an-opposing-position route
ended by telling the lender to claim whatever settled — the one case
where the settled portion is specifically not claimable yet. That
sentence is gone rather than qualified: the note directly beneath it
already explains the timing, and saying it twice at two different levels
of precision is how they came to disagree in the first place.

The most serious thing found in this whole review came late, and it was
about the transaction rather than the words around it. The card marked a
close-out as submitted only once the network had confirmed it. That
sounds right and is not: confirming can time out, or lose its connection,
on a transaction that has already been accepted and will mine perfectly
well. When that happened the card concluded nothing had been sent, gave
the button back, and a lender pressing it again could have a second
close-out queued behind the first — which either wastes a network fee
arriving at a loan that has just closed, or, where the first settled only
part, runs for real against what is left. The card now records the
attempt the moment the transaction has an identifier, which is the point
at which it stops being safe to assume nothing happened.

That fix was half a fix, and reviewing it found the other half. Recording
the attempt disables the button on the position — but after a failed
confirmation the page is not showing that button, it is showing the open
confirmation panel, and the confirm inside it was not covered. The retry
the whole change was meant to prevent was still one click away, by a
different route. Both are closed now, and the close-out additionally
refuses to start a second time while a first is unaccounted for,
regardless of what the screen is showing.

It took a third pass to get the underlying idea right. The card was
deciding whether a close-out was still outstanding by looking at how
recently it had re-read the loan — which is a fact about the app, not
about the transaction. That reading fails in both directions. One of the
readings behind the card is deliberately slow to refresh, so on a failed
confirmation nothing would refresh it and the action stayed disabled for
a transaction that may simply have been dropped; and if anything did
refresh those readings while the transaction was still in flight, the
action came back with the transaction unresolved, which is the thing
being prevented. The card now follows the transaction itself, and stops
following it after a few minutes if the network never accepted it —
because a lender whose transaction vanished should be able to try again,
and one whose transaction landed no longer has a position for this card
to offer anything about.

Two smaller items alongside it. A live check on the deployed site treated
the Terms notice appearing over a claims, vault, recovery or desk page as
an inconclusive result and told whoever ran it to accept the Terms and try
again. Those four pages are deliberately exempt from that notice, because
they are how somebody gets their money out and paperwork must not stand
in the way. So the notice appearing there is a fault, and the check was
both failing to report it and recommending the exact step that makes it
disappear from the next run. It now fails, and says not to do that.

Following the transaction brought its own correction, and then a
correction to the correction. Waiting for one fresh reading of the loan
before offering the button again is right when the transaction succeeded
— the position has changed, and a button offered against the figures from
before the close-out would be offering something that no longer exists.
It is wrong when the transaction was rejected, or when the wallet
replaced it with a cancellation: nothing happened on the chain, a retry
is reasonable, and neither of those endings triggers the refresh that
would end the wait, so the button could have stayed away for good.

But "we have been waiting a while" is not one of those endings, and
treating it as one was a mistake worth naming. A transaction that has not
confirmed yet has not failed — it can still go through — so re-offering
the button after a few minutes invited a second close-out to queue up
behind a first that was still live, which is exactly the outcome the wait
exists to prevent and the more expensive one. The app now keeps waiting,
and says so: it tells the lender plainly that it has not been able to
account for the transaction, that this does not mean it failed, why the
button is staying off, and to look in their wallet, which is where the
answer actually is. An honest "we don't know yet" is better product than
a button that implies it is safe to try again.

It also follows the transaction properly now. A wallet that speeds up or
cancels a pending send produces a different transaction for the same
slot, and the app was watching only the original — so a sped-up close-out
that went through perfectly looked identical to one that vanished, and a
confirmed cancellation looked the same again. All three now resolve to
what actually happened.

A separate correction to the live checks: when the address of the site to
review was not supplied, every one of them stopped with an unhandled
error, which the batch runner reads as "this check found a defect in the
product". Nothing had been reviewed at all. They now report that the
review could not be started, which is a different verdict with a
different remedy — supply the address and run it again, rather than go
hunting for a bug that was never found.


Two more from the same review pass. The confirmation for the matched
close-out told every lender that the matcher incentive would arrive in
their wallet immediately. That is not true for a wallet the sanctions
oracle has flagged — the protocol runs the close-out for them but does
not pay them that incentive — and such a lender can reach this button by
design, because close-out paths stay open to flagged wallets so the other
side can still be made whole. The card now checks, and says which of the
three cases applies: paid, not paid, or not yet known. The not-paid
wording is careful about where the money goes instead, because "you do
not get it" would overstate the loss: the part that would have come out
of this position simply stays in what the lender claims later, and only
the part from the opposing position goes elsewhere.

And the heading on a loan blocked by a sequencer outage said "if this
loan is not repaid", conditionally, about a loan the chain has already
confirmed is past its repayment window and its grace period. That
hedging was correct once, when the app checked sequencer health before
the repayment window; it stopped being correct when the order was
changed to match the contract, and the sentence explaining it outlived
the ordering it described.

A later pass tightened three more things about that wait, and one of them
matters more than it sounds. Waiting for the position to refresh before
offering the button again was measured from when the transaction was
sent, and that is the wrong moment: anything can refresh the page's
readings in between — another card, switching back to the window, an
ordinary poll — and those readings still describe the loan as it was
before the close-out. On a slow transaction the wait was therefore
already satisfied when the close-out landed, and the button came back
immediately over figures from before it. It is now measured from when
the app learned the transaction's outcome, which is the earliest moment
anything could have changed.

The second: if a completely unrelated transaction takes the same slot in
the queue, ours can never run — and the app was reading that other
transaction's outcome as though it were ours, so an unrelated success
was reported as a successful close-out. It now uses the same shared piece
of the app that every other transaction goes through, which already knew
the difference between our transaction sped up (still ours, read its
result), cancelled (ours never ran), and displaced by something else
(ours never ran either).

The third: switching networks while a close-out was in flight threw away
the only record of it. Switching back left the app no longer watching a
transaction that could still land, with the button offered again over the
top of it. Submissions are now remembered per network and per position,
so switching away and back finds what was left running.

Separately, a lender whose deployment has internal matching switched off
is told a match might still appear, which on that deployment it cannot.
The app has no way to read that setting today — the protocol does not
publish it — so this is recorded as its own piece of work rather than
guessed at.

Remembering the in-flight close-out turned out to need more than
remembering it per network. The record lived only as long as the page
did, so reloading, or moving away from the position and back, lost it
just as completely — and reloading is the more likely of the two. It is
now kept on the device the same way the app already remembers a sale
listing or a recovery it has just broadcast, and cleared once the
transaction's outcome is known.

Two smaller corrections in the same area. The app stops and restarts its
watch on the transaction; it used to wait three minutes before starting
the next one, and a wallet that sped up or cancelled inside that gap
could leave the app permanently unable to work out what happened —
holding the button off while telling the lender it was still watching. It
restarts immediately now. And if the app lost the connection while the
transaction was still going, it never refreshed the position afterwards
even once it worked out the close-out had succeeded; on a part-settled
loan that left the remaining part locked with the answer already known.
Working out the outcome now refreshes the position by itself.

Keeping the record across a reload closed one hole and opened a smaller
one, which is worth describing because the fix is a choice about honesty
rather than about mechanism. The old wording told a lender whose
transaction could not be accounted for to check their wallet and reload
the page — and that used to work, by accident, because reloading threw
the record away. Now that the record survives, reloading changes nothing,
and somebody whose transaction had genuinely vanished would have found
the app refusing to let them close that position, permanently, over
something it has no way of checking.

The app cannot see anyone's wallet, so it now asks the person who can. It
says plainly that it keeps watching across a reload, and offers the
lender a way to state that their wallet no longer shows the transaction —
which stops the wait and returns the action. It is worded as their
statement rather than as a reset button, and it says what it costs if
they are wrong, because pretending the button performs a check would be
the same false confidence in a new place.

One more way of not knowing about a close-out, found by looking for it
rather than by hitting it: the same position open in two browser tabs.
The tab that sends remembers it; the other tab had nothing to notice, so
it would have gone on offering the button over a transaction already on
its way. Tabs now tell each other, in both directions — one that learns
of a close-out stops offering the action, and one that learns the record
has been cleared stops waiting.

Telling tabs about each other closed most of that gap and not all of it.
A confirmation already open in a second tab passes its check, then waits
on a pending question and a final check with the protocol before the
wallet opens — seconds during which the first tab can send. The app now
re-reads its own record in the last moment before handing anything to the
wallet, and stops there if a close-out has already gone out from this
browser, saying so rather than implying the position is closed. Two tabs
pressing in the same instant remains possible; the browser offers nothing
that would settle that, and the app does not claim otherwise.

The watch on a submitted close-out no longer stops at all. It had a
three-minute limit, and recognising a transaction that was sped up or
cancelled depends on the original still being in flight — so the limit
was quietly the difference between telling a lender their close-out was
cancelled and never being able to say. The limit now governs only what
the card says: after a few minutes it stops describing an ordinary pause
and states that it cannot account for the transaction, while the same
watch carries on. The app's note of a submitted close-out is also kept
until the position on screen has caught up with it, rather than being
dropped the moment a receipt arrives — in that window a reload used to
find nothing and offer the button again.

Where the browser refuses to store that note at all — private mode, or
storage switched off — the card now says so and names the consequence:
this page still holds the action back, a reload will not. And erasing
your data from the "Your data" page now says the thing it could not
previously: a transaction already sent to the blockchain keeps going, so
what the erasure removes is the app's note of it, after which the app
stops following it and may offer the same action again.

One claim has been withdrawn. An overdue NFT rental carried a warning
that someone might settle it against an opposing position first. The
protocol has no path that does that for a rental — its search for a
counterparty requires the rented item to carry a market price, and its
settlement moves fungible assets only — so the card was describing an
outcome that cannot happen, on the one card whose job is being exact
about what the lender receives.

On the two public pages: a counter that arrives but cannot be a count —
negative, fractional, or not a number at all — is no longer printed as
though it were one. It is withheld like an absent figure, but labelled
differently, because "the source sent something impossible" and "the
source sent nothing" are different facts and a reader checking the source
is owed the difference. The protocol console also refreshes while it is
open; it used to keep whatever it loaded with, so a fee or a switch
changed by governance could sit there superseded, with the page's own age
line saying nothing was wrong.

One more way the app could have trapped a lender, found in review rather
than in the wild. When a close-out is sent and then never resolves, the
only way back to the action is the lender telling the app their wallet no
longer shows the transaction — and the app offered that only after a few
minutes had passed, measured against the device's own clock. A clock
corrected backwards after sending, or a record written while the clock
was wrong, made that wait never finish: the position would have stayed
unclosable from the app for as long as the error lasted, with no route
out. The wait is now measured so that no clock change can stall it.

The same lesson applied a second time, in the other direction. After a
close-out succeeds, the card keeps the action back until the position on
screen has caught up — and it decided "caught up" by comparing
timestamps. A device clock corrected backwards in that window makes a
reading that has just been refreshed look older than the event it
followed, so the card would have gone on withholding the action on a
position that was still part-open, until the lender happened to reload.
It now waits for the refresh it asked for to finish, which is the thing
it actually wanted to know and which no clock can misreport.

Two tabs again, and the correction is to something this note claimed
earlier. When one tab finishes with a close-out it forgets its local
note of it, and the other tab was taking that as permission to forget
too — which put the action back in front of a lender whose own page had
not yet caught up. The earlier reasoning was that a last-moment check
with the protocol would catch anything wrong here. It would not: after a
close-out settles only part of a position the rest stays genuinely open,
so that check passes, and what is stale is not the action but the
description of what it will pay out. A tab now waits for its own figures
to refresh before it stops holding, regardless of what another tab has
decided about its own transaction.

On the analytics page: a loan whose lending asset was never recorded is
now left out of the by-type subtotals whichever placeholder the record
carries. One older placeholder was slipping through and being published
as an ERC-20 loan, which is worse than the gap it hid — the subtotals
then added up, so the page's own "we could not classify these" line read
zero and the disagreement it exists to expose was invisible.

The card now says which way a close-out failed. When the blockchain
rejects the call, or the wallet cancels it, or another transaction from
the same wallet takes its place, the position is untouched and the
action becomes available again — and until now that is all a lender saw:
an unchanged screen with the button back. Three short sentences say which
of the three happened, because all three leave the loan alone but only
one of them is likely to repeat.

Behind that, the way the card decides its figures have caught up after a
successful close-out has been rebuilt. It used to wait on a refresh
request and treat that request finishing as proof; a second refresh of
the same data cancels the first, and a cancelled request finishes in a
way indistinguishable from a successful one. The card now watches for
the readings themselves to change, which nothing else can fake, and it
tracks each close-out separately so a late answer about an earlier one
cannot lock the action on a position that is live now.

Two smaller corrections. The protocol console, when it knows its figures
have been superseded by a governance change, used to send readers to the
parameter reference for what is in force now. That reference reads the
same superseded snapshot and otherwise falls back to the values the
protocol launched with, so it could state the original numbers with
confidence at exactly the moment the console had established they were
wrong. It now points at the chain itself for current values, and
describes the reference as what it is: the place to learn what each
setting means and where it started.

And the forced-close card's newly rebuilt "have my figures caught up"
check was watching some readings that were never going to be refreshed —
including one the app deliberately switches off until it knows what the
collateral is. Waiting on those would have kept the action withheld for
several minutes after everything relevant had finished.

That same "have my figures caught up" check had one more gap, and it was
the one that mattered most. A reading that was already on its way when
the close-out confirmed was sent against the loan as it stood beforehand
— and the app was counting it as proof the figures had caught up. So the
action could come back over numbers that predate the transaction, which
is the exact thing the wait exists to prevent, and it would do so sooner
than any of the earlier fixes could catch. The card now abandons every
reading outstanding at the moment the outcome arrives, and waits only on
ones it started afterwards.

The card also used to disappear entirely while the app was still reading
whether the loan is open. That is the one reading that had not happened
yet, and removing the card is the strongest thing the surface can say —
it tells a lender the capability does not apply to their position. A
slow or failing read left them with no card, no explanation and nothing
to wait for. The card now stays on screen in its "a check is running"
state until the protocol has actually answered.

The public analytics page and the protocol console now print their
numbers in the language the reader chose, rather than the one their
device is configured in. The two disagree often — the digit grouping and
decimal mark differ between them — and the result was a page whose prose
followed one convention and whose figures followed another, with nothing
to say which was intended.

Finally, the protocol console no longer throws away a reading that
arrives without any parameter values in it. A deployment answering and
publishing nothing is a different fact from a deployment we have not
heard from, and only the second is a reason to stop asking. The console
keeps the reading, still reports when it was taken, and says plainly
that the values themselves did not arrive.

Two follow-ons to the changes just described, both found by reading the
result rather than the intent.

The first is about readings the app decides not to wait for. A close-out
can leave a loan in a state that pauses these checks, and the borrower
can undo that state — at which point the checks resume with whatever
they last held, which is a picture of the loan from before the close-out
ran. Skipping them was right; leaving them where they could come back
was not. They are now discarded, so a resumed check starts from nothing,
says it is still running, and offers no action until it has an answer of
its own — and the discard reaches whatever is displaying the value, so
the old figure leaves the screen at that moment rather than whenever
something else happens to redraw the page.

The second is a promise the console was making and not keeping. When a
reading arrives with no parameter values in it, the page says the
provenance below — which source, which block, how long ago — is still
accurate. It was printed inside the same block that hides the values, so
there was nothing below. It now sits outside, where the sentence says it
is.

And the language-formatting change went one placeholder deep where it
needed to go all the way. A line reading "2% (200 bps)" was formatting
the percentage for the reader's language and leaving the bracketed
figure beside it in the device's — one line, two conventions. Every
figure now follows the chosen language. The VPFI tier threshold takes a
slightly different route, because it is a number a reader is invited to
check against the chain digit by digit: formatting it the ordinary way
would round it in the process, so it is formatted without that
conversion, and where a browser cannot do so it is shown unformatted
rather than shortened. Losing the separators a reader expects is a
cosmetic problem; losing a digit of the figure they came to verify is
not.
<!-- assembled-fragment: lender-forced-close-out.md sha256=71f6c991146cb8f7f9443c072cdda44ebe458fcbf1d8b0c5b6b9983a09b6fa91 -->
