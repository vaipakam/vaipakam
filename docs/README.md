# `docs/` — Vaipakam documentation tree

The living documentation for Vaipakam. Different audiences land in different subtrees; this README is the orientation layer that points them to the right one.

## Where to start, depending on what you're reading for

| You want… | Read |
|---|---|
| **The canonical technical whitepaper** | [`apps/www/src/content/whitepaper/Whitepaper.en.md`](../apps/www/src/content/whitepaper/Whitepaper.en.md) (lives in `apps/www`, not here — it's the file the website renders) |
| **Operator-side conventions** — git procedures, PR workflow, CI gates, branch protection, project-board discipline, release notes + functional specs, milestones, the operator-handbook surface | [`docs/internal/ProjectProcedures.md`](internal/ProjectProcedures.md) |
| **Architectural decision rationale** — WHY a specific load-bearing choice was made (Diamond, no-KYC retail, CCIP migration, depth-tiered LTV, …) | [`docs/adr/`](adr/) — 9 ADRs + a template |
| **Domain terminology** | [`docs/GLOSSARY.md`](GLOSSARY.md) |
| **The code-independent intended-behaviour specification** | [`docs/FunctionalSpecs/`](FunctionalSpecs/) — the test oracle; sourced from documents, never transcribed from contract code (per ADR-0007) |
| **Design exploration + plans** — proposals in flight, not yet ratified | [`docs/DesignsAndPlans/`](DesignsAndPlans/) |
| **Release narrative + per-PR fragments** | [`docs/ReleaseNotes/`](ReleaseNotes/) — fragments in `unreleased/`, dated files at the root |
| **Incident response procedures** | [`docs/ops/IncidentRunbook.md`](ops/IncidentRunbook.md) |
| **Admin key custody + pause levers** | [`docs/ops/AdminKeysAndPause.md`](ops/AdminKeysAndPause.md) |

## Sub-directory map

```
docs/
├── README.md                    ← this file
├── GLOSSARY.md                  ← project-specific domain terms
├── adr/                         ← Architecture Decision Records (numbered)
│   ├── README.md                ← ADR index + how to file a new one
│   ├── _template.md             ← Context / Decision / Consequences / Alternatives
│   └── NNNN-<slug>.md           ← one per ratified decision
├── FunctionalSpecs/             ← code-independent intent spec
│   ├── README.md                ← doc-set + domain slicing + precedence rules
│   ├── _CodeVsDocsAudit.md      ← code-vs-spec divergence register
│   └── <domain>.md              ← per-domain spec docs
├── DesignsAndPlans/             ← in-flight design exploration
│   └── <name>.md
├── ReleaseNotes/                ← per-release narratives
│   ├── README.md
│   ├── unreleased/              ← per-PR fragments waiting to be folded
│   └── ReleaseNotes-YYYY-MM-DD.md
├── internal/                    ← operator handbook + planning notes
│   ├── ProjectProcedures.md     ← the load-bearing handbook
│   ├── PinnedIssueDrafts.md     ← Pinned Issue bodies (source for live Issues)
│   └── …
└── ops/                         ← incident + operations docs
    ├── IncidentRunbook.md
    └── AdminKeysAndPause.md
```

## Living-doc rules

Three orthogonal axes, each with its own update cadence:

1. **Release notes** — every behaviour-changing PR carries a fragment under `ReleaseNotes/unreleased/`; folded into the dated file at end-of-day via `bash docs/ReleaseNotes/assemble.sh`. See [`ProjectProcedures.md` §6.1](internal/ProjectProcedures.md).
2. **FunctionalSpecs** — every behaviour-changing PR also updates the relevant `docs/FunctionalSpecs/<domain>.md` in the same diff. **Specs are sourced from documents, never transcribed from code** (ADR-0007). See [`ProjectProcedures.md` §6.3](internal/ProjectProcedures.md).
3. **ADRs** — appended when a load-bearing architectural decision is ratified. Never edit a past ADR; supersede via a new one. See [`adr/README.md`](adr/README.md).

A CI drift-check (`.github/workflows/release-notes-drift.yml`) warns on merges that change `contracts/src/` or `apps/` but touch neither release-notes nor FunctionalSpecs. Non-blocking — the drift surfaces in the Actions tab.

## For auditors

Read in this order:

1. The canonical whitepaper (link above) — system overview.
2. [`adr/`](adr/) — 9 decision records covering the load-bearing choices.
3. [`FunctionalSpecs/`](FunctionalSpecs/) — the intent specification (the test oracle).
4. [`FunctionalSpecs/_CodeVsDocsAudit.md`](FunctionalSpecs/_CodeVsDocsAudit.md) — code-vs-spec divergences open for triage.
5. [`internal/ProjectProcedures.md`](internal/ProjectProcedures.md) — operator handbook (12 sections + 5 subsections in §6).
6. [`../SECURITY.md`](../SECURITY.md) + [`ops/IncidentRunbook.md`](ops/IncidentRunbook.md) — security posture.

The [`../audits/`](../audits/) directory carries finalized audit deliverables when they exist; pre-engagement findings flow through the `audit_finding` Issue template under [`../.github/ISSUE_TEMPLATE/`](../.github/ISSUE_TEMPLATE/).

## Related

- [`../README.md`](../README.md) — repo root product overview for quick orientation. The canonical technical whitepaper is [`../apps/www/src/content/whitepaper/Whitepaper.en.md`](../apps/www/src/content/whitepaper/Whitepaper.en.md).
- [`../CLAUDE.md`](../CLAUDE.md) — AI-instruction twin of this directory's handbook.
- [`../AGENTS.md`](../AGENTS.md) — shared agent-guidance file (Codex review commands).
