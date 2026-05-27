# ADR-0006: Three-tier CI split — `contracts-fast`, `contracts-full`, `mainnet-gate`

**Status:** Superseded by [ADR-0011](0011-ci-scope-cifast-profile.md) (2026-05-28)
**Date:** 2026-05 (Pre-audit hardening #74; ADR backfilled 2026-05-20)

> **Superseded.** The three-tier shape this ADR describes was retired
> in #297 (closes #296) after the test corpus grew past the 16 GB
> ubuntu-latest ceiling. `contracts-full` and `gas-snapshot` are no
> longer in `ci.yml`; per-PR contracts CI runs under the narrow
> `cifast` foundry profile and the full regression moved to
> operator-local + the release-track `mainnet-gate` workflow. See
> [ADR-0011](0011-ci-scope-cifast-profile.md) for the post-#296
> design. The historical content below is preserved as the audit
> trail of the previous decision.

## Context

The protocol's full forge regression is ~2,012 tests. On a cold-cache
runner, it takes 10-15 min. The deploy-sanity subset (~12 tests under
`contracts/test/deploy/`) takes 1-2 min cold, seconds warm.

Two competing pressures:

1. **PR throughput** — small / docs-only PRs should not pay 10-15 min
   of contracts CI to merge. Tying every PR to the full regression
   makes the doc-PR cadence painful enough that contributors avoid
   filing them.
2. **Pre-mainnet safety** — no commit should reach a deployable
   ref (mainnet `release/*` branch, `v*` tag) without the full
   regression passing. A safety net only at the PR-merge moment
   (the standard pattern) misses cases where a regression-introducing
   commit hits `main` because the full regression isn't a required
   check.

Other constraints:

- **Path-filter awareness** — most PRs don't touch contracts at all.
  If contracts CI is required on every PR, docs PRs need a way to
  satisfy it without running 12 minutes of forge.
- **Cache reuse** — running the deploy-sanity suite and the full
  regression as two independent jobs would mean two cold rebuilds
  (10+ min wasted on the second one). The two must share the
  foundry artifact tree.

## Decision

Adopt a **three-tier CI split**:

1. **`contracts-fast`** (required) — runs `forge build` +
   `predeploy-check.sh` (deploy-sanity suite). 1-2 min warm, 8-12
   min cold. **Required status check** on `main`.
2. **`contracts-full`** (informational) — runs `forge build` +
   `predeploy-check.sh --full` (full 2,012-test regression). Same
   workflow file, serialized AFTER `contracts-fast` via `needs:`
   so the same workflow run's foundry cache (saved at the END of
   `contracts-fast`) is restored at the START of `contracts-full`
   — one cold rebuild per workflow run, not two. **Informational
   status check** — failures visible but not blocking PR merge.
3. **`mainnet-gate`** (hard CI gate) — runs `predeploy-check.sh
   --full` on push to `release/**`, PR to `release/**`, `v*` tag
   push, and `workflow_dispatch`. Bit-identical to what
   `deploy-mainnet.sh` invokes at preflight step `[1b]`. **Required
   status check** on `release/**`.

Three additional pieces:

- **Path filter (`detect-changes` job)** — first CI job; diffs PR
  head vs base and exports `contracts` + `workspaces` booleans.
  Downstream jobs `if:`-guard on these. Skipped-due-to-`if` counts
  as SUCCESS for required status checks, so docs-only PRs merge in
  under a minute.
- **detect-changes itself in required-status-checks** — defensive
  against the path filter ever failing (otherwise its skip would
  silently let a contracts PR through with no contracts check).
- **Cache key** — `forge-${runner.os}-${configHash}-${sourceHash}`
  with `configHash = hashFiles('contracts/foundry.toml',
  'contracts/remappings.txt', 'contracts/.submodule-state')` and
  `sourceHash = hashFiles('contracts/{src,script,test}/**/*.sol')`.
  Restore-key uses the configHash prefix so warm hits work across
  same-config commits; cold rebuild only on config / submodule /
  source change.

## Consequences

**Positive**

- Docs-only PRs merge in <1 min — the path-filter design pays off
  exactly here.
- Contracts PRs get the fast suite as a hard gate AND the full
  regression as a "look at me before you merge" informational
  signal in the same run.
- The same-run cache transfer means contracts PRs pay one cold
  rebuild, not two.
- Release / mainnet refs pay for the full regression
  unconditionally (via `mainnet-gate`) — the safety net is at the
  ref that actually matters.

**Negative / accepted costs**

- `contracts-full`'s informational status means a regression-
  introducing PR could theoretically be merged on a maintainer's
  judgement call. Mitigated by: (a) PR-time visibility — the red
  check is visible to anyone reviewing; (b) `mainnet-gate` is the
  hard gate, so a regression that reaches `main` doesn't reach
  a deployable ref; (c) the maintainer in practice waits for
  green before merging contracts changes.
- Cache-key churn during the design phase (v1 → v4 over PRs #80,
  #84) burned operator attention. Mitigated now that the v4 shape
  has stabilised; documented in `ProjectProcedures.md` §7.5.
- The three-tier picture takes a moment to explain to a new
  contributor. Mitigated by `ProjectProcedures.md` §7 + the inline
  comments in `.github/workflows/ci.yml`.

**Risks the decision creates**

- A future change to the deploy-sanity suite that makes it slow (>
  5 min warm) would erode the "fast PR" guarantee. Mitigation:
  watch the time budget; if it creeps, split or trim.
- `contracts-full` being informational means a green PR can sit on
  `main` with a latent regression flagged in the run but not
  blocking. Mitigation: `mainnet-gate.yml` re-runs the full
  regression on every push / PR to `release/**` and every `v*` tag
  push, so a regression that reaches `main` can't reach a
  deployable ref. (The `release-notes-drift` workflow is unrelated
  — it warns on missing docs updates and does not exercise the
  forge test suite.)

## Alternatives considered

**Alternative A — Single contracts CI job (`forge test` =
everything, required)**: Rejected. Forces every PR to pay 10-15
min cold or wait for cache warm; punishes docs PRs.

**Alternative B — Two-job split, both jobs run independently
(parallel, both required)**: Rejected. Two cold rebuilds per
workflow run = 20+ min wasted compute. The serialized variant
saves half of that without sacrificing coverage.

**Alternative C — Path-filter required jobs run unconditionally
(no `if:` guard)**: Rejected. Workflow-skip-as-success is the
specific GitHub-native mechanism that makes the path-filter design
work with required-status-checks; running the jobs unconditionally
defeats the purpose.

**Alternative D — `contracts-full` required (blocking)**:
Rejected for the PR-throughput reason. The `mainnet-gate` net
provides the safety; PR-merge blocking on the full regression is
not necessary.

## References

- Workflow: [`.github/workflows/ci.yml`](../../.github/workflows/ci.yml),
  [`.github/workflows/mainnet-gate.yml`](../../.github/workflows/mainnet-gate.yml)
- Doc: [`docs/internal/ProjectProcedures.md`](../internal/ProjectProcedures.md) §7
- Pre-deploy gate: [`contracts/script/predeploy-check.sh`](../../contracts/script/predeploy-check.sh)
- Deploy-sanity suite: [`contracts/test/deploy/`](../../contracts/test/deploy/)
- Related PRs (cache-key v1 → v4 evolution): #80, #84, #86, #87, #88, #90
