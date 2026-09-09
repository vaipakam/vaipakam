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

Three shapes are deliberately NOT recognised, and all are misses rather than
noise. A file operation reached through a variable is one, as just described. A command run through a module imported under an arbitrary alias is one:
resolving that name means following a binding, which this reader declines
everywhere and which is the subject of the open question above — the alternative
of admitting any named receiver was measured against the common case of matching
a pattern held in a variable, and would report that. The other is a script that
quotes an example of a write to its own configuration: in a shell a quoted
string handed to a command may be executed by it, so quoted shell text is read
as executable unless it is plainly being stored. Narrowing that was tried when
the classifier was written and immediately lost real payloads. Both are named
here so they are limits rather than surprises.

The boundary this reader works to is stated in it: it is defence in depth
behind the configuration declaration that actually preserves operator-managed
values, it is allowed to be incomplete, and it is not allowed to be noisy. A
missed exotic spelling costs nothing that the declaration does not already
cover; a false report blocks correct work, because this check runs inside
typechecking. Several review suggestions that would have widened coverage into
whole shells and dialects this reader does not parse were declined on that
basis, and the reasoning is recorded at the code rather than left implicit.
