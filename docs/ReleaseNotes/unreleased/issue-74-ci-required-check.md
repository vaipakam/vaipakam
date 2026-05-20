## Thread — CI required-check workflow (PR #<n>)

Until this change every pull request that landed on `main` had been
verified only locally — the `Protect main` branch ruleset required a
pull-request review (with one approver and thread resolution) but had
no `required_status_checks` rule, so no automated CI gate ran. The
`release-notes-drift.yml` workflow was the only check that touched
pull requests, and it is deliberately non-blocking. That left a real
gap: a contributor — or the assistant — could open a PR with a
broken `forge build`, a regressed test, or a typecheck failure and
the only thing standing between it and `main` was the reviewer's
local-run discipline.

A new `ci.yml` workflow closes that gap. Two parallel jobs:

- **`contracts`** runs `bash contracts/script/predeploy-check.sh --full`
  end-to-end — the same gate the mainnet runbook invokes as its
  `[1b]` preflight step. That cohesive script covers `forge build`,
  the full regression test sweep (with the slow invariant suite
  excluded, matching the local convention), the deploy shell-script
  lint, and the per-facet ABI-in-sync check the predeploy-missing-
  ABI work landed earlier. Because CI runs exactly what the
  pre-deploy gate runs, CI green guarantees the gate will accept the
  state at deploy time — drift between "passes CI" and "the deploy
  script will accept" is no longer possible.

- **`workspaces`** runs `pnpm install --frozen-lockfile` and then
  `pnpm -r typecheck` + `pnpm -r test`, fanning out across every
  workspace under `apps/` and `packages/`. The typecheck pass
  covers the keeper, indexer, and agent Workers — and the
  indexer's `check-event-coverage.mjs` guardrail, so a contract
  state-change event added without a matching indexer handler
  fails CI here.

Both jobs are independent and run in parallel, with concurrency
serialisation per branch so a fresh push cancels the older in-flight
run. Foundry's artifact tree and incremental compile cache are keyed
on `foundry.toml` + `remappings.txt` + the contracts source tree, so
warm builds drop from the cold ~10 min figure to ~90 s.

This PR ships the workflow in non-blocking form. The `Protect main`
ruleset will be updated in a follow-up PR to add a
`required_status_checks` rule referencing the `contracts` and
`workspaces` job names — staging the rollout this way lets the
workflow demonstrate green runs on real PRs before becoming a hard
gate. Required-signatures, and the equivalent keeper-bot main
protection, are also follow-ups in the same hardening arc.

Closes #74.
