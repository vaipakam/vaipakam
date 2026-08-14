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
twenty-three files, against the thirty-one the first version tracked. Most of the newly visible text is legitimate, but some of it is not,
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
