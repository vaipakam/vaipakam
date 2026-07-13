# Cross-chain portfolio view (E-13)

**Status:** frontend design (read-only; no contracts, no cross-chain tx).
Card: #1215. Umbrella: #1221.

## Problem

Positions, offers, claims, and rewards are per-chain (the core protocol is
single-chain per Diamond by design). A user active on two or more chains
must chain-switch to discover what they hold or can claim.

## Design

Dashboard "All chains" toggle:

- **Reads:** for each deployed chain in `@vaipakam/contracts/deployments`,
  run the existing bulk position-hydration read path against that chain's
  RPC in parallel (viem multi-client; RPC URLs from the existing env
  pattern). No new contract views needed.
- **Aggregation:** unified tables (positions, offers, claimables, pending
  rewards) with a per-chain badge on every row; totals shown per-asset,
  and value totals summed in the **active numeraire** (the PAD numeraire
  is governance-rotatable and not hard-wired to USD — a USD figure is an
  optional display conversion, never the accounting basis), and only when
  every chain's oracle read succeeded (partial sums mislead).
- **Actions:** rows deep-link into the chain-scoped surface and trigger
  the wallet network-switch prompt; the aggregated view itself is
  strictly read-only.
- **Degradation:** a chain whose RPC fails shows a per-chain "unreachable"
  banner, and **aggregate value totals become unavailable** ("totals
  unavailable — <chain> unreachable") rather than showing a partial sum
  that reads as the full portfolio (Codex round-4; consistent with the
  every-chain-must-succeed rule above). Per-chain rows and per-chain
  subtotals for reachable chains still render — never silently omitted
  (silent omission reads as "no positions there").
- **Rewards nuance:** interaction-reward pending amounts are per-chain
  claims (mirror funding model); the aggregate view labels them "claimable
  on <chain>" so nobody expects a unified claim.
- **Caching:** existing indexer per-chain caches serve first paint; chain
  reads confirm before any row shows an actionable state (the standing
  hints-vs-authority discipline).

## Performance bounds

5 chains × bulk hydration is the cost of one dashboard load each; loads
run concurrently and stream into the UI per-chain (no all-or-nothing
barrier). Respect per-RPC rate budgets from the log-chunk tuning env.

## Non-goals

Cross-chain actions, unified claiming, canonical-tier display changes
(the VPFI page already explains canonical-vs-mirror tiers).

## Acceptance

E2E on a 2-chain Anvil mesh: positions on both chains render with correct
badges; one RPC blocked → banner + excluded totals; deep-link switches
network. COVERAGE.md row per the verification directive.
