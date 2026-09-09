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
the generic names only: declaring `copy`, `move` or `cp` is not a write, while
declaring a function named for one of the distinctive APIs still reads as one.
That is a deliberate, nameable gap rather than an open-ended list of shapes to
keep recognising.

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

The boundary this reader works to is stated in it: it is defence in depth
behind the configuration declaration that actually preserves operator-managed
values, it is allowed to be incomplete, and it is not allowed to be noisy. A
missed exotic spelling costs nothing that the declaration does not already
cover; a false report blocks correct work, because this check runs inside
typechecking. Several review suggestions that would have widened coverage into
whole shells and dialects this reader does not parse were declined on that
basis, and the reasoning is recorded at the code rather than left implicit.
