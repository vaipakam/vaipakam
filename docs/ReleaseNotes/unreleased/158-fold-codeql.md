## Thread — Fold CodeQL into ci.yml (closes #158)

Continuation of PR #157's compute-saving theme. PR #157 folded
`gas-snapshot.yml` + `slither.yml` into `ci.yml` and added a
fail-fast gate so `contracts-fast` `needs: workspaces`. The card #158
filed at that time tracked the same fold for CodeQL — and this PR
does it.

`.github/workflows/codeql.yml` is **deleted**. Its `analyze` job
moves into `ci.yml` as a new `analyze-jstypescript` job (matrix
flattened to the single `javascript-typescript` language; same
`security-extended` query pack, same `paths-ignore` config, same
SARIF upload to the Security → Code scanning surface). The job gates
on `detect-changes.outputs.workspaces == 'true'` — the same
path-filter that drives the workspaces typecheck — so docs-only or
contracts-only PRs skip it as before.

`contracts-fast` now `needs: [detect-changes, workspaces,
analyze-jstypescript]`, so a TypeScript-side failure caught by
EITHER the workspaces typecheck OR CodeQL's static analysis
short-circuits the expensive forge build. The `!cancelled()` prefix
on the `if:` lets the job still run when the gate jobs are skipped
(contracts-only PR — the path-filter excludes both gates, and
contracts-fast runs unconditioned by them).

CodeQL's weekly cron survives the move. The original `codeql.yml`
carried a `schedule: '17 6 * * 1'` (Mondays 06:17 UTC) safety scan;
that schedule is now on `ci.yml` itself, and `detect-changes` was
taught to treat `schedule` (and `workflow_dispatch`) events as
"everything changed" so the full graph runs weekly against main. The
recurring cost — ~25 min of CI on Mondays for the full pipeline — is
a deliberate trade for the audit safety net (catches CodeQL-pack
drift, submodule pin drift, and dep-bump-triggered failures between
commit-driven runs).

Top-of-file `ci.yml` permissions extended to add `security-events:
write` (for CodeQL's SARIF upload, same right Slither already needs)
and `actions: read` (required by `github/codeql-action/analyze`).

After this PR merges the Actions tab no longer has a separate
`CodeQL` workflow — its run appears as a job inside `ci`. The
Protect main ruleset doesn't reference CodeQL by name (only
`contracts-fast`, `workspaces`, `detect-changes` are required), so
no ruleset update is needed.
