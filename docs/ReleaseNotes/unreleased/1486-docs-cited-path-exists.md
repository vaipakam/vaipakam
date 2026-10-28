## Thread — the docs path gate checks that every cited path exists (PR #3023)

The blocking docs path gate on the operator runbooks used to catch one thing: a citation of a directory that had been removed or renamed. It now also catches a runbook that links to, or shows as code, a repository path the tracked tree does not have, such as a wrong spec path, a script that was deleted, or a file name with a typo.

That second rule waited for a real markdown parser. The gate used to find links and code spans with patterns, and every pattern mistake would have turned into a false alarm under a rule that reports anything it cannot find. Links and code spans now come from the same CommonMark parser the excision gate already uses. The words taken out of command text stay a loose guess on purpose, and only the removed-directory rule reads them. A code span counts as a path only when it starts at a top-level entry of the repository, a span starting with ./ or ../ is relative to a working directory and is not judged, and a path the committed ignore files cover (such as the contracts .env file an operator is told to create) is not a finding. A new set of fixtures pins each case the original review found wrong.

Fifteen stale citations in the runbooks were fixed in the same change: two moved spec and release-note paths, a publish step that pointed at a file that never existed, a future mainnet artifact now written with its slug placeholder, and mentions of deleted scripts and the removed lz-watcher written as prose rather than as paths.

Closes #1486.

> Caveat: the gate still covers docs/ops/ only. Widening it to the design docs is #1462.
