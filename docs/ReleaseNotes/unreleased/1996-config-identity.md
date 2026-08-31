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

When the file cannot answer, the checker no longer guesses from the directory —
it declines to stay silent. A deployment that selects a configuration whose
Worker cannot be identified is reported, with its own remedy rather than a
package's, because naming a package would be a claim about a Worker that was
never identified. The remedy is to make the command safe for whatever it
targets, which is always available and never wrong for any Worker: carry the
preservation flag, or declare preservation in the selected configuration.

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
names a package the reader can act on.

One limit is recorded rather than solved, and is deliberate. When a deployment
selects an environment, Wrangler derives the deployed Worker name from that
environment rather than using the declared name as written, so the declared
name is no longer what ships. In that case the checker ignores the name and
falls back to the directory, which is the answer that errs toward reporting.

This was the one finding of ten deferred out of the preceding deploy-guard
work, on the grounds that reading another file was a different kind of tool
from scanning a line. That objection no longer holds: resolving a path against
a modelled working directory, opening the file and reading a field out of it
was built during that same work for the preservation setting, so this is one
more field out of a file the checker already opens.

Closes #1996.
