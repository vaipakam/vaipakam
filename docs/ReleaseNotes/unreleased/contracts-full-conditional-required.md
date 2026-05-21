## Thread — Make `contracts-full` a conditional required check (PR #<n>)

Tightens the merge gate. Pre-change, `contracts-full` (the full
2,012-test regression) ran informationally on every PR but did
not gate merge. The deliberate trade-off was acknowledged in
`ci.yml`'s top comment: a subtle regression that only the full
suite catches could land on main between PR merge and the next
`mainnet-gate.yml` run on a release tag. `mainnet-gate.yml` is the
load-bearing backstop, but the gap is real.

This PR closes that gap by adding `contracts-full (forge +
predeploy-check --full)` to the `Protect main` ruleset's
`required_status_checks` rule and renaming the job (drops the
`[informational]` suffix that's now stale). The check is
conditionally required via the path-filter skip pattern: its
existing `if: needs.detect-changes.outputs.contracts == 'true'`
guard skips it on docs-only PRs, and branch protection treats
`if:`-skipped checks as SUCCESS. So docs-only PRs continue to
merge fast; contracts-touching PRs must wait for the full
regression to complete on the FINAL commit before merge.

Trade-off, per the user's explicit preference in
`feedback_ci_compute_over_wall_clock`:

- Critical-path wall-clock on contracts-touching PRs grows by
  ~5-10 min — `contracts-fast` clears in ~10 min cold but
  `contracts-full` runs another ~5-10 min on the warm cache.
- Compute cost is UNCHANGED — `contracts-full` was already
  running, just not gating.
- Confidence in the final merge SHA goes from MEDIUM to HIGH.
  The full suite is guaranteed to have run on the exact commit
  being merged.

`mainnet-gate.yml`'s rationale block was updated to reflect the
new shape: the workflow now exists as the audit-trail symmetry
backstop for release tags rather than the only line of defence
for the full regression.

Maintainer action alongside merge: update GitHub Settings → Rules
→ Protect main → "Require status checks to pass" to include the
new `contracts-full (forge + predeploy-check --full)` entry. The
PR description carries the exact UI walkthrough.
