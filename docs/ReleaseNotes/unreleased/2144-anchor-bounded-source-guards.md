## Thread — The drive's source guards are bounded by meaning, not by character count (PR #TBD)

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
every time. So these checks no longer read the file as text. They parse
it, the way the language itself does, and every region is a piece of the
parse rather than a stretch of characters. Quotes, comments, patterns and
the punctuation that means two different things stop being special cases
to remember.

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
Anything else is treated as a length and has to say what it counts. A new
way of hiding a number cannot be invented, because there is nothing left
to evade: unrecognised is refused.

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

Putting a removed window back, in any of the fifty disguises review has
demonstrated, turns the suite red.

Three of the windows survived the earlier passes for a reason worth
naming: they bounded a declaration spread over several lines, which is
neither a block nor a call, so there was nothing to convert them to. That
missing bound now exists — a region may be taken as the statement it
belongs to, ending where that statement ends.

The effect is that these checks now fail when the thing they describe
changes, and not when the file grows. A check that fails because a file
got longer teaches nothing, and trains the next reader to widen the
number rather than ask what it was supposed to bound.

Closes #2144. No product surface changes.
