## Thread — CI required-check workflow (PR #84)

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

A new `ci.yml` workflow closes that gap. Three parallel jobs, split
into a fast required-check tier and a slower informational tier:

- **`contracts-fast`** runs `bash contracts/script/predeploy-check.sh`
  (no `--full`) — `forge build`, the deploy-sanity suite (the 12
  tests under `test/deploy/` covering EIP-170 facet sizes, selector
  coverage and ownership, the deploy-integration test), the deploy
  shell-script lint, and the per-facet ABI-in-sync check. ~30-60s.
  Designed to be the required-status-check (the follow-up that
  wires it into the `Protect main` ruleset is tracked as `74.B`).
  Catches the regression classes that would block an actual
  `--broadcast` deploy.

- **`contracts-full`** runs the same script with `--full`, which
  swaps the deploy-sanity suite for the full
  `forge test --no-match-path "test/invariants/*"` regression
  (2,012 tests). Matches what `deploy-mainnet.sh --full` invokes at
  its preflight step. Runs in parallel with `contracts-fast`,
  surfaces a red on the PR if any non-deploy-sanity test regresses,
  but is **informational only** — not in the required-status-check
  rule. The rationale: paying 10-15 min on every PR for the full
  suite when the deploy-blocker classes are already covered by the
  fast check is over-blocking; the full suite still runs so we see
  any drift, but a docs-only PR isn't gated on it. The release/*
  branch / `v*` tag-gated `mainnet-gate.yml` workflow (tracked as
  `74.C`) re-runs `--full` as a hard gate before any cutover, which
  is the line where the full suite matters.

- **`workspaces`** runs `pnpm install --frozen-lockfile` and then
  `pnpm -r typecheck`, fanning out across every workspace under
  `apps/` and `packages/`. The typecheck pass covers the keeper,
  indexer, and agent Workers — and the indexer's
  `check-event-coverage.mjs` guardrail, so a contract state-change
  event added without a matching indexer handler fails CI here. The
  vitest test step (`pnpm -r test`) is deliberately not included in
  the required-check yet — the first CI run on this PR surfaced
  pre-existing test-setup failures in `apps/defi`
  (PublicDashboard + LoanDetails tests need a `ChainProvider`
  wrap, Issue #85). Including those failures in a required check
  would have shipped a red CI on day one. Once #85 is fixed, the
  `pnpm -r test` step can be added back in a small follow-up PR.

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
