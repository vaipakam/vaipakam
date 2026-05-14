# Release notes — 2026-05-15

One feature-sized thread landed today, end-to-end:
**internal-liquidation matching** (B.2 from
`docs/internal/PendingTasks-2026-05-14.md`) — a new pre-external-
aggregator liquidation path where opposing-direction loans clear
each other through the protocol's own collateral without paying
DEX slippage or aggregator fees. Bots earn 1% per matched leg
synchronously; the legacy external swap path remains the
fallback once a 2% LTV priority window expires.

The work spans 11 commits in the vaipakam repo + 1 in the
sibling `vaipakam-keeper-bot` repo, on branch
`feat/internal-liquidation-ledger`. Kill-switch defaults `false`
on every fresh deploy so production stays in today's
external-only liquidation behaviour until per-chain governance
flips it on.

## Headline tally

| Phase | Commits | Tests added |
|---|---|---|
| Design-doc iteration (5 commits) | `d698e76`, `28ba425`, `4221b61`, `446059a`, `038f86e` | — (docs) |
| PR1 — rename `maxLtvBps → loanInitMaxLtvBps` | `741e42d` | rename-sweep only (20 files) |
| PR2 — per-tier liquidation threshold + snapshot-at-init | `4c84eb5` | existing suite re-green (40 files) |
| PR3 — internal-match scaffold (3 globals + view) | `3037a7a` | +13 `InternalMatchConfig.t.sol` |
| ABI sync PR1+2+3 | `d4332bd` | — |
| PR4 — validation surface + priority-window gate | `73b8118` | +10 gates + 5 priority-window |
| PR5 — 2-way execution body | `49a98b3` | +5 `InternalMatchExecution.t.sol` |
| PR6 — frontend + ABI sync | `f902415` | (frontend only) |
| PR5.5 — 3-way A→B→C→A chain match | `826e98d` | +1 chain-cycle test |
| Keeper-bot export-list update | `be723a9` | — |
| Design-doc implementation status | `693f02f` | — |
| **Sibling repo**: keeper-bot detector | `df847d9` | (npm typecheck) |

**Forge regression**: 1936 passed / 0 failed / 5 skipped on the
full non-invariant suite (94 suites). tsc-clean across
`apps/{defi,keeper,indexer,agent}` and `vaipakam-keeper-bot`.

## Thread — Internal-liquidation matching (B.2)

### What changed

The protocol's liquidation gauntlet picks up a new "internal
match" rung BEFORE the external 0x / 1inch swap path. When a
loan crosses its per-tier liquidation threshold, an off-chain
keeper bot looks for a counterpart loan — one whose
`principalAsset` is this loan's `collateralAsset` and vice
versa — and submits a single transaction that swaps the two
loans' collateral directly through the protocol's own escrow
infrastructure.

For the 2-loan case: A owes USDC and has WETH collateral; B
owes WETH and has USDC collateral. The match transfers B's
USDC to A's lender (clearing A's debt) and A's WETH to B's
lender (clearing B's debt), with the bot taking 1% of each
leg's notional as the matching fee. Neither side pays a DEX
spread or aggregator slippage.

The 3-loan extension closes an A→B→C→A asset cycle the same
way — independent min-match on each of the three legs.

A configurable priority window above each loan's per-tier
liquidation threshold (default 2% LTV) keeps the existing
external `triggerLiquidation` path locked while internal
matchers race to find pairs. Above the window — i.e., once
LTV crosses `liquidationLtvBpsAtInit + 200 BPS` by default —
the external path reopens. Worst-case LTV deterioration vs
today: ≤ 2%, well inside the bad-debt buffer.

### Why this matters

External aggregator liquidations cost 5–7.7% of the loan in
discounts + slippage + aggregator fees. When two near-
liquidation loans happen to be each other's mirror, an
internal match clears both for just 1% per leg (and the
borrowers net out ahead — they save 4–6.7%). At scale,
even a 10–25% match rate trims a real fraction of the
protocol's liquidation cost surface.

The match path is also strictly safer than external on
slippage: zero. Oracle prices both legs; collateral moves
deterministically; no AMM curve crossing.

### Architectural pivots (from plan-mode Q&A)

The original design (§9.1 of the design doc) had four global
LTV knobs: advertise / match-liquidate / external / incentive.
Two of those collapsed during user-driven review:

1. **"Match-liquidate floor" is the per-tier liquidation
   threshold itself.** A separate global knob would drift
   away from the per-asset risk gradient. Snapshotted onto
   each loan at `initiateLoan` via the new
   `Loan.liquidationLtvBpsAtInit` field, so tier degradation
   mid-loan never re-gates existing loans.
2. **Per-tier replaces per-asset for liquidation threshold.**
   The previous `RiskParams.liqThresholdBps` is retired
   entirely; `ProtocolConfig.tier{1,2,3}LiquidationLtvBps`
   (defaults 90 / 85 / 80%) take over, fed by the same depth-
   tier classification that drives origination caps. Both
   admin-tunable via `ConfigFacet.setTierLiquidationLtvBps`,
   range-bounded [50%, 95%], cross-tier monotonic enforced.

The view-based candidate-discovery approach won over a stored
ledger: `MetricsFacet.getMatchEligibleLoans` filters
`s.activeLoanIdsList` per-block. No `addToLedger` /
`removeFromLedger` maintenance hooks, no soft-delete flag.
Per-block freshness gives soft-delete-at-84% semantics for
free.

### Surfaces added

- **Contracts**:
  - `RiskFacet.triggerInternalMatchLiquidation(loanIdA,
    loanIdB, loanIdC)` — entry point.
  - `RiskFacet.triggerLiquidation` — gains the
    `InternalMatchOnlyBand` revert in the priority window
    when the kill-switch is on.
  - `ConfigFacet.setTierLiquidationLtvBps` /
    `getTierLiquidationLtvBps` — per-tier liquidation
    threshold.
  - `ConfigFacet.setInternalMatchEnabled` /
    `setInternalMatchConfig` /
    `getInternalMatchConfigBundle` — kill-switch + 2
    tunables.
  - `MetricsFacet.getMatchEligibleLoans` — paginated active-
    loan view filtered by current LTV (returns empty when
    kill-switch is off).
  - New `LoanStatus.InternalMatched` terminal state +
    `Active → InternalMatched` lifecycle edge.
  - New event `InternalMatchExecuted` with indexed leg-A /
    leg-B + all three legs' notional + per-leg incentive
    amounts.
- **Frontend** (`apps/defi`):
  - `useInternalMatchConfig` hook (mirror of
    `usePeriodicInterestConfig`).
  - `LoanStatus.InternalMatched = 5` + `'Internally Matched'`
    label in `types/loan.ts`.
- **Indexer** (`apps/indexer`):
  - `InternalMatchExecuted` allowlisted in
    `check-event-coverage.mjs` (schema row is B.2.3
    follow-up).
- **Keeper bot** (`vaipakam-keeper-bot`):
  - `src/detectors/internalMatcher.ts` — per-tick scan +
    bucket pairing + per-leg submit; kill-switch-aware
    short-circuit; per-tick submit cap.
- **Docs**:
  - `docs/DesignsAndPlans/InternalLiquidationLedger.md` —
    full design doc, alternatives discussion, pivot trail,
    implementation status table.
  - This release notes file.

### Range bounds + safety

Every numeric knob is admin-configurable with compile-time
range bounds the setter enforces:

| Knob | Default | Hard range |
|---|---|---|
| `tier1LiquidationLtvBps` | 9_000 (90%) | `[5_000, 9_500]`, T1 ≥ T2 |
| `tier2LiquidationLtvBps` | 8_500 (85%) | `[5_000, 9_500]`, T1 ≥ T2 ≥ T3 |
| `tier3LiquidationLtvBps` | 8_000 (80%) | `[5_000, 9_500]`, T2 ≥ T3 |
| `externalLiquidationPriorityWindowBps` | 200 (2%) | `[0, 500]` (5% cap) |
| `internalMatchIncentivePerLegBps` | 100 (1%) | `[0, 300]` (3% cap) |

Worst case (3-way, max governance settings): tier-3 95% +
500 BPS window = 100% absolute external floor, still bounded.
3% per-leg cap × 3 legs = 9% of total notional to the bot,
well under the 5–7.7% per-leg external discount borrowers
would otherwise pay.

### Tracked follow-ups (B.2.1 – B.2.5)

See `docs/internal/PendingTasks-2026-05-14.md` §B.2 for the
full list. Summary: per-page badge wiring (label exists, badges
don't); MyLoans "near-liquidation" filter bucket; indexer
schema row; 3-way chain detection in the bot; companion bot
pair-search algorithm doc.

## Operational

- **No production behaviour change today.** Kill-switch
  defaults `false`. Existing external-liquidation flow runs
  exactly as before. Frontend renders no `InternalMatched`
  state because no loans transition to it without an enable
  call.
- **Per-chain enablement** sequence:
  1. Deploy new contracts (the per-tier liquidation snapshot +
     `Loan.liquidationLtvBpsAtInit` field is a storage-layout
     change vs prior; pre-mainnet means clean redeploy, no
     migration).
  2. Verify `getInternalMatchConfigBundle` returns
     `(false, 200, 100)` — defaults landed.
  3. Wait for keeper-bot deploy to be live on this chain.
  4. `setInternalMatchEnabled(true)` via ADMIN_ROLE
     (TimelockController post-handover).
  5. Monitor `InternalMatchExecuted` event volume + bot
     wallet balances for one week before considering increases
     to the priority window.
- **Audit**: bundles with item A.4 in PendingTasks (next
  scheduled engagement). No standalone pass.
- **Runbook updates**: `docs/ops/GovernanceRunbook.md` +
  `docs/ops/IncidentRunbook.md` updated with the new setters
  + the kill-switch-flip incident procedure.
