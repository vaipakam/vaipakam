# Claim-All batching (E-10)

**Status:** design for review (contracts read + frontend). Card: #1212.
Umbrella: #1221. Coordinates with #214 (Claim Center bulk-claim UI shape);
mind #939 (uncapped entry-loop finding) and #941 (amount==0 claimables
display) when implementing.

## Problem

Every payout is pull-based and per-loan: principal, collateral, buffers,
VPFI rebates, and interaction rewards are separate transactions; loans
can't finalize behind an unclaimed party. Recurring UX tax, and idle
unclaimed value.

## Design

### Contract surface

Prefer an explicit batched entry point over raw multicall:

```
claimBatch(ClaimRequest[] requests)   // bounded: MAX_BATCH (e.g. 20)
  ClaimRequest { kind: LENDER | BORROWER | INTERACTION_REWARDS; loanId; }
```

- Executes each claim through the same internal paths as the individual
  entry points (`claimAsLender`, `claimAsBorrower`,
  `claimInteractionRewards` — the last at most once per batch, respecting
  its own bounded catch-up cursor).
- **Per-item isolation:** a failing item records
  `BatchClaimItemSkipped(loanId, kind, reason)` and continues — one stale
  row must not revert 19 valid claims. (The frontend pre-filters against
  live claimability, but races happen.)
- Reentrancy: the facet-level guard wraps the whole batch; internal claim
  paths must be callable under the already-entered guard (same pattern as
  other internal-call flows through the Diamond; verify against the #951
  `nonReentrant` collision lesson — use internal functions, not external
  self-calls).
- NFT gating unchanged: each item validates the caller holds the relevant
  position NFT at execution.
- Sanctions: Tier-1 screen once per call (caller-scoped, same rule as the
  individual claim paths).

Why not generic `multicall(bytes[])`: a public delegate-multicall on a
Diamond is a footgun (msg.value semantics, selector-routing surprises,
audit surface). A typed batch is smaller surface and easier to reason
about.

### Frontend

- Claim Center header CTA: "Claim all eligible (N)" with an itemized
  preview (per-loan amounts, rewards line, VPFI rebate lines per the spec's
  rebate-display rule).
- Discovery: indexed hints + on-chain confirmation (existing Claim Center
  discipline); include position-NFT-ownership discovery so secondary
  buyers see their rows.
- After a batch: if the rewards cursor left a remainder, surface the
  "more pending — claim again" state (shared with E-3's timeline).

### Keeper-swept claims (optional follow-up, separate flip)

Opt-in per-user flag + `KEEPER_ACTION_SWEEP_CLAIMS` grant: keeper executes
`claimBatch` on the user's behalf, destination locked to the user's vault,
fee bounded in bps and skimmed from swept value. Off by default; ships only
after the base batch is proven. (Value lands in the vault, not the wallet —
sweeping to wallets would be an automatic push, which the distribution
model forbids.)

## Tests

Batch with mixed kinds; per-item skip on one stale row; NFT-gate per item;
rewards-cursor interaction; gas ceiling at MAX_BATCH; guard-reentry safety;
loan finalization (NFT burn) when a batch completes both sides' claims.

## Spec edit

ProjectDetailsREADME §6 Claiming: batch surface + per-item isolation
semantics; distribution model still pull-only (batching changes
granularity, not the model).
