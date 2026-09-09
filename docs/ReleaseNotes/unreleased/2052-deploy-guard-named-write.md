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
f-string is not; a triple-quoted Python literal spans lines; a JavaScript
regular expression is data, told apart from division by the token in front of
it and deliberately biased so that an ambiguous slash stays division, because
the other reading turns real code into data. A function or method declaration
is not a call, so declaring one named like a copy no longer reports anything.

The set of writes the checker recognises was widened at its edges rather than
lengthened: a manifest script value is shell text and is now read as such;
a command still counts when it is reached behind an environment assignment or
a privilege wrapper carrying its own options; the redirection forms that
truncate a target — the no-clobber override, the combined output form, and the
all-streams form — are recognised alongside the plain one; and the Python call
that renames over an existing path is treated as the overwrite it is. Where a
method name is too common to admit unqualified, it is spelled with its module,
so the guard does not start reporting ordinary string manipulation.

The boundary this reader works to is stated in it: it is defence in depth
behind the configuration declaration that actually preserves operator-managed
values, it is allowed to be incomplete, and it is not allowed to be noisy. A
missed exotic spelling costs nothing that the declaration does not already
cover; a false report blocks correct work, because this check runs inside
typechecking. Several review suggestions that would have widened coverage into
whole shells and dialects this reader does not parse were declined on that
basis, and the reasoning is recorded at the code rather than left implicit.
