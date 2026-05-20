# Contributing to Vaipakam

Thanks for your interest in Vaipakam — a decentralised P2P lending,
borrowing, and NFT-rental platform built on the EIP-2535 Diamond
Standard.

This file is the **30-second contributor's guide**. The full
contributor handbook lives at
[`docs/internal/ProjectProcedures.md`](docs/internal/ProjectProcedures.md)
— read that before opening a non-trivial PR.

## Before you start

- **Code of conduct**: see [`CODE_OF_CONDUCT.md`](CODE_OF_CONDUCT.md).
  We follow the Contributor Covenant; participation in the project
  means agreeing to it.
- **Security issues**: if you've found a vulnerability (asset loss,
  oracle drift, sanctions bypass, cross-chain message forgery, etc.)
  **do NOT file a public Issue.** Follow the runbook at
  [`docs/ops/IncidentRunbook.md`](docs/ops/IncidentRunbook.md)
  for private disclosure.
- **Issues**: file via the templates under
  [`.github/ISSUE_TEMPLATE/`](.github/ISSUE_TEMPLATE/). Blank issues
  are disabled; pick the closest template (`bug`, `feature_request`,
  `audit_finding`).

## Quick start

```bash
# Clone + install (pnpm workspace)
git clone https://github.com/vaipakam/vaipakam.git
cd vaipakam
pnpm install

# One-time: install the pre-commit hook (requires `pre-commit` on PATH;
# install with `pipx install pre-commit` or `brew install pre-commit`).
# Catches trailing whitespace, EOF newlines, large files, JSON/YAML
# syntax, and runs `forge fmt --check` on staged Solidity files.
pre-commit install

# Build + test contracts (always under contracts/)
cd contracts
nice -n -10 ionice -c 2 -n 0 forge build
nice -n -10 ionice -c 2 -n 0 forge test

# Workspace typecheck — DO NOT use `pnpm -r typecheck` (silently
# skips workspaces without a `typecheck` script); use the explicit
# per-workspace form documented in ProjectProcedures.md §2.4.
pnpm --filter @vaipakam/keeper typecheck
pnpm --filter @vaipakam/indexer typecheck
pnpm --filter @vaipakam/agent typecheck
pnpm --filter @vaipakam/defi exec tsc -b --noEmit
pnpm --filter @vaipakam/www typecheck
```

The `nice -n -10 ionice -c 2 -n 0` prefix on `forge` is convention —
viaIR runs are long and benefit from higher priority. See
[`ProjectProcedures.md §9`](docs/internal/ProjectProcedures.md).

## PR workflow

1. **Pick a card** from the [`@vaipakam-labs`](https://github.com/users/vaipakam/projects/1)
   project board (or file an Issue first if it's a new idea).
2. **Branch** from `main` (`feat/issue-<N>-<slug>`).
3. **Implement + test** locally; build green, all tests green.
4. **Open the PR** with a body covering: What, Why, Verification,
   `Closes #N`.
5. **Move the card** on `@vaipakam-labs` to `In review` (the move
   happens *after* the PR exists; see ProjectProcedures.md §5.3).
6. **Trigger Codex** with `@codex review <mode>` per
   [`AGENTS.md`](AGENTS.md) (`normal` / `adversarial` / `full` /
   `full security-critical`). The `vaipakam/vaipakam` repo has Codex
   configured to auto-review on PR-open, so this is usually only
   needed after a fix push.
7. **Address findings**, push, re-trigger, repeat until clean.
8. **Merge** is the maintainer's call (`gh pr merge --squash`,
   without `--delete-branch` — branches are kept for troubleshooting
   per project convention).

Full step-by-step in
[`ProjectProcedures.md §3`](docs/internal/ProjectProcedures.md).

## Conventions worth knowing up front

- **Solidity 0.8.29 with viaIR + optimizer 200 runs** — pin matters
  for deterministic build artifacts auditors can reproduce.
- **Custom errors, not `require` strings** — gas efficiency + clean
  ABI decode at the consumer side.
- **ERC20 approvals = exact amount, never `MaxUint256`** — full
  rationale in ProjectProcedures.md §12.
- **Release notes** — every behaviour-changing PR carries a
  per-PR fragment in `docs/ReleaseNotes/unreleased/` (template:
  `docs/ReleaseNotes/unreleased/_TEMPLATE.md`). Plain English, no
  code. Folded into the dated file via `bash
  docs/ReleaseNotes/assemble.sh` at end-of-day.
- **Functional specs** — `docs/FunctionalSpecs/` is the
  code-independent specification of intended behaviour. Behaviour-
  changing PRs update the relevant domain spec in the same diff —
  the spec is **never** transcribed from code. See
  `docs/FunctionalSpecs/README.md`.

## Where things live

| Tree | What |
| --- | --- |
| [`contracts/`](contracts/) | Solidity contracts (Diamond + facets), Foundry tests, deploy scripts. |
| [`apps/`](apps/) | Workspaces: `defi` (connected app), `www` (marketing), `keeper`, `indexer`, `agent` (Cloudflare Workers), `labs` (internal). |
| [`packages/`](packages/) | Shared packages: `contracts` (ABIs + deployments), `lib`, `ui`. |
| [`docs/`](docs/) | Living docs — `DesignsAndPlans/`, `FunctionalSpecs/`, `ReleaseNotes/`, `internal/`, `ops/`. |
| [`audits/`](audits/) | Audit reports + auditor working directories (populated as audits land). |
| [`.github/`](.github/) | Issue templates, workflows, CODEOWNERS, LABELS reference. |

## Where to ask questions

- **General**: open a discussion (or a `question`-labelled Issue if
  you prefer the Issue surface).
- **Architecture**: design rationale lives in
  `docs/DesignsAndPlans/`. The agent handbook
  `docs/internal/ProjectProcedures.md` summarises load-bearing
  conventions.
- **Security**: private disclosure via the IncidentRunbook (above).

Welcome aboard.
