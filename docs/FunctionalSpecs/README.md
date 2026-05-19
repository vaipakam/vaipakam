# Functional Specs — the platform's living functional reference

`docs/FunctionalSpecs/` is the **code-free, current-state** description of
what the Vaipakam platform does. It is the single place to learn the
complete functional behaviour of the protocol, and it is written so it
can double as a **test-design reference** — every behavioural statement
should be concrete enough to turn into a test case.

## What this corpus is — and is not

| Doc family | Question it answers | Genre |
| --- | --- | --- |
| `docs/FunctionalSpecs/` (this folder) | "What does the platform **do**, right now?" | Current-state spec |
| `docs/ReleaseNotes/` | "What **changed**, in which PR, and why?" | Change history |
| `docs/DesignsAndPlans/` | "What were we **considering**, and why did we pick this?" | Design exploration |

The three are kept **separate on purpose**. Release notes are a changelog
— they are never deleted or rewritten. Design docs capture intent and
rejected alternatives. The Functional Specs are the distilled,
always-current truth: when behaviour changes, the relevant spec section
is **rewritten to the new state**, not appended to.

## Rules for every doc in this folder

1. **No code.** No Solidity, no TypeScript, no ABIs, no snippets. Plain
   English describing observable behaviour. (Same rule as release notes.)
2. **Current state only.** Describe how the platform behaves *today*. No
   "previously X, now Y" — that is what the release notes are for.
3. **Testable.** Prefer enumerated, observable behavioural statements —
   "On accept, the loan initiates only if the health factor is at least
   the configured minimum; otherwise the call reverts." Each statement
   should map cleanly to a test case.
4. **Audience-neutral.** A new engineer, an auditor, or a QA designer
   should each be able to use these docs without reading the code.

## The doc set

**Existing (platform-wide):**

- `ProjectDetailsREADME.md` — architecture overview + operational
  examples for developers.
- `TokenomicsTechSpec.md` — VPFI token economics + multi-chain model.
- `WebsiteReadme.md` — website / product UX.

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
- Escrow — per-user escrow proxies, stuck-escrow recovery
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
fragment.** The release-note fragment is the "what changed" lens; the
Functional Spec edit is the "current state" lens — written together, by
the author who has the full context of the change, so the spec cannot
drift.

This is part of the post-merge definition-of-done in the project
`CLAUDE.md`. A non-blocking CI check
(`.github/workflows/release-notes-drift.yml`) warns in the Actions tab
if a merge changed `contracts/src/` or `apps/` but touched no
`docs/FunctionalSpecs/` doc — the same backstop the release-note
fragments have.

## Baseline

The per-domain specs above do not exist yet. Authoring them from the
release notes, the design docs, and the contracts' actual behaviour is a
tracked epic — **Issue #76** — done domain by domain (one focused PR per
domain). Until a domain's spec exists, its behaviour is described — less
tidily — across the release notes and the `DesignsAndPlans/` docs.
