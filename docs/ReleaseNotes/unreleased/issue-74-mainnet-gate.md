## Thread — Pre-audit branch hardening: mainnet-gate workflow + signed commits + keeper-bot protection (PR #<n>)

This change closes out the `74.C` follow-up arc from PR #84 — the
items deferred when the contracts CI was split into `contracts-fast`
(required, deploy-sanity only) and `contracts-full` (informational,
runs the full regression on every PR but doesn't gate merges).

Three changes ship together:

**Mainnet-gate workflow.** A new `.github/workflows/mainnet-gate.yml`
runs `bash contracts/script/predeploy-check.sh --full` on every push
to a `release/**` branch and every `v*` tag push. This is the same
script the mainnet runbook invokes at preflight step `[1b]`, so a
release-track commit cannot ship a state the deploy script would
reject. The split between routine PR CI (fast, sanity-only) and the
mainnet gate (slow, full regression) gives us the right cost/coverage
trade-off — small PRs aren't blocked on a 10-15 min regression, but
no release-track commit slips through without it. The workflow also
captures audit-trail evidence on tag pushes: resolved compiler
version + every facet's runtime bytecode size against the EIP-170
ceiling, logged into the workflow run record.

**Required signed commits on `main`.** The `Protect main` ruleset now
includes a `required_signatures` rule. The current pattern — squash-
merging via `gh pr merge --squash` — produces a GitHub-signed merge
commit on `main`, so the rule passes for every PR merge automatically.
Direct pushes (which were already blocked by branch protection)
remain blocked. The rule is a defence-in-depth backstop against a
hypothetical future bypass.

**Keeper-bot now public + protected.** The reference keeper bot
(`vaipakam/vaipakam-keeper-bot`) is flipped from private to public,
and an equivalent `Protect main` ruleset is created on it: the same
six rules as the monorepo's main protection, with the keeper-bot's
two CI jobs (`Typecheck`, `ABI shape sanity`) wired as required
status checks. The repo was always intended to flip public at
mainnet cutover; doing it now lets the equivalent branch-protection
free-tier kick in (GitHub's free branch-protection requires a public
repo, no GitHub Pro upgrade needed).

Combined with `contracts-fast` and `workspaces` being added to the
required-status-checks rule (the `74.B` change that landed alongside
PR #84's merge), the `Protect main` ruleset on the monorepo now
enforces eight independent gates on every merge:

- no branch deletion
- no force-push / non-fast-forward
- linear history (squash / rebase only)
- pull-request required, with thread resolution
- `contracts-fast` must be SUCCESS
- `workspaces` must be SUCCESS
- signed commits
- (`contracts-full` runs in parallel but is informational — see PR #84
  for the rationale)

The `release/**` branch family doesn't yet have its own ruleset —
that lands when the first release branch is cut. A small follow-up
will add a ruleset scoped to `refs/heads/release/**` that requires
the `mainnet-gate-full` context, so a force-push or unsanctioned
merge to a release branch cannot bypass the full-regression gate.
Tracked as part of the mainnet rollout workflow rather than as a
new code change, since the ruleset can't reference a context that
hasn't run at least once.

Closes #74 (the rest of the arc; the CI workflow itself landed in
PR #84).
