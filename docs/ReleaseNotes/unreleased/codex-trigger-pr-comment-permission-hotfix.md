## Thread — Codex trigger workflow PR-comment permission hotfix

The `codex-review-trigger` workflow that shipped in #274 surfaced a
GitHub Actions permission gotcha on its first live run against
PR #275: the workflow's declared `issues: write` permission is
sufficient for creating comments on true issues, but PR comments
specifically require `pull-requests: write` — even though the REST
endpoint is the same `/repos/.../issues/{n}/comments`. The earlier
#273 review had tightened `pull-requests: write` to `read` on the
basis of mistaken least-privilege analysis (treating the
`/issues/{n}/comments` path as covered solely by `issues: write`),
and the workflow consequently failed with HTTP 403 when it tried
to auto-forward an `@codex review` trigger from a PR's description.

This thread restores `pull-requests: write` in the workflow's
permissions block. The `author_association` gate
(`OWNER + COLLABORATOR + MEMBER`) introduced in #274 still bounds
who can cause the elevated token to act, preserving the public-repo
cost-DoS protection. The repository-level
`default_workflow_permissions: read` ceiling is unchanged, so any
future workflow without an explicit `permissions:` block still
defaults read-only.

Operator bypass for in-flight PRs while a similar hotfix is pending
in any future regression: manually post `@codex review <mode>` as a
PR comment from a PAT that has the needed scopes. The workflow's
role is to auto-forward triggers from PR descriptions into PR
threads; Codex itself reads any directly-posted trigger comment
regardless of who authored it, so the manual-comment path is a
clean degraded-mode fallback.

Lesson recorded for future workflow reviews: the
`/issues/{n}/comments` REST endpoint accepts EITHER `issues=write`
OR `pull_requests=write` per the server-returned
`x-accepted-github-permissions` header, but the actual permission
the token needs is determined by whether `n` resolves to a true
issue or a pull request. For workflows that operate on PR threads,
`pull-requests: write` is the load-bearing scope.
