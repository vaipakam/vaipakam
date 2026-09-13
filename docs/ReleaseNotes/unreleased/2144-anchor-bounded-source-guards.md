## Thread — The drive's source guards are bounded by meaning, not by character count (PR #2170)

Parts of the drive that reviews the deployed build cannot be run from a
unit test, because importing the file runs the whole drive. Those parts
are checked by reading the drive's own source instead, and each such
check needs a region of that source to reason about. Several still took
their region as a fixed number of characters from a starting point, which
is wrong in both directions and moves with edits that have nothing to do
with the rule being checked. Too short, and the check is blind to the end
of the region while looking exact: one such check counted the assignments
recording an outcome, found two where there are three, and asserted that
count as exact, so deleting the very line it exists to protect would have
left it passing. Too long, and a rule about one region silently starts
matching its neighbours.

Every such region is now bounded by something that means the region has
ended — the statement it belongs to, the block it opens, or a named
landmark in the code that follows it. The helpers refuse to return
anything when a landmark is missing, or when the closing one does not
follow the opening one; that last case would otherwise hand back an empty
region, and a rule asserted over nothing passes by checking nothing,
which is the failure this whole family exists to refuse.

Review caught the same mistake three times, and the third time is what
changed the approach. Each attempt established that the conversion was
complete using something that read the file as plain text, and each
reader was narrower than what it was looking for. The first missed
several windows because it insisted they start a particular way. The
second could not see a window written across four lines, because it
stopped at the first closing bracket it met. The third, a hand-written
reader of its own, missed a bound hidden behind a comment, a bound
written as text rather than as a number, and a bound given a name — and
quietly skipped any call whose brackets it could not pair up, so ordinary
formatting was enough to slip past it.

Each fix was correct and the next gap was already waiting, because
"where does this piece of code end" is a question the language's own
grammar answers, and a reader assembled by hand is a worse answer to it
every time. So the boundaries are no longer found by reading characters.
The file is parsed, the way the language itself does, and a region that
is a piece of the grammar — a statement, a block, a call — is taken as
that piece. Quotes, comments, patterns and the punctuation that means two
different things stop being special cases to remember.

One kind of region is deliberately still located by text, and saying
otherwise would have been the overclaim this note is about. Some regions
are not a piece of the grammar at all — a declaration and the few lines
that belong with it — so there is no piece to ask for, and they are
bounded by naming a landmark in the code instead. Those landmarks are
matched against the file's text, with one protection: a landmark is
never matched inside a comment, because these files quote code in prose
constantly and a mention in a comment was moving a boundary. A landmark
that appears inside a string is still matched, and that is on purpose —
a string in the code under test is code, and one of these landmarks is a
message the program actually prints.

That also fixed a fault the hand-written reader had been shipping: a
declaration containing a search pattern was cut in half, and one
containing an unbalanced bracket was reported as having no end at all —
the same silent truncation this whole effort exists to remove, produced
by the tool meant to remove it.

The completeness claim is now made by the suite rather than in prose, and
it is made the safe way round: rather than working out which values hold
source code and checking only those — a question with no bounded answer,
and every gap in it a hiding place — it checks every such bound in the
family, and the handful that legitimately count characters say so in a
short note at their own declaration, naming what they count. Nine of
those became three notes, because saying it once per reason is also how
a fourth gets noticed. A note covers the one declaration it sits above
and nothing else; an earlier version covered whatever happened to follow
within a few lines, which would have let a fixed window inherit a pass by
being written next to a legitimate count.

Deciding whether a bound is a count, rather than a landmark, is also
asked of the value a name is given, and of the value that name is given
in turn. Review found those being answered by two separate pieces of
code, of which the weaker looked only at the surface of a definition — so
a length that had been given a name, or worked out by arithmetic, or
handed on through a second name, read as a landmark. There is one answer
to it now, used in both places, because it was always one question.

A further round found the rule drawn slightly wrong in both directions at
once, which is the useful kind of finding. It was too narrow in four
places — it recognised one of the three standard ways to shorten a piece
of text and not the other two, it did not see a length supplied as a
default value or declared inside a branch of a multi-way choice, and the
note excusing a legitimate count could be faked by an ordinary piece of
text that merely contained the words. And it was too wide in one: a
landmark that happened to mention a number was being read as a length,
which would have forced apologetic notes onto perfectly correct code.
That last one matters most. A check that complains about correct work
does not get obeyed, it gets switched off.

The same round found a region in the existing checks bounded by a
sentence rather than by code. These files quote code in prose constantly
— naming the thing a rule is about, the call a fix replaced — and one
check had been ending its region at a mention inside a comment rather
than at the code it meant to stop before. A landmark is now required to
be code, and that check is re-anchored. Notes in the margin that mention
a landmark no longer move it.

A sixth round settled how the check should be phrased, and that is the
part worth recording. Every round so far had answered the same question —
"could this length be a fixed number?" — and every round had found
another way of writing one that the check did not know about: spelled as
text, given a name, handed on through a second name, worked out by
arithmetic, supplied as a default, declared inside a branch, produced by
a function defined and called on the spot, assigned after the fact, or
buried in a pattern that unpacks an argument. There is no end to that
list. Every way of writing a number is an open-ended thing, and a check
whose correctness depends on having listed all of them is wrong without
knowing it.

So the question is asked the other way round now. Rather than trying to
recognise a length, the check recognises a LANDMARK — a search for text,
a small helper that performs one, a name holding the result, the measured
length of the thing searched for, and simple combinations of those. That
list is short and closed, because it is what these checks actually write.
Anything else is treated as a length and has to say what it counts.
Unrecognised is refused, so no new way of SPELLING a number gets in by
being one the check had not met.

That is a real result and it is narrower than it first reads, which is
worth stating plainly rather than leaving to be discovered. Closing the
set of spellings does not close the set of ways a shape the check DOES
recognise can turn out not to be a landmark after all. A search reads as
a landmark, but the check does not yet establish that it searches the
same text being narrowed — so a search through some unrelated string can
carry a fixed count through in good standing. A name holding a search
reads as a landmark even where the thing it names was never set, because
control left the block before the line that sets it. And a stand-in
object that only looks like a searchable thing is caught when it is
written out plainly and not when it is chosen between two of them.

None of these is a way of writing a number; each is a way for a
recognised landmark to be hollow. They are recorded as open work rather
than described as closed, because a check that overstates what it
guarantees is the same failure as a window that overstates what it
bounds.

Measured before adopting it: phrased this way the check objects to
exactly the three places that genuinely do count characters, and to
nothing else. Its remaining cost is written down rather than glossed — a
landmark handed into a helper as an argument is unknown to it, and the
answer to a case like that is to teach it the shape, never to attach an
apologetic note to correct code. A note asserts that something really
does count characters, and putting one on correct work is a falsehood the
next reader inherits.

A seventh round is worth recording because the findings changed
character. They stopped being "here is another way to write a number the
check has not met" and became "the things you call landmarks include
several that are not" — which is a question about a short list I control
rather than about an open-ended one I cannot finish. That is the evidence
the change of phrasing did what it was meant to.

The substantial one is that a place and a distance had been treated as
the same thing. The gap BETWEEN two landmarks is a width, and using a
width to say where a region ends is the fixed length again, arrived at by
subtraction instead of typed out. So the check now keeps places and
distances apart, and knows which combinations mean anything: a place plus
or minus a distance is a place, one place minus another is a distance,
and two places do not add. A measured width on its own measures something
and points at nothing, so it can no longer end a region.

The rest were things that merely looked like landmarks: an object with a
search-shaped method that returns a fixed number, an object with a
length-shaped field that does the same, a name that holds a landmark when
it is declared and is overwritten afterwards, a helper that returns a
landmark on one path and nothing on the other, and a collection of
landmarks handed over where one was expected.

Two of these were live rather than hypothetical. One check bounded a
region with no end at all, so its rule about the order of two things could
have been satisfied by matching text anywhere further down the file; it is
re-bounded on the block it is actually about. And a check whose region
legitimately runs to the end of an already-bounded piece of text is
recognised as such, rather than being asked to invent an ending it does
not need.

The notes that excuse a genuine count were tightened twice more. One note
above a line declaring two names was excusing both, though it can only be
about one, so a line declaring more than one name is no longer excusable.
And a note now has to be a stated reason rather than a mention: the words
alone, or a sentence saying never to use them, no longer count.

An eighth round kept narrowing the same short list, and two of its
findings were the more valuable kind: places where the check objected to
correct work. A region that starts at the very beginning of the text was
being told to apologise for counting characters, when the beginning of a
text is a place like any other. And a name used as a landmark was being
rejected because somewhere else entirely, in an unrelated piece of code,
a different thing of the same name was changed. Both are now right. A
check that complains about correct work does not get obeyed; it gets
switched off, and then it protects nothing.

The rest were the remaining ways to look like a landmark without being
one: a name overwritten by unpacking rather than by a plain assignment, a
collection's count of landmarks mistaken for one of them, a landmark set
up inside a branch that may not have run, and a value that looks fixed
until a caller supplies a different one. Two were ways of writing the
same truncation that the check simply was not looking at, and one was a
helper trusted by its name where a locally defined thing of the same name
could have returned anything.

The oldest habit in this work surfaced once more: a region whose starting
landmark was matched inside a comment rather than in the code. That had
been fixed for one kind of boundary three rounds earlier and not for the
others, and parsing had made it worse rather than better — the earlier
hand-written version would usually have run off the end and complained,
where the parser hands back a plausible, complete, wrong region.

A ninth round found three, down from fourteen, and all three concerned
the one place the check reads a landmark out of a list. A position in
that list has to be a whole number counting from the front, since
anything else picks out nothing at all and the region then runs to the
end of the text. And a list that is changed after it is built no longer
says what it said, whether by replacing an entry or adding one — though
merely reading it changes nothing, and an early version of this treated
every use as a change and rejected regions the checks legitimately take.

The third was an old kind of name that can be declared twice, where the
second declaration quietly replaces the first rather than making a new
one. Resolving it where it is written rather than where it belongs had
made those look like two separate things.

A tenth round found six more, and two were again the check objecting to
correct work: a landmark stored in an old-style name declared plainly at
the top of a function, which always runs before it is used; and a list
changed *after* the region was already taken, which cannot affect
something that has already happened. Both are accepted now, and the
cases that genuinely are unsafe — a landmark set up inside a branch, or
one set up after the fact, or a list changed before the region is taken —
still are not.

The other four were the list rule again and a receiver taken on trust: a
position past the end of the list, a position written in a way that looks
like a number without being one, an entry stepped up in place, and a
thing that merely has a search-shaped method. The check now resolves the
list and confirms the entry is really there, and confirms a receiver is
not something written out in the file with a method of the right name.

One process note, because it is the more useful lesson. I read that round
as clean and began merging. It was not: the findings were on the second
page of a paginated list and my check read only the first. Nothing
merged, but only because a rule about resolving conversations stopped it,
not because my own check caught the mistake.

An eleventh round produced the decision this note should end on: one
capability was **removed** rather than fixed again.

The check had learned, early on, to recognise a landmark picked out of a
list. That was added to avoid complaining about a shape review raised in
passing — and that shape appears nowhere in this work. Keeping it honest
then took three rounds: the position in the list had to be proved real,
the list proved unchanged, a change proved able to reach the use, the
ways of spelling a change all recognised, and the list followed through
second names for it. What was still open after all that needed the kind
of whole-program reasoning this work has four times declined to attempt,
on the grounds that a half-version of it states confident conclusions it
has not earned.

A capability with no user, whose correctness bill has no ceiling, is not
worth the surface it presents. So it is gone, and a bound of that shape
is simply reported like anything else the check does not recognise. If a
real one ever appears, it can be recognised then, deliberately, with its
own reasoning written down. Removing it also retired a second rule that
existed only to serve it, and that the same round showed could not be
made sound either.

That is the opposite of the reflex this whole effort has been fighting.
The easy move was a sixth patch to a feature nobody uses; the honest one
was to stop carrying it.

Putting a removed window back, in any of the disguises review has
demonstrated, turns the suite red — each one written down as its own
case, and each rule that ACCEPTS something written down beside it, so
neither half can quietly rot into the other.

No count is given for that list, on purpose. An earlier draft of this
note asserted one, and a careful recount could not reproduce it: the
obvious way to tally the cases mixes the ones that must be refused with
the ones that must be allowed. Twice already in this work a number has
been stated on the strength of a check narrower than the thing it
counted. The honest version is the list itself, which anyone can read.

Four further rounds narrowed the same short list, and the last of them
ended the way the parsing round did — by replacing something written by
hand with the thing that already exists to do it properly.

The remaining findings had almost all stopped being about lengths and
become about NAMES: what a name means at the place it is used. Answering
that had quietly grown its own hand-written machinery — which shapes
introduce a new scope, which spellings declare a name, which declarations
are hoisted to the top of the piece of code they sit in, what counts as
changing a name. Nine rounds each added one more shape to that list: a
name taken apart from a larger value, a name declared inside one branch
of a multi-way choice, a name given a fallback value, an older kind of
name that floats to the top, a name introduced by a class, a name a
function or a class gives only to itself, the same name declared twice, a
name declared and published in one breath, and a name brought in from
another file.

That is the open set again, wearing different clothes. "What does this
name mean here" is written down in the specification of the language and
implemented by a well-used component that does nothing else. So the
question is asked of that component now, and about a hundred and eighty
lines of language rules re-implemented by hand are gone. Only the two
questions it does not answer stay local — whether a definition definitely
runs on the way to the use, and whether a change to a name could reach
it — and both refuse when the order cannot be known rather than assume
the convenient answer.

Two other fixes in the same stretch are worth recording because they are
the kind that keeps the check honest rather than merely stricter. Order
means something only when both ends of the comparison sit in
straight-line code: a region taken inside a function runs whenever that
function is called, so a change written below it may still happen first.
And a value set up inside a class's own fields runs when an object is
made rather than where it is written — unless it belongs to the class
itself, which does run in place, so that case is accepted rather than
refused. A check that objects to correct work gets switched off.

One boundary was still located by reading text where the grammar could
have answered: a piece of text borrowed from another and then measured
was slipping past the collector, and so was a header written inside the
gap of a piece of assembled text, which is code and was being skipped as
though it were quotation.

A further round is the one that shows the effort has turned a corner, and
it is worth recording for that rather than for its fixes. Four of its
five findings were the check REFUSING CORRECT WORK — the direction that
matters most, because a check which complains about correct code does not
get obeyed, it gets switched off. The refusing side has become tight
enough that the remaining work is loosening it where it is too tight.

Three of those four were the same mistake wearing different syntax, and
naming it is the fix. A rule was being stated about a whole piece of
code, when only PART of that piece is uncertain. The body of a loop that
always runs at least once is not uncertain, though the loop repeats. The
name of a value stored on an object is worked out when the object's
shape is written down, though the value itself waits until the object is
made. The test of a loop runs at least once, though its body may not. In
each case the rule was right about one part and wrong about the other,
and wrong in the direction that refuses.

So the rules no longer name a piece of code. They name the PART of it
that is uncertain, and everything not named is ordinary code in ordinary
order. What is left out of those lists carries as much weight as what is
in them, and is written down beside them: the setting-up step of a loop
always runs, the clean-up step after a guarded attempt always runs, and
the kind of loop that checks its condition afterwards appears in neither
list, because it is guaranteed a first pass.

This is the same correction as the earlier one about assembled text, one
level up. A piece of assembled text is not quotation or code — its fixed
parts are quotation and its gaps are code. A piece of code is not
skipped or run — its parts are.

The fifth finding went the other way and was the cheapest kind of evasion
to fix: the check confirmed a helper came from this very file by looking
at the END of the file name it was imported from, so a file whose name
merely ENDED that way was trusted. A test could write one, have it hand
back the whole unbounded text, and pass. The name now has to be the whole
final part of the path.

Two smaller ones round it out, both again the refusing direction: bounds
handed to a borrowed operation inside a list were being read as one
unreadable thing rather than as the two bounds they are, and text brought
in from another file was being refused outright on the grounds that
imports cannot hold text — which is untrue, and contradicted a limit this
same file states two screens further down.

The next round confirmed the shift and sharpened the same idea. Naming
the uncertain part rather than the whole construct was right, but the
question asked about that part was still being asked about the whole: it
checked whether the use sat anywhere inside the construct, when what
matters is whether it sits on the SAME uncertain path. Something set up
in one branch and used in the other passed that test, and the value would
not have been set at all. The question is now asked of the part, which is
also what makes a value set earlier in the same branch, or earlier in the
same arm of a multi-way choice, correctly accepted.

That round also found the one case where a value stored on the thing
itself, rather than on each copy of it, is NOT in ordinary order. All the
names worked out when a shape is written down are worked out before any
of those stored values are, so a name computed further down can supply
something a stored value further up reads. Text order and running order
genuinely differ there, and the check now knows it.

The oldest habit in this work reappeared once more, and it is the one
worth ending on: two readers of the same question. A reader of "which
property is this" existed twice — one that could decode a name written
indirectly and one that refused to look at any — so a truncation spelled
with an indirect name was invisible to one and misread by the other, and
slipped past both. That is precisely the fault of the round that had two
answers to "is this a length", and of the round that had two answers to
"what does this name mean". There is one reader now.

Two smaller ones, both again the refusing direction: a truncation takes
at most two bounds and anything after is ignored by the language, but the
check was reading the ignored one as a length; and a note excusing a
genuine count, written above a small helper, was excusing every
truncation in that helper rather than the one it describes — the same
one-reason-many-bounds fault found earlier on a line declaring several
names, a scope wider. A note above a helper now excuses it only when
there is exactly one thing in it to be about.

A later round is worth recording for what it says about fixing things one
shape at a time. Half its findings were holes in the two rounds before
it — each of those a fix that was right about the case in front of it and
silent about the case beside it. A note excusing a genuine count, written
above a name, was made to cover only one truncation when the name held a
function; it still covered two when the name held anything else. That
same rule has now been stated four times, at four scopes, and only the
fourth states it plainly: one reason excuses one bound, wherever the two
sit.

The others follow the same pattern. A borrowed truncation whose method
name cannot be read was dropped, where the ordinary path has inspected
such a call for many rounds on the principle that a call nobody can name
is not a reason to stop looking. A truncation borrowed through the
language's own reflection helper was invisible because the thing it
borrows sits in an argument rather than on the call. And a region taken
from a named landmark would quietly take the NEXT block in the file when
the named one opened no block at all — which is the silent-wrong-region
failure this whole effort exists to refuse, produced by the helper meant
to refuse it. It now says so instead.

Two more were the check objecting to correct work: a value set inside a
branch went on poisoning a name that a later, unconditional setting
provably replaces; and a region chosen between two already-bounded
regions was called unbounded, when either choice has a meaningful end.

Three of the windows survived the earlier passes for a reason worth
naming: they bounded a declaration spread over several lines, which is
neither a block nor a call, so there was nothing to convert them to. That
missing bound now exists — a region may be taken as the statement it
belongs to, ending where that statement ends.

The last round is the one that names the shape of the whole effort. Two
of its findings were, again, the check objecting to correct work — a
choice between two already-bounded regions was accepted when written one
way and refused when written another, and an ordinary local function
handed to the language's reflection helper was reported as a truncation
it plainly is not. That second one had two readers answering the same
question about the same call, and the one that did not own the shape gave
the worse answer; whoever owns a shape now owns its answer.

One finding was the check trusting something it should not have. A
wrapper around a piece of text uses the built-in search, so it had been
exempted — but a wrapper is an ordinary object whose search can simply be
replaced, and replacing it is a change to a property, which no check on
the NAME can see. The exemption now depends on how the wrapper is used
rather than on how it was made: read through it and nothing else, or it
is not trusted.

The last one was a defect this effort introduced one round earlier. A
search had been widened to consider every occurrence of what it is
looking for, which was right; on an EMPTY thing to look for, every
position is an occurrence and the search never moves past the end, so
the call did not fail — it hung. The helper it grew out of has rejected
an empty landmark since it was written. This one now does too. It is a
fair record of the loop: most of what the review found in the late
rounds was over-strictness, but not all of it, and the one that was not
would have been a test suite that stops rather than a test that reports.

Two corrections after that are worth recording because both were holes
the round before them had opened, and both were in the direction that
matters. A list of values whose identity can be read off the page
included things built with `new`, on the reasoning that a thing written
out plainly is plainly what it is. That is true of a piece of text or an
object written out and false of a construction, because a constructor is
allowed to hand back something else entirely — so a narrowing borrowed
through one was not merely misjudged, it was invisible. And the rule that
a wrapper is trusted only if nobody has touched it was implemented by
looking at the first thing done to the name rather than the whole of it,
so reaching one property further along replaced the finder without the
check noticing.

The second of those is the more instructive. The rule was stated as
"list what may be done with this and refuse the rest", which is the shape
that has held up everywhere else here — and then it was implemented
against a prefix of what was being done rather than the whole of it. The
principle was right and the reading was short. A guard that misses a real
window is worse than one that objects to a good one, so both were fixed
even though the review loop had reached its agreed limit; a limit on how
long to keep polishing is not permission to ship a hole opened on the way
there.

The effect is that these checks now fail when the thing they describe
changes, and not when the file grows. A check that fails because a file
got longer teaches nothing, and trains the next reader to widen the
number rather than ask what it was supposed to bound.

Closes #2144. No product surface changes.
