# `audits/` — third-party + internal audit reports

This directory holds **finalized audit deliverables** produced by
external auditors (firms or independent researchers) and the Vaipakam
team's responses to them. It is the canonical, version-controlled
record of the protocol's audit history.

## What lives here

```
audits/
├── README.md            ← this file
├── <auditor-slug>/      ← one subfolder per audit engagement
│   ├── README.md        ← engagement overview (scope, dates, commit pinned)
│   ├── findings.md      ← every finding, by severity, with disposition
│   ├── report.pdf       ← the auditor's final report (PDF / signed)
│   └── responses/       ← Vaipakam's responses + fix PRs per finding
│       └── F-001-<slug>.md
└── ...
```

Subfolder naming convention: `<lowercase-auditor>-<engagement-year>`,
e.g. `runtime-verification-2026`, `quantstamp-2026q3`.

## What does NOT live here

- **In-flight findings during an active engagement** — those go in
  the auditor's private workspace until the engagement is signed off.
  Only the FINAL version is checked in.
- **Internal pre-audit reviews** — that's
  `docs/FunctionalSpecs/_CodeVsDocsAudit.md` (code-vs-spec divergence
  log) and the per-PR Codex review history. The `audits/` directory
  is reserved for engaged third-party (or formal internal-by-a-
  different-team) review.
- **Bug bounties / pen-test reports** — those go in
  `docs/security/` (separate directory; not yet created).

## How findings link to fixes

Each finding has a unique ID assigned by the auditor (e.g.
`RV-VAI-001`). Vaipakam's response captures:

1. **Disposition** — Accepted (will fix) / Acknowledged (won't fix,
   with rationale) / Disputed (with rationale).
2. **Fix tracking** — the GitHub Issue # that tracks the fix (filed
   via the `.github/ISSUE_TEMPLATE/audit_finding.yml` template).
3. **Closing commit / PR** — the merge commit that resolves the
   finding, with the post-merge regression results.

The `audit_finding` Issue template (under `.github/ISSUE_TEMPLATE/`)
mirrors this shape so contributor-filed findings + auditor-filed
findings live in the same Issue surface and get triaged the same way.

## Audit cadence (target)

- **Pre-mainnet**: one full engagement before initial mainnet cutover
  (the `audit-prep` milestone tracks the work it depends on).
- **Major-version**: one full engagement before any major-version
  release (`v1.0`, `v2.0`).
- **Diff-only**: cheaper diff audits for incremental contract changes
  between major engagements, scoped to the changed surface.

The roadmap for each engagement is captured in
`docs/DesignsAndPlans/` and tracked on the
[`@vaipakam-labs`](https://github.com/users/vaipakam/projects/1)
project board under the `audit` label.

## For auditors landing here cold

Start with:

1. [`docs/internal/ProjectProcedures.md`](../docs/internal/ProjectProcedures.md)
   — the operator handbook. Section 12 carries the "conventions worth
   knowing" list.
2. [`docs/FunctionalSpecs/README.md`](../docs/FunctionalSpecs/README.md)
   — the intended-behaviour spec set (code-independent). This is the
   spec you should compare contract behaviour against; divergences
   are candidate bugs.
3. [`docs/DesignsAndPlans/`](../docs/DesignsAndPlans/) — design
   rationale for architectural choices.
4. [`CLAUDE.md`](../CLAUDE.md) — project-specific conventions,
   load-bearing constants, deploy-time gates, and security policies.
5. [`AGENTS.md`](../AGENTS.md) — shared agent-guidance file (Codex
   review commands, project-specific review profiles).

For private disclosure of an in-scope finding (before the formal
deliverable), follow the `docs/ops/IncidentRunbook.md` channel — NOT
a public GitHub Issue.
