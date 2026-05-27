# Pinned Issue draft bodies

Content for the three Pinned Issues described in
[`ProjectProcedures.md §5.6`](ProjectProcedures.md#56-milestones--pinned-issues).
Committed here so the wording is reviewable in version control before
the Issues are filed + pinned on GitHub.

## Maintaining these drafts

When the Pinned Issues need to be updated (a new milestone opens, the
contribution process changes, the project's strategic state shifts):

1. Update the relevant draft section in this file via a normal PR.
2. After the PR merges, copy the updated body into the live Pinned
   Issue on GitHub via "Edit" on the Issue.

The drafts here are the **source of truth**; the live GitHub Issues
are render targets. This makes the wording auditable (PR history)
rather than living only as opaque "Edit" actions on GitHub.

---

## Pin slot 1 — "Read this first: audit context"

**Title for the GitHub Issue:** `Read this first: audit context`

**Labels:** `documentation`

**Body (paste verbatim into the GitHub Issue body):**

> This Issue is **pinned** as a permanent orientation for anyone landing
> on the repo cold — auditors, security researchers, ecosystem
> integrators, new contributors. Skim this once; it points at everything
> load-bearing.
>
> ### Where we are in the roadmap
>
> | Milestone | Status | Tracks |
> |---|---|---|
> | [`audit-prep`](../milestone/1) | **Current** | Pre-audit hardening — branch protection, signed commits, mainnet-gate workflow, ADRs, glossary, SECURITY.md, CodeQL + Slither static analysis, Cloudflare posture, dependency triage. |
> | [`audit-1`](../milestone/2) | Pending | Third-party audit engagement window. |
> | [`audit-1-fixes`](../milestone/3) | Pending | Findings remediation from audit-1. |
> | [`mainnet-cutover`](../milestone/4) | Pending | The cutover runbook execution — testnet → mainnet on every chain. |
> | [`post-mainnet-v1.1`](../milestone/5) | Pending | Deferred items + feature work post-launch. |
>
> ### Where to start, depending on your role
>
> **Auditors**:
> 1. [`apps/www/src/content/whitepaper/Whitepaper.en.md`](../blob/main/apps/www/src/content/whitepaper/Whitepaper.en.md) — canonical technical whitepaper.
> 2. [`docs/adr/`](../tree/main/docs/adr) — Architecture Decision Records.
> 3. [`docs/FunctionalSpecs/`](../tree/main/docs/FunctionalSpecs) — code-independent specification.
> 4. [`docs/internal/ProjectProcedures.md`](../blob/main/docs/internal/ProjectProcedures.md) — operator handbook.
> 5. [`SECURITY.md`](../blob/main/SECURITY.md) — security posture + private disclosure channels.
> 6. [`audits/`](../tree/main/audits) — where finalized audit deliverables land.
>
> **Ecosystem integrators**:
> 1. [`packages/contracts/src/abis/`](../tree/main/packages/contracts/src/abis) — per-facet ABI JSONs.
> 2. [`packages/contracts/src/deployments.json`](../blob/main/packages/contracts/src/deployments.json) — consolidated per-chain deployment data.
> 3. [`vaipakam/vaipakam-keeper-bot`](https://github.com/vaipakam/vaipakam-keeper-bot) — public reference keeper bot.
> 4. [GitHub Releases](../releases) — tagged artifact bundles.
>
> **Contributors**:
> 1. [`CONTRIBUTING.md`](../blob/main/CONTRIBUTING.md).
> 2. [`good first issue` cards](../issues?q=is%3Aopen+label%3A%22good+first+issue%22).
> 3. [`CODE_OF_CONDUCT.md`](../blob/main/CODE_OF_CONDUCT.md).
>
> ### Security disclosure
>
> **Do not** file security-sensitive findings as public Issues. Use either
> [GitHub Security Advisories](../security/advisories/new) (preferred) or
> email `security@vaipakam.xyz` (PGP key in `security.asc`). Full policy
> in [`SECURITY.md`](../blob/main/SECURITY.md).
>
> ### Project board
>
> Day-to-day work tracking: [`@vaipakam-labs`](https://github.com/users/vaipakam/projects/1).

---

## Pin slot 2 — "How to contribute"

**Title for the GitHub Issue:** `How to contribute`

**Labels:** `documentation`, `good first issue`

**Body (paste verbatim into the GitHub Issue body):**

> This Issue is **pinned** as the on-ramp for new contributors. The full
> guide is in [`CONTRIBUTING.md`](../blob/main/CONTRIBUTING.md); this
> Issue is the discoverable starting point.
>
> ### Three on-ramps depending on what you want to do
>
> **1. Fix a bug or land a small feature** — start with a
> [good-first-issue](../issues?q=is%3Aopen+label%3A%22good+first+issue%22).
>
> **2. Pick up a tracked card from the project board** —
> [`@vaipakam-labs`](https://github.com/users/vaipakam/projects/1).
> Filter by `Status = Backlog` + `help wanted`. Comment on the card
> ("I'll take this") before starting.
>
> **3. Propose something new** — open an Issue via the
> [feature_request template](../issues/new/choose). Discuss the shape
> BEFORE writing code.
>
> ### The PR workflow
>
> Full detail in [`CONTRIBUTING.md`](../blob/main/CONTRIBUTING.md) and
> [`docs/internal/ProjectProcedures.md`](../blob/main/docs/internal/ProjectProcedures.md).
> Key points:
>
> 1. Branch `feat/issue-<N>-<slug>` or `fix/issue-<N>-<slug>`.
> 2. Implement + test locally per the per-workspace typecheck list.
> 3. Sign commits — every commit to `main` must carry a valid signature.
> 4. Open the PR using the [PR template](../blob/main/.github/pull_request_template.md).
> 5. Address Codex findings (advisory; per [AGENTS.md](../blob/main/AGENTS.md)).
> 6. Maintainer merges via squash-merge.
>
> ### Conventions worth knowing
>
> - Solidity 0.8.29 + viaIR + optimizer 200 runs.
> - Custom errors, not `require` strings.
> - ERC20 approvals: exact amount, never `MaxUint256`.
> - Release notes: per-PR fragment in `docs/ReleaseNotes/unreleased/`.
> - Functional specs: every behaviour-changing PR updates
>   `docs/FunctionalSpecs/<domain>.md` in the same diff.
> - No `--delete-branch` on merge — branches kept for troubleshooting.
>
> ### Code of Conduct
>
> Participation means agreeing to the
> [Contributor Covenant Code of Conduct](../blob/main/CODE_OF_CONDUCT.md).
> Reports go to `support@vaipakam.com`.

---

## Pin slot 3 — "Vaipakam roadmap"

**Title for the GitHub Issue:** `Vaipakam roadmap`

**Labels:** `documentation`

**Body (paste verbatim into the GitHub Issue body):**

> This Issue is **pinned** as the high-level "where is the project going"
> view. Fine-grained tracking lives on the
> [`@vaipakam-labs`](https://github.com/users/vaipakam/projects/1)
> project board; this Issue is the strategic-cadence layer above it.
>
> ### Current state (as of last update)
>
> Vaipakam is in **pre-mainnet hardening**. The protocol is feature-
> complete for v1 scope (P2P lending + borrowing + NFT rentals + CCIP
> cross-chain). Remaining gates before mainnet:
>
> - [`audit-prep`](../milestone/1) — testnet rehearsals, audit-readiness
>   documentation, security tooling, Cloudflare posture, dependency
>   triage. **In flight.**
> - [`audit-1`](../milestone/2) — third-party audit engagement.
> - [`audit-1-fixes`](../milestone/3) — findings remediation.
> - [`mainnet-cutover`](../milestone/4) — testnet → mainnet rollout per
>   the cutover runbook.
>
> ### Milestone cadence
>
> | Milestone | Focus | Status |
> |---|---|---|
> | `audit-prep` | Pre-audit hardening | **Current** |
> | `audit-1` | Audit engagement | Pending |
> | `audit-1-fixes` | Findings remediation | Pending |
> | `mainnet-cutover` | Production deploy | Pending |
> | `post-mainnet-v1.1` | Deferred work, feature iteration | Pending |
>
> Each cardinal milestone gates the next.
>
> ### What does NOT move during audit-prep
>
> Three classes of work stay frozen during audit-prep + audit-1:
>
> - **Contract surface changes** that aren't bug fixes.
> - **Cross-chain layer changes** (CCIP deploy / configuration is the
>   only allowed cross-chain work and is operator-run).
> - **Solidity submodule pointer updates** that affect audited
>   bytecode.
>
> Off-chain code (Workers, frontend, docs, CI, ops) continues normally.
>
> ### After mainnet
>
> - Per-iteration sprints on the `@vaipakam-labs` board.
> - Quarterly mini-audits for diff-only review.
> - Annual major audit for the protocol surface.
>
> ### Where the detail lives
>
> - **Fine-grained work**: project board.
> - **Design exploration**: [`docs/DesignsAndPlans/`](../tree/main/docs/DesignsAndPlans).
> - **Architecture decisions**: [`docs/adr/`](../tree/main/docs/adr).
> - **Spec of intended behaviour**: [`docs/FunctionalSpecs/`](../tree/main/docs/FunctionalSpecs).
> - **Recent ships**: [`docs/ReleaseNotes/`](../tree/main/docs/ReleaseNotes).
>
> *Roadmap dates aren't published — they shift with audit-firm
> availability. Watch the milestones for the actual signal.*
