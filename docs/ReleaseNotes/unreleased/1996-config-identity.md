## Thread — The deploy guard now asks which Worker a configuration names (PR #TBD)

The repository-wide deploy checker protects two Workers, and until now it
decided which Worker a deployment targeted partly by where the configuration
file sat on disk. Wrangler does not work that way: it reads the Worker's
identity out of the configuration's own name field. A configuration living
outside either protected directory but naming one of them therefore deployed a
protected Worker while the checker reported nothing, because the directory it
was asked about was out of scope.

The checker now reads that field. When a deployment explicitly selects a
configuration file, and that file can be found and understood, the name it
declares decides the answer — the same rule Wrangler itself applies, and the
same rule the checker already applied to an explicitly named Worker. This cuts
both ways: a configuration sitting inside a protected directory but naming a
different Worker is now correctly treated as deploying that different Worker,
whose values are not the protected ones.

When the file cannot answer, the checker no longer stays silent. It still tries
the older directory-based reasoning first — a configuration selected from inside
a protected package is reported against that package, with that package's
remedy, because that is the more useful answer when it is available. What
changed is the case where even that yields nothing: rather than passing the
deployment, the checker reports it against no package at all, with a remedy of
its own, because naming a package would be a claim about a Worker that was never
identified. That remedy is to make the command safe for whatever it targets,
which is always available and never wrong for any Worker: carry the preservation
flag, or declare preservation in the selected configuration.

A configuration the surrounding script rewrites on its way to the deployment is
not the file that gets loaded, so the copy sitting in the checkout answers
nothing about it — neither which Worker it names nor whether it preserves
values. A script that ships a configuration declaring preservation and edits
that declaration away immediately before deploying is the case, and it reads as
safe to anyone reading only the checked-in file. Both of the checker's readers
of a selected configuration now stand down when they see it being written,
whether the write is spelled as a file write in a program or as a redirection in
a shell script.

That inversion is affordable because it was measured before it was adopted. The
repository contains one hundred and thirty-two deployment mentions and none of
them selects a configuration file, so the rule cannot produce a single complaint
on the tree as it stands — which matters, because this checker runs as part of
type-checking and a wrong complaint would block every change in the repository.
Anyone who later adds a legitimate configuration-selecting deployment clears the
complaint by making the command safe, not by asking for an exemption. The
measurement is worth re-taking rather than assumed, and the reasoning is
recorded beside the rule so a future reader can re-take it.

The inversion is deliberately confined to configuration selection. Two related
options name a directory rather than a file and reach the same
cannot-be-identified state, but they are ordinary in wrapper scripts and were
not part of the measurement, so widening to them is separate work with its own
count. Prose keeps deferring to the surrounding text, which on a runbook line
names a package the reader can act on — but only prose does. A command written
out as an executable call in a helper script has no surrounding text to defer
to, and deferring there produced no answer at all, so a generated configuration
selected from such a helper passed unexamined. Those reach the same complaint
as any other unidentified selection.

A configuration a script generates deserves the same treatment for
preservation, and now gets it in two more places. An explicitly named
configuration is answered by the path it names and by nothing else: the checker
used to fall back to a file of the same name inside a protected package, which
answers about a different file. And a script that writes the configuration
before deploying it is recognised in more of the shapes a script actually uses,
including the one where the file is named before the write rather than inside
it. The write has to come first, though — a scan that ignored order let
maintenance code below a deployment invalidate the file that deployment reads,
and report a correct command because of a line that runs after it.

Selecting an environment changes which name ships, and the checker reads that
too. Wrangler layers the chosen environment over the top of the configuration
and takes the deployed Worker from the result, so a configuration whose
top-level name is some unprotected Worker can still deploy a protected one
through an environment further down the same file. Which environment matters:
when the choice is written plainly enough to read, only that one is consulted,
because deploying one environment says nothing about the others, and consulting
them all made an unrelated environment answer for a deployment that never
touches it. Where the choice cannot be read, every environment is a candidate.

An environment can be chosen in more ways than a command-line flag, and two of
them look like nothing at all. A set of environment variables assembled
elsewhere in the script and handed to the command carries whatever the script
was started with, so an environment can arrive without appearing anywhere on
the line; the same is true of a file of variables named for loading, which is
read before the configuration is. In both cases the checker treats the choice
as made and unread rather than as absent.

The point where this had to be settled is what a name that matches nothing
protected proves. If the environments were read, it proves the deployment is
out of scope, and the checker says so. If they could not be — a configuration
in the format whose environments live in sections this checker's reader stops
before — it proves nothing, because an unread section could name a protected
Worker, and the checker falls back to the directory instead. An earlier version
of this work applied the cautious half everywhere. That was sound while
environments were not read at all and became wrong the moment an inherited set
of variables counted as a choice, since almost every real command carries one:
the caution then fired constantly and reported ordinary deployments of
unprotected Workers. It now applies only where it is earned.

This was the one finding of ten deferred out of the preceding deploy-guard
work, on the grounds that reading another file was a different kind of tool
from scanning a line. That objection no longer holds: resolving a path against
a modelled working directory, opening the file and reading a field out of it
was built during that same work for the preservation setting, so this is one
more field out of a file the checker already opens.

Closes #1996.
