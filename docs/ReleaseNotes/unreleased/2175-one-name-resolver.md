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

Beyond those five, no behaviour changes. The rules that were correct are
correct in the same cases; they now say why in terms anyone can check.

Three behaviour changes where a first draft claimed one is itself worth
recording. None was aimed at; each follows from every rule resolving
names the same way, which is the whole point of the change. That is
exactly the kind that goes unmentioned unless somebody checks, and the
reason to check is that a reader cannot tell a deliberate widening from
an accidental one unless the note says which.
