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
- **Per-item isolation — two layers** (Codex rounds 1–2):
  1. *Precondition failures:* refactor each claim path into
     `_tryClaimX(...) returns (bool ok, bytes32 reason)` that checks
     every precondition **before** mutating state and returns instead of
     reverting; the existing single entry points become
     `require(_tryClaimX(...))`-style wrappers (identical behaviour,
     selectors unchanged).
  2. *Post-precondition reverts* — a claim can pass every check and
     still revert **inside the payout transfer** (blacklisted or paused
     token; the weird-ERC20 matrix explicitly includes claims in that
     class). Internal calls can't contain that, so each batch item
     executes through a thin `onlySelf` **external** self-call wrapped
     in `try/catch`: a transfer revert unwinds only that item's state
     (the claim stays unclaimed and individually retryable later) while
     the batch continues. **Claimant threading (Codex round-3):** the
     self-call enters with `msg.sender == address(this)`, so the item
     function takes the claimant (and payout destination — see below)
     explicitly —
     `claimItemFor(address claimant, Destination d, ClaimRequest r) onlySelf` — and
     every refactored claim internal takes `claimant` as a parameter
     instead of reading `msg.sender`. `claimBatch` passes its own
     `msg.sender`; `claimBatchFor` passes `user`. NFT-holder and
     reward-entitlement checks run against that threaded claimant.
     Guard layout: the reentrancy guard sits on `claimBatch` /
     `claimBatchFor` only; the `onlySelf` item function is exempted
     from the facet guard and relies on the batch-level guard (mind
     the #951 collision class).
  Either way a failing item records
  `BatchClaimItemSkipped(loanId, kind, reason)` and continues — one
  stale row must not revert 19 valid claims. (The frontend pre-filters
  against live claimability, but races happen.)
- Reentrancy: the facet-level guard wraps the batch entry points; the
  ONE deliberate external self-call in this design is the `onlySelf`
  item dispatch above (needed for `try/catch` isolation), which is
  exempt from the facet guard and protected by the batch-level guard +
  `onlySelf`. All other composition stays internal-function based per
  the #951 `nonReentrant` collision lesson.
- NFT gating: each item validates that the **threaded claimant** holds
  the relevant position NFT at execution — `claimBatch` is simply the
  case where claimant == caller; `claimBatchFor` validates against
  `user`, never the keeper caller (Codex round-4).
- Sanctions: Tier-1 screen once per call against the **claimant /
  beneficiary** of the value transfer (== caller for `claimBatch`;
  == `user` for `claimBatchFor`), same rule as the individual claim
  paths apply to their claimant.
- Payout destination is threaded explicitly alongside the claimant
  (Codex round-4): `claimItemFor(claimant, destination, request)` with
  `destination ∈ {WALLET, VAULT}`. Self-service `claimBatch` defaults to
  the claimant's wallet exactly like the individual claim paths;
  `claimBatchFor` forces `VAULT` (the user's own vault) — without the
  explicit destination the sweep would become an automatic wallet push,
  which the distribution model forbids.

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

Opt-in per-user flag + `KEEPER_ACTION_SWEEP_CLAIMS` grant. The base
`claimBatch` validates the **caller** as NFT holder and
`claimInteractionRewards` is caller-scoped, so a keeper calling it would
claim nothing (or its own rewards) — the sweep needs a dedicated
user-bound entry (Codex round-2): `claimBatchFor(user, requests)` that
(a) requires the user's standing sweep grant to the calling keeper,
(b) validates NFT holdership and reward entitlement against `user`, not
the caller, (c) **Tier-1 sanctions-screens `user` — the beneficiary of
the value transfer — not merely the keeper caller** (a sanctioned user
must not receive swept proceeds through a keeper any more than through
their own call; screening the caller too is fine but not sufficient),
and (d) locks the destination to the *user's* vault (the threaded
`destination = VAULT` mode above), with the keeper fee bounded in bps
and **skimmed only from fungible swept amounts** — in-kind legs
(ERC-721 / unique ERC-1155 collateral returns) cannot bear a bps carve
without valuation or fractionalization, so they sweep fee-free (Codex
round-4); the keeper's economics come from the fungible legs. Off by
default; ships only after the base batch is proven. (Value lands in the
vault, not the wallet — sweeping to wallets would be an automatic push,
which the distribution model forbids.)

## Tests

Batch with mixed kinds; per-item skip on one stale row; NFT-gate per item;
rewards-cursor interaction; gas ceiling at MAX_BATCH; guard-reentry safety;
loan finalization (NFT burn) when a batch completes both sides' claims.

## Spec edit

ProjectDetailsREADME §6 Claiming: batch surface + per-item isolation
semantics; distribution model still pull-only (batching changes
granularity, not the model).
