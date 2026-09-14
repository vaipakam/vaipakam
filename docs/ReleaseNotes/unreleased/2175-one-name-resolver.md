# One answer to "what does this name hold, and can I trust it here"

The checks that keep the live drives' source regions honest repeatedly
need to know what a name stands for. Seven separate rules were working
that out independently — each asking the same underlying question, each
deciding for itself what a missing answer meant, and each expressing "I
could not tell" in its own way.

Two things followed from that, and both were found by review rather than
by reasoning about it.

A rule added to one of the seven was absent from the other six. Unpacking
a name from a pattern is not the same as naming a value, and one copy had
known that for several rounds while the rest did not — so a bound taken
apart from a search result read as though it were the search itself, and
a region that does not exist at runtime was certified.

And "I could not follow this" kept being read as "this is harmless".
Those are opposite answers, and while they shared one blank response,
which one a caller got depended on where the blank arrived from.

There are three answers now, and they are different questions. The name
stands for something, and here it is. The name has a binding, and what it
holds at this point cannot be trusted — it was written to earlier, or
unpacked from a pattern, or declared in a branch that may not have run,
or defined in terms of itself. Or the name has no binding here at all,
which means it belongs to another file or to the language itself.

That third answer is not a kind of failure, and separating it out is half
the point. A built-in is unbound and perfectly well understood; a local
whose value cannot be followed is unknown and must be refused. Keeping
them in one bucket had made a built-in look unreadable, and could as
easily have made an unreadable local look like a built-in.

Callers still decide what each answer means for their own question, and
two of them deliberately disagree: a name from elsewhere is taken as text
when it is being searched for, and is not taken as a bounded region when
something is being cut from it. Both are right, and neither could be
stated while the two situations shared one response.

Making the states visible immediately showed one caller answering
permissively: a receiver whose value could not be determined was being
trusted, when the whole purpose of that rule is to catch a stand-in
pretending to be text. Two kinds of name are exempt, and both for the
same reason: a plain parameter, whose value arrives from whoever called
the function, and an imported name, whose value belongs to another file.
Neither can be read here, and both are how these drives are ordinarily
handed their source. Everything else whose value cannot be determined is
now refused.

That exemption was first written by matching on the REASON the lookup
failed, and review caught it immediately — which is worth recording,
because it is the same mistake in miniature that the whole change exists
to remove. Several quite different situations shared one reason with a
plain parameter: one that supplies its own value when the caller omits
it, one that collects the remaining arguments into a list, one taken
apart from a pattern, and one defined inside a branch that may never have
run. All four inherited the exemption. The rule now asks the binding a
question of fact — does this value arrive from outside this file — which
is true of a plain parameter and of an import and of none of the four.

One more limit on that exemption followed, and it is the kind worth
stating: it describes a value the check CANNOT SEE. Where a helper is
called with the value in plain view — handed an object that merely has a
search-shaped property — the exemption had been vouching for exactly what
the check exists to catch. So a call whose argument is visibly not text
is refused, whatever the helper's body would have said. Working out what
each parameter holds at each call is a larger analysis and is not
attempted here; the narrower question has an answer and is asked instead.

That limit needed widening twice more before it held. Every form the
language offers for passing a value along — selecting between two,
spreading a list, assigning, awaiting, discarding all but the last of a
series — is somewhere the inspection can stop one step short of the
value, and each was found separately. They are now listed in one place so
there is a single thing to check rather than one more each time. The
inspection also refuses an argument whose value could not be worked out
AND does not come from outside the file: the exemption describes a value
that cannot be seen, and such a name satisfies neither half of that.

There is a SECOND behaviour change, and an earlier draft of this note
said there was not. Because every rule now follows a name the same way, a
small helper reached through a second name is recognised where before it
was not — the old code required the helper's own declaration to be the
function itself, and a name pointing at another name is not that. This is
a widening: regions that used to be refused now pass. It follows from the
change rather than being aimed at, which is exactly why it needed
stating; a reader checking whether this note was complete would have
found it and been right to mind.

A THIRD followed, found the same way, and this one corrects an
over-strictness rather than widening a judgement. Where a name is
declared twice — once by unpacking and once plainly — the old rule
refused it because one of the two declarations was an unpacking, even
when the plain one is the declaration that stands where the name is used.
It now reads the declaration that actually stands, so a name provably
holding the beginning of the text is accepted as such. The old answer was
not conservative, it was wrong.

Two TIGHTENINGS join them, both found the same way and both closing
windows that were open before this change rather than introduced by it. A
value reached by reading a property of something is no longer accepted as
the text being searched — what a property holds when a line runs is not a
question this can answer, which the work preceding this change had
already concluded elsewhere. And a built-in that the file itself writes
over is no longer treated as the built-in: assigning to a name that was
never declared creates nothing to see, so the name looked untouched while
it had been replaced outright.

The check on what a caller hands a helper went through five revisions
before it was abandoned, and the abandonment is described further down —
this paragraph records only what those revisions were reaching for, since
a later section replaces the answer and not the question. Each version
asked the same crude thing of EVERY argument — is this visibly not a
piece of text — which was wrong twice over: it condemned an ordinary
numeric search offset passed alongside the text, and it never asked which
parameter a stand-in would actually land on. The narrower question those
revisions settled on was which parameter the helper searches THROUGH, and
what was passed for that one. What did survive all of it is the
separation: what an expression hands over, and whether that value is a
stand-in, are two readings with two names, which is the same correction
this whole change is about.

One consequence of separating them is worth recording: the rule about
what counts as a piece of text now lives in one place, with the rule
about receivers, instead of being written twice in slightly different
words. A name holding a regular expression and a regular expression
written out are the same question, and were being answered by two pieces
of code.

Review then found three more, and all three are the same shape as the
ones before them: a rule that had been written at one site and not at its
sibling. A name holding a stand-in was being accepted where the identical
stand-in written out at the call was refused — one question, two answers.
A built-in replaced through a stable second name for the language's own
global object was not seen as replaced, though replacing it directly had
been caught for two rounds. And a search written inside a function the
helper merely CREATES, and never calls, was being attributed to the
helper's own result, so an ordinary argument was refused on the strength
of code that does not run.

Fixing the first of those exposed a defect in the consolidation itself,
and it is worth stating because it is the risk that comes with having one
answer instead of seven. Each rule keeps a record of what it has already
looked at, so that a name defined in terms of itself is refused instead of
followed forever — and resolving a name had been borrowing whichever
rule's record was to hand. Two rules that each resolve the SAME name while
judging one thing therefore shared that record, and the second read the
first's entry as a loop. A plain parameter came back "defined in terms of
itself", and a correct region was refused. Resolving keeps its own record
now; the answer depends on the name and the file and on nothing a caller
happens to have looked at first.

Alongside those, a genuine loosening. A value assigned on the arm of a
branch that the use excludes cannot have been assigned by the time the
use runs, and counting it had erased a parameter's provenance and refused
a correct region. Only the two constructs where the arms truly cannot
both run are treated this way; a switch falls through, and a catch runs
because its try block got part of the way, so neither qualifies.

The round after that found two of those very fixes reaching past their
own question, which is worth stating as the pattern it is rather than as
two more entries. The branch-arm rule holds only within a SINGLE
evaluation: where the name being written outlives the function the branch
is in, the first call's assignment is still there for the second, and the
rule was stepping over the lifetime test standing next to it. And the
alias walk gave up after a fixed number of steps — a guess about how many
names someone might chain together — where the condition that actually
ends such a walk is reaching a name declared nowhere in the file, or
coming back to one already on the chain. Both are decidable; a number is
not.

The third finding of that round was the third in a row against one small
piece of this: which of a helper's parameters a search actually looks
through. Each round named a different place the search should not have
been looking, and all three were the same question asked about the wrong
thing. What selects an argument for inspection is not a search written
anywhere inside the helper — it is a search whose result can BE the
position the helper hands back. A search used only to choose between two
outcomes that are both genuine landmarks cannot change the answer, and
neither can one inside a function the helper never calls. That is now one
question in one place, and the accompanying list names only what is
provably discarded, so anything missing from it is inspected rather than
skipped — a gap costs a refused region, never a certified one.

And then the round after that removed the thing all three of those rounds
had been about, which is the most consequential change here and the one
worth reading if you read only one.

Working out which of a helper's parameters a search actually looks
through had produced a finding in five consecutive reviews. Each named a
different route through a helper's body — a nested function reusing a
name, a function created and never called, a search used only to pick
between two outcomes, a search feeding another search's starting point, a
helper handing its value to a second helper. Every one of those findings
was right, every fix was correct, and not one of them ended the sequence.
The sixth was going to exist as well.

The question underneath was never which parameter a search reads. It is
whether an argument could hand the helper a SEARCH THAT LIES — something
shaped like a text search that answers with a fixed number instead of a
position. Only an object can carry a method that lies. A piece of text
can too, in principle, except that its own search is the genuine one.
Every other simple value — a number, a true or false, nothing at all —
carries no such method, so a helper handed one fails visibly rather than
quietly producing a fixed window.

So that is the question now, asked of every argument, with nothing traced
through anything. It is shorter, it cannot be evaded by passing a value
through one more helper, and it accepts the ordinary numeric offset that
five rounds of a widening rule had refused.

Two things are given up, and they are recorded rather than glossed. An
argument that really is a stand-in, handed to a helper whose every
possible answer is a genuine landmark regardless, is now refused — the
previous round had established that case and made it pass. So is one
whose search only supplies the starting point of an outer genuine search.
Both were correct regions. Both are refused, because establishing
otherwise needs exactly the tracing that produced five rounds of findings.
The cost is a refused region on shapes that appear nowhere in this
codebase; the direction is the safe one, and the alternative was a rule
whose edges had no end.

The review after that found two holes in the short rule that replaced all
of it — and both are the very mistake this whole change exists to remove,
made inside the rule that removed the last one.

The claim that a simple value carries no search of its own is false when
the file gives it one: a number handed a property is briefly wrapped in an
object, so a file that attaches a search to that wrapper makes every
number answer with whatever it likes. That is the same mechanism as
replacing a built-in outright, which this guard already refuses one level
up, and it is refused the same blunt way — by asking whether the file
contains such an attachment at all, not by working out which values it
could reach. Working that out is the tracing that had just been removed.

The second is plainer and worse. The same number written two ways got two
answers: one spelled as a bare digit was accepted, and one spelled with a
leading plus was refused. Nothing about the value differs. Deciding from
how something is written rather than from what it produces is the defect
this change is named after, and it had been reintroduced in the fix for
it. Every form whose result is a simple value whatever its parts — the
arithmetic and comparison forms, the negations, the increments, an
ordinary template — is now read as one. A template with a function
attached to it is deliberately not, because that function returns
whatever it likes.

The same review found the branch rule reaching only one of the two places
that need it. A name given its value where it is declared is not recorded
as having been written to — the two are different things to the machinery
underneath — so a declaration on the arm of a branch the reader is not on
never reached the rule that would have discounted it, and was refused by a
neighbouring test instead. It is one shared piece of reasoning now, which
is the fifth time on this change that one rule turned out to be answered
at one site and not at its sibling.

This note ENUMERATES the behaviour changes rather than counting them, and
that is a correction rather than a preference: a running total beside a
list is a second place the same fact is recorded, and this one was wrong
on three consecutive reviews. None of the changes was aimed at. Each
follows from every rule resolving names the same way, which is the point
of the change — and that is exactly the kind that goes unmentioned unless
somebody checks, because a reader cannot tell a deliberate widening from
an accidental one unless the note says which.

Everything else behaves as it did. The rules that were correct are
correct in the same cases; they now say why in terms anyone can check.
