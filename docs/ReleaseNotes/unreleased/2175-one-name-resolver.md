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
pretending to be text. A parameter is exempt — its value arrives from the
caller, which is how these drives are handed their source — and
everything else unresolved is now refused.

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

No other behaviour changes. The rules that were correct are correct in
the same cases; they now say why in terms anyone can check.
