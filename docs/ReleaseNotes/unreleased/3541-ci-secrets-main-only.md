## Thread — CI secrets move to a main-only environment (PR #<n>)

Every secret the CI workflows use, other than the built-in GitHub token, now
lives in a GitHub environment that only the main branch may use, instead of
at the repository level. Before this change any workflow that ran could read
those secrets, including a copy edited on a pushed branch, so anyone able to
push a branch could reach the project-board token, the backup archive and
ledger keys, the ops alert credentials, the Cloudflare read token and the
Claude token. Now a branch run receives none of them, whatever its workflow
says. Each job that reads a secret also checks that it runs from main, as a
readable statement of the same rule.

The Claude workflow no longer answers mentions in inline pull-request review
comments, because those events run the pull request's own copy of the
workflow and cannot be admitted to a main-only environment. Mentions in issues
and in the pull-request conversation still work.

The release workflow now checks the tag's shape once, before anything uses it,
and passes it to later steps as data rather than pasting it into a script. Its
checkout no longer keeps a GitHub credential.

The secrets themselves move in the repository settings, which an owner does;
the steps are in the pull request and in the project procedures (section 7.7).
A workflow linter and an offline docs link check follow in #3548.

Advances #3541.

> Caveat: until the owner moves the secrets into the environment and deletes the repository copies, branch runs can still read the repository copies.
