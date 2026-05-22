# Architecture Decision Records

This directory holds Vaipakam's **Architecture Decision Records (ADRs)**
— short documents that capture the **WHY** behind load-bearing
architectural decisions in the protocol. Each ADR records:

1. The **context** that forced a decision (the constraint, the
   trade-off, the failure mode being avoided).
2. The **decision** that was made.
3. The **consequences** that follow — both intended and accepted.
4. The **alternatives** that were considered and why they were rejected.

ADRs are append-only. When a decision is superseded, the original ADR
stays in place and is marked `Superseded by ADR-NNNN`, with the
superseding ADR cross-linking back. This preserves the historical
record auditors need to evaluate the protocol's evolution.

## Why these exist (and what they're not)

Without ADRs, "why is this architected this way?" becomes git
archaeology — readers have to reconstruct intent from commit
messages, PR threads, and oral history. ADRs make the intent
**discoverable** alongside the code.

ADRs are **not**:

- A spec — that's `docs/FunctionalSpecs/`.
- A design proposal — that's `docs/DesignsAndPlans/`. (ADRs land
  *after* a design proposal is implemented; they capture which
  decision the project ratified.)
- A roadmap — that's the
  [`@vaipakam-labs`](https://github.com/users/vaipakam/projects/1)
  project board.
- A release log — that's `docs/ReleaseNotes/`.

ADRs explicitly accumulate. New ones get appended, old ones stay.
That's the point of the record.

## Index

| # | Title | Status |
|---|---|---|
| [ADR-0001](0001-eip-2535-diamond-pattern.md) | Adopt EIP-2535 Diamond Pattern for the core protocol | Accepted |
| [ADR-0002](0002-no-kyc-on-retail.md) | Retail-deploy gating policy — sanctions ON; KYC and country-pair OFF | Accepted |
| [ADR-0003](0003-vpfi-time-weighted-discount.md) | Time-weighted accumulator for VPFI fee discounts | Accepted |
| [ADR-0004](0004-ccip-over-layerzero.md) | Migrate cross-chain transport from LayerZero to Chainlink CCIP | Accepted |
| [ADR-0005](0005-depth-tiered-ltv.md) | Depth-tiered LTV behind a kill-switch | Accepted |
| [ADR-0006](0006-three-tier-ci-split.md) | Three-tier CI split — `contracts-fast`, `contracts-full`, `mainnet-gate` | Accepted |
| [ADR-0007](0007-functionalspecs-doc-sourced.md) | FunctionalSpecs are sourced from documents, never transcribed from code | Accepted |
| [ADR-0008](0008-per-user-vault-factory.md) | Per-user UUPS vault via factory, not a commingled vault | Accepted |
| [ADR-0009](0009-bsl-vs-mit-license.md) | BSL-1.1 on the protocol, MIT on the public reference keeper bot | Accepted |
| [ADR-0010](0010-canonical-rate-semantics.md) | Canonical limit-order semantics for Offer min/max fields (lender = ceiling, borrower = floor; LTV/HF derived not entered; `loanInitMaxLtvBps` live-at-match) | Accepted |

## Filing a new ADR

When you make a load-bearing architectural decision:

1. Copy [`_template.md`](_template.md) to `NNNN-<short-slug>.md` where
   `NNNN` is the next available number (zero-padded).
2. Fill in the four sections (Context, Decision, Consequences,
   Alternatives Considered).
3. Add a row to the index above (this file).
4. Land the ADR in the **same PR** as the decision-implementing code
   when possible. If the decision was already in code before the ADR
   process existed, backfill the ADR with the date of the original
   decision (not the backfill date) and note the backfill in a
   one-line preamble.

Keep ADRs short. 80-150 lines is typical. If you need more, the
content probably belongs in `docs/DesignsAndPlans/` (the design
exploration), with the ADR carrying a one-paragraph summary + link.

## For auditors

These records are written for *you*. Each one captures a real
trade-off the protocol made. If an ADR's "Consequences" or
"Alternatives Considered" section looks thin or under-defended,
that's a real signal — surface it as a finding via the
[`audit_finding`](../../.github/ISSUE_TEMPLATE/audit_finding.yml)
Issue template or in your engagement deliverable.
