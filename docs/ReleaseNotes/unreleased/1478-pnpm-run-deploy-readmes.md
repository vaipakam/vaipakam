## Thread — every documented pnpm deploy invocation now runs the package script (PR #TBD)

Under the workspace's pinned pnpm, `pnpm --filter <package> deploy`
resolves to pnpm's own built-in "portable package deploy" command —
which demands a target directory and never runs the package's declared
`deploy` script. Every per-app README documented exactly that broken
form, so an operator following any of the six app READMEs verbatim
stopped at a usage error instead of deploying. The ops runbooks were
corrected during the #1450 review (Codex round 28); this change sweeps
the remaining sites — the six `apps/*` READMEs — to the working
`pnpm --filter <package> run deploy` form. A repo-wide sweep found no
other documented pnpm invocation whose script name collides with a
pnpm builtin. Closes #1478.
