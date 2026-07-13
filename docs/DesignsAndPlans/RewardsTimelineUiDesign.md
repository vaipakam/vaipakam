# Interaction-rewards timeline UI (E-3)

**Status:** frontend-only design. Card: #1205. Umbrella: #1221.

## Problem

Reward mechanics are correct but opaque: bounded per-call catch-up, per-day
caps, day-0 exclusion, pending-finalization vs pending-broadcast waits, and
close-gated claimability all read as "missing rewards" to users.

## Design

A per-day timeline in Claim Center (above per-loan claim rows, per the
spec's placement rule), one row per reward day in the user's window:

| Column | Source |
| --- | --- |
| Day (UTC) | derived |
| Earned (pre-cap) | the §4 formula, same math as `claimInteractionRewards`: per side, `½ × dailyPool[D] × (userContribution / globalDenominator_side[D])` — user contribution from `getUserRewardEntries`, global denominator from the broadcast (division by the denominator, never multiplication) |
| Cap trim | recompute `min(raw, cap)`; show "capped −X" chip when trimmed |
| State | one of: `loan open` (close-gated) / `awaiting finalization` / `awaiting broadcast` (known-global-set flag unset) / `awaiting funding` (mirror chains only: broadcast landed but the day's VPFI budget remittance hasn't — §4a decouples them, and a claim against an unfunded mirror reverts on empty balance) / `claimable` / `claimed` |

Header widgets:

- Pending claimable: `previewInteractionRewards(user)`.
- Lifetime claimed: `InteractionRewardsClaimed` events (indexer cache,
  chain-verified on demand).
- **"More pending — claim again" banner** whenever a bounded claim leaves
  a non-empty remainder (cursor didn't reach head) — the spec explicitly
  requires surfacing this rather than implying one call clears everything.

Rules honored (from TokenomicsTechSpec §4/4a):

- The broadcast-arrival check is the **known-global-set flag**, never a
  zero-denominator test (zero is a valid finalized value).
- Day 0 exclusion shown as a greyed row with an explainer tooltip, so its
  absence from totals is legible.
- Waiting states never offer a claim button that would revert.
- Contributing-loans list shows numeraire participation, not per-loan VPFI
  (protocol-wide denominator caveat), linking to Loan Details.

## Data plumbing

All reads exist: `previewInteractionRewards`, `getUserRewardEntries`,
`knownGlobalSet`/denominator views, claim events. Indexer may cache the
day-state materialization; the chain remains authoritative before any
action (same discipline as Claim Center's claimability rule).

## Acceptance

A user with (a) an open loan, (b) a capped day, (c) an un-broadcast day,
and (d) a long catch-up backlog can explain each of the four from the UI
alone. E2E spec under `apps/alpha02/e2e/` + COVERAGE.md row per the
verification directive.
