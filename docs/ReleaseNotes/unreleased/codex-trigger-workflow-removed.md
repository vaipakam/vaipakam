## Thread — Codex trigger workflow removed (redundant with Codex's native integration)

The `codex-review-trigger` workflow shipped in #274 (+ hotfixed in
#276 for a permission gap) turned out to be redundant: Codex's
GitHub App already fires on `pull_request: opened` events when the
PR description contains `@codex review <mode>`, and also listens
natively to PR-thread comments containing the trigger text.

PR #275's run timeline made the redundancy obvious. Codex posted
its initial review at 20:42 UTC even though our trigger workflow
had failed at 20:40 with the permission bug carried over from the
original #273 review. The Codex App was bridging the
description-to-review path independently — our workflow was
forwarding the trigger into a comment Codex would have triggered on
anyway, just slower.

The workflow's defensive shape (an `author_association` gate
restricting forwarding to `OWNER + COLLABORATOR + MEMBER`,
SHA-keyed dedupe, a concurrency group serializing parallel events)
was all defending against an attack surface — paid-Codex-compute
abuse via forwarded comments — that no longer exists when no
forwarding happens. The two remaining edge cases the workflow was
the only thing covering (PR description edited post-open with a
new trigger; PR re-opened with the trigger in body) are rare in
practice and covered by the same one-off fallback that handles any
manual re-trigger need: post `@codex review <mode>` as a PR
comment from a PAT with the needed scopes.

Delete `.github/workflows/codex-review-trigger.yml` entirely.
Documented here so anyone reading `git log` on `main` over the
~24-hour window where the workflow existed has the context for
why it appeared and then disappeared.

Supersedes #274 + #276.
