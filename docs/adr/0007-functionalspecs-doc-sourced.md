# ADR-0007: FunctionalSpecs are sourced from documents, never transcribed from code

**Status:** Accepted
**Date:** 2026-05 (FunctionalSpecs convention; ADR backfilled 2026-05-20)

## Context

A non-trivial protocol needs a **specification of intended behaviour**
that auditors can compare the code against. Without one, "is this a
bug?" reduces to "this is what the code does, so this is what the
code is meant to do" — a closed loop that defines bugs out of
existence.

Many projects produce a spec by reading the code and transcribing it
into prose. This is the FAST path: the spec ends up exhaustive,
matches the code 1:1, and reads as "documentation of what we built".
It is also the WRONG path. A code-derived spec cannot detect a code
bug — by construction. If the code over-restricts a Tier-1 LTV
ceiling because of an off-by-one in the threshold check, the
code-derived spec dutifully writes "Tier-1 LTV is capped at 49.99%"
and the bug is laundered into the spec.

The right shape is the **independent oracle**: a spec sourced from
the documents (design docs, decision records, whitepaper, owner
intent) — INDEPENDENT of the contract code, which is the thing under
test. Divergences between code-observed behaviour and the
document-sourced spec become **candidate bugs**, not silent
reconciliations.

Vaipakam went through three iterations on this before landing on the
current rule. The third iteration is the rule that stuck.

## Decision

**`docs/FunctionalSpecs/<domain>.md` is the code-independent
specification of what the platform is INTENDED to do — the test
oracle.** Three load-bearing rules:

1. **Spec is sourced from documents, never transcribed from code.**
   When a behaviour-changing PR ships, the author *states their
   intent* in the relevant FunctionalSpec file — they do NOT
   transcribe the code they just wrote. If that code has a bug,
   the spec stays correct and the divergence is detectable.

2. **Code-observed behaviour enters the spec ONLY via an explicit
   intent-decision from the project owner.** Not silently. If
   review surfaces a divergence between code and spec, it gets
   appended to `docs/FunctionalSpecs/_CodeVsDocsAudit.md` as a
   "candidate bug" pending triage. Triage outcomes:
   - **Code is wrong** → file a bug-fix card; when fixed, the
     finding moves to Resolved.
   - **Spec is wrong** → owner provides an explicit intent-decision
     in writing; the spec doc is updated; the finding moves to
     Resolved citing the intent-decision.
   There is NO third path where the spec is silently rewritten to
   match the code.

3. **The FunctionalSpec is updated in the SAME PR as the
   behaviour-changing code change.** A separate "update specs
   later" step drifts. The release-notes drift workflow
   (`.github/workflows/release-notes-drift.yml`) warns on merges
   that change `contracts/src/` or `apps/` but touch no
   `docs/FunctionalSpecs/` — same backstop the release-note
   fragments have.

`docs/FunctionalSpecs/README.md` carries the full doc-set definition,
domain slicing, and conflict-precedence rule. The Codex audit-loop
that will eventually consume `_CodeVsDocsAudit.md` is deferred (see
the meta-discussion on PR #91); when adopted, it will be a Codex
adversarial review comparing the changed contracts against the
relevant FunctionalSpec.

## Consequences

**Positive**

- The spec is **falsifiable** — code-vs-spec divergences are
  candidate bugs, not silent matches. This is the only way an
  audit oracle can do its job.
- Doc-sourcing forces the project to articulate intent as a
  primary artifact, separately from the implementation. Helpful
  beyond audit — onboarding, decision-making, and external
  communication all benefit.
- The "same PR" rule makes drift impossible by construction (in
  the limit; the drift-warning backstop catches honest mistakes).

**Negative / accepted costs**

- Authoring takes longer than code-transcription would. The
  author has to think about "what did I MEAN to build" separately
  from "what does this code do".
- Conflicts between code and spec are unavoidable as the project
  evolves. The `_CodeVsDocsAudit.md` register externalises these,
  which is good — but it requires triage discipline.
- The full baseline corpus (#76) is multi-session work that lags
  the code. Accepted: the baseline grows as PRs that touch each
  domain land, with the warning workflow nudging the per-domain
  update.

**Risks the decision creates**

- A diligent-looking but actually-code-transcribed spec defeats
  the whole shape. Mitigation: documented in
  `docs/FunctionalSpecs/README.md` and `CLAUDE.md`; PR-time review
  surfaces "did the author just transcribe the code?" as a
  Codex-review focus area going forward.
- The `_CodeVsDocsAudit.md` register grows over time. Mitigation:
  open-finding count IS audit-relevant — a growing list signals
  drift. Auditors will read this file directly.

## Alternatives considered

**Alternative A — Code-derived spec (default industry pattern)**:
Rejected for the reasons above — it cannot detect a code bug.
This is the alternative most projects pick, which is precisely
why most projects' specs aren't useful as audit oracles.

**Alternative B — Auto-generated spec from NatSpec / docstrings**:
Rejected. NatSpec is a useful per-function annotation but is
ALSO code-sourced; auto-generating from it has the same defect
as Alt A.

**Alternative C — Spec lives entirely outside the repo (in
DesignsAndPlans or external docs)**: Rejected. Specs in
`docs/DesignsAndPlans/` get out of date even faster — they're
design *exploration*, written BEFORE the decision is ratified.
The FunctionalSpec is the *ratified-intent* version, lives
alongside the code, and is updated per-PR.

**Alternative D — Audit-firm-written spec**: An external auditor
writes the spec as part of an engagement. Rejected because
(a) it pushes the cost to audit time, which is precisely when
you want the spec to *already exist* so the auditor can use it;
(b) it transfers the intent-articulation responsibility off the
project, defeating the secondary benefits.

## References

- Convention: [`docs/FunctionalSpecs/README.md`](../FunctionalSpecs/README.md)
- Audit register: [`docs/FunctionalSpecs/_CodeVsDocsAudit.md`](../FunctionalSpecs/_CodeVsDocsAudit.md)
- Drift workflow: [`.github/workflows/release-notes-drift.yml`](../../.github/workflows/release-notes-drift.yml)
- Policy summary: [`CLAUDE.md`](../../CLAUDE.md) § "Functional specs"
- Related: Issue [#76](https://github.com/vaipakam/vaipakam/issues/76)
  (baseline FunctionalSpecs corpus; ongoing track)
