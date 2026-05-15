# Release notes — 2026-05-15

Two threads landed today:

1. **Internal-liquidation matching** (B.2 from
   `docs/internal/PendingTasks-2026-05-14.md`) — the feature
   piece. A new pre-aggregator liquidation path that runs
   ahead of the external swap. See Thread 1 below.
2. **Task-tracking migration to @vaipakam-labs** — the
   housekeeping piece. Dated `PendingTasks-yyyy-mm-dd.md`
   files retired in favor of the GitHub Project board; label
   vocabulary + Issue Templates + multi-repo auto-add Action
   landed in both repos. See Thread 2 below.

## Thread 1 — Internal-liquidation matching (B.2)

A new pre-aggregator liquidation path — a new pre-external-
aggregator liquidation path where opposing-direction loans clear
each other through the protocol's own collateral without paying
DEX slippage or aggregator fees. Bots earn 1% per matched leg
synchronously; the legacy external swap path remains the
fallback once a 2% LTV priority window expires.

The work spans 21 commits in the vaipakam repo + 3 in the
sibling `vaipakam-keeper-bot` repo, on branch
`feat/internal-liquidation-ledger`. The contract / scaffold
side (PR1–PR6 + PR5.5 + ABI syncs + design-doc iteration)
landed first; the 5 tracked follow-ups (B.2.1 – B.2.5) all
landed in the same release without splitting into a separate
branch. Kill-switch defaults `false` on every fresh deploy so
production stays in today's external-only liquidation
behaviour until per-chain governance flips it on.

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
| Doc updates (PendingTasks + ReleaseNotes + runbooks) | `3deeb1c` | — |
| **B.2.1** — InternalMatched is claim-eligible | `175c1fc` | (frontend only) |
| **B.2.2** — Dashboard near-match warning chip + signals helper | `a927b0a` | (frontend only) |
| **B.2.3** — indexer InternalMatchExecuted handler + activity event | `637c627` | event-coverage 21/15 (was 20/16) |
| Follow-ups close-out | `377d997` | — |
| **Sibling repo**: keeper-bot detector + 2-way matcher | `df847d9` | (npm typecheck) |
| **Sibling repo / B.2.5**: pair-search algorithm doc | `46f4e7b` | — |
| **Sibling repo / B.2.4**: 3-way chain pass | `1dc638b` | (npm typecheck) |

**Forge regression**: 1936 passed / 0 failed / 5 skipped on the
full non-invariant suite (94 suites). tsc-clean across
`apps/{defi,keeper,indexer,agent}` and `vaipakam-keeper-bot`.
Indexer event-coverage check passes (21 handled / 15
allowlisted, up from 20 / 16).

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

### Follow-ups B.2.1 – B.2.5 — all shipped same release

The five B.2 follow-ups originally tracked as "out of scope
for the design branch" all landed in this release alongside
the main work:

| ID | Scope | Commit |
|---|---|---|
| B.2.1 | `LoanStatus.InternalMatched` treated as claim-eligible terminal in `ClaimActionBar` so borrowers can claim residual collateral after a partial match. | `175c1fc` |
| B.2.2 | Dashboard "near match" amber chip on borrower-side rows when current LTV is within 5% of (but still below) the snapshotted liquidation threshold. Threads `liquidationLtvBpsAtInit` through `LoanDetails` / `LoanSummary` + the two user-loan adapters; `lib/internalMatchSignals.ts` exposes the `isNearInternalMatchWindow` helper. | `a927b0a` |
| B.2.3 | Indexer `InternalMatchExecuted` handler: decrements principal + collateral per leg via the partial-match α rule from §7 of the design doc; flips `status = 'internal_matched'` when principal clears. Activity-event row keyed on leg-A with matcher as actor. Allowlist entry retired. | `637c627` |
| B.2.4 | 3-way A→B→C→A chain detection in `vaipakam-keeper-bot/src/detectors/internalMatcher.ts` — second pass over loans that didn't pair up 2-way, principal-asset bucketing for O(1) hop walks. | `1dc638b` (keeper-bot) |
| B.2.5 | `vaipakam-keeper-bot/docs/InternalMatchSearchAlgorithm.md` — eligibility surface, match-shape constraints, candidate enumeration, submit policy, gas + economics, kill-switch behaviour, planned extensions. | `46f4e7b` (keeper-bot, with §4 update in `1dc638b`) |

PendingTasks-2026-05-14.md §B.2 marked all five closed in
`377d997`.

## Thread 2 — Migration of task tracking to @vaipakam-labs

A separate, smaller piece of work landed today alongside B.2:
the move from dated `PendingTasks-yyyy-mm-dd.md` files to the
GitHub Project [@vaipakam-labs](https://github.com/users/vaipakam/projects/1)
as the live tracker for outstanding work. Markdown docs were
becoming hard to maintain — the same items leaked across
`docs/ToDo.md`, `docs/internal/PendingTasks-yyyy-mm-dd.md`, and
`docs/ReleaseNotes/*` in slightly different framings, and
closure state drifted between them.

### What moved where

| Surface | New role |
|---|---|
| **`@vaipakam-labs` project board** | Live task tracker. Status / Priority / Size / Module / Sprint fields. Both `vaipakam/vaipakam` and `vaipakam/vaipakam-keeper-bot` linked. |
| `docs/internal/RoughNotes.md` | Brain-dump (already in active use). Promote to a card within 24-48h or strike. |
| `docs/ToDo.md` | Long-running brain-dump backlog. Items promote to cards as they become actionable. |
| `docs/ReleaseNotes/yyyy-mm-dd.md` | Historical record of what shipped. Unchanged role; new releases continue here. |
| `docs/DesignsAndPlans/*.md` | Architectural rationale. Unchanged role. |
| `docs/ops/*Runbook.md` | On-call procedures. Unchanged role. |
| `docs/internal/PendingTasks-2026-05-14.md` | **Frozen** — last of the dated pattern. Banner at top points readers to the project. No new `PendingTasks-yyyy-mm-dd.md` files going forward. |

### What was set up on @vaipakam-labs

**18 curated draft cards** matching the actionable items from
`PendingTasks-2026-05-14.md` + cherry-picks from `docs/ToDo.md`.
Closed items (B.1 / B.2 / C.2 / D / B.2.1–B.2.5 / E.3 / E.4 /
E.5 / T-064) stayed off the board — they're in ReleaseNotes /
PendingTasks history. ~80 stale items in `docs/ToDo.md` stayed
in ToDo.md until they become actionable.

**Five custom Project fields:**
- `Status` — Backlog / Ready / In progress / In review / Done (already on the project)
- `Priority` — P0 / P1 / P2 (already)
- `Size` — XS / S / M / L / XL (already)
- `Module` — contracts / apps/defi / apps/keeper / apps/indexer / apps/agent / apps/www / vaipakam-keeper-bot / docs / ops (**new**)
- `Sprint` — 2-week Iteration field (**new**; iteration list still needs UI configuration)

**Promoted four feature-request drafts to real Issues** so they
carry permanent discussion threads:
- [#1](https://github.com/vaipakam/vaipakam/issues/1) C.1 — Off-chain data-fetch audit (`security` + `audit` labels)
- [#2](https://github.com/vaipakam/vaipakam/issues/2) E.1 — Aave V4 peer-reader (`enhancement`)
- [#3](https://github.com/vaipakam/vaipakam/issues/3) E.2 — Balancer V2 SOR direct-quote (`enhancement`)
- [#4](https://github.com/vaipakam/vaipakam/issues/4) T-600 — Treasury architecture (`enhancement`)
- [#5](https://github.com/vaipakam/vaipakam/issues/5) T-068 — LayerZero → CCIP (`enhancement`)

Other 13 cards remain as drafts; they'll get promoted to Issues
when discussion threads become useful (e.g., when audit fixes
start landing for C.1 or when a per-chain mainnet rollout
sequence kicks off A.1 / A.2 / A.3 / A.6).

### Label vocabulary — synced across both repos

Both `vaipakam/vaipakam` and `vaipakam/vaipakam-keeper-bot` now
carry an identical 17-label set:

| Type labels | Flag labels |
|---|---|
| `bug` | `security` |
| `enhancement` | `audit` |
| `chore` | `testnet-rehearsal` |
| `refactor` | `mainnet-rollout` |
| `infra` | `good first issue` |
| `perf` | `help wanted` |
| `documentation` | `duplicate` / `invalid` / `wontfix` |
| `question` | |

New issues must carry exactly one **type** label plus zero-or-more
**flag** labels. Issue templates enforce this automatically.

### Issue Templates in both repos

- `.github/ISSUE_TEMPLATE/bug.yml` — auto-applies `bug`, prompts for chain / surface / repro / expected / actual / severity / env
- `.github/ISSUE_TEMPLATE/feature_request.yml` — auto-applies `enhancement`, prompts for problem / proposal / alternatives / surface / size (XS-XL, matches the project's Size field) / risk / acceptance
- `.github/ISSUE_TEMPLATE/config.yml` — disables blank issues; routes security disclosures to `IncidentRunbook.md` privately rather than a public Issue

### Multi-repo auto-add — the workaround

GitHub Projects v2's in-UI Auto-add workflow is one-repo-per-rule
([community discussion](https://github.com/orgs/community/discussions/47803)).
The community-standard workaround: deploy
`actions/add-to-project@v1.0.2` as a GitHub Action in each
contributing repo. The Action runs on issue `opened` / `reopened`
/ `transferred` and pushes the issue into `@vaipakam-labs` using
the `ADD_TO_PROJECT_PAT` repo secret (a personal access token
with `project` scope — required because the default
`GITHUB_TOKEN` can't cross the repo→user-project boundary even
when the user account is the same login).

Workflow files: `.github/workflows/add-to-project.yml` in both
repos, identical except for the comment header. The in-UI
Auto-add workflow has been disabled by hand.

### Commits

This thread shows up in the commit log as:

| Commit | What |
|---|---|
| `87aa1e5` | docs: close E.3 / E.4 / E.5 / T-064 (already-shipped sweep) |
| `9d3eb5f` | docs: strike PendingTasks §C.2 |
| `ea4abbd` | docs: freeze PendingTasks-2026-05-14.md as last of dated pattern |
| `417b5ea` | chore: GitHub Issue Templates (bug + feature_request) |
| `54dc347` | chore(ci): GitHub Action to auto-add issues to @vaipakam-labs |
| `8f3d0cc` (keeper-bot) | chore: GitHub Issue Templates mirror |
| `38d420a` (keeper-bot) | chore(ci): GitHub Action mirror |

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
