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

Every way the file can fail to answer falls back to the previous
directory-based reasoning rather than to a complaint. That matters more than
usual here, because this checker runs as part of type-checking and a wrong
complaint would block every change in the repository. A path built from a
variable, a file generated at build time and so absent from the checkout, a
file that does not parse, a file with no literal name, and a name built from a
template are all treated as "this file did not answer", and the older reasoning
takes over unchanged.

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
