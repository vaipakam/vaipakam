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
SARIF upload to the Security → Code scanning surface). The job runs
on every PR — matching the pre-fold `codeql.yml` behaviour which had
no path filter. CodeQL walks JS/TS repo-wide (root tsconfig, root
scripts, `.github/codeql/` configs), so gating on the workspaces
path-filter would have introduced a regression Codex caught on round-1.

`contracts-fast` now `needs: [detect-changes, workspaces,
analyze-jstypescript]` for sequencing — analyze-jstypescript must
finish before contracts-fast starts so they don't race for runner
minutes — but the `if:` condition only short-circuits on a
`workspaces` failure, NOT on an analyze-jstypescript failure. Reason:
`workspaces` is a Protect-main required check, so its red blocks
merge directly even when contracts-fast auto-skips. analyze-
jstypescript is NOT required — if we used it to gate contracts-fast,
a CodeQL failure would auto-skip contracts-fast and branch
protection would treat the skipped required check as SUCCESS,
making the PR mergeable with no forge build run. That's the safety-
vs-compute trade-off Codex round-2 caught (P1 finding on this PR).
The `!cancelled()` prefix on the `if:` lets contracts-fast still run
when the gate jobs are skipped (contracts-only PR — the path-filter
excludes workspaces).

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
