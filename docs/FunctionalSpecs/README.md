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
| `docs/internal/FunctionalSpecsCodeVsDocsAudit.md` | "Where does the **code** diverge from the spec?" | Divergence findings |
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

## The divergence audit

The spec is the intended behaviour; the code is the reality. Comparing
them is how the platform finds **buggy code** (build ≠ intent) and
**stale docs** (intent moved, doc didn't).

- Code behaviour is derived **on demand** for the audit — by reading the
  contracts at audit time. It is **not** kept as a second maintained
  corpus (that would just drift; the code is always there to read).
- The [internal divergence audit](../internal/FunctionalSpecsCodeVsDocsAudit.md) records **only the conflicts** — one entry per
  divergence: the behaviour, what the code does, what the spec says, the
  `ReleaseNotes` recency check, a verdict (**code bug** / **stale doc** /
  **ambiguous**), and a proposed fix. Reviewed case-by-case.

The former [_CodeVsDocsAudit.md](_CodeVsDocsAudit.md) is a compatibility
index, so existing section links still lead to their preserved audit records.
Implementation guidance and historical test inventories are kept in
[internal implementation notes](../internal/FunctionalSpecImplementationNotes.md),
separate from functional requirements. Moving evidence does not resolve a
finding or endorse an observed behavior.

**The contamination safeguard.** When the audit finds *"the code does X,
the spec is silent"*, X does **not** silently enter the spec. It is
logged as a finding; a human decides "X is intended" (then the spec
gains X *as confirmed intent*) or "X is a bug" (then it is fixed, and the
spec is untouched). **Code-observed behaviour only ever enters the spec
through an explicit human intent-decision** — never by transcription.
That gate is what keeps bugs out of the oracle.

## The doc set

**Existing (platform-wide):**

- `ProjectDetailsREADME.md` — platform behavior, funds flows, lifecycle
  rules, authority, and deployment safety.
- `TokenomicsTechSpec.md` — VPFI token economics, fees, discounts, rewards,
  custody, capacity deposits, and the multi-chain model.
- `WebsiteReadme.md` — website / product UX.
- `Alpha02ConnectedApp.md` — connected-app behaviour (`apps/app`,
  `app.vaipakam.com`), including guided flows, data freshness, Rate Desk,
  token safety, support, alerts, and operational controls. The filename
  still carries the app's former `alpha02` name.

- [KeeperOperations.md](KeeperOperations.md) — operational duties, independent
  activation, transaction outcomes, reward automation, and deployment adoption.
  The owner's October 27 direction places execution on a separate always-on
  Oracle Cloud VM and operational state in a dedicated Cloudflare database.
  It describes the intended move without claiming migration completion.

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
- Cross-Chain — the CCIP messenger, mirror token, reward messenger and the
  remittance receivers (the fixed-rate buy adapter/receiver was removed in
  #687-A)
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

Except for the keeper operations spec, the proposed per-domain specs above
do not exist yet. Authoring them **from the
documents** — the up-to-date FunctionalSpecs docs, `DesignsAndPlans`, and
`ReleaseNotes` (per the conflict-precedence above), **not** from the
contract code — is a tracked epic, **Issue #76**, done domain by domain
(one focused PR per domain). Each domain's internal divergence-audit section
is produced alongside its spec, by comparing the new spec against the
code at that time. Until a domain's spec exists, its intended behaviour
is described — less tidily — across the release notes and the
`DesignsAndPlans/` docs.

## Release-note consolidation: August 13 through October 22, 2026

The following source map accounts for every dated file present in the inclusive
range. It identifies where functional decisions belong, rather than copying
change history into the requirements. The dated release notes remain unchanged.
A historical correction is read with its later superseding decision; later
owner decisions already recorded in the specs are retained.

In this table, Platform means [ProjectDetailsREADME.md](ProjectDetailsREADME.md),
App means [Alpha02ConnectedApp.md](Alpha02ConnectedApp.md), Website means
[WebsiteReadme.md](WebsiteReadme.md), Tokenomics means
[TokenomicsTechSpec.md](TokenomicsTechSpec.md), and Keeper means
[KeeperOperations.md](KeeperOperations.md). Internal notes identify supporting
verification or tooling history, not additional product requirements.

| Release source | Functional home | Decisions reconciled |
| --- | --- | --- |
| [2026-08-13](../ReleaseNotes/ReleaseNotes-2026-08-13.md) | App; tokenomics | Navigation, disclosure-bound consent, tariff ceilings, compensation recovery |
| [2026-08-14](../ReleaseNotes/ReleaseNotes-2026-08-14.md) | Platform; app | Service trust boundaries and advisory transaction simulation |
| [2026-08-15](../ReleaseNotes/ReleaseNotes-2026-08-15.md) | App; platform; tokenomics | Identity-scoped reads, live expiry, authenticated cross-chain peers, surplus-read authority |
| [2026-08-16](../ReleaseNotes/ReleaseNotes-2026-08-16.md) | Platform; website; tokenomics | Offer deadlines, live worked examples, retirement of an unbuilt cross-chain check |
| [2026-08-17](../ReleaseNotes/ReleaseNotes-2026-08-17.md) | Platform | Loan status observability and unchanged atomicity across component splits |
| [2026-08-18](../ReleaseNotes/ReleaseNotes-2026-08-18.md) | Platform; app; website | Sale settlement, seller bounds, configuration provenance and existing-loan fee snapshots |
| [2026-08-19](../ReleaseNotes/ReleaseNotes-2026-08-19.md) | Platform; app; website | Sale and transfer bookkeeping, reward migration, event identity and source metadata |
| [2026-08-20](../ReleaseNotes/ReleaseNotes-2026-08-20.md) | Tokenomics; platform; app; website | Claim and expiry parity, coordinated mirror claims, allocation headroom, wallet privacy |
| [2026-08-21](../ReleaseNotes/ReleaseNotes-2026-08-21.md) | App; website; tokenomics | Lender choices and loading states; historical rebate handling, later removed by #1980 |
| [2026-08-22](../ReleaseNotes/ReleaseNotes-2026-08-22.md) | Platform; app; tokenomics | Stale sale refusal, acceptance preflight, historical rebates and activation conditions |
| [2026-08-23](../ReleaseNotes/ReleaseNotes-2026-08-23.md) | Platform; app; website; keeper | Bounded offset holds, buyer-authored sale terms, published live rates and keeper workload |
| [2026-08-24](../ReleaseNotes/ReleaseNotes-2026-08-24.md) | Platform | Inherited treasury-fee admission and screening the current borrower |
| [2026-08-25](../ReleaseNotes/ReleaseNotes-2026-08-25.md) | Platform; tokenomics; website | Reviewed sale bounds, exact size and remaining term, transparent backing and unpriced launch |
| [2026-08-26](../ReleaseNotes/ReleaseNotes-2026-08-26.md) | Tokenomics; platform | Lender entitlement across settlement routes, activation evidence and binding operator choices |
| [2026-08-27](../ReleaseNotes/ReleaseNotes-2026-08-27.md) | Tokenomics; app; keeper | Claimable-time expiry, day-application reads, matcher share and connected-app identity |
| [2026-08-28](../ReleaseNotes/ReleaseNotes-2026-08-28.md) | App; keeper; platform | Versioned Terms gate, bounded scans and acknowledgement discovery |
| [2026-08-29](../ReleaseNotes/ReleaseNotes-2026-08-29.md) | App; website | Local data rights, preference-only updates, cross-tab Terms and signed server erasure |
| [2026-08-30](../ReleaseNotes/ReleaseNotes-2026-08-30.md) | App; website | Accurate collection disclosure, immutable Terms text and smart-wallet signed controls |
| [2026-08-31](../ReleaseNotes/ReleaseNotes-2026-08-31.md) | App; website; tokenomics; platform | Support redaction, session erasure, effective-tier meaning and preserved deployment settings |
| [2026-09-01](../ReleaseNotes/ReleaseNotes-2026-09-01.md) | App; website; tokenomics | Report preview, late-answer identity, perk absorption and broadcast safety |
| [2026-09-07](../ReleaseNotes/ReleaseNotes-2026-09-07.md) | App; website | Canonical app links and same-origin legacy recovery boundary |
| [2026-09-09](../ReleaseNotes/ReleaseNotes-2026-09-09.md) | Tokenomics; platform | Recorded reward roles and evidence-qualified custody observations |
| [2026-09-10](../ReleaseNotes/ReleaseNotes-2026-09-10.md) | App; website; platform | Public analytics and console, legacy-route recovery and lender close-out |
| [2026-09-11](../ReleaseNotes/ReleaseNotes-2026-09-11.md) | Platform; internal notes | Deployment verification refinements; no new user action |
| [2026-09-12](../ReleaseNotes/ReleaseNotes-2026-09-12.md) | App | Forced-close decision states and the block supporting them |
| [2026-09-13](../ReleaseNotes/ReleaseNotes-2026-09-13.md) | Tokenomics; app | Measured delivered-funding ledger and honest multilingual close-out disclosures |
| [2026-09-14](../ReleaseNotes/ReleaseNotes-2026-09-14.md) | Tokenomics; app; platform | Dedicated reward custody, protected ingress and reconciliation of loan status |
| [2026-09-15](../ReleaseNotes/ReleaseNotes-2026-09-15.md) | Tokenomics; app; platform | Legacy reconciliation epoch and chain-proven settlement points |
| [2026-09-17](../ReleaseNotes/ReleaseNotes-2026-09-17.md) | App; platform; keeper | Reminder integrity, deadline order, measured request limits and disclosed held records |
| [2026-09-20](../ReleaseNotes/ReleaseNotes-2026-09-20.md) | App; website; platform | Working push delivery and explicit maintenance unavailability |
| [2026-09-21](../ReleaseNotes/ReleaseNotes-2026-09-21.md) | Tokenomics; app; platform | Epoch custody and all-or-nothing shared-data migration |
| [2026-09-22](../ReleaseNotes/ReleaseNotes-2026-09-22.md) | Platform; internal notes | Read-only recovery evidence for a database move; assembly-only changes add no product rule |
| [2026-09-23](../ReleaseNotes/ReleaseNotes-2026-09-23.md) | Internal notes | Release-note validation only; no functional product change |
| [2026-09-24](../ReleaseNotes/ReleaseNotes-2026-09-24.md) | Internal notes | Release-note heading validation only; no functional product change |
| [2026-09-25](../ReleaseNotes/ReleaseNotes-2026-09-25.md) | Tokenomics; platform; app | Epoch draws, accurate failure reasons and debt-sized collateral repayment |
| [2026-09-26](../ReleaseNotes/ReleaseNotes-2026-09-26.md) | Internal notes | Assembly and deployment/test tooling only; no new user-facing behavior |
| [2026-09-28](../ReleaseNotes/ReleaseNotes-2026-09-28.md) | Platform; tokenomics; app | Transferred VPFI reservations and direct acceptance of authorized refinance requests |
| [2026-09-29](../ReleaseNotes/ReleaseNotes-2026-09-29.md) | Platform; tokenomics | Retired fixed-rate purchase surface remains absent |
| [2026-10-02](../ReleaseNotes/ReleaseNotes-2026-10-02.md) | Platform; tokenomics | Transferred-position tier accounting and reserved-balance consolidation |
| [2026-10-03](../ReleaseNotes/ReleaseNotes-2026-10-03.md) | Tokenomics; app | Staged wide-day claims, plain-language market flows and excess-collateral withdrawal |
| [2026-10-04](../ReleaseNotes/ReleaseNotes-2026-10-04.md) | Platform; app | Consented illiquid refinance, collateral bounds, signed-book coverage and exact input amounts |
| [2026-10-05](../ReleaseNotes/ReleaseNotes-2026-10-05.md) | App; platform | Committed collateral ranges, meaningful activity amounts and correctly scaled pair LTV |
| [2026-10-06](../ReleaseNotes/ReleaseNotes-2026-10-06.md) | Platform; app | Recorded default debt, standing-refinance holds and authoritative request discovery |
| [2026-10-07](../ReleaseNotes/ReleaseNotes-2026-10-07.md) | Platform; app | Recorded internal-match debt discharge and labelled sanctions test lists |
| [2026-10-13](../ReleaseNotes/ReleaseNotes-2026-10-13.md) | Tokenomics; platform; app | Capacity deposits, custody eras, claim domains, epoch release, rooted funding and report readiness |
| [2026-10-14](../ReleaseNotes/ReleaseNotes-2026-10-14.md) | Platform; app; keeper | Grace-ended state, lender and keeper close-out, safe route discovery and ordered sends |
| [2026-10-15](../ReleaseNotes/ReleaseNotes-2026-10-15.md) | Platform; app; keeper | Settled indexed positions, single runner, internal-match sends and expected no-health-factor cases |
| [2026-10-16](../ReleaseNotes/ReleaseNotes-2026-10-16.md) | Tokenomics; platform; app | Sanctions reward holds, claim notice and countdown, signed Full opt-in, custody and public backing |
| [2026-10-17](../ReleaseNotes/ReleaseNotes-2026-10-17.md) | Platform; internal notes | Fresh testnet deployment status; deployment alone activates no reward program |
| [2026-10-18](../ReleaseNotes/ReleaseNotes-2026-10-18.md) | Keeper; tokenomics; platform | Dedicated keeper state and runtime, delivery proofs, capacity fee bounds and sanctions automation |
| [2026-10-19](../ReleaseNotes/ReleaseNotes-2026-10-19.md) | Keeper; tokenomics; platform | Testnet capacity and perk activation, deadlines, published escrow and delisting readiness |
| [2026-10-20](../ReleaseNotes/ReleaseNotes-2026-10-20.md) | Keeper; platform; tokenomics | Upgrade safety, finalized sanctions evidence, labelled clearance rehearsal and observation alerts |
| [2026-10-21](../ReleaseNotes/ReleaseNotes-2026-10-21.md) | Keeper; platform; tokenomics | Measured forced sales, remittance route records, reward-day automation and retired shared state |
| [2026-10-22](../ReleaseNotes/ReleaseNotes-2026-10-22.md) | Platform; app; tokenomics | Measured arrivals, lender-first forced settlement, treasury accrual and zero-valued claims |

A source release is not a live-deployment guarantee. For example, the October
19 notes record capacity enabled on three testnets and priority routing priced
on two; the October 21 and 22 notes explicitly say their settlement changes
had not yet reached the testnets. Feature defaults, dated activation facts,
and current chain observations must be described separately.
