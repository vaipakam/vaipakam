## Doc cascade — remove stale `contracts-full` / `gas-snapshot` references (Issue #298)

Closes the documentation finish-line started by PR #297 (closes #296),
which removed the `contracts-full` and `gas-snapshot` jobs from
`ci.yml` and added the `cifast` foundry profile to slither. Several
files repo-wide still described the OLD three-tier CI shape in their
comments / prose. None of them held a live dependency on the removed
jobs (those would have broken the build) — but they DID mislead
anyone reading the operator-facing guidance.

### What changed

- **ADR-0011 added** — *CI compile scope narrowed to the `cifast`
  foundry profile; full regression is operator-local.* Captures the
  why (16 GB ubuntu-latest ceiling vs the 17.7 GB default-profile
  cold RSS, structural per-test artifact cost, no-self-hosted policy),
  the decision (delete `contracts-full` + `gas-snapshot` from CI; new
  `cifast` profile narrows scope to deploy-sanity + positive-flow +
  setup; mainnet-gate keeps the full regression on the release track),
  the consequences (release-track safety net unchanged; per-PR
  feedback drops from 25-30 min to 5-10 min cold), and the
  alternatives that were rejected (self-hosted runner, per-path viaIR,
  slim-base refactor, keeping the jobs as informational-only or
  workflow_dispatch-only).
- **ADR-0006 marked Superseded** by ADR-0011 with a banner pointing
  to the new ADR. The historical content stays intact as the audit
  trail of the previous decision.
- **`docs/adr/README.md`** — index entry updated for ADR-0006's new
  status and ADR-0011 added in sequence.
- **`.github/workflows/mainnet-gate.yml`** — top-of-file comment
  rewritten. The OLD text claimed "the routine PR CI runs both the
  deploy-sanity suite AND the full 2,012-test regression"; the new
  text describes the post-#296 reality (CI runs only the cifast
  surface; full regression is operator-local + this workflow on the
  release track). The actual workflow body — `bash
  script/predeploy-check.sh --full` at step `[1b]` — is unchanged,
  because the LIVE dependency was always fine.
- **`.github/workflows/contracts-docs.yml`** — comment ref to "the
  gas-snapshot workflow" removed; restored mention of `ci.yml`'s
  `contracts-fast` job as the warm-cache source.
- **`.github/workflows/ci.yml`** — two cache-key comment blocks
  (slither + Build docs) rewritten to drop their `contracts-full +
  gas-snapshot` mentions.
- **`docs/internal/PinnedIssueDrafts.md`** — milestone row for
  `audit-prep` cleaned up (was "CodeQL + Slither + gas-snapshot
  tracking"; now "CodeQL + Slither static analysis"). The
  gas-snapshot tracking moved operator-local with #296.
- **`docs/internal/ProjectProcedures.md`** — the same audit-prep row
  cleaned up; §7.1 "Protect main ruleset (monorepo)" rewritten from
  the 8-gate / contracts-full-as-informational shape to the 10-gate
  shape currently enforced by the ruleset (detect-changes,
  contracts-fast, workspaces, Build docs, Slither static analysis +
  the five hygiene gates), with a paragraph explaining where the
  full regression runs now (operator-local + mainnet-gate); §9.4
  `predeploy-check.sh` reference updated to point at mainnet-gate
  + the deploy script for the `--full` invocations; §10 hardening
  summary updated to the post-#296 state.
- **`docs/ops/DeploymentRunbook.md`** — preflight checklist row for
  gas-snapshot review marked "operator-local" so the runbook makes
  the post-#296 expectation explicit.

### What was deliberately NOT touched

- **`docs/ReleaseNotes/ReleaseNotes-2026-05-20.md` /
  `ReleaseNotes-2026-05-21.md`** — historical release notes; they
  describe what shipped on those dates and should not be rewritten.
- The `bash script/predeploy-check.sh --full` step inside
  `mainnet-gate.yml` — it's the LIVE dependency; only the prose
  surrounding it described the CI environment incorrectly.

### Why P3

Pure documentation update — no live job depended on the stale
references, so this PR isn't blocking anything. PR #297 ships the
structural fix; this is the operator-guidance finish-line.
