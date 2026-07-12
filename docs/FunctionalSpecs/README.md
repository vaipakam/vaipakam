# Functional Specs — the platform's intended-behaviour specification

`docs/FunctionalSpecs/` is the **code-free specification of what the
Vaipakam platform is *intended* to do**. It is the single place to learn
the platform's functional behaviour, and it is written so it can serve
as a **test oracle** — every behavioural statement should be concrete
enough to turn into a test case.

## The load-bearing rule: this spec is implementation-independent

These docs describe **intended** behaviour, sourced from the project's
**documents** — never transcribed from the contract code. This is
deliberate and non-negotiable:

> A spec used to *test* the code must be independent of the code. If the
> spec were derived from the code, a test written against it could only
> ever confirm "the code does what the code does" — it could not catch a
> bug, and a real bug would be transcribed into the spec as if it were
> correct, then *locked in* by the tests.

The code is the thing **under test**. It is never the **source** of this
spec. Where the code and this spec disagree, that is a finding — see the
divergence audit below.

## What this corpus is — and is not

| Doc family | Question it answers | Genre |
| --- | --- | --- |
| `docs/FunctionalSpecs/` (this folder) | "What is the platform **meant** to do?" | Specification — the test oracle |
| `docs/FunctionalSpecs/_CodeVsDocsAudit.md` | "Where does the **code** diverge from the spec?" | Divergence findings |
| `docs/ReleaseNotes/` | "What **changed**, in which PR, and why?" | Change history |
| `docs/DesignsAndPlans/` | "What did we **consider**, and why this choice?" | Design exploration |

Release notes are a changelog — never deleted or rewritten. Design docs
capture intent and rejected alternatives. The Functional Specs are the
distilled statement of intended behaviour.

## Rules for every doc in this folder

1. **Implementation-independent.** Source behaviour from the documents
   (the up-to-date FunctionalSpecs docs, `DesignsAndPlans`, and
   `ReleaseNotes`) — *never* by reading the contract code. (See the
   load-bearing rule above.)
2. **No code.** No Solidity, no TypeScript, no ABIs, no snippets. Plain
   English describing observable behaviour.
3. **Intended behaviour.** Describe what the platform is *meant* to do.
   No "previously X, now Y" — that is what the release notes are for.
4. **Testable.** Prefer enumerated, observable behavioural statements —
   "On accept, the loan initiates only if the health factor is at least
   the configured minimum; otherwise the call is rejected." Each
   statement should map cleanly to a test case.
5. **Audience-neutral.** A new engineer, an auditor, or a QA designer
   should each be able to use these docs without reading the code.

## Resolving conflicts *between documents*

When the source documents disagree about intended behaviour:

1. The up-to-date `docs/FunctionalSpecs/` docs are taken as current
   intent. `docs/DesignsAndPlans/` docs may be stale.
2. On a `FunctionalSpecs` vs `DesignsAndPlans` conflict, consult
   `docs/ReleaseNotes/` to see which is the more recent decision.
3. If still unresolved, `docs/FunctionalSpecs/` holds the final say.
4. Genuinely ambiguous cases are resolved case-by-case, not by rule.

This precedence decides *which document states the intent*. It is a
separate question from whether the **code** matches that intent — see
the audit.

## The divergence audit — `_CodeVsDocsAudit.md`

The spec is the intended behaviour; the code is the reality. Comparing
them is how the platform finds **buggy code** (build ≠ intent) and
**stale docs** (intent moved, doc didn't).

- Code behaviour is derived **on demand** for the audit — by reading the
  contracts at audit time. It is **not** kept as a second maintained
  corpus (that would just drift; the code is always there to read).
- `_CodeVsDocsAudit.md` records **only the conflicts** — one entry per
  divergence: the behaviour, what the code does, what the spec says, the
  `ReleaseNotes` recency check, a verdict (**code bug** / **stale doc** /
  **ambiguous**), and a proposed fix. Reviewed case-by-case.

**The contamination safeguard.** When the audit finds *"the code does X,
the spec is silent"*, X does **not** silently enter the spec. It is
logged as a finding; a human decides "X is intended" (then the spec
gains X *as confirmed intent*) or "X is a bug" (then it is fixed, and the
spec is untouched). **Code-observed behaviour only ever enters the spec
through an explicit human intent-decision** — never by transcription.
That gate is what keeps bugs out of the oracle.

## The doc set

**Existing (platform-wide):**

- `ProjectDetailsREADME.md` — architecture overview + operational
  examples for developers.
- `TokenomicsTechSpec.md` — VPFI token economics + multi-chain model.
- `WebsiteReadme.md` — website / product UX.
- `Alpha02ConnectedApp.md` — alpha02 connected-app behaviour, including guided
  flows, data freshness, Rate Desk, token safety, support, alerts, and
  operational controls.

The two cross-cutting **analysis matrices** (action × actor) now live under
`docs/DesignsAndPlans/` — they are code-derived analysis of how the live gates
and the keeper boundary behave per action, not code-independent intended-behavior
specs, so they belong with the design/analysis docs rather than the
test-oracle FunctionalSpecs:

- [`docs/DesignsAndPlans/SanctionsAndTermsGateMatrix.md`](../DesignsAndPlans/SanctionsAndTermsGateMatrix.md)
  — cross-cutting action matrix for the two live compliance gates on the retail
  deploy: address-level sanctions screening (Tier-1 block / Tier-2 wind-down /
  fail-open) and the versioned Terms-of-Service gate, per action family, plus
  the UI banner / Terms-prompt rules.
- [`docs/DesignsAndPlans/KeeperAuthorityMatrix.md`](../DesignsAndPlans/KeeperAuthorityMatrix.md)
  — cross-cutting matrix of keeper delegation authority: the allowed delegated
  lifecycle surface vs. the no-custody boundary (a keeper, even with
  `KEEPER_ACTION_ALL`, can never claim, withdraw, transfer position NFTs, or
  redirect funds), plus the permissionless-trigger exception.

**Planned — per-domain functional specs** (authored by the baseline
epic; see below). One doc per functional domain:

- Offers — creation, acceptance, cancellation, range-order matching
- Loans — initiation, lifecycle, loan-detail reads
- Repayment — full / partial repay, NFT daily deductions, late fees,
  periodic interest settlement
- Defaults & Liquidation — time-based default, HF-based liquidation,
  internal-match liquidation, the flash-loan liquidation path
- Risk, Oracle & Liquidity — health factor / LTV, price feeds, liquidity
  classification, depth-tiered LTV
- Vault — per-user vault proxies, stuck-vault recovery
- Position NFTs — offer / loan position NFTs and their metadata
- VPFI Token, Discounts, Staking & Rewards — fee discounts, staking
  rewards, interaction rewards
- Cross-Chain — the CCIP messenger, mirror token, buy adapter/receiver,
  reward messenger
- Treasury & Founder Distribution
- Compliance — sanctions screening (KYC / country-pair gates are dormant
  on the retail deploy — see the project CLAUDE.md)
- Admin, Governance & Config — timelock, pause / guardian, kill-switches,
  protocol configuration

This list is a starting proposal; the baseline epic may re-slice it.

## How the corpus stays current — the maintenance rule

**Every behaviour-changing PR updates the relevant
`docs/FunctionalSpecs/<domain>.md` in the same diff as its release-note
fragment.** The author writes the **intended** behaviour they set out to
build — *stating intent* — and never transcribes the code they just
wrote. (If that code has a bug, the spec stays correct, and the
divergence audit catches `code ≠ spec` later.)

The release-note fragment is the "what changed" lens; the Functional
Spec edit is the "intended current behaviour" lens. A non-blocking CI
check (`.github/workflows/release-notes-drift.yml`) warns in the Actions
tab if a merge changed `contracts/src/` or `apps/` but touched no
`docs/FunctionalSpecs/` doc.

## Baseline

The per-domain specs above do not exist yet. Authoring them **from the
documents** — the up-to-date FunctionalSpecs docs, `DesignsAndPlans`, and
`ReleaseNotes` (per the conflict-precedence above), **not** from the
contract code — is a tracked epic, **Issue #76**, done domain by domain
(one focused PR per domain). Each domain's `_CodeVsDocsAudit.md` section
is produced alongside its spec, by comparing the new spec against the
code at that time. Until a domain's spec exists, its intended behaviour
is described — less tidily — across the release notes and the
`DesignsAndPlans/` docs.
