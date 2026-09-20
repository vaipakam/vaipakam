## Thread — a wrangler config is recognised by what it contains, not only by what it is called (PR #<n>)

The guard that stops a Worker deploy from wiping dashboard-managed variables
used to find configuration files one way: by wrangler's filename convention.
Anything checked in under another name was invisible to it, even though the
deploy command accepts any path — so a deployable config committed as, say,
`configs/agent-staging.jsonc` could omit the preservation flag and nothing
would say so. The retired command scanner had covered that case, and its
removal was recorded at the time as a real reduction awaiting an owner
decision rather than a gap we had always had. That decision has now been made
and the coverage is restored.

A file is now recognised as a Worker configuration if EITHER its name follows
the convention OR it carries a top-level `compatibility_date` — the field
wrangler requires of a Worker and which no package manifest, TypeScript
configuration, lockfile or contract ABI in this repository contains.
Everything either test finds goes through the same single requirement, and the
remedy is unchanged: declare the preservation flag. A file found by its
contents is not asked to be renamed, because the declaration is what makes it
safe and the naming convention is only tidiness. Neither test needs to reason
about how a deploy is spelled or how command-line options merge with file
contents, which is the unbounded reasoning the earlier scanner was retired for.

The choice of field is the whole reason this is safe to do. An earlier attempt
at reading file contents keyed on the project name and turned a correct tree
red, because every manifest has a name; name-plus-entry-point would fail the
same way for the same reason. Two limits are stated plainly rather than
implied. A configuration written in TOML is still recognised only by its name:
identifying it by content would need either a grammar this check deliberately
does not carry, or a crude text search that would flag a file merely mentioning
the field in a comment — trading one narrow gain for a new class of false
alarms. And a file that has neither the conventional name nor the field, with
the date supplied on the command line instead, remains out of reach. The one
genuinely open gap is unchanged and still needs an owner decision: a
configuration that is generated or rewritten at deploy time, which no check
over committed files can see.

The operator-visible trade is unchanged — a deploy cannot remove a variable, so
deleting one stays a deliberate dashboard action. The summary line the check
prints now reports how many files were identified by content rather than by
name, and continues to count exempt Pages projects separately, so the number an
operator reads is a claim about files the check actually asserted.
