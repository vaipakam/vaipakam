# ADR-0011: CI compile scope narrowed to the `cifast` foundry profile; full regression is operator-local

**Status:** Accepted (supersedes [ADR-0006](0006-three-tier-ci-split.md))
**Decision implemented in:** #295 (2026-05-27, `cifast` profile + CI scope narrowing) + #297 (2026-05-27, `contracts-full` + `gas-snapshot` removed from `ci.yml`; `Protect main` ruleset updated).
**ADR landing in:** #298 / #299 (2026-05-28, this doc-cascade PR — the structural change had already merged; this ADR backfills the audit record).

## Context

[ADR-0006](0006-three-tier-ci-split.md) adopted a three-tier CI split:
`contracts-fast` (required, ~12 deploy-sanity tests) ran serialized
ahead of `contracts-full` (informational, ~2,012-test full regression),
with `mainnet-gate` re-running the full regression on the release
track. The two PR-side jobs shared a single cold compile via cache
hand-off; `contracts-full`'s "informational" status meant a red
result was visible but didn't block merge.

That shape worked until the test corpus grew. Re-measured on
2026-05-27 against the head of the test tree, the **cold-build peak
RSS for the full default-profile compile is ~17.7 GB** — over the
**16 GB ceiling** GitHub-hosted `ubuntu-latest` runners enforce. PR
#288 (T-086 step 5) was the first to trip it routinely: CI killed
mid-compile with no test signal. Two follow-ups confirmed the cap is
structural, not a transient:

- The per-test-artifact cost is ~uniform regardless of own LOC
  because every `.t.sol` pulls full facet bytecode through dynamic
  Diamond casts. Inheritance / composition / slim-base mixin
  refactors landed marginal savings (-0.42 GB / 7 tests for slim
  base; -0.22 GB for full composition migration) — neither closed
  the ~1.7 GB headroom gap.
- Per-path `viaIR` is structurally infeasible: Solidity's compile
  unit is the import closure. A `[profile.x] via_ir = false`
  segment that targets `test/**` only would still pull every
  imported `src/` file into the same unit (every test imports
  facets via dynamic Diamond casts plus library helpers), and the
  unit's compile flags apply to ALL files in it. So either the
  whole unit goes through `viaIR` (the production setting and the
  current default profile) or none of it does — which would lose
  production-parity bytecode. Tested in a throwaway worktree on
  2026-05-27; `forge build` rejected the mixed config.

A non-self-hosted runner remains the explicit operator decision:
GitHub-hosted `ubuntu-latest` is free for public repos and the
maintenance burden of a self-hosted runner — image upkeep, secret
hygiene, network-egress posture, the contributor-PR fork-runner
sandboxing the GitHub-hosted path gives us for free — is not worth
the speedup at the current ~5 contracts PRs/week cadence. If that
cadence climbs above ≥5 contracts PRs/week sustained, or
audit-prep adds a regular heavy-test cycle, revisit this. So the
constraint is real: at ubuntu-latest's 16 GB ceiling, the
default-profile full forge regression cannot run on GitHub Actions
in any per-PR form, regardless of how we split it.

## Decision

Narrow CI's contracts compile scope per-job via a dedicated foundry
profile, and remove the full-regression jobs from per-PR CI entirely.
Full regression stays operator-local — at end-of-step + at
mainnet-deploy preflight via `predeploy-check.sh --full`. The
release-track safety net (`mainnet-gate`) is unchanged.

Concretely (lands with PRs [#295](https://github.com/vaipakam/vaipakam/pull/295)
closes #290 and [#297](https://github.com/vaipakam/vaipakam/pull/297)
closes #296):

1. **New `cifast` foundry profile** in `contracts/foundry.toml`. It
   compiles `src/` + `script/` + `lib/` + `test/deploy/**` +
   `test/scenarios/**` + `test/mocks/**` + `test/SetupTest.t.sol` +
   `test/HelperTest.sol`. Every other `test/*.t.sol` is enumerated in
   the profile's `skip = [...]` list; `test/{invariants,fork,token}/**`
   are skipped wholesale. Measured cold: **3.17 GB / 5:22** (well
   under the 16 GB ceiling). viaIR + `optimizer_runs = 200` are kept
   ON so the deploy-sanity + positive-flow surface compiles with
   production-identical bytecode.
2. **`contracts-fast`** runs under `FOUNDRY_PROFILE=cifast`. It
   executes the deploy-sanity suite via `predeploy-check.sh` AND a
   new positive-flow step `forge test --match-path
   "test/scenarios/*.t.sol"`. Timeout: 15 min (was 45).
3. **`contracts-full`** (the informational full-regression job) and
   **`gas-snapshot`** (the gas-diff job) are **deleted entirely**
   from `ci.yml`. No `workflow_dispatch` fallback, no weekly cron
   schedule — the structural RSS overrun makes their CI presence a
   footgun even when gated.
4. **`Slither static analysis`** and **`Build docs`** also run under
   `FOUNDRY_PROFILE=cifast` — they only need `src/` compiled, and
   the smaller compile graph drops their cold cost too.
5. **`mainnet-gate`** keeps the `bash script/predeploy-check.sh
   --full` step in place on push to `release/**`, PR targeting
   `release/**`, every `v*` tag push, and `workflow_dispatch`. It
   runs on the same `ubuntu-latest` runner under the default
   foundry profile, so it shares the 16 GB ceiling. **It has NOT
   been exercised on the current test corpus** (no release-track
   refs exist yet on this repo). Before the first push to a
   `release/**` branch or the first `v*` tag, the operator must
   either: (a) confirm `predeploy-check.sh --full` fits on
   `ubuntu-latest` for that release commit's corpus, or (b) move
   the gate to a self-hosted runner / a different scheduled path.
   This ADR documents the gap so it's not discovered at cutover.
   The narrow trigger set (release branches + version tags, not
   every PR) is what makes the unknown tolerable for now:
   the per-PR loop is unblocked by the `cifast` change above, and
   the operator-local end-of-step full run is the real defence
   on contracts changes day-to-day.
6. **`Protect main` ruleset** updated to drop `contracts-full` +
   `Gas snapshot diff` from `required_status_checks`. The required
   set is now: `contracts-fast` + `detect-changes` + `workspaces` +
   `Build docs` + `Slither static analysis`.

## Consequences

**Positive**

- CI clears the 16 GB ubuntu-latest ceiling cold (~3.17 GB vs 17.7 GB);
  no more silent kills mid-compile.
- Per-PR feedback wall-clock drops from ~25-30 min cold to ~5-10 min
  cold on the contracts surface.
- The deploy-sanity + positive-flow surface is what mainnet-deploy
  actually depends on for "is the cut safe" — narrowing CI to that
  scope keeps the gate's promise aligned with what it can prove.
- Slither + Build docs no longer pay for compiling 90+ test files
  they don't need.

**Negative / accepted costs**

- Full regression cannot run on GitHub Actions in any per-PR form.
  The operator runs it locally at end-of-step + mainnet preflight;
  the release-track `mainnet-gate` workflow holds the
  `predeploy-check.sh --full` step but shares the same 16 GB
  ceiling and has not yet been validated on the current corpus
  (see the "release-track gate's runner constraint" note above —
  operator action required before the first release/v* push).
- A non-deploy-sanity / non-positive-flow regression introduced by
  a PR will NOT be caught by CI. Caught instead by: (a) the
  end-of-step local full run (operator), (b) `mainnet-gate` on the
  release/v-tag push, (c) CodeQL / Slither weekly runs for static
  patterns, (d) Codex review.
- The `cifast` `skip = [...]` list enumerates every excluded test
  file. New `test/*.t.sol` files default to being COMPILED by
  `cifast` (a glob can't predict the future). When adding a new
  test that doesn't earn its compile cost in the CI scope, also
  append it to `skip = [...]` — flagged in the
  `feedback_facet_addition_checklist.md` operator memory.

**Risks the decision creates**

- "End-of-step full regression is operator-local" depends on the
  operator running it. Mitigations: `predeploy-check.sh --full` is
  wired into `deploy-mainnet.sh` preflight step `[1b]`; `mainnet-gate`
  also forces it; the operator habit is reinforced by the post-merge
  release-notes / ToDo / Project-card definition-of-done.
- Skip-list drift: if a contributor adds 30 test files and forgets
  to update `skip = [...]`, the cifast cold-build RSS creeps. Watch
  the time / RSS budget on `contracts-fast` cold runs; trim the
  scenarios subset or move files out of the cifast scope if it
  threatens the ceiling again.

## Alternatives considered

**Alternative A — Self-hosted runner**: Rejected. The maintenance
burden (runner-image upkeep, secret hygiene, network-egress posture,
contributor-PR fork-runner sandboxing) is not worth the speedup at
the current ~5 contracts PRs/week cadence. Revisit if cadence climbs
or audit prep adds a regular heavy-test cycle.

**Alternative B — Per-path viaIR off on tests**: Rejected as
structurally infeasible (per the "constraint" section above):
Solidity's compile unit is the import closure, so a `via_ir = false`
on `test/**` would still need `src/` files in the same unit, and a
unit's compile flags apply uniformly. Tested in a throwaway
worktree; `forge build` rejected the mixed config.

**Alternative C — Slim-base / composition refactor of the test
suite**: Measured marginal (≤0.4 GB savings); doesn't close the
~1.7 GB headroom gap to 16 GB. The structural cost is dynamic-cast
facet imports per test, which composition doesn't change.

**Alternative D — `contracts-full` informational-only, no
`workflow_dispatch`, no weekly cron**: Considered as a softer
landing in #297 (PR #295's first cut gated it to `workflow_dispatch`
only). Rejected as a footgun — an informational red signal on a
job that physically can't pass on `ubuntu-latest` invites either
ignored noise or repeated manual retries. Cleaner to delete it.

**Alternative E — Keep `gas-snapshot` as a non-blocking
informational check**: Rejected for the same reason as D. Gas-diff
visibility moves to operator-local `forge snapshot --diff` at
end-of-step.

## References

- Issue: [#290](https://github.com/vaipakam/vaipakam/issues/290) (CI scope tightening), [#296](https://github.com/vaipakam/vaipakam/issues/296) (remove contracts-full + gas-snapshot), [#298](https://github.com/vaipakam/vaipakam/issues/298) (doc cascade)
- PRs: [#295](https://github.com/vaipakam/vaipakam/pull/295), [#297](https://github.com/vaipakam/vaipakam/pull/297)
- Workflow: [`.github/workflows/ci.yml`](../../.github/workflows/ci.yml), [`.github/workflows/mainnet-gate.yml`](../../.github/workflows/mainnet-gate.yml)
- Profile: [`contracts/foundry.toml`](../../contracts/foundry.toml) → `[profile.cifast]`
- Pre-deploy gate: [`contracts/script/predeploy-check.sh`](../../contracts/script/predeploy-check.sh)
- Related ADR: [ADR-0006](0006-three-tier-ci-split.md) (superseded by this one)
